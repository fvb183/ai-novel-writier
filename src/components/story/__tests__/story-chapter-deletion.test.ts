import { describe, expect, it } from 'vitest'
import type { StoryNode, StorySnapshot } from '../../../shared/story-branches'
import { planDeleteStoryBlueprint, planDeleteStoryChapter } from '../story-chapter-deletion'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const blueprint = { title: '林间支线', role: '发展', purpose: '找到钥匙', keyEvents: '取得钥匙', characters: ['甲'], suspenseHook: '', userGuidance: '', notes: '' }
function fixture(): StorySnapshot {
  const nodes: StoryNode[] = [1, 2, 3].map(n => ({ id: `chapter:${n}`, revisionId: `revision:${n}`, title: `主线${n}`, kind: 'content', chapterNumber: n,
    body: `主线正文${n}`, event: '', mainline: { chapterNumber: n, manuscriptStatus: 'finalized', hasBlueprint: false, hasManuscript: true } }))
  nodes.push({ id: id(1), revisionId: id(10), title: '林间支线', kind: 'content', chapterNumber: 2, body: '', event: '取得钥匙', chapterBlueprint: blueprint },
    { id: id(2), revisionId: id(11), title: '独立后章', kind: 'content', chapterNumber: 3, body: '幸存正文', event: '' })
  return { revision: 'a'.repeat(64), nodes, revisions: [], edges: [
    { id: 'mainline:chapter:1>chapter:2', from: 'chapter:1', to: 'chapter:2', label: '', condition: '' },
    { id: 'mainline:chapter:2>chapter:3', from: 'chapter:2', to: 'chapter:3', label: '', condition: '' },
    { id: id(20), from: 'chapter:1', to: id(1), label: '入林', condition: '有地图' },
    { id: id(21), from: id(1), to: id(2), label: '出林', condition: '持有钥匙' },
  ], routes: [{ id: 'mainline', title: '主线', nodeIds: ['chapter:1', 'chapter:2', 'chapter:3'] },
    { id: id(30), title: '森林线', nodeIds: ['chapter:1', id(1), id(2)] }], notes: [
      { id: id(40), routeId: id(30), nodeId: id(1), summary: '已取得钥匙', characterStates: '', entryDifferences: '', sourceHash: 'b'.repeat(64), confirmed: true },
      { id: id(41), routeId: id(30), nodeId: id(2), summary: '后章前情', characterStates: '', entryDifferences: '', sourceHash: 'c'.repeat(64), confirmed: true },
    ] }
}

describe('chapter deletion preserves manuscripts and surviving routes', () => {
  it('removes an unwritten branch with its blueprint and reconnects surviving chapters', () => {
    const before = fixture(), original = structuredClone(before)
    const result = planDeleteStoryBlueprint(before, id(1))
    expect(result.error).toBeUndefined()
    expect(result.operations).toContainEqual({ type: 'delete-node', id: id(1) })
    expect(result.operations).toContainEqual({ type: 'put-route', route: { ...before.routes[1], nodeIds: ['chapter:1', id(2)] } })
    expect(result.operations).toContainEqual({ type: 'delete-note', id: id(40) })
    expect(result.operations).not.toContainEqual({ type: 'delete-note', id: id(41) })
    const bridge = result.operations.find(operation => operation.type === 'put-edge')
    expect(bridge).toMatchObject({ edge: { from: 'chapter:1', to: id(2), condition: '(有地图) 且 (持有钥匙)' } })
    expect(result.operations.filter(operation => operation.type === 'delete-node')).toHaveLength(1)
    expect(before).toEqual(original)
  })
  it('deletes only the blueprint from a written branch, omitting the optional property entirely', () => {
    const before = fixture(), target = before.nodes[3]
    target.body = '已经生成的支线正文'
    const result = planDeleteStoryBlueprint(before, target.id)
    expect(result.operations).toHaveLength(1)
    const update = result.operations[0]
    expect(update.type).toBe('put-node')
    if (update.type !== 'put-node') throw new Error('expected author input')
    expect(update.node.id).toBe(target.id)
    expect(update.node.body).toBe(target.body)
    expect(update.node.event).toBe('')
    expect(Object.hasOwn(update.node, 'chapterBlueprint')).toBe(false)
    expect(Object.hasOwn(update.node, 'revisionId')).toBe(false)
  })
  it('preserves an empty current draft when an earlier saved manuscript exists', () => {
    const before = fixture(), target = before.nodes[3]
    const { revisionId: _revision, ...input } = target
    before.revisions.push({ id: id(50), nodeId: target.id, parentRevisionId: null, node: { ...input, body: '可恢复的已存正文' } })
    const result = planDeleteStoryBlueprint(before, target.id)
    expect(result.operations.map(operation => operation.type)).toEqual(['put-node'])
    expect(before.revisions[0].node.body).toBe('可恢复的已存正文')
  })
  it('retains manually authored events while deleting blueprint-only planning', () => {
    const before = fixture(); before.nodes[3].body = '已写'; before.nodes[3].event = '作者另外记录的既有事实'
    expect(planDeleteStoryBlueprint(before, id(1)).operations[0]).toMatchObject({ node: { event: '作者另外记录的既有事实' } })
  })
  it('removes a redundant route when deleting its only branch and keeps the mainline', () => {
    const before = fixture(); before.routes[1].nodeIds = ['chapter:1', id(1), 'chapter:2']
    before.edges[3].to = 'chapter:2'
    const result = planDeleteStoryChapter(before, id(1))
    expect(result.operations).toContainEqual({ type: 'delete-route', id: id(30) })
    expect(result.operations).not.toContainEqual({ type: 'delete-route', id: 'mainline' })
    expect(result.operations.filter(operation => operation.type === 'put-edge')).toHaveLength(0)
  })
  it('keeps a noncontiguous mainline route instead of dropping an intentional alternate path', () => {
    const before = fixture(); before.routes[1].nodeIds = ['chapter:1', id(1), 'chapter:3']; before.edges[3].to = 'chapter:3'
    const result = planDeleteStoryChapter(before, id(1))
    expect(result.operations).not.toContainEqual({ type: 'delete-route', id: id(30) })
    expect(result.operations).toContainEqual({ type: 'put-route', route: { ...before.routes[1], nodeIds: ['chapter:1', 'chapter:3'] } })
    expect(result.operations).toContainEqual(expect.objectContaining({ type: 'put-edge', edge: expect.objectContaining({ from: 'chapter:1', to: 'chapter:3' }) }))
  })
  it('rejects ambiguous broken paths atomically and does not silently truncate conditions', () => {
    const before = fixture(); before.edges = before.edges.filter(edge => edge.id !== id(21))
    expect(planDeleteStoryChapter(before, id(1))).toEqual({ operations: [], error: 'STORY_ROUTE_DISCONNECTED' })
    const large = fixture(); large.edges[2].condition = '甲'.repeat(2500); large.edges[3].condition = '乙'.repeat(2500)
    expect(planDeleteStoryChapter(large, id(1))).toEqual({ operations: [], error: 'STORY_SIZE_LIMIT' })
  })
  it('retains an existing explicit mainline skip when deleting its terminal branch', () => {
    const before = fixture(); before.routes[1].nodeIds = ['chapter:1', 'chapter:3', id(1)]
    before.edges[2].from = 'chapter:3'
    const result = planDeleteStoryChapter(before, id(1))
    expect(result.error).toBeUndefined()
    expect(result.operations).toContainEqual({ type: 'put-route', route: { ...before.routes[1], nodeIds: ['chapter:1', 'chapter:3'] } })
    expect(result.operations.filter(operation => operation.type === 'put-edge')).toHaveLength(0)
  })
  it('keeps canonical chapter deletion inside the existing blueprint workflow', () => {
    expect(planDeleteStoryChapter(fixture(), 'chapter:1')).toEqual({ operations: [], error: 'STORY_MAINLINE_READ_ONLY' })
    expect(planDeleteStoryBlueprint(fixture(), id(99))).toEqual({ operations: [], error: 'STORY_NODE_NOT_FOUND' })
  })
})
