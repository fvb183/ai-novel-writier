import { ipc } from '../../ipc-client'
import { globalEventBus } from '../../../shared/event-bus'
import { buildAgentTool } from '../tool-registry'
import type { StoryContextRequest } from '../../../shared/story-branches'
import { projectStoryWritingContext, storyWritingContinuityInstruction } from '../../../shared/story-writing-context'
import { agentToolText, assertAgentProjectCurrent, assertAgentToolActive, requireAgentProject } from './project-context'

const selected = (args: Record<string, unknown>, context: Parameters<typeof requireAgentProject>[0]): StoryContextRequest => {
  const request = { nodeId: args.node_id, routeId: args.mode === 'shared' ? null : args.route_id, mode: args.mode ?? 'route',
    ...(args.bridge_to_node_id !== undefined ? { bridgeToNodeId: args.bridge_to_node_id } : {}) } as StoryContextRequest
  if (context?.storyContext && (request.nodeId !== context.storyContext.nodeId || request.routeId !== context.storyContext.routeId
    || request.mode !== context.storyContext.mode || request.bridgeToNodeId !== context.storyContext.bridgeToNodeId)) throw new Error('STORY_CONTEXT_SCOPE_MISMATCH')
  return request
}

export const readStoryGraphTool = buildAgentTool({
  name: 'read_story_graph', userFacingName: '读取剧情分支图', source: 'builtin',
  description: '读取剧情节点、连接和路线的结构；不读取其他路线正文或人物动态事实。写正文前请在所选路线调用 read_story_context。',
  descriptionEn: 'Read story nodes, edges and routes as structure, excluding prose and dynamic facts from other routes. Read the selected story context before proposing prose.',
  inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false,
  execute: async (_args, context) => {
    const { projectSession } = requireAgentProject(context)
    try {
    const response = await ipc.invokeWithProjectSession(projectSession, 'story:read', {})
    assertAgentProjectCurrent(context)
    if (!response.success) return { success: false, content: '', error: response.error }
    return { success: true, content: JSON.stringify({
      nodes: response.data.nodes.map(({ id, kind, title, chapterNumber }) => ({ id, kind, title, chapterNumber })),
      edges: response.data.edges, routes: response.data.routes,
      instruction: agentToolText(context, '这是路线结构，不是所有路线共同发生的事实。请沿作者选定路径读取正文。', 'This is route structure, not common established events. Read prose along the author-selected path.'),
    }) }
    } catch {
      return { success: false, content: '', error: agentToolText(context, '读取剧情分支失败，请重新核对项目会话。', 'Could not read story structure. Check the project session and retry.') }
    }
  },
})

export const readStoryContextTool = buildAgentTool({
  name: 'read_story_context', userFacingName: '读取路线前情', source: 'builtin',
  description: '读取作者所选节点的路线前情。route 仅取该路线前缀；shared 仅取作者确认的共同事实与入口差异。只有作者指定 bridge_to_node_id 时才额外读取这一份直接连接的后文作为未来衔接约束，不是已发生事实。省略即不接回后文，桥参数须与作者选择一致。未确认的共享前情不能用于生成。',
  descriptionEn: 'Read the selected node’s continuity: route mode uses only that prefix; shared mode uses author-confirmed common facts and entry differences. Only an author-selected bridge_to_node_id admits that one directly linked later chapter as a future transition constraint, not established history. Omit it when no bridge was selected; it must match the author’s selection. Unconfirmed shared continuity cannot authorize generation.',
  inputSchema: { type: 'object', properties: {
    node_id: { type: 'string', description: '目标节点 ID', descriptionEn: 'Target node ID' },
    route_id: { type: 'string', description: 'route 模式的路线 ID', descriptionEn: 'Route ID in route mode' },
    mode: { type: 'string', description: '路线正文或汇合共享正文', descriptionEn: 'Route prose or shared merge prose', enum: ['route', 'shared'], default: 'route' },
    bridge_to_node_id: { type: 'string', description: '可选：作者指定的直接后继节点 ID，作为接回后文的未来约束。不得自行选择、替换或省略作者指定值。', descriptionEn: 'Optional author-selected direct successor ID, used as the future bridge constraint. Never choose, replace or omit a value selected by the author.' },
  }, required: ['node_id', 'mode'] }, requiresConfirmation: false,
  execute: async (args, context) => {
    const { projectSession } = requireAgentProject(context)
    const request = selected(args, context)
    try {
    const response = await ipc.invokeWithProjectSession(projectSession, 'story:context', request)
    assertAgentProjectCurrent(context)
    if (!response.success) return { success: false, content: '', error: response.error }
    return { success: true, content: JSON.stringify({ ...projectStoryWritingContext(response.data),
      sourcePlanInstruction: storyWritingContinuityInstruction(context?.writingLanguage ?? 'zh-CN'),
      instruction: agentToolText(context, '只按此路径及当前确认前情取材；其他路线和全局人物动态状态不能充当本路线事实。目标 chapterBlueprint 是本章待落实的计划，不是已发生的前情。有 continuation 时仅把这一份指定后文作为未来衔接约束，不得当作过去事实；没有则只参考前文。按蓝图生成时只改目标 body，保留蓝图与 chapterSource；不得覆盖主线草稿。审查衔接只报告问题与建议，不调用写入提案。', 'Use only this path and current confirmed continuity. Other routes and global dynamic character state are not facts for this route. The target chapterBlueprint is a plan for this chapter, not established continuity. If continuation is present, use only that selected later chapter as a future transition constraint, never earlier facts; otherwise use past continuity only. Generate only the target body and preserve its blueprint and chapterSource; never overwrite mainline drafts. A consistency review reports issues and suggestions without write proposals.'),
    }) }
    } catch {
      return { success: false, content: '', error: agentToolText(context, '读取路线前情失败，请重新核对所选路线。', 'Could not read route continuity. Check the selected route and retry.') }
    }
  },
})

export const proposeStoryChangesTool = buildAgentTool({
  name: 'propose_story_changes', userFacingName: '提出剧情分支修改', source: 'builtin',
  description: '提出剧情节点、连接、路线或前情候选，必须经作者批准。新实体 ID 必须为小写 UUIDv4。正文或现有事件修改限作者当前所选路线的一个节点，先调用 read_story_context；普通助手请引导作者从剧情分支页选中节点并点击“让助手帮助写作”，新建节点先留空正文。按章节蓝图生成时只改目标 body，chapterBlueprint 和只读来源 chapterSource 保持原样；不得覆盖主线草稿。蓝图编辑须作为独立提案。operations 使用 put-node/delete-node/restore-node/put-edge/delete-edge/put-route/delete-route/put-note/delete-note。共同前情只可提出未确认候选，不能代作者确认。',
  descriptionEn: 'Propose story node, edge, route or continuity changes for author approval. New entity IDs must be lowercase UUIDv4. Prose or existing-event edits target one node in the author-selected route after read_story_context. In a general conversation, ask the author to select the node in the story editor and choose Prepare assistant writing. Create new structural nodes with empty prose first. Blueprint chapter generation changes only the target body, preserving chapterBlueprint and read-only chapterSource; never overwrite mainline drafts. Propose blueprint edits separately. Use put-node/delete-node/restore-node/put-edge/delete-edge/put-route/delete-route/put-note/delete-note operations. Continuity notes remain unconfirmed candidates.',
  inputSchema: { type: 'object', properties: {
    operations: { type: 'array', description: '与剧情编辑器相同的操作数组；put-node.node 含 id/kind/title/chapterNumber/event/body，可含 chapterBlueprint（title/role/purpose/keyEvents/characters:string[]/suspenseHook/userGuidance/notes）。现有蓝图和 chapterSource 省略时保留，不得编造或更换 chapterSource。正文生成时不要修改蓝图。put-edge.edge 含 id/from/to/label/condition，put-route.route 含 id/title/nodeIds，put-note.note 含 id/routeId/nodeId/summary/characterStates/entryDifferences。不得传写入版本、哈希或授权。', descriptionEn: 'Story operations: put-node.node has id/kind/title/chapterNumber/event/body and optional chapterBlueprint {title,role,purpose,keyEvents,characters:string[],suspenseHook,userGuidance,notes}. Omitted existing blueprint and chapterSource are preserved. Never invent or replace chapterSource, or change a blueprint while generating prose. put-edge.edge has id/from/to/label/condition; put-route.route has id/title/nodeIds; put-note.note has id/routeId/nodeId/summary/characterStates/entryDifferences. Do not supply revision, hash or authorization.' },
    context: { type: 'object', description: '可选的所选路线 {nodeId,routeId,mode,bridgeToNodeId?}，接回后文参数也须与作者选择一致', descriptionEn: 'Optional {nodeId,routeId,mode,bridgeToNodeId?}, matching the author-selected route including its optional later-chapter bridge' },
  }, required: ['operations'] }, requiresConfirmation: true, isReadOnly: false,
  execute: async (_args, context) => {
    const { projectSession } = requireAgentProject(context)
    if (!context?.agentToolAction) return { success: false, commitState: 'not_committed', content: '', error: 'GENERATION_AGENT_ACTION_REQUIRED' }
    assertAgentToolActive(context)
    context.markSideEffectStarted?.()
    const receipt = await ipc.invokeWithProjectSession(projectSession, 'agent-generation:commit-domain-tool', { ref: context.agentToolAction })
    if (receipt.kind !== 'story') throw new Error('GENERATION_AGENT_DOMAIN_RECEIPT_MISMATCH')
    globalEventBus.emit('STORY_CHANGED', { projectSession })
    return { success: true, commitState: 'committed', content: agentToolText(context,
      '作者批准的剧情分支修改已提交；前情候选仍需作者另行确认，才能成为共享事实。',
      'The approved story changes were committed. Continuity candidates still require separate author confirmation before becoming shared facts.') }
  },
})
