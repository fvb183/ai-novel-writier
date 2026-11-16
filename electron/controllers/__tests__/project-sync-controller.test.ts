import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  root: '', projectId: '', lease: 'current', database: {},
  readBytes: vi.fn(), openDialog: vi.fn(), saveDialog: vi.fn(),
  engine: { status: vi.fn(), enable: vi.fn(), exportBundle: vi.fn(), receive: vi.fn(), preview: vi.fn(), apply: vi.fn(), join: vi.fn() },
}))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler) },
  dialog: { showOpenDialog: mocks.openDialog, showSaveDialog: mocks.saveDialog } }))
vi.mock('../../database', () => ({ getCurrentProjectPath: () => mocks.root, getProjectDb: () => mocks.database, createProjectDatabase: vi.fn() }))
vi.mock('../../services/project-access', () => ({ projectAccess: { assertCurrentProjectContext(context: any) {
  if (context?.leaseId !== mocks.lease || context?.projectId !== mocks.projectId || context?.projectPath !== mocks.root) throw new Error('stale lease')
  return { rootPath: mocks.root, projectId: mocks.projectId }
} } }))
vi.mock('../../services/project-sync-service', () => ({ getProjectSyncEngine: () => mocks.engine }))
vi.mock('../../services/project-asset-runtime', () => ({
  projectAssetRuntimeContext: (database: unknown, projectId: string, rootPath: string, revalidate: () => void) => ({ database, projectId, rootPath, revalidate }),
  prepareProjectAuthorAssets: async (context: { revalidate(): void }) => { context.revalidate(); return {} },
  recoverProjectAuthorAssets: async (context: { revalidate(): void }) => { context.revalidate() },
  applyProjectAuthorSync: async (context: { revalidate(): void }, token: string, resolutions: unknown) => { context.revalidate(); return mocks.engine.apply(token, resolutions) },
}))
vi.mock('../project-controller', () => ({ registerRecentProject: vi.fn() }))
vi.mock('../../security/windows-safe-file-system', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../security/windows-safe-file-system')>(), windowsSafeFileSystem: { readBytes: mocks.readBytes },
}))
import { registerProjectSyncController } from '../project-sync-controller'
import { ExternalFileGrantService } from '../../services/external-file-grant-service'
import { syncDigest } from '../../services/project-sync-engine'
import { ProjectAssetBlobStore } from '../../services/project-asset-blob-store'

const roots: string[] = []
let now = 0
let grants: ExternalFileGrantService
const event = (id = 11) => ({ sender: { id, once: vi.fn() } })
const context = () => ({ projectId: mocks.projectId, projectPath: mocks.root, leaseId: 'current' })
const invoke = (channel: string, input: unknown, sender = event()) => mocks.handlers.get(channel)!(sender, input)
const bundle = () => {
  const replicaId = randomUUID(), batch = { protocol: 1 as const, projectId: mocks.projectId, replicaId, sequence: 1,
    previousHash: null, batchId: randomUUID(), changes: [{ kind: 'synthetic', id: 'saved', parents: [], value: 'content', deleted: false }] }
  const body = { format: 'ai-novel-sync' as const, version: 1 as const, projectId: mocks.projectId, senderReplicaId: replicaId, batches: [{ ...batch, hash: syncDigest(batch) }] }
  return { ...body, hash: syncDigest(body) }
}
function sourceGrant(operation: 'sync-package-read' | 'read' = 'sync-package-read') {
  const source = path.join(mocks.root, `${randomUUID()}.ainovelsync`)
  fs.writeFileSync(source, JSON.stringify(bundle()))
  return grants.issueFile({ filePath: source, webContentsId: 11, operations: [operation], ttlMs: 1000 }).grantId
}
beforeEach(() => {
  vi.clearAllMocks(); now = 0; mocks.handlers.clear(); mocks.lease = 'current'; mocks.projectId = randomUUID()
  mocks.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-controller-'))); roots.push(mocks.root)
  grants = new ExternalFileGrantService({ now: () => now })
  mocks.readBytes.mockImplementation(async (capability: any) => fs.readFileSync(path.join(capability.rootPath, capability.relativePath)))
  mocks.engine.status.mockReturnValue({ enabled: true, projectId: mocks.projectId })
  mocks.engine.exportBundle.mockImplementation(bundle)
  mocks.engine.receive.mockReturnValue({ token: 'preview' })
  registerProjectSyncController(grants)
})
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('Sync IPC capabilities and lease boundaries', () => {
  it('requires full captured context before accessing an active engine', async () => {
    expect(await invoke('sync:status', {})).toEqual({ success: false, error: 'SYNC_SESSION_STALE' })
    expect(mocks.engine.status).not.toHaveBeenCalled()
  })
  it('rejects ordinary archive permission, another window and expired grants before reading', async () => {
    const ordinary = sourceGrant('read')
    expect(await invoke('sync:import-preview', { projectSession: context(), sourceGrantId: ordinary })).toEqual({ success: false, error: 'SYNC_GRANT_INVALID' })
    const source = sourceGrant()
    expect(await invoke('sync:import-preview', { projectSession: context(), sourceGrantId: source }, event(12))).toEqual({ success: false, error: 'SYNC_GRANT_INVALID' })
    now = 1001
    expect(await invoke('sync:import-preview', { projectSession: context(), sourceGrantId: source })).toEqual({ success: false, error: 'SYNC_GRANT_INVALID' })
    expect(mocks.readBytes).not.toHaveBeenCalled()
  })
  it('consumes an exact source grant once and passes parsed content to hash-validation engine', async () => {
    const input = { projectSession: context(), sourceGrantId: sourceGrant() }
    expect(await invoke('sync:import-preview', input)).toMatchObject({ success: true, preview: { token: 'preview' } })
    expect(mocks.engine.receive).toHaveBeenCalledTimes(1)
    expect(await invoke('sync:import-preview', input)).toEqual({ success: false, error: 'SYNC_GRANT_INVALID' })
    expect(mocks.engine.receive).toHaveBeenCalledTimes(1)
  })
  it('rechecks the captured lease after asynchronous file reading before receiving any batch', async () => {
    mocks.readBytes.mockImplementationOnce(async () => { mocks.lease = 'replacement'; return Buffer.from(JSON.stringify(bundle())) })
    expect(await invoke('sync:import-preview', { projectSession: context(), sourceGrantId: sourceGrant() })).toEqual({ success: false, error: 'SYNC_SESSION_STALE' })
    expect(mocks.engine.receive).not.toHaveBeenCalled()
  })
  it('refuses directory grants without consuming them as exact sync package grants', async () => {
    const grant = grants.issueDirectory({ directoryPath: mocks.root, webContentsId: 11, operations: ['sync-package-read'], ttlMs: 1000 })
    expect(await invoke('sync:import-preview', { projectSession: context(), sourceGrantId: grant.grantId })).toEqual({ success: false, error: 'SYNC_GRANT_INVALID' })
    expect(grants.activeCount()).toBe(1)
    expect(mocks.readBytes).not.toHaveBeenCalled()
  })
  it('does not publish an export if the lease changes while capturing the bundle', async () => {
    const target = path.join(mocks.root, 'out.ainovelsync')
    const grant = grants.issueNewChild({ filePath: target, webContentsId: 11, operations: ['sync-package-create'], ttlMs: 1000 })
    mocks.engine.exportBundle.mockImplementationOnce(() => { mocks.lease = 'replacement'; return bundle() })
    expect(await invoke('sync:export', { projectSession: context(), targetGrantId: grant.grantId })).toEqual({ success: false, error: 'SYNC_SESSION_STALE' })
    expect(fs.readdirSync(mocks.root)).toEqual([])
  })
  it('publishes once with a real maxUses=1 target grant and keeps it valid until the actual commit', async () => {
    const target = path.join(mocks.root, 'saved.ainovelsync')
    const grant = grants.issueNewChild({ filePath: target, webContentsId: 11, operations: ['sync-package-create'], ttlMs: 1000, maxUses: 1 })
    const input = { projectSession: context(), targetGrantId: grant.grantId }
    expect(await invoke('sync:export', input)).toMatchObject({ success: true, filePath: target })
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toMatchObject({ projectId: mocks.projectId })
    expect(grants.activeCount()).toBe(0)
    expect(await invoke('sync:export', input)).toEqual({ success: false, error: 'SYNC_GRANT_INVALID' })
  })
  it('cancels receipt import on grant revocation during the async read', async () => {
    const grantId = sourceGrant()
    mocks.readBytes.mockImplementationOnce(async () => { grants.revoke(grantId); return Buffer.from(JSON.stringify(bundle())) })
    expect(await invoke('sync:import-preview', { projectSession: context(), sourceGrantId: grantId })).toEqual({ success: false, error: 'SYNC_GRANT_INVALID' })
    expect(mocks.engine.receive).not.toHaveBeenCalled()
  })
  it('uses explicit Android picker purpose and a dedicated join target grant', async () => {
    mocks.openDialog.mockResolvedValueOnce({ canceled: false, filePaths: [mocks.root] })
    const result = await invoke('dialog:select-sync-join-target', 'Replica')
    expect(mocks.openDialog).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'sync-project-location' }))
    expect(grants.resolveExactPath({ grantId: result.grantId, webContentsId: 11, operation: 'sync-project-join' })).toBe(path.join(mocks.root, 'Replica'))
  })
  it('preserves the stable stale-preview error and hides unexpected paths from failures', async () => {
    mocks.engine.apply.mockImplementationOnce(() => { throw new Error('SYNC_PREVIEW_STALE') })
    expect(await invoke('sync:apply', { projectSession: context(), token: 'old', resolutions: [] })).toEqual({ success: false, error: 'SYNC_PREVIEW_STALE' })
    mocks.engine.apply.mockImplementationOnce(() => { throw new Error('private/path/should-not-leak') })
    expect(await invoke('sync:apply', { projectSession: context(), token: 'old', resolutions: [] })).toEqual({ success: false, error: 'SYNC_OPERATION_FAILED' })
  })
  it('previews only the requested current asset conflict head under the captured full lease', async () => {
    const storage = path.join(mocks.root, '.ai-novel'); fs.mkdirSync(storage)
    const store = new ProjectAssetBlobStore(storage), assetId = randomUUID(), revision = `${'a'.repeat(64)}:0`
    const blob = store.put(Buffer.from('作者版本实际内容'), 'application/json')
    mocks.engine.preview.mockReturnValue({ token: 'current-preview', conflicts: [{ kind: 'project-asset', id: assetId,
      variants: [{ revision, deleted: false, value: { version: 1, category: 'files', group: 'prompt', logicalName: 'prompts/draft.zh-cn.json',
        files: [{ path: 'prompts/draft.zh-CN.json', blob }] } }] }] })
    const input = { projectSession: context(), token: 'current-preview', assetId, revision }
    expect(await invoke('sync:asset-preview', input)).toMatchObject({ success: true, preview: { text: '作者版本实际内容' } })
    expect(await invoke('sync:asset-preview', { ...input, token: 'old-preview' })).toEqual({ success: false, error: 'SYNC_PREVIEW_STALE' })
    expect(await invoke('sync:asset-preview', { ...input, revision: 'other-head' })).toEqual({ success: false, error: 'SYNC_ASSET_PREVIEW_INVALID' })
    expect(await invoke('sync:asset-preview', { ...input, filePath: '../secret' })).toEqual({ success: false, error: 'SYNC_ASSET_PREVIEW_INVALID' })
    mocks.lease = 'new-lease'
    expect(await invoke('sync:asset-preview', input)).toEqual({ success: false, error: 'SYNC_SESSION_STALE' })
    expect(mocks.engine.receive).not.toHaveBeenCalled(); expect(mocks.engine.apply).not.toHaveBeenCalled()
  })
})
