import { BrowserWindow, ipcMain } from 'electron'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import type { GoogleDriveAuthorization, GoogleDriveProgressReporter } from '../../src/shared/google-drive-sync'
import { randomUUID } from 'node:crypto'
import { getCurrentProjectPath, getProjectDb } from '../database'
import { projectAccess } from '../services/project-access'
import { externalFileGrants } from '../services/external-file-grant-service'
import { captureSecureRootIdentity } from '../security/windows-safe-file-system'
import { getProjectSyncEngine, onProjectSyncSaved } from '../services/project-sync-service'
import { joinSyncProject } from '../services/project-sync-transfer'
import { createGoogleDriveAuthorization } from '../services/google-drive-authorization'
import { GoogleDriveClient, validDriveId } from '../services/google-drive-client'
import { GoogleDriveStateStore } from '../services/google-drive-state'
import { GoogleDriveSyncService } from '../services/google-drive-sync-service'
import { registerRecentProject } from './project-controller'
import path from 'node:path'
import { registerGoogleDriveBackupController } from './google-drive-backup-controller'
import { GoogleDriveBackupService, GoogleDriveBackupStore } from '../services/google-drive-backup-service'
import { getGlobalDataRoot } from '../services/app-data-locator'
import { prepareProjectAuthorAssets, projectAssetRuntimeContext, recoverProjectAuthorAssets } from '../services/project-asset-runtime'
import { ProjectAssetBlobStore } from '../services/project-asset-blob-store'
import { registerModelSettingsSyncController } from './model-settings-sync-controller'
import { GoogleDriveLocalProjects } from '../services/google-drive-local-projects'
import { sameProjectPathKey } from '../../src/shared/project-session-context'

function fail(code: string): never { throw new Error(code) }
function localFailureCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code
  if (code === 'ENOSPC') return 'DRIVE_LOCAL_STORAGE_FULL'
  if (code === 'EACCES' || code === 'EPERM' || error instanceof Error && error.message === 'SECURE_FS_ACCESS_DENIED') return 'DRIVE_LOCAL_ACCESS_DENIED'
}
function input(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('DRIVE_INPUT_INVALID')
  return raw as Record<string, unknown>
}
function capture(context: unknown) {
  let active
  try { active = projectAccess.assertCurrentProjectContext(context as ProjectSessionContext, getCurrentProjectPath()) } catch { return fail('SYNC_SESSION_STALE') }
  const database = getProjectDb()
  if (!database) fail('SYNC_SESSION_STALE')
  const revalidate = () => {
    try { projectAccess.assertCurrentProjectContext(context as ProjectSessionContext, getCurrentProjectPath()) } catch { fail('SYNC_SESSION_STALE') }
    if (getProjectDb() !== database) fail('SYNC_SESSION_STALE')
  }
  return { database, projectId: active.projectId, rootPath: active.rootPath, session: context as ProjectSessionContext, revalidate, engine: getProjectSyncEngine(database, active.projectId) }
}
let releaseSavedNotifications: (() => void) | undefined
export function registerGoogleDriveSyncController(options: { authorization?: () => GoogleDriveAuthorization; state?: GoogleDriveStateStore; client?: (token: (signal?: AbortSignal) => Promise<string>, revalidate: () => void, signal?: AbortSignal) => GoogleDriveClient; automaticTimeoutMs?: number; toggleTimeoutMs?: number } = {}) {
  releaseSavedNotifications?.()
  releaseSavedNotifications = onProjectSyncSaved(projectId => {
    localProjects.invalidate(projectId)
    for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send('sync:saved-changed', { projectId })
  })
  let authorization: GoogleDriveAuthorization | undefined
  const auth = () => authorization ??= (options.authorization ?? createGoogleDriveAuthorization)()
  const state = options.state ?? new GoogleDriveStateStore(), service = new GoogleDriveSyncService(state)
  const locks = new Set<string>()
  const localProjects = new GoogleDriveLocalProjects(state, service, locks)
  let automaticBusy = false
  let automaticOperation: { id: string; owner: number; abort: AbortController } | undefined
  const cancelAutomatic = () => automaticOperation?.abort.abort(new Error('DRIVE_CANCELLED'))
  let authGeneration = 0, authBusy = false
  const authLease = (generation: number) => { if (generation !== authGeneration) fail('GOOGLE_AUTH_CHANGED') }
  const client = (revalidate: () => void = () => {}, signal?: AbortSignal) => {
    const generation = authGeneration
    let credential: Promise<string> | undefined
    const check = () => { authLease(generation); revalidate() }
    return (options.client ?? ((token, checked, signal) => new GoogleDriveClient(token, { revalidate: checked, signal })))(async requestSignal => {
      check(); credential ??= auth().accessToken(false, requestSignal ?? signal)
      const token = await credential; check(); return token
    }, check, signal)
  }
  let backups: { cancelAll(): void } | undefined
  let modelSettings: { cancelAll(): void } | undefined
  const changeAuth = async (action: () => Promise<unknown>) => {
    if (authBusy) fail('GOOGLE_AUTH_BUSY')
    authBusy = true; const generation = ++authGeneration; cancelAutomatic(); backups?.cancelAll(); modelSettings?.cancelAll()
    try { const result = await action(); authLease(generation); return result }
    finally { authBusy = false }
  }
  const handle = (channel: string, action: (event: { sender: { id: number; isDestroyed?(): boolean; send?(channel: string, value: unknown): void } }, raw: unknown) => Promise<unknown>) => ipcMain.handle(channel, async (event, raw) => {
    try { return await action(event, raw) } catch (error) {
      const code = localFailureCode(error) ?? (error instanceof Error ? error.message : '')
      if (code === 'GOOGLE_AUTH_REQUIRED') await authorization?.invalidate().catch(() => {})
      // OAuth can succeed while the separate Drive probe fails. Keep the UI's
      // credential state accurate without claiming that the probe succeeded.
      const generation = authGeneration
      const status = channel === 'drive:connect' && !['GOOGLE_AUTH_CHANGED', 'GOOGLE_AUTH_CANCELLED'].includes(code)
        ? await authorization?.status().catch(() => undefined) : undefined
      return { success: false, error: /^(?:DRIVE|GOOGLE|SYNC|PROJECT_SYNC|MODEL_SYNC)_[A-Z0-9_]+$/.test(code) ? code : 'DRIVE_OPERATION_FAILED',
        ...(status && generation === authGeneration ? { auth: status } : {}) }
    }
  })
  backups = registerGoogleDriveBackupController({ handle, client, locks,
    service: new GoogleDriveBackupService(new GoogleDriveBackupStore(() => path.join(getGlobalDataRoot(), 'google-drive-backups'), state)),
    capture: raw => {
      const current = capture(raw), replicaId = current.engine.status().replicaId
      const binding = replicaId ? state.binding(current.projectId, replicaId) : undefined
      if (!binding) fail('DRIVE_PROJECT_NOT_BOUND')
      const generation = authGeneration
      const check = () => {
        authLease(generation); current.revalidate()
        const live = state.binding(current.projectId, binding!.replicaId)
        if (!live || live.accountId !== binding!.accountId || live.folderId !== binding!.folderId) fail('DRIVE_BINDING_CHANGED')
      }
      return { binding: binding!, rootPath: current.rootPath, session: current.session, check,
        prepare: async () => { await prepareProjectAuthorAssets(projectAssetRuntimeContext(current.database, current.projectId, current.rootPath, check)) } }
    },
  })
  handle('drive:auth-status', async () => ({ success: true, auth: await auth().status() }))
  modelSettings = registerModelSettingsSyncController({ handle, client, locks, state,
    captureAccount: () => {
      const generation = authGeneration
      return { generation, check: () => { authLease(generation); if (authBusy) fail('GOOGLE_AUTH_BUSY') } }
    }, capture: raw => {
    const current=capture(raw),replicaId=current.engine.status().replicaId
    const binding=replicaId?state.binding(current.projectId,replicaId):undefined
    if(!binding)fail('DRIVE_PROJECT_NOT_BOUND')
    const generation=authGeneration
    return{projectId:current.projectId,folderId:binding!.folderId,accountId:binding!.accountId,check:()=>{
      authLease(generation);current.revalidate()
      const live=state.binding(current.projectId,binding!.replicaId)
      if(!live||live.accountId!==binding!.accountId||live.folderId!==binding!.folderId)fail('DRIVE_BINDING_CHANGED')
    }}
  } })
  handle('drive:configure', async (_event, raw) => changeAuth(async () => {
    const value = input(raw)
    if (typeof value.clientId !== 'string') fail('GOOGLE_CLIENT_ID_INVALID')
    if (value.clientSecret !== undefined && typeof value.clientSecret !== 'string') fail('GOOGLE_CLIENT_SECRET_INVALID')
    if (value.clientSecret === undefined) await auth().configure(value.clientId.trim())
    else await auth().configure(value.clientId.trim(), value.clientSecret as string)
    return { success: true, auth: await auth().status() }
  }))
  handle('drive:connect', async () => changeAuth(async () => {
    const generation = authGeneration
    await auth().accessToken(true)
    authLease(generation)
    // An authorization result must also access this app's Drive API.
    await client().accountId()
    return { success: true, auth: await auth().status() }
  }))
  handle('drive:cancel-auth', async () => { ++authGeneration; cancelAutomatic(); backups?.cancelAll(); modelSettings?.cancelAll(); auth().cancel(); return { success: true, auth: await auth().status() } })
  handle('drive:disconnect', async () => changeAuth(async () => { await auth().disconnect(); return { success: true, auth: await auth().status() } }))
  handle('drive:list-projects', async () => ({ success: true, projects: await client().projects() }))
  handle('drive:local-projects', async () => ({ success: true, localProjects: localProjects.preferences() }))
  handle('drive:auto-sync', async (event, raw) => {
    if (automaticBusy || authBusy) fail('DRIVE_BUSY')
    const operationId = raw === undefined ? randomUUID() : input(raw).operationId
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(operationId)) fail('DRIVE_INPUT_INVALID')
    // Own the slot before authorization: silent Android authorization can itself wait.
    automaticBusy = true
    const operation = automaticOperation = { id: operationId, owner: event.sender.id, abort: new AbortController() }
    const timer = setTimeout(() => operation.abort.abort(new Error('DRIVE_SYNC_TIMEOUT')), options.automaticTimeoutMs ?? 300_000)
    const generation = authGeneration, signal = operation.abort.signal
    const check = () => {
      authLease(generation)
      if (event.sender.isDestroyed?.()) operation.abort.abort(new Error('DRIVE_CANCELLED'))
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('DRIVE_CANCELLED')
    }
    const progress: GoogleDriveProgressReporter = value => {
      check()
      event.sender.send?.('drive:sync-progress', { operationId, ...value })
    }
    try {
      progress({ stage: 'authorization' })
      const status = await auth().status(signal); check()
      if (!status.authorized || !status.available || !status.configured) return { success: true, auth: status }
      const automatic = await localProjects.synchronize(client(check, signal), check, progress); check()
      progress({ stage: 'complete' })
      return { success: true, auth: status, automatic, localProjects: localProjects.preferences() }
    } catch (error) {
      check()
      throw error
    } finally {
      clearTimeout(timer)
      // Cancellation aborts real transport. Keep ownership until it has unwound.
      if (automaticOperation === operation) { automaticOperation = undefined; automaticBusy = false }
    }
  })
  handle('drive:cancel-auto-sync', async (event, raw) => {
    const value = input(raw)
    if (typeof value.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.operationId)) fail('DRIVE_INPUT_INVALID')
    if (automaticOperation?.id === value.operationId && automaticOperation.owner === event.sender.id) cancelAutomatic()
    return { success: true }
  })
  const toggle = async (current: ReturnType<typeof capture>, enabled: boolean, name: string) => {
    if (locks.has(current.projectId)) fail('DRIVE_BUSY')
    const generation = authGeneration, abort = new AbortController()
    const timer = setTimeout(() => abort.abort(new Error('DRIVE_SYNC_TIMEOUT')), options.toggleTimeoutMs ?? 300_000)
    const checked = () => { authLease(generation); current.revalidate(); if (abort.signal.aborted) throw abort.signal.reason }
    let phase = 'DRIVE_PREPARE_FAILED'
    locks.add(current.projectId)
    try {
      const driveClient = client(checked, abort.signal)
      if (!enabled) {
        const replicaId = current.engine.status().replicaId, binding = replicaId ? state.binding(current.projectId, replicaId) : undefined
        service.cancelEnable(current.projectId, replicaId)
        if (!binding) return { success: true, drive: { bound: false } }
        service.setAutoSync(current.projectId, binding.replicaId, false)
        state.update(state => { state.bindings[`${binding.projectId}|${binding.replicaId}`].pendingDisable = true })
        try {
          if (await driveClient.accountId() !== binding.accountId) fail('DRIVE_ACCOUNT_MISMATCH')
          checked(); await driveClient.setProjectAutoSync(binding.folderId, current.projectId, false); checked()
          state.update(state => { state.bindings[`${binding.projectId}|${binding.replicaId}`].pendingDisable = false })
        } catch { checked() /* Local pause persists; the next authorized tick propagates it. */ }
        return { success: true, status: current.engine.status(), drive: service.status(current.projectId, binding.replicaId) }
      }
      const store = await prepareProjectAuthorAssets(projectAssetRuntimeContext(current.database, current.projectId, current.rootPath, checked)); checked()
      current.engine.enable()
      const replicaId = current.engine.status().replicaId!
      phase = 'DRIVE_BIND_FAILED'
      const accountId = await driveClient.accountId(); checked()
      // Persist only after the account is known. A failed first upload can then
      // resume the same project/folder, never silently publish to a new account.
      service.requestEnable({ accountId, projectId: current.projectId, replicaId, localPath: current.rootPath, name: name.slice(0, 200) })
      let binding = state.binding(current.projectId, replicaId)
      if (!binding) binding = await service.bind(driveClient, current.projectId, replicaId, name, undefined, checked)
      checked(); localProjects.rememberPath(current.projectId, binding.replicaId, current.rootPath)
      phase = 'DRIVE_UPLOAD_FAILED'
      await service.exchange(driveClient, current.projectId, current.engine, checked, store); checked()
      return { success: true, status: current.engine.status(), drive: service.status(current.projectId, binding.replicaId) }
    } catch (error) {
      checked()
      if (error instanceof Error && /^(?:DRIVE|GOOGLE|SYNC|PROJECT_SYNC)_[A-Z0-9_]+$/.test(error.message)) throw error
      const nativeCode = localFailureCode(error)
      if (nativeCode) fail(nativeCode)
      fail(phase)
    } finally { clearTimeout(timer); locks.delete(current.projectId) }
  }
  handle('drive:toggle-project', async (_event, raw) => {
    const value = input(raw)
    if (typeof value.path !== 'string' || typeof value.enabled !== 'boolean') fail('DRIVE_INPUT_INVALID')
    const project = localProjects.locals().find(project => sameProjectPathKey(project.path, value.path as string))
    if (!project) fail('DRIVE_INPUT_INVALID')
    if (sameProjectPathKey(getCurrentProjectPath(), project.path)) return toggle(capture(value.projectSession), value.enabled as boolean, path.basename(project.path))
    const generation = authGeneration
    return localProjects.withClosedProject(project, () => authLease(generation), async (database, revalidate) => toggle({ database, projectId: project.projectId, rootPath: project.path,
      session: value.projectSession as ProjectSessionContext, revalidate, engine: getProjectSyncEngine(database, project.projectId) }, value.enabled as boolean, path.basename(project.path)))
  })
  for (const action of ['project-status', 'bind', 'exchange', 'set-auto-sync'] as const) handle(`drive:${action}`, async (_event, raw) => {
    const value = input(raw), current = capture(value.projectSession)
    if (action === 'project-status') {
      await recoverProjectAuthorAssets(projectAssetRuntimeContext(current.database, current.projectId, current.rootPath, current.revalidate))
      current.revalidate()
      return { success: true, status: current.engine.status(), drive: service.status(current.projectId, current.engine.status().replicaId) }
    }
    if (action === 'set-auto-sync') {
      if (typeof value.enabled !== 'boolean') fail('DRIVE_INPUT_INVALID')
      current.revalidate()
      return toggle(current, value.enabled as boolean, path.basename(current.rootPath))
    }
    const generation = authGeneration
    const checked = () => { authLease(generation); current.revalidate() }
    if (locks.has(current.projectId)) fail('DRIVE_BUSY')
    locks.add(current.projectId)
    try {
      const store = await prepareProjectAuthorAssets(projectAssetRuntimeContext(current.database, current.projectId, current.rootPath, checked))
      checked()
      if (action === 'bind') {
        if (value.folderId !== undefined && !validDriveId(value.folderId) || value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 200)) fail('DRIVE_INPUT_INVALID')
        current.engine.enable()
        await service.bind(client(checked), current.projectId, current.engine.status().replicaId!, typeof value.name === 'string' ? value.name : current.projectId.slice(0, 8), value.folderId as string | undefined, checked)
        checked()
        return { success: true, status: current.engine.status(), drive: service.status(current.projectId, current.engine.status().replicaId) }
      }
      return await service.exchange(client(checked), current.projectId, current.engine, checked, store)
    } finally { locks.delete(current.projectId) }
  })
  handle('drive:join', async (event, raw) => {
    const value = input(raw)
    if (!validDriveId(value.folderId) || typeof value.targetGrantId !== 'string') fail('DRIVE_INPUT_INVALID')
    const permission = { grantId: value.targetGrantId, webContentsId: event.sender.id, operation: 'sync-project-join' as const }
    if (externalFileGrants.revalidate(permission).scope !== 'file') fail('SYNC_GRANT_INVALID')
    const use = externalFileGrants.beginUse(permission), capability = use.capability
    const target = path.join(capability.rootPath, capability.relativePath)
    const generation = authGeneration
    const revalidate = () => {
      authLease(generation)
      try { use.revalidate() } catch { fail('SYNC_GRANT_INVALID') }
      const current = captureSecureRootIdentity(capability.rootPath)
      if (current.volumeSerialNumber !== capability.rootIdentity.volumeSerialNumber || current.fileIndex !== capability.rootIdentity.fileIndex) fail('SYNC_GRANT_INVALID')
    }
    try {
      revalidate()
      const driveClient = client(revalidate), downloaded = await service.downloadProject(driveClient, value.folderId, revalidate)
      let joinedReplicaId = ''
      const result = await joinSyncProject({ bundle: downloaded.bundle, targetProjectPath: target, assertTargetAuthorized: revalidate,
        prepareAssets: async (_database, storageRoot) => service.hydrateBundleAssets(driveClient, downloaded.bundle, value.folderId as string, new ProjectAssetBlobStore(storageRoot), revalidate),
        materializeAssets: (database, storageRoot) => recoverProjectAuthorAssets({ database, projectId: downloaded.bundle.projectId, storageRoot, revalidate }),
        join: (database, projectId, bundle) => { const engine = getProjectSyncEngine(database, projectId), result = engine.join(bundle); joinedReplicaId = engine.status().replicaId!; return result } })
      use.complete()
      let warning: string | undefined
      try { service.rememberJoined(downloaded.binding, joinedReplicaId) } catch { warning = 'DRIVE_BINDING_NOT_SAVED' }
      if (!warning) localProjects.rememberPath(result.projectId, joinedReplicaId, result.projectPath)
      try { registerRecentProject({ name: path.basename(result.projectPath), path: result.projectPath, projectId: result.projectId, updatedAt: new Date().toISOString() }) } catch { /* The committed copy remains available at projectPath. */ }
      return { success: true, projectPath: result.projectPath, applied: result.applied, drive: warning ? { bound: false, error: warning } : service.status(result.projectId, joinedReplicaId) }
    } finally { use.release() }
  })
}
