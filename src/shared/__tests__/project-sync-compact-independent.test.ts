import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compareCompactClocks, mergeCompactClocks, mergeCompactRecords, type CompactClock, type CompactHead, type CompactRecord } from '../project-sync-compact'

const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
const C = '00000000-0000-4000-8000-000000000003'
function record(id: string, value: string | null, clock: CompactClock, deleted = false): CompactRecord[] {
  const body = { kind: 'core', id, clock, deleted, value }
  const head: CompactHead = { revision: createHash('sha256').update(JSON.stringify(body)).digest('hex'), clock, deleted, value }
  return [{ kind: body.kind, id, heads: [head] }]
}
const permutations = <T,>(values: T[]): T[][] => values.length ? values.flatMap((value, index) => permutations(values.filter((_, offset) => offset !== index)).map(tail => [value, ...tail])) : [[]]

describe('independent compact causal merge review', () => {
  it('compares causal order rather than largest counter, device order or wall-clock time', () => {
    expect(compareCompactClocks({ [A]: 900 }, { [A]: 1, [B]: 2 })).toBe('concurrent')
    expect(compareCompactClocks({ [A]: 2 }, { [A]: 2, [B]: 1 })).toBe('before')
    expect(compareCompactClocks({ [A]: 2, [B]: 1 }, { [A]: 2 })).toBe('after')
    expect(compareCompactClocks({ [A]: 2, [B]: 1 }, { [B]: 1, [A]: 2 })).toBe('equal')
  })

  it('does not resurrect a deleted record when a long-offline unchanged snapshot returns', () => {
    const deleted = record('chapter', null, { [A]: 300 }, true)
    const obsolete = record('chapter', '旧离线正文', { [A]: 1 })
    for (const ordered of permutations([deleted, obsolete])) expect(mergeCompactRecords(...ordered)).toEqual(deleted)
  })

  it('retains both a deletion and an independently edited offline manuscript', () => {
    const deleted = record('chapter', null, { [A]: 300 }, true)
    const offlineEdit = record('chapter', '离线手机新正文', { [A]: 1, [B]: 4 })
    const merged = mergeCompactRecords(deleted, offlineEdit)
    expect(merged[0].heads).toHaveLength(2)
    expect(merged[0].heads.some(head => head.deleted)).toBe(true)
    expect(merged[0].heads.some(head => head.value === '离线手机新正文')).toBe(true)
    expect(mergeCompactRecords(offlineEdit, deleted)).toEqual(merged)
  })

  it('treats snapshot omission as unknown rather than silently deleting another device record', () => {
    const local = record('chapter', '电脑已保存正文', { [A]: 6 })
    const incomingOtherRecord = record('setting', '手机修改设定', { [A]: 1, [B]: 50 })
    const merged = mergeCompactRecords(local, incomingOtherRecord)
    expect(merged).toHaveLength(2)
    expect(merged.find(item => item.id === 'chapter')?.heads[0].value).toBe('电脑已保存正文')
  })

  it('isolates record causality: a high counter on a different record does not resolve a chapter conflict', () => {
    const desktop = record('chapter', '电脑稿', { [A]: 9 })
    const phone = record('chapter', '手机稿', { [A]: 1, [B]: 7 })
    const unrelated = record('setting', '已经合并的设定', { [A]: 100, [B]: 100 })
    const merged = mergeCompactRecords(desktop, phone, unrelated)
    expect(merged.find(item => item.id === 'chapter')?.heads).toHaveLength(2)
    expect(merged.find(item => item.id === 'setting')?.heads).toHaveLength(1)
  })

  it('converges in every delivery order and is associative/idempotent across three concurrent peers', () => {
    const peers = [record('chapter', '电脑稿', { [A]: 2 }), record('chapter', '手机稿', { [A]: 1, [B]: 1 }), record('chapter', '平板稿', { [A]: 1, [C]: 1 })]
    const expected = mergeCompactRecords(...peers)
    expect(expected[0].heads).toHaveLength(3)
    for (const ordered of permutations(peers)) {
      expect(mergeCompactRecords(...ordered)).toEqual(expected)
      expect(mergeCompactRecords(mergeCompactRecords(ordered[0], ordered[1]), ordered[2])).toEqual(expected)
      expect(mergeCompactRecords(expected, ...ordered, expected)).toEqual(expected)
    }
  })

  it('keeps only the explicit resolution after its clock covers all conflicting variants', () => {
    const desktop = record('chapter', '电脑稿', { [A]: 9 })
    const phone = record('chapter', '手机稿', { [A]: 1, [B]: 7 })
    const deletion = record('chapter', null, { [A]: 1, [C]: 2 }, true)
    const resolved = record('chapter', '作者采用手机稿', { [A]: 9, [B]: 8, [C]: 2 })
    for (const ordered of permutations([desktop, phone, deletion, resolved])) expect(mergeCompactRecords(...ordered)).toEqual(resolved)
  })

  it('rejects contradictory bodies claiming the same record clock', () => {
    const original = record('chapter', '真实正文', { [A]: 5, [B]: 2 })
    const changed = record('chapter', '同版本被篡改', { [B]: 2, [A]: 5 })
    expect(() => mergeCompactRecords(original, changed)).toThrow('SYNC_COMPACT_EQUIVOCATION')
    expect(() => mergeCompactRecords(changed, original)).toThrow('SYNC_COMPACT_EQUIVOCATION')
  })

  it('merges clocks without mutation and preserves all device counters', () => {
    const first = Object.freeze({ [A]: 8, [B]: 1 }), second = Object.freeze({ [A]: 2, [C]: 4 })
    expect(mergeCompactClocks(first, second)).toEqual({ [A]: 8, [B]: 1, [C]: 4 })
    expect(first).toEqual({ [A]: 8, [B]: 1 }); expect(second).toEqual({ [A]: 2, [C]: 4 })
  })
})
