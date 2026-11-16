import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const boundary = vi.hoisted(() => ({ validGrant: true, completed: 0, released: 0, identity: { volumeSerialNumber: 'synthetic', fileIndex: '1' } }))
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('../../services/external-file-grant-service', () => ({ externalFileGrants: {
  beginUse: () => {
    const revalidate = () => { if (!boundary.validGrant) throw new Error('DRIVE_RESTORE_TARGET_CHANGED') }
    revalidate()
    return { capability: { scope: 'file', relativePath: 'new-copy', rootPath: 'synthetic-parent', rootIdentity: boundary.identity }, revalidate,
      complete: () => { revalidate(); boundary.completed++; boundary.validGrant = false }, release: () => { boundary.released++ } }
  },
  revalidate: () => { if (!boundary.validGrant) throw new Error('DRIVE_RESTORE_TARGET_CHANGED'); return { scope: 'file', relativePath: 'new-copy', rootPath: 'synthetic-parent', rootIdentity: boundary.identity } },
  resolveExactPath: () => 'synthetic-independent-target',
} }))
vi.mock('../../security/windows-safe-file-system', () => ({ captureSecureRootIdentity: () => boundary.identity }))
vi.mock('../project-controller', () => ({ registerRecentProject: vi.fn() }))
import { registerGoogleDriveBackupController } from '../google-drive-backup-controller'
import { GoogleDriveBackupService, GoogleDriveBackupStore } from '../../services/google-drive-backup-service'
import type { DriveBinding } from '../../services/google-drive-state'
import type { GoogleDriveClient } from '../../services/google-drive-client'
import type { exportPortableProject } from '../../services/project-archive-service'
import type { restorePortableProject } from '../../services/project-restore-service'
const event = { sender: { id: 7 } }, otherEvent = { sender: { id: 9 } }
const bytes = Buffer.from('controller synthetic archive'), hash = createHash('sha256').update(bytes).digest('hex')
let root: string, current: boolean, handlers: Map<string, (event: typeof otherEvent, raw: unknown) => Promise<any>>
let binding: DriveBinding, service: GoogleDriveBackupService, exportProject: ReturnType<typeof vi.fn<typeof exportPortableProject>>, restoreProject: ReturnType<typeof vi.fn<typeof restorePortableProject>>
let pendingExport: Promise<void> | undefined, releaseExport: (() => void) | undefined
let locks: Set<string>
const context = () => ({ projectId: binding.projectId, leaseId: 'frozen', projectPath: 'synthetic-source' })
const invoke = (channel: string, input: unknown, sender = event) => handlers.get(channel)!(sender, input)
beforeEach(() => {
  const base = path.resolve('.runtime/test-fixtures/drive-backup-controller'); fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, 'case-'))
  boundary.validGrant = true; boundary.completed = 0; boundary.released = 0; current = true; pendingExport = undefined; releaseExport = undefined
  handlers = new Map(); locks = new Set()
  binding = { projectId: randomUUID(), replicaId: randomUUID(), accountId: 'synthetic-account', folderId: 'folder', files: [], received: {}, uploads: {} }
  service = new GoogleDriveBackupService(new GoogleDriveBackupStore(root))
  service.list = vi.fn(async () => [])
  service.publish = vi.fn(async (_client, _binding, job, check) => { check(); job.completed = true; service.store.save(job) })
  exportProject = vi.fn(async input => {
    input.assertCurrentContext(input.projectSession, input.sourceProjectRoot)
    fs.writeFileSync(input.targetArchivePath, bytes)
    await pendingExport
    return { originProjectId: binding.projectId, snapshotGeneration: input.snapshotGeneration!, targetSha256: hash, targetByteSize: bytes.byteLength,
      sourceEvidence: { schemaVersion: 11, schemaFingerprint: hash, tableCount: 1, fieldCount: 1 }, entryCount: 1, requiresRuntimeFreezeGuard: true }
  })
  restoreProject = vi.fn(async input => {
    input.assertTargetAuthorized?.()
    return { originProjectId: binding.projectId, targetProjectId: randomUUID(), targetProjectRoot: input.targetProjectRoot, snapshotGeneration: randomUUID(), portableDatabaseSha256: hash, requiresRuntimeFreezeGuard: true }
  })
  registerGoogleDriveBackupController({ handle: (channel, handler) => handlers.set(channel, handler), service, locks,
    client: () => ({} as GoogleDriveClient), capture: raw => { if ((raw as { leaseId?: string })?.leaseId !== 'frozen') throw new Error('SYNC_SESSION_STALE'); return { binding, rootPath: 'synthetic-source', session: context(), check: () => { if (!current) throw new Error('SYNC_SESSION_STALE') } } },
    exportProject, restoreProject,
  })
})
afterEach(() => {
  releaseExport?.()
  if (!path.resolve(root).startsWith(path.resolve('.runtime/test-fixtures/drive-backup-controller') + path.sep)) throw new Error('unsafe cleanup')
  fs.rmSync(root, { recursive: true, force: true })
})
describe('Drive backup controller authority and cancellation', () => {
  it('requires the captured session before exporting any content', async () => {
    await expect(invoke('drive:backup-create', { projectSession: { ...context(), leaseId: 'stale' }, operationId: randomUUID(), parentGenerationIds: [] })).rejects.toThrow('SYNC_SESSION_STALE')
    expect(exportProject).not.toHaveBeenCalled()
  })
  it('shares the project lock with sync and rejects a stale lease after snapshot export', async () => {
    pendingExport = new Promise(resolve => { releaseExport = resolve })
    const operationId = randomUUID(), running = invoke('drive:backup-create', { projectSession: context(), operationId, parentGenerationIds: [] })
    await vi.waitFor(() => expect(exportProject).toHaveBeenCalledOnce())
    expect(locks.has(binding.projectId)).toBe(true)
    await expect(invoke('drive:backup-list', { projectSession: context() })).rejects.toThrow('DRIVE_BUSY')
    current = false; releaseExport!()
    await expect(running).rejects.toThrow('SYNC_SESSION_STALE')
    expect(service.publish).not.toHaveBeenCalled(); expect(service.store.read(operationId)?.completed).not.toBe(true)
    expect(locks.size).toBe(0)
  })
  it('only lets the calling window cancel, and does not publish a partial generation', async () => {
    pendingExport = new Promise(resolve => { releaseExport = resolve })
    const operationId = randomUUID(), running = invoke('drive:backup-create', { projectSession: context(), operationId, parentGenerationIds: [] })
    await vi.waitFor(() => expect(exportProject).toHaveBeenCalledOnce())
    expect(await invoke('drive:backup-cancel', { operationId }, otherEvent)).toMatchObject({ cancelled: false })
    expect(await invoke('drive:backup-cancel', { operationId })).toMatchObject({ cancelled: true })
    releaseExport!(); await expect(running).rejects.toThrow('DRIVE_CANCELLED')
    expect(service.publish).not.toHaveBeenCalled()
  })
  it('reuses a prepared archive after an unknown publication instead of exporting newer input under the old identity', async () => {
    const operationId = randomUUID(), request = { projectSession: context(), operationId, parentGenerationIds: [] }
    vi.mocked(service.publish).mockRejectedValueOnce(new Error('DRIVE_UPLOAD_UNCONFIRMED'))
    await expect(invoke('drive:backup-create', request)).rejects.toThrow('DRIVE_UPLOAD_UNCONFIRMED')
    const savedHash = service.store.read(operationId)!.archive!.sha256
    await invoke('drive:backup-create', request)
    expect(exportProject).toHaveBeenCalledOnce(); expect(service.publish).toHaveBeenCalledTimes(2)
    expect(service.store.read(operationId)?.archive?.sha256).toBe(savedHash)
  })
  it('rejects a revoked restore destination before any cloud download', async () => {
    boundary.validGrant = false
    service.download = vi.fn()
    await expect(invoke('drive:backup-restore', { projectSession: context(), operationId: randomUUID(), generationId: randomUUID(), targetGrantId: 'revoked' })).rejects.toThrow('DRIVE_RESTORE_TARGET_CHANGED')
    expect(service.download).not.toHaveBeenCalled(); expect(restoreProject).not.toHaveBeenCalled()
  })
  it('retains the destination capability through download and restore, consuming it only after a new identity commits', async () => {
    const snapshotGeneration = randomUUID()
    service.download = vi.fn(async (_client, _binding, generationId, target, checked) => {
      checked(); fs.writeFileSync(target, bytes); checked()
      return { generationId, snapshotGeneration } as Awaited<ReturnType<typeof service.download>>
    })
    const result = await invoke('drive:backup-restore', { projectSession: context(), operationId: randomUUID(), generationId: randomUUID(), targetGrantId: 'one-use' })
    expect(result.success).toBe(true); expect(result.targetProjectId).not.toBe(binding.projectId)
    expect(restoreProject.mock.calls[0][0]).toMatchObject({ expectedOriginProjectId: binding.projectId, expectedSnapshotGeneration: snapshotGeneration })
    expect(boundary.completed).toBe(1); expect(boundary.released).toBe(1)
  })
})
