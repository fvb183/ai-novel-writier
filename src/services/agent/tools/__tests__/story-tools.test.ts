import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useProjectStore } from '../../../../stores/project-store'
import { createAgentExecutionContext } from '../project-context'
import { readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool } from '../story-tools'
import { prepareStoryProposal } from '../../../../shared/story-proposal'
import type { StoryContext, StoryContextRequest, StorySnapshot } from '../../../../shared/story-branches'
import { validateAgentGenerationInput, buildAgentGenerationContext } from '../../../../../electron/services/agent-generation-context'
import { builtinTools } from '..'

const invoke = vi.fn()
vi.mock('../../../ipc-client', () => ({ ipc: { invokeWithProjectSession: (...args: unknown[]) => invoke(...args) } }))
const nodeId = '11111111-1111-4111-8111-111111111111'
const routeId = '22222222-2222-4222-8222-222222222222'
const scope: StoryContextRequest = { nodeId, routeId, mode: 'route' }
const node = { id: nodeId, kind: 'content' as const, title: '北塔', chapterNumber: 2, event: '遇见守卫', body: '原正文', revisionId: nodeId }
const snapshot: StorySnapshot = { revision: 'a'.repeat(64), nodes: [node], edges: [], notes: [], revisions: [], routes: [{ id: routeId, title: '北塔路线', nodeIds: [nodeId] }] }
const scoped: StoryContext = { request: scope, sourceHash: 'b'.repeat(64), contextHash: 'c'.repeat(64), target: node, prefix: [], entrances: [], note: null, noteCurrent: false, readyForGeneration: true }
const project = { id: 'project-A', sessionLease: 'lease-A', name: 'A', path: 'C:\\novels\\A', novelConfig: { writingLanguage: 'zh-CN' }, characterStates: '', createdAt: '', updatedAt: '' }
beforeEach(() => { invoke.mockReset(); useProjectStore.setState({ currentProject: project as never }) })
afterEach(() => { useProjectStore.setState({ currentProject: null }) })

it('registers two read tools and a confirmed write tool with immutable main metadata', () => {
  const tools = [readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool]
  expect(tools.map(tool => [tool.requiresConfirmation, tool.isReadOnly])).toEqual([[false, true], [false, true], [true, false]])
  for (const tool of tools) expect(builtinTools).toContain(tool)
  const frozen = tools.map(({ name, description, inputSchema, requiresConfirmation, isReadOnly, source }) => ({ name, description, inputSchema: { ...inputSchema }, requiresConfirmation, isReadOnly, source }))
  const input = { mode: 'planning' as const, uiLocale: 'zh-CN' as const, historyMessages: [], userMessage: '写北塔路线', storyContext: scope, tools: frozen }
  expect(validateAgentGenerationInput(input).storyContext).toEqual(scope)
  expect(() => validateAgentGenerationInput({ ...input, tools: [{ ...frozen[2], requiresConfirmation: false }] })).toThrow('GENERATION_AGENT_INPUT_INVALID')
  expect(() => validateAgentGenerationInput({ ...input, tools: [...frozen, { ...frozen[0], name: 'read_drafts' }] })).toThrow('GENERATION_AGENT_INPUT_INVALID')
})

it('graph reads expose topology without leaking other route prose', async () => {
  invoke.mockResolvedValue({ success: true, data: snapshot })
  const result = await readStoryGraphTool.execute({}, createAgentExecutionContext())
  expect(result.success).toBe(true)
  expect(result.content).toContain('北塔路线')
  expect(result.content).not.toContain('原正文')
  expect(result.content).not.toContain('遇见守卫')
})

it('selected context rejects another route and drops stale continuity candidates from model data', async () => {
  const context = { ...createAgentExecutionContext(), storyContext: scope }
  await expect(readStoryContextTool.execute({ node_id: nodeId, route_id: nodeId, mode: 'route' }, context)).rejects.toThrow('STORY_CONTEXT_SCOPE_MISMATCH')
  expect(invoke).not.toHaveBeenCalled()
  invoke.mockResolvedValue({ success: true, data: { ...scoped, note: { summary: '失效候选不可用' } } })
  const result = await readStoryContextTool.execute({ node_id: nodeId, route_id: routeId, mode: 'route' }, context)
  expect(result.content).not.toContain('失效候选不可用')
  expect(invoke.mock.calls[0][1]).toBe('story:context')
})

it('requires a host-issued action and uses only its durable main receipt for a write', async () => {
  const context = createAgentExecutionContext()
  expect((await proposeStoryChangesTool.execute({ operations: [] }, context)).commitState).toBe('not_committed')
  expect(invoke).not.toHaveBeenCalled()
  const ref = { handle: { projectId: 'project-A', epoch: 'epoch', runId: 'run', rootActionId: 'root' }, attemptId: 'attempt', toolCallId: 'call' }
  invoke.mockResolvedValue({ kind: 'story' })
  const result = await proposeStoryChangesTool.execute({ expectedRevision: 'forged', operations: [] }, { ...context, agentToolAction: ref })
  expect(result.commitState).toBe('committed')
  expect(invoke).toHaveBeenCalledWith(context.projectSession, 'agent-generation:commit-domain-tool', { ref })
})

it('keeps prose in one selected route and never lets generated notes confirm common facts', () => {
  const operation = { type: 'put-node', node: { ...node, revisionId: undefined, body: '候选正文' } }
  delete operation.node.revisionId
  expect(() => prepareStoryProposal({ operations: [operation] }, snapshot)).toThrow('STORY_ROUTE_CONTEXT_REQUIRED')
  expect(() => prepareStoryProposal({ operations: [{ ...operation, node: { ...operation.node, body: node.body, event: '别的路线事件' } }] }, snapshot)).toThrow('STORY_ROUTE_CONTEXT_REQUIRED')
  expect(() => prepareStoryProposal({ operations: [operation] }, { ...snapshot, routes: [...snapshot.routes, { id: nodeId, title: '另一前缀', nodeIds: [routeId, nodeId] }] }, scope, scoped)).toThrow('STORY_SHARED_CONTEXT_REQUIRED')
  const proposal = prepareStoryProposal({ operations: [operation] }, { ...snapshot, routes: [...snapshot.routes, { id: nodeId, title: '共用路线', nodeIds: [nodeId] }] }, scope, scoped)
  expect(proposal.writesProse).toBe(true)
  expect(proposal.affectedRoutes).toEqual(['共用路线', '北塔路线'])
  expect(proposal.affectsSharedContent).toBe(true)
  expect(() => prepareStoryProposal({ operations: [operation, { type: 'delete-route', id: routeId }] }, snapshot, scope, scoped)).toThrow('STORY_PROSE_REQUIRES_SEPARATE_PROPOSAL')
  expect(() => prepareStoryProposal({ operations: [{ type: 'put-note', note: { id: nodeId, nodeId, routeId }, confirm: true }] }, snapshot, scope, scoped)).toThrow('STORY_AUTHOR_CONFIRMATION_REQUIRED')
})

it('builds the model context from main-verified route facts and refuses unconfirmed shared generation', () => {
  const tools = [readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool].map(({ name, description, inputSchema, requiresConfirmation, isReadOnly, source }) => ({ name, description, inputSchema: { ...inputSchema }, requiresConfirmation, isReadOnly, source }))
  const input = { mode: 'planning' as const, uiLocale: 'zh-CN' as const, historyMessages: [], userMessage: '写北塔路线', storyContext: scope, tools }
  const prompt = JSON.stringify({ key: 'assistant_writing_identity', content: '写作助手', systemRole: '小说助手' })
  const context = buildAgentGenerationContext(input, { project_name: '合成', character_states: '外线受伤状态', characters_arch: '旧全局动态' }, 'zh-CN', prompt, prompt, { context: scoped, staticCharacters: [{ name: '林岚', background: '守塔人' }] })
  const system = context.initialMessages[0].content
  expect(system).toContain('原正文')
  expect(system).toContain('守塔人')
  expect(system).not.toContain('外线受伤状态')
  expect(system).not.toContain('旧全局动态')
  expect(() => buildAgentGenerationContext(input, {}, 'zh-CN', prompt, prompt, { context: { ...scoped, readyForGeneration: false }, staticCharacters: [] })).toThrow('GENERATION_AGENT_STORY_CONTEXT_NOT_READY')
})
