import { describe, expect, it } from 'vitest'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import { blueprintTreeView } from '../blueprint-tree-view'
import type { StorySnapshot } from '../../../shared/story-branches'

const bp = (chapterNumber: number): ChapterBlueprint => ({ chapterNumber, title: `蓝图 ${chapterNumber}`, role: '发展', purpose: '', keyEvents: '计划事件', characters: ['甲'], suspenseHook: '', userGuidance: '', notes: '', notesUpdatedAt: '' })
const fixture = (): StorySnapshot => ({ revision: 'canonical', nodes: [1, 2].map(chapterNumber => ({ id: `chapter:${chapterNumber}`, kind: 'content', title: `正文 ${chapterNumber}`, chapterNumber, body: `定稿 ${chapterNumber}`, event: '', revisionId: `revision:${chapterNumber}`, mainline: { chapterNumber, manuscriptStatus: 'finalized', hasBlueprint: false } })), edges: [{ id: 'mainline:chapter:1>chapter:2', from: 'chapter:1', to: 'chapter:2', label: '', condition: '' }], routes: [{ id: 'mainline', title: '主线', nodeIds: ['chapter:1', 'chapter:2'] }], notes: [], revisions: [] })

describe('canonical blueprint tree preview', () => {
  it('keeps manuscript-only imported chapters without inventing a blueprint', () => {
    const original = fixture(), before = structuredClone(original)
    const view = blueprintTreeView(original, [bp(3), bp(4), bp(5)])
    expect(view.nodes.map(node => node.id)).toEqual(['chapter:1', 'chapter:2', 'chapter:3', 'chapter:4', 'chapter:5'])
    expect(view.nodes[0].chapterBlueprint).toBeUndefined()
    expect(view.nodes[1].chapterBlueprint).toBeUndefined()
    expect(view.nodes[0].body).toBe('定稿 1')
    expect(view.routes[0].nodeIds).toEqual(view.nodes.map(node => node.id))
    expect(original).toEqual(before)
  })

  it('overlays only canonical blueprint drafts while preserving independent chapter identity and manuscript', () => {
    const original = fixture()
    const branch = { id: 'independent-uuid', kind: 'content' as const, title: '独立第三章', chapterNumber: 3, event: '分支事件', body: '分支正文', revisionId: 'branch-revision', chapterBlueprint: bp(3) }
    original.nodes.push(branch)
    original.edges.push({ id: 'branch-edge', from: 'chapter:2', to: branch.id, label: '分支', condition: '' })
    original.routes.push({ id: 'branch-route', title: '分支线', nodeIds: ['chapter:1', 'chapter:2', branch.id] })
    const view = blueprintTreeView(original, [{ ...bp(3), title: '主线新标题' }])
    expect(view.nodes.find(node => node.id === 'chapter:3')?.title).toBe('主线新标题')
    expect(view.nodes.find(node => node.id === branch.id)).toEqual(branch)
    expect(view.routes.find(route => route.id === 'branch-route')).toEqual(original.routes[1])
    expect(view.edges.find(edge => edge.id === 'branch-edge')).toEqual(original.edges[1])
    expect(view.revision).toBe(original.revision)
  })

  it('does not revive a deleted unwritten blueprint from an older story snapshot', () => {
    const original = fixture()
    original.nodes.push({ id: 'chapter:3', kind: 'content', title: '已删除空章', chapterNumber: 3, body: ' \n ', event: '旧计划', revisionId: 'old', chapterBlueprint: bp(3),
      mainline: { chapterNumber: 3, manuscriptStatus: 'draft', hasBlueprint: true, hasManuscript: false } })
    const view = blueprintTreeView(original, [])
    expect(view.nodes.map(node => node.id)).toEqual(['chapter:1', 'chapter:2'])
    expect(view.routes[0].nodeIds).toEqual(['chapter:1', 'chapter:2'])
    expect(view.edges).toHaveLength(1)
  })

  it('retains written and historically written chapters when their blueprints are removed', () => {
    const original = fixture(); original.nodes[1].body = ''
    original.nodes[1].mainline = { chapterNumber: 2, manuscriptStatus: 'draft', hasBlueprint: true, hasManuscript: true }
    original.nodes[1].chapterBlueprint = bp(2)
    const view = blueprintTreeView(original, [])
    expect(view.nodes).toHaveLength(2)
    expect(view.nodes[1].chapterBlueprint).toBeUndefined()
    expect(view.nodes[1].mainline?.hasManuscript).toBe(true)
    expect(blueprintTreeView(original, [bp(2)]).nodes[1].mainline?.hasManuscript).toBe(true)
  })

  it('keeps an explicitly referenced empty chapter as a missing source instead of inventing a blueprint', () => {
    const original = fixture()
    original.nodes.push({ id: 'chapter:3', kind: 'content', title: '旧蓝图空章', chapterNumber: 3, body: '', event: '旧计划', revisionId: 'old', chapterBlueprint: bp(3),
      mainline: { chapterNumber: 3, manuscriptStatus: 'unwritten', hasBlueprint: true, hasManuscript: false } })
    original.routes.push({ id: 'manual-route', title: '引用待补来源', nodeIds: ['chapter:1', 'chapter:3'] })
    const node = blueprintTreeView(original, []).nodes.find(node => node.id === 'chapter:3')!
    expect(node.chapterBlueprint).toBeUndefined()
    expect(node.event).toBe('')
    expect(node.mainline).toMatchObject({ manuscriptStatus: 'missing', hasBlueprint: false, hasManuscript: false })
  })
})
