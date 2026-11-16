import { createHash } from 'node:crypto'
import type { SyncBundle, SyncJson } from '../../src/shared/project-sync'
import { parseProjectAuthorAsset, projectAssetBlobs, type ProjectAssetBlob } from '../../src/shared/project-sync-assets'

function fail(code: string): never { throw new Error(`PROJECT_SYNC_ASSET_${code}`) }
type AssetRecordSource = { kind: string; heads: readonly { deleted: boolean; value: SyncJson | null }[] }
type AssetReferenceBundle = Pick<SyncBundle, 'batches'> & { compact?: { records: readonly AssetRecordSource[]; accepted?: readonly AssetRecordSource[] } }
/** Compact packets carry current/concurrent heads; legacy packets carry batches. */
export function* bundleProjectAssetValues(bundle: AssetReferenceBundle): Iterable<SyncJson> {
  for (const batch of bundle.batches) for (const change of batch.changes) {
    if (change.kind === 'project-asset' && !change.deleted && change.value !== null) yield change.value
  }
  for (const record of [...(bundle.compact?.records ?? []), ...(bundle.compact?.accepted ?? [])]) if (record.kind === 'project-asset') {
    for (const head of record.heads) if (!head.deleted && head.value !== null) yield head.value
  }
}
/** Includes every unresolved alternative, never only the currently selected asset. */
export function referencedProjectAssetBlobs(bundle: AssetReferenceBundle): ProjectAssetBlob[] {
  const references = new Map<string, ProjectAssetBlob>()
  for (const value of bundleProjectAssetValues(bundle)) {
    for (const blob of projectAssetBlobs(parseProjectAuthorAsset(value))) {
      const existing = references.get(blob.sha256)
      if (existing && existing.byteSize !== blob.byteSize) fail('INVALID')
      if (!existing) references.set(blob.sha256, blob)
    }
  }
  return [...references.values()].sort((a, b) => a.sha256.localeCompare(b.sha256))
}
/** Syntactic and byte integrity checks complete before a caller opens CAS writers. */
export function validateInlineProjectAssetBlobs(bundle: SyncBundle): void {
  if (bundle.inlineBlobs === undefined) return
  const references = referencedProjectAssetBlobs(bundle), wanted = new Map(references.map(blob => [blob.sha256, blob]))
  if (!Array.isArray(bundle.inlineBlobs) || !references.length || bundle.inlineBlobs.length !== references.length) fail('INLINE_INCOMPLETE')
  const seen = new Set<string>()
  for (const inline of bundle.inlineBlobs) {
    if (!inline || typeof inline !== 'object' || Array.isArray(inline) || Object.keys(inline).sort().join(',') !== 'base64,byteSize,sha256'
      || typeof inline.sha256 !== 'string' || seen.has(inline.sha256) || typeof inline.base64 !== 'string'
      || !Number.isSafeInteger(inline.byteSize) || inline.byteSize < 0) fail('INLINE_INVALID')
    const reference = wanted.get(inline.sha256)
    if (!reference || reference.byteSize !== inline.byteSize) fail('INLINE_INCOMPLETE')
    const encodedLength = 4 * Math.ceil(inline.byteSize / 3)
    if (inline.base64.length !== encodedLength || /[^A-Za-z0-9+/=]/.test(inline.base64)) fail('INLINE_INVALID')
    const bytes = Buffer.from(inline.base64, 'base64')
    if (bytes.byteLength !== inline.byteSize || bytes.toString('base64') !== inline.base64 || createHash('sha256').update(bytes).digest('hex') !== inline.sha256) fail('HASH_MISMATCH')
    seen.add(inline.sha256)
  }
}
