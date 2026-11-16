import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { migrateSchema, verifySchema } from '../runner'
import { createMigrationRegistry } from '../registry'
import { SqliteSchemaAdapter } from '../sqlite-schema-adapter'

function v10() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  initializeLegacyBaselineSchema(db, Buffer.alloc(32, 91))
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 10)
  return db
}
describe('M10 installed author-assets lane', () => {
  it('adds empty catalogs without rewriting existing blueprints, imported prose or history', () => {
    const db = v10()
    try {
      db.prepare("INSERT OR IGNORE INTO project_core(id,project_name) VALUES('main','原项目')").run()
      db.prepare("INSERT INTO blueprints(chapter_number,title) VALUES(3,'只有第三章有蓝图')").run()
      const content = db.prepare('INSERT INTO contents(body) VALUES(?)').run('直接导入第一章：保留原始正文🌙')
      db.prepare("INSERT INTO drafts(chapter_number,version,source,content_id,word_count) VALUES(1,1,'write',?,19)").run(Number(content.lastInsertRowid))
      const names = ['project_core', 'blueprints', 'contents', 'drafts', 'story_nodes', 'story_edges', 'story_routes']
      const before = names.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())
      const adapter = new SqliteSchemaAdapter(db)
      expect(migrateSchema(adapter, getDesktopMigrationRegistry(), 11).completedSteps).toEqual(['M10'])
      expect(names.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())).toEqual(before)
      expect(db.prepare('SELECT COUNT(*) FROM project_author_assets').pluck().get()).toBe(0)
      expect(db.prepare('SELECT COUNT(*) FROM project_asset_local_state').pluck().get()).toBe(0)
      expect(db.pragma('user_version', { simple: true })).toBe(11)
      verifySchema(adapter, getDesktopMigrationRegistry(), 11)
    } finally { db.close() }
  })
  it('rolls back catalog DDL and schema version together on verification failure', () => {
    const db = v10()
    try {
      const original = getDesktopMigrationRegistry(), registry = createMigrationRegistry(original.implementations.map(step =>
        step.id === 'M10' ? { ...step, verify: () => false } : step), original.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), registry, 11)).toThrow()
      expect(db.pragma('user_version', { simple: true })).toBe(10)
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_author_assets'").get()).toBeUndefined()
    } finally { db.close() }
  })
  it('older installed registries reject the new schema instead of opening it as an old book', () => {
    const db = v10()
    try {
      const original = getDesktopMigrationRegistry(), adapter = new SqliteSchemaAdapter(db)
      migrateSchema(adapter, original, 11)
      const older = createMigrationRegistry(original.implementations.filter(step => step.id !== 'M10'), original.recognizedSchemas.filter(schema => schema.version <= 10))
      expect(() => verifySchema(adapter, older, 10)).toThrow()
    } finally { db.close() }
  })
})
