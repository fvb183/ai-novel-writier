import { createHash, randomUUID } from 'node:crypto'
import { validateInlineProjectAssetBlobs } from './project-sync-asset-manifest'
import type Database from 'better-sqlite3'
import type { SyncApplyResult, SyncBatch, SyncBundle, SyncChange, SyncConflict, SyncFeature, SyncPreview, SyncRecord, SyncResolution, SyncStatus, SyncVariant } from '../../src/shared/project-sync'
import { validateCompactSnapshot } from '../../src/shared/project-sync-compact'

export interface SyncProjection {
  readonly immutableKinds?: readonly string[]
  /** New format metadata may be added in a normal batch without rewriting old batches. */
  readonly legacyExtensionKinds?: readonly string[]
  capture(database: Database.Database): SyncRecord[]
  validate(records: SyncRecord[]): void
  validateChanges?(changes: SyncChange[]): void
  validateHistory?(batches: readonly SyncBatch[]): void
  validateLegacyImport?(records: SyncRecord[]): void
  validateCandidate?(database: Database.Database, records: SyncRecord[]): void
  apply(database: Database.Database, records: SyncRecord[]): void
}
type StoredBatch = { batch_id: string; hash: string; payload_json: string; accepted: number }
type Revision = SyncVariant & { kind: string; id: string; parents: string[] }
type Graph = { heads: Map<string, Revision[]>; revisions: Map<string, Revision>; missing: string[] }
type MutationBaseline = { before: Map<string, SyncRecord>; graph: Graph }
const MAX_BYTES = 64 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const REVISION = /^[a-f0-9]{64}:\d+$/
const key = (kind: string, id: string) => JSON.stringify([kind, id])
function fail(code: string): never { throw new Error(code) }

/** Deterministic JSON, including recursive validation before hashing untrusted input. */
export function canonicalSyncJson(value: unknown, depth = 0): string {
  if (depth > 48) return fail('SYNC_INVALID_DOCUMENT')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : fail('SYNC_INVALID_DOCUMENT')
  if (Array.isArray(value)) return '[' + value.map(item => canonicalSyncJson(item, depth + 1)).join(',') + ']'
  if (typeof value !== 'object' || !value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('SYNC_INVALID_DOCUMENT')
  return '{' + Object.keys(value).sort().map(name => {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) return fail('SYNC_INVALID_DOCUMENT')
    return JSON.stringify(name) + ':' + canonicalSyncJson((value as Record<string, unknown>)[name], depth + 1)
  }).join(',') + '}'
}
export const syncDigest = (value: unknown): string => createHash('sha256').update(canonicalSyncJson(value)).digest('hex')
function strictKeys(value: object, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(',')) fail('SYNC_INVALID_DOCUMENT')
}
function checkIdentity(kind: unknown, id: unknown): void {
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9:_-]{0,95}$/.test(kind)
    || typeof id !== 'string' || !id.length || id.length > 512 || /[\u0000-\u001f]/.test(id)) fail('SYNC_INVALID_ENTITY')
}
function validateBatch(input: unknown, projectId: string): SyncBatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('SYNC_INVALID_BATCH')
  const batch = input as SyncBatch
  strictKeys(batch, ['protocol', 'projectId', 'replicaId', 'sequence', 'previousHash', 'batchId', 'changes', 'hash'])
  if (batch.protocol !== 1 || batch.projectId !== projectId || !UUID.test(batch.replicaId) || !UUID.test(batch.batchId)
    || !Number.isSafeInteger(batch.sequence) || batch.sequence < 1 || !HASH.test(batch.hash)
    || (batch.sequence === 1 ? batch.previousHash !== null : typeof batch.previousHash !== 'string' || !HASH.test(batch.previousHash))
    || !Array.isArray(batch.changes) || !batch.changes.length || batch.changes.length > 20_000) return fail('SYNC_INVALID_BATCH')
  const seen = new Set<string>()
  for (const change of batch.changes) {
    if (!change || typeof change !== 'object') fail('SYNC_INVALID_CHANGE')
    strictKeys(change, ['kind', 'id', 'parents', 'value', 'deleted'])
    checkIdentity(change.kind, change.id)
    const identity = key(change.kind, change.id)
    if (seen.has(identity) || typeof change.deleted !== 'boolean' || change.deleted && change.value !== null
      || !Array.isArray(change.parents) || change.parents.length > 256 || new Set(change.parents).size !== change.parents.length
      || change.parents.some(parent => typeof parent !== 'string' || !REVISION.test(parent))) fail('SYNC_INVALID_CHANGE')
    seen.add(identity)
  }
  const { hash, ...body } = batch
  if (hash !== syncDigest(body)) return fail('SYNC_BATCH_HASH_MISMATCH')
  return batch
}
export function validateSyncBundle(input: unknown): SyncBundle {
  const encoded = canonicalSyncJson(input)
  if (Buffer.byteLength(encoded) > MAX_BYTES) return fail('SYNC_PACKAGE_TOO_LARGE')
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('SYNC_INVALID_PACKAGE')
  const bundle = input as SyncBundle
  strictKeys(bundle, ['format', 'version', 'projectId', 'senderReplicaId', 'batches', 'hash',
    ...('minimumReaderSchemaVersion' in bundle ? ['minimumReaderSchemaVersion'] : []),
    ...('requiredFeatures' in bundle ? ['requiredFeatures'] : []), ...('inlineBlobs' in bundle ? ['inlineBlobs'] : []), ...('compact' in bundle ? ['compact'] : [])])
  if ('minimumReaderSchemaVersion' in bundle && bundle.minimumReaderSchemaVersion !== 10 && bundle.minimumReaderSchemaVersion !== 11 && bundle.minimumReaderSchemaVersion !== 12) fail('SYNC_READER_VERSION_UNSUPPORTED')
  if ('requiredFeatures' in bundle && (!Array.isArray(bundle.requiredFeatures) || !bundle.requiredFeatures.length
    || bundle.requiredFeatures.length > 3 || new Set(bundle.requiredFeatures).size !== bundle.requiredFeatures.length
    || bundle.requiredFeatures.some(feature => !['narrative-sync-v1', 'project-assets-v1', 'compact-sync-v2'].includes(feature)))) fail('SYNC_READER_FEATURE_UNSUPPORTED')
  if (bundle.format !== 'ai-novel-sync' || bundle.version !== 1 || !UUID.test(bundle.projectId)
    || !UUID.test(bundle.senderReplicaId) || !Array.isArray(bundle.batches) || !bundle.compact && !bundle.batches.length || bundle.batches.length > 20_000) return fail('SYNC_INVALID_PACKAGE')
  if (bundle.compact) {
    if (bundle.batches.length || bundle.minimumReaderSchemaVersion !== 12 || !bundle.requiredFeatures?.includes('compact-sync-v2')) fail('SYNC_READER_FEATURE_REQUIRED')
    validateCompactSnapshot(bundle.compact, syncDigest)
  } else if (bundle.requiredFeatures?.includes('compact-sync-v2')) fail('SYNC_COMPACT_INVALID')
  const ids = new Set<string>(), positions = new Set<string>()
  let requiresNarrative = false, requiresAssets = false
  for (const inputBatch of bundle.batches) {
    const batch = validateBatch(inputBatch, bundle.projectId), position = `${batch.replicaId}:${batch.sequence}`
    if (ids.has(batch.batchId) || positions.has(position)) fail('SYNC_DUPLICATE_BATCH')
    ids.add(batch.batchId); positions.add(position)
    requiresNarrative ||= batch.changes.some(change => change.kind === 'narrative-plan')
    requiresAssets ||= batch.changes.some(change => change.kind === 'project-asset')
  }
  if (requiresNarrative && !bundle.requiredFeatures?.includes('narrative-sync-v1')) fail('SYNC_READER_FEATURE_REQUIRED')
  if (requiresAssets && (!bundle.requiredFeatures?.includes('project-assets-v1') || bundle.minimumReaderSchemaVersion !== 11)) fail('SYNC_READER_FEATURE_REQUIRED')
  validateInlineProjectAssetBlobs(bundle)
  const { hash, ...body } = bundle
  if (!HASH.test(hash) || hash !== syncDigest(body)) return fail('SYNC_PACKAGE_HASH_MISMATCH')
  return bundle
}

/** Rebuild the causal graph; timestamps and arrival order never select a winner. */
function buildGraph(batches: SyncBatch[]): Graph {
  const revisions = new Map<string, Revision>(), heads = new Map<string, Revision[]>()
  const known = new Map(batches.map(batch => [batch.hash, batch])), missing = new Set<string>()
  const degrees = new Map<string, number>(), dependents = new Map<string, string[]>(), queue: SyncBatch[] = []
  for (const batch of [...batches].sort((a, b) => a.hash.localeCompare(b.hash))) {
    const dependencies = new Set([batch.previousHash, ...batch.changes.flatMap(change => change.parents.map(parent => parent.split(':')[0]!))].filter((item): item is string => !!item))
    degrees.set(batch.hash, dependencies.size)
    if (!dependencies.size) queue.push(batch)
    for (const dependency of dependencies) {
      if (!known.has(dependency)) missing.add(dependency)
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), batch.hash])
    }
  }
  const ancestors = (candidate: string, parents: string[]): boolean => {
    const visit = [...parents], seen = new Set<string>()
    while (visit.length) {
      const id = visit.pop()!
      if (id === candidate) return true
      if (seen.has(id)) continue
      seen.add(id); visit.push(...(revisions.get(id)?.parents ?? []))
    }
    return false
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
      const batch = queue[cursor]!
      if (batch.previousHash) {
        const previous = known.get(batch.previousHash)!
        if (previous.replicaId !== batch.replicaId || previous.sequence !== batch.sequence - 1) fail('SYNC_INVALID_REPLICA_CHAIN')
      }
      batch.changes.forEach((change, index) => {
        const identity = key(change.kind, change.id)
        for (const parent of change.parents) {
          const prior = revisions.get(parent)
          if (!prior || key(prior.kind, prior.id) !== identity) fail('SYNC_INVALID_PARENT')
        }
        const revision: Revision = { ...change, revision: `${batch.hash}:${index}`, batchId: batch.batchId, replicaId: batch.replicaId }
        const current = (heads.get(identity) ?? []).filter(head => !ancestors(head.revision, change.parents))
        revisions.set(revision.revision, revision)
        heads.set(identity, [...current, revision].sort((a, b) => a.revision.localeCompare(b.revision)))
      })
      for (const next of dependents.get(batch.hash) ?? []) {
        const degree = degrees.get(next)! - 1
        degrees.set(next, degree)
        if (degree === 0) queue.push(known.get(next)!)
      }
  }
  if (queue.length < batches.length && !missing.size) fail('SYNC_CAUSAL_CYCLE')
  return { heads, revisions, missing: [...missing].sort() }
}
const graphConflicts = (graph: Graph): SyncConflict[] => [...graph.heads.values()].filter(heads => heads.length > 1).map(heads => ({
  kind: heads[0]!.kind, id: heads[0]!.id,
  variants: heads.map(({ revision, batchId, replicaId, deleted, value }) => ({ revision, batchId, replicaId, deleted, value })),
})).sort((a, b) => key(a.kind, a.id).localeCompare(key(b.kind, b.id)))
const graphRecords = (graph: Graph): SyncRecord[] => [...graph.heads.values()].filter(heads => heads.length === 1 && !heads[0]!.deleted)
  .map(([head]) => ({ kind: head!.kind, id: head!.id, value: head!.value })).sort((a, b) => key(a.kind, a.id).localeCompare(key(b.kind, b.id)))
const recordMap = (records: SyncRecord[]) => {
  const result = new Map<string, SyncRecord>()
  for (const record of records) {
    checkIdentity(record.kind, record.id)
    const identity = key(record.kind, record.id)
    if (result.has(identity)) fail('SYNC_DUPLICATE_ENTITY')
    canonicalSyncJson(record.value); result.set(identity, record)
  }
  return result
}

export class ProjectSyncEngine {
  busy = false
  private mutationScope: { baseline?: MutationBaseline } | null = null
  constructor(private readonly database: Database.Database, readonly projectId: string, private readonly projection: SyncProjection, private readonly saved?: (projectId: string) => void) {
    if (!UUID.test(projectId)) fail('SYNC_INVALID_PROJECT_ID')
  }
  private meta(): { project_id: string; replica_id: string } | undefined {
    const row = this.database.prepare('SELECT project_id,replica_id FROM project_sync_meta WHERE id=1').get() as { project_id: string; replica_id: string } | undefined
    if (row && row.project_id !== this.projectId) fail('SYNC_PROJECT_ID_MISMATCH')
    return row
  }
  private rows(acceptedOnly = false): StoredBatch[] {
    return this.database.prepare('SELECT batch_id,hash,payload_json,accepted FROM project_sync_batches' + (acceptedOnly ? ' WHERE accepted=1' : '') + ' ORDER BY hash').all() as StoredBatch[]
  }
  private batches(acceptedOnly = false): SyncBatch[] { return this.rows(acceptedOnly).map(row => validateBatch(JSON.parse(row.payload_json), this.projectId)) }
  private atomic<T>(operation: () => T): T {
    const previous = this.busy; this.busy = true
    try { return this.database.transaction(operation)() }
    finally { this.busy = previous }
  }
  private insert(batch: SyncBatch, accepted: boolean, received = false): void {
    const existing = this.database.prepare('SELECT hash FROM project_sync_batches WHERE batch_id=? OR (replica_id=? AND sequence=?)').all(batch.batchId, batch.replicaId, batch.sequence) as Array<{ hash: string }>
    if (existing.length) {
      if (existing.length !== 1 || existing[0]!.hash !== batch.hash) fail('SYNC_BATCH_EQUIVOCATION')
      return
    }
    if (received && batch.replicaId === this.meta()?.replica_id) fail('SYNC_REPLICA_ID_REUSED')
    this.database.prepare('INSERT INTO project_sync_batches(batch_id,replica_id,sequence,hash,payload_json,accepted) VALUES(?,?,?,?,?,?)')
      .run(batch.batchId, batch.replicaId, batch.sequence, batch.hash, canonicalSyncJson(batch), accepted ? 1 : 0)
  }
  private localBatch(changes: SyncChange[]): SyncBatch {
    const replicaId = this.meta()?.replica_id ?? fail('SYNC_NOT_ENABLED')
    const row = this.database.prepare('SELECT payload_json FROM project_sync_batches WHERE replica_id=? ORDER BY sequence DESC LIMIT 1').get(replicaId) as { payload_json: string } | undefined
    const previous = row ? validateBatch(JSON.parse(row.payload_json), this.projectId) : undefined
    const body = { protocol: 1 as const, projectId: this.projectId, replicaId, sequence: (previous?.sequence ?? 0) + 1, previousHash: previous?.hash ?? null, batchId: randomUUID(), changes }
    return { ...body, hash: syncDigest(body) }
  }
  enable(): SyncStatus {
    this.atomic(() => {
      if (this.meta()) return
      this.database.prepare('INSERT INTO project_sync_meta(id,project_id,replica_id) VALUES(1,?,?)').run(this.projectId, randomUUID())
      const records = this.projection.capture(this.database); recordMap(records); this.projection.validate(records)
      if (!records.length) fail('SYNC_EMPTY_PROJECT')
      this.insert(this.localBatch(records.map(record => ({ ...record, parents: [], deleted: false }))), true)
    })
    return this.status()
  }
  /** Called at the outer business transaction, before its commit. */
  captureMutation<T>(operation: () => T): T {
    if (this.busy || !this.meta()) return operation()
    // Repository transactions start capturing only when a portable table is
    // actually written. Reading a project or updating a task log is free of
    // projection/causal-history scans, while all author writes still share one
    // atomic outbox batch at the end of the outer transaction.
    if (this.mutationScope) {
      this.mutationScope.baseline ??= this.atomic(() => this.captureBaseline())
      const result = operation()
      if (result && typeof (result as { then?: unknown }).then === 'function') fail('SYNC_ASYNC_MUTATION_FORBIDDEN')
      return result
    }
    let changed = false
    const result = this.atomic(() => {
      const baseline = this.captureBaseline()
      const result = operation()
      if (result && typeof (result as { then?: unknown }).then === 'function') fail('SYNC_ASYNC_MUTATION_FORBIDDEN')
      changed = this.finishMutation(baseline)
      return result
    })
    // Notifications carry no content. The synchronous transaction is finished;
    // a rollback of an outer caller can at most cause a harmless extra check.
    if (changed) { try { this.saved?.(this.projectId) } catch { /* A closed renderer cannot undo a durable save. */ } }
    return result
  }
  /** Must run inside the repository's real SQLite transaction. Nested savepoint
   * failures restore the capture baseline along with their rolled-back writes. */
  captureTransaction<T>(operation: () => T): T {
    if (this.busy) return operation()
    if (this.mutationScope) {
      const scope = this.mutationScope, previous = scope.baseline
      try { return operation() }
      catch (error) { scope.baseline = previous; throw error }
    }
    const scope: { baseline?: MutationBaseline } = {}
    this.mutationScope = scope
    let changed = false
    try {
      const result = operation()
      if (result && typeof (result as { then?: unknown }).then === 'function') fail('SYNC_ASYNC_MUTATION_FORBIDDEN')
      if (scope.baseline) changed = this.atomic(() => this.finishMutation(scope.baseline!))
      return result
    } finally {
      this.mutationScope = null
      if (changed) { try { this.saved?.(this.projectId) } catch { /* Save is independent of listeners. */ } }
    }
  }
  private captureBaseline(): MutationBaseline {
    return this.assertLocalState() ?? {
      before: recordMap(this.projection.capture(this.database)), graph: buildGraph([]),
    }
  }
  private finishMutation({ before, graph }: MutationBaseline): boolean {
    const afterRecords = this.projection.capture(this.database), after = recordMap(afterRecords)
    this.projection.validate(afterRecords)
    const changes: SyncChange[] = []
    for (const identity of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(identity), next = after.get(identity)
      if (old && next && canonicalSyncJson(old.value) === canonicalSyncJson(next.value)) continue
      const entity = next ?? old!
      if (old && this.projection.immutableKinds?.includes(entity.kind)) fail('SYNC_IMMUTABLE_RECORD_CHANGED')
      changes.push({ kind: entity.kind, id: entity.id, parents: (graph.heads.get(identity) ?? []).map(head => head.revision), value: next?.value ?? null, deleted: !next })
    }
    if (!changes.length) return false
    const batch = this.localBatch(changes.sort((a, b) => key(a.kind, a.id).localeCompare(key(b.kind, b.id))))
    this.validateImmutability([...this.batches(), batch])
    this.insert(batch, true)
    return true
  }
  exportBundle(): SyncBundle {
    return this.exportIncrementalBundle(new Set(), false) ?? fail('SYNC_EMPTY_PROJECT')
  }
  /** Cloud transport selects hashes before reading payloads; an idle save never serializes history. */
  exportIncrementalBundle(knownHashes: ReadonlySet<string>, includePending = false): SyncBundle | undefined {
    const replicaId = this.meta()?.replica_id ?? fail('SYNC_NOT_ENABLED')
    // Legacy feature adoption can append a batch and must precede selection.
    this.assertLocalState()
    const selected = (this.database.prepare('SELECT hash FROM project_sync_batches' + (includePending ? '' : ' WHERE accepted=1') + ' ORDER BY hash').all() as Array<{ hash: string }>)
      .filter(row => !knownHashes.has(row.hash))
    if (!selected.length) return undefined
    if (selected.length > 20_000) fail('SYNC_PACKAGE_TOO_LARGE')
    const read = this.database.prepare('SELECT payload_json FROM project_sync_batches WHERE hash=?')
    const batches = selected.map(row => validateBatch(JSON.parse((read.get(row.hash) as { payload_json: string }).payload_json), this.projectId))
    const features: SyncFeature[] = []
    if (batches.some(batch => batch.changes.some(change => change.kind === 'narrative-plan'))) features.push('narrative-sync-v1')
    if (batches.some(batch => batch.changes.some(change => change.kind === 'project-asset'))) features.push('project-assets-v1')
    const requiredFeatures = features.length ? { requiredFeatures: features } : {}
    const minimumReader = features.includes('project-assets-v1') ? { minimumReaderSchemaVersion: 11 as const }
      : Number(this.database.pragma('user_version', { simple: true })) >= 10 ? { minimumReaderSchemaVersion: 10 as const } : {}
    const body = { format: 'ai-novel-sync' as const, version: 1 as const, ...minimumReader, ...requiredFeatures, projectId: this.projectId, senderReplicaId: replicaId, batches }
    const result = { ...body, hash: syncDigest(body) }; validateSyncBundle(result); return result
  }
  receive(input: unknown): SyncPreview {
    const bundle = validateSyncBundle(input)
    if (bundle.compact) fail('SYNC_COMPACT_UPGRADE_REQUIRED')
    if (bundle.projectId !== this.projectId) fail('SYNC_PROJECT_ID_MISMATCH')
    if (!this.meta()) fail('SYNC_NOT_ENABLED')
    this.assertLocalState()
    if (bundle.minimumReaderSchemaVersion === undefined && Number(this.database.pragma('user_version', { simple: true })) >= 10 && this.projection.validateLegacyImport) {
      const source = buildGraph(bundle.batches)
      if (!source.missing.length && !graphConflicts(source).length) this.projection.validateLegacyImport(graphRecords(source))
    }
    // Validate individual payloads even when conflict/missing-parent graphs
    // cannot yet be projected. Invalid pending data must never poison a replica.
    for (const batch of bundle.batches) this.projection.validateChanges?.(batch.changes)
    this.validateImmutability([...this.batches(), ...bundle.batches])
    this.atomic(() => {
      for (const batch of bundle.batches) this.insert(batch, false, true)
      // An exported package is evidence the peer accepted these exact batches.
      if (bundle.senderReplicaId !== this.meta()!.replica_id) {
        for (const batch of bundle.batches) this.database.prepare('INSERT OR IGNORE INTO project_sync_acknowledgements(peer_replica_id,batch_id) VALUES(?,?)').run(bundle.senderReplicaId, batch.batchId)
      }
      const graph = buildGraph(this.batches())
      if (!graph.missing.length && !graphConflicts(graph).length) {
        const records = graphRecords(graph)
        this.projection.validate(records)
        this.projection.validateCandidate?.(this.database, records)
      }
    })
    return this.preview()
  }
  preview(): SyncPreview {
    if (!this.meta()) fail('SYNC_NOT_ENABLED')
    const rows = this.rows(), graph = buildGraph(this.batches()), current = recordMap(this.projection.capture(this.database))
    const proposed = recordMap(graphRecords(graph)), conflicts = graphConflicts(graph)
    let changedRecords = 0
    for (const identity of new Set([...current.keys(), ...proposed.keys()])) {
      if (canonicalSyncJson(current.get(identity)?.value ?? null) !== canonicalSyncJson(proposed.get(identity)?.value ?? null)
        || current.has(identity) !== proposed.has(identity)) changedRecords++
    }
    return { token: syncDigest({ batches: rows.map(row => [row.hash, row.accepted]), current: [...current].sort(([a], [b]) => a.localeCompare(b)) }),
      pendingBatches: rows.filter(row => !row.accepted).length, missingBatchHashes: graph.missing, conflicts, changedRecords,
      canApply: !graph.missing.length && !conflicts.length }
  }
  apply(token: string, resolutions: SyncResolution[] = []): SyncApplyResult {
    return this.atomic(() => {
      this.validateImmutability(this.batches())
      const preview = this.preview()
      if (preview.token !== token) fail('SYNC_PREVIEW_STALE')
      this.assertLocalState()
      if (!preview.pendingBatches && !resolutions.length) return { applied: true, appliedBatches: 0, preview }
      if (preview.missingBatchHashes.length) return { applied: false, appliedBatches: 0, preview }
      const graph = buildGraph(this.batches()), conflicts = graphConflicts(graph)
      if (!Array.isArray(resolutions) || resolutions.length && resolutions.length !== conflicts.length) fail('SYNC_INVALID_RESOLUTION')
      if (conflicts.length && !resolutions.length) return { applied: false, appliedBatches: 0, preview }
      for (const table of ['generation_runs', 'import_runs']) {
        if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
          && this.database.prepare(`SELECT 1 FROM ${table} WHERE status='running' LIMIT 1`).get()) fail('SYNC_ACTIVE_OPERATION')
      }
      if (resolutions.length) {
        const seen = new Set<string>(), changes: SyncChange[] = []
        for (const resolution of resolutions) {
          const identity = key(resolution.kind, resolution.id), heads = graph.heads.get(identity)
          if (seen.has(identity) || !heads || heads.length < 2 || !Array.isArray(resolution.expectedHeads)
            || canonicalSyncJson([...resolution.expectedHeads].sort()) !== canonicalSyncJson(heads.map(head => head.revision).sort())) fail('SYNC_PREVIEW_STALE')
          const selected = heads.find(head => head.revision === resolution.selectedRevision)
          if (!selected) fail('SYNC_INVALID_RESOLUTION')
          seen.add(identity); changes.push({ kind: selected.kind, id: selected.id, parents: heads.map(head => head.revision), value: selected.value, deleted: selected.deleted })
        }
        this.insert(this.localBatch(changes), false)
      }
      const merged = buildGraph(this.batches())
      if (merged.missing.length || graphConflicts(merged).length) fail('SYNC_UNRESOLVED_CONFLICT')
      const records = graphRecords(merged); this.projection.validate(records)
      this.projection.apply(this.database, records)
      const actual = recordMap(this.projection.capture(this.database))
      const extensions = this.projectionExtensions(records, actual, 'SYNC_PROJECTION_MISMATCH')
      if (extensions.length) this.insert(this.localBatch(extensions), false)
      const appliedBatches = this.rows().filter(row => !row.accepted).length
      this.database.prepare('UPDATE project_sync_batches SET accepted=1 WHERE accepted=0').run()
      return { applied: true, appliedBatches, preview: this.preview() }
    })
  }
  join(input: unknown): SyncApplyResult {
    const bundle = validateSyncBundle(input)
    if (bundle.compact) fail('SYNC_COMPACT_UPGRADE_REQUIRED')
    if (bundle.projectId !== this.projectId) fail('SYNC_PROJECT_ID_MISMATCH')
    return this.atomic(() => {
      if (this.meta() || this.rows().length) fail('SYNC_JOIN_REQUIRES_NEW_PROJECT')
      this.database.prepare('INSERT INTO project_sync_meta(id,project_id,replica_id) VALUES(1,?,?)').run(this.projectId, randomUUID())
      this.receive(bundle)
      const preview = this.preview()
      if (!preview.canApply) fail('SYNC_JOIN_INCOMPLETE')
      return this.apply(preview.token)
    })
  }
  status(): SyncStatus {
    const meta = this.meta()
    if (!meta) return { enabled: false, projectId: this.projectId, replicaId: null, localBatches: 0, acknowledgedBatches: 0, pendingBatches: 0, conflicts: 0 }
    this.assertLocalState()
    const local = this.batches(true).filter(batch => batch.replicaId === meta.replica_id)
    const acknowledgements = new Set((this.database.prepare('SELECT DISTINCT batch_id FROM project_sync_acknowledgements').all() as Array<{ batch_id: string }>).map(row => row.batch_id))
    const preview = this.preview()
    return { enabled: true, projectId: this.projectId, replicaId: meta.replica_id, localBatches: local.length,
      acknowledgedBatches: local.filter(batch => acknowledgements.has(batch.batchId)).length, pendingBatches: preview.pendingBatches, conflicts: preview.conflicts.length }
  }
  private assertLocalState(): MutationBaseline | undefined {
    const accepted = this.batches(true)
    this.validateImmutability(accepted)
    // Joining starts with a fresh empty projection and no accepted local state.
    if (!accepted.length) return
    const current = recordMap(this.projection.capture(this.database))
    let graph = buildGraph(accepted)
    const expected = graphRecords(graph)
    const extensions = this.projectionExtensions(expected, current, 'SYNC_LOCAL_STATE_DIVERGED')
    if (extensions.length) {
      this.atomic(() => this.insert(this.localBatch(extensions), true))
      graph = buildGraph(this.batches(true))
    }
    return { before: current, graph }
  }
  private projectionExtensions(expectedRecords: SyncRecord[], current: Map<string, SyncRecord>, error: string): SyncChange[] {
    const expected = recordMap(expectedRecords), comparable = new Map(current), extensions: SyncChange[] = []
    for (const [identity, record] of current) if (!expected.has(identity) && this.projection.legacyExtensionKinds?.includes(record.kind)) {
      comparable.delete(identity)
      extensions.push({ ...record, parents: [], deleted: false })
    }
    if (syncDigest([...comparable].sort(([a], [b]) => a.localeCompare(b))) !== syncDigest([...expected].sort(([a], [b]) => a.localeCompare(b)))) fail(error)
    if (extensions.length) this.projection.validate([...current.values()])
    return extensions.sort((a, b) => key(a.kind, a.id).localeCompare(key(b.kind, b.id)))
  }
  private validateImmutability(batches: SyncBatch[]): void {
    this.projection.validateHistory?.(batches)
    if (!this.projection.immutableKinds?.length) return
    const observations = new Map<string, string>()
    for (const batch of batches) for (const change of batch.changes) {
      if (!this.projection.immutableKinds.includes(change.kind)) continue
      if (change.deleted) fail('SYNC_IMMUTABLE_RECORD_CHANGED')
      const identity = key(change.kind, change.id), value = canonicalSyncJson(change.value)
      const previous = observations.get(identity)
      if (previous !== undefined && previous !== value) fail('SYNC_IMMUTABLE_RECORD_CHANGED')
      observations.set(identity, value)
    }
  }
}
