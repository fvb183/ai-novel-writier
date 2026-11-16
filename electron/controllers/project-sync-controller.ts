import fs from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import { showOpenDialogInLastDirectory, showSaveDialogInLastDirectory } from '../utils/remembered-dialog'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import type { SyncBundle, SyncResolution } from '../../src/shared/project-sync'
import { getCurrentProjectPath, getProjectDb } from '../database'
import { projectAccess } from '../services/project-access'
import { externalFileGrants, type ExternalFileGrantOperation, type ExternalFileGrantService, type IssuedExternalFileGrant } from '../services/external-file-grant-service'
import { getProjectSyncEngine } from '../services/project-sync-service'
import { joinSyncProject, readSyncPackage, writeSyncPackage } from '../services/project-sync-transfer'
import { applyProjectAuthorSync, prepareProjectAuthorAssets, projectAssetRuntimeContext, recoverProjectAuthorAssets } from '../services/project-asset-runtime'
import { attachBundleAssets, stageBundleAssets } from '../services/project-sync-asset-transfer'
import { ProjectAssetBlobStore } from '../services/project-asset-blob-store'
import { parseProjectAuthorAsset } from '../../src/shared/project-sync-assets'
import { previewProjectAuthorAsset } from '../services/project-asset-preview'
import { registerRecentProject } from './project-controller'

const TTL = 10 * 60 * 1000
interface SyncEvent { sender: { id: number; once(event: 'destroyed', listener: () => void): unknown } }
interface SyncRequest { projectSession?: ProjectSessionContext; sourceGrantId?: string; targetGrantId?: string; token?: string; resolutions?: SyncResolution[]; assetId?: string; revision?: string; filePath?: string; offset?: number }
function fail(code: string): never { throw new Error(code) }
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return { success: false as const, error: /^(?:SYNC|PROJECT_SYNC)_[A-Z0-9_]+$/.test(message) ? message : 'SYNC_OPERATION_FAILED' }
}
function request(value: unknown): SyncRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SYNC_INPUT_INVALID')
  return value as SyncRequest
}
function suggested(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const name = value.trim().replace(/[\x00-\x1f<>:"/\\|?*]/g, '-').replace(/[. ]+$/, '').slice(0, 80)
  return name && name !== '.' && name !== '..' && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? name : fallback
}
function selected(event: SyncEvent, grants: ExternalFileGrantService, grant: IssuedExternalFileGrant, file: string) {
  event.sender.once('destroyed', () => grants.revoke(grant.grantId))
  return { grantId: grant.grantId, displayName: path.basename(file) }
}
function capture(context: ProjectSessionContext | undefined) {
  let active
  try { active = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath()) }
  catch { return fail('SYNC_SESSION_STALE') }
  const database = getProjectDb()
  if (!database) fail('SYNC_SESSION_STALE')
  const revalidate = () => {
    try { projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath()) }
    catch { fail('SYNC_SESSION_STALE') }
    if (getProjectDb() !== database) fail('SYNC_SESSION_STALE')
  }
  return { database, active, revalidate, engine: getProjectSyncEngine(database, active.projectId) }
}

export function registerProjectSyncController(grants: ExternalFileGrantService = externalFileGrants): void {
  const granted = (event: SyncEvent, grantId: unknown, operation: ExternalFileGrantOperation) => {
    try {
      if (typeof grantId !== 'string' || !grantId) fail('SYNC_GRANT_INVALID')
      const permission = { grantId, webContentsId: event.sender.id, operation }
      if (grants.revalidate(permission).scope !== 'file') fail('SYNC_GRANT_INVALID')
      const use = grants.beginUse(permission), capability = use.capability
      const file = path.join(capability.rootPath, capability.relativePath)
      const revalidate = () => {
        try { use.revalidate() } catch { fail('SYNC_GRANT_INVALID') }
      }
      return { capability, file, revalidate, complete: use.complete, release: use.release }
    } catch { return fail('SYNC_GRANT_INVALID') }
  }
  ipcMain.handle('dialog:select-sync-export', async (event: SyncEvent, name: string) => {
    const choice = await showSaveDialogInLastDirectory('project-archive', { title: '导出同步包', defaultPath: `${suggested(name, 'project')}.ainovelsync`, filters: [{ name: 'AI Novel Sync', extensions: ['ainovelsync'] }] })
    if (choice.canceled || !choice.filePath) return null
    if (fs.existsSync(choice.filePath)) fail('SYNC_TARGET_EXISTS')
    return selected(event, grants, grants.issueNewChild({ webContentsId: event.sender.id, filePath: choice.filePath,
      operations: ['sync-package-create'], ttlMs: TTL, maxUses: 1 }), choice.filePath)
  })
  ipcMain.handle('dialog:select-sync-package', async (event: SyncEvent) => {
    const options = { title: '选择同步包', properties: ['openFile'] as ('openFile')[], filters: [{ name: 'AI Novel Sync', extensions: ['ainovelsync'] }], purpose: 'sync-package-read' }
    const choice = await showOpenDialogInLastDirectory('project-archive', options)
    const file = choice.canceled ? undefined : choice.filePaths[0]
    if (!file) return null
    return selected(event, grants, grants.issueFile({ webContentsId: event.sender.id, filePath: file,
      operations: ['sync-package-read'], ttlMs: TTL, maxUses: 1 }), file)
  })
  ipcMain.handle('dialog:select-sync-join-target', async (event: SyncEvent, name: string) => {
    // The Android shim transports purpose explicitly; title is presentation only.
    const options = { title: '选择同步副本所在文件夹', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], purpose: 'sync-project-location' }
    const choice = await showOpenDialogInLastDirectory('project-restore-target', options)
    const parent = choice.canceled ? undefined : choice.filePaths[0]
    if (!parent) return null
    const base = suggested(name, 'sync-project')
    let target = path.join(parent, base)
    for (let index = 2; fs.existsSync(target) && index < 1000; index++) target = path.join(parent, `${base}-${index}`)
    if (fs.existsSync(target)) fail('SYNC_TARGET_EXISTS')
    return selected(event, grants, grants.issueNewChild({ webContentsId: event.sender.id, filePath: target,
      operations: ['sync-project-join'], ttlMs: TTL, maxUses: 1 }), target)
  })
  for (const action of ['status', 'enable', 'preview', 'recover-assets'] as const) {
    ipcMain.handle(`sync:${action}`, async (_event: SyncEvent, raw: unknown) => {
      try {
        const current = capture(request(raw).projectSession)
        const assets = projectAssetRuntimeContext(current.database, current.active.projectId, current.active.rootPath, current.revalidate)
        if (action === 'enable' || action === 'preview') await prepareProjectAuthorAssets(assets)
        else await recoverProjectAuthorAssets(assets)
        current.revalidate()
        if (action === 'enable') current.engine.enable()
        return { success: true as const, status: current.engine.status(), ...(action === 'preview' ? { preview: current.engine.preview() } : {}) }
      } catch (error) { return failure(error) }
    })
  }
  ipcMain.handle('sync:export', async (event: SyncEvent, raw: unknown) => {
    try {
      const input = request(raw), current = capture(input.projectSession)
      const store = await prepareProjectAuthorAssets(projectAssetRuntimeContext(current.database, current.active.projectId, current.active.rootPath, current.revalidate))
      current.revalidate()
      const target = granted(event, input.targetGrantId, 'sync-package-create')
      try {
        const bundle = attachBundleAssets(current.engine.exportBundle(), store)
        writeSyncPackage(target.file, bundle, () => { current.revalidate(); target.revalidate() })
        target.complete()
        return { success: true as const, status: current.engine.status(), filePath: target.file }
      } finally { target.release() }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('sync:import-preview', async (event: SyncEvent, raw: unknown) => {
    try {
      const input = request(raw), current = capture(input.projectSession)
      const store = await prepareProjectAuthorAssets(projectAssetRuntimeContext(current.database, current.active.projectId, current.active.rootPath, current.revalidate))
      const source = granted(event, input.sourceGrantId, 'sync-package-read')
      try {
        const bundle = await readSyncPackage(source.capability)
        current.revalidate(); source.revalidate()
        stageBundleAssets(bundle, store, () => { current.revalidate(); source.revalidate() })
        const preview = current.engine.receive(bundle)
        source.complete()
        return { success: true as const, status: current.engine.status(), preview }
      } finally { source.release() }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('sync:apply', async (_event: SyncEvent, raw: unknown) => {
    try {
      const input = request(raw), current = capture(input.projectSession)
      if (typeof input.token !== 'string' || !input.token || !Array.isArray(input.resolutions)) fail('SYNC_INPUT_INVALID')
      const applied = await applyProjectAuthorSync(projectAssetRuntimeContext(current.database, current.active.projectId, current.active.rootPath, current.revalidate), input.token, input.resolutions)
      current.revalidate()
      return { success: true as const, status: current.engine.status(), preview: applied.preview, applied }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('sync:asset-preview', (_event: SyncEvent, raw: unknown) => {
    try {
      const input = request(raw), current = capture(input.projectSession), preview = current.engine.preview()
      if (input.token !== preview.token) fail('SYNC_PREVIEW_STALE')
      const variant = preview.conflicts.find(record => record.kind === 'project-asset' && record.id === input.assetId)?.variants
        .find(variant => variant.revision === input.revision)
      if (!variant) fail('SYNC_ASSET_PREVIEW_INVALID')
      if (variant.deleted) return { success: true, preview: { category: 'files' as const, title: input.assetId!, deleted: true } }
      const result = previewProjectAuthorAsset(parseProjectAuthorAsset(variant.value),
        new ProjectAssetBlobStore(path.join(current.active.rootPath, '.ai-novel')), { filePath: input.filePath, offset: input.offset })
      current.revalidate()
      return { success: true, preview: result }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('sync:join', async (event: SyncEvent, raw: unknown) => {
    try {
      const input = request(raw)
      const source = granted(event, input.sourceGrantId, 'sync-package-read')
      try {
        const target = granted(event, input.targetGrantId, 'sync-project-join')
        try {
          const bundle: SyncBundle = await readSyncPackage(source.capability)
          source.revalidate(); target.revalidate()
          const checked = () => { source.revalidate(); target.revalidate() }
          const result = await joinSyncProject({ bundle, targetProjectPath: target.file,
            assertTargetAuthorized: checked,
            prepareAssets: async (_database, storageRoot) => stageBundleAssets(bundle, new ProjectAssetBlobStore(storageRoot), checked),
            materializeAssets: (database, storageRoot) => recoverProjectAuthorAssets({ database, projectId: bundle.projectId, storageRoot, revalidate: checked }),
            join: (database, projectId, checkedBundle) => getProjectSyncEngine(database, projectId).join(checkedBundle) })
          source.complete(); target.complete()
          let recentProjectUpdated = true
          try { registerRecentProject({ name: path.basename(result.projectPath), path: result.projectPath, projectId: result.projectId, updatedAt: new Date().toISOString() }) }
          catch { recentProjectUpdated = false }
          return { success: true as const, projectPath: result.projectPath, applied: result.applied, recentProjectUpdated }
        } finally { target.release() }
      } finally { source.release() }
    } catch (error) { return failure(error) }
  })
}
