import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useProjectStore } from '../../../../stores/project-store'
import { createAgentExecutionContext } from '../project-context'
import { readStoryContextTool, readStoryGraphTool, proposeStoryChangesTool } from '../story-tools'
import { buildAgentGenerationContext, validateAgentStoryRequest } from '../../../../../electron/services/agent-generation-context'
import { prepareStoryProposal } from '../../../../shared/story-proposal'
import { storyWritingContinuityInstruction } from '../../../../shared/story-writing-context'
import type { StoryContext, StorySnapshot } from '../../../../shared/story-branches'

const invoke = vi.fn()
vi.mock('../../../ipc-client', () => ({ ipc: { invokeWithProjectSession: (...args: unknown[]) => invoke(...args) } }))
const nodeId = '11111111-1111-4111-8111-111111111111', routeId = '22222222-2222-4222-8222-222222222222'
const request = { nodeId, routeId, mode: 'route' as const }
const blueprint = { title: '目标章节蓝图', role: '推进角色选择', purpose: '寻找援军', keyEvents: '点亮塔灯', characters: ['林岚'], suspenseHook: '地底回应', userGuidance: '保持暴雨声', notes: '暂不揭晓身份' }
const target = { id: nodeId, kind: 'content' as const, title: '灯塔分支', chapterNumber: 8, event: '', body: '本章旧稿', revisionId: nodeId, chapterBlueprint: blueprint,
  chapterSource: { chapterNumber: 8, blueprintHash: 'a'.repeat(64), manuscriptHash: 'b'.repeat(64) } }
const prefix = { ...target, id: routeId, title: '上一节点', body: '父级已经抵达海岸', chapterBlueprint: { ...blueprint, keyEvents: '父级蓝图尚未发生的计划' } }
const scoped: StoryContext = { request, sourceHash: 'c'.repeat(64), contextHash: 'd'.repeat(64), target, prefix: [prefix], entrances: [], note: null, noteCurrent: false, readyForGeneration: true }
const snapshot: StorySnapshot = { revision: 'e'.repeat(64), nodes: [target, prefix], edges: [], notes: [], revisions: [], routes: [{ id: routeId, title: '灯塔路线', nodeIds: [routeId, nodeId] }] }
beforeEach(() => { invoke.mockReset(); useProjectStore.setState({ currentProject: { id: 'P', path: 'C:/synthetic/story', sessionLease: 'lease', name: '合成', novelConfig: { writingLanguage: 'zh-CN' } } as never }) })
afterEach(() => useProjectStore.setState({ currentProject: null }))

it('freezes the target plan and source for model writing while excluding ancestor plans and mainline future outlines', () => {
  const tools = [readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool].map(({ name, description, inputSchema, requiresConfirmation, isReadOnly, source }) => ({ name, description, inputSchema: { ...inputSchema }, requiresConfirmation, isReadOnly, source }))
  const input = { mode: 'fast' as const, uiLocale: 'zh-CN' as const, historyMessages: [], userMessage: '按当前蓝图生成章节', storyContext: request, tools }
  const prompt = JSON.stringify({ key: 'assistant_writing_identity', content: '写作助手', systemRole: '小说写作' })
  const context = buildAgentGenerationContext(input, { project_name: '合成', core_outline: '主线未来结局不能进入分支', synopsis: '主线未来章纲不能进入分支', world_setting: '风暴海岸' }, 'zh-CN', prompt, prompt, { context: scoped, staticCharacters: [] })
  const system = context.initialMessages[0].content
  for (const included of ['目标章节蓝图', '寻找援军', '点亮塔灯', '保持暴雨声', '父级已经抵达海岸', '风暴海岸', 'chapterSource']) expect(system).toContain(included)
  for (const excluded of ['父级蓝图尚未发生的计划', '主线未来结局不能进入分支', '主线未来章纲不能进入分支']) expect(system).not.toContain(excluded)
  expect(system).toContain('不得创建或覆盖全局主线章节草稿')
  expect(system).toContain('正文 body 修改')
})

it('returns the current target blueprint without promoting ancestor plans to established continuity', async () => {
  invoke.mockResolvedValue({ success: true, data: scoped })
  const result = await readStoryContextTool.execute({ node_id: nodeId, route_id: routeId, mode: 'route' }, { ...createAgentExecutionContext(), storyContext: request })
  expect(result.success).toBe(true)
  const material = JSON.parse(result.content)
  expect(material.target.chapterBlueprint).toEqual(blueprint)
  expect(material.target.chapterSource).toEqual(target.chapterSource)
  expect(material.prefix[0].body).toBe('父级已经抵达海岸')
  expect(material.prefix[0].chapterBlueprint).toBeUndefined()
  expect(material.prefix[0].chapterSource).toEqual(prefix.chapterSource)
  expect(material.prefix[0]).toMatchObject({ eventStatus: 'chapter-plan', manuscriptStatus: 'available' })
  expect(result.content).not.toContain('父级蓝图尚未发生的计划')
})

it('keeps graph reads structural even when other nodes own chapter plans and imported prose', async () => {
  invoke.mockResolvedValue({ success: true, data: snapshot })
  const result = await readStoryGraphTool.execute({}, createAgentExecutionContext())
  expect(result.success).toBe(true)
  expect(result.content).toContain('灯塔路线')
  for (const excluded of ['目标章节蓝图', '父级蓝图尚未发生的计划', '父级已经抵达海岸', 'chapterSource', 'blueprintHash']) expect(result.content).not.toContain(excluded)
})

it('validates and strictly preserves the author-selected optional bridge in read and write tool scopes', async () => {
  const laterId = '33333333-3333-4333-8333-333333333333', bridgedRequest = { ...request, bridgeToNodeId: laterId }
  expect(validateAgentStoryRequest(bridgedRequest)).toEqual(bridgedRequest)
  expect(() => validateAgentStoryRequest({ ...request, bridgeToNodeId: 'invalid' })).toThrow('GENERATION_AGENT_STORY_CONTEXT_INVALID')
  expect(() => validateAgentStoryRequest({ ...request, bridgeToNodeId: nodeId })).toThrow('GENERATION_AGENT_STORY_CONTEXT_INVALID')
  const execution = { ...createAgentExecutionContext(), storyContext: bridgedRequest }
  await expect(readStoryContextTool.execute({ node_id: nodeId, route_id: routeId, mode: 'route' }, execution)).rejects.toThrow('STORY_CONTEXT_SCOPE_MISMATCH')
  await expect(readStoryContextTool.execute({ node_id: nodeId, route_id: routeId, mode: 'route', bridge_to_node_id: routeId }, execution)).rejects.toThrow('STORY_CONTEXT_SCOPE_MISMATCH')
  expect(invoke).not.toHaveBeenCalled()
  const bridged = { ...scoped, request: bridgedRequest, continuation: { node: { ...target, id: laterId, body: '作者指定后文的开场' }, edge: { id: routeId, from: nodeId, to: laterId, label: '接回', condition: '' } } }
  invoke.mockResolvedValue({ success: true, data: bridged })
  expect((await readStoryContextTool.execute({ node_id: nodeId, route_id: routeId, mode: 'route', bridge_to_node_id: laterId }, execution)).success).toBe(true)
  expect(invoke.mock.calls[0][2]).toEqual(bridgedRequest)
  expect(() => prepareStoryProposal({ context: request, operations: [{ type: 'put-node', node: target }] }, snapshot, bridgedRequest, bridged)).toThrow('STORY_CONTEXT_SCOPE_MISMATCH')
})

it('only admits the matching direct later chapter into the model context as future constraints', () => {
  const laterId = '33333333-3333-4333-8333-333333333333', bridgedRequest = { ...request, bridgeToNodeId: laterId }
  const input = { mode: 'fast' as const, uiLocale: 'zh-CN' as const, historyMessages: [], userMessage: '审查当前分支的衔接，只给建议', storyContext: bridgedRequest, tools: [] }
  const prompt = JSON.stringify({ key: 'assistant_writing_identity', content: '写作助手', systemRole: '小说写作' })
  expect(() => buildAgentGenerationContext(input, {}, 'zh-CN', prompt, prompt, { context: scoped, staticCharacters: [] })).toThrow('GENERATION_AGENT_STORY_CONTEXT_NOT_READY')
  const bridged = { ...scoped, request: bridgedRequest, continuation: { node: { ...target, id: laterId, body: '指定后文的状态约束' }, edge: { id: routeId, from: nodeId, to: laterId, label: '接回', condition: '' } } }
  const result = buildAgentGenerationContext(input, {}, 'zh-CN', prompt, prompt, { context: bridged, staticCharacters: [] })
  expect(result.initialMessages[0].content).toContain('指定后文的状态约束')
  expect(result.initialMessages[0].content).toContain('尚未发生的衔接约束')
  expect(result.initialMessages[0].content).toContain('不得调用 propose_story_changes 或写入任何正文')
  expect(() => buildAgentGenerationContext({ ...input, storyContext: request }, {}, 'zh-CN', prompt, prompt, { context: bridged, staticCharacters: [] })).toThrow('GENERATION_AGENT_STORY_CONTEXT_NOT_READY')
})

it.each([
  ['', 'unwritten', '尚未落实，只是未实现的前置计划'],
  ['实际正文：未能拿到王冠，仍空手离开', 'available', '正文与计划冲突时，以实际正文为准'],
])('labels source blueprint events consistently in the main prompt and tool when prior prose is %s', async (body, status, explanation) => {
  const context: StoryContext = { ...scoped, prefix: [{ ...prefix, event: '源蓝图计划：拿到王冠', body }] }
  const original = structuredClone(context)
  const input = { mode: 'fast' as const, uiLocale: 'zh-CN' as const, historyMessages: [], userMessage: '按当前蓝图写作', storyContext: request, tools: [] }
  const prompt = JSON.stringify({ key: 'assistant_writing_identity', content: '写作助手', systemRole: '小说写作' })
  const initial = buildAgentGenerationContext(input, {}, 'zh-CN', prompt, prompt, { context, staticCharacters: [] }).initialMessages[0].content
  expect(initial).toContain('"eventStatus":"chapter-plan"')
  expect(initial).toContain(`"manuscriptStatus":"${status}"`)
  expect(initial).toContain(explanation)
  expect(initial).toContain('不得据此推断人物的当前状态、持有物品')
  invoke.mockResolvedValue({ success: true, data: context })
  const result = await readStoryContextTool.execute({ node_id: nodeId, route_id: routeId, mode: 'route' }, { ...createAgentExecutionContext(), storyContext: request })
  const material = JSON.parse(result.content)
  expect(material.prefix[0]).toMatchObject({ event: '源蓝图计划：拿到王冠', body, eventStatus: 'chapter-plan', manuscriptStatus: status, chapterSource: prefix.chapterSource })
  expect(material.sourcePlanInstruction).toBe(storyWritingContinuityInstruction('zh-CN'))
  expect(context).toEqual(original)
})
