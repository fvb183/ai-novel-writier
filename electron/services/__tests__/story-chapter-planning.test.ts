import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { STORY_BRANCH_SQL } from '../story-branch-schema'
import { StoryBranchRepository as Stories } from '../../repositories/story-branch-repository'
import { forkStoryFromChapter } from '../story-chapter-planning'
import { MAINLINE_STORY_ROUTE_ID, mainlineStoryNodeId } from '../../../src/shared/story-branches'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
let db: Database.Database
beforeEach(() => { db = new Database(':memory:'); initializeLegacyBaselineSchema(db); db.exec(STORY_BRANCH_SQL) })
afterEach(() => { db.close(); vi.restoreAllMocks() })
function blueprint(chapter: number, title = `蓝图${chapter}`) {
  db.prepare(`INSERT INTO blueprints(chapter_number,title,role,purpose,key_events,characters,suspense_hook,user_guidance,notes)
    VALUES(?,?,'发展','本章目的',?,'["主角"]','本章悬念','作者指导','本章笔记')`).run(chapter, title, `关键事件${chapter}`)
}
function draft(chapter: number, body: string, options: { status?: string; dependencies?: string } = {}) {
  const contentId = db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid
  const version = Number(db.prepare('SELECT COALESCE(MAX(version),0)+1 FROM drafts WHERE chapter_number=?').pluck().get(chapter))
  return Number(db.prepare(`INSERT INTO drafts(chapter_number,version,status,source,content_id,source_dependencies) VALUES(?,?,?,'write',?,?)`)
    .run(chapter, version, options.status ?? 'draft', contentId, options.dependencies ?? '[]').lastInsertRowid)
}
function mainline() { for (const chapter of [1, 2, 3]) { blueprint(chapter); draft(chapter, `主线第${chapter}章正文`) } }
function mainFacts() {
  return Object.fromEntries(['blueprints', 'drafts', 'contents', 'finalization_outbox'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]))
}
function fork(afterChapter = 2, placement: 'branch' | 'insert' = 'branch', title = '新的支线章节') {
  return forkStoryFromChapter(db, { expectedRevision: Stories.read(db).revision, afterChapter, placement, title })
}
const branchInput = (id: string) => {
  const { revisionId: _revision, ...input } = Stories.read(db).nodes.find(node => node.id === id)!
  return input
}

describe('live canonical chapter projection and branch authoring', () => {
  it('rejects backwards canonical paths before compacting their live anchors', () => {
    mainline(); const before = Stories.read(db)
    expect(() => Stories.commit(db, before.revision, [{ type: 'put-route', route: {
      id: 'bb018d6a-015f-4aa0-b125-7a8b16359f28', title: '倒序主线', nodeIds: ['chapter:3', 'chapter:1'],
    } }])).toThrow('STORY_ROUTE_DISCONNECTED')
    expect(Stories.read(db)).toEqual(before)
  })
  it('includes imported prose chapters without inventing blueprints and never copies projected chapters into story storage', () => {
    draft(1, '只有导入正文一'); draft(2, '只有导入正文二'); blueprint(3)
    const before = mainFacts(), read = Stories.read(db)
    expect(read.nodes.map(node => node.id)).toEqual(['chapter:1', 'chapter:2', 'chapter:3'])
    expect(read.nodes[0]).toMatchObject({ body: '只有导入正文一', mainline: { chapterNumber: 1, hasBlueprint: false, manuscriptStatus: 'draft' } })
    expect(read.nodes[0].chapterBlueprint).toBeUndefined()
    expect(read.nodes[1].chapterBlueprint).toBeUndefined()
    expect(read.nodes[2].mainline?.hasBlueprint).toBe(true)
    expect(read.nodes[2].body).toBe(''); expect(read.nodes[2].event).toBe('')
    expect(read.routes.find(route => route.id === MAINLINE_STORY_ROUTE_ID)?.nodeIds).toEqual(['chapter:1', 'chapter:2', 'chapter:3'])
    expect(db.prepare('SELECT COUNT(*) FROM story_nodes').pluck().get()).toBe(0)
    expect(db.prepare('SELECT COUNT(*) FROM story_node_revisions').pluck().get()).toBe(0)
    expect(mainFacts()).toEqual(before)
  })

  it('keeps stable chapter identities while returning current canonical planning and prose on every read', () => {
    mainline(); const first = Stories.read(db), before = mainFacts()
    db.prepare("UPDATE blueprints SET title='新的原蓝图标题',purpose='新的原蓝图目的' WHERE chapter_number=2").run()
    draft(2, '原章第二章新稿')
    const second = Stories.read(db), node = second.nodes.find(node => node.id === 'chapter:2')!
    expect(node.title).toBe('新的原蓝图标题'); expect(node.chapterBlueprint?.purpose).toBe('新的原蓝图目的')
    expect(node.body).toBe('原章第二章新稿')
    expect(node.id).toBe(first.nodes.find(node => node.chapterNumber === 2)!.id)
    expect(second.revision).not.toBe(first.revision)
    expect(node.revisionId).not.toBe(first.nodes.find(node => node.id === node.id)!.revisionId)
    expect(mainFacts()).not.toEqual(before)
    expect(db.prepare('SELECT COUNT(*) FROM story_nodes').pluck().get()).toBe(0)
  })

  it('forks directly from a live imported chapter and stores only the independent child, links and anchor route', () => {
    draft(1, '没有蓝图的正文'); draft(2, '第二章正文'); const before = mainFacts(), created = fork(1)
    const child = created.snapshot.nodes.find(node => node.id === created.nodeId)!
    expect(child.body).toBe(''); expect(child.chapterSource).toBeUndefined(); expect(child.mainline).toBeUndefined()
    expect(child.chapterBlueprint?.title).toBe('新的支线章节')
    expect(db.prepare('SELECT COUNT(*) FROM story_nodes').pluck().get()).toBe(1)
    expect(db.prepare('SELECT COUNT(*) FROM story_node_revisions').pluck().get()).toBe(1)
    const stored = JSON.parse(String(db.prepare('SELECT payload_json FROM story_routes WHERE id=?').pluck().get(created.routeId)))
    expect(stored.nodeIds).toEqual(['chapter:1', child.id])
    expect(Stories.context(db, { nodeId: child.id, routeId: created.routeId, mode: 'route' }).prefix.map(node => node.id)).toEqual(['chapter:1'])
    expect(mainFacts()).toEqual(before)
  })

  it('inserts between actual neighboring chapters, preserves the canonical chain, and resolves the live main-line tail', () => {
    for (const chapter of [1, 2, 4, 5]) { blueprint(chapter); draft(chapter, `正文${chapter}`) }
    const before = mainFacts(), created = fork(2, 'insert'), route = created.snapshot.routes.find(route => route.id === created.routeId)!
    expect(route.nodeIds).toEqual(['chapter:1', 'chapter:2', created.nodeId, 'chapter:4', 'chapter:5'])
    const stored = JSON.parse(String(db.prepare('SELECT payload_json FROM story_routes WHERE id=?').pluck().get(created.routeId)))
    expect(stored.nodeIds).toEqual(['chapter:2', created.nodeId, 'chapter:4'])
    expect(created.snapshot.edges.some(edge => edge.from === 'chapter:2' && edge.to === 'chapter:4')).toBe(true)
    expect(created.snapshot.edges.some(edge => edge.from === 'chapter:2' && edge.to === created.nodeId)).toBe(true)
    expect(created.snapshot.edges.some(edge => edge.from === created.nodeId && edge.to === 'chapter:4')).toBe(true)
    const request = { nodeId: created.nodeId, routeId: created.routeId, mode: 'route' as const }
    const past = Stories.context(db, request)
    expect(past.prefix.map(node => node.id)).toEqual(['chapter:1', 'chapter:2'])
    expect(past.continuation).toBeUndefined(); expect(JSON.stringify(past)).not.toContain('正文4')
    const bridge = Stories.context(db, { ...request, bridgeToNodeId: 'chapter:4' })
    expect(bridge.continuation?.node.body).toBe('正文4')
    expect(JSON.stringify(bridge)).not.toContain('正文5')
    expect(bridge.sourceHash).toBe(past.sourceHash); expect(bridge.contextHash).not.toBe(past.contextHash)
    expect(mainFacts()).toEqual(before)
  })

  it('automatically includes a newly imported earlier chapter without rewriting branch storage', () => {
    draft(1, '一'); draft(3, '三'); const created = fork(3)
    const raw = db.prepare('SELECT payload_json FROM story_routes WHERE id=?').pluck().get(created.routeId)
    expect(created.snapshot.routes.find(route => route.id === created.routeId)?.nodeIds).toEqual(['chapter:1', 'chapter:3', created.nodeId])
    draft(2, '新补入的二')
    const read = Stories.read(db)
    expect(read.routes.find(route => route.id === created.routeId)?.nodeIds).toEqual(['chapter:1', 'chapter:2', 'chapter:3', created.nodeId])
    expect(db.prepare('SELECT payload_json FROM story_routes WHERE id=?').pluck().get(created.routeId)).toBe(raw)
    expect(Stories.context(db, { nodeId: created.nodeId, routeId: created.routeId, mode: 'route' }).prefix[1].body).toBe('新补入的二')
  })

  it('retains chapters after blueprint deletion when prose exists and fails closed for a truly missing anchor', () => {
    mainline(); const created = fork(2)
    db.prepare('DELETE FROM blueprints WHERE chapter_number=2').run()
    expect(Stories.read(db).nodes.find(node => node.id === 'chapter:2')?.chapterBlueprint).toBeUndefined()
    expect(Stories.context(db, { nodeId: created.nodeId, routeId: created.routeId, mode: 'route' }).prefix.at(-1)?.body).toBe('主线第2章正文')
    db.prepare('DELETE FROM drafts WHERE chapter_number=2').run()
    const read = Stories.read(db)
    expect(read.nodes.find(node => node.id === 'chapter:2')?.mainline?.manuscriptStatus).toBe('missing')
    expect(read.nodes.find(node => node.id === created.nodeId)).toBeTruthy()
    expect(() => Stories.context(db, { nodeId: created.nodeId, routeId: created.routeId, mode: 'route' })).toThrow('STORY_CHAPTER_NOT_FOUND')
  })

  it('keeps a broken canonical chapter visible without blocking other stored branches or the book view', () => {
    blueprint(1); draft(1, '无效依赖草稿', { dependencies: 'not-json' })
    const read = Stories.read(db)
    expect(read.nodes[0].mainline?.manuscriptStatus).toBe('unavailable')
    expect(() => Stories.context(db, { nodeId: 'chapter:1', routeId: MAINLINE_STORY_ROUTE_ID, mode: 'route' })).toThrow('STORY_CHAPTER_NOT_FOUND')
    expect(() => fork(1)).toThrow('STORY_CHAPTER_NOT_FOUND')
  })

  it('does not allow story operations to write, remove or restore virtual mainline chapters and derived topology', () => {
    mainline(); const before = Stories.read(db), node = before.nodes.find(node => node.id === 'chapter:1')!, facts = mainFacts()
    const { revisionId: _revision, ...input } = node
    for (const operation of [
      { type: 'put-node', node: { ...input, body: '覆盖原章' } }, { type: 'delete-node', id: node.id },
      { type: 'restore-node', id: node.id, revisionId: crypto.randomUUID() },
      { type: 'delete-route', id: MAINLINE_STORY_ROUTE_ID }, { type: 'put-route', route: before.routes[0] },
      { type: 'delete-edge', id: before.edges[0].id }, { type: 'put-edge', edge: before.edges[0] },
    ]) expect(() => Stories.commit(db, before.revision, [operation as Parameters<typeof Stories.commit>[2][number]])).toThrow('STORY_MAINLINE_READ_ONLY')
    expect(mainFacts()).toEqual(facts); expect(Stories.read(db)).toEqual(before)
  })

  it('rejects stale author CAS and generated context after main-line planning or manuscript changes', () => {
    mainline(); const created = fork(2), input = branchInput(created.nodeId)
    const request = { nodeId: created.nodeId, routeId: created.routeId, mode: 'route' as const }, old = Stories.context(db, request)
    db.prepare("UPDATE blueprints SET purpose='父章新规划' WHERE chapter_number=1").run()
    expect(() => Stories.commit(db, created.snapshot.revision, [{ type: 'put-node', node: { ...input, body: '旧稿' } }])).toThrow('STORY_REVISION_STALE')
    draft(1, '父章新正文')
    expect(() => Stories.commit(db, Stories.read(db).revision, [{ type: 'put-node', node: { ...input, body: '旧上下文生成' } }],
      { expectedContext: { request, contextHash: old.contextHash } })).toThrow('STORY_CONTEXT_STALE')
    const current = Stories.context(db, request)
    expect(current.prefix[0].body).toBe('父章新正文'); expect(current.sourceHash).not.toBe(old.sourceHash)
  })

  it('saves a branch blueprint and generated body while its parent remains a live canonical reference', () => {
    mainline(); const facts = mainFacts(), created = fork(1, 'insert'), input = branchInput(created.nodeId)
    const planned = Stories.commit(db, created.snapshot.revision, [{ type: 'put-node', node: { ...input, chapterBlueprint: { ...input.chapterBlueprint!, purpose: '支线目标' } } }])
    const request = { nodeId: created.nodeId, routeId: created.routeId, mode: 'route' as const, bridgeToNodeId: 'chapter:2' }
    const context = Stories.context(db, request), plannedInput = branchInput(created.nodeId)
    const written = Stories.commit(db, planned.revision, [{ type: 'put-node', node: { ...plannedInput, body: '作者批准的生成章节' } }],
      { expectedContext: { request, contextHash: context.contextHash } })
    expect(written.edges).toEqual(planned.edges); expect(written.routes).toEqual(planned.routes)
    expect(written.nodes.find(node => node.id === created.nodeId)?.chapterBlueprint?.purpose).toBe('支线目标')
    expect(mainFacts()).toEqual(facts)
    const previous = Stories.context(db, request)
    draft(2, '指定后文变化')
    const refreshed = Stories.context(db, request)
    expect(refreshed.sourceHash).toBe(previous.sourceHash); expect(refreshed.contextHash).not.toBe(previous.contextHash)
    expect(() => Stories.commit(db, Stories.read(db).revision, [{ type: 'put-node', node: { ...plannedInput, body: '旧后文候选' } }],
      { expectedContext: { request, contextHash: previous.contextHash } })).toThrow('STORY_CONTEXT_STALE')
  })

  it('preserves legacy independent source snapshots and immutable revisions without silently turning them into mainline nodes', () => {
    mainline()
    const legacy = { id: crypto.randomUUID(), kind: 'content' as const, title: 'R1旧独立快照', chapterNumber: 1, body: '历史独立稿', event: '历史计划',
      chapterSource: { chapterNumber: 1, blueprintHash: 'a'.repeat(64), manuscriptHash: 'b'.repeat(64) } }
    const saved = Stories.commit(db, Stories.read(db).revision, [{ type: 'put-node', node: legacy }])
    const revision = saved.nodes.find(node => node.id === legacy.id)!.revisionId
    fork(1)
    expect(Stories.read(db).nodes.find(node => node.id === legacy.id)).toEqual({ ...legacy, revisionId: revision })
    expect(Stories.read(db).nodes.find(node => node.id === mainlineStoryNodeId(1))?.body).toBe('主线第1章正文')
    expect(Stories.read(db).revisions.find(row => row.id === revision)?.node).toEqual(legacy)
  })

  it('refuses a bridge that loops backwards through the derived main-line chain and keeps all data intact', () => {
    mainline(); const created = fork(3), before = Stories.read(db)
    expect(() => Stories.commit(db, before.revision, [{ type: 'put-edge', edge: { id: crypto.randomUUID(), from: created.nodeId, to: 'chapter:1', label: '', condition: '' } }])).toThrow('STORY_CYCLE')
    expect(Stories.read(db)).toEqual(before)
    expect(() => fork(3, 'insert')).toThrow('STORY_CHAPTER_NEXT_REQUIRED')
  })
})
