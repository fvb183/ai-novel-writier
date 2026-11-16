import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { StoryBranchRepository as Stories } from '../../repositories/story-branch-repository'
import { forkStoryFromChapter } from '../story-chapter-planning'
import { getProjectSyncEngine, wrapProjectDatabase } from '../project-sync-service'
import { assertPortableSourceSchema } from '../portable-project-format'
import { syncDigest } from '../project-sync-engine'
import type { SyncChange } from '../../../src/shared/project-sync'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
const handles: Database.Database[] = []
afterEach(() => handles.splice(0).forEach(db => db.close()))
function replica(projectId = randomUUID(), schemaVersion = CURRENT_DESKTOP_SCHEMA_VERSION) {
  const raw = new Database(':memory:'); handles.push(raw)
  initializeLegacyBaselineSchema(raw)
  migrateSchema(new SqliteSchemaAdapter(raw), getDesktopMigrationRegistry(), schemaVersion)
  raw.prepare("INSERT INTO project_core(id,project_name) VALUES('main','实时主线与独立章节')").run()
  const db = wrapProjectDatabase(raw, projectId), engine = getProjectSyncEngine(db, projectId)
  return { db, engine, projectId }
}
function draft(db: Database.Database, chapter: number, body: string) {
  const content = db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid
  const version = Number(db.prepare('SELECT COALESCE(MAX(version),0)+1 FROM drafts WHERE chapter_number=?').pluck().get(chapter))
  return Number(db.prepare('INSERT INTO drafts(chapter_number,version,content_id) VALUES(?,?,?)').run(chapter, version, content).lastInsertRowid)
}
function facts(db: Database.Database) {
  return { blueprints: db.prepare('SELECT * FROM blueprints').all(), drafts: db.prepare('SELECT * FROM drafts').all(), contents: db.prepare('SELECT * FROM contents').all() }
}
function setup() {
  const a = replica()
  draft(a.db, 1, '导入正文一，没有蓝图'); draft(a.db, 2, '指定接回的主线正文二')
  a.db.prepare("INSERT INTO blueprints(chapter_number,title,key_events,characters) VALUES(3,'尚未写的原章','不能成为既成事实','[\"主角\"]')").run()
  const fork = forkStoryFromChapter(a.db, { expectedRevision: Stories.read(a.db).revision, afterChapter: 1, title: '插入的独立章节', placement: 'insert' })
  a.engine.enable()
  const b = replica(a.projectId)
  // Local row ids are intentionally different; no author rows are added.
  b.db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('drafts',80)").run()
  b.engine.join(a.engine.exportBundle())
  return { a, b, fork }
}
const nodeInput = (db: Database.Database, id: string) => {
  const { revisionId: _revision, ...input } = Stories.read(db).nodes.find(node => node.id === id)!
  return input
}
function forgedBundle(a: ReturnType<typeof replica>, changes: SyncChange[]) {
  const original = a.engine.exportBundle(), previous = original.batches.find(batch => batch.replicaId === original.senderReplicaId)!
  const body = { protocol: 1 as const, projectId: a.projectId, replicaId: original.senderReplicaId, sequence: previous.sequence + 1,
    previousHash: previous.hash, batchId: randomUUID(), changes }
  const extra = { ...body, hash: syncDigest(body) }, { hash: _hash, ...envelope } = original
  const forged = { ...envelope, batches: [...original.batches, extra] }
  return { ...forged, hash: syncDigest(forged) }
}

it('synchronizes live chapter anchors, imported prose without blueprints, insert bridges and independent edits across different local row identities', () => {
  const { a, b, fork } = setup(), source = Stories.read(a.db).nodes.find(node => node.id === 'chapter:1')!
  expect(a.db.prepare('SELECT MIN(id) FROM drafts').pluck().get()).not.toBe(b.db.prepare('SELECT MIN(id) FROM drafts').pluck().get())
  expect(Stories.read(b.db)).toEqual(fork.snapshot)
  expect(source.chapterBlueprint).toBeUndefined()
  const originalMainline = facts(b.db), child = nodeInput(b.db, fork.nodeId)
  Stories.commit(b.db, Stories.read(b.db).revision, [{ type: 'put-node', node: { ...child,
    chapterBlueprint: { ...child.chapterBlueprint!, purpose: '手机上的独立蓝图', characters: ['分支同伴'] },
  } }])
  const saved = Stories.commit(b.db, Stories.read(b.db).revision, [{ type: 'put-node', node: { ...nodeInput(b.db, fork.nodeId), body: '手机生成并批准的插入章节' } }])
  expect(facts(b.db)).toEqual(originalMainline)
  const preview = a.engine.receive(b.engine.exportBundle())
  expect(preview.conflicts).toEqual([]); expect(a.engine.apply(preview.token).applied).toBe(true)
  expect(Stories.read(a.db)).toEqual(saved)
  expect(Stories.read(a.db).nodes.find(node => node.id === source.id)).toEqual(source)
  expect(saved.routes.find(route => route.id === fork.routeId)?.nodeIds).toEqual(['chapter:1', fork.nodeId, 'chapter:2', 'chapter:3'])
  const request = { nodeId: fork.nodeId, routeId: fork.routeId, mode: 'route' as const, bridgeToNodeId: 'chapter:2' }
  expect(Stories.context(a.db, request)).toEqual(Stories.context(b.db, request))
  expect(Stories.context(a.db, request).prefix.map(node => node.id)).toEqual(['chapter:1'])
  expect(Stories.context(a.db, request).continuation?.node.body).toBe('指定接回的主线正文二')
  expect(saved.edges.some(edge => edge.from === 'chapter:1' && edge.to === fork.nodeId)).toBe(true)
  expect(saved.revisions.some(revision => revision.node.chapterBlueprint?.purpose === '手机上的独立蓝图')).toBe(true)
  expect(a.engine.exportBundle().minimumReaderSchemaVersion).toBe(10)
  expect(a.engine.exportBundle().batches.flatMap(batch => batch.changes).filter(change => change.kind === 'story_nodes').some(change => change.id.startsWith('chapter:'))).toBe(false)
  expect(assertPortableSourceSchema(a.db)).toEqual({ tables: 64, fields: 514 })
  expect(a.db.pragma('user_version', { simple: true })).toBe(11)
})

it('refreshes canonical parent and bridge context after synchronization and blocks commits frozen against old mainline text', () => {
  const { a, b, fork } = setup()
  const request = { nodeId: fork.nodeId, routeId: fork.routeId, mode: 'route' as const, bridgeToNodeId: 'chapter:2' }
  const before = Stories.context(a.db, request)
  draft(b.db, 1, '手机更新的真实父章正文')
  draft(b.db, 2, '手机更新的指定后文正文')
  a.engine.apply(a.engine.receive(b.engine.exportBundle()).token)
  const current = Stories.context(a.db, request)
  expect(current.prefix[0].body).toBe('手机更新的真实父章正文')
  expect(current.continuation?.node.body).toBe('手机更新的指定后文正文')
  expect(current.contextHash).not.toBe(before.contextHash); expect(current.sourceHash).not.toBe(before.sourceHash)
  expect(() => Stories.commit(a.db, Stories.read(a.db).revision, [{ type: 'put-node', node: { ...nodeInput(a.db, fork.nodeId), body: '过期候选' } }],
    { expectedContext: { request, contextHash: before.contextHash } })).toThrow('STORY_CONTEXT_STALE')
  expect(Stories.read(a.db).nodes.find(node => node.id === fork.nodeId)?.body).toBe('')
})

it.each(['chapter:0', 'chapter:01', 'chapter:100001', 'chapter:2:extra'])('rejects malformed virtual references %s before adding pending batches', id => {
  const { a, b, fork } = setup(), before = Stories.read(b.db), edgeId = randomUUID()
  const forged = forgedBundle(a, [{ kind: 'story_edges', id: edgeId, parents: [], deleted: false,
    value: { id: edgeId, from: fork.nodeId, to: id, label: '', condition: '' } }])
  expect(() => b.engine.receive(forged)).toThrow('PROJECT_SYNC_STORY_INVALID')
  expect(Stories.read(b.db)).toEqual(before); expect(b.engine.status().pendingBatches).toBe(0)
})

it('rejects an implicit mainline cycle in a fully rehashed sync package atomically', () => {
  const { a, b, fork } = setup(), before = Stories.read(b.db), id = randomUUID()
  const forged = forgedBundle(a, [{ kind: 'story_edges', id, parents: [], deleted: false,
    value: { id, from: fork.nodeId, to: 'chapter:1', label: '', condition: '' } }])
  expect(() => b.engine.receive(forged)).toThrow('PROJECT_SYNC_STORY_INVALID')
  expect(Stories.read(b.db)).toEqual(before); expect(b.engine.status().pendingBatches).toBe(0)
})

function orderedCandidates(schemaVersion = 10) {
  const a = replica(randomUUID(), schemaVersion), old = draft(a.db, 5, '第五章较早候选'), latest = draft(a.db, 5, '第五章作者最新有效稿')
  // Wire ordering is deliberately opposite to the author's draft versions.
  a.db.prepare("INSERT INTO project_sync_entity_map(kind,entity_id,local_key) VALUES('draft',?,?)").run('ffffffff-ffff-4fff-8fff-fffffffffff1', String(old))
  a.db.prepare("INSERT INTO project_sync_entity_map(kind,entity_id,local_key) VALUES('draft',?,?)").run('00000000-0000-4000-8000-000000000002', String(latest))
  return { a, old, latest }
}

it('preserves the actual newest unfinished draft on a fresh join despite reversed stable-UUID order', () => {
  const { a } = orderedCandidates(), before = facts(a.db)
  a.engine.enable(); const b = replica(a.projectId)
  b.engine.join(a.engine.exportBundle())
  expect(Stories.read(a.db).nodes.find(node => node.id === 'chapter:5')?.body).toBe('第五章作者最新有效稿')
  expect(Stories.read(b.db)).toEqual(Stories.read(a.db))
  expect(facts(a.db)).toEqual(before)
  expect(b.db.prepare('SELECT body FROM drafts d JOIN contents c ON c.id=d.content_id ORDER BY version DESC LIMIT 1').pluck().get()).toBe('第五章作者最新有效稿')
})

it('adds draft selection as a normal upgrade batch while leaving schema-9 batches, source versions and prose untouched', () => {
  const { a } = orderedCandidates(9); a.engine.enable()
  const legacy = a.engine.exportBundle(), before = facts(a.db)
  migrateSchema(new SqliteSchemaAdapter(a.db), getDesktopMigrationRegistry(), 10)
  const upgraded = a.engine.exportBundle()
  expect(upgraded.batches.filter(batch => legacy.batches.some(previous => previous.batchId === batch.batchId))).toEqual(legacy.batches)
  expect(upgraded.batches).toHaveLength(legacy.batches.length + 1)
  expect(upgraded.batches.find(batch => !legacy.batches.some(previous => previous.batchId === batch.batchId))?.changes.map(change => change.kind)).toEqual(['draft-selection'])
  expect(facts(a.db)).toEqual(before)
  const b = replica(a.projectId); b.engine.join(upgraded)
  expect(Stories.read(b.db)).toEqual(Stories.read(a.db))
})

it('refuses an ambiguous old package atomically and can join after its source upgrades and records the author selection', () => {
  const { a } = orderedCandidates(9); a.engine.enable()
  const legacy = a.engine.exportBundle(), b = replica(a.projectId), before = facts(b.db)
  expect(() => b.engine.join(legacy)).toThrow('PROJECT_SYNC_DRAFT_SELECTION_REQUIRED')
  expect(b.engine.status().enabled).toBe(false); expect(facts(b.db)).toEqual(before)
  migrateSchema(new SqliteSchemaAdapter(a.db), getDesktopMigrationRegistry(), 10)
  expect(b.engine.join(a.engine.exportBundle()).applied).toBe(true)
  expect(Stories.read(b.db).nodes.find(node => node.id === 'chapter:5')?.body).toBe('第五章作者最新有效稿')
})

it('joins an old book with four authoritative final chapters and one unfinished candidate without changing its selected manuscripts', () => {
  const a = replica(randomUUID(), 9)
  for (const chapter of [1, 2, 3, 4]) {
    const id = draft(a.db, chapter, `正式第${chapter}章`)
    a.db.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(id)
    a.db.prepare('INSERT INTO chapter_finalization_heads(chapter_number,draft_id) VALUES(?,?)').run(chapter, id)
  }
  draft(a.db, 5, '第五章唯一有效未定稿'); a.engine.enable()
  const before = Stories.read(a.db), sourceRows = facts(a.db), b = replica(a.projectId)
  expect(b.engine.join(a.engine.exportBundle()).applied).toBe(true)
  expect(Stories.read(b.db)).toEqual(before); expect(facts(a.db)).toEqual(sourceRows)
  expect(Stories.read(b.db).nodes.map(node => node.mainline?.manuscriptStatus)).toEqual(['finalized', 'finalized', 'finalized', 'finalized', 'draft'])
})

it('keeps the authoritative final head over newer candidates when reading an old package, without editing its receipt or final version', () => {
  const { a, old } = orderedCandidates(9)
  a.db.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(old)
  a.db.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,target_file_name)
    VALUES(?,?,5,'第五章正式稿',?,1,?,'正式稿.txt')`).run(randomUUID(), old, createHash('sha256').update('第五章较早候选').digest('hex'), '第五章较早候选')
  // Add another candidate to retain the formerly ambiguous old transport shape.
  draft(a.db, 5, '第五章还未采纳的另一候选')
  a.db.prepare('INSERT INTO chapter_finalization_heads(chapter_number,draft_id) VALUES(5,?)').run(old)
  a.engine.enable(); const before = facts(a.db), b = replica(a.projectId)
  b.engine.join(a.engine.exportBundle())
  expect(Stories.read(b.db).nodes.find(node => node.id === 'chapter:5')?.body).toBe('第五章较早候选')
  const formal = () => b.db.prepare("SELECT d.version,c.body,o.finalization_id,o.content_hash,o.content_revision,o.content_snapshot FROM drafts d JOIN contents c ON c.id=d.content_id JOIN finalization_outbox o ON o.draft_id=d.id WHERE d.status='finalized'").get()
  const frozen = formal()
  expect(facts(a.db)).toEqual(before)
  expect(b.db.prepare('SELECT COUNT(*) FROM finalization_outbox').pluck().get()).toBe(1)
  migrateSchema(new SqliteSchemaAdapter(a.db), getDesktopMigrationRegistry(), 10)
  const upgraded = a.engine.exportBundle(), preview = b.engine.receive(upgraded)
  const sourceSelection = upgraded.batches.flatMap(batch => batch.changes).find(change => change.kind === 'draft-selection')?.value
  const resolutions = preview.conflicts.map(conflict => ({ kind: conflict.kind, id: conflict.id,
    expectedHeads: conflict.variants.map(variant => variant.revision),
    selectedRevision: conflict.variants.find(variant => JSON.stringify(variant.value) === JSON.stringify(sourceSelection))!.revision }))
  expect(b.engine.apply(preview.token, resolutions).applied).toBe(true)
  expect(formal()).toEqual(frozen)
  expect(Stories.read(b.db).nodes.find(node => node.id === 'chapter:5')?.body).toBe('第五章较早候选')
})

it('rolls back a failed temporary version swap together with all joined drafts and metadata', () => {
  const { a } = orderedCandidates(); a.engine.enable()
  const b = replica(a.projectId), before = facts(b.db)
  b.db.exec("CREATE TRIGGER fail_draft_swap BEFORE UPDATE OF version ON drafts WHEN NEW.version < 0 BEGIN SELECT RAISE(ABORT,'INJECTED_ORDER_FAILURE'); END")
  expect(() => b.engine.join(a.engine.exportBundle())).toThrow('INJECTED_ORDER_FAILURE')
  expect(facts(b.db)).toEqual(before)
  expect(b.engine.status().enabled).toBe(false)
  expect(b.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(0)
})

it('exposes concurrent choices of a newest unfinished draft as an explicit synchronization conflict', () => {
  const { a } = orderedCandidates(); a.engine.enable(); const b = replica(a.projectId); b.engine.join(a.engine.exportBundle())
  draft(a.db, 5, '电脑继续生成的第五章'); draft(b.db, 5, '手机继续生成的第五章')
  const preview = a.engine.receive(b.engine.exportBundle()), conflict = preview.conflicts.find(value => value.kind === 'draft-selection')!
  expect(conflict.id).toBe('5'); expect(conflict.variants).toHaveLength(2)
  expect(a.engine.apply(preview.token).applied).toBe(false)
  const selectedId = b.db.prepare("SELECT m.entity_id FROM project_sync_entity_map m JOIN drafts d ON m.kind='draft' AND m.local_key=CAST(d.id AS TEXT) JOIN contents c ON c.id=d.content_id WHERE c.body='手机继续生成的第五章'").pluck().get()
  const selected = conflict.variants.find(value => (value.value as { draftId?: string })?.draftId === selectedId)!
  expect(a.engine.apply(preview.token, [{ kind: conflict.kind, id: conflict.id, expectedHeads: conflict.variants.map(value => value.revision), selectedRevision: selected.revision }]).applied).toBe(true)
  expect(Stories.read(a.db).nodes.find(node => node.id === 'chapter:5')?.body).toBe('手机继续生成的第五章')
  expect(a.db.prepare('SELECT COUNT(*) FROM drafts WHERE chapter_number=5').pluck().get()).toBe(4)
})
