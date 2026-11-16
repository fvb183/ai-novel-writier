import { describe, expect, it } from 'vitest'
import type { StoryContext, StoryNode } from '../story-branches'
import { projectStoryWritingContext, storyWritingContinuityInstruction } from '../story-writing-context'

const source = { chapterNumber: 1, blueprintHash: 'a'.repeat(64), manuscriptHash: 'b'.repeat(64) }
const node: StoryNode = { id: 'prior', kind: 'content', title: '前置章节', chapterNumber: 1, event: '拿到王冠并离开王城', body: '', revisionId: 'version', chapterSource: source,
  chapterBlueprint: { title: '前章计划', role: '', purpose: '', keyEvents: '不应额外注入的蓝图全文', characters: [], suspenseHook: '', userGuidance: '', notes: '' } }
const context: StoryContext = { request: { nodeId: 'target', routeId: 'route', mode: 'route' }, sourceHash: 'c'.repeat(64), contextHash: 'd'.repeat(64), target: { ...node, id: 'target' }, prefix: [node], entrances: [], note: null, noteCurrent: false, readyForGeneration: true }

describe('model-visible source chapter continuity', () => {
  it('labels a live unwritten mainline chapter without exposing its unimplemented blueprint as earlier facts', () => {
    const { chapterSource: _source, ...base } = node
    const mainline = { ...base, id: 'chapter:1', event: '', mainline: { chapterNumber: 1, manuscriptStatus: 'unwritten' as const, hasBlueprint: true } }
    const projected = projectStoryWritingContext({ ...context, prefix: [mainline] })
    expect(projected.prefix[0]).toMatchObject({ id: 'chapter:1', event: '', body: '', manuscriptStatus: 'unwritten', mainline: mainline.mainline })
    expect(projected.prefix[0]).not.toHaveProperty('chapterBlueprint')
    expect(projected.prefix[0]).not.toHaveProperty('chapterSource')
    expect(projected.prefix[0].mainline).not.toBe(mainline.mainline)
  })
  it('keeps unwritten source events explicitly unrealized while preserving source identity and canonical data', () => {
    const before = structuredClone(context), projected = projectStoryWritingContext(context)
    expect(projected.prefix[0]).toMatchObject({ event: node.event, body: '', eventStatus: 'chapter-plan', manuscriptStatus: 'unwritten', chapterSource: source })
    expect(projected.prefix[0]).not.toHaveProperty('chapterBlueprint')
    expect(projected.prefix[0].chapterSource).not.toBe(source)
    expect(projected.sourceHash).toBe(context.sourceHash)
    expect(projected.contextHash).toBe(context.contextHash)
    expect(context).toEqual(before)
    expect(storyWritingContinuityInstruction('zh-CN')).toContain('不能当作既成前情')
    expect(storyWritingContinuityInstruction('en-US')).toContain('not earlier facts')
  })

  it('prioritizes existing prose over a conflicting source plan instead of promoting planned character or item states', () => {
    const projected = projectStoryWritingContext({ ...context, prefix: [{ ...node, body: '实际正文：王冠被抢走，主角仍被困在王城' }] })
    expect(projected.prefix[0]).toMatchObject({ eventStatus: 'chapter-plan', manuscriptStatus: 'available', body: '实际正文：王冠被抢走，主角仍被困在王城' })
    expect(storyWritingContinuityInstruction('zh-CN')).toContain('正文与计划冲突时，以实际正文为准')
    expect(storyWritingContinuityInstruction('en-US')).toContain('body taking priority')
  })

  it('does not reinterpret ordinary manually authored events or whitespace as an existing source manuscript', () => {
    const { chapterSource: _source, ...manual } = node
    const projected = projectStoryWritingContext({ ...context, prefix: [manual, { ...node, id: 'blank-source', body: ' \n\t' }] })
    expect(projected.prefix[0]).toMatchObject({ event: manual.event, body: manual.body })
    expect(projected.prefix[0]).not.toHaveProperty('eventStatus')
    expect(projected.prefix[0]).not.toHaveProperty('manuscriptStatus')
    expect(projected.prefix[0]).not.toHaveProperty('chapterSource')
    expect(projected.prefix[1].manuscriptStatus).toBe('unwritten')
  })
})
