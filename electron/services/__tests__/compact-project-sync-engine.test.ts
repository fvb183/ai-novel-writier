import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema, verifySchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { CompactProjectSyncEngine, convertLegacyBundleToCompact, makeCompactBundle } from '../compact-project-sync-engine'
import { ProjectSyncEngine, syncDigest, type SyncProjection } from '../project-sync-engine'
import type { SyncBatch } from '../../../src/shared/project-sync'

const handles: Database.Database[] = []
afterEach(() => handles.splice(0).forEach(db => db.close()))
const projection: SyncProjection = {
  capture: db => (db.prepare('SELECT kind,entity_id,value_json FROM synthetic_author ORDER BY kind,entity_id').all() as Array<{kind:string;entity_id:string;value_json:string}>).map(row => ({kind:row.kind,id:row.entity_id,value:JSON.parse(row.value_json)})),
  validate: records => { for (const record of records) if (record.kind !== 'text' || typeof record.value !== 'string') throw new Error('BAD_AUTHOR_VALUE') },
  apply: (db,records) => { db.prepare('DELETE FROM synthetic_author').run(); const insert=db.prepare('INSERT INTO synthetic_author VALUES(?,?,?)'); for(const record of records) insert.run(record.kind,record.id,JSON.stringify(record.value)) },
}
function replica(projectId = randomUUID()) {
  const db = new Database(':memory:'); handles.push(db)
  initializeLegacyBaselineSchema(db); migrateSchema(new SqliteSchemaAdapter(db),getDesktopMigrationRegistry(),CURRENT_DESKTOP_SCHEMA_VERSION)
  verifySchema(new SqliteSchemaAdapter(db),getDesktopMigrationRegistry(),12)
  db.exec('CREATE TABLE synthetic_author(kind TEXT,entity_id TEXT,value_json TEXT,PRIMARY KEY(kind,entity_id))')
  db.prepare('INSERT INTO synthetic_author VALUES(?,?,?)').run('text','chapter1',JSON.stringify('初始正文'))
  const engine = new CompactProjectSyncEngine(db,projectId,projection)
  return {db,engine,projectId}
}
type Replica = ReturnType<typeof replica>
function write(target:Replica,value:string,id='chapter1') { target.engine.captureMutation(()=>target.db.prepare('INSERT INTO synthetic_author VALUES(?,?,?) ON CONFLICT(kind,entity_id) DO UPDATE SET value_json=excluded.value_json').run('text',id,JSON.stringify(value))) }
function remove(target:Replica,id='chapter1') { target.engine.captureMutation(()=>target.db.prepare('DELETE FROM synthetic_author WHERE entity_id=?').run(id)) }
const body=(target:Replica,id='chapter1')=>target.db.prepare('SELECT value_json FROM synthetic_author WHERE entity_id=?').pluck().get(id)
function join(a:Replica) { const b=replica(a.projectId); expect(b.engine.join(a.engine.exportBundle()).applied).toBe(true); return b }

describe('compact causal author snapshots',()=>{
  it('migrates a 3000-batch legacy save chain iteratively without retaining old prose or overflowing the call stack',()=>{
    const a=replica(),replicaId=randomUUID(),insert=a.db.prepare('INSERT INTO project_sync_batches VALUES(?,?,?,?,?,1)')
    a.db.prepare('INSERT INTO project_sync_meta VALUES(1,?,?)').run(a.projectId,replicaId)
    let previous:SyncBatch|undefined
    a.db.transaction(()=>{for(let sequence=1;sequence<=3000;sequence++){
      const body={protocol:1 as const,projectId:a.projectId,replicaId,sequence,previousHash:previous?.hash??null,batchId:randomUUID(),changes:[{kind:'text',id:'chapter1',parents:previous?[`${previous.hash}:0`]:[],deleted:false,value:`旧链正文 ${sequence}`}]}
      const batch={...body,hash:syncDigest(body)};insert.run(batch.batchId,replicaId,sequence,batch.hash,JSON.stringify(batch));previous=batch
    }})()
    a.db.prepare('UPDATE synthetic_author SET value_json=?').run(JSON.stringify('旧链正文 3000'))
    expect(a.engine.status().localBatches).toBe(3000)
    expect(a.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(0)
    const compact=JSON.stringify(a.engine.exportBundle())
    expect(compact).toContain('旧链正文 3000');expect(compact).not.toContain('旧链正文 2999');expect(compact.length).toBeLessThan(1500)
  },20000)
  it('installs only through registered schema12 migration and keeps 100 prose saves bounded without old values',()=>{
    const a=replica();a.engine.enable(); const initial=JSON.stringify(a.engine.exportBundle()).length
    for(let index=0;index<100;index++) write(a,`当前正文 ${String(index).padStart(3,'0')}`)
    const snapshot=a.engine.exportBundle()
    expect(snapshot.compact!.records).toHaveLength(1)
    expect(snapshot.compact!.records[0]!.heads).toHaveLength(1)
    expect(JSON.stringify(snapshot)).toContain('当前正文 099');expect(JSON.stringify(snapshot)).not.toContain('当前正文 098')
    expect(JSON.stringify(snapshot).length).toBeLessThan(initial+100)
    expect(a.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(0)
    expect(a.db.prepare('SELECT COUNT(*) FROM project_sync_compact_records').pluck().get()).toBe(1)
    expect(Number(a.db.prepare('SELECT SUM(length(heads_json)) FROM project_sync_compact_records').pluck().get())).toBeLessThan(1000)
  })
  it('preserves concurrent saved bodies and removes the unselected old value after resolution',()=>{
    const a=replica();a.engine.enable();const b=join(a)
    write(a,'电脑并发稿');write(b,'手机并发稿')
    const preview=a.engine.receive(b.engine.exportBundle());expect(preview.conflicts).toHaveLength(1)
    expect(a.engine.apply(preview.token).applied).toBe(false)
    const conflict=preview.conflicts[0]!,selected=conflict.variants.find(variant=>variant.value==='手机并发稿')!
    a.engine.apply(preview.token,[{kind:conflict.kind,id:conflict.id,expectedHeads:conflict.variants.map(variant=>variant.revision),selectedRevision:selected.revision}])
    const updated=b.engine.receive(a.engine.exportBundle());expect(updated.conflicts).toHaveLength(0);b.engine.apply(updated.token)
    expect(body(a)).toBe(JSON.stringify('手机并发稿'));expect(body(b)).toBe(body(a))
    expect(JSON.stringify(a.engine.exportBundle())).not.toContain('电脑并发稿')
  })
  it('does not allow an old offline snapshot to resurrect a deleted record',()=>{
    const a=replica();a.engine.enable();const offline=join(a);remove(a)
    for(let index=0;index<100;index++) write(a,`另一章 ${index}`,'chapter2')
    const result=a.engine.receive(offline.engine.exportBundle());expect(result.conflicts).toHaveLength(0)
    expect(result.pendingBatches).toBe(0);expect(body(a)).toBeUndefined()
    const tombstone=a.engine.exportBundle().compact!.records.find(record=>record.id==='chapter1')!
    expect(tombstone.heads[0]!.deleted).toBe(true);expect(tombstone.heads[0]!.value).toBeNull()
  })
  it('retains a concurrent delete versus offline edit as a conflict',()=>{
    const a=replica();a.engine.enable();const offline=join(a);remove(a);write(offline,'离线修改的正文')
    const result=a.engine.receive(offline.engine.exportBundle());expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.variants.some(variant=>variant.deleted)).toBe(true)
    expect(result.conflicts[0]!.variants.some(variant=>variant.value==='离线修改的正文')).toBe(true)
  })
  it('never uses unapplied pending clocks to silently supersede the remote body',()=>{
    const a=replica();a.engine.enable();const b=join(a);write(a,'已收到但尚未应用的电脑稿')
    b.engine.receive(a.engine.exportBundle());write(b,'继续编辑本地手机稿')
    const preview=b.engine.preview();expect(preview.conflicts).toHaveLength(1)
    expect(JSON.stringify(preview.conflicts)).toContain('已收到但尚未应用的电脑稿')
    expect(JSON.stringify(preview.conflicts)).toContain('继续编辑本地手机稿')
  })
  it('uses per-record context when a delta advertises a global counter from a record not yet received',()=>{
    const a=replica();a.engine.enable();write(a,'第二章基线','chapter2');const b=join(a)
    write(a,'手机尚未看到的第一章');write(a,'只先收到第二章','chapter2')
    const full=a.engine.exportBundle(),compact=full.compact!
    const partial=makeCompactBundle(a.projectId,full.senderReplicaId,{...compact,mode:'delta',records:compact.records.filter(record=>record.id==='chapter2')})
    const received=b.engine.receive(partial);b.engine.apply(received.token)
    write(b,'未看见电脑第一章时的手机编辑')
    const merged=b.engine.receive(full)
    expect(merged.conflicts).toHaveLength(1)
    expect(merged.conflicts[0]!.id).toBe('chapter1')
  })
  it('converts legacy chains once and compares an upgraded long-offline author edit after 100 compact saves',()=>{
    const a=replica(),legacyA=new ProjectSyncEngine(a.db,a.projectId,projection);legacyA.enable()
    const b=replica(a.projectId),legacyB=new ProjectSyncEngine(b.db,b.projectId,projection);legacyB.join(legacyA.exportBundle())
    legacyA.captureMutation(()=>a.db.prepare('UPDATE synthetic_author SET value_json=?').run(JSON.stringify('电脑旧版保存')))
    legacyB.captureMutation(()=>b.db.prepare('UPDATE synthetic_author SET value_json=?').run(JSON.stringify('手机旧版离线保存')))
    const converted=convertLegacyBundleToCompact(legacyA.exportBundle());expect(converted.compact!.records).toHaveLength(1)
    a.engine.status();b.engine.status()
    expect(a.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(0)
    expect(b.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(0)
    for(let index=0;index<100;index++) write(a,`升级后电脑稿 ${index}`)
    const result=b.engine.receive(a.engine.exportBundle());expect(result.conflicts).toHaveLength(1)
    expect(JSON.stringify(result.conflicts)).toContain('手机旧版离线保存')
    expect(JSON.stringify(result.conflicts)).toContain('升级后电脑稿 99')
  })
  it('rolls author data and compact heads back together after an outer transaction failure',()=>{
    const a=replica();a.engine.enable();const before=a.engine.exportBundle()
    expect(()=>a.db.transaction(()=>a.engine.captureTransaction(()=>{write(a,'不应提交');throw new Error('rollback')}))()).toThrow('rollback')
    expect(a.engine.exportBundle()).toEqual(before)
  })
})
