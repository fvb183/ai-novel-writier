import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { createMigrationRegistry } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { STORY_TABLES } from '../../services/story-branch-schema'
import { ProjectSyncEngine } from '../../services/project-sync-engine'
import { projectSyncProjection } from '../../services/project-sync-projection'
import { randomUUID } from 'node:crypto'

function fixture() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
  db.prepare("INSERT INTO project_core(id,project_name) VALUES('main','原作品')").run()
  db.prepare("INSERT INTO contents(body) VALUES('原稿与历史保留')").run()
  return db
}
it('installs M08 from the registered schema 8 without changing existing author data or replica history', () => {
  const db = fixture()
  try {
    const before = db.prepare('SELECT * FROM contents').all()
    const adapter = new SqliteSchemaAdapter(db), registry = getDesktopMigrationRegistry()
    expect(migrateSchema(adapter, registry, 9).completedSteps).toEqual(['M08'])
    expect(db.prepare('SELECT * FROM contents').all()).toEqual(before)
    for (const table of STORY_TABLES) expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0)
    expect(verifySchema(adapter, registry, 9).version).toBe(9)
    expect(migrateSchema(adapter, registry, 9).completedSteps).toEqual([])
  } finally { db.close() }
})
it('rolls back all story tables and user_version when M08 verification fails', () => {
  const db = fixture()
  try {
    const original = getDesktopMigrationRegistry(), fingerprint = sqliteSchemaFingerprint(db)
    const registry = createMigrationRegistry(original.implementations.map(step => step.id === 'M08' ? { ...step, verify: () => false } : step), original.recognizedSchemas)
    expect(() => migrateSchema(new SqliteSchemaAdapter(db), registry, 9)).toThrow('MIGRATION_VERIFICATION_FAILED')
    expect(db.pragma('user_version', { simple: true })).toBe(8)
    expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
    expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe('原稿与历史保留')
  } finally { db.close() }
})
it('upgrades an enabled schema 8 replica without rewriting any accepted synchronization batch', () => {
  const db = fixture()
  try {
    const adapter = new SqliteSchemaAdapter(db), registry = getDesktopMigrationRegistry()
    migrateSchema(adapter, registry, 9)
    const engine = new ProjectSyncEngine(db, randomUUID(), projectSyncProjection)
    engine.enable()
    const accepted = engine.exportBundle()
    // The stage-3 empty-story projection is byte-for-byte the same author data.
    for (const table of STORY_TABLES) db.exec(`DROP TABLE ${table}`)
    db.pragma('user_version=8')
    expect(verifySchema(adapter, registry, 8).version).toBe(8)
    expect(migrateSchema(adapter, registry, 9).completedSteps).toEqual(['M08'])
    expect(engine.exportBundle()).toEqual(accepted)
  } finally { db.close() }
})
