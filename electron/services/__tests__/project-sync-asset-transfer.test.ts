import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectSyncEngine, syncDigest } from '../project-sync-engine'
import { projectSyncProjection } from '../project-sync-projection'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { ProjectAssetBlobStore } from '../project-asset-blob-store'
import { captureProjectAssets, projectAssetIdentity, recordCapturedProjectAssets } from '../project-sync-assets'
import { materializeSelectedProjectAssets } from '../project-asset-materializer'
import { attachBundleAssets, hydrateBundleAssets, hydrateProjectAssetReferences, referencedProjectAssetBlobs, stageBundleAssets } from '../project-sync-asset-transfer'
import type { GoogleDriveClient, DriveFile } from '../google-drive-client'
import { GoogleDriveSyncService } from '../google-drive-sync-service'
import { driveBytesSource } from '../google-drive-client'
import { projectAuthorFileBytes } from '../project-asset-author-projection'
import { createCompactHead, makeCompactBundle } from '../compact-project-sync-engine'
import { GoogleDriveStateStore, type DriveState } from '../google-drive-state'
import type { ProjectAuthorAsset } from '../../../src/shared/project-sync-assets'
import type { SyncBundle } from '../../../src/shared/project-sync'
import { createDriveAssetHttpFixture } from './drive-asset-http.fixture'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value: string) => Buffer.from(`SYNTHETIC:${Buffer.from(value).toString('base64')}`),
  decryptString: (value: Buffer) => Buffer.from(value.toString().slice('SYNTHETIC:'.length), 'base64').toString() } }))
const roots: string[] = [], handles: Database.Database[] = [], servers: Array<Awaited<ReturnType<typeof createDriveAssetHttpFixture>>> = []
const check = () => {}
function replica(projectId = randomUUID(), manuscript = false) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'asset-transfer-'))); roots.push(root)
  const storage = path.join(root, '.ai-novel'); fs.mkdirSync(storage)
  const db = new Database(path.join(storage, 'project.db')); handles.push(db); db.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(db); migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.prepare("INSERT INTO project_core(id,project_name) VALUES('main','asset transport synthetic')").run()
  if (manuscript) {
    const contentId = db.prepare('INSERT INTO contents(body) VALUES(?)').run('已保存的原正文').lastInsertRowid
    db.prepare("INSERT INTO drafts(chapter_number,version,source,content_id,word_count) VALUES(1,1,'write',?,8)").run(contentId)
  }
  const store = new ProjectAssetBlobStore(storage), engine = new ProjectSyncEngine(db, projectId, projectSyncProjection)
  let stateValue: DriveState | null = null
  const state = new GoogleDriveStateStore({ read: () => structuredClone(stateValue), write: value => { stateValue = structuredClone(value) } })
  const service = new GoogleDriveSyncService(state)
  return { root, storage, db, store, engine, projectId, state, service }
}
type Replica = ReturnType<typeof replica>
function value(target: Replica, content: string | Uint8Array): Extract<ProjectAuthorAsset, { category: 'files' }> {
  const name = 'prompts/draft.zh-CN.json'
  return { version: 1, category: 'files', group: 'prompt', logicalName: name, files: [{ path: name, blob: target.store.put(typeof content === 'string' ? Buffer.from(content) : content, 'application/json') }] }
}
function checkpoint(target: Replica, bytes: Buffer): Extract<ProjectAuthorAsset, { category: 'files' }> {
  return { version: 1, category: 'files', group: 'author-content', logicalName: 'partial_arch.json', files: [
    { path: 'partial_arch.json', blob: target.store.put(bytes, 'application/json') },
  ] }
}
async function publishOldCheckpoint(target: Replica, server: Awaited<ReturnType<typeof cloud>>, bundle: SyncBundle) {
  const client = server.client()
  for (const blob of referencedProjectAssetBlobs(bundle)) {
    const fileId = await client.allocateId()
    await client.publishObject(server.folderId, target.projectId, 'asset', driveBytesSource(target.store.read(blob)), { fileId, digest: blob.sha256 })
  }
  const bytes = Buffer.from(JSON.stringify(bundle)), fileId = await client.allocateId(), digest = createHash('sha256').update(bytes).digest('hex')
  await client.publish(server.folderId, target.projectId, bytes, { fileId, digest })
  return { file: server.files.get(fileId)!, digest }
}
function saveAsset(target: Replica, asset: ProjectAuthorAsset | null) {
  target.engine.captureMutation(() => recordCapturedProjectAssets(target.db, asset ? [{ id: projectAssetIdentity(target.projectId, asset), value: asset }] : []))
}
const body = (target: Replica) => target.db.prepare('SELECT c.body FROM contents c JOIN drafts d ON d.content_id=c.id WHERE d.chapter_number=1').pluck().get()
const batchCount = (target: Replica) => Number(target.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get())
async function materialize(target: Replica) { await materializeSelectedProjectAssets({ database: target.db, storageRoot: target.storage, revalidate: check, replaceKnowledge: async input => { expect(input.selected).toHaveLength(0) } }) }
function rehash(bundle: SyncBundle) {
  for (const batch of bundle.batches) { const { hash: _hash, ...payload } = batch; batch.hash = syncDigest(payload) }
  const { hash: _hash, ...payload } = bundle; bundle.hash = syncDigest(payload); return bundle
}
async function cloud(projectId: string) { const server = await createDriveAssetHttpFixture(projectId); servers.push(server); return server }
async function bind(target: Replica, server: Awaited<ReturnType<typeof cloud>>) { await target.service.bind(server.client(), target.projectId, target.engine.status().replicaId!, 'synthetic', server.folderId, check) }
async function join(target: Replica, server: Awaited<ReturnType<typeof cloud>>, source: Replica) {
  const downloaded = await source.service.downloadProject(server.client(), server.folderId, check)
  await hydrateBundleAssets(server.client(), downloaded.bundle, server.folderId, target.store, check)
  expect(target.engine.join(downloaded.bundle).applied).toBe(true)
  target.service.rememberJoined(downloaded.binding, target.engine.status().replicaId!)
  await materialize(target)
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  for (const db of handles.splice(0)) db.close()
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('asset-transfer-')) throw new Error('unsafe fixture cleanup')
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

describe('asset hydration during delayed cloud garbage collection', () => {
  it('exports and stages a valid conflicted compact snapshot including the adopted display bytes', () => {
    const left = replica(), right = replica(left.projectId), assetId = randomUUID(), author = randomUUID(), offline = randomUUID()
    const asset = (text: string) => ({ version: 1 as const, category: 'knowledge' as const, documentId: 'source', blob: left.store.put(Buffer.from(text), 'application/json') })
    const displayed = asset('adopted display'), a = asset('parallel value A'), b = asset('parallel value B')
    const packet = makeCompactBundle(left.projectId, author, { protocol: 2, mode: 'snapshot', clock: { [author]: 2, [offline]: 1 },
      records: [{ kind: 'project-asset', id: assetId, heads: [
        createCompactHead('project-asset', assetId, { [author]: 2 }, false, a),
        createCompactHead('project-asset', assetId, { [author]: 1, [offline]: 1 }, false, b),
      ] }], accepted: [{ kind: 'project-asset', id: assetId, heads: [createCompactHead('project-asset', assetId, { [author]: 1 }, false, displayed)] }] })
    const complete = attachBundleAssets(packet, left.store)
    expect(complete.inlineBlobs).toHaveLength(3)
    stageBundleAssets(complete, right.store)
    for (const value of [displayed, a, b]) expect(right.store.read(value.blob)).toEqual(left.store.read(value.blob))
  })
  const bytes = Buffer.from('required live author bytes')
  const blob = { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length, mime: 'text/plain' }
  const file = (id: string, createdTime: string): DriveFile => ({ id, name: id, size: String(bytes.length),
    md5Checksum: createHash('md5').update(bytes).digest('hex'), createdTime, appProperties: { ainwDigest: blob.sha256 } })
  it('prefers the newest immutable object and falls back when that exact ID was concurrently removed', async () => {
    const target = replica(), reads: string[] = []
    const listObjects = vi.fn(async () => [file('old', '2026-01-01T00:00:00Z'), file('new', '2026-01-02T00:00:00Z')])
    const client = { listObjects, downloadObject: async (candidate: DriveFile, _folder: string, _project: string, _kind: string, _expected: unknown, write: (part: Uint8Array) => void) => {
      reads.push(candidate.id)
      if (candidate.id === 'new') { write(bytes.subarray(0, 2)); throw new Error('DRIVE_FILE_NOT_FOUND') }
      write(bytes)
    } } as unknown as GoogleDriveClient
    await hydrateProjectAssetReferences(client, target.projectId, [blob], 'folder', target.store, check)
    expect(reads).toEqual(['new', 'old']); expect(listObjects).toHaveBeenCalledTimes(1)
    expect(target.store.read(blob)).toEqual(bytes)
  })
  it('refreshes the object list once when a fresh writer appeared after the first catalog read', async () => {
    const target = replica(), reads: string[] = []
    const listObjects = vi.fn().mockResolvedValueOnce([file('gone', '2026-01-01T00:00:00Z')]).mockResolvedValue([file('fresh', '2026-01-03T00:00:00Z')])
    const client = { listObjects, downloadObject: async (candidate: DriveFile, _folder: string, _project: string, _kind: string, _expected: unknown, write: (part: Uint8Array) => void) => {
      reads.push(candidate.id); if (candidate.id === 'gone') throw new Error('DRIVE_FILE_NOT_FOUND'); write(bytes)
    } } as unknown as GoogleDriveClient
    await hydrateProjectAssetReferences(client, target.projectId, [blob], 'folder', target.store, check)
    expect(reads).toEqual(['gone', 'fresh']); expect(listObjects).toHaveBeenCalledTimes(2)
    expect(target.store.read(blob)).toEqual(bytes)
  })
})

describe('self-contained local asset exchange files', () => {
  it.each(['world_building_generation_handle', 'synopsis_generation_handle'])('rejects a hash-correct historical checkpoint containing %s before installing inline bytes', handle => {
    const a = replica(), b = replica(a.projectId), raw = Buffer.from(JSON.stringify({ candidate: 'author text', progress: 4, [handle]: { token: 'SYNTHETIC_RUNTIME_AUTHORITY' } }))
    const source = path.join(a.storage, 'partial_arch.json'); fs.writeFileSync(source, raw)
    const asset = checkpoint(a, raw); saveAsset(a, asset); a.engine.enable(); saveAsset(a, null)
    const bundle = attachBundleAssets(a.engine.exportBundle(), a.store)
    expect(bundle.requiredFeatures).toContain('project-assets-v1')
    expect(bundle.inlineBlobs![0].sha256).toBe(createHash('sha256').update(raw).digest('hex'))
    expect(() => stageBundleAssets(bundle, b.store, check)).toThrow('PROJECT_SYNC_ASSET_RUNTIME_AUTHORITY')
    expect(fs.readdirSync(b.store.root)).toEqual([]); expect(batchCount(b)).toBe(0)
    expect(fs.readFileSync(source)).toEqual(raw); expect(a.store.read(asset.files[0].blob)).toEqual(raw)
  })
  it('transfers projected author checkpoint/progress without changing the original runtime checkpoint', async () => {
    const a = replica(), b = replica(a.projectId), raw = Buffer.from(JSON.stringify({ candidate: 'author candidate', scope: ['world'], progress: 3, world_building_generation_handle: { token: 'SYNTHETIC_LOCAL_ONLY' } }))
    const source = path.join(a.storage, 'partial_arch.json'); fs.writeFileSync(source, raw)
    const projected = projectAuthorFileBytes('partial_arch.json', raw), asset = checkpoint(a, projected)
    saveAsset(a, asset); a.engine.enable()
    const bundle = attachBundleAssets(a.engine.exportBundle(), a.store)
    stageBundleAssets(bundle, b.store, check); expect(b.engine.join(bundle).applied).toBe(true); await materialize(b)
    expect(JSON.parse(fs.readFileSync(path.join(b.storage, 'partial_arch.json'), 'utf8'))).toEqual({ candidate: 'author candidate', scope: ['world'], progress: 3 })
    expect(fs.readFileSync(source)).toEqual(raw)
  })
  it('joins actual SQLite/CAS replicas only after complete inline validation and preserves the manuscript', async () => {
    const a = replica(undefined, true), b = replica(a.projectId), asset = value(a, '{"instruction":"baseline"}')
    saveAsset(a, asset); a.engine.enable()
    const bundle = attachBundleAssets(a.engine.exportBundle(), a.store)
    expect(bundle.inlineBlobs).toHaveLength(1); expect(bundle.minimumReaderSchemaVersion).toBe(11)
    expect(() => b.engine.join(a.engine.exportBundle())).toThrow('PROJECT_SYNC_ASSET_MISSING_BYTES')
    expect(batchCount(b)).toBe(0)
    stageBundleAssets(bundle, b.store, check)
    expect(b.engine.join(bundle).applied).toBe(true); await materialize(b)
    expect(b.engine.status().replicaId).not.toBe(a.engine.status().replicaId)
    expect(body(b)).toBe('已保存的原正文')
    expect(fs.readFileSync(path.join(b.storage, asset.logicalName), 'utf8')).toBe('{"instruction":"baseline"}')
  })
  it.each(['missing', 'extra', 'noncanonical', 'wrong-size', 'unknown-key', 'size-conflict'] as const)('rejects %s inline data before installing any bytes or polluting a ledger', mode => {
    const a = replica(), b = replica(a.projectId); saveAsset(a, value(a, 'a')); a.engine.enable()
    const bundle = structuredClone(attachBundleAssets(a.engine.exportBundle(), a.store))
    if (mode === 'missing') delete bundle.inlineBlobs
    if (mode === 'extra') bundle.inlineBlobs!.push({ ...bundle.inlineBlobs![0] })
    if (mode === 'noncanonical') bundle.inlineBlobs![0].base64 = 'YR=='
    if (mode === 'wrong-size') bundle.inlineBlobs![0].byteSize = 2
    if (mode === 'unknown-key') Object.assign(bundle.inlineBlobs![0], { path: '../outside' })
    if (mode === 'size-conflict') {
      const original = bundle.batches[0].changes.find(change => change.kind === 'project-asset')!, extra = structuredClone(original)
      extra.id = randomUUID()
      const asset = extra.value as unknown as Extract<ProjectAuthorAsset, { category: 'files' }>
      asset.logicalName = 'prompts/review.zh-CN.json'; asset.files[0].path = asset.logicalName; asset.files[0].blob.byteSize = 2
      bundle.batches[0].changes.push(extra)
    }
    rehash(bundle)
    expect(() => stageBundleAssets(bundle, b.store, check)).toThrow(/PROJECT_SYNC_ASSET_/)
    expect(batchCount(b)).toBe(0); expect(fs.readdirSync(b.store.root)).toEqual([])
  })
  it('checks the lease again before installing a fully written inline blob', () => {
    const a = replica(), b = replica(a.projectId); saveAsset(a, value(a, 'lease-bound bytes')); a.engine.enable()
    const bundle = attachBundleAssets(a.engine.exportBundle(), a.store)
    let checks = 0
    expect(() => stageBundleAssets(bundle, b.store, () => { if (++checks === 4) throw new Error('SYNC_SESSION_STALE') })).toThrow('SYNC_SESSION_STALE')
    expect(fs.readdirSync(b.store.root)).toEqual([]); expect(batchCount(b)).toBe(0)
  })
  it('keeps old and deleted candidate bytes and enforces the total 64 MiB cap before reading a large blob', () => {
    const a = replica(), old = value(a, 'old'); saveAsset(a, old); a.engine.enable()
    const changed = value(a, 'changed'); saveAsset(a, changed); saveAsset(a, null)
    const bundle = a.engine.exportBundle(), references = referencedProjectAssetBlobs(bundle)
    expect(references.map(blob => blob.sha256).sort()).toEqual([old.files[0].blob.sha256, changed.files[0].blob.sha256].sort())
    expect(attachBundleAssets(bundle, a.store).inlineBlobs).toHaveLength(2)
    const virtual = structuredClone(bundle)
    const baseline = virtual.batches.find(batch => batch.sequence === 1)!
    const first = baseline.changes.find(change => change.kind === 'project-asset' && !change.deleted)!.value as unknown as Extract<ProjectAuthorAsset, { category: 'files' }>
    first.files[0].blob.byteSize = 49 * 1024 ** 2
    // Use one independent baseline to keep its causal hash references coherent.
    virtual.batches = [baseline]; rehash(virtual)
    const read = vi.spyOn(a.store, 'read')
    expect(() => attachBundleAssets(virtual, a.store)).toThrow('SYNC_PACKAGE_TOO_LARGE')
    expect(read).not.toHaveBeenCalled()
  })
})

describe('real loopback REST transfers author assets before domain packages', () => {
  it('rejects a hash-correct remote historical runtime checkpoint before receive or cursor/cache advancement', async () => {
    const a = replica(), b = replica(a.projectId), raw = Buffer.from(JSON.stringify({ authorCandidate: 'kept', synopsis_generation_handle: { token: 'SYNTHETIC_REMOTE_HANDLE' } }))
    const source = path.join(a.storage, 'partial_arch.json'); fs.writeFileSync(source, raw)
    saveAsset(a, checkpoint(a, raw)); a.engine.enable(); saveAsset(a, null)
    const bundle = a.engine.exportBundle(), server = await cloud(a.projectId)
    await publishOldCheckpoint(a, server, bundle)
    b.engine.enable(); await bind(b, server)
    const before = structuredClone(b.state.read()), count = batchCount(b), receive = vi.spyOn(b.engine, 'receive')
    await expect(b.service.exchange(server.client(), b.projectId, b.engine, check, b.store)).rejects.toThrow('PROJECT_SYNC_ASSET_RUNTIME_AUTHORITY')
    expect(receive).not.toHaveBeenCalled(); expect(batchCount(b)).toBe(count); expect(b.state.read()).toEqual(before)
    expect(fs.readFileSync(source)).toEqual(raw)
  })
  it('rechecks a legacy received cache once instead of trusting pathless asset references from the old policy', async () => {
    const a = replica(), b = replica(a.projectId), raw = Buffer.from(JSON.stringify({ progress: 5, world_building_generation_handle: 'SYNTHETIC_LEGACY_HANDLE' }))
    saveAsset(a, checkpoint(a, raw)); a.engine.enable(); saveAsset(a, null)
    const bundle = a.engine.exportBundle(), server = await cloud(a.projectId), published = await publishOldCheckpoint(a, server, bundle)
    b.engine.enable(); await bind(b, server)
    const blobs = referencedProjectAssetBlobs(bundle)
    for (const blob of blobs) b.store.put(a.store.read(blob), blob.mime)
    b.engine.receive(bundle) // Simulate a domain packet accepted by the previous client before this policy existed.
    b.state.update(state => {
      const binding = state.bindings[`${b.projectId}|${b.engine.status().replicaId}`]
      binding.files = [published.file]; binding.received[published.file.id] = published.digest
      binding.assetReferences = blobs; delete binding.assetPolicyVersion
    })
    const before = structuredClone(b.state.read()), count = batchCount(b), receive = vi.spyOn(b.engine, 'receive')
    const downloads = () => server.calls.filter(call => call.path.includes(`/files/${published.file.id}?`) && call.path.includes('alt=media')).length
    const oldDownloads = downloads()
    await expect(b.service.exchange(server.client(), b.projectId, b.engine, check, b.store)).rejects.toThrow('PROJECT_SYNC_ASSET_RUNTIME_AUTHORITY')
    expect(downloads()).toBe(oldDownloads + 1); expect(receive).not.toHaveBeenCalled()
    expect(batchCount(b)).toBe(count); expect(b.state.read()).toEqual(before)
    expect(b.state.binding(b.projectId, b.engine.status().replicaId!)!.assetPolicyVersion).toBeUndefined()
  })
  it('hydrates a new replica, stages a later edit without applying, and restores missing cached CAS bytes', async () => {
    const a = replica(undefined, true), b = replica(a.projectId), original = value(a, '{"instruction":"old"}')
    saveAsset(a, original); a.engine.enable(); const server = await cloud(a.projectId); await bind(a, server)
    await a.service.exchange(server.client(), a.projectId, a.engine, check, a.store)
    expect(server.committed.slice(0, 2)).toEqual(['asset', 'sync'])
    await join(b, server, a)
    expect(body(b)).toBe('已保存的原正文')
    const edited = value(a, '{"instruction":"new"}'); saveAsset(a, edited)
    a.engine.captureMutation(() => a.db.prepare("UPDATE contents SET body='远端保存的新正文' WHERE id=(SELECT content_id FROM drafts WHERE chapter_number=1)").run())
    await a.service.exchange(server.client(), a.projectId, a.engine, check, a.store)
    await b.service.exchange(server.client(), b.projectId, b.engine, check, b.store)
    expect(body(b)).toBe('已保存的原正文'); expect(captureProjectAssets(b.db)[0].value).toEqual(original)
    expect(b.store.has(edited.files[0].blob)).toBe(true)
    expect(b.engine.apply(b.engine.preview().token).applied).toBe(true); await materialize(b)
    expect(body(b)).toBe('远端保存的新正文')
    expect(fs.readFileSync(path.join(b.storage, edited.logicalName), 'utf8')).toBe('{"instruction":"new"}')
    await b.service.exchange(server.client(), b.projectId, b.engine, check, b.store)
    await b.service.exchange(server.client(), b.projectId, b.engine, check, b.store)
    const coreDownloads = server.calls.filter(call => call.path.includes('alt=media') && server.files.get(new URL(`http://synthetic${call.path}`).pathname.split('/').at(-1)!)?.appProperties?.ainwKind === 'sync').length
    fs.unlinkSync(path.join(b.store.root, original.files[0].blob.sha256))
    await b.service.exchange(server.client(), b.projectId, b.engine, check, b.store)
    expect(b.store.has(original.files[0].blob)).toBe(true)
    expect(server.calls.filter(call => call.path.includes('alt=media') && server.files.get(new URL(`http://synthetic${call.path}`).pathname.split('/').at(-1)!)?.appProperties?.ainwKind === 'sync')).toHaveLength(coreDownloads)
    const pathToCorrupt = path.join(b.store.root, original.files[0].blob.sha256), corrupted = Buffer.alloc(original.files[0].blob.byteSize, 42)
    fs.writeFileSync(pathToCorrupt, corrupted)
    const count = batchCount(b), historicalReads = vi.spyOn(b.store, 'source')
    await b.service.exchange(server.client(), b.projectId, b.engine, check, b.store)
    expect(historicalReads).not.toHaveBeenCalled()
    // A dormant, unselected historical object is verified when it is actually
    // read/restored, rather than by rescanning every historical byte per save.
    expect(() => b.store.read(original.files[0].blob)).toThrow('PROJECT_SYNC_ASSET_HASH_MISMATCH')
    expect(fs.readFileSync(pathToCorrupt)).toEqual(corrupted); expect(batchCount(b)).toBe(count)
  }, 30_000)
  it('does not receive or advance discovery when a domain package references a missing cloud blob', async () => {
    const a = replica(), b = replica(a.projectId); saveAsset(a, value(a, 'baseline')); a.engine.enable()
    const server = await cloud(a.projectId); await bind(a, server); await a.service.exchange(server.client(), a.projectId, a.engine, check, a.store); await join(b, server, a)
    const asset = value(a, 'later bytes'); saveAsset(a, asset); await a.service.exchange(server.client(), a.projectId, a.engine, check, a.store)
    const file = [...server.files.values()].find(item => item.appProperties?.ainwDigest === asset.files[0].blob.sha256)!
    server.files.delete(file.id)
    const before = structuredClone(b.state.read()), count = batchCount(b)
    await expect(b.service.exchange(server.client(), b.projectId, b.engine, check, b.store)).rejects.toThrow('PROJECT_SYNC_ASSET_BLOB_MISSING')
    expect(b.state.read()).toEqual(before); expect(batchCount(b)).toBe(count)
    server.files.set(file.id, file)
    await b.service.exchange(server.client(), b.projectId, b.engine, check, b.store)
    expect(b.store.has(asset.files[0].blob)).toBe(true)
  }, 30_000)
  it('persists a protected resumable asset session and never uploads a domain package before the bytes complete', async () => {
    const a = replica(); saveAsset(a, value(a, new Uint8Array(5 * 1024 ** 2 + 1).fill(29))); a.engine.enable()
    const server = await cloud(a.projectId); await bind(a, server); server.interruptNextAssetChunk()
    await expect(a.service.exchange(server.client(), a.projectId, a.engine, check, a.store)).rejects.toThrow('DRIVE_NETWORK_FAILED')
    expect(server.committed).toEqual([])
    const serialized = JSON.stringify(a.state.read())
    expect(serialized).not.toContain('/upload/drive/')
    expect(Object.keys(a.state.binding(a.projectId, a.engine.status().replicaId!)!.uploadSessions ?? {})).toHaveLength(1)
    const resumed = new GoogleDriveSyncService(a.state)
    await resumed.exchange(server.client(), a.projectId, a.engine, check, a.store)
    expect(server.committed).toEqual(['asset', 'sync'])
    expect(server.calls.filter(call => call.method === 'POST' && call.kind === 'asset')).toHaveLength(1)
  }, 30_000)
  it('loses no original input and installs no final blob when a lease expires during a real media GET', async () => {
    const a = replica(), b = replica(a.projectId); saveAsset(a, value(a, 'baseline')); a.engine.enable()
    const server = await cloud(a.projectId); await bind(a, server); await a.service.exchange(server.client(), a.projectId, a.engine, check, a.store); await join(b, server, a)
    const changed = value(a, 'lease boundary payload'); saveAsset(a, changed); await a.service.exchange(server.client(), a.projectId, a.engine, check, a.store)
    let current = true; const checked = () => { if (!current) throw new Error('SYNC_SESSION_STALE') }
    server.beforeAssetRead(() => { current = false })
    const before = structuredClone(b.state.read()), count = batchCount(b), selected = captureProjectAssets(b.db)
    await expect(b.service.exchange(server.client(checked), b.projectId, b.engine, checked, b.store)).rejects.toThrow('SYNC_SESSION_STALE')
    expect(batchCount(b)).toBe(count); expect(b.state.read()).toEqual(before); expect(captureProjectAssets(b.db)).toEqual(selected)
    expect(b.store.has(changed.files[0].blob)).toBe(false)
    expect(fs.readdirSync(b.store.root).some(name => name.startsWith('.incoming-'))).toBe(false)
  }, 30_000)
  it('preserves both feature markers in mixed-version discovery and hydrates real zero-byte Skill files', async () => {
    const a = replica(), b = replica(a.projectId), skill: ProjectAuthorAsset = { version: 1, category: 'files', group: 'skill', logicalName: 'skills/sample', files: [
      { path: 'skills/sample/SKILL.md', blob: a.store.put(Buffer.from('# Synthetic writing instructions'), 'text/markdown') },
      { path: 'skills/sample/notes.txt', blob: a.store.put(Buffer.alloc(0), 'text/plain') },
    ] }
    saveAsset(a, skill); a.engine.enable(); const server = await cloud(a.projectId); await bind(a, server)
    await a.service.exchange(server.client(), a.projectId, a.engine, check, a.store)
    const legacy = replica(a.projectId); legacy.engine.enable()
    const legacyBundle = legacy.engine.exportBundle(); legacyBundle.requiredFeatures = ['narrative-sync-v1']; rehash(legacyBundle)
    const source = Buffer.from(JSON.stringify(legacyBundle)), fileId = await server.client().allocateId()
    await server.client().publish(server.folderId, a.projectId, source, { fileId, digest: createHash('sha256').update(source).digest('hex') })
    const downloaded = await a.service.downloadProject(server.client(), server.folderId, check)
    expect(downloaded.bundle.minimumReaderSchemaVersion).toBe(11)
    expect(downloaded.bundle.requiredFeatures).toEqual(['narrative-sync-v1', 'project-assets-v1'])
    await a.service.hydrateBundleAssets(server.client(), downloaded.bundle, server.folderId, b.store, check)
    expect(b.store.read(skill.files[1].blob)).toEqual(Buffer.alloc(0))
    expect(server.committed.filter(kind => kind === 'asset')).toHaveLength(2)
  }, 30_000)
  it('rejects a real resumable PUT redirect without contacting its sink or replaying a create', async () => {
    const a = replica(); saveAsset(a, value(a, 'redirect boundary')); a.engine.enable()
    const server = await cloud(a.projectId); await bind(a, server); server.redirectNextAssetPut()
    await expect(a.service.exchange(server.client(), a.projectId, a.engine, check, a.store)).rejects.toThrow('DRIVE_REDIRECT_REJECTED')
    expect(server.calls.some(call => call.path === '/sink')).toBe(false)
    expect(server.calls.filter(call => call.method === 'POST' && call.kind === 'asset')).toHaveLength(1)
    expect(server.committed).toEqual([])
  }, 30_000)
})
