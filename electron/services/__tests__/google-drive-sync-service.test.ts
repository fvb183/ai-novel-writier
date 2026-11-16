import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { DraftRepository } from '../../repositories/draft-repository'
import { getProjectSyncEngine, wrapProjectDatabase } from '../project-sync-service'
import { DRIVE_APP_TAG, type DriveFile, type DriveUpload, type GoogleDriveClient } from '../google-drive-client'
import { GoogleDriveSyncService } from '../google-drive-sync-service'
import { GoogleDriveStateStore, type DriveState } from '../google-drive-state'
import type { SyncBundle, SyncResolution } from '../../../src/shared/project-sync'
import { COMPACT_HISTORY_FILE_LIMIT } from '../google-drive-compact-sync'

const active = vi.hoisted(() => ({ database: null as unknown }))
const protectedStorage = vi.hoisted(() => ({ available: false }))
vi.mock('../../database', () => ({ getProjectDb: () => active.database }))
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => protectedStorage.available,
  getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (value: string) => Buffer.from(`SYNTHETIC_DEVICE_ENVELOPE:${Buffer.from(value).toString('base64')}`),
  decryptString: (value: Buffer) => Buffer.from(value.toString().replace(/^SYNTHETIC_DEVICE_ENVELOPE:/, ''), 'base64').toString() } }))

const handles: Database.Database[] = []
afterEach(() => { active.database = null; protectedStorage.available = false; handles.splice(0).forEach(database => database.close()); vi.restoreAllMocks() })
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const clone = <T>(value: T): T => structuredClone(value)
const validLease = () => {}

function replica(projectId = randomUUID()) {
  const raw = new Database(':memory:'); handles.push(raw)
  raw.pragma('foreign_keys=ON'); initializeLegacyBaselineSchema(raw)
  migrateSchema(new SqliteSchemaAdapter(raw), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  raw.prepare("INSERT INTO project_core(id,project_name) VALUES('main','合成云端同步验收')").run()
  const db = wrapProjectDatabase(raw, projectId), engine = getProjectSyncEngine(db, projectId)
  return { projectId, raw, db, engine }
}
type Replica = ReturnType<typeof replica>
function addDraft(target: Replica, chapterNumber: number, content: string) {
  return DraftRepository.create({ chapterNumber, source: 'write', content, wordCount: content.length }, target.db)
}
function editDraft(target: Replica, content: string) {
  active.database = target.db
  const id = target.raw.prepare('SELECT id FROM drafts WHERE chapter_number=1').pluck().get() as number
  DraftRepository.updateContent(id, content, content.length)
}
const body = (target: Replica) => target.raw.prepare('SELECT c.body FROM contents c JOIN drafts d ON c.id=d.content_id WHERE d.chapter_number=1').pluck().get() as string
const countBatches = (target: Replica) => target.raw.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()
function memoryState() {
  let value: DriveState | null = null, writes = 0
  const state = new GoogleDriveStateStore({ read: () => clone(value), write: next => { value = clone(next); writes++ } })
  return { state, writes: () => writes, document: () => state.read() }
}

/** Real sync transactions are used below; this substitute only stores immutable Drive objects. */
class MemoryDrive {
  account = 'synthetic-account'
  files = new Map<string, { file: DriveFile; bytes: Uint8Array }>()
  folders = new Map<string, DriveFile>()
  downloadGate?: () => Promise<void>
  failNextPublication = false
  publishIds: string[] = []
  discoveryCursors: (string | undefined)[] = []
  deletedIds: string[] = []
  beforeDelete?: () => void
  private nextId = 0
  private changes = 0
  client() { return this as unknown as GoogleDriveClient }
  async accountId() { return this.account }
  async listObjects() { return [] }
  async projects() { return [...this.folders.values()].map(file => ({ folderId: file.id, projectId: file.appProperties!.ainwProject, name: file.name })) }
  async allocateId() { return `synthetic_file_${++this.nextId}` }
  async checkFolder(folderId: string, projectId?: string) {
    const file = this.folders.get(folderId)
    if (!file) throw new Error('DRIVE_FILE_NOT_FOUND')
    if (projectId && file.appProperties!.ainwProject !== projectId) throw new Error('DRIVE_PROJECT_MISMATCH')
    return clone(file)
  }
  async createProject(projectId: string, name: string, reservedId: string, autoSync?: boolean) {
    this.folders.set(reservedId, { id: reservedId, name, mimeType: 'application/vnd.google-apps.folder', appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'project', ainwProject: projectId, ...(autoSync === false ? { ainwAutoSync: '0' } : {}) } })
    return reservedId
  }
  async setProjectAutoSync(folderId: string, projectId: string, enabled: boolean) {
    await this.checkFolder(folderId, projectId)
    this.folders.get(folderId)!.appProperties!.ainwAutoSync = enabled ? '1' : '0'
  }
  put(folderId: string, projectId: string, id: string, bytes: Uint8Array) {
    this.files.set(id, { bytes: bytes.slice(), file: { id, name: `${sha(bytes)}.ainovelsync`, parents: [folderId], mimeType: 'application/json', size: String(bytes.byteLength), md5Checksum: md5(bytes),
      appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'sync', ainwProject: projectId, ainwDigest: sha(bytes) } } }); this.changes++
  }
  async discover(folderId: string, projectId: string, _cache: DriveFile[], cursor?: string) {
    await this.checkFolder(folderId, projectId); this.discoveryCursors.push(cursor)
    return { cursor: `synthetic_cursor_${this.changes}`, files: [...this.files.values()].filter(({ file }) => file.parents!.includes(folderId)).map(({ file }) => clone(file)) }
  }
  async download(file: DriveFile, folderId: string, projectId: string) {
    await this.checkFolder(folderId, projectId)
    await this.downloadGate?.()
    const stored = this.files.get(file.id)
    if (!stored) throw new Error('DRIVE_FILE_NOT_FOUND')
    if (sha(stored.bytes) !== file.appProperties!.ainwDigest) throw new Error('DRIVE_HASH_MISMATCH')
    return stored.bytes.slice()
  }
  async publish(folderId: string, projectId: string, bytes: Uint8Array, upload: DriveUpload) {
    await this.checkFolder(folderId, projectId)
    this.publishIds.push(upload.fileId)
    const stored = this.files.get(upload.fileId)
    if (stored) {
      if (sha(stored.bytes) !== upload.digest) throw new Error('DRIVE_OBJECT_MISMATCH')
      return false
    }
    expect(sha(bytes)).toBe(upload.digest)
    this.put(folderId, projectId, upload.fileId, bytes)
    if (this.failNextPublication) { this.failNextPublication = false; throw new Error('DRIVE_UPLOAD_UNCONFIRMED') }
    return true
  }
  async deleteSyncFile(folderId: string, projectId: string, expected: DriveFile) {
    await this.checkFolder(folderId, projectId)
    this.beforeDelete?.()
    const stored = this.files.get(expected.id)
    if (stored && sha(stored.bytes) !== expected.appProperties!.ainwDigest) throw new Error('DRIVE_IMMUTABLE_OBJECT_CHANGED')
    this.files.delete(expected.id); this.deletedIds.push(expected.id); this.changes++
  }
}

async function source() {
  const a = replica(); addDraft(a, 1, '原始正文必须保留'); a.engine.enable()
  const memory = memoryState(), drive = new MemoryDrive(), service = new GoogleDriveSyncService(memory.state)
  const binding = await service.bind(drive.client(), a.projectId, a.engine.status().replicaId!, '合成小说', undefined, validLease)
  await service.exchange(drive.client(), a.projectId, a.engine, validLease)
  return { a, memory, drive, service, folderId: binding.folderId }
}
async function join(fixture: Awaited<ReturnType<typeof source>>) {
  const received = await fixture.service.downloadProject(fixture.drive.client(), fixture.folderId, validLease)
  const b = replica(fixture.a.projectId)
  expect(b.engine.join(received.bundle).applied).toBe(true)
  fixture.service.rememberJoined(received.binding, b.engine.status().replicaId!)
  return b
}

describe('Google Drive exchange with real SQLite project replicas', () => {
  it('uploads only changed records, checkpoints current values, deletes old objects and joins after collection', async () => {
    const fixture = await source(), { a, drive, service, memory } = fixture
    const publications: SyncBundle[] = []
    const publish = drive.publish.bind(drive)
    vi.spyOn(drive, 'publish').mockImplementation(async (folder, project, bytes, upload) => {
      publications.push(JSON.parse(new TextDecoder().decode(bytes)))
      return publish(folder, project, bytes, upload)
    })
    for (let index = 0; index < COMPACT_HISTORY_FILE_LIMIT + 3; index++) {
      editDraft(a, `保存后的正文 ${index}`)
      await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    }
    expect(publications).toHaveLength(COMPACT_HISTORY_FILE_LIMIT + 3)
    expect(publications.every(bundle => bundle.compact?.mode === 'delta' && bundle.compact.records.length === 1)).toBe(true)
    for (let index = 0; index < COMPACT_HISTORY_FILE_LIMIT; index++) {
      addDraft(a, index + 2, `压缩前新增章节 ${index}`)
      await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    }
    const checkpoints = publications.filter(bundle => bundle.compact?.mode === 'snapshot')
    expect(checkpoints.length).toBeGreaterThan(0)
    expect(JSON.stringify(checkpoints.at(-1)!.compact!.records)).toContain(`保存后的正文 ${COMPACT_HISTORY_FILE_LIMIT + 2}`)
    expect(JSON.stringify(checkpoints.at(-1)!.compact!.records)).not.toContain('保存后的正文 0"')
    expect(drive.deletedIds.length).toBeGreaterThanOrEqual(COMPACT_HISTORY_FILE_LIMIT)
    expect(drive.files.size).toBeLessThanOrEqual(COMPACT_HISTORY_FILE_LIMIT)
    const binding = memory.state.binding(a.projectId, a.engine.status().replicaId!)!
    expect(Object.keys(binding.received).sort()).toEqual([...drive.files.keys()].sort())
    expect(Object.keys(binding.cloudCompact!).sort()).toEqual([...drive.files.keys()].sort())
    const restarted = new GoogleDriveSyncService(memory.state)
    const before = drive.publishIds.length
    expect((await restarted.exchange(drive.client(), a.projectId, a.engine, validLease)).uploaded).toBe(false)
    expect(drive.publishIds).toHaveLength(before)
    const joined = await join(fixture)
    expect(body(joined)).toBe(body(a))
  })

  it('retains long-offline edits and both conflict variants after automatic history collection', async () => {
    const fixture = await source(), { a, drive, service } = fixture, offline = await join(fixture)
    editDraft(offline, '长时间离线的手机改稿')
    for (let index = 0; index < COMPACT_HISTORY_FILE_LIMIT; index++) {
      editDraft(a, `电脑继续保存 ${index}`)
      await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    }
    expect(drive.deletedIds.length).toBeGreaterThan(0)
    const result = await service.exchange(drive.client(), a.projectId, offline.engine, validLease)
    expect(result.preview.missingBatchHashes).toEqual([])
    expect(result.preview.conflicts).toHaveLength(1)
    expect(JSON.stringify(result.preview.conflicts)).toContain('长时间离线的手机改稿')
    expect(JSON.stringify(result.preview.conflicts)).toContain(`电脑继续保存 ${COMPACT_HISTORY_FILE_LIMIT - 1}`)
    expect(body(offline)).toBe('长时间离线的手机改稿')
  })

  it('does not delete any source when a replacement checkpoint fails and retries without reuploading deltas', async () => {
    const fixture = await source(), { a, drive, service, memory } = fixture
    for (let index = 0; index < COMPACT_HISTORY_FILE_LIMIT - 2; index++) {
      addDraft(a, index + 2, `检查点前保存 ${index}`)
      await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    }
    const publish = drive.publish.bind(drive)
    let checkpointFailure: string | undefined = 'DRIVE_NETWORK_FAILED'
    vi.spyOn(drive, 'publish').mockImplementation(async (folder, project, bytes, upload) => {
      if (checkpointFailure && JSON.parse(new TextDecoder().decode(bytes)).compact?.mode === 'snapshot') throw new Error(checkpointFailure)
      return publish(folder, project, bytes, upload)
    })
    editDraft(a, '触发检查点的保存')
    addDraft(a, COMPACT_HISTORY_FILE_LIMIT, '触发检查点的新章节')
    const interrupted = await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(interrupted.success).toBe(true)
    expect(interrupted.drive.historyCleanupError).toBe('DRIVE_NETWORK_FAILED')
    expect(drive.deletedIds).toEqual([])
    const files = drive.files.size
    checkpointFailure = 'SYNC_PACKAGE_TOO_LARGE'
    const limit = await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(limit.success).toBe(true); expect(limit.uploaded).toBe(false)
    expect(limit.drive.historyCleanupError).toBe('SYNC_PACKAGE_TOO_LARGE')
    expect(drive.deletedIds).toEqual([])
    checkpointFailure = undefined
    await new GoogleDriveSyncService(memory.state).exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(drive.files.size).toBe(1)
    expect(drive.deletedIds).toHaveLength(files)
    expect(service.status(a.projectId, a.engine.status().replicaId!).historyCleanupError).toBeUndefined()
    expect(body(await join(fixture))).toBe('触发检查点的保存')
  })

  it('forgets consumed upload IDs removed by a peer collector while retaining unfinished upload reservations', async () => {
    const fixture = await source(), { a, drive, service, memory, folderId } = fixture, other = await join(fixture)
    editDraft(other, '手机已经确认上传的正文')
    await service.exchange(drive.client(), a.projectId, other.engine, validLease)
    const before = memory.state.binding(a.projectId, other.engine.status().replicaId!)!
    const ownId = drive.publishIds.at(-1)!, ownHash = Object.entries(before.uploads).find(([, id]) => id === ownId)![0]
    memory.state.update(state => {
      const binding = state.bindings[`${a.projectId}|${other.engine.status().replicaId}`]
      binding.uploads.unfinished = 'never_confirmed'; binding.uploadSessions = { unfinished: 'device_sealed_pending' }
    })
    const downloaded = await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    a.engine.apply(downloaded.preview.token)
    drive.put(folderId, a.projectId, 'collector_checkpoint', new TextEncoder().encode(JSON.stringify(a.engine.exportBundle())))
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(drive.files.has(ownId)).toBe(false)
    await service.exchange(drive.client(), a.projectId, other.engine, validLease)
    const after = memory.state.binding(a.projectId, other.engine.status().replicaId!)!
    expect(after.uploads[ownHash]).toBeUndefined()
    expect(after.uploads.unfinished).toBe('never_confirmed')
    expect(after.uploadSessions!.unfinished).toBe('device_sealed_pending')
    expect(after.received[ownId]).toBeUndefined(); expect(after.cloudBatches![ownId]).toBeUndefined()
  })

  it('refreshes discovery when a peer collects a source between catalog and download during exchange or join', async () => {
    const fixture = await source(), { a, drive, service, folderId } = fixture, other = await join(fixture)
    editDraft(other, '并发清理后仍能下载的正文')
    await service.exchange(drive.client(), a.projectId, other.engine, validLease)
    const original = drive.download.bind(drive)
    let replaced = false, replacements = 0
    vi.spyOn(drive, 'download').mockImplementation(async (file, folder, project) => {
      if (!replaced) {
        replaced = true
        drive.put(folderId, a.projectId, `replacement_checkpoint_${++replacements}`, new TextEncoder().encode(JSON.stringify(other.engine.exportBundle())))
        drive.files.delete(file.id)
      }
      return original(file, folder, project)
    })
    const result = await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(result.preview.missingBatchHashes).toEqual([])
    expect(a.engine.apply(result.preview.token).applied).toBe(true)
    expect(body(a)).toBe('并发清理后仍能下载的正文')
    replaced = false
    expect(body(await join(fixture))).toBe(body(a))
    expect(drive.discoveryCursors.filter(cursor => cursor === undefined).length).toBeGreaterThanOrEqual(3)
  })

  it('includes unresolved received conflict batches in replacement checkpoints without applying or discarding either value', async () => {
    const fixture = await source(), { a, drive, service, folderId } = fixture, other = await join(fixture)
    editDraft(a, '检查点中的电脑冲突版本'); editDraft(other, '检查点中的手机冲突版本')
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    await service.exchange(drive.client(), a.projectId, other.engine, validLease)
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(a.engine.preview().conflicts).toHaveLength(1)
    for (let index = 0; index < COMPACT_HISTORY_FILE_LIMIT; index++) {
      addDraft(a, index + 2, `冲突未处理时的其他正文 ${index}`)
      await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    }
    expect(drive.deletedIds.length).toBeGreaterThan(0)
    const recovered = await service.downloadProject(drive.client(), folderId, validLease)
    expect(JSON.stringify(recovered.bundle.compact!.records)).toContain('检查点中的电脑冲突版本')
    expect(JSON.stringify(recovered.bundle.compact!.records)).toContain('检查点中的手机冲突版本')
    expect(a.engine.preview().conflicts).toHaveLength(1)
    expect(body(a)).toBe('检查点中的电脑冲突版本')
  })

  it('collects covered legacy cumulative packages without removing a concurrently uploaded delta', async () => {
    const fixture = await source(), { a, drive, service, folderId } = fixture, other = await join(fixture)
    addDraft(other, 2, '清理时并发上传的第二章')
    editDraft(a, '旧端累计包的最新正文')
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    drive.put(folderId, a.projectId, 'legacy_full', new TextEncoder().encode(JSON.stringify(a.engine.exportBundle())))
    drive.beforeDelete = () => {
      drive.beforeDelete = undefined
      const incremental = other.engine.exportIncrementalBundle(new Set(a.engine.exportBundle().batches.map(batch => batch.hash)))!
      drive.put(folderId, a.projectId, 'concurrent_delta', new TextEncoder().encode(JSON.stringify(incremental)))
    }
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(drive.files.has('concurrent_delta')).toBe(true)
    expect(drive.deletedIds.length).toBeGreaterThan(0)
    const next = await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(next.preview.missingBatchHashes).toEqual([])
    expect(a.engine.apply(next.preview.token).applied).toBe(true)
    const joined = await join(fixture)
    expect(joined.raw.prepare('SELECT COUNT(*) FROM drafts WHERE chapter_number=2').pluck().get()).toBe(1)
  })
  it('keeps a failed initial upload hidden and resumes the same folder and object after restart', async () => {
    const a = replica(), memory = memoryState(), drive = new MemoryDrive(), service = new GoogleDriveSyncService(memory.state)
    addDraft(a, 1, '手机首次保存的小说'); a.engine.enable()
    const replicaId = a.engine.status().replicaId!
    service.requestEnable({ accountId: drive.account, projectId: a.projectId, replicaId, localPath: 'C:/synthetic/phone-book', name: '手机小说' })
    const binding = await service.bind(drive.client(), a.projectId, replicaId, '手机小说', undefined, validLease)
    expect(drive.folders.get(binding.folderId)!.appProperties!.ainwAutoSync).toBe('0')
    drive.failNextPublication = true
    await expect(service.exchange(drive.client(), a.projectId, a.engine, validLease)).rejects.toThrow('DRIVE_UPLOAD_UNCONFIRMED')
    expect(service.status(a.projectId, replicaId)).toMatchObject({ bound: true, autoSync: true, preferencePending: true })
    expect(drive.folders.get(binding.folderId)!.appProperties!.ainwAutoSync).toBe('0')
    const restarted = new GoogleDriveSyncService(memory.state)
    await restarted.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(drive.folders.size).toBe(1); expect(drive.files.size).toBe(1)
    expect(new Set(drive.publishIds).size).toBe(1)
    expect(drive.folders.get(binding.folderId)!.appProperties!.ainwAutoSync).toBe('1')
    expect(restarted.status(a.projectId, replicaId)).toMatchObject({ autoSync: true })
    expect(restarted.status(a.projectId, replicaId).preferencePending).toBeUndefined()
    expect(memory.state.read().enabling).toEqual({})
  })

  it('reuses a reserved folder after first creation fails and refuses recovery under another account', async () => {
    const a = replica(), memory = memoryState(), drive = new MemoryDrive(), service = new GoogleDriveSyncService(memory.state)
    a.engine.enable(); const replicaId = a.engine.status().replicaId!
    service.requestEnable({ accountId: drive.account, projectId: a.projectId, replicaId, localPath: 'C:/synthetic/phone-book', name: '手机小说' })
    vi.spyOn(drive, 'createProject').mockRejectedValueOnce(new Error('DRIVE_NETWORK_FAILED'))
    await expect(service.bind(drive.client(), a.projectId, replicaId, '手机小说', undefined, validLease)).rejects.toThrow('DRIVE_NETWORK_FAILED')
    const reserved = memory.state.read().creating[`${drive.account}|${a.projectId}`].folderId
    expect(service.status(a.projectId, replicaId)).toEqual({ bound: false, autoSync: true, preferencePending: true })
    drive.account = 'other-account'
    expect(() => service.requestEnable({ accountId: drive.account, projectId: a.projectId, replicaId, localPath: 'C:/synthetic/phone-book', name: '手机小说' })).toThrow('DRIVE_ACCOUNT_MISMATCH')
    await expect(service.bind(drive.client(), a.projectId, replicaId, '手机小说', undefined, validLease)).rejects.toThrow('DRIVE_ACCOUNT_MISMATCH')
    expect(drive.folders.size).toBe(0)
    drive.account = 'synthetic-account'
    const restarted = new GoogleDriveSyncService(memory.state)
    expect((await restarted.bind(drive.client(), a.projectId, replicaId, '手机小说', undefined, validLease)).folderId).toBe(reserved)
    await restarted.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(drive.folders.size).toBe(1); expect(memory.state.read().enabling).toEqual({})
  })

  it('does not revive a canceled switch-on after a later manual exchange', async () => {
    const a = replica(), memory = memoryState(), drive = new MemoryDrive(), service = new GoogleDriveSyncService(memory.state)
    a.engine.enable(); const replicaId = a.engine.status().replicaId!
    service.requestEnable({ accountId: drive.account, projectId: a.projectId, replicaId, localPath: 'C:/synthetic/phone-book', name: '手机小说' })
    const binding = await service.bind(drive.client(), a.projectId, replicaId, '手机小说', undefined, validLease)
    service.setAutoSync(a.projectId, replicaId, false)
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(service.status(a.projectId, replicaId).autoSync).toBe(false)
    expect(drive.folders.get(binding.folderId)!.appProperties!.ainwAutoSync).toBe('0')
    expect(memory.state.read().enabling).toEqual({})
  })
  it('joins an independent replica and stages remote repository changes until explicit application', async () => {
    const fixture = await source(), { a, drive, service } = fixture, b = await join(fixture)
    expect(b.engine.status().replicaId).not.toBe(a.engine.status().replicaId)
    expect(body(b)).toBe('原始正文必须保留')
    editDraft(a, '桌面离线写入的新正文'); addDraft(b, 2, '手机离线新增第二章')
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    const download = await service.exchange(drive.client(), b.projectId, b.engine, validLease)
    expect(download.preview.canApply).toBe(true); expect(download.preview.pendingBatches).toBeGreaterThan(0)
    expect(body(b)).toBe('原始正文必须保留')
    expect(b.engine.apply(download.preview.token).applied).toBe(true)
    expect(body(b)).toBe('桌面离线写入的新正文')
    await service.exchange(drive.client(), b.projectId, b.engine, validLease)
    const reverse = await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(a.raw.prepare('SELECT COUNT(*) FROM drafts WHERE chapter_number=2').pluck().get()).toBe(0)
    expect(a.engine.apply(reverse.preview.token).applied).toBe(true)
    expect(a.raw.prepare('SELECT c.body FROM contents c JOIN drafts d ON c.id=d.content_id WHERE d.chapter_number=2').pluck().get()).toBe('手机离线新增第二章')
    const before = countBatches(a)
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    const files = drive.files.size
    const duplicate = await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(countBatches(a)).toBe(before)
    expect(duplicate.uploaded).toBe(false)
    expect(drive.files.size).toBe(files)
    expect(a.engine.preview().pendingBatches).toBe(0)
  })

  it('preserves both offline body variants and only publishes an author-selected conflict resolution', async () => {
    const fixture = await source(), { a, drive, service } = fixture, b = await join(fixture)
    editDraft(a, '桌面独立改写'); editDraft(b, '手机独立改写')
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    const remote = await service.exchange(drive.client(), b.projectId, b.engine, validLease)
    expect(remote.preview.conflicts).toHaveLength(1)
    expect(body(b)).toBe('手机独立改写')
    expect(b.engine.apply(remote.preview.token).applied).toBe(false)
    await service.exchange(drive.client(), b.projectId, b.engine, validLease)
    const incoming = await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(body(a)).toBe('桌面独立改写')
    const conflict = incoming.preview.conflicts[0]
    expect(conflict.kind).toBe('draft')
    const phone = conflict.variants.find(variant => variant.value && typeof variant.value === 'object' && !Array.isArray(variant.value) && variant.value.content === '手机独立改写')!
    const resolution: SyncResolution = { kind: conflict.kind, id: conflict.id, expectedHeads: conflict.variants.map(variant => variant.revision), selectedRevision: phone.revision }
    expect(a.engine.apply(incoming.preview.token, [resolution]).applied).toBe(true)
    expect(body(a)).toBe('手机独立改写')
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    const confirmed = await service.exchange(drive.client(), b.projectId, b.engine, validLease)
    expect(confirmed.preview.conflicts).toHaveLength(0)
    expect(b.engine.apply(confirmed.preview.token).applied).toBe(true)
    expect(body(b)).toBe(body(a))
    const retainedBodies = a.engine.exportBundle().compact!.records.filter(record => record.kind === 'draft').flatMap(record => record.heads.map(head => head.value))
    expect(JSON.stringify(retainedBodies)).not.toContain('桌面独立改写')
    expect(JSON.stringify(retainedBodies)).toContain('手机独立改写')
    expect(a.engine.preview().conflicts).toEqual([])
  })

  it('isolates received objects and discovery cursors for two local copies of the same project', async () => {
    const fixture = await source(), { a, drive, service, memory } = fixture
    editDraft(a, '第二个副本加入前的新正文')
    await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    const b = await join(fixture)
    expect(body(b)).toBe('第二个副本加入前的新正文')
    editDraft(b, '第二副本后来修改，第一副本还没收到')
    await service.exchange(drive.client(), b.projectId, b.engine, validLease)
    const c = await join(fixture) // Reproduces overwriting a project-level received cache on the same computer.
    expect(body(c)).toBe('第二副本后来修改，第一副本还没收到')
    const before = memory.state.binding(a.projectId, a.engine.status().replicaId!)!
    const result = await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(drive.discoveryCursors.at(-1)).toBe(before.cursor)
    expect(result.downloaded).toBeGreaterThan(0)
    expect(result.preview.pendingBatches).toBeGreaterThan(0)
    expect(body(a)).toBe('第二个副本加入前的新正文')
    expect(a.engine.apply(result.preview.token).applied).toBe(true)
    expect(body(a)).toBe(body(c))
    expect(Object.keys(memory.document().bindings)).toHaveLength(3)
  })

  it('does not receive or write transfer state when its lease expires during download', async () => {
    const fixture = await source(), { a, drive, service, memory } = fixture
    // Own publications are now known immediately; stage an unseen peer object to exercise download cancellation.
    const peer = await join(fixture)
    addDraft(peer, 2, '取消传输的远端新章')
    await service.exchange(drive.client(), a.projectId, peer.engine, validLease)
    let release!: () => void, started!: () => void, current = true
    const held = new Promise<void>(resolve => { release = resolve }), downloading = new Promise<void>(resolve => { started = resolve })
    drive.downloadGate = async () => { started(); await held }
    const checked = () => { if (!current) throw new Error('SYNC_SESSION_STALE') }
    const receive = vi.spyOn(a.engine, 'receive'), before = countBatches(a), saved = memory.document(), writes = memory.writes()
    const exchange = service.exchange(drive.client(), a.projectId, a.engine, checked)
    const failure = expect(exchange).rejects.toThrow('SYNC_SESSION_STALE')
    await downloading; current = false; release(); await failure
    expect(receive).not.toHaveBeenCalled()
    expect(countBatches(a)).toBe(before)
    expect(memory.document()).toEqual(saved); expect(memory.writes()).toBe(writes)
    expect(body(a)).toBe('原始正文必须保留')
  })

  it('does not advance discovery past an invalid package and can receive it after repair', async () => {
    const fixture = await source(), { a, drive, service, memory, folderId } = fixture
    const bytes = new TextEncoder().encode('{"not":"a-sync-package"}')
    drive.put(folderId, a.projectId, 'synthetic_broken', bytes)
    const prior = memory.state.binding(a.projectId, a.engine.status().replicaId!)!, before = body(a)
    await expect(service.exchange(drive.client(), a.projectId, a.engine, validLease)).rejects.toThrow('DRIVE_PACKAGE_INVALID')
    expect(memory.state.binding(a.projectId, a.engine.status().replicaId!)!.cursor).toBe(prior.cursor)
    expect(memory.state.binding(a.projectId, a.engine.status().replicaId!)!.received.synthetic_broken).toBeUndefined()
    expect(body(a)).toBe(before)
    drive.put(folderId, a.projectId, 'synthetic_broken', new TextEncoder().encode(JSON.stringify(a.engine.exportBundle())))
    const repaired = await service.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(repaired.success).toBe(true)
    expect(memory.state.binding(a.projectId, a.engine.status().replicaId!)!.received.synthetic_broken).toBeTruthy()
    expect(countBatches(a)).toBe(0)
    expect(a.engine.exportBundle().compact!.records.length).toBeGreaterThan(0)
  })

  it('reuses the persisted reserved file identity after an unknown publication outcome', async () => {
    const fixture = await source(), { a, drive, service, memory } = fixture
    editDraft(a, '上传回执丢失时也不能重复创建对象')
    drive.failNextPublication = true
    const before = memory.state.binding(a.projectId, a.engine.status().replicaId!)!, files = drive.files.size
    await expect(service.exchange(drive.client(), a.projectId, a.engine, validLease)).rejects.toThrow('DRIVE_UPLOAD_UNCONFIRMED')
    const reserved = drive.publishIds.at(-1)
    expect(drive.files.size).toBe(files + 1)
    expect(memory.state.binding(a.projectId, a.engine.status().replicaId!)!.cursor).toBe(before.cursor)
    const restarted = new GoogleDriveSyncService(memory.state)
    const retried = await restarted.exchange(drive.client(), a.projectId, a.engine, validLease)
    expect(retried.uploaded).toBe(false)
    expect(drive.publishIds.at(-1)).toBe(reserved)
    expect(drive.files.size).toBe(files + 1)
    expect(body(a)).toBe('上传回执丢失时也不能重复创建对象')
  })

  it('rejects a different authorized account before discovering or mutating project data', async () => {
    const fixture = await source(), { a, drive, service, memory } = fixture
    drive.account = 'another-account'
    const saved = memory.document(), calls = drive.discoveryCursors.length, before = countBatches(a)
    await expect(service.exchange(drive.client(), a.projectId, a.engine, validLease)).rejects.toThrow('DRIVE_ACCOUNT_MISMATCH')
    expect(memory.document()).toEqual(saved)
    expect(drive.discoveryCursors).toHaveLength(calls)
    expect(countBatches(a)).toBe(before)
  })

  it('keeps foreground transfer opt-in local to one replica and out of project changes', async () => {
    const fixture = await source(), { a, drive, service, memory } = fixture, replicaId = a.engine.status().replicaId!
    const baseline = a.engine.exportBundle()
    expect(service.status(a.projectId, replicaId).autoSync).toBe(false)
    expect(service.setAutoSync(a.projectId, replicaId, true).autoSync).toBe(true)
    const restarted = new GoogleDriveSyncService(memory.state)
    expect(restarted.status(a.projectId, replicaId).autoSync).toBe(true)
    const b = await join(fixture)
    expect(service.status(b.projectId, b.engine.status().replicaId).autoSync).toBe(false)
    expect(a.engine.exportBundle()).toEqual(baseline)
    expect(() => service.setAutoSync(a.projectId, randomUUID(), true)).toThrow('DRIVE_PROJECT_NOT_BOUND')
    drive.account = 'disconnected'
    expect(service.setAutoSync(a.projectId, replicaId, false).autoSync).toBe(false)
  })

  it('restores an encrypted partial upload session after restart without persisting its plaintext capability', async () => {
    protectedStorage.available = true
    const fixture = await source(), { a, drive, service, memory } = fixture
    editDraft(a, '加密断点恢复的合成内容')
    const original = drive.publish.bind(drive), sessionUrl = '/upload/drive/v3/files?upload_id=SYNTHETIC_PRIVATE_CAPABILITY'
    let interrupted = false
    drive.publish = async (folderId, projectId, bytes, upload) => {
      if (!interrupted) { interrupted = true; upload.sessionUrl = sessionUrl; throw new Error('DRIVE_NETWORK_FAILED') }
      expect(upload.sessionUrl).toBe(sessionUrl)
      const result = await original(folderId, projectId, bytes, upload)
      delete upload.sessionUrl
      return result
    }
    await expect(service.exchange(drive.client(), a.projectId, a.engine, validLease)).rejects.toThrow('DRIVE_NETWORK_FAILED')
    const saved = memory.document(), binding = memory.state.binding(a.projectId, a.engine.status().replicaId!)!
    expect(Object.values(binding.uploadSessions ?? {})).toHaveLength(1)
    expect(JSON.stringify(saved)).not.toContain('SYNTHETIC_PRIVATE_CAPABILITY')
    const restarted = new GoogleDriveSyncService(memory.state)
    expect((await restarted.exchange(drive.client(), a.projectId, a.engine, validLease)).success).toBe(true)
    expect(Object.keys(memory.state.binding(a.projectId, a.engine.status().replicaId!)!.uploadSessions ?? {})).toHaveLength(0)
  })
})
