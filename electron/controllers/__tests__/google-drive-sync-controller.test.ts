import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoogleDriveAuthorization } from '../../../src/shared/google-drive-sync'
import type { SyncBundle } from '../../../src/shared/project-sync'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(), root: 'C:/synthetic/drive-project', projectId: '', lease: 'lease-a', database: {},
  grantValid: true, prepareError: '', prepareCode: '', identity: { volumeSerialNumber: 1, fileIndex: 'parent-root' },
  grants: { revalidate: vi.fn(), resolveExactPath: vi.fn(), beginUse: vi.fn() }, transfer: vi.fn(), recent: vi.fn(),
  engine: { status: vi.fn(), enable: vi.fn(), exportBundle: vi.fn(), receive: vi.fn(), preview: vi.fn() },
  joined: { status: vi.fn(), join: vi.fn() }, joinedDb: {},
}))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => Promise<any>) => mocks.handlers.set(name, fn) },
  safeStorage: { isEncryptionAvailable: () => false }, shell: { openExternal: vi.fn() } }))
vi.mock('../../database', () => ({ getCurrentProjectPath: () => mocks.root, getProjectDb: () => mocks.database }))
vi.mock('../../services/project-access', () => ({ projectAccess: { assertCurrentProjectContext(value: any) {
  if (value?.projectId !== mocks.projectId || value?.projectPath !== mocks.root || value?.leaseId !== mocks.lease) throw new Error('stale')
  return { rootPath: mocks.root, projectId: mocks.projectId }
} } }))
vi.mock('../../services/project-sync-service', () => ({ onProjectSyncSaved: () => () => {}, getProjectSyncEngine: (db: unknown) => db === mocks.joinedDb ? mocks.joined : mocks.engine }))
vi.mock('../../services/project-asset-runtime', () => ({
  projectAssetRuntimeContext: (database: unknown, projectId: string, rootPath: string, revalidate: () => void) => ({ database, projectId, rootPath, revalidate }),
  prepareProjectAuthorAssets: async (context: { revalidate(): void }) => { context.revalidate(); if (mocks.prepareError) throw Object.assign(new Error(mocks.prepareError), { code: mocks.prepareCode }); return {} },
  recoverProjectAuthorAssets: async (context: { revalidate(): void }) => { context.revalidate() },
}))
vi.mock('../../services/external-file-grant-service', () => ({ externalFileGrants: mocks.grants }))
vi.mock('../../security/windows-safe-file-system', () => ({ captureSecureRootIdentity: () => mocks.identity }))
vi.mock('../../services/project-sync-transfer', () => ({ joinSyncProject: mocks.transfer }))
vi.mock('../project-controller', () => ({ registerRecentProject: mocks.recent }))

import { registerGoogleDriveSyncController } from '../google-drive-sync-controller'
import { GoogleDriveStateStore, driveReplicaKey, type DriveState } from '../../services/google-drive-state'
import { GoogleDriveClient } from '../../services/google-drive-client'
import { syncDigest } from '../../services/project-sync-engine'
import { GoogleDriveLocalProjects } from '../../services/google-drive-local-projects'

const token = 'synthetic-private-access-token'
const event = { sender: { id: 11 } }
const invoke = (channel: string, input?: unknown) => mocks.handlers.get(channel)!(event, input)
const context = () => ({ projectId: mocks.projectId, projectPath: mocks.root, leaseId: 'lease-a' })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let stored: DriveState, state: GoogleDriveStateStore, auth: GoogleDriveAuthorization
let replicaId: string, joinedReplicaId: string, bytes: Uint8Array, includeRemoteFile: boolean
let fetchDownload: () => Promise<Uint8Array>, publish: (upload: { sessionUrl?: string }) => Promise<boolean>, accountFailure: string | undefined
let updateAutoSync: () => Promise<void>
function fixture() {
  vi.clearAllMocks(); mocks.handlers.clear(); mocks.projectId = randomUUID(); mocks.lease = 'lease-a'; mocks.database = {}; mocks.joinedDb = {}; mocks.grantValid = true; mocks.prepareError = ''; mocks.prepareCode = ''
  replicaId = randomUUID(); joinedReplicaId = randomUUID()
  const senderReplicaId = randomUUID()
  const batchBody = { protocol: 1 as const, projectId: mocks.projectId, replicaId: senderReplicaId, sequence: 1, previousHash: null, batchId: randomUUID(),
    changes: [{ kind: 'synthetic-record', id: 'author-record', parents: [], value: 'saved author content', deleted: false }] }
  const raw = { format: 'ai-novel-sync' as const, version: 1 as const, projectId: mocks.projectId, senderReplicaId, batches: [{ ...batchBody, hash: syncDigest(batchBody) }] }
  const bundle: SyncBundle = { ...raw, hash: syncDigest(raw) }
  bytes = new TextEncoder().encode(JSON.stringify(bundle))
  stored = { version: 1, bindings: { [driveReplicaKey(mocks.projectId, replicaId)]: { accountId: 'account-a', projectId: mocks.projectId, replicaId,
    folderId: 'cloud-folder', files: [], received: {}, uploads: {} } }, creating: {} }
  state = new GoogleDriveStateStore({ read: () => structuredClone(stored), write: value => { stored = structuredClone(value) } })
  auth = { status: vi.fn<GoogleDriveAuthorization['status']>(async () => ({ platform: 'desktop', available: true, configured: true, authorized: true, persistence: 'session-only' })),
    configure: vi.fn(async () => {}), accessToken: vi.fn(async () => token), disconnect: vi.fn(async () => {}), invalidate: vi.fn(async () => {}), cancel: vi.fn() }
  mocks.engine.status.mockReturnValue({ enabled: true, projectId: mocks.projectId, replicaId })
  mocks.engine.exportBundle.mockReturnValue(bundle)
  mocks.engine.preview.mockReturnValue({ token: 'preview', pendingBatches: 0, changedRecords: 0, missingBatchHashes: [], conflicts: [], canApply: true })
  mocks.joined.status.mockReturnValue({ enabled: true, projectId: mocks.projectId, replicaId: joinedReplicaId })
  mocks.joined.join.mockReturnValue({ applied: true, appliedBatches: 1 })
  mocks.grants.revalidate.mockImplementation(() => {
    if (!mocks.grantValid) throw new Error('SYNC_GRANT_INVALID')
    return { scope: 'file', rootPath: 'C:/synthetic/selected-parent', relativePath: 'joined-copy', rootIdentity: { ...mocks.identity } }
  })
  mocks.grants.beginUse.mockImplementation(() => ({ capability: mocks.grants.revalidate(),
    revalidate: () => { mocks.grants.revalidate() }, complete: () => { mocks.grants.revalidate() }, release: () => {} }))
  mocks.grants.resolveExactPath.mockReturnValue('C:/synthetic/selected-parent/joined-copy')
  mocks.transfer.mockImplementation((request: any) => { request.assertTargetAuthorized(); const applied = request.join(mocks.joinedDb, mocks.projectId, request.bundle)
    return { projectPath: request.targetProjectPath, projectId: mocks.projectId, applied } })
  fetchDownload = async () => bytes; publish = async () => true; updateAutoSync = async () => {}; includeRemoteFile = true; accountFailure = undefined
  registerGoogleDriveSyncController({ authorization: () => auth, state, client: (getToken, check) => {
    const client = { accountId: async () => { await getToken(); check(); if (accountFailure) throw new Error(accountFailure); return 'account-a' },
      checkFolder: async () => { check(); return { id: 'cloud-folder', name: 'Cloud project', appProperties: { ainwProject: mocks.projectId } } },
      discover: async () => { check(); return { cursor: 'cursor-after-download', files: includeRemoteFile ? [{ id: 'remote-object', name: 'changes', appProperties: { ainwDigest: 'a'.repeat(64) } }] : [] } },
      download: async () => fetchDownload(),
      allocateId: async () => { check(); return 'allocated-upload' },
      setProjectAutoSync: async () => { await updateAutoSync(); check() },
      publish: async (_folder: string, _project: string, _bytes: Uint8Array, upload: { sessionUrl?: string }) => publish(upload),
      projects: async () => [] }
    return client as unknown as GoogleDriveClient
  } })
}
beforeEach(fixture)
afterEach(() => { vi.restoreAllMocks() })

describe('Google Drive controller authority boundaries', () => {
  it('keeps a cloud join filesystem denial distinct from an unknown Drive failure', async () => {
    mocks.transfer.mockRejectedValue(Object.assign(new Error('private path ' + token), { code: 'EACCES' }))
    expect(await invoke('drive:join', { folderId: 'cloud-folder', targetGrantId: 'selected-grant' })).toEqual({ success: false, error: 'DRIVE_LOCAL_ACCESS_DENIED' })
  })
  it.each([['EPERM', 'DRIVE_LOCAL_ACCESS_DENIED'], ['EACCES', 'DRIVE_LOCAL_ACCESS_DENIED'], ['ENOSPC', 'DRIVE_LOCAL_STORAGE_FULL']])('preserves native %s without disclosing its raw message', async (code, expected) => {
    mocks.prepareError = 'private path and token ' + token; mocks.prepareCode = code
    expect(await invoke('drive:set-auto-sync', { projectSession: context(), enabled: true })).toEqual({ success: false, error: expected })
  })
  it('serializes an old queued pause before a new switch-on so it cannot overwrite the later intent', async () => {
    vi.spyOn(GoogleDriveLocalProjects.prototype, 'locals').mockReturnValue([])
    vi.spyOn(GoogleDriveLocalProjects.prototype, 'preferences').mockReturnValue([])
    state.update(state => { state.bindings[driveReplicaKey(mocks.projectId, replicaId)].pendingDisable = true })
    const started = deferred<void>(), release = deferred<void>()
    updateAutoSync = async () => { started.resolve(); await release.promise }
    const pending = invoke('drive:auto-sync', { operationId: 'queued-pause' })
    await started.promise
    expect(await invoke('drive:set-auto-sync', { projectSession: context(), enabled: true })).toEqual({ success: false, error: 'DRIVE_BUSY' })
    release.resolve(); expect(await pending).toMatchObject({ success: true })
    updateAutoSync = async () => {}
    expect(await invoke('drive:set-auto-sync', { projectSession: context(), enabled: true })).toMatchObject({ success: true, drive: { autoSync: true } })
    expect(state.binding(mocks.projectId, replicaId)?.pendingDisable).toBe(false)
  })
  it('persists the explicit switch-on and canonical path when first upload fails, then clears it after retry', async () => {
    // No completed cloud baseline exists on first upload. The default fixture
    // already contains this exact batch, which correctly skips publication.
    includeRemoteFile = false
    let publicationAttempts = 0
    publish = async () => { publicationAttempts++; throw new Error('DRIVE_REQUEST_TIMEOUT') }
    expect(await invoke('drive:set-auto-sync', { projectSession: context(), enabled: true })).toEqual({ success: false, error: 'DRIVE_REQUEST_TIMEOUT' })
    expect(publicationAttempts).toBe(1)
    expect(stored.enabling?.[driveReplicaKey(mocks.projectId, replicaId)]).toMatchObject({ accountId: 'account-a', localPath: mocks.root, replicaId })
    expect(state.binding(mocks.projectId, replicaId)).toMatchObject({ autoSync: true, localPath: mocks.root })
    expect(await invoke('drive:project-status', { projectSession: context() })).toMatchObject({ drive: { autoSync: true, preferencePending: true } })
    publish = async () => { publicationAttempts++; return true }
    expect(await invoke('drive:exchange', { projectSession: context() })).toMatchObject({ success: true, drive: { autoSync: true } })
    expect(publicationAttempts).toBe(2)
    expect(stored.enabling).toEqual({})
  })

  it('retains a local pause after a failed first upload and does not retry it', async () => {
    publish = async () => { throw new Error('DRIVE_REQUEST_TIMEOUT') }
    await invoke('drive:set-auto-sync', { projectSession: context(), enabled: true })
    expect(await invoke('drive:set-auto-sync', { projectSession: context(), enabled: false })).toMatchObject({ success: true, drive: { autoSync: false } })
    expect(stored.enabling).toEqual({})
    expect(state.binding(mocks.projectId, replicaId)?.autoSync).toBe(false)
  })

  it('reports a safe preparation phase without leaking a native path or credentials', async () => {
    mocks.prepareError = 'private native path and token ' + token
    expect(await invoke('drive:set-auto-sync', { projectSession: context(), enabled: true })).toEqual({ success: false, error: 'DRIVE_PREPARE_FAILED' })
    expect(stored.enabling).toBeUndefined()
  })

  it('bounds the entire switch-on and never queues an upload before the account is known', async () => {
    let signal: AbortSignal | undefined
    registerGoogleDriveSyncController({ authorization: () => auth, state, toggleTimeoutMs: 5, client: (_token, _check, currentSignal) => {
      signal = currentSignal
      return { accountId: () => new Promise((_resolve, reject) => currentSignal!.addEventListener('abort', () => reject(currentSignal!.reason), { once: true })) } as unknown as GoogleDriveClient
    } })
    expect(await invoke('drive:set-auto-sync', { projectSession: context(), enabled: true })).toEqual({ success: false, error: 'DRIVE_SYNC_TIMEOUT' })
    expect(signal?.aborted).toBe(true); expect(stored.enabling).toBeUndefined()
  })
  it('owns the automatic slot while silent authorization is still pending', async () => {
    const status = deferred<Awaited<ReturnType<GoogleDriveAuthorization['status']>>>()
    vi.mocked(auth.status).mockReturnValueOnce(status.promise)
    const running = invoke('drive:auto-sync', { operationId: 'authorization-wait' })
    expect(await invoke('drive:auto-sync', { operationId: 'second-wait' })).toEqual({ success: false, error: 'DRIVE_BUSY' })
    expect(auth.status).toHaveBeenCalledOnce()
    status.resolve({ platform: 'android', available: true, configured: true, authorized: false, persistence: 'google-play-services' })
    expect(await running).toMatchObject({ success: true, auth: { authorized: false } })
  })
  it('passes cancellation through the authorization-status wait before opening a project', async () => {
    const started = deferred<AbortSignal>()
    vi.mocked(auth.status).mockImplementationOnce(signal => new Promise((_resolve, reject) => {
      started.resolve(signal!)
      signal!.addEventListener('abort', () => reject(new Error('DRIVE_CANCELLED')), { once: true })
    }))
    const running = invoke('drive:auto-sync', { operationId: 'cancel-authorization-status' })
    const signal = await started.promise
    expect(signal.aborted).toBe(false)
    expect(await invoke('drive:cancel-auto-sync', { operationId: 'cancel-authorization-status' })).toEqual({ success: true })
    expect(await running).toEqual({ success: false, error: 'DRIVE_CANCELLED' })
    expect(signal.aborted).toBe(true)
    expect(auth.accessToken).not.toHaveBeenCalled()
    expect(mocks.engine.receive).not.toHaveBeenCalled()
  })
  it('cancels only the initiating window operation and retains the slot until work unwinds', async () => {
    const started = deferred<void>(), release = deferred<void>(), send = vi.fn()
    vi.spyOn(GoogleDriveLocalProjects.prototype, 'synchronize').mockImplementation(async (_client, check, progress) => {
      progress?.({ stage: 'catalog' }); started.resolve(); await release.promise; check()
      return { imported: 0, updated: 0, conflicts: [], failures: [] }
    })
    vi.spyOn(GoogleDriveLocalProjects.prototype, 'preferences').mockReturnValue([])
    const running = mocks.handlers.get('drive:auto-sync')!({ sender: { id: 11, send } }, { operationId: 'owned-operation' })
    await started.promise
    expect(send).toHaveBeenCalledWith('drive:sync-progress', { operationId: 'owned-operation', stage: 'catalog' })
    expect(await mocks.handlers.get('drive:cancel-auto-sync')!({ sender: { id: 99 } }, { operationId: 'owned-operation' })).toEqual({ success: true })
    expect(await invoke('drive:cancel-auto-sync', { operationId: 'unrelated-operation' })).toEqual({ success: true })
    expect(await invoke('drive:cancel-auto-sync', { operationId: 'owned-operation' })).toEqual({ success: true })
    expect(await invoke('drive:auto-sync')).toEqual({ success: false, error: 'DRIVE_BUSY' })
    release.resolve(); expect(await running).toEqual({ success: false, error: 'DRIVE_CANCELLED' })
    expect(await invoke('drive:auto-sync')).toMatchObject({ success: true })
  })
  it('finishes an expired automatic cycle with a fixed error before accepting a fresh cycle', async () => {
    registerGoogleDriveSyncController({ authorization: () => auth, state, automaticTimeoutMs: 5 })
    vi.spyOn(GoogleDriveLocalProjects.prototype, 'synchronize').mockImplementation(async (_client, check) => {
      await new Promise(resolve => setTimeout(resolve, 20)); check()
      return { imported: 0, updated: 0, conflicts: [], failures: [] }
    })
    expect(await invoke('drive:auto-sync', { operationId: 'expired-operation' })).toEqual({ success: false, error: 'DRIVE_SYNC_TIMEOUT' })
    expect(JSON.stringify(await invoke('drive:auto-sync', { operationId: '../bad-id' }))).not.toContain(token)
    expect(await invoke('drive:auto-sync', { operationId: '../bad-id' })).toEqual({ success: false, error: 'DRIVE_INPUT_INVALID' })
  })
  it('returns actual authorization without reporting success when the subsequent Drive probe is unreachable', async () => {
    accountFailure = 'DRIVE_NETWORK_FAILED'
    expect(await invoke('drive:connect')).toMatchObject({ success: false, error: 'DRIVE_NETWORK_FAILED', auth: { authorized: true } })
    expect(auth.invalidate).not.toHaveBeenCalled()
    expect(mocks.engine.enable).not.toHaveBeenCalled()
    expect(mocks.engine.exportBundle).not.toHaveBeenCalled()
    expect(JSON.stringify(await invoke('drive:auth-status'))).not.toContain(token)
    accountFailure = undefined
    expect(await invoke('drive:connect')).toMatchObject({ success: true, auth: { authorized: true } })
  })
  it('invalidates a rejected token before returning the failed Drive probe status', async () => {
    accountFailure = 'GOOGLE_AUTH_REQUIRED'
    vi.mocked(auth.invalidate).mockImplementation(async () => { vi.mocked(auth.status).mockResolvedValue({ platform: 'desktop', available: true, configured: true, authorized: false, persistence: 'session-only' }) })
    expect(await invoke('drive:connect')).toMatchObject({ success: false, error: 'GOOGLE_AUTH_REQUIRED', auth: { authorized: false } })
    expect(auth.invalidate).toHaveBeenCalledOnce()
  })
  it('requires the captured full project lease before any engine access', async () => {
    expect(await invoke('drive:bind', {})).toEqual({ success: false, error: 'SYNC_SESSION_STALE' })
    expect(mocks.engine.enable).not.toHaveBeenCalled()
    expect(mocks.engine.status).not.toHaveBeenCalled()
  })
  it('stops a downloaded update before receive or completion records when the project lease changes', async () => {
    const pending = deferred<Uint8Array>(), started = deferred<void>()
    fetchDownload = async () => { started.resolve(); return pending.promise }
    const before = structuredClone(stored)
    const running = invoke('drive:exchange', { projectSession: context() })
    await started.promise; mocks.lease = 'replacement-lease'; pending.resolve(bytes)
    expect(await running).toEqual({ success: false, error: 'SYNC_SESSION_STALE' })
    expect(mocks.engine.receive).not.toHaveBeenCalled()
    expect(mocks.engine.enable).not.toHaveBeenCalled()
    expect(mocks.engine.exportBundle).not.toHaveBeenCalled()
    expect(stored).toEqual(before)
  })
  it('does not finish an old upload after cancel, disconnect, or reconnect changes authorization', async () => {
    for (const action of ['drive:cancel-auth', 'drive:disconnect', 'drive:connect']) {
      fixture()
      const pending = deferred<boolean>(), started = deferred<void>()
      // No downloaded objects in this case: the old operation must not complete any receipt.
      includeRemoteFile = false
      publish = async upload => { upload.sessionUrl = 'https://synthetic.invalid/upload/private-session'; started.resolve(); return pending.promise }
      const running = invoke('drive:exchange', { projectSession: context() })
      await started.promise
      expect((await invoke(action)).success).toBe(true)
      pending.resolve(true)
      expect(await running).toEqual({ success: false, error: 'GOOGLE_AUTH_CHANGED' })
      const binding = state.binding(mocks.projectId, replicaId)!
      expect(binding.lastTransferredAt).toBeUndefined(); expect(binding.lastUploadedHash).toBeUndefined()
      expect(binding.uploadSessions).toBeUndefined(); expect(binding.received).toEqual({})
      expect(mocks.engine.receive).not.toHaveBeenCalled(); expect(mocks.engine.enable).not.toHaveBeenCalled()
      expect(JSON.stringify(stored)).not.toContain('private-session')
    }
  })
  it('rechecks the join destination grant after downloading and binds a successful join to the new replica only', async () => {
    const pending = deferred<Uint8Array>(), started = deferred<void>()
    fetchDownload = async () => { started.resolve(); return pending.promise }
    const running = invoke('drive:join', { folderId: 'cloud-folder', targetGrantId: 'selected-grant' })
    await started.promise; mocks.grantValid = false; pending.resolve(bytes)
    expect(await running).toEqual({ success: false, error: 'SYNC_GRANT_INVALID' })
    expect(mocks.transfer).not.toHaveBeenCalled(); expect(mocks.joined.join).not.toHaveBeenCalled()
    fixture()
    const beforeLocal = state.binding(mocks.projectId, replicaId)
    expect(await invoke('drive:join', { folderId: 'cloud-folder', targetGrantId: 'selected-grant' })).toMatchObject({ success: true, projectPath: path.join('C:/synthetic/selected-parent', 'joined-copy'), drive: { bound: true } })
    expect(mocks.grants.revalidate).toHaveBeenCalledWith({ grantId: 'selected-grant', webContentsId: 11, operation: 'sync-project-join' })
    expect(state.binding(mocks.projectId, joinedReplicaId)).toMatchObject({ replicaId: joinedReplicaId, projectId: mocks.projectId, folderId: 'cloud-folder' })
    expect(state.binding(mocks.projectId, replicaId)).toEqual(beforeLocal)
  })
  it('never returns access tokens, and cancellation invalidates an in-flight authorization receipt', async () => {
    expect(await invoke('drive:configure', { clientId: 'public.apps.googleusercontent.com' })).toMatchObject({ success: true, auth: { configured: true } })
    const connected = await invoke('drive:connect')
    expect(connected.success).toBe(true); expect(JSON.stringify(connected)).not.toContain(token)
    const pending = deferred<string>(), started = deferred<void>()
    vi.mocked(auth.accessToken).mockImplementationOnce(async () => { started.resolve(); return pending.promise })
    const running = invoke('drive:connect')
    await started.promise
    const cancelled = await invoke('drive:cancel-auth'); pending.resolve(token)
    expect(await running).toEqual({ success: false, error: 'GOOGLE_AUTH_CHANGED' })
    expect(JSON.stringify(cancelled)).not.toContain(token)
    vi.mocked(auth.configure).mockRejectedValueOnce(new Error(`private provider details ${token}`))
    const failed = await invoke('drive:configure', { clientId: 'public.apps.googleusercontent.com' })
    expect(failed).toEqual({ success: false, error: 'DRIVE_OPERATION_FAILED' })
    expect(JSON.stringify(failed)).not.toContain(token)
  })
  it('passes an explicit desktop client secret only to authorization and never returns it', async () => {
    const secret = 'SYNTHETIC_CONTROLLER_SECRET'
    const result = await invoke('drive:configure', { clientId: 'public.apps.googleusercontent.com', clientSecret: secret })
    expect(result.success).toBe(true)
    expect(auth.configure).toHaveBeenCalledWith('public.apps.googleusercontent.com', secret)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(await invoke('drive:configure', { clientId: 'public.apps.googleusercontent.com', clientSecret: 123 })).toEqual({ success: false, error: 'GOOGLE_CLIENT_SECRET_INVALID' })
  })
})
