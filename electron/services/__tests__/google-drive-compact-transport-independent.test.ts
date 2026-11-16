import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAssetBlob, ProjectAuthorAsset } from '../../../src/shared/project-sync-assets'
import { ProjectAssetBlobStore } from '../project-asset-blob-store'
import type { SyncBundle, SyncRecord } from '../../../src/shared/project-sync'
import { mergeCompactClocks, mergeCompactRecords } from '../../../src/shared/project-sync-compact'
import { canonicalSyncJson, ProjectSyncEngine, validateSyncBundle, type SyncProjection } from '../project-sync-engine'
import { CompactProjectSyncEngine, makeCompactBundle } from '../compact-project-sync-engine'
import { COMPACT_EXCHANGE_DEADLINE_MS, COMPACT_HISTORY_FILE_LIMIT } from '../google-drive-compact-sync'
import { GoogleDriveSyncService } from '../google-drive-sync-service'
import { GoogleDriveStateStore, driveReplicaKey, type DriveState } from '../google-drive-state'
import { DRIVE_APP_TAG, type DriveFile, type DriveUpload, type DriveObjectSource, type GoogleDriveClient } from '../google-drive-client'
import { PROJECT_SYNC_SQL } from '../project-sync-schema'
import { COMPACT_SYNC_SQL } from '../../migrations/m12-compact-sync'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
const handles: Database.Database[] = [], roots: string[] = []
afterEach(() => { handles.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); for (const root of roots.splice(0)) { if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('compact-transport-independent-')) throw Error('unsafe fixture cleanup'); fs.rmSync(root, { recursive: true, force: true }) } })
const folderId = 'synthetic_compact_folder', accountId = 'synthetic_account'
const clone = <T,>(value: T): T => structuredClone(value)
const sha = (bytes: Uint8Array, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')

function actor(projectId = randomUUID(), initial: SyncRecord[] = [{ kind: 'core', id: 'chapter', value: '共同原稿' }, { kind: 'core', id: 'setting', value: '共同设定' }]) {
  const db = new Database(':memory:'); handles.push(db); db.pragma('foreign_keys=ON')
  db.exec('CREATE TABLE drafts(id INTEGER PRIMARY KEY,chapter_number INTEGER,status TEXT,version INTEGER)'); db.exec(PROJECT_SYNC_SQL); db.exec(COMPACT_SYNC_SQL)
  db.exec('CREATE TABLE author_records(kind TEXT,id TEXT,value TEXT,PRIMARY KEY(kind,id))')
  const put = (record: SyncRecord) => db.prepare('INSERT OR REPLACE INTO author_records VALUES(?,?,?)').run(record.kind, record.id, canonicalSyncJson(record.value))
  initial.forEach(put)
  const projection: SyncProjection = { capture: () => (db.prepare('SELECT * FROM author_records ORDER BY kind,id').all() as Array<{kind:string;id:string;value:string}>).map(row => ({ ...row, value: JSON.parse(row.value) })), validate: () => {},
    apply(_db, records) { db.prepare('DELETE FROM author_records').run(); records.forEach(put) } }
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'compact-transport-independent-'))); roots.push(root)
  const store = new ProjectAssetBlobStore(root)
  const engine = new CompactProjectSyncEngine(db, projectId, projection)
  let savedState: DriveState | null = null
  const state = new GoogleDriveStateStore({ read: () => clone(savedState), write: value => { savedState = clone(value) } })
  const bind = () => {
    const replicaId = engine.status().replicaId!, key = driveReplicaKey(projectId, replicaId)
    state.update(value => { value.bindings[key] = { projectId, replicaId, folderId, accountId, files: [], received: {}, uploads: {} } })
    return key
  }
  return { db, projectId, engine, state, bind, projection, store, asset(text: string) { const blob = store.put(Buffer.from(text), 'application/json'); const value: ProjectAuthorAsset = { version: 1, category: 'knowledge', documentId: 'independent_knowledge', blob }; engine.captureMutation(() => put({ kind: 'project-asset', id: 'independent_knowledge', value: value as unknown as SyncRecord['value'] })); return blob }, records: () => projection.capture(db), edit(id: string, value: string) { engine.captureMutation(() => put({ kind: 'core', id, value })) } }
}
type Actor = ReturnType<typeof actor>
class MemoryCloud {
  files = new Map<string, { file: DriveFile; bundle: SyncBundle }>()
  deleted: string[] = []
  published: SyncBundle[] = []
  verifiedSnapshots = new Set<string>()
  afterDiscover?: () => void
  failSnapshotRead = false
  beforeDelete?: (id: string) => void
  assets = new Map<string, { file: DriveFile; bytes: Uint8Array }>()
  assetPublications: string[] = []
  deletedAssets: string[] = []
  afterAssetList?: () => void
  beforeDomainPublication?: () => void
  private counter = 0
  constructor(readonly projectId: string) {}
  async accountId() { return accountId }
  async checkFolder() { return { id: folderId, name: '合成作品', mimeType: 'application/vnd.google-apps.folder', appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'project', ainwProject: this.projectId } } }
  async listObjects() { const result = [...this.assets.values()].map(item => clone(item.file)); this.afterAssetList?.(); return result }
  addAsset(id: string, blob: ProjectAssetBlob, bytes: Uint8Array) {
    const file: DriveFile = { id, name: id, parents: [folderId], size: String(bytes.byteLength), md5Checksum: sha(bytes, 'md5'), createdTime: new Date(Date.now()).toISOString(),
      appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'asset', ainwProject: this.projectId, ainwDigest: blob.sha256 } }
    this.assets.set(id, { file, bytes: bytes.slice() }); return file
  }
  async publishObject(_folder: string, _project: string, kind: string, source: DriveObjectSource, upload: DriveUpload) {
    expect(kind).toBe('asset')
    const buffer = new Uint8Array(source.byteSize)
    for (let offset = 0; offset < source.byteSize; offset += 65536) buffer.set(await source.read(offset, Math.min(65536, source.byteSize - offset)), offset)
    expect(sha(buffer)).toBe(source.sha256)
    this.addAsset(upload.fileId, { sha256: source.sha256, byteSize: source.byteSize, mime: 'text/plain' }, buffer)
    this.assetPublications.push(upload.fileId); return true
  }
  async downloadObject(file: DriveFile, _folder: string, _project: string, _kind: string, expected: ProjectAssetBlob, write: (bytes: Uint8Array) => void) {
    const item = this.assets.get(file.id); if (!item) throw Error('DRIVE_FILE_NOT_FOUND')
    expect(sha(item.bytes)).toBe(expected.sha256); await write(item.bytes)
  }
  async deleteAssetFile(_folder: string, _project: string, file: DriveFile) { this.assets.delete(file.id); this.deletedAssets.push(file.id) }

  async allocateId() { return 'compact_file_' + String(++this.counter).padStart(4, '0') }
  async discover(_folder: string, _project: string) { const files = [...this.files.values()].map(item => clone(item.file)); this.afterDiscover?.(); return { files, cursor: 'cursor_' + this.counter } }
  async download(file: DriveFile) {
    const item = this.files.get(file.id); if (!item) throw Error('DRIVE_FILE_NOT_FOUND')
    if (item.bundle.compact?.mode === 'snapshot') {
      if (this.failSnapshotRead) throw Error('DRIVE_NETWORK_FAILED')
      this.verifiedSnapshots.add(file.id)
    }
    return Buffer.from(JSON.stringify(item.bundle))
  }
  async deleteSyncFile(_folder: string, _project: string, file: DriveFile) { this.beforeDelete?.(file.id); this.files.delete(file.id); this.deleted.push(file.id) }
  async publish(_folder: string, _project: string, bytes: Uint8Array, upload: DriveUpload) {
    const bundle = validateSyncBundle(JSON.parse(new TextDecoder().decode(bytes)))
    this.beforeDomainPublication?.()
    const digest = sha(bytes), existing = this.files.get(upload.fileId)
    expect(digest).toBe(upload.digest)
    if (existing) { expect(existing.file.appProperties!.ainwDigest).toBe(digest); return false }
    const id = upload.fileId
    const file: DriveFile = { id, name: digest + '.ainovelsync', parents: [folderId], mimeType: 'application/json', size: String(bytes.byteLength), md5Checksum: sha(bytes, 'md5'),
      appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'sync', ainwProject: bundle.projectId, ainwDigest: digest } }
    this.files.set(id, { file: clone(file), bundle: clone(bundle) }); this.published.push(clone(bundle)); return true
  }
  client() { return this as unknown as GoogleDriveClient }
  mergedBundle(projectId: string) {
    const bundles = [...this.files.values()].map(item => item.bundle), first = bundles[0]
    return makeCompactBundle(projectId, first.senderReplicaId, { protocol: 2, mode: 'snapshot', clock: mergeCompactClocks(...bundles.map(bundle => bundle.compact!.clock)), records: mergeCompactRecords(...bundles.map(bundle => bundle.compact!.records)) })
  }
}
async function exchange(target: Actor, cloud: MemoryCloud) {
  const key = driveReplicaKey(target.projectId, target.engine.status().replicaId!), binding = target.state.read().bindings[key]
  expect(binding).toBeDefined()
  return new GoogleDriveSyncService(target.state).exchange(cloud.client(), target.projectId, target.engine, () => {}, target.store)
}
async function source() {
  const a = actor(), cloud = new MemoryCloud(a.projectId); a.engine.enable(); a.bind(); await exchange(a, cloud); return { a, cloud }
}
function peer(a: Actor) { const b = actor(a.projectId, []); expect(b.engine.join(a.engine.exportBundle()).applied).toBe(true); b.bind(); return b }

describe('independent real compact transport review', () => {
  it('does not reupload a five-MiB baseline snapshot after saving one small record', async () => {
    const a = actor(undefined, [
      { kind: 'core', id: 'chapter', value: '短正文初稿' },
      { kind: 'core', id: 'setting', value: 'x'.repeat(5 * 1024 * 1024) },
    ]), cloud = new MemoryCloud(a.projectId)
    a.engine.enable(); a.bind()
    expect((await exchange(a, cloud)).success).toBe(true)
    const snapshots = cloud.published.filter(bundle => bundle.compact!.mode === 'snapshot').length
    expect(snapshots).toBe(1)
    expect(Buffer.byteLength(JSON.stringify(cloud.published[0]))).toBeGreaterThan(5 * 1024 * 1024)
    const before = cloud.published.length
    a.edit('chapter', '只保存这一小段新正文')
    expect((await exchange(a, cloud)).success).toBe(true)
    const outgoing = cloud.published.slice(before)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0].compact!.mode).toBe('delta')
    expect(outgoing[0].compact!.records.map(record => record.id)).toEqual(['chapter'])
    expect(outgoing[0].compact!.records[0].heads[0].value).toBe('只保存这一小段新正文')
    expect(Buffer.byteLength(JSON.stringify(outgoing[0]))).toBeLessThan(16 * 1024)
    expect(cloud.published.filter(bundle => bundle.compact!.mode === 'snapshot')).toHaveLength(snapshots)
  }, 20_000)

  it('publishes a fresh asset ID before referencing a revived hash while another collector removes the old ID', async () => {
    const { a, cloud } = await source(), text = '旧离线设备重新采用的原文', blob = a.asset(text)
    const old = cloud.addAsset('old_asset_reserved', blob, Buffer.from(text)), key = driveReplicaKey(a.projectId, a.engine.status().replicaId!)
    a.state.update(value => { value.bindings[key].uploads['asset:' + blob.sha256] = old.id })
    cloud.beforeDomainPublication = () => { cloud.assets.delete(old.id); cloud.deletedAssets.push(old.id); cloud.beforeDomainPublication = undefined }
    expect((await exchange(a, cloud)).success).toBe(true)
    expect(cloud.assetPublications).toHaveLength(1)
    const freshId = cloud.assetPublications[0]
    expect(freshId).not.toBe(old.id); expect(cloud.assets.has(freshId)).toBe(true)
    const downloaded = await new GoogleDriveSyncService(a.state).downloadProject(cloud.client(), folderId, () => {})
    const fresh = actor(a.projectId, [])
    await new GoogleDriveSyncService(fresh.state).hydrateBundleAssets(cloud.client(), downloaded.bundle, folderId, fresh.store, () => {})
    expect(fresh.store.read(blob).toString()).toBe(text)
    expect(fresh.engine.join(downloaded.bundle).applied).toBe(true)
  })

  it('rejects a suspended asset publication after an awaited cloud asset listing', async () => {
    const { a, cloud } = await source(); a.asset('尚未发布的新原文')
    const published = cloud.published.length
    let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now)
    cloud.afterAssetList = () => { now += COMPACT_EXCHANGE_DEADLINE_MS + 1 }
    await expect(exchange(a, cloud)).rejects.toThrow('DRIVE_SYNC_TIMEOUT')
    expect(cloud.assetPublications).toEqual([]); expect(cloud.published).toHaveLength(published)
  })

  it('migrates old cloud packages into a verified compact snapshot and deletes their obsolete prose', async () => {
    const a = actor(), cloud = new MemoryCloud(a.projectId), legacy = new ProjectSyncEngine(a.db, a.projectId, a.projection)
    legacy.enable()
    for (let index = 0; index < 3; index++) {
      legacy.captureMutation(() => a.db.prepare("UPDATE author_records SET value=? WHERE kind='core' AND id='chapter'").run(canonicalSyncJson('旧协议改稿_' + index)))
      const bundle = legacy.exportBundle(), bytes = Buffer.from(JSON.stringify(bundle))
      await cloud.publish(folderId, a.projectId, bytes, { fileId: await cloud.allocateId(), digest: sha(bytes) })
    }
    const oldIds = [...cloud.files.keys()]
    cloud.beforeDelete = id => { if (oldIds.includes(id)) expect([...cloud.verifiedSnapshots].some(verified => cloud.files.has(verified))).toBe(true) }
    a.engine.enable(); a.bind()
    expect((await exchange(a, cloud)).success).toBe(true)
    expect(oldIds.every(id => !cloud.files.has(id))).toBe(true)
    expect([...cloud.files.values()].every(item => item.bundle.compact?.mode === 'snapshot')).toBe(true)
    const retained = JSON.stringify([...cloud.files.values()].map(item => item.bundle))
    expect(retained).toContain('旧协议改稿_2'); expect(retained).not.toContain('旧协议改稿_0'); expect(retained).not.toContain('旧协议改稿_1')
  })

  it('publishes only a changed record and automatically removes its superseded cloud objects', async () => {
    const { a, cloud } = await source()
    for (let index = 0; index < 30; index++) { a.edit('chapter', '改稿_' + index); await exchange(a, cloud) }
    const changes = cloud.published.slice(1).filter(bundle => bundle.compact!.mode === 'delta')
    expect(changes.every(bundle => bundle.compact!.records.length === 1)).toBe(true)
    expect(cloud.files.size).toBeLessThanOrEqual(COMPACT_HISTORY_FILE_LIMIT)
    const cloudText = JSON.stringify([...cloud.files.values()].map(item => item.bundle))
    expect(cloudText).toContain('改稿_29'); expect(cloudText).not.toContain('改稿_1"'); expect(cloud.deleted.length).toBeGreaterThan(0)
    const joined = actor(a.projectId, []), downloaded = await new GoogleDriveSyncService(a.state).downloadProject(cloud.client(), folderId, () => {})
    expect(joined.engine.join(downloaded.bundle).applied).toBe(true)
    expect(joined.records()).toEqual(a.records())
  })

  it('preserves both offline manuscripts across cloud cleanup and fresh-device joining', async () => {
    const { a, cloud } = await source(), b = peer(a)
    a.edit('chapter', '电脑独立新稿'); b.edit('chapter', '手机离线新稿')
    await exchange(a, cloud); await exchange(b, cloud); await exchange(a, cloud)
    const joined = actor(a.projectId, [])
    const downloaded = await new GoogleDriveSyncService(a.state).downloadProject(cloud.client(), folderId, () => {})
    const heads = downloaded.bundle.compact!.records.find(record => record.id === 'chapter')!.heads
    expect(heads.map(head => head.value).sort()).toEqual(['电脑独立新稿', '手机离线新稿'].sort())
    expect(joined.engine.join(downloaded.bundle).applied).toBe(true)
    expect(joined.engine.preview().conflicts[0].variants.map(variant => variant.value).sort()).toEqual(['电脑独立新稿', '手机离线新稿'].sort())
    expect(a.records().find(record => record.id === 'chapter')!.value).toBe('电脑独立新稿')
    expect(b.records().find(record => record.id === 'chapter')!.value).toBe('手机离线新稿')
  })

  it('converges two simultaneously published unrelated edits without a last-writer overwrite', async () => {
    const { a, cloud } = await source(), b = peer(a)
    a.edit('chapter', '电脑改正文'); b.edit('setting', '手机改设定')
    await Promise.all([exchange(a, cloud), exchange(b, cloud)])
    const joined = actor(a.projectId, [])
    const downloaded = await new GoogleDriveSyncService(a.state).downloadProject(cloud.client(), folderId, () => {})
    expect(joined.engine.join(downloaded.bundle).applied).toBe(true)
    expect(joined.records()).toEqual([{ kind: 'core', id: 'chapter', value: '电脑改正文' }, { kind: 'core', id: 'setting', value: '手机改设定' }])
  })

  it('never deletes source objects when the replacement snapshot cannot be read back', async () => {
    const { a, cloud } = await source()
    for (let index = 0; index < COMPACT_HISTORY_FILE_LIMIT - 2; index++) { a.edit('new_record_' + index, '独立资料_' + index); await exchange(a, cloud) }
    const sources = [...cloud.files.keys()]
    cloud.failSnapshotRead = true
    a.edit('threshold_record', '达到压缩阈值的新资料')
    const result = await exchange(a, cloud)
    expect(result.success).toBe(true)
    expect(sources.every(id => cloud.files.has(id))).toBe(true)
    expect(a.state.read().bindings[driveReplicaKey(a.projectId, a.engine.status().replicaId!)].historyCleanupError).toBe('DRIVE_NETWORK_FAILED')
    expect(cloud.deleted).toEqual([])
  })

  it('checks wall-clock expiry after an awaited discovery before publishing or deleting', async () => {
    const { a, cloud } = await source(); a.edit('chapter', '挂起期间待传的新稿')
    const published = cloud.published.length, deleted = cloud.deleted.length
    let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now)
    cloud.afterDiscover = () => { now += COMPACT_EXCHANGE_DEADLINE_MS + 1 }
    await expect(exchange(a, cloud)).rejects.toThrow('DRIVE_SYNC_TIMEOUT')
    expect(cloud.published).toHaveLength(published); expect(cloud.deleted).toHaveLength(deleted)
    expect(a.records().find(record => record.id === 'chapter')!.value).toBe('挂起期间待传的新稿')
  })
})
