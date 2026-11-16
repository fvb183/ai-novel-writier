import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { SyncRecord, SyncResolution } from '../../../src/shared/project-sync'
import { canonicalSyncJson, ProjectSyncEngine, type SyncProjection } from '../project-sync-engine'
import { mergeCompactClocks, mergeCompactRecords } from '../../../src/shared/project-sync-compact'
import { CompactProjectSyncEngine, makeCompactBundle } from '../compact-project-sync-engine'
import { PROJECT_SYNC_SQL } from '../project-sync-schema'
import { COMPACT_SYNC_SQL } from '../../migrations/m12-compact-sync'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
function replica(projectId = randomUUID(), initial: SyncRecord[] = [{ kind: 'core', id: 'chapter', value: '共同初稿' }]) {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON')
  db.exec('CREATE TABLE drafts(id INTEGER PRIMARY KEY,chapter_number INTEGER,status TEXT,version INTEGER)')
  db.exec(PROJECT_SYNC_SQL); db.exec(COMPACT_SYNC_SQL)
  db.exec('CREATE TABLE author_records(kind TEXT,id TEXT,value TEXT,PRIMARY KEY(kind,id))')
  const put = (record: SyncRecord) => db.prepare('INSERT OR REPLACE INTO author_records VALUES(?,?,?)').run(record.kind, record.id, canonicalSyncJson(record.value))
  initial.forEach(put)
  let rejectProjection = false, applyCount = 0
  const projection: SyncProjection = {
    capture: () => (db.prepare('SELECT * FROM author_records ORDER BY kind,id').all() as Array<{ kind: string; id: string; value: string }>).map(record => ({ ...record, value: JSON.parse(record.value) })),
    validate: () => {},
    apply(_db, records) {
      applyCount++
      if (rejectProjection) throw Error('synthetic projection failure')
      db.prepare('DELETE FROM author_records').run(); records.forEach(put)
    },
  }
  const engine = new CompactProjectSyncEngine(db, projectId, projection)
  const legacy = new ProjectSyncEngine(db, projectId, projection)
  return { db, projectId, engine, legacy, projection, records: () => projection.capture(db), applyCount: () => applyCount, rejectProjection: () => { rejectProjection = true },
    edit(value: string, kind = 'core', id = 'chapter') { engine.captureMutation(() => put({ kind, id, value })) },
    legacyEdit(value: string) { legacy.captureMutation(() => put({ kind: 'core', id: 'chapter', value })) },
    remove() { engine.captureMutation(() => db.prepare("DELETE FROM author_records WHERE kind='core' AND id='chapter'").run()) } }
}
function pair() {
  const a = replica(); a.engine.enable()
  const b = replica(a.projectId, []); expect(b.engine.join(a.engine.exportBundle()).applied).toBe(true)
  return { a, b }
}

describe('independent real compact engine review', () => {
  it('does not silently resolve a joined chapter conflict through a causal clock from another displayed record', () => {
    const { a, b } = pair()
    a.edit('电脑独立稿'); b.edit('手机独立稿'); b.edit('手机新增设定', 'core', 'setting')
    const packages = [a.engine.exportBundle(), b.engine.exportBundle()]
    const bundle = makeCompactBundle(a.projectId, a.engine.status().replicaId!, { protocol: 2, mode: 'snapshot', clock: mergeCompactClocks(...packages.map(value => value.compact!.clock)), records: mergeCompactRecords(...packages.map(value => value.compact!.records)) })
    const c = replica(a.projectId, [])
    expect(c.engine.join(bundle).applied).toBe(true)
    expect(c.records().find(record => record.id === 'chapter')!.value).toBe('电脑独立稿')
    expect(c.engine.preview().conflicts[0].variants).toHaveLength(2)
    c.edit('继续修改本地显示的电脑稿')
    const variants = c.engine.preview().conflicts.find(conflict => conflict.id === 'chapter')?.variants ?? []
    expect(variants.map(variant => variant.value).sort()).toEqual(['继续修改本地显示的电脑稿', '手机独立稿'].sort())
  })

  it('does not pretend an unapplied remote manuscript was already observed by a new local write', () => {
    const { a, b } = pair(); a.edit('尚未采用的云端新稿')
    b.engine.receive(a.engine.exportBundle())
    b.edit('作者继续修改旧基准的手机稿')
    const variants = b.engine.preview().conflicts[0].variants
    expect(variants.map(variant => variant.value).sort()).toEqual(['作者继续修改旧基准的手机稿', '尚未采用的云端新稿'].sort())
    const accepted = b.engine.exportBundle().compact!
    const remoteId = a.engine.status().replicaId!
    expect(accepted.clock[remoteId]).toBe(1)
    expect(b.records()[0].value).toBe('作者继续修改旧基准的手机稿')
  })

  it('does not write business data when the received package is already applied', () => {
    const { a, b } = pair(), before = b.applyCount()
    const preview = b.engine.receive(a.engine.exportBundle())
    b.rejectProjection()
    expect(b.engine.apply(preview.token)).toMatchObject({ applied: true, appliedBatches: 0 })
    expect(b.applyCount()).toBe(before)
  })

  it.each(['generation_runs', 'import_runs'])('blocks applying incoming content while %s is active', table => {
    const { a, b } = pair(); a.edit('远端新稿')
    const preview = b.engine.receive(a.engine.exportBundle()), before = b.records()
    b.db.exec(`CREATE TABLE ${table}(status TEXT); INSERT INTO ${table} VALUES('running')`)
    expect(() => b.engine.apply(preview.token)).toThrow('SYNC_ACTIVE_OPERATION')
    expect(b.records()).toEqual(before)
    b.db.prepare(`UPDATE ${table} SET status='paused'`).run()
    expect(b.engine.apply(preview.token).applied).toBe(true)
    expect(b.records()[0].value).toBe('远端新稿')
  })

  it('keeps delete/edit conflict alternatives while stale unchanged snapshots cannot resurrect a deletion', () => {
    const { a, b } = pair(), old = b.engine.exportBundle()
    a.remove()
    expect(a.engine.receive(old).conflicts).toEqual([])
    expect(a.engine.apply(a.engine.preview().token).applied).toBe(true)
    expect(a.records()).toEqual([])
    b.edit('离线手机的新正文')
    const conflict = a.engine.receive(b.engine.exportBundle()).conflicts[0]
    expect(conflict.variants).toHaveLength(2)
    expect(conflict.variants.some(variant => variant.deleted)).toBe(true)
    expect(conflict.variants.some(variant => variant.value === '离线手机的新正文')).toBe(true)
    expect(a.records()).toEqual([])
  })

  it('migrates both old offline replicas without replaying obsolete prose or overwriting either new draft', () => {
    const a = replica(); a.legacy.enable()
    const b = replica(a.projectId, []); b.legacy.join(a.legacy.exportBundle())
    a.legacyEdit('电脑最终新稿'); b.legacyEdit('手机长期离线新稿')
    const oldReplicaId = b.legacy.status().replicaId
    a.engine.enable(); b.engine.enable()
    expect(b.engine.status().replicaId).toBe(oldReplicaId)
    expect(a.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(0)
    expect(b.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(0)
    expect(JSON.stringify(a.engine.exportBundle())).not.toContain('共同初稿')
    const preview = b.engine.receive(a.engine.exportBundle()), conflict = preview.conflicts[0]
    expect(conflict.variants.map(variant => variant.value).sort()).toEqual(['电脑最终新稿', '手机长期离线新稿'].sort())
    const choice: SyncResolution = { kind: conflict.kind, id: conflict.id, expectedHeads: conflict.variants.map(variant => variant.revision), selectedRevision: conflict.variants.find(variant => variant.value === '手机长期离线新稿')!.revision }
    expect(b.engine.apply(preview.token, [choice]).applied).toBe(true)
    const confirmation = a.engine.receive(b.engine.exportBundle())
    expect(a.engine.apply(confirmation.token).applied).toBe(true)
    expect(a.records()).toEqual(b.records()); expect(a.records()[0].value).toBe('手机长期离线新稿')
    expect(JSON.stringify(b.engine.exportBundle())).not.toContain('电脑最终新稿')
  })

  it('rolls back a failed projection without consuming the pending remote draft', () => {
    const { a, b } = pair(); a.edit('待应用远端稿')
    const preview = b.engine.receive(a.engine.exportBundle()), before = b.records()
    b.rejectProjection()
    expect(() => b.engine.apply(preview.token)).toThrow('synthetic projection failure')
    expect(b.records()).toEqual(before); expect(b.engine.preview().pendingBatches).toBeGreaterThan(0)
  })
})
