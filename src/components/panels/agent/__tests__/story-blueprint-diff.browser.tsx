import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import StoryProposalDiff from '../StoryProposalDiff'
import { prepareStoryProposal } from '../../../../shared/story-proposal'
import type { StoryContext, StoryNodeInput, StorySnapshot } from '../../../../shared/story-branches'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const nodeId = '11111111-1111-4111-8111-111111111111', routeId = '22222222-2222-4222-8222-222222222222'
const blueprint = { title: '原灯塔蓝图', role: '推进', purpose: '寻找援军', keyEvents: '旧计划：点亮塔灯', characters: ['林岚'], suspenseHook: '地下传来回应', userGuidance: '保留暴雨声', notes: '暂不揭晓来者' }
const node: StoryNodeInput = { id: nodeId, kind: 'content', title: '灯塔支线', chapterNumber: 8, event: '寻求援军', body: '当前分支正文', chapterBlueprint: blueprint,
  chapterSource: { chapterNumber: 8, blueprintHash: 'a'.repeat(64), manuscriptHash: 'b'.repeat(64) } }
const request = { nodeId, routeId, mode: 'route' as const }, current = { ...node, revisionId: nodeId }
const snapshot: StorySnapshot = { revision: 'c'.repeat(64), nodes: [current], edges: [], notes: [], revisions: [], routes: [{ id: routeId, title: '灯塔路线', nodeIds: [nodeId] }] }
const context: StoryContext = { request, sourceHash: 'd'.repeat(64), contextHash: 'e'.repeat(64), target: current, prefix: [], entrances: [], note: null, noteCurrent: false, readyForGeneration: true }
let root: Root, container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

it('shows the actual before and candidate chapter plan plus its retained mainline source before approval', async () => {
  const { chapterSource: _source, ...candidate } = node
  const proposal = prepareStoryProposal({ operations: [{ type: 'put-node', node: { ...candidate, chapterBlueprint: { ...blueprint, title: '候选灯塔蓝图', keyEvents: '新计划：先修复灯塔再求援' } } }] }, snapshot, request, context)
  await act(async () => root.render(<StoryProposalDiff preview={{ kind: 'valid', snapshot, proposal }} />))
  await expect.element(page.getByRole('region', { name: '章节蓝图及来源对比' })).toBeVisible()
  const section = container.querySelector('[aria-label="章节蓝图及来源对比"]')!
  for (const actual of ['当前蓝图与来源', '候选蓝图与来源', '原灯塔蓝图', '候选灯塔蓝图', '旧计划：点亮塔灯', '新计划：先修复灯塔再求援', '来源：主线第 8 章的独立副本', '林岚', '保留暴雨声']) expect(section.textContent).toContain(actual)
  expect(container.textContent).toContain('当前分支正文')
  expect(proposal.operations[0]).toMatchObject({ node: { chapterSource: node.chapterSource } })
})

it('explains why chapter generation cannot rewrite its blueprint or forge a source binding', async () => {
  await act(async () => root.render(<StoryProposalDiff preview={{ kind: 'invalid', error: 'STORY_BLUEPRINT_SEPARATE_PROPOSAL' }} />))
  await expect.element(page.getByRole('alert')).toHaveTextContent('按蓝图生成正文时不能同时改写蓝图')
  await act(async () => root.render(<StoryProposalDiff preview={{ kind: 'invalid', error: 'STORY_CHAPTER_SOURCE_READ_ONLY' }} />))
  await expect.element(page.getByRole('alert')).toHaveTextContent('助手不能编造、更换或删除这份来源绑定')
})
