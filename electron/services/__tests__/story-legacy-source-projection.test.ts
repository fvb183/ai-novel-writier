import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { StoryBranchRepository as Stories, storyCanonicalJson } from '../../repositories/story-branch-repository'
import { STORY_BRANCH_SQL } from '../story-branch-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { getProjectSyncEngine, wrapProjectDatabase } from '../project-sync-service'
import { syncDigest } from '../project-sync-engine'
import type { StoryChapterBlueprint, StoryNodeInput, StoryOperation } from '../../../src/shared/story-branches'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
let db: Database.Database
beforeEach(() => { db = new Database(':memory:'); initializeLegacyBaselineSchema(db); db.exec(STORY_BRANCH_SQL) })
afterEach(() => db.close())
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const blank = (title = ''): StoryChapterBlueprint => ({ title, role: '', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '', notes: '' })
function draft(chapter: number, body: string, status = 'draft') {
  const content = db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid
  const version = Number(db.prepare('SELECT COALESCE(MAX(version),0)+1 FROM drafts WHERE chapter_number=?').pluck().get(chapter))
  return Number(db.prepare('INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(?,?,?,?)').run(chapter, version, status, content).lastInsertRowid)
}
function source(chapterNumber: number, body: string, chapterBlueprint = blank()): StoryNodeInput {
  return { id: randomUUID(), kind: 'content', title: chapterBlueprint.title || `原导入稿名${chapterNumber}`, chapterNumber,
    event: chapterBlueprint.keyEvents, body, chapterBlueprint,
    chapterSource: { chapterNumber, manuscriptHash: digest(body), blueprintHash: digest(storyCanonicalJson(chapterBlueprint)) } }
}
function storedInput(id: string): StoryNodeInput {
  const { revisionId: _revision, ...input } = JSON.parse(String(db.prepare('SELECT payload_json FROM story_nodes WHERE id=?').pluck().get(id)))
  return input
}
function storyRows() { return Object.fromEntries(['story_nodes', 'story_edges', 'story_routes', 'story_notes', 'story_node_revisions'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])) }
function currentBook() {
  const sources: StoryNodeInput[] = []
  for (const chapter of [1, 2, 3, 4, 5]) {
    const planning = chapter < 3 ? blank() : { ...blank(`原蓝图第${chapter}章`), keyEvents: `原计划${chapter}` }
    if (chapter >= 3) db.prepare('INSERT INTO blueprints(chapter_number,title,key_events) VALUES(?,?,?)').run(chapter, `当前蓝图第${chapter}章`, `当前计划${chapter}`)
    const body = chapter === 5 ? '第五章当前主线正文' : `当前第${chapter}章正文`
    draft(chapter, body, chapter < 5 ? 'finalized' : 'draft')
    sources.push(source(chapter, chapter === 5 ? '第五章R1冻结的旧正文' : body, planning))
  }
  const child: StoryNodeInput = { id: randomUUID(), kind: 'content', title: '真正的独立支线', chapterNumber: 6, event: '', body: '', chapterBlueprint: blank('独立第六章') }
  const snapshotRoute = { id: randomUUID(), title: '主线快照 · 第 5 章', nodeIds: sources.map(node => node.id) }
  const branchRoute = { id: randomUUID(), title: '真正的支线路线', nodeIds: [...snapshotRoute.nodeIds, child.id] }
  const operations: StoryOperation[] = [...sources, child].map(node => ({ type: 'put-node', node }))
  operations.push(...sources.slice(1).map((node, index) => ({ type: 'put-edge' as const, edge: { id: randomUUID(), from: sources[index].id, to: node.id, label: '', condition: '' } })),
    { type: 'put-edge', edge: { id: randomUUID(), from: sources[4].id, to: child.id, label: '独立展开', condition: '' } },
    { type: 'put-route', route: snapshotRoute }, { type: 'put-route', route: branchRoute })
  const snapshot = Stories.commit(db, Stories.read(db).revision, operations)
  return { sources, child, snapshotRoute, branchRoute, snapshot }
}

describe('projection-only R1 source compatibility', () => {
  it('folds the five pristine historical sources into five current chapters and keeps only the actual independent chapter', () => {
    const f = currentBook(), before = storyRows(), read = Stories.read(db)
    expect(read.nodes).toHaveLength(6)
    expect(read.nodes.filter(node => node.mainline).map(node => node.id)).toEqual(['chapter:1', 'chapter:2', 'chapter:3', 'chapter:4', 'chapter:5'])
    expect(read.nodes.find(node => node.id === 'chapter:1')?.chapterBlueprint).toBeUndefined()
    expect(read.nodes.find(node => node.id === 'chapter:5')?.body).toBe('第五章当前主线正文')
    expect(read.aliases?.nodes).toEqual(Object.fromEntries(f.sources.map(node => [node.id, `chapter:${node.chapterNumber}`])))
    expect(read.aliases?.routes[f.snapshotRoute.id]).toBe('mainline')
    expect(read.routes.map(route => route.id).sort()).toEqual([f.branchRoute.id, 'mainline'].sort())
    expect(read.routes.find(route => route.id === f.branchRoute.id)?.nodeIds).toEqual(['chapter:1', 'chapter:2', 'chapter:3', 'chapter:4', 'chapter:5', f.child.id])
    expect(read.edges).toHaveLength(5)
    expect(new Set(read.edges.map(edge => `${edge.from}|${edge.to}`)).size).toBe(read.edges.length)
    expect(read.edges.some(edge => edge.from === 'chapter:5' && edge.to === f.child.id)).toBe(true)
    expect(read.revisions).toHaveLength(6)
    expect(read.revisions.some(revision => revision.node.body === '第五章R1冻结的旧正文')).toBe(true)
    expect(storyRows()).toEqual(before)
  })

  it('uses the live original in branch context and accepts old selected-source aliases without exposing frozen prose to the model scope', () => {
    const f = currentBook(), context = Stories.context(db, { nodeId: f.child.id, routeId: f.branchRoute.id, mode: 'route' })
    expect(context.prefix.map(node => node.id)).toEqual(['chapter:1', 'chapter:2', 'chapter:3', 'chapter:4', 'chapter:5'])
    expect(JSON.stringify(context)).toContain('第五章当前主线正文')
    expect(JSON.stringify(context)).not.toContain('第五章R1冻结的旧正文')
    const source = Stories.context(db, { nodeId: f.sources[4].id, routeId: f.snapshotRoute.id, mode: 'route' })
    expect(source.request).toEqual({ nodeId: 'chapter:5', routeId: 'mainline', mode: 'route' })
    expect(source.target.body).toBe('第五章当前主线正文')
    const before = Stories.read(db)
    db.prepare("UPDATE contents SET body='第五章再次改写的主线正文' WHERE id=(SELECT content_id FROM drafts WHERE chapter_number=5)").run()
    const changed = Stories.context(db, context.request)
    expect(changed.contextHash).not.toBe(context.contextHash)
    expect(() => Stories.commit(db, before.revision, [{ type: 'put-node', node: { ...f.child, body: '过期候选' } }])).toThrow('STORY_REVISION_STALE')
    expect(storedInput(f.sources[4].id).body).toBe('第五章R1冻结的旧正文')
  })

  it('reports exact stored-route effects for folded UUID edits without changing records or merging duplicate titles', () => {
    const f = currentBook(), original = storedInput(f.sources[4].id)
    Stories.commit(db, Stories.read(db).revision, [
      { type: 'put-route', route: { id: randomUUID(), title: f.snapshotRoute.title, nodeIds: [...f.snapshotRoute.nodeIds] } },
      { type: 'put-route', route: { id: randomUUID(), title: '仅使用当前主线', nodeIds: ['chapter:1', 'chapter:2', 'chapter:3', 'chapter:4', 'chapter:5'] } },
    ])
    const before = storyRows(), read = Stories.read(db)
    for (const source of f.sources) expect(read.aliases?.affectedRoutes?.[source.id]?.slice().sort()).toEqual([
      f.snapshotRoute.title, f.snapshotRoute.title, f.branchRoute.title,
    ].sort())
    expect(read.aliases?.affectedRoutes?.[f.child.id]).toBeUndefined()
    expect(storyRows()).toEqual(before)
    expect(() => Stories.commit(db, read.revision, [{ type: 'put-node', node: { ...original, body: '旧源的独立修改' } }]))
      .toThrow('SHARED_EDIT_CONFIRMATION_REQUIRED')
    expect(storyRows()).toEqual(before)
    const saved = Stories.commit(db, read.revision, [{ type: 'put-node', node: { ...original, body: '旧源的独立修改' } }], { confirmedSharedEdit: true })
    expect(saved.nodes.find(node => node.id === original.id)?.body).toBe('旧源的独立修改')
    expect(saved.aliases?.affectedRoutes?.[original.id]).toBeUndefined()
  })

  it.each(['body', 'title', 'event', 'kind', 'blueprint', 'source'] as const)('preserves a genuinely edited legacy %s as an independent chapter', field => {
    const f = currentBook(), original = storedInput(f.sources[4].id)
    const delta = field === 'body' ? { body: '作者独立改写的支线正文' } : field === 'title' ? { title: '作者独立改名' }
      : field === 'event' ? { event: '独立事件' } : field === 'kind' ? { kind: 'branch' as const }
        : field === 'blueprint' ? { chapterBlueprint: { ...original.chapterBlueprint!, purpose: '独立改写目的' } }
          : { chapterSource: { ...original.chapterSource!, manuscriptHash: 'a'.repeat(64) } }
    const saved = Stories.commit(db, Stories.read(db).revision, [{ type: 'put-node', node: { ...original, ...delta } }], { confirmedSharedEdit: true })
    expect(saved.nodes.find(node => node.id === original.id)).toMatchObject(delta)
    expect(saved.aliases?.nodes[original.id]).toBeUndefined()
    expect(saved.nodes.find(node => node.id === 'chapter:5')?.body).toBe('第五章当前主线正文')
    expect(saved.revisions.filter(revision => revision.nodeId === original.id)).toHaveLength(2)
  })

  it('keeps an edited-and-restored source independent and preserves every immutable version', () => {
    const f = currentBook(), original = storedInput(f.sources[4].id), root = f.snapshot.revisions.find(revision => revision.nodeId === original.id)!
    Stories.commit(db, Stories.read(db).revision, [{ type: 'put-node', node: { ...original, body: '历史上独立改写过' } }], { confirmedSharedEdit: true })
    const restored = Stories.commit(db, Stories.read(db).revision, [{ type: 'restore-node', id: original.id, revisionId: root.id }], { confirmedSharedEdit: true })
    expect(restored.aliases?.nodes[original.id]).toBeUndefined()
    expect(restored.nodes.find(node => node.id === original.id)?.body).toBe(original.body)
    expect(restored.revisions.filter(revision => revision.nodeId === original.id)).toHaveLength(3)
  })

  it('allows visible branch edits to commit using canonical projected route references while retaining raw frozen sources', () => {
    const f = currentBook(), before = storyRows(), route = f.snapshot.routes.find(route => route.id === f.branchRoute.id)!
    const saved = Stories.commit(db, f.snapshot.revision, [{ type: 'put-node', node: { ...f.child, body: '独立生成并批准的正文' } },
      { type: 'put-route', route: { ...route, title: '已更新的支线路线' } }])
    expect(saved.nodes.find(node => node.id === f.child.id)?.body).toBe('独立生成并批准的正文')
    expect(storedInput(f.sources[4].id).body).toBe('第五章R1冻结的旧正文')
    expect((before.story_node_revisions as unknown[]).every(row => (storyRows().story_node_revisions as unknown[]).some(current => JSON.stringify(row) === JSON.stringify(current)))).toBe(true)
    expect(Stories.context(db, { nodeId: f.child.id, routeId: f.branchRoute.id, mode: 'route' }).prefix.at(-1)?.body).toBe('第五章当前主线正文')
  })

  it('retains independent historical topology when aliasing two sources would invent a cycle', () => {
    draft(1, '主线正文')
    const first = source(1, '快照正文'), last = source(1, '另一份快照正文'), branch: StoryNodeInput = { id: randomUUID(), kind: 'content', title: '历史改道', chapterNumber: 2, body: '独立正文', event: '' }
    const route = { id: randomUUID(), title: '历史路线', nodeIds: [first.id, branch.id, last.id] }
    const operations: StoryOperation[] = [first, last, branch].map(node => ({ type: 'put-node', node }))
    operations.push(
      { type: 'put-edge', edge: { id: randomUUID(), from: first.id, to: branch.id, label: '', condition: '' } },
      { type: 'put-edge', edge: { id: randomUUID(), from: branch.id, to: last.id, label: '', condition: '' } }, { type: 'put-route', route },
    )
    const saved = Stories.commit(db, Stories.read(db).revision, operations)
    expect(saved.aliases).toBeUndefined()
    expect(saved.nodes.find(node => node.id === first.id)?.body).toBe(first.body)
    expect(saved.nodes.find(node => node.id === last.id)?.body).toBe(last.body)
    expect(saved.routes.find(item => item.id === route.id)?.nodeIds).toEqual(route.nodeIds)
  })

  it('rejects new projected cycles atomically rather than silently unfolding a pristine source', () => {
    const f = currentBook(), before = storyRows()
    expect(() => Stories.commit(db, f.snapshot.revision, [{ type: 'put-edge', edge: {
      id: randomUUID(), from: f.child.id, to: 'chapter:1', label: '', condition: '',
    } }])).toThrow('STORY_CYCLE')
    expect(storyRows()).toEqual(before)
    expect(Stories.read(db).aliases?.nodes).toEqual(f.snapshot.aliases?.nodes)
  })

  it('preserves an explicit noncontiguous canonical shortcut when it is continued into a branch', () => {
    const f = currentBook(), route = { id: randomUUID(), title: '跳过第二章的作者路线', nodeIds: ['chapter:1', 'chapter:3'] }
    Stories.commit(db, f.snapshot.revision, [{ type: 'put-edge', edge: { id: randomUUID(), from: 'chapter:1', to: 'chapter:3', label: '跳接', condition: '' } }, { type: 'put-route', route }])
    expect(Stories.read(db).routes.find(item => item.id === route.id)?.nodeIds).toEqual(route.nodeIds)
    const child: StoryNodeInput = { id: randomUUID(), kind: 'content', title: '跳接后的独立章节', chapterNumber: 4, event: '', body: '' }
    Stories.commit(db, Stories.read(db).revision, [{ type: 'put-node', node: child },
      { type: 'put-edge', edge: { id: randomUUID(), from: 'chapter:3', to: child.id, label: '', condition: '' } },
      { type: 'put-route', route: { ...route, nodeIds: [...route.nodeIds, child.id] } }])
    expect(Stories.context(db, { nodeId: child.id, routeId: route.id, mode: 'route' }).prefix.map(node => node.id)).toEqual(['chapter:1', 'chapter:3'])
  })

  it('keeps a noncontiguous legacy source-only author route and its shortcut instead of treating it as an automatic mainline copy', () => {
    const f = currentBook(), route = { id: randomUUID(), title: '作者保留的跳接路线', nodeIds: [f.sources[0].id, f.sources[2].id] }
    Stories.commit(db, f.snapshot.revision, [{ type: 'put-edge', edge: { id: randomUUID(), from: route.nodeIds[0], to: route.nodeIds[1], label: '', condition: '' } }, { type: 'put-route', route }])
    const read = Stories.read(db)
    expect(read.aliases?.routes[route.id]).toBeUndefined()
    expect(read.routes.find(item => item.id === route.id)?.nodeIds).toEqual(['chapter:1', 'chapter:3'])
    expect(read.edges.some(edge => edge.from === 'chapter:1' && edge.to === 'chapter:3')).toBe(true)
  })
})

describe('legacy source projection across actual synchronization', () => {
  function replica(projectId: string) {
    const raw = new Database(':memory:'); initializeLegacyBaselineSchema(raw)
    migrateSchema(new SqliteSchemaAdapter(raw), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
    raw.prepare("INSERT INTO project_core(id,project_name) VALUES('main','旧源归一同步')").run()
    const wrapped = wrapProjectDatabase(raw, projectId)
    return { db: wrapped, engine: getProjectSyncEngine(wrapped, projectId) }
  }
  it('synchronizes untouched frozen rows and exposes the same canonical context after route saves and current manuscript edits', () => {
    db.close(); const projectId = randomUUID(), a = replica(projectId); db = a.db
    const f = currentBook(), frozen = storedInput(f.sources[4].id), originalHistory = db.prepare('SELECT * FROM story_node_revisions ORDER BY id').all()
    a.engine.enable(); const b = replica(projectId)
    try {
      b.engine.join(a.engine.exportBundle())
      expect(Stories.read(b.db)).toEqual(Stories.read(db))
      const route = Stories.read(db).routes.find(route => route.id === f.branchRoute.id)!
      Stories.commit(db, Stories.read(db).revision, [{ type: 'put-node', node: { ...f.child, body: '已经批准的支线正文' } }, { type: 'put-route', route: { ...route, title: '保存后的支线路线' } }])
      b.engine.apply(b.engine.receive(a.engine.exportBundle()).token)
      expect(Stories.read(b.db)).toEqual(Stories.read(db))
      const request = { nodeId: f.child.id, routeId: f.branchRoute.id, mode: 'route' as const }
      expect(Stories.context(b.db, request)).toEqual(Stories.context(db, request))
      expect(JSON.stringify(Stories.context(b.db, request))).not.toContain(frozen.body)
      const previous = Stories.context(db, request)
      b.db.prepare("UPDATE contents SET body='另一端实时修订的第五章' WHERE id=(SELECT content_id FROM drafts WHERE chapter_number=5)").run()
      a.engine.apply(a.engine.receive(b.engine.exportBundle()).token)
      expect(Stories.context(db, request).prefix.at(-1)?.body).toBe('另一端实时修订的第五章')
      expect(Stories.context(db, request).contextHash).not.toBe(previous.contextHash)
      expect(storedInput(frozen.id)).toEqual(frozen)
      expect(originalHistory.every(row => db.prepare('SELECT * FROM story_node_revisions WHERE id=?').get((row as { id: string }).id)
        && JSON.stringify(db.prepare('SELECT * FROM story_node_revisions WHERE id=?').get((row as { id: string }).id)) === JSON.stringify(row))).toBe(true)
    } finally { b.db.close() }
  })

  it('rejects a fully rehashed incoming back-edge against the admitted canonical view before storing any pending batch', () => {
    db.close(); const projectId = randomUUID(), a = replica(projectId); db = a.db
    const f = currentBook(); a.engine.enable(); const b = replica(projectId)
    try {
      b.engine.join(a.engine.exportBundle())
      const original = a.engine.exportBundle(), previous = original.batches.filter(batch => batch.replicaId === original.senderReplicaId).sort((a, b) => b.sequence - a.sequence)[0]
      const id = randomUUID(), payload = { protocol: 1 as const, projectId, replicaId: original.senderReplicaId, sequence: previous.sequence + 1,
        previousHash: previous.hash, batchId: randomUUID(), changes: [{ kind: 'story_edges', id, parents: [], deleted: false,
          value: { id, from: f.child.id, to: 'chapter:1', label: '', condition: '' } }] }
      const { hash: _hash, ...envelope } = original, forged = { ...envelope, batches: [...original.batches, { ...payload, hash: syncDigest(payload) }] }
      const before = Stories.read(b.db)
      expect(() => b.engine.receive({ ...forged, hash: syncDigest(forged) })).toThrow('PROJECT_SYNC_STORY_INVALID')
      expect(Stories.read(b.db)).toEqual(before); expect(b.engine.status().pendingBatches).toBe(0)
    } finally { b.db.close() }
  })
})

describe('manuscript evidence and empty-blueprint deletion', () => {
  it('does not invent a manuscript-only chapter from whitespace draft placeholders but preserves a blueprint-only chapter', () => {
    draft(1, ' \n\t'); draft(1, '', 'archived')
    expect(Stories.read(db).nodes).toEqual([])
    db.prepare("INSERT INTO blueprints(chapter_number,title) VALUES(1,'待写蓝图')").run()
    expect(Stories.read(db).nodes[0]).toMatchObject({ id: 'chapter:1', mainline: { hasBlueprint: true, hasManuscript: false, manuscriptStatus: 'unwritten' } })
    db.prepare('DELETE FROM blueprints WHERE chapter_number=1').run()
    expect(Stories.read(db).nodes).toEqual([])
  })

  it('keeps manuscript evidence when the current draft is blank but historical prose exists, without changing current draft selection', () => {
    draft(1, '历史中确有正文'); draft(1, '')
    expect(Stories.read(db).nodes[0]).toMatchObject({ id: 'chapter:1', body: '', mainline: { hasBlueprint: false, hasManuscript: true, manuscriptStatus: 'unwritten' } })
  })

  it('does not let an untouched R1 source resurrect a deleted unwritten blueprint as a second visible node', () => {
    const planning = blank('未生成章节')
    db.prepare("INSERT INTO blueprints(chapter_number,title) VALUES(1,'未生成章节')").run(); draft(1, '')
    const frozen = source(1, '', planning), route = { id: randomUUID(), title: '主线快照 · 第 1 章', nodeIds: [frozen.id] }
    Stories.commit(db, Stories.read(db).revision, [{ type: 'put-node', node: frozen }, { type: 'put-route', route }])
    const before = storyRows()
    db.prepare('DELETE FROM blueprints WHERE chapter_number=1').run()
    const read = Stories.read(db)
    expect(read.nodes).toEqual([]); expect(read.routes).toEqual([])
    expect(read.aliases?.nodes[frozen.id]).toBe('chapter:1')
    expect(storyRows()).toEqual(before)
  })

  it('keeps an explicit missing source for a real branch after deleting its unwritten canonical blueprint', () => {
    const planning = blank('待写主章')
    db.prepare("INSERT INTO blueprints(chapter_number,title) VALUES(1,'待写主章')").run(); draft(1, '')
    const frozen = source(1, '', planning), child: StoryNodeInput = { id: randomUUID(), kind: 'content', title: '真实独立分支', chapterNumber: 2, event: '', body: '独立分支正文' }
    const route = { id: randomUUID(), title: '独立路线', nodeIds: [frozen.id, child.id] }
    Stories.commit(db, Stories.read(db).revision, [{ type: 'put-node', node: frozen }, { type: 'put-node', node: child },
      { type: 'put-edge', edge: { id: randomUUID(), from: frozen.id, to: child.id, label: '', condition: '' } }, { type: 'put-route', route }])
    db.prepare('DELETE FROM blueprints WHERE chapter_number=1').run()
    const read = Stories.read(db)
    expect(read.nodes.find(node => node.id === frozen.id)).toBeUndefined()
    expect(read.nodes.find(node => node.id === 'chapter:1')?.mainline?.manuscriptStatus).toBe('missing')
    expect(read.nodes.find(node => node.id === child.id)?.body).toBe('独立分支正文')
    expect(() => Stories.context(db, { nodeId: child.id, routeId: route.id, mode: 'route' })).toThrow('STORY_CHAPTER_NOT_FOUND')
  })
})


it('projects reviewed legacy work as the live mainline without inventing a blueprint', () => {
  draft(1, '审稿后仍在创作的正文', 'reviewed')
  const nodes = Stories.read(db).nodes
  expect(nodes).toHaveLength(1)
  expect(nodes[0]).toMatchObject({ id: 'chapter:1', body: '审稿后仍在创作的正文',
    mainline: { manuscriptStatus: 'draft', hasBlueprint: false, hasManuscript: true } })
  expect(db.prepare('SELECT COUNT(*) FROM blueprints').pluck().get()).toBe(0)
})
