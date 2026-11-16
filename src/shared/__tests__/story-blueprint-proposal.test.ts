import { describe, expect, it } from 'vitest'
import type { StoryContext, StoryContextRequest, StoryNodeInput, StorySnapshot } from '../story-branches'
import { prepareStoryProposal } from '../story-proposal'

const nodeId = '11111111-1111-4111-8111-111111111111', routeId = '22222222-2222-4222-8222-222222222222'
const blueprint = { title: '灯塔求援', role: '推进', purpose: '找到援兵', keyEvents: '点亮信号灯；守塔人回应', characters: ['林岚'], suspenseHook: '回应来自地下', userGuidance: '保留暴雨声', notes: '本章结尾不揭晓来者' }
const source = { chapterNumber: 8, blueprintHash: 'a'.repeat(64), manuscriptHash: 'b'.repeat(64) }
const node: StoryNodeInput = { id: nodeId, kind: 'content', title: '分支灯塔', chapterNumber: 8, event: '前往灯塔求援', body: '当前节点旧稿', chapterBlueprint: blueprint, chapterSource: source }
const request: StoryContextRequest = { nodeId, routeId, mode: 'route' }
const current = { ...node, revisionId: '33333333-3333-4333-8333-333333333333' }
const snapshot: StorySnapshot = { revision: 'd'.repeat(64), nodes: [current], edges: [], routes: [{ id: routeId, title: '灯塔路线', nodeIds: [nodeId] }], notes: [], revisions: [] }
const context: StoryContext = { request, sourceHash: 'e'.repeat(64), contextHash: 'f'.repeat(64), target: current, prefix: [], entrances: [], note: null, noteCurrent: false, readyForGeneration: true }
const propose = (candidate: StoryNodeInput) => prepareStoryProposal({ operations: [{ type: 'put-node', node: candidate }] }, snapshot, request, context)

describe('branch chapter blueprint proposal boundaries', () => {
  it.each([
    { type: 'put-node', node: { ...node, id: 'chapter:1', body: '不得写入的主线正文' } },
    { type: 'delete-node', id: 'chapter:1' },
    { type: 'restore-node', id: 'chapter:1', revisionId: nodeId },
    { type: 'put-edge', edge: { id: 'mainline:chapter:1>chapter:2', from: 'chapter:1', to: 'chapter:2', label: '', condition: '' } },
    { type: 'delete-edge', id: 'mainline:chapter:1>chapter:2' },
    { type: 'put-route', route: { id: 'mainline', title: '伪造主线', nodeIds: ['chapter:1'] } },
    { type: 'delete-route', id: 'mainline' },
  ])('refuses generated writes to read-only canonical chapter structure: $type', operation => {
    expect(() => prepareStoryProposal({ operations: [operation] }, snapshot, request, context)).toThrow('STORY_MAINLINE_READ_ONLY')
  })
  it('inherits omitted author blueprint and source and changes only the selected node manuscript', () => {
    const { chapterBlueprint: _blueprint, chapterSource: _source, ...minimal } = node
    const result = propose({ ...minimal, body: '依据灯塔蓝图生成的候选章节' })
    expect(result.writesProse).toBe(true)
    expect(result.operations).toEqual([{ type: 'put-node', node: { ...node, body: '依据灯塔蓝图生成的候选章节' } }])
    expect(node.chapterBlueprint).toEqual(blueprint)
    expect(node.body).toBe('当前节点旧稿')
  })

  it('does not mistake property order changes for a blueprint rewrite', () => {
    const reordered = Object.fromEntries(Object.entries(blueprint).reverse()) as typeof blueprint
    expect(propose({ ...node, chapterBlueprint: reordered, body: '候选正文' }).writesProse).toBe(true)
  })

  it('requires a separate reviewed proposal to change a chapter blueprint while drafting', () => {
    expect(() => propose({ ...node, body: '候选正文', chapterBlueprint: { ...blueprint, keyEvents: '偷偷改成另一条路线' } })).toThrow('STORY_BLUEPRINT_SEPARATE_PROPOSAL')
    const result = propose({ ...node, chapterBlueprint: { ...blueprint, purpose: '作者另行审阅的计划修改' } })
    expect(result.writesProse).toBe(false)
    expect(result.operations[0]).toMatchObject({ node: { chapterBlueprint: { purpose: '作者另行审阅的计划修改' }, chapterSource: source } })
  })

  it('does not let generated candidates forge or replace a mainline source binding', () => {
    expect(() => propose({ ...node, chapterSource: { ...source, chapterNumber: 99 } })).toThrow('STORY_CHAPTER_SOURCE_READ_ONLY')
    expect(() => propose({ ...node, chapterSource: { ...source, blueprintHash: 'c'.repeat(64) } })).toThrow('STORY_CHAPTER_SOURCE_READ_ONLY')
    const standalone = { ...snapshot, nodes: [{ ...current, chapterSource: undefined }] }
    expect(() => prepareStoryProposal({ operations: [{ type: 'put-node', node }] }, standalone, request, { ...context, target: standalone.nodes[0] })).toThrow('STORY_CHAPTER_SOURCE_READ_ONLY')
  })

  it('does not combine prose generation with node identity or event changes', () => {
    for (const delta of [{ title: '偷偷改标题' }, { event: '偷偷变成已定事实' }, { chapterNumber: 9 }, { kind: 'branch' as const }]) {
      expect(() => propose({ ...node, ...delta, body: '新的候选正文' })).toThrow('STORY_CHAPTER_PROSE_ONLY')
    }
    expect(propose({ ...node, event: '独立供作者审阅的事件变更' }).writesProse).toBe(true)
  })

  it('still requires an author-selected matching route and refuses edits to another target', () => {
    const { chapterBlueprint: _blueprint, chapterSource: _source, ...minimal } = node
    expect(() => prepareStoryProposal({ operations: [{ type: 'put-node', node: { ...minimal, body: '新正文' } }] }, snapshot)).toThrow('STORY_ROUTE_CONTEXT_REQUIRED')
    expect(() => prepareStoryProposal({ context: { ...request, nodeId: routeId }, operations: [{ type: 'put-node', node }] }, snapshot, request, context)).toThrow('STORY_CONTEXT_SCOPE_MISMATCH')
  })
})
