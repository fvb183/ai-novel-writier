import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleDriveBackupService, GoogleDriveBackupStore, driveFileSource, type DriveBackupJob } from '../google-drive-backup-service'
import { DRIVE_APP_TAG, type GoogleDriveClient, type DriveObjectKind, type DriveObjectSource, type DriveUpload, type DriveFile } from '../google-drive-client'
import { type DriveBinding, GoogleDriveStateStore } from '../google-drive-state'
import { createProjectArchiveRoundtripFixture } from '../../../test/desktop/project-archive.fixture'
import { exportPortableProject } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { createPortableProjectAssetProvider } from '../portable-project-assets'
import { readPortableKnowledgeSnapshot } from '../../vector-store'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { extractPortableProjectArchive } from '../portable-project-archive'
const require = createRequire(import.meta.url)
const Sqlite = require('better-sqlite3') as typeof import('better-sqlite3')
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false }, app: { getPath: () => path.resolve('.runtime/drive-backup-test-app') } }))
const roots: string[] = []
// A short, synthetic scratch path on the same authorized C workspace avoids
// Windows native SQLite's legacy path-length limit in nested archive attempts.
const temporaryBase = path.resolve('..', '.drive-backup-fixtures')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const scope = (): DriveBinding => ({ projectId: randomUUID(), replicaId: randomUUID(), accountId: 'synthetic-account', folderId: 'synthetic-folder', files: [], uploads: {}, received: {} })
function memoryDrive(binding: DriveBinding) {
  const files = new Map<string, DriveFile>(), bytes = new Map<string, Uint8Array>(), published: DriveObjectKind[] = []
  let counter = 0, failManifest = false
  const client = {
    accountId: async () => binding.accountId, allocateId: async () => `reserved-${++counter}`,
    listObjects: async (_folder: string, _project: string, kind: string) => [...files.values()].filter(file => file.appProperties?.ainwKind === kind),
    metadata: async (id: string) => { if (!files.has(id)) throw new Error('DRIVE_FILE_NOT_FOUND'); return files.get(id)! },
    publishObject: async (_folder: string, _project: string, kind: DriveObjectKind, source: DriveObjectSource, upload: DriveUpload) => {
      if (kind === 'backup-manifest' && failManifest) throw new Error('DRIVE_NETWORK_FAILED')
      const body = await source.read(0, source.byteSize)
      files.set(upload.fileId, { id: upload.fileId, name: kind, parents: [binding.folderId], size: String(body.byteLength), md5Checksum: createHash('md5').update(body).digest('hex'), appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: kind, ainwProject: binding.projectId, ainwDigest: sha(body) } })
      bytes.set(upload.fileId, body); published.push(kind); return true
    },
    downloadObjectBytes: async (file: DriveFile) => bytes.get(file.id)!,
    downloadObject: async (file: DriveFile, _folder: string, _project: string, _kind: string, expected: { sha256: string; byteSize: number }, write: (bytes: Uint8Array) => void) => {
      const body = bytes.get(file.id)!
      if (sha(body) !== expected.sha256 || body.byteLength !== expected.byteSize) throw new Error('DRIVE_HASH_MISMATCH')
      await write(body)
    },
  } as unknown as GoogleDriveClient
  return { client, files, bytes, published, manifestFailure(value: boolean) { failManifest = value } }
}
function setup(binding = scope()) {
  const parent = path.join(temporaryBase, 'jobs'); fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'job-')); roots.push(root)
  const store = new GoogleDriveBackupStore(root), service = new GoogleDriveBackupService(store), drive = memoryDrive(binding)
  const job: DriveBackupJob = { operationId: randomUUID(), projectId: binding.projectId, replicaId: binding.replicaId, accountId: binding.accountId, folderId: binding.folderId, createdAt: '2026-10-29T00:00:00Z', parentGenerationIds: [] }
  return { binding, root, store, service, drive, job }
}
async function writeArchive(test: ReturnType<typeof setup>, bytes = Buffer.from('synthetic complete archive')) {
  fs.writeFileSync(path.join(test.store.jobDirectory(test.job.operationId), 'archive.ainovel'), bytes)
  const source = await driveFileSource(path.join(test.store.jobDirectory(test.job.operationId), 'archive.ainovel'))
  test.job.archive = { sha256: source.sha256, md5: source.md5, byteSize: source.byteSize, snapshotGeneration: randomUUID() }; source.close(); test.store.save(test.job)
}
beforeEach(() => {
  const scratch = path.join(temporaryBase, 'tmp'); fs.mkdirSync(scratch, { recursive: true })
  vi.stubEnv('LOCALAPPDATA', scratch); vi.stubEnv('TEMP', scratch); vi.stubEnv('TMP', scratch)
})
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(temporaryBase, 'jobs') + path.sep)) throw new Error('unsafe test cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})
describe('Google Drive complete historical generations', () => {
  it('hides incomplete archive uploads and resumes the same persisted generation before publishing its manifest', async () => {
    const test = setup(); await writeArchive(test); test.drive.manifestFailure(true)
    await expect(test.service.publish(test.drive.client, test.binding, test.job, () => {})).rejects.toThrow('DRIVE_NETWORK_FAILED')
    expect(await test.service.list(test.drive.client, test.binding, () => {})).toEqual([])
    const saved = test.store.read(test.job.operationId)!, archiveId = saved.archiveUpload!.fileId
    test.drive.manifestFailure(false)
    await new GoogleDriveBackupService(test.store).publish(test.drive.client, test.binding, saved, () => {})
    const generations = await test.service.list(test.drive.client, test.binding, () => {})
    expect(generations).toHaveLength(1); expect(generations[0].archiveFileId).toBe(archiveId)
    expect(test.drive.published.at(-1)).toBe('backup-manifest'); expect(test.store.read(saved.operationId)?.completed).toBe(true)
  })
  it('preserves concurrent sibling generations and excludes a manifest whose archive no longer matches', async () => {
    const test = setup(); await writeArchive(test); await test.service.publish(test.drive.client, test.binding, test.job, () => {})
    for (let index = 0; index < 2; index++) {
      const job = { ...structuredClone(test.job), operationId: randomUUID(), parentGenerationIds: [test.job.operationId], completed: false, archiveUpload: undefined, manifestUpload: undefined }
      fs.copyFileSync(path.join(test.store.jobDirectory(test.job.operationId), 'archive.ainovel'), path.join(test.store.jobDirectory(job.operationId), 'archive.ainovel'))
      await test.service.publish(test.drive.client, test.binding, job, () => {})
    }
    const list = await test.service.list(test.drive.client, test.binding, () => {})
    expect(list.filter(item => item.siblingGenerationIds.length === 1)).toHaveLength(2)
    test.drive.files.get(list[0].archiveFileId)!.size = '1'
    expect(await test.service.list(test.drive.client, test.binding, () => {})).toHaveLength(2)
  })
  it('does not publish a completion or mutate the journal after its lease expires at an awaited archive upload', async () => {
    const test = setup(); await writeArchive(test)
    let current = true
    const original = test.drive.client.publishObject.bind(test.drive.client)
    test.drive.client.publishObject = async (...args) => { const result = await original(...args); current = false; return result }
    const checked = () => { if (!current) throw new Error('SYNC_SESSION_STALE') }
    await expect(test.service.publish(test.drive.client, test.binding, test.job, checked)).rejects.toThrow('SYNC_SESSION_STALE')
    expect(test.drive.published).toEqual(['backup']); expect(test.store.read(test.job.operationId)?.completed).not.toBe(true)
    expect(await test.service.list(test.drive.client, test.binding, () => {})).toEqual([])
  })
  it('seals resumable upload URLs in device state and isolates a second replica or account', async () => {
    const test = setup(); await writeArchive(test)
    const protectedStore = { sealSession: (value: string) => Buffer.from(value).toString('base64'), unsealSession: (value: string) => Buffer.from(value, 'base64').toString() } as GoogleDriveStateStore
    const store = new GoogleDriveBackupStore(test.root, protectedStore)
    test.job.archiveUpload = { fileId: 'fixed', digest: test.job.archive!.sha256, sessionUrl: '/upload/drive/synthetic-private-capability' }
    store.save(test.job)
    expect(fs.readFileSync(path.join(store.jobDirectory(test.job.operationId), 'job.json'), 'utf8')).not.toContain('/upload/drive/')
    expect(store.read(test.job.operationId)?.archiveUpload?.sessionUrl).toContain('/upload/drive/')
    expect(store.pending({ ...test.binding, replicaId: randomUUID() })).toBeUndefined()
    expect(store.pending({ ...test.binding, accountId: 'another-account' })).toBeUndefined()
  })
  it('roundtrips a real portable archive with author assets and canonical knowledge into a new identity', async () => {
    const fixture = await createProjectArchiveRoundtripFixture()
    try {
      const test = setup({ ...scope(), projectId: fixture.sourceProjectId })
      const directory = test.store.jobDirectory(test.job.operationId), archive = path.join(directory, 'archive.ainovel')
      const before = fs.readFileSync(fixture.sourceDatabasePath)
      const checkpointPath = path.join(fixture.sourceStorage, 'partial_arch.json')
      const authorCheckpoint = { candidates: [{ title: '合成作者候选', content: '保留作者已经编写的内容' }], scope: ['world', 'synopsis'], progress: { completed: 2, total: 5, currentStage: 'author-review' } }
      const originalCheckpoint = Buffer.from(`${JSON.stringify({ ...authorCheckpoint,
        world_building_generation_handle: { generationId: 'synthetic-world-runtime-id', token: 'synthetic-world-local-authority' },
        synopsis_generation_handle: { generationId: 'synthetic-synopsis-runtime-id', token: 'synthetic-synopsis-local-authority' },
      }, null, 2)}\n`)
      fs.writeFileSync(checkpointPath, originalCheckpoint)
      const checkpointHash = sha(originalCheckpoint)
      const receipt = await exportPortableProject({ sourceProjectRoot: fixture.sourceRoot, projectSession: { projectId: fixture.sourceProjectId, projectPath: fixture.sourceRoot, leaseId: 'source-lease' }, targetArchivePath: archive, attemptParentPath: directory, assertCurrentContext: () => {}, assets: createPortableProjectAssetProvider(), snapshotGeneration: test.job.operationId })
      expect(fs.readFileSync(checkpointPath)).toEqual(originalCheckpoint)
      expect(sha(fs.readFileSync(checkpointPath))).toBe(checkpointHash)
      const source = await driveFileSource(archive)
      test.job.archive = { sha256: source.sha256, md5: source.md5, byteSize: source.byteSize, snapshotGeneration: receipt.snapshotGeneration }; source.close(); test.store.save(test.job)
      await test.service.publish(test.drive.client, test.binding, test.job, () => {})
      const downloaded = path.join(directory, 'downloaded.ainovel')
      await test.service.download(test.drive.client, test.binding, test.job.operationId, downloaded, () => {})
      expect(fs.readFileSync(downloaded)).toEqual(fs.readFileSync(archive))
      const extracted = await extractPortableProjectArchive({ archivePath: downloaded, stagingParentPath: directory })
      const archivedCheckpoint = fs.readFileSync(path.join(extracted.stagingPath, 'partial_arch.json'))
      expect(JSON.parse(archivedCheckpoint.toString('utf8'))).toEqual(authorCheckpoint)
      expect(extracted.manifest.entries.find(entry => entry.path === 'partial_arch.json')).toMatchObject({ sha256: sha(archivedCheckpoint), byteSize: archivedCheckpoint.length, disposition: 'author-content' })
      expect(sha(archivedCheckpoint)).not.toBe(checkpointHash)
      const forbiddenCheckpointAuthority = ['world_building_generation_handle', 'synopsis_generation_handle',
        'synthetic-world-runtime-id', 'synthetic-synopsis-runtime-id', 'synthetic-world-local-authority', 'synthetic-synopsis-local-authority']
      for (const entry of extracted.manifest.entries) {
        const payload = fs.readFileSync(path.join(extracted.stagingPath, ...entry.path.split('/')))
        for (const forbidden of forbiddenCheckpointAuthority) expect(payload.includes(Buffer.from(forbidden))).toBe(false)
      }
      await expect(restorePortableProject({ archivePath: downloaded, targetProjectRoot: fixture.targetRoot, expectedOriginProjectId: randomUUID() })).rejects.toThrow('PORTABLE_RESTORE_INVALID')
      expect(fs.existsSync(fixture.targetRoot)).toBe(false)
      const restored = await restorePortableProject({ archivePath: downloaded, targetProjectRoot: fixture.targetRoot })
      expect(restored.originProjectId).toBe(fixture.sourceProjectId); expect(restored.targetProjectId).not.toBe(fixture.sourceProjectId)
      const restoredCheckpoint = fs.readFileSync(path.join(fixture.targetStorage, 'partial_arch.json'))
      expect(restoredCheckpoint).toEqual(archivedCheckpoint)
      expect(JSON.parse(restoredCheckpoint.toString('utf8'))).toEqual(authorCheckpoint)
      const database = new Sqlite(fixture.targetDatabasePath, { readonly: true })
      try {
        expect(database.prepare('SELECT body FROM contents WHERE body=?').get(fixture.chapter20Body)).toBeTruthy()
        expect(database.prepare('SELECT COUNT(*) FROM project_sync_meta').pluck().get()).toBe(0)
        const avatar = database.prepare('SELECT relative_path FROM character_avatar_assets WHERE character_id=?').get(fixture.characterId) as { relative_path: string }
        expect(fs.readFileSync(path.join(fixture.targetStorage, avatar.relative_path))).toEqual(fixture.avatarBytes)
      } finally { database.close() }
      expect(await readPortableKnowledgeSnapshot(fixture.targetStorage)).toEqual(await readPortableKnowledgeSnapshot(fixture.sourceStorage))
      expect(fs.readFileSync(fixture.sourceDatabasePath)).toEqual(before)
      expect(fs.readFileSync(checkpointPath)).toEqual(originalCheckpoint)
      expect(sha(fs.readFileSync(checkpointPath))).toBe(checkpointHash)
    } finally { fixture.dispose() }
  }, 45_000)
  it('backs up a schema 10 source and restores the current schema without restoring sync identity', async () => {
    const test = setup(), sourceRoot = path.join(test.root, 'source10'), storage = path.join(sourceRoot, '.ai-novel')
    fs.mkdirSync(storage, { recursive: true })
    fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId: test.binding.projectId, createdAt: '2026-10-01T00:00:00Z' })))
    const original = new Sqlite(path.join(storage, 'project.db'))
    try {
      initializeLegacyBaselineSchema(original); migrateSchema(new SqliteSchemaAdapter(original), getDesktopMigrationRegistry(), 10)
      original.prepare("INSERT INTO project_core(id,project_name) VALUES('main','schema10 synthetic')").run()
      const contentId = original.prepare('INSERT INTO contents(body) VALUES(?)').run('旧版本保留正文').lastInsertRowid
      original.prepare("INSERT INTO drafts(chapter_number,version,source,content_id,word_count) VALUES(1,1,'write',?,8)").run(contentId)
      expect(original.pragma('user_version', { simple: true })).toBe(10)
    } finally { original.close() }
    const directory = test.store.jobDirectory(test.job.operationId), archive = path.join(directory, 'archive.ainovel')
    const receipt = await exportPortableProject({ sourceProjectRoot: sourceRoot, projectSession: { projectId: test.binding.projectId, projectPath: sourceRoot, leaseId: 'source10' }, targetArchivePath: archive, attemptParentPath: directory, assets: createPortableProjectAssetProvider(), snapshotGeneration: test.job.operationId, assertCurrentContext: () => {} })
    const preservedSource = new Sqlite(path.join(storage, 'project.db'), { readonly: true })
    try { expect(preservedSource.pragma('user_version', { simple: true })).toBe(10) } finally { preservedSource.close() }
    const source = await driveFileSource(archive)
    test.job.archive = { sha256: source.sha256, md5: source.md5, byteSize: source.byteSize, snapshotGeneration: receipt.snapshotGeneration }; source.close(); test.store.save(test.job)
    await test.service.publish(test.drive.client, test.binding, test.job, () => {})
    const downloaded = path.join(directory, 'downloaded.ainovel'), target = path.join(test.root, 'copy10')
    await test.service.download(test.drive.client, test.binding, test.job.operationId, downloaded, () => {})
    const restored = await restorePortableProject({ archivePath: downloaded, targetProjectRoot: target, expectedOriginProjectId: test.binding.projectId, expectedSnapshotGeneration: test.job.operationId })
    expect(restored.targetProjectId).not.toBe(test.binding.projectId)
    const database = new Sqlite(path.join(target, '.ai-novel', 'project.db'), { readonly: true })
    try { expect(database.pragma('user_version', { simple: true })).toBe(11); expect(database.prepare('SELECT COUNT(*) FROM project_sync_meta').pluck().get()).toBe(0) }
    finally { database.close() }
  }, 45_000)
})
