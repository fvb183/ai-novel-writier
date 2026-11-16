import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { createMigrationRegistry } from '../registry'
import { migrateSchema, probeSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { StoryBranchRepository as Stories } from '../../repositories/story-branch-repository'
import { ProjectSyncEngine, syncDigest, validateSyncBundle } from '../../services/project-sync-engine'
import { projectSyncProjection } from '../../services/project-sync-projection'
import { assertPortableSourceSchema } from '../../services/portable-project-format'

function fixture() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
  db.prepare("INSERT INTO project_core(id,project_name) VALUES('main','旧版作者作品')").run()
  const node = { id: randomUUID(), kind: 'content' as const, title: '原分支', chapterNumber: 1, event: '原事件', body: '原正文' }
  Stories.commit(db, Stories.read(db).revision, [{ type: 'put-node', node }])
  return db
}
it('upgrades schema 9 to the live-reference format without rewriting stored author rows or history', () => {
  const db = fixture()
  try {
    const registry = getDesktopMigrationRegistry(), adapter = new SqliteSchemaAdapter(db)
    const fingerprint = sqliteSchemaFingerprint(db)
    const rows = db.prepare('SELECT * FROM story_nodes').all(), revisions = db.prepare('SELECT * FROM story_node_revisions').all()
    const engine = new ProjectSyncEngine(db, randomUUID(), projectSyncProjection); engine.enable()
    const legacyBundle = engine.exportBundle(), batchRows = db.prepare('SELECT * FROM project_sync_batches').all()
    expect(legacyBundle.minimumReaderSchemaVersion).toBeUndefined()
    expect(migrateSchema(adapter, registry, 10).completedSteps).toEqual(['M09'])
    expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
    expect(db.prepare('SELECT * FROM story_nodes').all()).toEqual(rows)
    expect(db.prepare('SELECT * FROM story_node_revisions').all()).toEqual(revisions)
    expect(db.prepare('SELECT * FROM project_sync_batches').all()).toEqual(batchRows)
    const bundle = engine.exportBundle()
    expect(bundle.batches).toEqual(legacyBundle.batches)
    expect(bundle.minimumReaderSchemaVersion).toBe(10)
    expect(validateSyncBundle(legacyBundle)).toEqual(legacyBundle)
    expect(validateSyncBundle(bundle)).toEqual(bundle)
    expect(assertPortableSourceSchema(db)).toEqual({ tables: 62, fields: 510 })
    expect(verifySchema(adapter, registry, 10).version).toBe(10)
    const legacyRegistry = createMigrationRegistry(registry.implementations.filter(step => step.to <= 9), registry.recognizedSchemas.filter(schema => schema.version <= 9))
    expect(() => probeSchema(adapter, legacyRegistry)).toThrow('UNRECOGNIZED_SCHEMA')
    const { hash: _hash, ...body } = bundle
    const future = { ...body, minimumReaderSchemaVersion: 12 }
    expect(() => validateSyncBundle({ ...future, hash: syncDigest(future) })).toThrow('SYNC_READER_VERSION_UNSUPPORTED')
  } finally { db.close() }
})
it('rolls back the semantic version gate when M09 verification fails', () => {
  const db = fixture()
  try {
    const original = getDesktopMigrationRegistry(), fingerprint = sqliteSchemaFingerprint(db)
    const registry = createMigrationRegistry(original.implementations.map(step => step.id === 'M09' ? { ...step, verify: () => false } : step), original.recognizedSchemas)
    expect(() => migrateSchema(new SqliteSchemaAdapter(db), registry, 10)).toThrow('MIGRATION_VERIFICATION_FAILED')
    expect(db.pragma('user_version', { simple: true })).toBe(9)
    expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
    expect(Stories.read(db).nodes[0].body).toBe('原正文')
  } finally { db.close() }
})
