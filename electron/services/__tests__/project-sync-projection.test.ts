import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema, verifySchema } from '../../migrations/runner'
import { DraftRepository } from '../../repositories/draft-repository'
import { refreshCharacterIdentityProjection, CharacterRosterRepository } from '../../repositories/character-roster-repository'
import { projectSyncProjection as projection } from '../project-sync-projection'
import type { SyncRecord } from '../../../src/shared/project-sync'
import { getAuthoritativeFinalizedDraftId, setAuthoritativeFinalizedDraft } from '../finalized-draft-head'
import { ProjectSyncEngine } from '../project-sync-engine'
import { randomUUID } from 'node:crypto'

const Sqlite = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const handles: Database.Database[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function database() {
  const db = new Sqlite(':memory:'); handles.push(db); db.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.prepare("INSERT INTO project_core(id,project_name) VALUES('main','合成同步项目')").run()
  return db
}
const draft = (db: Database.Database, content: string) => DraftRepository.create({ chapterNumber: 1, source: 'write', content, wordCount: content.length }, db)
function merge(...groups: SyncRecord[][]): SyncRecord[] {
  const result = new Map<string, SyncRecord>()
  for (const records of groups) for (const record of records) result.set(record.kind + '\u0000' + record.id, record)
  return [...result.values()]
}
afterEach(() => { for (const db of handles.splice(0)) db.close() })

it('projects two independent SQLite copies with colliding local draft versions and stable dependency identity', () => {
  const left = database(), right = database()
  left.transaction(() => {
    left.prepare("INSERT INTO characters(character_id,name,role) VALUES('stable-character','甲','protagonist')").run()
    refreshCharacterIdentityProjection(left)
  })()
  left.prepare("INSERT INTO blueprints(chapter_number,title,notes) VALUES(1,'标题','作者备注')").run()
  draft(left, '共同初稿')
  const genesis = projection.capture(left); projection.apply(right, genesis)
  expect(projection.capture(right)).toEqual(genesis)
  const leftId = draft(left, '左端第二稿'), rightId = draft(right, '右端第二稿')
  expect(left.prepare('SELECT version FROM drafts WHERE id=?').pluck().get(leftId)).toBe(2)
  expect(right.prepare('SELECT version FROM drafts WHERE id=?').pluck().get(rightId)).toBe(2)
  const leftRecords = projection.capture(left), rightRecords = projection.capture(right)
  const all = merge(leftRecords, rightRecords)
  projection.apply(left, all); projection.apply(right, all)
  expect(projection.capture(left)).toEqual(projection.capture(right))
  expect(left.prepare('SELECT version FROM drafts WHERE id=?').pluck().get(leftId)).toBe(2)
  expect(right.prepare('SELECT version FROM drafts WHERE id=?').pluck().get(rightId)).toBe(3)
  expect(right.prepare('SELECT body FROM drafts d JOIN contents c ON c.id=d.content_id ORDER BY version DESC LIMIT 1').pluck().get()).toBe('右端第二稿')
  const leftStable = leftRecords.find(record => record.kind === 'draft' && (record.value as { content: string }).content === '左端第二稿')!.id
  const remoteLeft = Number(right.prepare("SELECT local_key FROM project_sync_entity_map WHERE kind='draft' AND entity_id=?").pluck().get(leftStable))
  DraftRepository.create({ chapterNumber: 2, source: 'write', content: '后续正文', wordCount: 4,
    sourceDependencies: [{ draftId: remoteLeft, contentHash: digest('左端第二稿') }] }, right)
  const continuation = projection.capture(right); projection.apply(left, continuation)
  expect(projection.capture(left)).toEqual(continuation)
  expect(JSON.parse(String(left.prepare('SELECT source_dependencies FROM drafts WHERE chapter_number=2').pluck().get()))[0])
    .toEqual({ draftId: leftId, contentHash: digest('左端第二稿') })
  expect(CharacterRosterRepository.read(right).status).toBe('ready')
  verifySchema(new SqliteSchemaAdapter(left), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  verifySchema(new SqliteSchemaAdapter(right), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
})

it('keeps new reviews local while preserving legacy frozen evidence and stale dependency hashes', () => {
  const left = database(), right = database(), source = draft(left, '审稿时原文')
  const bodyId = Number(left.prepare('INSERT INTO contents(body) VALUES(?)').run('旧审稿报告').lastInsertRowid)
  left.prepare("INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id) VALUES(?,1,1,1,'draft',?,?)")
    .run(source, '审稿时原文', bodyId)
  DraftRepository.create({ chapterNumber: 2, source: 'write', content: '来源变动前已完成的稿件', wordCount: 12,
    sourceDependencies: [{ draftId: source, contentHash: digest('审稿时原文') }] }, left)
  left.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)').run('后来作者修改', source)
  expect(projection.capture(left).some(record => record.kind === 'history:reviews')).toBe(false)
  // Previously accepted evidence remains importable and immutable after upgrade.
  const legacy = { original: { id: 1, base_draft_id: source, review_index: 1, source_draft_chapter_number: 1,
    source_draft_version: 1, source_draft_status: 'draft', source_content: '审稿时原文' },
    references: { baseDraftId: null }, content: '旧审稿报告' }
  const payload = JSON.stringify(legacy)
  left.prepare('INSERT INTO project_sync_history VALUES(?,?,?)').run('history:reviews\u0000legacy-review', payload, digest(payload))
  const before = projection.capture(left)
  projection.apply(right, before)
  expect(projection.capture(right)).toEqual(before)
  expect(right.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
  expect(right.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
  const history = right.prepare('SELECT payload_json,content_hash FROM project_sync_history').get() as { payload_json: string; content_hash: string }
  expect(history.content_hash).toBe(digest(history.payload_json))
  expect(JSON.parse(history.payload_json).original.source_content).toBe('审稿时原文')
  const dependencies = JSON.parse(String(right.prepare('SELECT source_dependencies FROM drafts WHERE chapter_number=2').pluck().get()))
  expect(dependencies[0].contentHash).toBe(digest('审稿时原文'))
  const changed = structuredClone(before)
  const changedReview = changed.find(record => record.kind === 'history:reviews')!.value as { content: string }
  changedReview.content = 'counterfeit'
  expect(() => projection.apply(right, changed)).toThrow('HISTORY_IMMUTABLE')
  expect(projection.capture(right)).toEqual(before)
})

it('keeps the explicit finalized head across different local version ordering and sequential finalizations', () => {
  const left = database(), right = database()
  const original = draft(left, '原来定稿')
  left.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(original)
  setAuthoritativeFinalizedDraft(left, 1, original)
  projection.apply(right, projection.capture(left))
  const leftId = draft(left, '左端后来定稿'), rightId = draft(right, '右端并发草稿')
  const leftNew = projection.capture(left), rightNew = projection.capture(right)
  const all = merge(leftNew, rightNew)
  // Explicitly select the left candidate before either draft is finalized.
  const leftSelection = leftNew.find(record => record.kind === 'draft-selection')!
  all.splice(all.findIndex(record => record.kind === 'draft-selection'), 1, leftSelection)
  projection.apply(left, all); projection.apply(right, all)
  const stable = leftNew.find(r => r.kind === 'draft' && (r.value as { content: string }).content === '左端后来定稿')!.id
  const remote = Number(right.prepare("SELECT local_key FROM project_sync_entity_map WHERE kind='draft' AND entity_id=?").pluck().get(stable))
  left.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(leftId)
  setAuthoritativeFinalizedDraft(left, 1, leftId)
  projection.apply(right, projection.capture(left))
  expect(getAuthoritativeFinalizedDraftId(right, 1)).toBe(remote)
  expect(right.prepare('SELECT version FROM drafts WHERE id=?').pluck().get(rightId)).toBe(2)
  // The remote device then finalizes its existing lower-numbered draft.
  right.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(rightId)
  setAuthoritativeFinalizedDraft(right, 1, rightId)
  const finalRecords = projection.capture(right)
  projection.apply(left, finalRecords)
  expect(projection.capture(left)).toEqual(finalRecords)
  expect(getAuthoritativeFinalizedDraftId(right, 1)).toBe(rightId)
  expect(right.prepare("SELECT MAX(version) FROM drafts WHERE status='finalized'").pluck().get()).toBeGreaterThan(2)
})

it.each(['keep-edit', 'keep-delete'])('projects an explicit delete/edit resolution: %s', resolution => {
  const left = database(), right = database(), original = draft(left, '共同旧稿')
  projection.apply(right, projection.capture(left))
  const stable = projection.capture(left).find(r => r.kind === 'draft')!.id
  left.prepare('DELETE FROM drafts WHERE id=?').run(original)
  right.prepare("UPDATE contents SET body='另一端新编辑' WHERE id=(SELECT content_id FROM drafts LIMIT 1)").run()
  const chosen = resolution === 'keep-edit' ? projection.capture(right) : projection.capture(left)
  projection.apply(left, chosen); projection.apply(right, chosen)
  expect(projection.capture(left)).toEqual(projection.capture(right))
  expect(left.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(resolution === 'keep-edit' ? 1 : 0)
  expect(left.prepare("SELECT local_key FROM project_sync_entity_map WHERE kind='draft' AND entity_id=?").pluck().get(stable)).toBe(String(original))
  if (resolution === 'keep-edit') expect(left.prepare('SELECT body FROM contents JOIN drafts ON contents.id=drafts.content_id').pluck().get()).toBe('另一端新编辑')
})

it('keeps generation observations and executable run rows entirely local', () => {
  const left = database(), right = database()
  left.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)').run('root-secret', 'machine-key', '{"apiKey":"test-private-marker"}', '{}')
  left.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('run-private', 'root-secret', '{"path":"C:/private-marker"}', 'running', 123, 'private-open-key')
  const records = projection.capture(left)
  expect(records.some(r => r.kind === 'history:generation')).toBe(false)
  expect(JSON.stringify(records)).not.toMatch(/private-marker|machine-key|root-secret|run-private|private-open-key/)
  projection.apply(right, records)
  expect(projection.capture(right)).toEqual(records)
  expect(right.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
})

it('does not create sync batches for review reports, generation status or regenerated plot snapshots', () => {
  const db = database(), source = draft(db, 'author prose'), engine = new ProjectSyncEngine(db, randomUUID(), projection)
  engine.enable(); const before = engine.exportBundle()
  engine.captureMutation(() => {
    const report = db.prepare('INSERT INTO contents(body) VALUES(?)').run('machine review report').lastInsertRowid
    db.prepare("INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id) VALUES(?,1,1,1,'draft',?,?)")
      .run(source, 'author prose', report)
    db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)').run('local-root', 'local-key', '{}', '{}')
    db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('local-run', 'local-root', '{}', 'completed', 123, 'local-owner')
    db.prepare("UPDATE project_core SET plot_tree_snapshot=? WHERE id='main'").run('{"generated":"display projection"}')
  })
  expect(engine.exportBundle()).toEqual(before)
  expect(db.prepare('SELECT COUNT(*) FROM project_sync_history').pluck().get()).toBe(0)
  engine.captureMutation(() => db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)').run('saved new author prose', source))
  expect(engine.exportBundle().batches).toHaveLength(before.batches.length + 1)
})

it('invalidates downstream continuity when a previously unfinalized earlier chapter arrives', () => {
  const source = database(), target = database()
  const later = DraftRepository.create({ chapterNumber: 2, source: 'write', content: '原有后章', wordCount: 4 }, source)
  source.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(later)
  setAuthoritativeFinalizedDraft(source, 2, later)
  projection.apply(target, projection.capture(source))
  target.prepare("UPDATE continuity_projection_meta SET stale_from_chapter=NULL WHERE id='main'").run()
  const generation = target.prepare("SELECT generation FROM continuity_projection_meta WHERE id='main'").pluck().get() as number
  const earlier = draft(source, '后来补入前章')
  source.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(earlier)
  setAuthoritativeFinalizedDraft(source, 1, earlier)
  projection.apply(target, projection.capture(source))
  expect(target.prepare("SELECT generation,stale_from_chapter FROM continuity_projection_meta WHERE id='main'").get())
    .toEqual({ generation: generation + 1, stale_from_chapter: 1 })
})


it('roundtrips replaced finals and their immutable narrative evidence after re-finalization', () => {
  const left = database(), right = database()
  const old = draft(left, '旧章中铜钥匙藏在钟后')
  const finalize = (id: number, body: string) => {
    left.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(id)
    left.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,
      content_hash,content_revision,content_snapshot,target_file_name,publication_status)
      VALUES(?,?,1,'合成章节',?,1,?,?,'published')`).run(`synthetic-final-${id}`, id, digest(body), body, `synthetic-${id}.txt`)
    setAuthoritativeFinalizedDraft(left, 1, id)
  }
  finalize(old, '旧章中铜钥匙藏在钟后')
  left.prepare(`INSERT INTO narrative_thread_plans(title,type,target_start_chapter,target_end_chapter,author_intent)
    VALUES('铜钥匙','物品',1,2,'保留原来确认的伏笔')`).run()
  left.prepare(`INSERT INTO narrative_thread_confirmations(plan_id,draft_id,event_type,evidence,reason)
    VALUES(1,?,'planted','铜钥匙藏在钟后','作者确认')`).run(old)
  projection.apply(right, projection.capture(left))
  const next = draft(left, '重新定稿后铜钥匙在桌上')
  left.prepare("UPDATE drafts SET status='superseded' WHERE id=?").run(old)
  finalize(next, '重新定稿后铜钥匙在桌上')
  const records = projection.capture(left)
  expect(() => projection.validate(records)).not.toThrow()
  projection.apply(right, records)
  expect(projection.capture(right)).toEqual(records)
  expect(right.prepare("SELECT COUNT(*) FROM drafts WHERE status='superseded'").pluck().get()).toBe(1)
  expect(right.prepare('SELECT evidence FROM narrative_thread_confirmations').pluck().get()).toBe('铜钥匙藏在钟后')

  // Without the narrative reference, the immutable receipt guard itself must still reject removal.
  const tampered = structuredClone(records).filter(record => record.kind !== 'narrative-plan')
  const historical = tampered.find(record => record.kind === 'draft' && (record.value as { status: string }).status === 'superseded')!
  ;(historical.value as { finalization: unknown }).finalization = null
  expect(() => projection.apply(right, tampered)).toThrow('IMMUTABLE_FINALIZATION')
  expect(projection.capture(right)).toEqual(records)
})

it('keeps a reviewed working manuscript as the explicit selected draft across devices', () => {
  const left = database(), right = database()
  const original = draft(left, '旧工作稿')
  left.prepare("UPDATE drafts SET status='reviewed' WHERE id=?").run(original)
  const records = projection.capture(left)
  expect(records.some(record => record.kind === 'draft-selection')).toBe(true)
  projection.apply(right, records)
  expect(projection.capture(right)).toEqual(records)
  expect(right.prepare('SELECT status FROM drafts').pluck().get()).toBe('reviewed')
})
