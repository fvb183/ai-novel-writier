import type { SyncBundle, SyncInlineBlob } from '../../src/shared/project-sync'
import { parseProjectAssetBlob, parseProjectAuthorAsset, type ProjectAssetBlob } from '../../src/shared/project-sync-assets'
import { syncDigest, validateSyncBundle } from './project-sync-engine'
import { ProjectAssetBlobStore } from './project-asset-blob-store'
import { bundleProjectAssetValues, referencedProjectAssetBlobs, validateInlineProjectAssetBlobs } from './project-sync-asset-manifest'
import { GoogleDriveClient, type DriveFile } from './google-drive-client'
import { assertProjectAuthorFileBytes, isAuthorCheckpointPath } from './project-asset-author-projection'
export { referencedProjectAssetBlobs } from './project-sync-asset-manifest'

const MAX_PACKAGE = 64 * 1024 * 1024, CHUNK = 4 * 1024 * 1024
function fail(code: string): never { throw new Error(`PROJECT_SYNC_ASSET_${code}`) }
function body(bundle: SyncBundle) {
  return { format: bundle.format, version: bundle.version, projectId: bundle.projectId, senderReplicaId: bundle.senderReplicaId, batches: bundle.batches,
    ...(bundle.minimumReaderSchemaVersion === undefined ? {} : { minimumReaderSchemaVersion: bundle.minimumReaderSchemaVersion }),
    ...('compact' in bundle ? { compact: bundle.compact } : {}),
    ...(bundle.requiredFeatures === undefined ? {} : { requiredFeatures: bundle.requiredFeatures }) }
}
/** Check every immutable candidate, including revisions that are no longer selected. */
export function assertBundleAuthorAssetBytes(bundle: SyncBundle, read: (blob: ProjectAssetBlob) => Buffer, revalidate: () => void): void {
  const checked = new Set<string>()
  for (const value of bundleProjectAssetValues(bundle)) {
    const asset = parseProjectAuthorAsset(value)
    if (asset.category !== 'files') continue
    for (const file of asset.files) {
      if (!isAuthorCheckpointPath(file.path) || checked.has(file.blob.sha256)) continue
      revalidate(); const bytes = read(file.blob); revalidate()
      assertProjectAuthorFileBytes(file.path, bytes); revalidate()
      checked.add(file.blob.sha256)
    }
  }
}
/** A local exchange file is self-contained. The existing 64 MiB envelope cap includes base64. */
export function attachBundleAssets(input: SyncBundle, store: ProjectAssetBlobStore): SyncBundle {
  const bundle = validateSyncBundle(input), blobs = referencedProjectAssetBlobs(bundle)
  if (!blobs.length) return bundle
  const base = body(bundle)
  const skeleton = blobs.map(blob => ({ sha256: blob.sha256, byteSize: blob.byteSize, base64: '' }))
  const expectedSize = Buffer.byteLength(JSON.stringify({ ...base, inlineBlobs: skeleton, hash: '0'.repeat(64) })) + blobs.reduce((size, blob) => size + 4 * Math.ceil(blob.byteSize / 3), 0)
  if (expectedSize > MAX_PACKAGE) throw new Error('SYNC_PACKAGE_TOO_LARGE')
  const inlineBlobs: SyncInlineBlob[] = blobs.map(blob => ({ sha256: blob.sha256, byteSize: blob.byteSize, base64: store.read(blob, MAX_PACKAGE).toString('base64') }))
  const payload = { ...base, inlineBlobs }, result = { ...payload, hash: syncDigest(payload) }
  return validateSyncBundle(result)
}
/** Validate all bytes first. Any verified CAS orphan left by a later failure is inert. */
export function stageBundleAssets(input: SyncBundle, store: ProjectAssetBlobStore, revalidate: () => void = () => {}): void {
  const bundle = validateSyncBundle(input), blobs = referencedProjectAssetBlobs(bundle)
  if (!blobs.length) return
  if (bundle.inlineBlobs === undefined) fail('INLINE_INCOMPLETE')
  validateInlineProjectAssetBlobs(bundle)
  const bytesByHash = new Map(bundle.inlineBlobs.map(inline => [inline.sha256, inline]))
  assertBundleAuthorAssetBytes(bundle, blob => Buffer.from(bytesByHash.get(blob.sha256)!.base64, 'base64'), revalidate)
  revalidate()
  for (const blob of blobs) {
    revalidate()
    if (store.has(blob)) continue
    const bytes = Buffer.from(bytesByHash.get(blob.sha256)!.base64, 'base64'), writer = store.createWriter(blob)
    try {
      for (let offset = 0; offset < bytes.length; offset += CHUNK) { revalidate(); writer.write(bytes.subarray(offset, offset + CHUNK)) }
      writer.complete(revalidate)
    } catch (error) { writer.abort(); throw error }
  }
  revalidate()
}

/** Derived package-reference caches contain only bounded descriptors, never bytes or paths. */
export async function hydrateProjectAssetReferences(client: GoogleDriveClient, projectId: string, references: readonly ProjectAssetBlob[], folderId: string,
  store: ProjectAssetBlobStore, revalidate: () => void, verifyExisting = true): Promise<void> {
  const blobs = references.map(parseProjectAssetBlob), missing: ProjectAssetBlob[] = []
  const sizes = new Map<string, number>()
  for (const blob of blobs) {
    if (sizes.has(blob.sha256) && sizes.get(blob.sha256) !== blob.byteSize) fail('INVALID')
    if (!sizes.has(blob.sha256)) { revalidate(); if (!(verifyExisting ? store.has(blob) : store.contains(blob))) missing.push(blob) }
    sizes.set(blob.sha256, blob.byteSize)
  }
  if (!missing.length) return
  const index = (files: DriveFile[]) => {
    const grouped = new Map<string, DriveFile[]>()
    for (const file of files) { const hash = file.appProperties?.ainwDigest ?? ''; grouped.set(hash, [...(grouped.get(hash) ?? []), file]) }
    for (const candidates of grouped.values()) candidates.sort((left, right) =>
      (Date.parse(right.createdTime ?? '') || 0) - (Date.parse(left.createdTime ?? '') || 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    return grouped
  }
  let byHash = index(await client.listObjects(folderId, projectId, 'asset')), relisted = false; revalidate()
  for (const blob of missing) {
    let hydrated = false
    while (!hydrated) {
      revalidate()
      const candidates = byHash.get(blob.sha256) ?? []
      if (candidates.some(file => Number(file.size) !== blob.byteSize || file.md5Checksum !== candidates[0]!.md5Checksum)) fail('HASH_MISMATCH')
      for (const file of candidates) {
        const writer = store.createWriter(blob)
        try {
          await client.downloadObject(file, folderId, projectId, 'asset', { sha256: blob.sha256, byteSize: blob.byteSize }, bytes => {
            revalidate()
            for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) writer.write(bytes.subarray(offset, offset + CHUNK))
            revalidate()
          })
          revalidate(); writer.complete(revalidate); hydrated = true; break
        } catch (error) {
          writer.abort()
          if (!(error instanceof Error) || error.message !== 'DRIVE_FILE_NOT_FOUND') throw error
        }
      }
      if (hydrated) break
      if (relisted) fail('BLOB_MISSING')
      byHash = index(await client.listObjects(folderId, projectId, 'asset')); relisted = true; revalidate()
    }
  }
  revalidate()
}
/** Join callers supply their private staging CAS; this function never touches a ledger. */
export async function hydrateBundleAssets(client: GoogleDriveClient, input: SyncBundle, folderId: string, store: ProjectAssetBlobStore, revalidate: () => void): Promise<void> {
  const bundle = validateSyncBundle(input)
  if (bundle.inlineBlobs !== undefined) stageBundleAssets(bundle, store, revalidate)
  await hydrateProjectAssetReferences(client, bundle.projectId, referencedProjectAssetBlobs(bundle), folderId, store, revalidate)
  assertBundleAuthorAssetBytes(bundle, blob => store.read(blob), revalidate)
  revalidate()
}
