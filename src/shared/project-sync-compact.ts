import type { SyncJson } from './project-sync'

export type CompactClock = Record<string, number>
export interface CompactHead { revision: string; clock: CompactClock; deleted: boolean; value: SyncJson | null }
export interface CompactRecord { kind: string; id: string; heads: CompactHead[] }
export interface CompactSnapshot { protocol: 2; mode: 'snapshot' | 'delta'; clock: CompactClock; records: CompactRecord[]; accepted?: CompactRecord[] }

export function validateCompactSnapshot(input: unknown, digest: (value: unknown) => string): CompactSnapshot {
  const invalid = (): never => { throw new Error('SYNC_COMPACT_INVALID') }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',')
  const validClock = (value: unknown): value is CompactClock => object(value) && Object.keys(value).length <= 256 && Object.entries(value).every(([key, count]) =>
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(key) && Number.isSafeInteger(count) && Number(count) > 0)
  if (!object(input) || !exact(input, ['protocol', 'mode', 'clock', 'records', ...('accepted' in input ? ['accepted'] : [])]) || input.protocol !== 2
    || !['snapshot', 'delta'].includes(String(input.mode)) || !validClock(input.clock) || !Array.isArray(input.records) || input.records.length > 100_000) invalid()
  const snapshot = input as unknown as CompactSnapshot, identities = new Set<string>()
  for (const record of snapshot.records) {
    if (!object(record) || !exact(record, ['kind', 'id', 'heads']) || typeof record.kind !== 'string' || !/^[a-z][a-z0-9:_-]{0,95}$/.test(record.kind)
      || typeof record.id !== 'string' || !record.id.length || record.id.length > 512 || /[\u0000-\u001f]/.test(record.id)
      || !Array.isArray(record.heads) || !record.heads.length || record.heads.length > 256) invalid()
    const key = JSON.stringify([record.kind, record.id]); if (identities.has(key)) invalid(); identities.add(key)
    const revisions = new Set<string>()
    for (const head of record.heads) {
      if (!object(head) || !exact(head, ['revision', 'clock', 'deleted', 'value']) || !validClock(head.clock)
        || typeof head.deleted !== 'boolean' || head.deleted && head.value !== null || !/^[a-f0-9]{64}$/.test(String(head.revision))
        || !['equal', 'before'].includes(compareCompactClocks(head.clock, snapshot.clock))) invalid()
      if (revisions.has(head.revision)) invalid(); revisions.add(head.revision)
      if (head.revision !== digest({ kind: record.kind, id: record.id, clock: head.clock, deleted: head.deleted, value: head.value })) invalid()
    }
    if (mergeCompactRecords([record])[0]!.heads.length !== record.heads.length) invalid()
  }
  if (snapshot.accepted !== undefined) {
    if (snapshot.mode !== 'snapshot' || !snapshot.records.some(record => record.heads.length > 1) || !Array.isArray(snapshot.accepted) || snapshot.accepted.some(record => !Array.isArray(record.heads) || record.heads.length !== 1)) invalid()
    validateCompactSnapshot({ protocol: 2, mode: 'snapshot', clock: snapshot.clock, records: snapshot.accepted }, digest)
    if (!compactRecordsCover(snapshot.records, snapshot.accepted)) invalid()
  }
  return snapshot
}

/** Every target head must actually be present or causally superseded for this same record. */
export function compactRecordsCover(keeper: readonly CompactRecord[], target: readonly CompactRecord[]): boolean {
  const index = new Map(keeper.map(record => [JSON.stringify([record.kind, record.id]), record.heads]))
  return target.every(record => record.heads.every(head => index.get(JSON.stringify([record.kind, record.id]))?.some(other =>
    compareCompactClocks(other.clock, head.clock) === 'after' || compareCompactClocks(other.clock, head.clock) === 'equal' && other.revision === head.revision)))
}

export function compareCompactClocks(left: CompactClock, right: CompactClock): 'equal' | 'before' | 'after' | 'concurrent' {
  let less = false, more = false
  for (const replica of new Set([...Object.keys(left), ...Object.keys(right)])) {
    less ||= (left[replica] ?? 0) < (right[replica] ?? 0)
    more ||= (left[replica] ?? 0) > (right[replica] ?? 0)
  }
  return less ? more ? 'concurrent' : 'before' : more ? 'after' : 'equal'
}
export function mergeCompactClocks(...clocks: CompactClock[]): CompactClock {
  const result: CompactClock = {}
  for (const clock of clocks) for (const [replica, sequence] of Object.entries(clock)) result[replica] = Math.max(result[replica] ?? 0, sequence)
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)))
}

/** Merge per-record causal heads. Absence is never a deletion; tombstones are explicit heads. */
export function mergeCompactRecords(...sources: readonly CompactRecord[][]): CompactRecord[] {
  const records = new Map<string, CompactRecord>()
  for (const source of sources) for (const record of source) {
    const key = JSON.stringify([record.kind, record.id]), prior = records.get(key)
    const heads = [...(prior?.heads ?? []), ...record.heads], survivors: CompactHead[] = []
    for (const head of heads) {
      if (survivors.some(other => other.revision === head.revision)) continue
      for (const other of survivors) if (compareCompactClocks(head.clock, other.clock) === 'equal' && head.revision !== other.revision) throw new Error('SYNC_COMPACT_EQUIVOCATION')
      if (survivors.some(other => compareCompactClocks(head.clock, other.clock) === 'before')) continue
      for (let index = survivors.length - 1; index >= 0; index--) if (compareCompactClocks(head.clock, survivors[index]!.clock) === 'after') survivors.splice(index, 1)
      survivors.push(head)
    }
    records.set(key, { kind: record.kind, id: record.id, heads: survivors.sort((a, b) => a.revision.localeCompare(b.revision)) })
  }
  return [...records.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
}
