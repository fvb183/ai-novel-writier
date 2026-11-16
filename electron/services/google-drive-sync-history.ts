import type { SyncBatch, SyncBundle } from '../../src/shared/project-sync'
import type { DriveFile } from './google-drive-client'
import { syncDigest, validateSyncBundle } from './project-sync-engine'

export const DRIVE_HISTORY_FILE_LIMIT = 16
export const DRIVE_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024

export function selectCloudBatches(source: SyncBundle, batches: SyncBatch[]): SyncBundle | undefined {
  if (!batches.length) return undefined
  const { hash: _hash, inlineBlobs: _inline, ...metadata } = source
  const body = { ...metadata, batches }
  return validateSyncBundle({ ...body, hash: syncDigest(body) })
}

/** Stable winner ordering prevents two collectors from removing each other's only copy. */
export function coveredCloudFiles(files: DriveFile[], coverage: Record<string, string[]>): DriveFile[] {
  const ordered = [...files].filter(file => coverage[file.id]?.length).sort((a, b) =>
    coverage[b.id].length - coverage[a.id].length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const retained: Set<string>[] = [], covered: DriveFile[] = []
  for (const file of ordered) {
    const hashes = coverage[file.id]
    if (retained.some(other => hashes.every(hash => other.has(hash)))) covered.push(file)
    else retained.push(new Set(hashes))
  }
  return covered
}
