import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../desktop-registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter } from '../sqlite-schema-adapter'
import { ProjectSyncEngine } from '../../services/project-sync-engine'
import { CompactProjectSyncEngine } from '../../services/compact-project-sync-engine'
import { projectSyncProjection } from '../../services/project-sync-projection'
import { assertPortableSourceSchema } from '../../services/portable-project-format'

it('migrates the recognized schema11 lane to12 without rewriting domain or legacy outbox before explicit compact adoption',()=>{
  const db=new Database(':memory:')
  try{
    initializeLegacyBaselineSchema(db);const adapter=new SqliteSchemaAdapter(db),registry=getDesktopMigrationRegistry()
    migrateSchema(adapter,registry,11);db.prepare("INSERT INTO project_core(id,project_name) VALUES('main','M12真实迁移')").run()
    const projectId=randomUUID(),legacy=new ProjectSyncEngine(db,projectId,projectSyncProjection)
    legacy.enable();legacy.captureMutation(()=>db.prepare("UPDATE project_core SET genre='保留的作者设定' WHERE id='main'").run())
    const rows=db.prepare('SELECT * FROM project_sync_batches ORDER BY hash').all(),oldReplica=legacy.status().replicaId
    expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(12)
    migrateSchema(adapter,registry,12);verifySchema(adapter,registry,12)
    expect(db.prepare('SELECT * FROM project_sync_batches ORDER BY hash').all()).toEqual(rows)
    expect(db.prepare('SELECT COUNT(*) FROM project_sync_compact_meta').pluck().get()).toBe(0)
    expect(assertPortableSourceSchema(db).tables).toBeGreaterThan(0)
    const compact=new CompactProjectSyncEngine(db,projectId);expect(compact.status().replicaId).toBe(oldReplica)
    expect(db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(0)
    expect(db.prepare("SELECT genre FROM project_core WHERE id='main'").pluck().get()).toBe('保留的作者设定')
    expect(compact.exportBundle().minimumReaderSchemaVersion).toBe(12)
    expect(compact.exportBundle().compact!.records.some(record=>record.kind.startsWith('history:'))).toBe(false)
  }finally{db.close()}
})
