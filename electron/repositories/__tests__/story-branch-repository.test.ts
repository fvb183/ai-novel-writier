import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { STORY_BRANCH_SQL } from '../../services/story-branch-schema'
import { StoryBranchRepository as Story, validateStoryData, validateStoryRecord } from '../story-branch-repository'
import type { StoryNodeInput, StoryOperation, StorySnapshot } from '../../../src/shared/story-branches'

const handles: Database.Database[] = []
afterEach(() => handles.splice(0).forEach(db => db.close()))
function database() { const db = new Database(':memory:'); db.exec(STORY_BRANCH_SQL); handles.push(db); return db }
function node(title: string, body = title, kind: StoryNodeInput['kind'] = 'content'): StoryNodeInput {
  return { id: randomUUID(), kind, title, chapterNumber: 1, event: `事件：${body}`, body }
}
function fixture() {
  const db = database(), start = node('分支点', '共同起点', 'branch'), a = node('救下朋友', '仅甲路线拿到钥匙并受伤'),
    b = node('追踪敌人', '仅乙路线丢失钥匙且毫发无伤'), merge = node('大厅汇合', '共享正文', 'merge'), end = node('共同后续')
  const rA = { id: randomUUID(), title: '救人路线', nodeIds: [start.id, a.id, merge.id, end.id] }
  const rB = { id: randomUUID(), title: '追踪路线', nodeIds: [start.id, b.id, merge.id, end.id] }
  const edges = [[start, a], [start, b], [a, merge], [b, merge], [merge, end]].map(([from, to]) => ({ id: randomUUID(), from: from!.id, to: to!.id, label: '', condition: '由作者决定' }))
  const operations: StoryOperation[] = [...[start, a, b, merge, end].map(item => ({ type: 'put-node' as const, node: item })),
    ...edges.map(edge => ({ type: 'put-edge' as const, edge })), { type: 'put-route', route: rA }, { type: 'put-route', route: rB }]
  let saved = Story.commit(db, Story.read(db).revision, operations)
  const commit = (ops: StoryOperation[], options = {}) => (saved = Story.commit(db, saved.revision, ops, options))
  return { db, start, a, b, merge, end, rA, rB, edges, commit, read: () => Story.read(db) }
}
function data(snapshot: StorySnapshot) {
  const { revision: _revision, ...result } = snapshot
  return result
}
it('keeps each route’s prose and events isolated and exposes only the shared prefix at a merge', () => {
  const f = fixture()
  const a = Story.context(f.db, { nodeId: f.merge.id, routeId: f.rA.id, mode: 'route' })
  const b = Story.context(f.db, { nodeId: f.merge.id, routeId: f.rB.id, mode: 'route' })
  expect(a.prefix.map(item => item.id)).toEqual([f.start.id, f.a.id])
  expect(b.prefix.map(item => item.id)).toEqual([f.start.id, f.b.id])
  expect(JSON.stringify(a)).not.toContain('仅乙路线')
  expect(JSON.stringify(b)).not.toContain('仅甲路线')
  expect(a.readyForGeneration).toBe(false)
  const shared = Story.context(f.db, { nodeId: f.merge.id, routeId: null, mode: 'shared' })
  expect(shared.prefix.map(item => item.id)).toEqual([f.start.id])
  expect(JSON.stringify(shared)).not.toContain('仅甲路线')
  expect(JSON.stringify(shared)).not.toContain('仅乙路线')
  expect(shared.entrances).toHaveLength(2)
  expect(shared.readyForGeneration).toBe(false)
  expect(Story.context(f.db, { nodeId: f.end.id, routeId: null, mode: 'shared' }).readyForGeneration).toBe(false)
})
it('requires explicit author confirmation of common continuity and invalidates it after either incoming path changes', () => {
  const f = fixture(), request = { nodeId: f.merge.id, routeId: null, mode: 'shared' as const }
  const first = Story.context(f.db, request), note = { id: randomUUID(), nodeId: f.merge.id, routeId: null,
    summary: '作者确认：双方都抵达大厅。', characterStates: '身份设定相同，路线伤势不作为共同状态。', entryDifferences: '救人路线有钥匙且受伤；追踪路线无钥匙且健康。' }
  f.commit([{ type: 'put-note', note, expectedSourceHash: first.sourceHash, confirm: false }])
  expect(Story.context(f.db, request).readyForGeneration).toBe(false)
  f.commit([{ type: 'put-note', note, expectedSourceHash: first.sourceHash, confirm: true }])
  const confirmed = Story.context(f.db, request)
  expect(confirmed.noteCurrent).toBe(true)
  expect(confirmed.readyForGeneration).toBe(true)
  f.commit([{ type: 'put-node', node: { ...f.b, event: '作者改变了追踪路线事件', body: '乙路线改为拿到地图' } }])
  const changed = Story.context(f.db, request)
  expect(changed.note).toEqual(confirmed.note)
  expect(changed.noteCurrent).toBe(false)
  expect(changed.readyForGeneration).toBe(false)
  expect(changed.sourceHash).not.toBe(first.sourceHash)
  expect(() => f.commit([{ type: 'put-note', note, expectedSourceHash: first.sourceHash, confirm: true }])).toThrow('STORY_CONTEXT_STALE')
})
it('does not use unconfirmed or stale route notes as generation authority and keeps unrelated route edits separate', () => {
  const f = fixture(), request = { nodeId: f.merge.id, routeId: f.rA.id, mode: 'route' as const }
  const first = Story.context(f.db, request), note = { id: randomUUID(), nodeId: f.merge.id, routeId: f.rA.id,
    summary: '甲路线前情', characterStates: '甲路线受伤', entryDifferences: '' }
  f.commit([{ type: 'put-note', note, expectedSourceHash: first.sourceHash, confirm: false }])
  expect(Story.context(f.db, request).contextHash).toBe(first.contextHash)
  f.commit([{ type: 'put-note', note, expectedSourceHash: first.sourceHash, confirm: true }])
  const confirmed = Story.context(f.db, request)
  expect(confirmed.contextHash).not.toBe(first.contextHash)
  f.commit([{ type: 'put-node', node: { ...f.b, body: '另一条路线变化' } }])
  expect(Story.context(f.db, request).contextHash).toBe(confirmed.contextHash)
  f.commit([{ type: 'put-node', node: { ...f.a, body: '甲路线前情变化' } }])
  const stale = Story.context(f.db, request)
  expect(stale.noteCurrent).toBe(false)
  expect(stale.contextHash).not.toBe(confirmed.contextHash)
})
it('requires shared-body confirmation, retains immutable versions and restores as a new version', () => {
  const f = fixture(), initial = f.read(), old = initial.nodes.find(item => item.id === f.merge.id)!
  const edited = { ...f.merge, body: '改写双方共享的汇合正文' }
  expect(() => f.commit([{ type: 'put-node', node: edited }])).toThrow('STORY_SHARED_EDIT_CONFIRMATION_REQUIRED')
  expect(() => f.commit([{ type: 'delete-route', id: f.rA.id }, { type: 'delete-route', id: f.rB.id },
    { type: 'put-node', node: edited }, { type: 'put-route', route: f.rA }, { type: 'put-route', route: f.rB }])).toThrow('STORY_SHARED_EDIT_CONFIRMATION_REQUIRED')
  expect(f.read()).toEqual(initial)
  f.commit([{ type: 'put-node', node: edited }], { confirmedSharedEdit: true })
  const middle = f.read(), changed = middle.nodes.find(item => item.id === f.merge.id)!
  expect(changed.revisionId).not.toBe(old.revisionId)
  expect(middle.revisions.find(item => item.id === old.revisionId)?.node.body).toBe('共享正文')
  expect(() => f.commit([{ type: 'restore-node', id: f.merge.id, revisionId: old.revisionId }])).toThrow('STORY_SHARED_EDIT_CONFIRMATION_REQUIRED')
  f.commit([{ type: 'restore-node', id: f.merge.id, revisionId: old.revisionId }], { confirmedSharedEdit: true })
  const restored = f.read().nodes.find(item => item.id === f.merge.id)!
  expect(restored.body).toBe('共享正文')
  expect(restored.revisionId).not.toBe(old.revisionId)
  expect(f.read().revisions.find(item => item.id === restored.revisionId)?.parentRevisionId).toBe(changed.revisionId)
})
it('protects graph revisions and recomputes the generation context in the commit transaction', () => {
  const f = fixture(), initial = f.read(), request = { nodeId: f.a.id, routeId: f.rA.id, mode: 'route' as const }
  const captured = Story.context(f.db, request)
  f.commit([{ type: 'put-node', node: { ...f.a, body: '前情已改写' } }])
  expect(() => Story.commit(f.db, initial.revision, [{ type: 'put-node', node: f.a }])).toThrow('STORY_REVISION_STALE')
  const before = f.read()
  expect(() => f.commit([{ type: 'put-node', node: { ...f.merge, body: '迟到的AI候选' } }], {
    confirmedSharedEdit: true, expectedContext: { request, contextHash: captured.contextHash },
  })).toThrow('STORY_CONTEXT_STALE')
  expect(f.read()).toEqual(before)
  const current = Story.context(f.db, request)
  expect(() => f.commit([{ type: 'put-node', node: { ...f.b, event: '试图用甲路线来源改写乙路线事件' } }], {
    expectedContext: { request, contextHash: current.contextHash },
  })).toThrow('STORY_CONTEXT_SCOPE_MISMATCH')
  expect(f.read()).toEqual(before)
  const shared = { nodeId: f.merge.id, routeId: null, mode: 'shared' as const }
  expect(() => f.commit([{ type: 'put-node', node: { ...f.merge, body: '未确认共同事实' } }], {
    confirmedSharedEdit: true, expectedContext: { request: shared, contextHash: Story.context(f.db, shared).contextHash },
  })).toThrow('STORY_CONTEXT_UNCONFIRMED')
})
it('rejects cycles, disconnected routes and referenced node deletions atomically', () => {
  const f = fixture(), before = f.read()
  expect(() => f.commit([{ type: 'put-edge', edge: { id: randomUUID(), from: f.merge.id, to: f.start.id, label: '', condition: '' } }])).toThrow('STORY_CYCLE')
  expect(() => f.commit([{ type: 'put-route', route: { ...f.rA, nodeIds: [f.start.id, f.merge.id] } }])).toThrow('STORY_ROUTE_DISCONNECTED')
  expect(() => f.commit([{ type: 'put-route', route: { ...f.rA, nodeIds: [f.start.id, f.a.id, f.start.id] } }])).toThrow('STORY_ROUTE_INVALID')
  expect(() => f.commit([{ type: 'delete-node', id: f.a.id }])).toThrow('STORY_REFERENCE_INVALID')
  expect(f.read()).toEqual(before)
  f.commit([{ type: 'delete-route', id: f.rA.id },
    ...f.edges.filter(edge => edge.from === f.a.id || edge.to === f.a.id).map(edge => ({ type: 'delete-edge' as const, id: edge.id })),
    { type: 'delete-node', id: f.a.id }])
  expect(f.read().nodes.some(item => item.id === f.a.id)).toBe(false)
  expect(f.read().revisions.some(item => item.nodeId === f.a.id)).toBe(true)
})
it('rolls back every table and new immutable version when SQLite rejects any write', () => {
  const db = database(), a = node('开始'), b = node('之后'), before = Story.read(db)
  db.exec("CREATE TRIGGER reject_story_edge BEFORE INSERT ON story_edges BEGIN SELECT RAISE(ABORT,'test-write-failed'); END;")
  expect(() => Story.commit(db, before.revision, [{ type: 'put-node', node: a }, { type: 'put-node', node: b },
    { type: 'put-edge', edge: { id: randomUUID(), from: a.id, to: b.id, label: '', condition: '' } }])).toThrow('test-write-failed')
  expect(Story.read(db)).toEqual(before)
})
it('strictly validates incoming record shapes, graph references and immutable revision chains', () => {
  const f = fixture(), valid = data(f.read())
  expect(() => validateStoryData(valid)).not.toThrow()
  expect(() => validateStoryRecord('story_nodes', { ...valid.nodes[0], injected: true })).toThrow('STORY_INPUT_INVALID')
  expect(() => validateStoryRecord('story_nodes', { ...valid.nodes[0], id: '../../outside' })).toThrow('STORY_ID_INVALID')
  expect(() => validateStoryRecord('story_edges', JSON.parse('{"id":"x","__proto__":{}}'))).toThrow('STORY_INPUT_INVALID')
  const broken = structuredClone(valid)
  broken.nodes[0]!.revisionId = randomUUID()
  expect(() => validateStoryData(broken)).toThrow('STORY_REVISION_INVALID')
  const cycle = structuredClone(valid), first = cycle.revisions[0]!
  first.parentRevisionId = first.id
  expect(() => validateStoryData(cycle)).toThrow('STORY_REVISION_INVALID')
  expect(() => validateStoryData({ ...valid, nodes: [valid.nodes[0], valid.nodes[0]] })).toThrow('STORY_DUPLICATE_ID')
})
it('keeps source continuity stable across a target edit while invalidating the generation commit hash', () => {
  const f = fixture(), request = { nodeId: f.merge.id, routeId: f.rA.id, mode: 'route' as const }
  const before = Story.context(f.db, request)
  f.commit([{ type: 'put-node', node: { ...f.merge, body: '当前目标改写' } }], { confirmedSharedEdit: true })
  const after = Story.context(f.db, request)
  expect(after.sourceHash).toBe(before.sourceHash)
  expect(after.contextHash).not.toBe(before.contextHash)
  f.commit([{ type: 'put-node', node: { ...f.end, body: '目标之后的另一节点' } }], { confirmedSharedEdit: true })
  expect(Story.context(f.db, request).contextHash).toBe(after.contextHash)
})
it('requires common author facts for a shared content node even after the routes have already merged', () => {
  const f = fixture(), request = { nodeId: f.end.id, routeId: f.rA.id, mode: 'route' as const }
  const viewed = Story.context(f.db, request)
  expect(viewed.prefix.map(item => item.id)).toEqual([f.start.id, f.a.id, f.merge.id])
  expect(viewed.readyForGeneration).toBe(false)
  expect(() => f.commit([{ type: 'put-node', node: { ...f.end, body: '试图把甲路线事实写成双方共用事实' } }], {
    confirmedSharedEdit: true, expectedContext: { request, contextHash: viewed.contextHash },
  })).toThrow('STORY_CONTEXT_UNCONFIRMED')
  const shared = { nodeId: f.end.id, routeId: null, mode: 'shared' as const }, common = Story.context(f.db, shared)
  expect(common.prefix.map(item => item.id)).toEqual([f.start.id])
  const note = { id: randomUUID(), nodeId: f.end.id, routeId: null, summary: '作者确认大厅之后的共同事实。', characterStates: '', entryDifferences: '钥匙与伤势仍有入口差异，不当作双方共同事实。' }
  f.commit([{ type: 'put-note', note, expectedSourceHash: common.sourceHash, confirm: true }])
  const confirmed = Story.context(f.db, shared)
  expect(confirmed.readyForGeneration).toBe(true)
  f.commit([{ type: 'put-node', node: { ...f.end, body: '根据作者确认的共同前情写后续' } }], {
    confirmedSharedEdit: true, expectedContext: { request: shared, contextHash: confirmed.contextHash },
  })
  expect(f.read().nodes.find(item => item.id === f.end.id)?.body).toBe('根据作者确认的共同前情写后续')
  f.commit([{ type: 'delete-route', id: f.rA.id }])
  expect(f.read().notes.find(item => item.id === note.id)?.summary).toBe(note.summary)
  expect(() => Story.context(f.db, shared)).toThrow('STORY_SHARED_CONTEXT_INVALID')
  expect(Story.context(f.db, { ...request, routeId: f.rB.id }).note).toBeNull()
})
