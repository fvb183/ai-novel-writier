import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { createMigrationRegistry } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const Sqlite = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
function fixture() {
  const db = new Sqlite(':memory:'); db.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7)
  for (const version of [1, 2]) {
    const content = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(`作者原文${version}`).lastInsertRowid)
    db.prepare("INSERT INTO drafts(chapter_number,version,status,source,content_id,word_count) VALUES(1,?,'finalized','write',?,5)").run(version, content)
  }
  return db
}

it('installs M07 once and backfills the existing finalized head without creating replica authority', () => {
  const db = fixture()
  try {
    const before = db.prepare('SELECT d.*,c.body FROM drafts d JOIN contents c ON c.id=d.content_id ORDER BY d.id').all()
    expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).completedSteps).toEqual(['M07'])
    expect(db.prepare('SELECT * FROM chapter_finalization_heads').all()).toEqual([{ chapter_number: 1, draft_id: 2 }])
    expect(db.prepare('SELECT d.*,c.body FROM drafts d JOIN contents c ON c.id=d.content_id ORDER BY d.id').all()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) FROM project_sync_meta').pluck().get()).toBe(0)
    expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).version).toBe(8)
    expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).completedSteps).toEqual([])
  } finally { db.close() }
})

it('rolls back the whole M07 schema and head backfill if verification fails', () => {
  const db = fixture()
  try {
    const registry = getDesktopMigrationRegistry(), fingerprint = sqliteSchemaFingerprint(db)
    const rejected = createMigrationRegistry(registry.implementations.map(step => step.id === 'M07' ? { ...step, verify: () => false } : step), registry.recognizedSchemas)
    expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected, 8)).toThrow('MIGRATION_VERIFICATION_FAILED')
    expect(db.pragma('user_version', { simple: true })).toBe(7)
    expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
    expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name='chapter_finalization_heads'").pluck().get()).toBe(0)
    expect(db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(2)
  } finally { db.close() }
})
