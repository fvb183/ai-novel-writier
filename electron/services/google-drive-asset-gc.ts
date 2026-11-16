import { parseProjectAssetBlob, type ProjectAssetBlob } from '../../src/shared/project-sync-assets'
import type { DriveFile, GoogleDriveClient } from './google-drive-client'

export const DRIVE_ASSET_GC_GRACE_MS = 24 * 60 * 60_000
export interface DriveAssetGarbageCandidate {
  digest: string
  size: string
  md5: string
  firstUnreferencedAt: number
  observations: number
}
export type DriveAssetGarbageState = Record<string, DriveAssetGarbageCandidate>
export function validDriveAssetGarbageState(value: unknown): value is DriveAssetGarbageState {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100_000) return false
  return Object.entries(value).every(([id, entry]) => {
    const candidate = entry as DriveAssetGarbageCandidate
    return /^[A-Za-z0-9_-]{1,200}$/.test(id) && !!candidate && typeof candidate === 'object'
      && typeof candidate.digest === 'string' && /^[a-f0-9]{64}$/.test(candidate.digest)
      && typeof candidate.size === 'string' && /^(?:0|[1-9][0-9]*)$/.test(candidate.size)
      && Number.isSafeInteger(Number(candidate.size)) && Number(candidate.size) <= 2 * 1024 ** 3
      && typeof candidate.md5 === 'string' && /^[a-f0-9]{32}$/.test(candidate.md5) && Number.isSafeInteger(candidate.firstUnreferencedAt)
      && candidate.firstUnreferencedAt >= 0 && Number.isSafeInteger(candidate.observations) && candidate.observations >= 1 && candidate.observations <= 2
  })
}
const hashes = (references: readonly ProjectAssetBlob[]) => new Set(references.map(reference => parseProjectAssetBlob(reference).sha256))
function eligible(file: DriveFile): file is DriveFile & { size: string; md5Checksum: string } {
  return typeof file.size === 'string' && /^(?:0|[1-9][0-9]*)$/.test(file.size)
    && typeof file.md5Checksum === 'string' && /^[a-f0-9]{32}$/.test(file.md5Checksum)
    && /^[a-f0-9]{64}$/.test(file.appProperties?.ainwDigest ?? '')
}
function protectedIds(files: DriveFile[], live: ReadonlySet<string>): Set<string> {
  const groups = new Map<string, DriveFile[]>()
  for (const file of files) {
    const digest = file.appProperties?.ainwDigest
    if (digest && live.has(digest)) groups.set(digest, [...(groups.get(digest) ?? []), file])
  }
  const protectedFiles = new Set<string>()
  for (const group of groups.values()) {
    // A stable minimum ID gives concurrent collectors the same keeper. Do not
    // deduplicate a group whose byte metadata disagrees or is incomplete.
    if (group.some(file => !eligible(file) || file.size !== group[0]!.size || file.md5Checksum !== group[0]!.md5Checksum)) {
      group.forEach(file => protectedFiles.add(file.id)); continue
    }
    protectedFiles.add(group.map(file => file.id).sort()[0]!)
  }
  return protectedFiles
}

/** Runs only after a compact snapshot was uploaded and read back successfully.
 * Every writer must publish fresh immutable asset IDs for hashes absent from
 * its observed live heads. Thus a concurrent/long-offline writer never relies
 * on an old object ID eligible for this collector's delayed sweep. */
export async function collectDriveAssetGarbage(input: {
  client: GoogleDriveClient
  folderId: string
  projectId: string
  confirmedSnapshotHash: string
  currentReferences: readonly ProjectAssetBlob[]
  previous: DriveAssetGarbageState
  /** Refresh the merged committed heads before deleting any previously marked ID. */
  refreshLiveReferences(): Promise<readonly ProjectAssetBlob[]>
  revalidate(): void
  now?: number
  graceMs?: number
  maximumDeletes?: number
}): Promise<{ candidates: DriveAssetGarbageState; deleted: string[]; reclaimedBytes: number }> {
  if (!/^[a-f0-9]{64}$/.test(input.confirmedSnapshotHash) || !validDriveAssetGarbageState(input.previous)) throw new Error('DRIVE_ASSET_GC_STATE_INVALID')
  const now = input.now ?? Date.now(), grace = input.graceMs ?? DRIVE_ASSET_GC_GRACE_MS, maximumDeletes = input.maximumDeletes ?? 32
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(grace) || grace < 0
    || !Number.isSafeInteger(maximumDeletes) || maximumDeletes < 1 || maximumDeletes > 1000) throw new Error('DRIVE_ASSET_GC_STATE_INVALID')
  input.revalidate()
  const files = await input.client.listObjects(input.folderId, input.projectId, 'asset'); input.revalidate()
  const keep = protectedIds(files, hashes(input.currentReferences)), candidates: DriveAssetGarbageState = {}
  const ready: DriveFile[] = []
  for (const file of files) {
    if (keep.has(file.id) || !eligible(file)) continue
    const old = input.previous[file.id], digest = file.appProperties!.ainwDigest
    const same = old?.digest === digest && old.size === file.size && old.md5 === file.md5Checksum && old.firstUnreferencedAt <= now
    candidates[file.id] = { digest, size: file.size, md5: file.md5Checksum,
      firstUnreferencedAt: same ? old.firstUnreferencedAt : now, observations: same ? Math.min(2, old.observations + 1) : 1 }
    if (same && candidates[file.id]!.observations >= 2 && now - old.firstUnreferencedAt >= grace) ready.push(file)
  }
  const deleted: string[] = []; let reclaimedBytes = 0
  if (ready.length) {
    const refreshed = hashes(await input.refreshLiveReferences()); input.revalidate()
    const liveKeep = protectedIds(files, refreshed)
    for (const file of ready.slice(0, maximumDeletes)) {
      if (liveKeep.has(file.id)) { delete candidates[file.id]; continue }
      input.revalidate(); await input.client.deleteAssetFile(input.folderId, input.projectId, file); input.revalidate()
      deleted.push(file.id); reclaimedBytes += Number(file.size); delete candidates[file.id]
    }
  }
  return { candidates, deleted, reclaimedBytes }
}
