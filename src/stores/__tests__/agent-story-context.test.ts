import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installAgentProjectGuard, useAgentStore } from '../agent-store'
import { useProjectStore } from '../project-store'
import { useLLMStore } from '../llm-store'
import { useEditorStore } from '../editor-store'
import { toolRegistry } from '../../services/agent/tool-registry'
import { readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool } from '../../services/agent/tools/story-tools'
import type { StoryContextRequest } from '../../shared/story-branches'
const { invoke, slash, mentions } = vi.hoisted(() => ({ invoke: vi.fn(), slash: vi.fn(), mentions: vi.fn() }))
vi.mock('../../services/ipc-client', () => ({ ipc: { invokeWithProjectSession: (...args: unknown[]) => invoke(...args), invoke: vi.fn() } }))
vi.mock('../../services/agent/intent-router', () => ({ parseSlashCommand: slash, parseMentions: mentions, mentionsToToolCalls: vi.fn(), getAllMentionTargets: vi.fn(() => []), getAllSlashCommands: vi.fn(() => []) }))
const scope: StoryContextRequest = { nodeId: '11111111-1111-4111-8111-111111111111', routeId: '22222222-2222-4222-8222-222222222222', mode: 'route' }
const project = (lease = 'lease-1') => ({ id: 'p', path: 'C:/synthetic/story', sessionLease: lease, name: 'story', novelConfig: { writingLanguage: 'zh-CN' } })
beforeEach(() => {
  invoke.mockReset(); slash.mockReset(); mentions.mockReset()
  useProjectStore.setState({ currentProject: project() as never })
  useAgentStore.setState({ conversations: [], activeConversationId: null, generating: false, toolsInitialized: true })
  useLLMStore.setState({ defaultModelId: 'synthetic' })
  useEditorStore.setState({ tabs: [] })
  toolRegistry.clear(); toolRegistry.registerAll([readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool])
  toolRegistry.register({ ...readStoryGraphTool, name: 'read_characters' })
})
afterEach(() => { toolRegistry.clear(); useAgentStore.setState({ generating: false }); useProjectStore.setState({ currentProject: null }) })

it('keeps a structured route and treats slash and mention text as plain requests before any global intent path', async () => {
  const conversation = useAgentStore.getState().createConversation()
  useAgentStore.getState().setStoryContext(scope)
  invoke.mockRejectedValue(new Error('SYNTHETIC_STOP_BEFORE_MODEL_REQUEST'))
  await useAgentStore.getState().sendMessage('/new @角色\n请写所选路线')
  expect(slash).not.toHaveBeenCalled(); expect(mentions).toHaveBeenCalledOnce()
  expect(useAgentStore.getState().activeConversationId).toBe(conversation.id)
  expect(invoke).toHaveBeenCalledOnce()
  const request = invoke.mock.calls[0][2]
  expect(request.input.storyContext).toEqual(scope)
  expect(request.input.userMessage).toBe('/new @角色\n请写所选路线')
  expect(request.input.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_story_graph', 'read_story_context', 'propose_story_changes'])
  expect(request.input).not.toHaveProperty('editorContext')
})

it('does not automatically restore a route selection after a project lease changes', () => {
  const dispose = installAgentProjectGuard()
  useAgentStore.getState().createConversation(); useAgentStore.getState().setStoryContext(scope)
  useProjectStore.setState({ currentProject: project('lease-2') as never })
  expect(useAgentStore.getState().getActiveConversation()).toBeNull()
  dispose()
})

it('starts a fresh conversation when the selected route changes after messages exist', () => {
  const original = useAgentStore.getState().createConversation()
  useAgentStore.getState().setStoryContext(scope)
  useAgentStore.setState(state => ({ conversations: state.conversations.map(conv => ({ ...conv, messages: [{ id: 'old', role: 'assistant', content: '另一条路线旧事实', createdAt: 0 }] })) }))
  useAgentStore.getState().setStoryContext({ ...scope, routeId: scope.nodeId })
  const active = useAgentStore.getState().getActiveConversation()!
  expect(active.id).not.toBe(original.id)
  expect(active.messages).toEqual([])
})
