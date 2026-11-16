import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { getProjectSyncEngine, wrapProjectDatabase } from '../project-sync-service'
import { DraftRepository } from '../../repositories/draft-repository'
import { setAuthoritativeFinalizedDraft } from '../finalized-draft-head'
import { syncDigest } from '../project-sync-engine'

const handles: Database.Database[] = []
afterEach(() => handles.splice(0).forEach(db => db.close()))
function replica(projectId = randomUUID()) {
  const raw = new Database(':memory:'); handles.push(raw)
  raw.pragma('foreign_keys=ON'); initializeLegacyBaselineSchema(raw)
  migrateSchema(new SqliteSchemaAdapter(raw), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  raw.prepare("INSERT INTO project_core(id,project_name) VALUES('main','审查合成项目')").run()
  return { raw, db: wrapProjectDatabase(raw, projectId), engine: getProjectSyncEngine(raw, projectId), projectId }
}

it('keeps capture enabled for database-returning fluent calls', () => {
  const a = replica(); a.engine.enable()
  a.db.exec('SELECT 1').prepare("UPDATE project_core SET synopsis='链式写入' WHERE id='main'").run()
  expect(a.engine.exportBundle().batches).toHaveLength(2)
})

it('does not expose an unwrapped connection through a prepared statement', () => {
  const a = replica(); a.engine.enable()
  a.db.prepare('SELECT 1').database.prepare("UPDATE project_core SET synopsis='语句连接写入' WHERE id='main'").run()
  expect(a.engine.exportBundle().batches).toHaveLength(2)
})

it.each(['default', 'deferred', 'immediate', 'exclusive'] as const)('keeps the captured database on transaction.%s', mode => {
  const a = replica(); a.engine.enable()
  const transaction = a.db.transaction(() => 'unused')
  const variant = transaction[mode] as typeof transaction & { database: Database.Database }
  expect(variant.database).toBe(a.db)
  variant.database.prepare("UPDATE project_core SET synopsis='事务对象连接写入' WHERE id='main'").run()
  expect(a.engine.exportBundle().batches).toHaveLength(2)
})

it('refuses to overwrite unjournaled local content when applying a new remote batch', () => {
  const a = replica(); a.engine.enable()
  const b = replica(a.projectId); b.engine.join(a.engine.exportBundle())
  a.db.prepare("UPDATE project_core SET synopsis='远端修改' WHERE id='main'").run()
  b.raw.prepare("UPDATE project_core SET synopsis='尚未进入日志的本地正文' WHERE id='main'").run()
  const preview = b.engine.receive(a.engine.exportBundle())
  expect(() => b.engine.apply(preview.token)).toThrow('SYNC_LOCAL_STATE_DIVERGED')
  expect(b.raw.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get()).toBe('尚未进入日志的本地正文')
  expect(b.engine.status().pendingBatches).toBe(1)
})

it('invalidates downstream continuity when a remote change replaces an authoritative finalized head', () => {
  const a = replica()
  const original = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '旧定稿', wordCount: 3 }, a.raw)
  a.raw.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(original)
  setAuthoritativeFinalizedDraft(a.raw, 1, original)
  a.engine.enable()
  const b = replica(a.projectId); b.engine.join(a.engine.exportBundle())
  const before = b.raw.prepare("SELECT generation FROM continuity_projection_meta WHERE id='main'").pluck().get() as number
  const replacement = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '远端新定稿', wordCount: 5 }, a.db)
  a.db.transaction(() => {
    a.db.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(replacement)
    setAuthoritativeFinalizedDraft(a.db, 1, replacement)
  })()
  const preview = b.engine.receive(a.engine.exportBundle()); expect(b.engine.apply(preview.token).applied).toBe(true)
  const watermark = b.raw.prepare("SELECT generation,stale_from_chapter FROM continuity_projection_meta WHERE id='main'").get() as { generation: number; stale_from_chapter: number | null }
  expect(watermark.stale_from_chapter).toBe(1)
  expect(watermark.generation).toBeGreaterThan(before)
})

it('rejects an unsupported record even when another record has a normal edit conflict', () => {
  const a = replica(); a.engine.enable()
  const b = replica(a.projectId); b.engine.join(a.engine.exportBundle())
  a.db.prepare("UPDATE project_core SET synopsis='远端修改' WHERE id='main'").run()
  b.db.prepare("UPDATE project_core SET synopsis='本地修改' WHERE id='main'").run()
  const incoming = a.engine.exportBundle(), changed = incoming.batches.find(batch => batch.sequence === 2)!
  changed.changes.push({ kind: 'remote-execution', id: 'unsupported', parents: [], value: { path: 'synthetic-test-only' }, deleted: false })
  const { hash: _batchHash, ...batchBody } = changed; changed.hash = syncDigest(batchBody)
  const { hash: _packageHash, ...packageBody } = incoming; incoming.hash = syncDigest(packageBody)
  expect(() => b.engine.receive(incoming)).toThrow('PROJECT_SYNC_KIND_UNSUPPORTED')
  expect(b.engine.status().pendingBatches).toBe(0)
})

it('rejects a null required author field before persisting an unusable incoming batch', () => {
  const a = replica(); a.engine.enable()
  const b = replica(a.projectId); b.engine.join(a.engine.exportBundle())
  a.db.prepare("UPDATE project_core SET project_name='远端标题' WHERE id='main'").run()
  const incoming = a.engine.exportBundle(), changed = incoming.batches.find(batch => batch.sequence === 2)!
  changed.changes.find(change => change.kind === 'project-core' && change.id === 'project_name')!.value = null
  const { hash: _batchHash, ...batchBody } = changed; changed.hash = syncDigest(batchBody)
  const { hash: _packageHash, ...packageBody } = incoming; incoming.hash = syncDigest(packageBody)
  expect(() => b.engine.receive(incoming)).toThrow('PROJECT_SYNC_RECORD_INVALID')
  expect(b.engine.status().pendingBatches).toBe(0)
  expect(b.raw.prepare("SELECT project_name FROM project_core WHERE id='main'").pluck().get()).toBe('审查合成项目')
})
