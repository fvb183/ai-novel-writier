import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DriveBackupGeneration } from '../../src/shared/google-drive-backup'
import { GoogleDriveClient, DRIVE_OBJECT_LIMITS, DRIVE_APP_TAG, driveBytesSource, validDriveId, type DriveObjectSource, type DriveUpload } from './google-drive-client'
import { GoogleDriveStateStore, type DriveBinding } from './google-drive-state'
import { tryReadJsonFile, writeJsonFile } from '../utils/config-utils'
import { validatePlatformDirectoryChain } from './migration-file-system'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
function fail(code: string): never { throw new Error(code) }
export interface DriveBackupJob {
  operationId: string; projectId: string; replicaId: string; accountId: string; folderId: string
  createdAt: string; parentGenerationIds: string[]; completed?: boolean
  archive?: { sha256: string; md5: string; byteSize: number; snapshotGeneration: string }
  archiveUpload?: DriveUpload; manifestUpload?: DriveUpload
}
type Manifest = { format: 'ai-novel-drive-backup'; version: 1; generationId: string; parentGenerationIds: string[]; createdAt: string; originProjectId: string; snapshotGeneration: string; archive: { fileId: string; sha256: string; md5: string; byteSize: number } }
const sameScope = (job: DriveBackupJob, binding: DriveBinding) => ['projectId', 'replicaId', 'accountId', 'folderId'].every(key => job[key as keyof DriveBackupJob] === binding[key as keyof DriveBinding])
export class GoogleDriveBackupStore {
  constructor(private rootValue: string | (() => string), private sessions = new GoogleDriveStateStore()) {}
  get root(): string { return typeof this.rootValue === 'function' ? this.rootValue() : this.rootValue }
  private directory(directory: string): void {
    const platform = validatePlatformDirectoryChain(directory, true)
    if (!platform) {
      const missing: string[] = []; let cursor = path.resolve(directory)
      while (!fs.existsSync(cursor)) { missing.push(cursor); const parent = path.dirname(cursor); if (parent === cursor) fail('DRIVE_BACKUP_LOCAL_INVALID'); cursor = parent }
      for (let current = cursor;; current = path.dirname(current)) {
        const info = fs.lstatSync(current)
        if (info.isSymbolicLink() || !info.isDirectory()) fail('DRIVE_BACKUP_LOCAL_INVALID')
        if (path.dirname(current) === current) break
      }
      for (const entry of missing.reverse()) fs.mkdirSync(entry, { mode: 0o700 })
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) fail('DRIVE_BACKUP_LOCAL_INVALID')
    const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    if (!platform && normalized(fs.realpathSync.native(directory)) !== normalized(directory)) fail('DRIVE_BACKUP_LOCAL_INVALID')
    validatePlatformDirectoryChain(directory)
  }
  jobDirectory(operationId: string): string {
    if (!UUID.test(operationId)) fail('DRIVE_INPUT_INVALID')
    this.directory(this.root)
    const directory = path.join(this.root, operationId); this.directory(directory); return directory
  }
  read(operationId: string): DriveBackupJob | undefined {
    const file = path.join(this.jobDirectory(operationId), 'job.json')
    if (fs.existsSync(file)) { const info = fs.lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('DRIVE_BACKUP_LOCAL_INVALID') }
    const result = tryReadJsonFile(file)
    if (result.status === 'missing') return
    if (result.status !== 'ok') fail('DRIVE_BACKUP_LOCAL_INVALID')
    const job = result.value as DriveBackupJob
    if (!job || job.operationId !== operationId || !UUID.test(job.projectId) || !UUID.test(job.replicaId)
      || !validDriveId(job.accountId) || !validDriveId(job.folderId) || !Number.isFinite(Date.parse(job.createdAt))
      || !Array.isArray(job.parentGenerationIds) || job.parentGenerationIds.some(id => !UUID.test(id))) fail('DRIVE_BACKUP_LOCAL_INVALID')
    for (const upload of [job.archiveUpload, job.manifestUpload]) if (upload?.sessionUrl) upload.sessionUrl = this.sessions.unsealSession(upload.sessionUrl)
    return job
  }
  save(job: DriveBackupJob): void {
    const copy = structuredClone(job)
    for (const upload of [copy.archiveUpload, copy.manifestUpload]) if (upload?.sessionUrl) {
      const sealed = this.sessions.sealSession(upload.sessionUrl)
      if (sealed) upload.sessionUrl = sealed; else delete upload.sessionUrl
    }
    const file = path.join(this.jobDirectory(job.operationId), 'job.json')
    if (fs.existsSync(file)) { const info = fs.lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('DRIVE_BACKUP_LOCAL_INVALID') }
    writeJsonFile(file, copy)
  }
  pending(binding: DriveBinding): DriveBackupJob | undefined {
    this.directory(this.root)
    const jobs = fs.readdirSync(this.root).filter(name => UUID.test(name)).map(name => this.read(name)!).filter(job => job && !job.completed && sameScope(job, binding))
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  }
}

/** A bounded source keeps one verified file descriptor, never a renderer path. */
export async function driveFileSource(file: string, check: () => void = () => {}): Promise<DriveObjectSource & { close(): void }> {
  check()
  const before = fs.lstatSync(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(DRIVE_OBJECT_LIMITS.backup)) fail('DRIVE_BACKUP_LOCAL_INVALID')
  const fd = fs.openSync(file, 'r'), same = () => {
    const info = fs.fstatSync(fd, { bigint: true })
    if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || info.mtimeNs !== before.mtimeNs || info.nlink !== 1n) fail('DRIVE_SOURCE_CHANGED')
  }
  const read = async (offset: number, length: number) => {
    // Yield between bounded reads so cancellation/project changes can be handled
    // even while hashing a large local archive before any HTTP request.
    await new Promise(resolve => setTimeout(resolve, 0)); check(); same()
    const bytes = Buffer.alloc(length)
    if (fs.readSync(fd, bytes, 0, length, offset) !== length) fail('DRIVE_SOURCE_CHANGED')
    same(); check(); return bytes
  }
  try {
    same(); const sha = createHash('sha256'), md5 = createHash('md5')
    for (let offset = 0; offset < Number(before.size); offset += 4 * 1024 ** 2) { const bytes = await read(offset, Math.min(4 * 1024 ** 2, Number(before.size) - offset)); sha.update(bytes); md5.update(bytes) }
    return { byteSize: Number(before.size), sha256: sha.digest('hex'), md5: md5.digest('hex'), read, close: () => fs.closeSync(fd) }
  } catch (error) { fs.closeSync(fd); throw error }
}
function parseManifest(bytes: Uint8Array, projectId: string): Manifest {
  let value: Manifest
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return fail('DRIVE_BACKUP_INVALID') }
  if (!value || value.format !== 'ai-novel-drive-backup' || value.version !== 1 || !UUID.test(value.generationId)
    || value.originProjectId !== projectId || !UUID.test(value.snapshotGeneration) || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.parentGenerationIds) || value.parentGenerationIds.length > 256 || new Set(value.parentGenerationIds).size !== value.parentGenerationIds.length
    || value.parentGenerationIds.some(id => !UUID.test(id) || id === value.generationId)
    || !value.archive || !validDriveId(value.archive.fileId) || !HASH.test(value.archive.sha256) || !/^[a-f0-9]{32}$/.test(value.archive.md5)
    || !Number.isSafeInteger(value.archive.byteSize) || value.archive.byteSize <= 0 || value.archive.byteSize > DRIVE_OBJECT_LIMITS.backup) fail('DRIVE_BACKUP_INVALID')
  return value
}
export class GoogleDriveBackupService {
  constructor(readonly store: GoogleDriveBackupStore) {}
  async list(client: GoogleDriveClient, binding: DriveBinding, check: () => void): Promise<DriveBackupGeneration[]> {
    if (await client.accountId() !== binding.accountId) fail('DRIVE_ACCOUNT_MISMATCH'); check()
    const files = await client.listObjects(binding.folderId, binding.projectId, 'backup-manifest'); check()
    const result: DriveBackupGeneration[] = []
    for (const file of files) {
      const bytes = await client.downloadObjectBytes(file, binding.folderId, binding.projectId, 'backup-manifest'); check()
      const manifest = parseManifest(bytes, binding.projectId)
      let archive
      try { archive = await client.metadata(manifest.archive.fileId); check() }
      catch (error) { if (error instanceof Error && error.message === 'DRIVE_FILE_NOT_FOUND') continue; throw error }
      if (archive.trashed || !archive.parents?.includes(binding.folderId) || archive.appProperties?.ainwApp !== DRIVE_APP_TAG || archive.appProperties.ainwKind !== 'backup'
        || archive.appProperties.ainwProject !== binding.projectId || archive.appProperties.ainwDigest !== manifest.archive.sha256 || archive.md5Checksum !== manifest.archive.md5 || Number(archive.size) !== manifest.archive.byteSize) continue
      if (result.some(item => item.generationId === manifest.generationId)) fail('DRIVE_BACKUP_INVALID')
      result.push({ generationId: manifest.generationId, parentGenerationIds: manifest.parentGenerationIds, createdAt: manifest.createdAt,
        originProjectId: manifest.originProjectId, snapshotGeneration: manifest.snapshotGeneration, archiveSha256: manifest.archive.sha256, archiveByteSize: manifest.archive.byteSize,
        archiveFileId: manifest.archive.fileId, manifestFileId: file.id, siblingGenerationIds: [] })
    }
    for (const item of result) item.siblingGenerationIds = result.filter(other => other.generationId !== item.generationId && ((!other.parentGenerationIds.length && !item.parentGenerationIds.length) || other.parentGenerationIds.some(parent => item.parentGenerationIds.includes(parent)))).map(other => other.generationId)
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.generationId.localeCompare(b.generationId))
  }
  async publish(client: GoogleDriveClient, binding: DriveBinding, job: DriveBackupJob, check: () => void): Promise<void> {
    check(); if (!sameScope(job, binding) || !job.archive) fail('DRIVE_BACKUP_LOCAL_INVALID')
    if (await client.accountId() !== binding.accountId) fail('DRIVE_ACCOUNT_MISMATCH'); check()
    const source = await driveFileSource(path.join(this.store.jobDirectory(job.operationId), 'archive.ainovel'), check)
    try {
      check()
      if (source.sha256 !== job.archive.sha256 || source.byteSize !== job.archive.byteSize || source.md5 !== job.archive.md5) fail('DRIVE_SOURCE_CHANGED')
      if (!job.archiveUpload) { const fileId = await client.allocateId(); check(); job.archiveUpload = { fileId, digest: source.sha256 }; this.store.save(job) }
      try { await client.publishObject(binding.folderId, binding.projectId, 'backup', source, job.archiveUpload); check() }
      finally { try { check(); this.store.save(job) } catch { /* Invalid leases never persist a late session. */ } }
      const manifest: Manifest = { format: 'ai-novel-drive-backup', version: 1, generationId: job.operationId, parentGenerationIds: job.parentGenerationIds,
        createdAt: job.createdAt, originProjectId: job.projectId, snapshotGeneration: job.archive.snapshotGeneration,
        archive: { fileId: job.archiveUpload.fileId, sha256: source.sha256, md5: source.md5, byteSize: source.byteSize } }
      const document = driveBytesSource(new TextEncoder().encode(JSON.stringify(manifest)))
      if (!job.manifestUpload) { const fileId = await client.allocateId(); check(); job.manifestUpload = { fileId, digest: document.sha256 }; this.store.save(job) }
      if (job.manifestUpload.digest !== document.sha256) fail('DRIVE_BACKUP_LOCAL_INVALID')
      try { await client.publishObject(binding.folderId, binding.projectId, 'backup-manifest', document, job.manifestUpload); check() }
      finally { try { check(); this.store.save(job) } catch { /* Preserve only state owned by this lease. */ } }
      check(); job.completed = true; this.store.save(job)
    } finally { source.close() }
  }
  async download(client: GoogleDriveClient, binding: DriveBinding, generationId: string, target: string, check: () => void): Promise<DriveBackupGeneration> {
    const generations = await this.list(client, binding, check); check()
    const generation = generations.find(item => item.generationId === generationId)
    if (!generation) fail('DRIVE_BACKUP_NOT_FOUND')
    const file = await client.metadata(generation!.archiveFileId); check()
    const fd = fs.openSync(target, 'wx', 0o600)
    try {
      await client.downloadObject(file, binding.folderId, binding.projectId, 'backup', { sha256: generation!.archiveSha256, byteSize: generation!.archiveByteSize }, chunk => {
        check(); let offset = 0
        while (offset < chunk.byteLength) offset += fs.writeSync(fd, chunk, offset, chunk.byteLength - offset)
      }); check(); fs.fsyncSync(fd)
    } catch (error) { fs.closeSync(fd); fs.unlinkSync(target); throw error }
    fs.closeSync(fd); return generation!
  }
}
