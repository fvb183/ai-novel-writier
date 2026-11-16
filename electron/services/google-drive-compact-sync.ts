import type { SyncBundle, SyncFeature } from '../../src/shared/project-sync'
import type { CompactClock, CompactRecord } from '../../src/shared/project-sync-compact'
import { compareCompactClocks, mergeCompactClocks, mergeCompactRecords } from '../../src/shared/project-sync-compact'
import type { ProjectAssetBlob } from '../../src/shared/project-sync-assets'
import { parseProjectAuthorAsset, projectAssetBlobs } from '../../src/shared/project-sync-assets'
import { syncDigest, validateSyncBundle } from './project-sync-engine'
import { legacyCompactRecords, makeCompactBundle } from './compact-project-sync-engine'
import type { CloudSyncEngine } from './google-drive-sync-service'
import type { GoogleDriveClient, DriveFile } from './google-drive-client'
import { GoogleDriveStateStore, type DriveBinding } from './google-drive-state'
import { ProjectAssetBlobStore } from './project-asset-blob-store'
import { hydrateBundleAssets, referencedProjectAssetBlobs } from './project-sync-asset-transfer'

export interface CompactCloudHead { revision: string; clock: CompactClock; deleted: boolean; assets?: ProjectAssetBlob[] }
export interface CompactCloudRecord { kind: string; id: string; heads: CompactCloudHead[] }
export interface CompactCloudSummary { mode: 'snapshot' | 'delta'; clock: CompactClock; records: CompactCloudRecord[]; legacy?: boolean; displayAssets?: ProjectAssetBlob[] }
export const COMPACT_HISTORY_FILE_LIMIT = 8
export const COMPACT_HISTORY_BYTES = 4 * 1024 * 1024
export const COMPACT_EXCHANGE_DEADLINE_MS = 10 * 60_000
const identity = (record: { kind: string; id: string }) => JSON.stringify([record.kind, record.id])
const fail = (code: string): never => { throw new Error(code) }
function parseCompactDriveBundle(bytes: Uint8Array): SyncBundle {
  try { return validateSyncBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
  catch (error) {
    if (/^SYNC_READER_(?:VERSION_UNSUPPORTED|FEATURE_REQUIRED|FEATURE_UNSUPPORTED)$/.test((error as Error).message)) throw error
    return fail('DRIVE_PACKAGE_INVALID')
  }
}

export function compactCloudSummary(bundle: SyncBundle): CompactCloudSummary {
  const compact = bundle.compact ?? fail('SYNC_COMPACT_REQUIRED')
  return { mode: compact.mode, clock: compact.clock,
    ...(compact.accepted ? { displayAssets: compact.accepted.filter(record => record.kind === 'project-asset')
      .flatMap(record => record.heads.filter(head => !head.deleted).flatMap(head => projectAssetBlobs(parseProjectAuthorAsset(head.value)))) } : {}),
    records: compact.records.map(record => ({ kind: record.kind, id: record.id,
    heads: record.heads.map(head => ({ revision: head.revision, clock: head.clock, deleted: head.deleted,
      ...(record.kind === 'project-asset' && !head.deleted ? { assets: projectAssetBlobs(parseProjectAuthorAsset(head.value)) } : {}) })) })) }
}
export function compactSummaryCovers(keeper: CompactCloudSummary, target: CompactCloudSummary): boolean {
  const index = new Map(keeper.records.map(record => [identity(record), record]))
  return target.records.every(record => record.heads.every(head => index.get(identity(record))?.heads.some(other => {
    const comparison = compareCompactClocks(head.clock, other.clock)
    return comparison === 'before' || comparison === 'equal' && head.revision === other.revision
  })))
}
export function coveredCompactCloudFiles(files: DriveFile[], summaries: Record<string, CompactCloudSummary>): DriveFile[] {
  return files.filter(file => summaries[file.id] && files.some(other => other.id !== file.id && summaries[other.id]
    && (!summaries[other.id]!.legacy || !!summaries[file.id]!.legacy)
    && compactSummaryCovers(summaries[other.id]!, summaries[file.id]!)
    && (summaries[file.id]!.legacy && !summaries[other.id]!.legacy
      || !compactSummaryCovers(summaries[file.id]!, summaries[other.id]!) || other.id < file.id)))
}
export function compactBundleFromRecords(source: Pick<SyncBundle, 'projectId' | 'senderReplicaId'> & Partial<Pick<SyncBundle, 'compact'>>,
  records: CompactRecord[], mode: 'snapshot' | 'delta' = 'snapshot', clock: CompactClock = {}, accepted?: CompactRecord[]): SyncBundle {
  const features: SyncFeature[] = ['compact-sync-v2']
  if (records.some(record => record.kind === 'project-asset')) features.push('project-assets-v1')
  if (records.some(record => record.kind === 'narrative-plan')) features.push('narrative-sync-v1')
  const body = { format: 'ai-novel-sync' as const, version: 1 as const, projectId: source.projectId, senderReplicaId: source.senderReplicaId,
    minimumReaderSchemaVersion: 12 as const, requiredFeatures: features, batches: [],
    compact: { protocol: 2 as const, mode, clock: mergeCompactClocks(clock, ...records.flatMap(record => record.heads.map(head => head.clock))), records,
      ...(mode === 'snapshot' && records.some(record => record.heads.length > 1) && (accepted ?? source.compact?.accepted)
        ? { accepted: accepted ?? source.compact!.accepted } : {}) } }
  return validateSyncBundle({ ...body, hash: syncDigest(body) })
}
export function compactCloudAssetReferences(summaries: readonly CompactCloudSummary[]): ProjectAssetBlob[] {
  // Merge metadata using the same per-record order; an old asset cannot remain
  // live merely because an obsolete immutable packet is awaiting collection.
  const records = mergeCompactRecords(...summaries.map(summary => summary.records.map(record => ({ ...record,
    heads: record.heads.map(head => ({ ...head, value: null })) }))))
  const surviving = new Set(records.flatMap(record => record.heads.map(head => head.revision)))
  const references = new Map<string, ProjectAssetBlob>()
  for (const summary of summaries) for (const record of summary.records) for (const head of record.heads) {
    if (!surviving.has(head.revision)) continue
    for (const blob of head.assets ?? []) {
      const prior = references.get(blob.sha256)
      if (prior && prior.byteSize !== blob.byteSize) fail('PROJECT_SYNC_ASSET_INVALID')
      references.set(blob.sha256, blob)
    }
  }
  for (const summary of summaries) for (const blob of summary.displayAssets ?? []) references.set(blob.sha256, blob)
  return [...references.values()]
}

export async function downloadCompactDriveProject(client: GoogleDriveClient, folderId: string, projectId: string,
  check: () => void, retry = 0): Promise<{ bundle: SyncBundle; files: DriveFile[]; cursor: string; received: Record<string, string>; cloudCompact: Record<string, CompactCloudSummary>; cloudBatches?: Record<string, string[]> }> {
  const discovered = await client.discover(folderId, projectId, []); check()
  const packets: Array<{ file: DriveFile; bundle: SyncBundle }> = [], received: Record<string, string> = {}
  let total = 0
  for (const file of discovered.files) {
    let bytes: Uint8Array
    try { bytes = await client.download(file, folderId, projectId); check() }
    catch (error) {
      check()
      if ((error as Error).message === 'DRIVE_FILE_NOT_FOUND' && retry < 2) return downloadCompactDriveProject(client, folderId, projectId, check, retry + 1)
      throw error
    }
    total += bytes.byteLength
    if (total > 512 * 1024 * 1024) fail('DRIVE_JOIN_TOO_LARGE')
    const bundle = parseCompactDriveBundle(bytes)
    if (bundle.projectId !== projectId) fail('DRIVE_PROJECT_MISMATCH')
    packets.push({ file, bundle }); received[file.id] = file.appProperties!.ainwDigest
  }
  if (!packets.length) fail('DRIVE_PROJECT_EMPTY')
  if (packets.every(packet => !packet.bundle.compact)) {
    const batches = new Map(packets.flatMap(packet => packet.bundle.batches).map(batch => [batch.hash, batch]))
    const first = packets[0]!.bundle, features = [...new Set(packets.flatMap(packet => packet.bundle.requiredFeatures ?? []))]
    const minimum = Math.max(...packets.map(packet => packet.bundle.minimumReaderSchemaVersion ?? 0))
    const body = { format: 'ai-novel-sync' as const, version: 1 as const, projectId, senderReplicaId: first.senderReplicaId,
      batches: [...batches.values()], ...(features.length ? { requiredFeatures: features } : {}), ...(minimum ? { minimumReaderSchemaVersion: minimum as 10 | 11 } : {}) }
    const bundle = validateSyncBundle({ ...body, hash: syncDigest(body) })
    return { bundle, files: discovered.files, cursor: discovered.cursor, received, cloudCompact: {},
      cloudBatches: Object.fromEntries(packets.map(packet => [packet.file.id, packet.bundle.batches.map(batch => batch.hash)])) }
  }
  const cloudCompact: Record<string, CompactCloudSummary> = {}, snapshots: SyncBundle[] = []
  const legacy = packets.filter(packet => !packet.bundle.compact)
  if (legacy.length) {
    const batches = new Map(legacy.flatMap(packet => packet.bundle.batches).map(batch => [batch.hash, batch]))
    const converted = legacyCompactRecords([...batches.values()])
    const bundle = makeCompactBundle(projectId, legacy[0]!.bundle.senderReplicaId, { protocol: 2, mode: 'snapshot', ...converted })
    snapshots.push(bundle)
    for (const packet of legacy) cloudCompact[packet.file.id] = { ...compactCloudSummary(bundle), legacy: true }
  }
  for (const packet of packets.filter(packet => packet.bundle.compact)) {
    snapshots.push(packet.bundle); cloudCompact[packet.file.id] = compactCloudSummary(packet.bundle)
  }
  const records = mergeCompactRecords(...snapshots.map(bundle => bundle.compact!.records))
  const clock = mergeCompactClocks(...snapshots.map(bundle => bundle.compact!.clock))
  const accepted = snapshots.find(snapshot => snapshot.compact?.accepted)?.compact?.accepted
  const bundle = compactBundleFromRecords({ projectId, senderReplicaId: packets[0]!.bundle.senderReplicaId }, records, 'snapshot', clock, accepted)
  return { bundle, files: discovered.files, cursor: discovered.cursor, received, cloudCompact }
}

type Dependencies = {
  client: GoogleDriveClient; state: GoogleDriveStateStore; engine: CloudSyncEngine; binding: DriveBinding; key: string
  store?: ProjectAssetBlobStore; check(): void
  publish(bundle: SyncBundle): Promise<{ file: DriveFile; uploaded: boolean }>
  publishAssets(bundle: SyncBundle, fresh: ReadonlySet<string>): Promise<void>
  collectAssets?(live: ProjectAssetBlob[], check: () => void, confirmedSnapshotHash: string): Promise<void>
}

/** Current values and unresolved heads, rather than an ever-growing revision
 * chain. Immutable packets are still used so parallel writers never overwrite. */
export class GoogleDriveCompactSync {
  private started = Date.now()
  private check = () => {
    this.deps.check()
    // A WebView may suspend timers. Wall-clock validation is required after
    // every await, before publication and before removing an object.
    if (Date.now() - this.started >= COMPACT_EXCHANGE_DEADLINE_MS) fail('DRIVE_SYNC_TIMEOUT')
  }
  constructor(private deps: Dependencies) {}

  async exchange(retry = 0): Promise<{ success: true; uploaded: boolean; downloaded: number; status: ReturnType<CloudSyncEngine['status']>; preview: ReturnType<CloudSyncEngine['preview']> }> {
    const { client, state, engine, binding, key, store } = this.deps
    this.check()
    const discovered = await client.discover(binding.folderId, binding.projectId, retry ? [] : binding.files, retry ? undefined : binding.cursor); this.check()
    const files = [...discovered.files], liveIds = new Set(files.map(file => file.id))
    const summaries: Record<string, CompactCloudSummary> = Object.fromEntries(Object.entries(binding.cloudCompact ?? {}).filter(([id]) => liveIds.has(id)))
    const received = Object.fromEntries(Object.entries(binding.received).filter(([id]) => liveIds.has(id)))
    const legacy: Array<{ file: DriveFile; bundle: SyncBundle }> = []
    const durableLocal = compactCloudSummary(engine.exportCompactBundle!(undefined, true)!)
    let downloaded = 0, uploaded = false
    for (const file of files) {
      const prior = binding.files.find(old => old.id === file.id)
      if (summaries[file.id] && compactSummaryCovers(durableLocal, summaries[file.id]!)
        && received[file.id] === file.appProperties!.ainwDigest && prior?.md5Checksum === file.md5Checksum && prior?.size === file.size) continue
      let bundle: SyncBundle
      try { bundle = parseCompactDriveBundle(await client.download(file, binding.folderId, binding.projectId)) }
      catch (error) {
        this.check()
        if ((error as Error).message === 'DRIVE_FILE_NOT_FOUND' && retry < 2) return this.exchange(retry + 1)
        throw error
      }
      this.check()
      if (bundle.projectId !== binding.projectId) fail('DRIVE_PROJECT_MISMATCH')
      if (!bundle.compact) { legacy.push({ file, bundle }); continue }
      if (referencedProjectAssetBlobs(bundle).length) {
        if (!store) fail('PROJECT_SYNC_ASSET_STORE_REQUIRED')
        await hydrateBundleAssets(client, bundle, binding.folderId, store!, this.check); this.check()
      }
      engine.receive(bundle); this.check()
      summaries[file.id] = compactCloudSummary(bundle); received[file.id] = file.appProperties!.ainwDigest; downloaded++
    }
    if (legacy.length) {
      // Legacy delta packets can be incomplete individually. Convert their
      // complete observed union once, then drop superseded payloads immediately.
      const batches = new Map(legacy.flatMap(item => item.bundle.batches).map(batch => [batch.hash, batch]))
      const first = legacy[0]!.bundle, features = [...new Set(legacy.flatMap(item => item.bundle.requiredFeatures ?? []))]
      const minimum = Math.max(...legacy.map(item => item.bundle.minimumReaderSchemaVersion ?? 0))
      const body = { format: 'ai-novel-sync' as const, version: 1 as const, projectId: binding.projectId, senderReplicaId: first.senderReplicaId,
        batches: [...batches.values()], ...(features.length ? { requiredFeatures: features } : {}), ...(minimum ? { minimumReaderSchemaVersion: minimum as 10 | 11 } : {}) }
      const checkedLegacy = validateSyncBundle({ ...body, hash: syncDigest(body) })
      const converted = legacyCompactRecords(checkedLegacy.batches)
      const combined = makeCompactBundle(binding.projectId, first.senderReplicaId, { protocol: 2, mode: 'snapshot', ...converted })
      if (referencedProjectAssetBlobs(combined).length) {
        if (!store) fail('PROJECT_SYNC_ASSET_STORE_REQUIRED')
        await hydrateBundleAssets(client, combined, binding.folderId, store!, this.check); this.check()
      }
      engine.receive(combined); this.check()
      // The union summary is a conservative coverage requirement for each old
      // file. Only a verified compact replacement may delete legacy objects.
      for (const item of legacy) { summaries[item.file.id] = { ...compactCloudSummary(combined), legacy: true }; received[item.file.id] = item.file.appProperties!.ainwDigest; downloaded++ }
    }
    const observedReferences = compactCloudAssetReferences(Object.values(summaries))
    const source = engine.exportCompactBundle!()!
    const cloudHeads = new Map<string, CompactCloudHead[]>()
    for (const summary of Object.values(summaries)) for (const record of summary.records) cloudHeads.set(identity(record), [...(cloudHeads.get(identity(record)) ?? []), ...record.heads])
    const records = source.compact!.records.map(record => ({ ...record, heads: record.heads.filter(head => !cloudHeads.get(identity(record))?.some(other => {
      const comparison = compareCompactClocks(head.clock, other.clock)
      if (comparison === 'equal' && head.revision !== other.revision) fail('SYNC_COMPACT_EQUIVOCATION')
      return comparison === 'before' || comparison === 'equal'
    })) })).filter(record => record.heads.length)
    if (records.length) {
      const delta = compactBundleFromRecords(source, records, Object.keys(summaries).length ? 'delta' : 'snapshot', source.compact!.clock)
      const known = new Set(observedReferences.map(blob => blob.sha256))
      const fresh = new Set(referencedProjectAssetBlobs(delta).filter(blob => !known.has(blob.sha256)).map(blob => blob.sha256))
      await this.deps.publishAssets(delta, fresh); this.check()
      const publication = await this.deps.publish(delta); this.check()
      if (delta.compact!.mode === 'snapshot') {
        const verified = parseCompactDriveBundle(await client.download(publication.file, binding.folderId, binding.projectId))
        this.check(); if (verified.hash !== delta.hash) fail('DRIVE_HISTORY_CHECKPOINT_INVALID')
      }
      files.push(publication.file); summaries[publication.file.id] = compactCloudSummary(delta)
      received[publication.file.id] = publication.file.appProperties!.ainwDigest; uploaded ||= publication.uploaded
    }
    // Commit successful transfer before best-effort collection. Cleanup errors
    // must never prevent the author from applying already received new content.
    const persist = (warning?: string) => state.update(value => {
      const current = value.bindings[key]
      if (!current || current.folderId !== binding.folderId || current.accountId !== binding.accountId) fail('DRIVE_BINDING_CHANGED')
      current.files = [...new Map(files.map(file => [file.id, file])).values()]
      current.cursor = discovered.cursor; current.received = { ...received }; current.cloudCompact = { ...summaries }; current.cloudBatches = {}
      current.assetReferences = compactCloudAssetReferences(Object.values(summaries)); current.assetPolicyVersion = 1
      current.lastTransferredAt = new Date().toISOString(); current.lastUploadedHash = source.hash
      if (warning) current.historyCleanupError = warning; else delete current.historyCleanupError
      for (const [hash, id] of Object.entries(current.uploads)) if (!hash.startsWith('asset:') && binding.files.some(old => old.id === id) && !files.some(file => file.id === id)) {
        delete current.uploads[hash]; if (current.uploadSessions) delete current.uploadSessions[hash]
      }
    })
    persist(binding.historyCleanupError)
    let warning: string | undefined
    try {
      let covered = coveredCompactCloudFiles(files, summaries)
      const remaining = files.filter(file => !covered.some(old => old.id === file.id))
      let confirmedSnapshotHash = files.find(file => summaries[file.id]?.mode === 'snapshot')?.appProperties?.ainwDigest
      const sizes = remaining.map(file => Number(file.size ?? 0))
      const incrementalBytes = sizes.reduce((sum, size) => sum + size, 0) - Math.max(0, ...sizes)
      if (!confirmedSnapshotHash || legacy.length || remaining.length >= COMPACT_HISTORY_FILE_LIMIT || remaining.length > 1 && incrementalBytes >= COMPACT_HISTORY_BYTES) {
        const all = engine.exportCompactBundle!(undefined, true)!
        const snapshot = compactBundleFromRecords(all, all.compact!.records, 'snapshot', all.compact!.clock)
        const confirmedReferences = compactCloudAssetReferences(Object.values(summaries))
        await this.deps.publishAssets(snapshot, new Set(referencedProjectAssetBlobs(snapshot).filter(blob => !confirmedReferences.some(known => known.sha256 === blob.sha256)).map(blob => blob.sha256))); this.check()
        const publication = await this.deps.publish(snapshot); this.check()
        const verified = parseCompactDriveBundle(await client.download(publication.file, binding.folderId, binding.projectId)); this.check()
        if (verified.hash !== snapshot.hash || !verified.compact) fail('DRIVE_HISTORY_CHECKPOINT_INVALID')
        confirmedSnapshotHash = publication.file.appProperties!.ainwDigest
        const replacement = compactCloudSummary(verified)
        if (!files.every(file => summaries[file.id] && compactSummaryCovers(replacement, summaries[file.id]!))) fail('DRIVE_HISTORY_CHECKPOINT_INVALID')
        if (!files.some(file => file.id === publication.file.id)) files.push(publication.file)
        summaries[publication.file.id] = replacement; received[publication.file.id] = publication.file.appProperties!.ainwDigest
        covered = coveredCompactCloudFiles(files, summaries)
      }
      for (const file of covered) {
        this.check(); await client.deleteSyncFile(binding.folderId, binding.projectId, file); this.check()
        const index = files.findIndex(other => other.id === file.id); if (index >= 0) files.splice(index, 1)
        delete summaries[file.id]; delete received[file.id]
      }
      // This hook must rediscover cloud heads and recheck fixed old object IDs,
      // rather than relying on the local references cached before publication.
      if (confirmedSnapshotHash) await this.deps.collectAssets?.(compactCloudAssetReferences(Object.values(summaries)), this.check, confirmedSnapshotHash)
      this.check()
    } catch (error) {
      this.check()
      const code = (error as Error).message
      if (/^(GOOGLE_AUTH_|DRIVE_ACCOUNT_|DRIVE_CANCELLED|SYNC_SESSION_)/.test(code)) throw error
      warning = /^(?:DRIVE|SYNC|PROJECT_SYNC)_[A-Z0-9_]+$/.test(code) ? code : 'DRIVE_HISTORY_CLEANUP_FAILED'
    }
    persist(warning)
    return { success: true, uploaded, downloaded, status: engine.status(), preview: engine.preview() }
  }
}
