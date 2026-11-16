import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { SyncBundle, SyncRecord } from '../../../src/shared/project-sync'
import { PROJECT_SYNC_SQL } from '../project-sync-schema'
import { ProjectSyncEngine, canonicalSyncJson, syncDigest, type SyncProjection } from '../project-sync-engine'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function replica(projectId = randomUUID(), initial: SyncRecord[] = [{ kind: 'core', id: 'title', value: '共同初稿' }]) {
  const db = new Database(':memory:'); databases.push(db)
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE drafts(id INTEGER PRIMARY KEY,chapter_number INTEGER,status TEXT,version INTEGER)')
  db.exec(PROJECT_SYNC_SQL)
  db.exec('CREATE TABLE author_records(kind TEXT,id TEXT,value TEXT,PRIMARY KEY(kind,id))')
  const put = (record: SyncRecord) => db.prepare('INSERT OR REPLACE INTO author_records VALUES(?,?,?)').run(record.kind, record.id, canonicalSyncJson(record.value))
  for (const record of initial) put(record)
  let rejectProjection = false
  const projection: SyncProjection = {
    capture: () => (db.prepare('SELECT * FROM author_records ORDER BY kind,id').all() as Array<{ kind: string; id: string; value: string }>).map(row => ({ ...row, value: JSON.parse(row.value) })),
    validate(records) { if (records.some(record => !['core', 'draft', 'finalization:1'].includes(record.kind))) throw new Error('UNSUPPORTED_KIND') },
    apply(_db, records) {
      db.prepare('DELETE FROM author_records').run()
      for (const record of records) put(record)
      if (rejectProjection) throw new Error('projection interrupted')
    },
  }
  const engine = new ProjectSyncEngine(db, projectId, projection)
  return { db, engine, projectId, records: () => projection.capture(db), rejectProjection: () => { rejectProjection = true },
    edit(record: SyncRecord) { engine.captureMutation(() => put(record)) },
    remove(kind: string, id: string) { engine.captureMutation(() => db.prepare('DELETE FROM author_records WHERE kind=? AND id=?').run(kind, id)) } }
}
function pair(initial?: SyncRecord[]) {
  const a = replica(undefined, initial); a.engine.enable()
  const b = replica(a.projectId, []); b.engine.join(a.engine.exportBundle())
  return { a, b }
}
function deliver(from: ReturnType<typeof replica>, to: ReturnType<typeof replica>) {
  const preview = to.engine.receive(from.engine.exportBundle())
  return to.engine.apply(preview.token)
}
function rehash(bundle: SyncBundle): SyncBundle {
  const { hash: _hash, ...body } = bundle
  return { ...body, hash: syncDigest(body) }
}

describe('local two-replica immutable synchronization', () => {
  it('refuses a cloned physical replica from extending the local sequence', () => {
    const { a, b } = pair()
    b.edit({ kind: 'core', id: 'title', value: '复制设备写入' })
    a.db.prepare('UPDATE project_sync_meta SET replica_id=?').run(b.engine.status().replicaId)
    expect(() => a.engine.receive(b.engine.exportBundle())).toThrow('SYNC_REPLICA_ID_REUSED')
    expect(a.engine.status().pendingBatches).toBe(0)
  })
  it('blocks incoming application during active generation and permits retry after pause', () => {
    const { a, b } = pair()
    a.edit({ kind: 'core', id: 'genre', value: '科幻' })
    const preview = b.engine.receive(a.engine.exportBundle())
    b.db.exec("CREATE TABLE generation_runs(status TEXT); INSERT INTO generation_runs VALUES('running')")
    expect(() => b.engine.apply(preview.token)).toThrow('SYNC_ACTIVE_OPERATION')
    expect(b.records()).toHaveLength(1)
    b.db.prepare("UPDATE generation_runs SET status='paused'").run()
    expect(b.engine.apply(preview.token).applied).toBe(true)
  })
  it('does not rewrite domain state when applying a duplicate package', () => {
    const { a, b } = pair(); b.rejectProjection()
    const preview = b.engine.receive(a.engine.exportBundle())
    expect(b.engine.apply(preview.token)).toMatchObject({ applied: true, appliedBatches: 0 })
  })
  it('joins the same project with a distinct replica and preserves independent edits', () => {
    const { a, b } = pair()
    expect(a.engine.status().replicaId).not.toBe(b.engine.status().replicaId)
    a.edit({ kind: 'core', id: 'title', value: '电脑标题' }); b.edit({ kind: 'core', id: 'genre', value: '手机类型' })
    expect(deliver(a, b).applied).toBe(true); expect(deliver(b, a).applied).toBe(true)
    expect(a.records()).toEqual(b.records())
    expect(a.records()).toHaveLength(2)
    expect(a.engine.status().acknowledgedBatches).toBe(a.engine.status().localBatches)
  })
  it('rolls back business writes and their outbox together', () => {
    const { a } = pair(); const before = a.engine.exportBundle()
    expect(() => a.engine.captureMutation(() => {
      a.db.prepare("UPDATE author_records SET value='\"lost\"'").run(); throw new Error('interrupted')
    })).toThrow('interrupted')
    expect(a.engine.exportBundle()).toEqual(before)
    expect(a.records()[0]!.value).toBe('共同初稿')
  })
  it('keeps concurrent same-number drafts as independent stable identities', () => {
    const { a, b } = pair()
    a.edit({ kind: 'draft', id: randomUUID(), value: { chapter: 1, requestedVersion: 2, content: '甲' } })
    b.edit({ kind: 'draft', id: randomUUID(), value: { chapter: 1, requestedVersion: 2, content: '乙' } })
    expect(deliver(a, b).applied).toBe(true); expect(deliver(b, a).applied).toBe(true)
    expect(a.records().filter(record => record.kind === 'draft')).toHaveLength(2)
    expect(a.records()).toEqual(b.records())
  })
  it('preserves both conflicting texts until an explicit causal resolution converges', () => {
    const { a, b } = pair(); const original = a.engine.exportBundle().batches[0]!
    a.edit({ kind: 'core', id: 'title', value: '甲的正文' }); b.edit({ kind: 'core', id: 'title', value: '乙的正文' })
    const preview = b.engine.receive(a.engine.exportBundle())
    expect(preview.conflicts).toHaveLength(1); expect(b.engine.apply(preview.token).applied).toBe(false)
    expect(b.records()[0]!.value).toBe('乙的正文')
    const conflict = preview.conflicts[0]!
    b.engine.apply(preview.token, [{ kind: conflict.kind, id: conflict.id, expectedHeads: conflict.variants.map(variant => variant.revision), selectedRevision: conflict.variants.find(variant => variant.value === '甲的正文')!.revision }])
    expect(deliver(b, a).applied).toBe(true); expect(a.records()).toEqual(b.records())
    expect(b.engine.exportBundle().batches.find(batch => batch.batchId === original.batchId)).toEqual(original)
    expect(b.engine.exportBundle().batches.flatMap(batch => batch.changes).some(change => change.value === '乙的正文')).toBe(true)
  })
  it('retains delete/edit conflicts and accepts an explicit delete without losing history', () => {
    const { a, b } = pair(); a.remove('core', 'title'); b.edit({ kind: 'core', id: 'title', value: '未丢失正文' })
    const preview = b.engine.receive(a.engine.exportBundle()), conflict = preview.conflicts[0]!
    expect(conflict.variants.some(variant => variant.deleted)).toBe(true)
    expect(b.engine.apply(preview.token).applied).toBe(false)
    b.engine.apply(preview.token, [{ kind: conflict.kind, id: conflict.id, expectedHeads: conflict.variants.map(variant => variant.revision), selectedRevision: conflict.variants.find(variant => variant.deleted)!.revision }])
    expect(deliver(b, a).applied).toBe(true); expect(a.records()).toEqual([])
    expect(b.engine.exportBundle().batches.flatMap(batch => batch.changes).some(change => change.value === '未丢失正文')).toBe(true)
  })
  it('treats competing finalized heads as a conflict instead of choosing a display number', () => {
    const { a, b } = pair([{ kind: 'finalization:1', id: 'head', value: 'draft-baseline' }])
    a.edit({ kind: 'finalization:1', id: 'head', value: 'desktop-v2' }); b.edit({ kind: 'finalization:1', id: 'head', value: 'phone-v2' })
    expect(deliver(a, b).applied).toBe(false)
    expect(b.records()[0]!.value).toBe('phone-v2')
  })
  it('rejects stale previews and leaves newly typed changes intact', () => {
    const { a, b } = pair(); a.edit({ kind: 'core', id: 'genre', value: '科幻' })
    const preview = b.engine.receive(a.engine.exportBundle())
    b.edit({ kind: 'core', id: 'title', value: '预览后输入' })
    expect(() => b.engine.apply(preview.token)).toThrow('SYNC_PREVIEW_STALE')
    expect(b.records().find(record => record.id === 'title')!.value).toBe('预览后输入')
  })
  it('deduplicates repeated delivery and retries a failed atomic projection', () => {
    const { a, b } = pair(); a.edit({ kind: 'core', id: 'genre', value: '奇幻' })
    const bundle = a.engine.exportBundle(), preview = b.engine.receive(bundle)
    b.engine.receive(bundle); expect(b.engine.preview().pendingBatches).toBe(1)
    const before = b.records(); b.rejectProjection()
    expect(() => b.engine.apply(preview.token)).toThrow('projection interrupted')
    expect(b.records()).toEqual(before); expect(b.engine.preview().pendingBatches).toBe(1)
  })
  it('waits for missing causal batches and handles reverse-order package arrival', () => {
    const { a, b } = pair(); a.edit({ kind: 'core', id: 'title', value: '一' }); a.edit({ kind: 'core', id: 'title', value: '二' })
    const bundle = a.engine.exportBundle(), last = bundle.batches.find(batch => batch.sequence === 3)!
    const preview = b.engine.receive(rehash({ ...bundle, batches: [last] }))
    expect(preview.missingBatchHashes).toHaveLength(1); expect(b.engine.apply(preview.token).applied).toBe(false)
    expect(deliver(a, b).applied).toBe(true); expect(b.records()[0]!.value).toBe('二')
    expect(deliver(a, b).appliedBatches).toBe(0)
  })
  it('rejects tampering, project mismatch and duplicate sequence equivocation', () => {
    const { a, b } = pair(), bundle = a.engine.exportBundle()
    expect(() => b.engine.receive({ ...bundle, hash: '0'.repeat(64) })).toThrow('SYNC_PACKAGE_HASH_MISMATCH')
    const other = replica(); other.engine.enable()
    expect(() => other.engine.receive(bundle)).toThrow('SYNC_PROJECT_ID_MISMATCH')
    const changed = structuredClone(bundle), first = changed.batches[0]!
    first.changes[0]!.value = '篡改'; const { hash: _hash, ...body } = first; first.hash = syncDigest(body)
    expect(() => b.engine.receive(rehash(changed))).toThrow('SYNC_BATCH_EQUIVOCATION')
  })
  it('rejects unsafe JSON and unsupported projections before author data changes', () => {
    expect(() => canonicalSyncJson(JSON.parse('{"__proto__":{}}'))).toThrow('SYNC_INVALID_DOCUMENT')
    const { a, b } = pair(), bundle = a.engine.exportBundle()
    const future = structuredClone(bundle), first = future.batches[0]!
    first.changes[0]!.kind = 'remote-execution'; const { hash: _hash, ...body } = first; first.hash = syncDigest(body)
    const fresh = replica(a.projectId, [])
    expect(() => fresh.engine.join(rehash(future))).toThrow('UNSUPPORTED_KIND')
    expect(fresh.engine.status().enabled).toBe(false); expect(fresh.records()).toEqual([])
    expect(b.records()).toEqual(a.records())
  })
})
