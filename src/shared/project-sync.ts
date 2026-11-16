/** Local-first protocol. Local SQLite row ids and runtime authority never identify changes. */
export type SyncJson = null | boolean | number | string | SyncJson[] | { [key: string]: SyncJson }
export interface SyncRecord { kind: string; id: string; value: SyncJson }
export interface SyncChange { kind: string; id: string; parents: string[]; value: SyncJson | null; deleted: boolean }
export interface SyncBatch {
  protocol: 1
  projectId: string
  replicaId: string
  sequence: number
  previousHash: string | null
  batchId: string
  changes: SyncChange[]
  hash: string
}
import type { CompactSnapshot } from './project-sync-compact'
export type SyncFeature = 'narrative-sync-v1' | 'project-assets-v1' | 'compact-sync-v2'
export interface SyncInlineBlob { sha256: string; byteSize: number; base64: string }
export interface SyncBundle { format: 'ai-novel-sync'; version: 1; minimumReaderSchemaVersion?: 10 | 11 | 12; requiredFeatures?: SyncFeature[]; inlineBlobs?: SyncInlineBlob[]; compact?: CompactSnapshot; projectId: string; senderReplicaId: string; batches: SyncBatch[]; hash: string }
export interface SyncVariant { revision: string; batchId: string; replicaId: string; deleted: boolean; value: SyncJson | null }
export interface SyncConflict { kind: string; id: string; variants: SyncVariant[] }
export interface SyncResolution { kind: string; id: string; expectedHeads: string[]; selectedRevision: string }
export interface SyncPreview {
  token: string
  pendingBatches: number
  missingBatchHashes: string[]
  conflicts: SyncConflict[]
  changedRecords: number
  canApply: boolean
}
export interface SyncStatus {
  enabled: boolean
  projectId: string
  replicaId: string | null
  localBatches: number
  acknowledgedBatches: number
  pendingBatches: number
  conflicts: number
}
export interface SyncApplyResult { applied: boolean; appliedBatches: number; preview: SyncPreview; assetsPending?: boolean; assetsError?: string }
