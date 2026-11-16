import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { createMigrationRegistry } from '../../migrations/registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { upgradeProjectSqlite } from '../sqlite-project-migration'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture(version = 11) {
  const base = path.resolve('.runtime/canonical-schema12-host'); fs.mkdirSync(base, { recursive: true })
  vi.stubEnv('LOCALAPPDATA', base)
  const root = fs.mkdtempSync(path.join(base, 'case-')); roots.push(root)
  const file = path.join(root, 'project.db'), db = new Database(file)
  db.transaction(() => {
  initializeLegacyBaselineSchema(db)
  db.prepare("INSERT INTO project_core(id,project_name) VALUES('main','受保护的旧项目')").run()
  db.prepare('INSERT INTO contents(body) VALUES(?)').run('中文正文\r\n原字节🙂')
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), version)
  })(); db.close()
  return { file, open: () => new Database(file) }
}
it('opens the recognized schema11 canonical project through the registered M12 without rewriting prose', () => {
  const f = fixture(), migrated = upgradeProjectSqlite({ databasePath: f.file })
  expect(migrated.schemaVersion).toBe(12)
  const db = f.open()
  try {
    expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe('中文正文\r\n原字节🙂')
    expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'project_sync_compact_%'").pluck().get()).toBe(2)
  } finally { db.close() }
}, 30000)
it('refuses an omitted registered upgrade step without writing the source', () => {
  const f = fixture(), registered = getDesktopMigrationRegistry()
  const registry = createMigrationRegistry(registered.implementations.filter(step => step.from !== 11), registered.recognizedSchemas)
  const before = fs.readFileSync(f.file)
  expect(() => upgradeProjectSqlite({ databasePath: f.file, registry })).toThrow('CANONICAL_SCHEMA_UPGRADE_UNSUPPORTED')
  expect(fs.readFileSync(f.file)).toEqual(before)
}, 30000)
