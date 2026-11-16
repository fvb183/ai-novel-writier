import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncApplyResult, SyncBatch, SyncBundle, SyncChange, SyncConflict, SyncJson, SyncPreview, SyncRecord, SyncResolution, SyncStatus } from '../../src/shared/project-sync'
import { compactRecordsCover, mergeCompactClocks, mergeCompactRecords, type CompactClock, type CompactHead, type CompactRecord, type CompactSnapshot } from '../../src/shared/project-sync-compact'
import { canonicalSyncJson, syncDigest, validateSyncBundle, type SyncProjection } from './project-sync-engine'
import { compactProjectSyncProjection, prepareCompactAuthorProjection } from './project-sync-projection'
import { isCompactAuthorRecord } from './project-sync-scope'

const identity = (record: { kind: string; id: string }) => JSON.stringify([record.kind, record.id])
const fail = (code: string): never => { throw new Error(code) }
const same = (left: unknown, right: unknown) => canonicalSyncJson(left) === canonicalSyncJson(right)
const recordsMap = (records: SyncRecord[]) => new Map(records.map(record => [identity(record), record]))
const values = (records: CompactRecord[]): SyncRecord[] => records.filter(record => record.heads.length === 1 && !record.heads[0]!.deleted)
  .map(record => ({ kind: record.kind, id: record.id, value: record.heads[0]!.value }))
export function createCompactHead(kind: string, id: string, clock: CompactClock, deleted: boolean, value: SyncJson | null): CompactHead {
  const body = { kind, id, clock: mergeCompactClocks(clock), deleted, value }
  return { revision: syncDigest(body), clock: body.clock, deleted, value }
}
export function makeCompactBundle(projectId: string, senderReplicaId: string, compact: CompactSnapshot): SyncBundle {
  const body = { format: 'ai-novel-sync' as const, version: 1 as const, minimumReaderSchemaVersion: 12 as const,
    requiredFeatures: ['compact-sync-v2'] as const, projectId, senderReplicaId, batches: [] as SyncBatch[], compact }
  return validateSyncBundle({ ...body, requiredFeatures: [...body.requiredFeatures], hash: syncDigest(body) })
}

/** One-time v1 conversion keeps causal clocks, not historical prose values. */
export function legacyCompactRecords(batches: readonly SyncBatch[]): { clock: CompactClock; records: CompactRecord[] } {
  const byHash = new Map(batches.map(batch => [batch.hash, batch])), clocks = new Map<string, CompactClock>()
  const dependencies = new Map<string, string[]>(), dependents = new Map<string, string[]>(), degrees = new Map<string, number>(), positions = new Map<string, string>(), ids = new Map<string, string>(), queue: SyncBatch[] = []
  for (const batch of byHash.values()) {
    const position = `${batch.replicaId}:${batch.sequence}`, { hash, ...body } = batch
    if (hash !== syncDigest(body)) fail('SYNC_BATCH_HASH_MISMATCH')
    if (positions.has(position) && positions.get(position) !== hash || ids.has(batch.batchId) && ids.get(batch.batchId) !== hash) fail('SYNC_BATCH_EQUIVOCATION')
    positions.set(position, hash); ids.set(batch.batchId, hash)
    const hashes = [...new Set([batch.previousHash, ...batch.changes.flatMap(change => change.parents.map(parent => parent.split(':')[0]!))].filter((item): item is string => !!item))]
    for (const parent of hashes) { if (!byHash.has(parent)) fail('SYNC_COMPACT_LEGACY_INCOMPLETE'); dependents.set(parent, [...(dependents.get(parent) ?? []), hash]) }
    if (batch.previousHash) { const previous = byHash.get(batch.previousHash)!; if (previous.replicaId !== batch.replicaId || previous.sequence !== batch.sequence - 1) fail('SYNC_INVALID_REPLICA_CHAIN') }
    for (const change of batch.changes) for (const reference of change.parents) {
      const [parentHash, position] = reference.split(':'), parent = byHash.get(parentHash!)?.changes[Number(position)]
      if (!parent || identity(parent) !== identity(change)) fail('SYNC_INVALID_PARENT')
    }
    dependencies.set(hash, hashes); degrees.set(hash, hashes.length); if (!hashes.length) queue.push(batch)
  }
  for (let index = 0; index < queue.length; index++) {
    const batch = queue[index]!
    clocks.set(batch.hash, mergeCompactClocks(...dependencies.get(batch.hash)!.map(hash => clocks.get(hash)!), { [batch.replicaId]: batch.sequence }))
    for (const hash of dependents.get(batch.hash) ?? []) { degrees.set(hash, degrees.get(hash)! - 1); if (!degrees.get(hash)) queue.push(byHash.get(hash)!) }
  }
  if (clocks.size !== byHash.size) fail('SYNC_CAUSAL_CYCLE')
  const clockOf = (batch: SyncBatch) => clocks.get(batch.hash)!
  const allowed = new Map<string, boolean>()
  for (const batch of batches) for (const change of batch.changes) if (!change.deleted) {
    allowed.set(identity(change), isCompactAuthorRecord(change.kind, change.id, change.value))
  }
  const records = mergeCompactRecords(...batches.map(batch => batch.changes.filter(change => allowed.get(identity(change)) !== false && !change.kind.startsWith('history:'))
    .map(change => ({ kind: change.kind, id: change.id, heads: [createCompactHead(change.kind, change.id, clockOf(batch), change.deleted, change.value)] }))))
  return { clock: mergeCompactClocks(...batches.map(clockOf)), records }
}
export function convertLegacyBundleToCompact(input: SyncBundle): SyncBundle {
  const bundle = validateSyncBundle(input)
  if (bundle.compact) return bundle
  const converted = legacyCompactRecords(bundle.batches)
  return makeCompactBundle(bundle.projectId, bundle.senderReplicaId, { protocol: 2, mode: 'snapshot', ...converted })
}

type Baseline = { records: SyncRecord[]; accepted: CompactRecord[]; clock: CompactClock }
export class CompactProjectSyncEngine {
  busy = false
  private mutationScope: { baseline?: Baseline } | null = null
  constructor(private readonly database: Database.Database, readonly projectId: string,
    private readonly projection: SyncProjection = compactProjectSyncProjection, private readonly saved?: (projectId: string) => void) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(projectId)) fail('SYNC_INVALID_PROJECT_ID')
  }
  private meta(): { project_id: string; replica_id: string } | undefined {
    const meta = this.database.prepare('SELECT project_id,replica_id FROM project_sync_meta WHERE id=1').get() as { project_id: string; replica_id: string } | undefined
    if (meta && meta.project_id !== this.projectId) fail('SYNC_PROJECT_ID_MISMATCH')
    return meta
  }
  private atomic<T>(operation: () => T): T {
    const prior = this.busy; this.busy = true
    try { return this.database.transaction(operation)() } finally { this.busy = prior }
  }
  private clock(pending = false): CompactClock {
    const row = this.database.prepare('SELECT clock_json,pending_clock_json FROM project_sync_compact_meta WHERE id=1').get() as { clock_json: string; pending_clock_json: string } | undefined
    return row ? JSON.parse(pending ? row.pending_clock_json : row.clock_json) : {}
  }
  private setClock(clock: CompactClock, pending = false): void {
    this.database.prepare(`UPDATE project_sync_compact_meta SET ${pending ? 'pending_clock_json' : 'clock_json'}=? WHERE id=1`).run(canonicalSyncJson(clock))
  }
  private read(accepted: boolean, kind?: string): CompactRecord[] {
    return (this.database.prepare('SELECT kind,entity_id,heads_json FROM project_sync_compact_records WHERE accepted=?' + (kind ? ' AND kind=?' : '') + ' ORDER BY kind,entity_id').all(...(kind ? [accepted ? 1 : 0, kind] : [accepted ? 1 : 0])) as Array<{ kind: string; entity_id: string; heads_json: string }>)
      .map(row => ({ kind: row.kind, id: row.entity_id, heads: JSON.parse(row.heads_json) }))
  }
  private write(records: CompactRecord[], accepted: boolean): void {
    this.database.prepare('DELETE FROM project_sync_compact_records WHERE accepted=?').run(accepted ? 1 : 0)
    const insert = this.database.prepare('INSERT INTO project_sync_compact_records(kind,entity_id,accepted,heads_json) VALUES(?,?,?,?)')
    for (const record of records) insert.run(record.kind, record.id, accepted ? 1 : 0, canonicalSyncJson(record.heads))
  }
  private pruneLegacy(): void {
    this.database.prepare('DELETE FROM project_sync_acknowledgements').run()
    this.database.prepare('DELETE FROM project_sync_batches').run()
    this.database.prepare('DELETE FROM project_sync_history').run()
    if (this.projection === compactProjectSyncProjection) prepareCompactAuthorProjection(this.database)
  }
  private ensureReady(): void {
    if (!this.meta() || this.database.prepare('SELECT id FROM project_sync_compact_meta WHERE id=1').get()) return
    this.atomic(() => {
      const rows = this.database.prepare('SELECT payload_json,accepted FROM project_sync_batches ORDER BY hash').all() as Array<{ payload_json: string; accepted: number }>
      this.projection.validateHistory?.(rows.map(row => JSON.parse(row.payload_json)))
      const accepted = legacyCompactRecords(rows.filter(row => row.accepted).map(row => JSON.parse(row.payload_json)))
      const all = legacyCompactRecords(rows.map(row => JSON.parse(row.payload_json)))
      const current = this.projection.capture(this.database), currentMap = recordsMap(current), previousMap = recordsMap(values(accepted.records))
      for (const [key, record] of previousMap) if (!currentMap.has(key) || !same(currentMap.get(key)!.value, record.value)) fail('SYNC_LOCAL_STATE_DIVERGED')
      this.database.prepare('INSERT INTO project_sync_compact_meta VALUES(1,?,?)').run(canonicalSyncJson(accepted.clock), canonicalSyncJson(all.clock))
      let adopted = accepted.records
      const extensions = current.filter(record => !previousMap.has(identity(record)))
      if (extensions.length) {
        const replicaId = this.meta()!.replica_id, clock = mergeCompactClocks(accepted.clock, { [replicaId]: (accepted.clock[replicaId] ?? 0) + 1 })
        adopted = mergeCompactRecords(adopted, extensions.map(record => ({ kind: record.kind, id: record.id, heads: [createCompactHead(record.kind, record.id, clock, false, record.value)] })))
        this.setClock(clock)
      }
      this.projection.validate(current)
      this.write(adopted, true)
      this.write(mergeCompactRecords(all.records).filter(record => !compactRecordsCover(adopted, [record])), false)
      this.pruneLegacy()
    })
  }
  enable(): SyncStatus {
    if (this.meta()) { this.ensureReady(); return this.status() }
    this.atomic(() => {
      const replicaId = randomUUID(), clock = { [replicaId]: 1 }, current = this.projection.capture(this.database)
      if (!current.length) fail('SYNC_EMPTY_PROJECT'); this.projection.validate(current)
      this.database.prepare('INSERT INTO project_sync_meta VALUES(1,?,?)').run(this.projectId, replicaId)
      this.database.prepare('INSERT INTO project_sync_compact_meta VALUES(1,?,?)').run(canonicalSyncJson(clock), '{}')
      this.write(current.map(record => ({ kind: record.kind, id: record.id, heads: [createCompactHead(record.kind, record.id, clock, false, record.value)] })), true)
      this.pruneLegacy()
    })
    return this.status()
  }
  private baseline(): Baseline {
    if (!this.meta()) fail('SYNC_NOT_ENABLED')
    this.ensureReady()
    const accepted = this.read(true), records = this.projection.capture(this.database)
    if (!same([...recordsMap(records)].sort(), [...recordsMap(values(accepted))].sort())) fail('SYNC_LOCAL_STATE_DIVERGED')
    return { records, accepted, clock: this.clock() }
  }
  private validateCombined(records: CompactRecord[]): void {
    const changes: SyncChange[] = records.flatMap(record => record.heads.map(head => ({ kind: record.kind, id: record.id, parents: [], deleted: head.deleted, value: head.value })))
    this.projection.validateChanges?.(changes)
    this.projection.validateHistory?.([{ changes } as SyncBatch])
    const immutable = new Map<string, CompactHead[]>()
    for (const record of records) if (this.projection.immutableKinds?.includes(record.kind)) immutable.set(identity(record), [...(immutable.get(identity(record)) ?? []), ...record.heads])
    for (const heads of immutable.values()) if (heads.some(head => head.deleted) || new Set(heads.map(head => canonicalSyncJson(head.value))).size > 1) fail('SYNC_IMMUTABLE_RECORD_CHANGED')
  }
  private finishMutation(baseline: Baseline): boolean {
    const after = this.projection.capture(this.database); this.projection.validate(after)
    const before = recordsMap(baseline.records), next = recordsMap(after)
    const changed = [...new Set([...before.keys(), ...next.keys()])].filter(key => !same(before.get(key)?.value ?? null, next.get(key)?.value ?? null) || before.has(key) !== next.has(key))
    if (!changed.length) return false
    const replicaId = this.meta()!.replica_id, clock = mergeCompactClocks(baseline.clock, { [replicaId]: (baseline.clock[replicaId] ?? 0) + 1 })
    const updates = changed.map(key => {
      const record = next.get(key) ?? before.get(key)!
      if (before.has(key) && this.projection.immutableKinds?.includes(record.kind)) fail('SYNC_IMMUTABLE_RECORD_CHANGED')
      // A delta may carry another record's later global counter. Only this
      // record's accepted context proves which prose the author has seen.
      const context = mergeCompactClocks(...(baseline.accepted.find(item => identity(item) === key)?.heads.map(head => head.clock) ?? []), { [replicaId]: clock[replicaId]! })
      return { kind: record.kind, id: record.id, heads: [createCompactHead(record.kind, record.id, context, !next.has(key), next.get(key)?.value ?? null)] }
    })
    this.validateCombined([...baseline.accepted, ...updates])
    this.write(mergeCompactRecords(baseline.accepted, updates), true); this.setClock(clock)
    return true
  }
  captureMutation<T>(operation: () => T): T {
    if (this.busy || !this.meta()) return operation()
    if (this.mutationScope) {
      this.mutationScope.baseline ??= this.atomic(() => this.baseline())
      const result = operation(); if (result && typeof (result as { then?: unknown }).then === 'function') fail('SYNC_ASYNC_MUTATION_FORBIDDEN')
      return result
    }
    let changed = false
    const result = this.atomic(() => { const baseline = this.baseline(), result = operation(); if (result && typeof (result as { then?: unknown }).then === 'function') fail('SYNC_ASYNC_MUTATION_FORBIDDEN'); changed = this.finishMutation(baseline); return result })
    if (changed) { try { this.saved?.(this.projectId) } catch { /* Notification cannot undo a save. */ } }
    return result
  }
  captureTransaction<T>(operation: () => T): T {
    if (this.busy) return operation()
    if (this.mutationScope) { const scope = this.mutationScope, prior = scope.baseline; try { return operation() } catch (error) { scope.baseline = prior; throw error } }
    const scope: { baseline?: Baseline } = {}; this.mutationScope = scope
    let changed = false
    try { const result = operation(); if (result && typeof (result as { then?: unknown }).then === 'function') fail('SYNC_ASYNC_MUTATION_FORBIDDEN'); if (scope.baseline) changed = this.atomic(() => this.finishMutation(scope.baseline!)); return result }
    finally { this.mutationScope = null; if (changed) { try { this.saved?.(this.projectId) } catch { /* Notification cannot undo a save. */ } } }
  }
  liveCompactRecords(includePending = true): CompactRecord[] {
    this.ensureReady()
    return includePending ? mergeCompactRecords(this.read(true), this.read(false)) : this.read(true)
  }
  liveCompactAssetRecords(includePending = true): CompactRecord[] {
    this.ensureReady()
    return includePending ? mergeCompactRecords(this.read(true, 'project-asset'), this.read(false, 'project-asset')) : this.read(true, 'project-asset')
  }
  exportCompactBundle(_knownClock?: CompactClock, includePending = false): SyncBundle {
    this.baseline()
    const records = this.liveCompactRecords(includePending)
    return makeCompactBundle(this.projectId, this.meta()!.replica_id, { protocol: 2, mode: 'snapshot', clock: includePending ? mergeCompactClocks(this.clock(), this.clock(true)) : this.clock(), records,
      ...(includePending && records.some(record => record.heads.length > 1) ? { accepted: this.read(true) } : {}) })
  }
  exportBundle(): SyncBundle { return this.exportCompactBundle() }
  exportIncrementalBundle(_knownHashes: ReadonlySet<string>, includePending = false): SyncBundle { return this.exportCompactBundle(undefined, includePending) }
  receive(input: unknown): SyncPreview {
    const incoming = validateSyncBundle(input)
    const incomingCompact = incoming.compact ?? fail('SYNC_COMPACT_UPGRADE_REQUIRED')
    if (incoming.projectId !== this.projectId) fail('SYNC_PROJECT_ID_MISMATCH')
    if (!this.meta()) fail('SYNC_NOT_ENABLED'); this.baseline()
    const accepted = this.read(true), candidate = mergeCompactRecords(accepted, this.read(false), incomingCompact.records)
    this.validateCombined([...accepted, ...candidate])
    if ((incomingCompact.clock[this.meta()!.replica_id] ?? 0) > (this.clock()[this.meta()!.replica_id] ?? 0)) fail('SYNC_REPLICA_ID_REUSED')
    this.atomic(() => {
      this.write(candidate.filter(record => !compactRecordsCover(accepted, [record])), false)
      this.setClock(mergeCompactClocks(this.clock(true), incomingCompact.clock), true)
      if (!candidate.some(record => record.heads.length > 1)) { this.projection.validate(values(candidate)); this.projection.validateCandidate?.(this.database, values(candidate)) }
    })
    return this.preview()
  }
  preview(): SyncPreview {
    if (!this.meta()) fail('SYNC_NOT_ENABLED'); this.ensureReady()
    const accepted = this.read(true), pending = this.read(false), candidate = mergeCompactRecords(accepted, pending)
    const conflicts: SyncConflict[] = candidate.filter(record => record.heads.length > 1).map(record => ({ kind: record.kind, id: record.id,
      variants: record.heads.map(head => ({ revision: head.revision, batchId: head.revision, replicaId: Object.keys(head.clock).sort().at(-1) ?? this.meta()!.replica_id, deleted: head.deleted, value: head.value })) }))
    return { token: syncDigest({ accepted, pending, clock: this.clock(), pendingClock: this.clock(true), current: this.projection.capture(this.database) }),
      pendingBatches: pending.length, missingBatchHashes: [], conflicts, changedRecords: pending.length, canApply: !conflicts.length }
  }
  apply(token: string, resolutions: SyncResolution[] = []): SyncApplyResult {
    this.baseline()
    return this.atomic(() => {
      const preview = this.preview(); if (preview.token !== token) fail('SYNC_PREVIEW_STALE')
      if (!Array.isArray(resolutions)) fail('SYNC_INVALID_RESOLUTION')
      if (!preview.pendingBatches && !resolutions.length) return { applied: true, appliedBatches: 0, preview }
      const candidate = this.liveCompactRecords(), conflicts = candidate.filter(record => record.heads.length > 1)
      if (conflicts.length && !resolutions.length) return { applied: false, appliedBatches: 0, preview }
      if (resolutions.length !== conflicts.length) fail('SYNC_INVALID_RESOLUTION')
      for (const table of ['generation_runs', 'import_runs']) if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
        && this.database.prepare(`SELECT 1 FROM ${table} WHERE status='running' LIMIT 1`).get()) fail('SYNC_ACTIVE_OPERATION')
      let clock = mergeCompactClocks(this.clock(), this.clock(true))
      const replicaId = this.meta()!.replica_id
      if (resolutions.length) clock = mergeCompactClocks(clock, { [replicaId]: (clock[replicaId] ?? 0) + 1 })
      const seen = new Set<string>()
      const resolved = candidate.map(record => {
        if (record.heads.length === 1) return record
        const resolution = resolutions.find(choice => identity(choice) === identity(record)) ?? fail('SYNC_PREVIEW_STALE')
        if (seen.has(identity(record)) || !same([...resolution.expectedHeads].sort(), record.heads.map(head => head.revision).sort())) fail('SYNC_PREVIEW_STALE')
        const selected = record.heads.find(head => head.revision === resolution.selectedRevision) ?? fail('SYNC_INVALID_RESOLUTION'); seen.add(identity(record))
        const context = mergeCompactClocks(...record.heads.map(head => head.clock), { [replicaId]: clock[replicaId]! })
        return { ...record, heads: [createCompactHead(record.kind, record.id, context, selected.deleted, selected.value)] }
      })
      const projected = values(resolved); this.projection.validate(projected); this.projection.validateCandidate?.(this.database, projected)
      this.projection.apply(this.database, projected)
      if (!same([...recordsMap(this.projection.capture(this.database))].sort(), [...recordsMap(projected)].sort())) fail('SYNC_LOCAL_STATE_DIVERGED')
      this.write(resolved, true); this.write([], false); this.setClock(clock); this.setClock({}, true); this.pruneLegacy()
      return { applied: true, appliedBatches: preview.pendingBatches, preview: this.preview() }
    })
  }
  join(input: unknown): SyncApplyResult {
    const supplied = validateSyncBundle(input), bundle = supplied.compact ? supplied : convertLegacyBundleToCompact(supplied)
    if (bundle.compact!.mode !== 'snapshot') fail('SYNC_COMPACT_UPGRADE_REQUIRED')
    if (bundle.projectId !== this.projectId) fail('SYNC_PROJECT_ID_MISMATCH')
    if (this.meta()) fail('SYNC_ALREADY_ENABLED')
    return this.atomic(() => {
      const records = bundle.compact!.records
      this.validateCombined(records)
      // A fresh device may be the only surviving copy of an unresolved book.
      // Pick existing heads for a validated local display, retaining all source
      // heads in pending; this is not an authored conflict resolution.
      const ordered = records.map(record => ({ ...record, heads: [...record.heads].sort((left, right) =>
        (right.clock[bundle.senderReplicaId] ?? 0) - (left.clock[bundle.senderReplicaId] ?? 0) || left.revision.localeCompare(right.revision)) }))
      const choices = ordered.map(() => 0)
      let displayed: CompactRecord[] | undefined = bundle.compact!.accepted
      if (displayed) this.projection.validate(values(displayed))
      for (let attempt = 0; !displayed && attempt < 1024; attempt++) {
        const candidate = ordered.map((record, index) => ({ ...record, heads: [record.heads[choices[index]!]!] }))
        try { this.projection.validate(values(candidate)); displayed = candidate; break } catch { /* Try another existing combination. */ }
        let position = choices.length - 1
        while (position >= 0) {
          choices[position] = (choices[position] ?? 0) + 1
          if (choices[position]! < ordered[position]!.heads.length) break
          choices[position] = 0; position--
        }
        if (position < 0) break
      }
      if (!displayed) fail('SYNC_COMPACT_JOIN_SELECTION_REQUIRED')
      const accepted = displayed!, projected = values(accepted)
      this.database.prepare('INSERT INTO project_sync_meta VALUES(1,?,?)').run(this.projectId, randomUUID())
      this.database.prepare('INSERT INTO project_sync_compact_meta VALUES(1,?,?)').run(canonicalSyncJson(mergeCompactClocks(...accepted.flatMap(record => record.heads.map(head => head.clock)))), canonicalSyncJson(bundle.compact!.clock))
      this.projection.apply(this.database, projected)
      if (!same([...recordsMap(this.projection.capture(this.database))].sort(), [...recordsMap(projected)].sort())) fail('SYNC_LOCAL_STATE_DIVERGED')
      this.write(accepted, true); this.write(records.filter(record => !compactRecordsCover(accepted, [record])), false); this.pruneLegacy()
      return { applied: true, appliedBatches: records.length, preview: this.preview() }
    })
  }
  status(): SyncStatus {
    const meta = this.meta()
    if (!meta) return { enabled: false, projectId: this.projectId, replicaId: null, localBatches: 0, acknowledgedBatches: 0, pendingBatches: 0, conflicts: 0 }
    this.ensureReady(); const preview = this.preview()
    return { enabled: true, projectId: this.projectId, replicaId: meta.replica_id, localBatches: this.clock()[meta.replica_id] ?? 0,
      acknowledgedBatches: 0, pendingBatches: preview.pendingBatches, conflicts: preview.conflicts.length }
  }
}
