import path from 'node:path'
import { getGlobalDataRoot } from './app-data-locator'
import { tryReadJsonFile, writeJsonFile } from '../utils/config-utils'
import { safeStorage } from 'electron'
import { deviceProtectedStorageAvailable } from './device-protected-storage'
import type { DriveFile } from './google-drive-client'
import { parseProjectAssetBlob, type ProjectAssetBlob } from '../../src/shared/project-sync-assets'
import type { CompactCloudSummary } from './google-drive-compact-sync'
import { validDriveAssetGarbageState, type DriveAssetGarbageState } from './google-drive-asset-gc'

export interface DriveBinding {
  replicaId: string
  accountId: string
  folderId: string
  projectId: string
  autoSync?: boolean
  pendingDisable?: boolean
  localPath?: string
  cursor?: string
  files: DriveFile[]
  received: Record<string, string>
  uploads: Record<string, string>
  /** Exact batch coverage of each verified live immutable cloud object. */
  cloudBatches?: Record<string, string[]>
  cloudCompact?: Record<string, CompactCloudSummary>
  assetGarbage?: DriveAssetGarbageState
  freshAssetUploads?: Record<string, { fileId: string; createdAt: number }>
  uploadSessions?: Record<string, string>
  /** Union of all dependencies from received/published packages; derived, device-local. */
  assetReferences?: ProjectAssetBlob[]
  /** Set only after every discovered domain package passed current author-byte policy. */
  assetPolicyVersion?: 1
  lastUploadedHash?: string
  lastTransferredAt?: string
  historyCleanupError?: string
}
/** An explicit switch-on survives a failed first upload, but never changes accounts. */
export interface DriveEnableIntent { accountId: string; projectId: string; replicaId: string; localPath: string; name: string }
export interface DriveState { version: 1; bindings: Record<string, DriveBinding>; creating: Record<string, { accountId: string; folderId: string }>; enabling?: Record<string, DriveEnableIntent>; excludedProjects?: Record<string, string[]> }
export const driveReplicaKey = (projectId: string, replicaId: string) => `${projectId}|${replicaId}`
export interface DriveStateIO { read(): unknown; write(value: DriveState): void }
const empty = (): DriveState => ({ version: 1, bindings: {}, creating: {} })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function validCompactSummaries(value: unknown): value is Record<string, CompactCloudSummary> {
  const validClock = (clock: unknown): boolean => !!clock && typeof clock === 'object' && !Array.isArray(clock)
    && Object.keys(clock).length <= 1024 && Object.values(clock).every(sequence => Number.isSafeInteger(sequence) && (sequence as number) >= 0)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 2048) return false
  try {
    for (const summary of Object.values(value) as CompactCloudSummary[]) {
      if (!summary || !validClock(summary.clock) || !Array.isArray(summary.records) || summary.records.length > 100_000) return false
      for (const record of summary.records) {
        if (typeof record.kind !== 'string' || typeof record.id !== 'string' || !Array.isArray(record.heads) || record.heads.length > 256) return false
        for (const head of record.heads) {
          if (!/^[a-f0-9]{64}$/.test(head.revision) || typeof head.deleted !== 'boolean' || !validClock(head.clock)) return false
          if (head.assets !== undefined) {
            if (!Array.isArray(head.assets) || head.assets.length > 100_000) return false
            for (const blob of head.assets) parseProjectAssetBlob(blob)
          }
        }
      }
    }
    return true
  } catch { return false }
}
export class GoogleDriveStateStore {
  constructor(private io: DriveStateIO = {
    read: () => {
      const result = tryReadJsonFile(path.join(getGlobalDataRoot(), 'google-drive-projects.json'))
      if (result.status === 'error') throw new Error('DRIVE_LOCAL_STATE_INVALID')
      return result.status === 'missing' ? null : result.value
    },
    write: value => writeJsonFile(path.join(getGlobalDataRoot(), 'google-drive-projects.json'), value),
  }) {}
  read(): DriveState {
    const value = this.io.read() as DriveState | null
    if (!value) return empty()
    if (value.version !== 1 || !value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)
      || !value.creating || typeof value.creating !== 'object' || Array.isArray(value.creating)) throw new Error('DRIVE_LOCAL_STATE_INVALID')
    for (const [key, binding] of Object.entries(value.bindings)) {
      if (!binding.replicaId || key !== driveReplicaKey(binding.projectId, binding.replicaId) || !binding.accountId || !binding.folderId || !Array.isArray(binding.files) || binding.files.length > 2048
        || binding.autoSync !== undefined && typeof binding.autoSync !== 'boolean'
        || binding.pendingDisable !== undefined && typeof binding.pendingDisable !== 'boolean'
        || binding.localPath !== undefined && (typeof binding.localPath !== 'string' || !path.isAbsolute(binding.localPath) || binding.localPath.includes('\0'))
        || binding.assetPolicyVersion !== undefined && binding.assetPolicyVersion !== 1
        || binding.historyCleanupError !== undefined && (typeof binding.historyCleanupError !== 'string' || !/^[A-Z][A-Z0-9_]{1,95}$/.test(binding.historyCleanupError))
        || !binding.received || typeof binding.received !== 'object' || !binding.uploads || typeof binding.uploads !== 'object') throw new Error('DRIVE_LOCAL_STATE_INVALID')
      if (binding.assetReferences !== undefined) {
        if (!Array.isArray(binding.assetReferences) || binding.assetReferences.length > 100_000) throw new Error('DRIVE_LOCAL_STATE_INVALID')
        const ids = new Set<string>()
        for (const blob of binding.assetReferences) {
          parseProjectAssetBlob(blob)
          if (ids.has(blob.sha256)) throw new Error('DRIVE_LOCAL_STATE_INVALID')
          ids.add(blob.sha256)
        }
      }
      if (binding.cloudBatches !== undefined && (!binding.cloudBatches || typeof binding.cloudBatches !== 'object' || Array.isArray(binding.cloudBatches)
        || Object.keys(binding.cloudBatches).length > 2048 || Object.values(binding.cloudBatches).some(hashes => !Array.isArray(hashes)
          || hashes.length > 20_000 || hashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))))) throw new Error('DRIVE_LOCAL_STATE_INVALID')
      if (binding.assetGarbage !== undefined && !validDriveAssetGarbageState(binding.assetGarbage)) throw new Error('DRIVE_LOCAL_STATE_INVALID')
      if (binding.cloudCompact !== undefined && !validCompactSummaries(binding.cloudCompact)) throw new Error('DRIVE_LOCAL_STATE_INVALID')
      if (binding.freshAssetUploads !== undefined && (!binding.freshAssetUploads || typeof binding.freshAssetUploads !== 'object'
        || Object.entries(binding.freshAssetUploads).some(([hash, item]) => !/^[a-f0-9]{64}$/.test(hash) || !item || !/^[A-Za-z0-9_-]{1,200}$/.test(item.fileId)
          || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0))) throw new Error('DRIVE_LOCAL_STATE_INVALID')
    }
    if (value.excludedProjects !== undefined && (typeof value.excludedProjects !== 'object' || value.excludedProjects === null || Array.isArray(value.excludedProjects)
      || Object.values(value.excludedProjects).some(ids => !Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id)))) throw new Error('DRIVE_LOCAL_STATE_INVALID')
    if (value.enabling !== undefined) {
      if (!value.enabling || typeof value.enabling !== 'object' || Array.isArray(value.enabling) || Object.keys(value.enabling).length > 1000) throw new Error('DRIVE_LOCAL_STATE_INVALID')
      for (const [key, intent] of Object.entries(value.enabling)) if (!intent || key !== driveReplicaKey(intent.projectId, intent.replicaId)
        || typeof intent.accountId !== 'string' || !intent.accountId || typeof intent.projectId !== 'string' || !intent.projectId
        || typeof intent.replicaId !== 'string' || !intent.replicaId || typeof intent.name !== 'string' || intent.name.length > 200
        || typeof intent.localPath !== 'string' || !path.isAbsolute(intent.localPath) || intent.localPath.includes('\0')) throw new Error('DRIVE_LOCAL_STATE_INVALID')
    }
    return clone(value)
  }
  update(change: (state: DriveState) => void): void {
    const state = this.read(), before = JSON.stringify(state)
    change(state)
    if (JSON.stringify(state) !== before) this.io.write(clone(state))
  }
  binding(projectId: string, replicaId: string): DriveBinding | undefined { return this.read().bindings[driveReplicaKey(projectId, replicaId)] }
  markProjectRemoved(projectId: string): void {
    this.update(state => {
      for (const [key, intent] of Object.entries(state.enabling ?? {})) if (intent.projectId === projectId) {
        state.excludedProjects ??= {}
        state.excludedProjects[intent.accountId] = [...new Set([...(state.excludedProjects[intent.accountId] ?? []), projectId])].slice(-1000)
        delete state.enabling![key]
      }
      for (const binding of Object.values(state.bindings)) if (binding.projectId === projectId) {
        state.excludedProjects ??= {}
        const ids = state.excludedProjects[binding.accountId] ?? []
        state.excludedProjects[binding.accountId] = [...new Set([...ids, projectId])].slice(-1000)
      }
    })
  }
  sealSession(value: string): string | undefined {
    try {
      if (!deviceProtectedStorageAvailable(safeStorage)) return
      return safeStorage.encryptString(value).toString('base64')
    } catch { return undefined }
  }
  unsealSession(value: string): string {
    try { return safeStorage.decryptString(Buffer.from(value, 'base64')) }
    catch { throw new Error('DRIVE_UPLOAD_STATE_UNAVAILABLE') }
  }
}
