import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import type { DriveBinding } from '../services/google-drive-state'
import type { GoogleDriveClient } from '../services/google-drive-client'
import { GoogleDriveBackupService, driveFileSource, type DriveBackupJob } from '../services/google-drive-backup-service'
import { exportPortableProject } from '../services/project-archive-service'
import { restorePortableProject } from '../services/project-restore-service'
import { createPortableProjectAssetProvider } from '../services/portable-project-assets'
import { externalFileGrants } from '../services/external-file-grant-service'
import { registerRecentProject } from './project-controller'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
function fail(code: string): never { throw new Error(code) }
type Event = { sender: { id: number } }
export interface DriveBackupScope { binding: DriveBinding; rootPath: string; session: ProjectSessionContext; check(): void; prepare?(): Promise<void> }
export interface DriveBackupControllerDependencies {
  handle(channel: string, handler: (event: Event, raw: unknown) => Promise<unknown>): void
  capture(raw: unknown): DriveBackupScope
  client(check: () => void, signal: AbortSignal): GoogleDriveClient
  service: GoogleDriveBackupService
  locks: Set<string>
  exportProject?: typeof exportPortableProject
  restoreProject?: typeof restorePortableProject
}
export function registerGoogleDriveBackupController(deps: DriveBackupControllerDependencies): { cancelAll(): void } {
  const operations = new Map<string, { owner: number; abort: AbortController }>()
  const input = (raw: unknown) => { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('DRIVE_INPUT_INVALID'); return raw as Record<string, unknown> }
  const run = async (event: Event, value: Record<string, unknown>, task: (scope: DriveBackupScope, client: GoogleDriveClient, check: () => void, signal: AbortSignal) => Promise<unknown>) => {
    const operationId = value.operationId ?? randomUUID()
    if (typeof operationId !== 'string' || !UUID.test(operationId)) fail('DRIVE_INPUT_INVALID')
    const scope = deps.capture(value.projectSession)
    if (operations.has(operationId) || deps.locks.has(scope.binding.projectId)) fail('DRIVE_BUSY')
    const abort = new AbortController()
    const check = () => { if (abort.signal.aborted) fail('DRIVE_CANCELLED'); scope.check() }
    operations.set(operationId, { owner: event.sender.id, abort }); deps.locks.add(scope.binding.projectId)
    try { check(); return await task(scope, deps.client(check, abort.signal), check, abort.signal) }
    finally { operations.delete(operationId); deps.locks.delete(scope.binding.projectId) }
  }
  deps.handle('drive:backup-cancel', async (event, raw) => {
    const value = input(raw), operation = operations.get(String(value.operationId))
    if (operation && operation.owner === event.sender.id) operation.abort.abort()
    return { success: true, cancelled: Boolean(operation?.owner === event.sender.id) }
  })
  deps.handle('drive:backup-list', async (event, raw) => {
    const value = input(raw)
    return run(event, value, async (scope, client, check) => {
      const generations = await deps.service.list(client, scope.binding, check); check()
      return { success: true, generations, pendingOperationId: deps.service.store.pending(scope.binding)?.operationId }
    })
  })
  deps.handle('drive:backup-create', async (event, raw) => {
    const value = input(raw)
    if (typeof value.operationId !== 'string' || !UUID.test(value.operationId) || !Array.isArray(value.parentGenerationIds)
      || value.parentGenerationIds.length > 256 || value.parentGenerationIds.some(id => typeof id !== 'string' || !UUID.test(id))) fail('DRIVE_INPUT_INVALID')
    return run(event, value, async (scope, client, check) => {
      const existing = await deps.service.list(client, scope.binding, check); check()
      let job = deps.service.store.read(value.operationId as string)
      if (job && ['projectId', 'replicaId', 'accountId', 'folderId'].some(name => job![name as keyof DriveBackupJob] !== scope.binding[name as keyof DriveBinding])) fail('DRIVE_ACCOUNT_MISMATCH')
      if (!job) {
        if (deps.service.store.pending(scope.binding)) fail('DRIVE_BACKUP_PENDING')
        const parents = [...new Set(value.parentGenerationIds as string[])]
        if (parents.some(id => !existing.some(item => item.generationId === id))) fail('DRIVE_BACKUP_PARENT_MISSING')
        job = { operationId: value.operationId as string, projectId: scope.binding.projectId, replicaId: scope.binding.replicaId,
          accountId: scope.binding.accountId, folderId: scope.binding.folderId, createdAt: new Date().toISOString(), parentGenerationIds: parents }
        check(); deps.service.store.save(job)
      }
      if (job.completed) {
        const generation = existing.find(item => item.generationId === job!.operationId)
        if (!generation) fail('DRIVE_BACKUP_NOT_FOUND')
        return { success: true, generation, generations: existing }
      }
      const directory = deps.service.store.jobDirectory(job.operationId), archive = path.join(directory, 'archive.ainovel')
      if (!job.archive) {
        await scope.prepare?.(); check()
        if (fs.existsSync(archive)) { const info = fs.lstatSync(archive); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('DRIVE_BACKUP_LOCAL_INVALID'); fs.unlinkSync(archive) }
        const receipt = await (deps.exportProject ?? exportPortableProject)({ sourceProjectRoot: scope.rootPath, projectSession: scope.session,
          targetArchivePath: archive, attemptParentPath: directory, snapshotGeneration: job.operationId, assets: createPortableProjectAssetProvider(),
          assertCurrentContext() { check(); return true } })
        check(); const source = await driveFileSource(archive, check)
        try {
          check()
          if (source.sha256 !== receipt.targetSha256 || source.byteSize !== receipt.targetByteSize) fail('DRIVE_SOURCE_CHANGED')
          job.archive = { sha256: source.sha256, md5: source.md5, byteSize: source.byteSize, snapshotGeneration: receipt.snapshotGeneration }
          deps.service.store.save(job)
        } finally { source.close() }
      }
      await deps.service.publish(client, scope.binding, job, check); check()
      const generations = await deps.service.list(client, scope.binding, check); check()
      return { success: true, generations, generation: generations.find(item => item.generationId === job!.operationId) }
    })
  })
  deps.handle('drive:backup-restore', async (event, raw) => {
    const value = input(raw)
    if (typeof value.generationId !== 'string' || !UUID.test(value.generationId) || typeof value.targetGrantId !== 'string') fail('DRIVE_INPUT_INVALID')
    const permission = { grantId: value.targetGrantId as string, webContentsId: event.sender.id, operation: 'create' as const }
    const grant = externalFileGrants.beginUse(permission)
    try {
      const capability = grant.capability
      if (capability.scope !== 'file') fail('DRIVE_RESTORE_TARGET_CHANGED')
      // Keep the one-use grant live across download and installation; consuming it
      // here would make every later boundary revalidation fail.
      const target = path.join(capability.rootPath, capability.relativePath)
      return await run(event, value, async (scope, client, check, signal) => {
        const authorized = () => {
          check(); grant.revalidate()
        }
        authorized()
        const directory = deps.service.store.jobDirectory(String(value.operationId)), archive = path.join(directory, 'restore.ainovel')
        if (fs.existsSync(archive)) fail('DRIVE_BACKUP_LOCAL_INVALID')
        try {
          const generation = await deps.service.download(client, scope.binding, value.generationId as string, archive, authorized); authorized()
          const receipt = await (deps.restoreProject ?? restorePortableProject)({ archivePath: archive, targetProjectRoot: target, signal, assertTargetAuthorized: authorized,
            expectedOriginProjectId: scope.binding.projectId, expectedSnapshotGeneration: generation.snapshotGeneration })
          grant.complete()
          // Restoration has committed independently. A late navigation result must not rewrite its identity.
          try { registerRecentProject({ name: path.basename(receipt.targetProjectRoot), path: receipt.targetProjectRoot, projectId: receipt.targetProjectId, updatedAt: new Date().toISOString() }) } catch { /* Copy remains available. */ }
          return { success: true, projectPath: receipt.targetProjectRoot, targetProjectId: receipt.targetProjectId }
        } finally { if (fs.existsSync(archive)) fs.unlinkSync(archive) }
      })
    } finally { grant.release() }
  })
  return { cancelAll() { for (const operation of operations.values()) operation.abort.abort() } }
}
