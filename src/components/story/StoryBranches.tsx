import { useEffect, useState } from 'react'
import { ChevronRight, GitBranch, PanelRightClose, PanelRightOpen, Plus } from 'lucide-react'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { StoryChapterBlueprint, StoryContext, StoryEdge, StoryNode, StoryNoteInput, StoryOperation, StoryRoute } from '../../shared/story-branches'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useAgentStore } from '../../stores/agent-store'
import { useStageStore } from '../../stores/navigation/stage-store'
import { prefillAgentInput } from '../panels/agent/AgentInputBox'
import { Button } from '../ui/Button'
import { DangerConfirm } from '../ui/DangerConfirm'
import { SegmentedControl } from '../ui/SegmentedControl'
import StoryTreeCanvas from './StoryTreeCanvas'
import StoryChapterBlueprintEditor from './StoryChapterBlueprintEditor'
import { availableGenerationModelId } from '../../services/workflows/chapter-write-launch'
import { useLLMStore } from '../../stores/llm-store'
import { routeStageModel } from '../../shared/model-stage-routing'
import { planConnect, planContinue, planFork, planMerge, planRouteFromPath, type StoryTreePlan } from './story-tree-commands'
import { affectedStoryRoutes, discardStoryWorkspace, ensureStoryWorkspace, getStoryWorkspace, loadStoryWorkspace, nodeInput, readStoryContext, saveStoryWorkspace, stageStoryOperations, storyPreview, updateStoryWorkspace, useStoryWorkspaces } from './story-workspace'
import './story-branches.css'

type Text = (zh: string, en: string) => string
type Section = 'blueprint' | 'node' | 'edges' | 'routes' | 'continuity' | 'history'
export function storyMessage(code: string, text: Text): string {
  const messages: Record<string, [string, string]> = {
    STORY_SAVED: ['分支内容已保存。', 'Story changes saved.'],
    STORY_MAINLINE_READ_ONLY: ['主线章节在原蓝图或正文中编辑。这里可以从本章分支或插章。', 'Edit a mainline chapter in its original blueprint or manuscript. You can branch or insert a chapter here.'],
    STORY_CHAPTER_NOT_FOUND: ['这个主线章节的来源已不存在，请刷新章节树后核对。', 'This mainline chapter source no longer exists. Refresh the chapter tree and review it.'],
    STORY_CHAPTER_SOURCE_UNAVAILABLE: ['暂时无法读取原章节。请保留当前输入，刷新后重试。', 'The original chapter cannot be read right now. Keep your input, refresh and retry.'],
    STORY_CHAPTER_SOURCE_INVALID: ['原章节的正文或蓝图记录暂时无法确认，请先打开原章核对，刷新后再继续。', 'The source manuscript or blueprint cannot be verified. Open the original chapter to review it, then refresh and continue.'],
    STORY_GRAPH_PENDING: ['先保存章节树上的修改，再核对前情或生成正文。', 'Save chapter tree changes before inspecting continuity or generating manuscript.'],
    STORY_CHAPTER_NEXT_REQUIRED: ['后面还没有主线章节，暂时不能插入接回章节。可以从本章分支。', 'There is no later mainline chapter to reconnect to. You can branch from this chapter.'],
    STORY_CONTINUATION_INVALID: ['选中的后文与当前章节没有直接连接。请先连接后文，或选择不接回。', 'The selected later chapter has no direct link from this chapter. Link it first, or choose no bridge.'],
    STORY_UNSAVED_INPUT: ['章节树还有未保存修改，请先保存或放弃，再继续。', 'The chapter tree has unsaved changes. Save or discard them before continuing.'],
    STORY_SOURCE_NOT_SAVED: ['原章节蓝图尚未完整保存，请保存后再创建分支。', 'The source blueprint is not fully saved. Save it before branching.'],
    STORY_RELOAD_REQUIRED: ['章节树已更新，输入已保留。请刷新后比较并确认。', 'The chapter tree changed and your input is retained. Refresh, compare and confirm.'],
    STORY_REVIEW_RETAINED_INPUT: ['已读取当前版本并保留你的输入。请比较差异后确认，再保存。', 'Current version loaded and your input retained. Compare and confirm before saving.'],
    STORY_REVIEW_REQUIRED: ['请先核对保留的输入与当前版本。', 'Review retained input against the current version first.'],
    STORY_REVISION_CONFLICT: ['分支内容已在别处修改。你的输入已保留，请重新读取并核对。', 'The story changed elsewhere. Your input is retained; reload and compare.'],
    STORY_VERSION_CONFLICT: ['分支内容已在别处修改。你的输入已保留，请重新读取并核对。', 'The story changed elsewhere. Your input is retained; reload and compare.'],
    STORY_STALE: ['分支内容已变化。你的输入已保留，请重新读取并核对。', 'The story changed. Your input is retained; reload and compare.'],
    STORY_REVISION_STALE: ['分支内容已在别处修改。你的输入已保留，请重新读取并核对。', 'The story changed elsewhere. Your input is retained; reload and compare.'],
    STORY_CONTEXT_STALE: ['路线前情的来源已变化。请保存当前修改后重新核对前情。', 'Continuity sources changed. Save your story changes and review continuity again.'],
    STORY_CONTEXT_UNCONFIRMED: ['请先核对、确认并保存汇合的共同前情。', 'Review, confirm and save common continuity at the merge first.'],
    STORY_SHARED_CONTEXT_INVALID: ['共用写作需要至少两条前情不同的路线，目标应是汇合或共用内容节点。', 'Shared writing needs at least two routes with different earlier paths and a merge or shared content target.'],
    STORY_CYCLE: ['连接形成了循环。请调整连接，保留单向前进的路线。', 'Links form a cycle. Update them to keep routes moving forward.'],
    STORY_ROUTE_DISCONNECTED: ['路线相邻节点之间缺少连接，请补充连接或调整顺序。', 'Adjacent route nodes lack a link. Add it or update their order.'],
    STORY_REFERENCE_INVALID: ['节点、路线或前情仍存在关联，请先核对这些连接。', 'A node, route or continuity reference is invalid. Review related connections.'],
    STORY_INPUT_INVALID: ['请核对节点标题、章节编号和路线内容，填写有效内容后再保存。', 'Check node titles, chapter numbers and route content, then save valid values.'],
    STORY_ROUTE_INVALID: ['路线需要节点，且每个节点只能经过一次。请核对节点顺序。', 'A route needs nodes and may visit each node once. Review its order.'],
    STORY_DUPLICATE_NOTE: ['同一节点和路线已有前情记录。请重新读取并核对，输入仍保留。', 'Continuity already exists for this node and route. Reload and compare; your input remains.'],
    STORY_NODE_NOT_FOUND: ['这个节点已被移除，请重新读取分支内容。输入仍保留。', 'This node was removed. Reload the story; your input remains.'],
    STORY_RECORD_NOT_FOUND: ['所选内容已不存在，请重新读取并核对。输入仍保留。', 'The selected record no longer exists. Reload and compare; your input remains.'],
    STORY_SIZE_LIMIT: ['分支内容超过当前容量，请缩短单次内容或减少条目后重试。', 'Story content exceeds the current limit. Shorten this content or reduce the number of records and retry.'],
    STORY_SESSION_STALE: ['项目会话已变化。输入仍保留，请重新读取并核对。', 'The project session changed. Your input remains; reload and compare.'],
    STORY_SHARED_EDIT_CONFIRMATION_REQUIRED: ['这份正文被多条路线共用，请先确认影响范围。', 'This content is shared by several routes. Confirm the affected routes first.'],
    STORY_BUSY: ['正在处理分支内容，请稍候。', 'Story changes are being processed. Please wait.'],
    STORY_INPUT_CHANGED: ['保存期间出现了新输入，已保留，请再保存一次。', 'New input arrived while saving and is retained. Save again.'],
    STORY_ROUTE_NODE_MISMATCH: ['当前路线不经过这个节点。请切换到包含它的路线，或选择“全图”。', 'This scene is outside the selected route. Choose a route containing it, or select All paths.'],
    STORY_ROUTE_REQUIRED: ['这个节点有多条前情，请先选择要展开的路线。', 'This scene has several earlier paths. Select the route to expand first.'],
    STORY_EDGE_EXISTS: ['这两个节点已经相连，点击树上的连线即可修改走向。', 'These scenes are already linked. Select that link on the tree to edit its direction.'],
    STORY_EDGE_IN_USE: ['这条连接已用于路线。请先调整相关路线，再修改连接的端点或删除连接。', 'A route uses this link. Update that route before changing the endpoints or removing the link.'],
    STORY_MERGE_SOURCES_REQUIRED: ['请选择至少两个不同的汇合入口。', 'Choose at least two different merge entrances.'],
  }
  return messages[code] ? text(...messages[code]) : code
}

export default function StoryBranches() {
  const project = useProjectStore(state => state.currentProject)
  const text = useLocaleStore(state => state.text)
  const session = projectSessionContextFromProject(project)
  if (!session) return <p>{text('请先打开作品。', 'Open a project first.')}</p>
  return <StoryEditor session={session} key={`${session.projectId}|${session.projectPath}`} />
}

function StoryEditor({ session }: { session: ProjectSessionContext }) {
  const text = useLocaleStore(state => state.text)
  const key = ensureStoryWorkspace(session)
  const workspace = useStoryWorkspaces(state => state.entries[key])
  const snapshot = storyPreview(workspace)
  const [section, setSection] = useState<Section>(() => snapshot?.nodes.find(item => item.id === workspace.selectedNodeId)?.chapterBlueprint ? 'blueprint' : 'node')
  const [danger, setDanger] = useState<'discard' | 'node' | 'route' | 'edge' | 'route-path' | null>(null)
  const [routeChange, setRouteChange] = useState<{ route: StoryRoute; noteIds: string[] } | null>(null)
  const [historyId, setHistoryId] = useState('')
  const [routeNode, setRouteNode] = useState('')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [mergeSources, setMergeSources] = useState<string[]>([])
  const [mergeTitle, setMergeTitle] = useState('')
  const [generationModelId, setGenerationModelId] = useState<string | null>(null)
  const models = useLLMStore(state => state.models)
  const draftingModelId = useLLMStore(state => routeStageModel('drafting', state).modelId)
  const selectedModelId = generationModelId ?? draftingModelId
  const stale = !sameProjectSessionContext(workspace.session, session)
  const node = snapshot?.nodes.find(item => item.id === workspace.selectedNodeId)
  const edge = snapshot?.edges.find(item => item.id === workspace.selectedEdgeId)
  const route = snapshot?.routes.find(item => item.id === workspace.selectedRouteId)
  const sharing = affectedStoryRoutes(workspace)
  const savedNode = workspace.snapshot?.nodes.find(item => item.id === node?.id)
  const pending = workspace.pending.length > 0
  const graphPending = workspace.pending.some(operation => operation.type !== 'put-note')
  const disabled = workspace.busy || stale
  const generating = useAgentStore(state => state.generating)
  useEffect(() => { if (!workspace.snapshot) void loadStoryWorkspace(key, session) }, [key, session.leaseId, workspace.snapshot])
  const continuationKey = (nodeId: string, routeId: string) => `${workspace.mode}:${routeId}:${nodeId}`
  const rememberedContinuation = (nodeId: string, routeId: string, fallback: string) => workspace.continuationSelections[continuationKey(nodeId, routeId)] ?? fallback
  const selectNode = (id: string) => {
    const next = snapshot?.nodes.find(item => item.id === id), index = route?.nodeIds.indexOf(id) ?? -1
    const fallback = next?.chapterBlueprint && index >= 0 ? route?.nodeIds[index + 1] ?? '' : ''
    updateStoryWorkspace(key, { selectedNodeId: id, context: null, bridgeToNodeId: rememberedContinuation(id, route?.id ?? '', fallback) })
    setHistoryId(''); setSection(next?.chapterBlueprint ? 'blueprint' : 'node'); setInspectorOpen(true)
  }
  const selectEdge = (id: string) => {
    const connection = snapshot?.edges.find(item => item.id === id)
    updateStoryWorkspace(key, { selectedEdgeId: id, ...(connection ? { selectedNodeId: connection.from, bridgeToNodeId: connection.to, context: null,
      continuationSelections: { ...workspace.continuationSelections, [continuationKey(connection.from, route?.id ?? '')]: connection.to },
    } : {}) })
    setSection('edges'); setInspectorOpen(true)
  }
  const selectRoute = (id: string) => {
    const next = snapshot?.routes.find(item => item.id === id), index = next?.nodeIds.indexOf(node?.id ?? '') ?? -1
    const fallback = node?.chapterBlueprint && index >= 0 ? next?.nodeIds[index + 1] ?? '' : ''
    updateStoryWorkspace(key, { selectedRouteId: id, context: null, bridgeToNodeId: rememberedContinuation(node?.id ?? '', id, fallback) })
  }
  const applyPlan = (plan: StoryTreePlan) => {
    if (disabled) return
    if (plan.error) { updateStoryWorkspace(key, { error: plan.error, notice: '' }); return }
    stageStoryOperations(key, plan.operations)
    updateStoryWorkspace(key, {
      ...(plan.selectedNodeId !== undefined ? { selectedNodeId: plan.selectedNodeId } : {}),
      ...(plan.selectedRouteId !== undefined ? { selectedRouteId: plan.selectedRouteId } : {}),
      ...(plan.selectedEdgeId !== undefined ? { selectedEdgeId: plan.selectedEdgeId } : {}),
      bridgeToNodeId: '',
    })
    setInspectorOpen(true); setSection(plan.selectedEdgeId && !plan.selectedNodeId ? 'edges' : 'blueprint')
    setHistoryId('')
  }
  const continueFrom = (id: string) => { if (snapshot) applyPlan(planContinue(snapshot, id, route?.id ?? null, text('后续剧情', 'Next scene'))) }
  const forkFrom = (id: string) => {
    if (!snapshot) return
    applyPlan(planFork(snapshot, id, route?.id ?? null, [text('走向 A', 'Direction A'), text('走向 B', 'Direction B')]))
  }
  const beginMerge = (id: string) => { selectNode(id); setMergeSources([id]); setMergeTitle(text('两路汇合', 'Paths converge')) }
  const createMerge = () => {
    if (!snapshot) return
    const plan = planMerge(snapshot, mergeSources, mergeTitle.trim())
    applyPlan(plan)
    if (!plan.error) setMergeSources([])
  }
  const changeNode = (delta: Partial<StoryNode>) => { if (node) stageStoryOperations(key, [{ type: 'put-node', node: { ...nodeInput(node), ...delta } }]) }
  const edgeRoutes = snapshot?.routes.filter(item => item.nodeIds.some((id, index) => id === edge?.from && item.nodeIds[index + 1] === edge?.to)) ?? []
  const changeEdge = (delta: Partial<StoryEdge>) => {
    if (!edge || !snapshot || disabled) return
    if ((delta.from !== undefined || delta.to !== undefined) && edgeRoutes.length) { updateStoryWorkspace(key, { error: 'STORY_EDGE_IN_USE' }); return }
    const updated = { ...edge, ...delta }
    if (delta.from !== undefined || delta.to !== undefined) {
      const plan = planConnect({ ...snapshot, edges: snapshot.edges.filter(item => item.id !== edge.id) }, updated.from, updated.to, updated.label)
      if (plan.error) { updateStoryWorkspace(key, { error: plan.error }); return }
    }
    stageStoryOperations(key, [{ type: 'put-edge', edge: updated }])
  }
  const changeRoute = (delta: Partial<StoryRoute>) => {
    if (!route || !snapshot || disabled) return
    if (delta.nodeIds) {
      const plan = planRouteFromPath({ ...snapshot, routes: snapshot.routes.filter(item => item.id !== route.id) }, delta.nodeIds, route.title)
      if (plan.error) { updateStoryWorkspace(key, { error: plan.error }); return }
      const notes = snapshot.notes.filter(note => note.routeId === route.id && !delta.nodeIds!.includes(note.nodeId))
      if (notes.length) { setRouteChange({ route: { ...route, ...delta }, noteIds: notes.map(note => note.id) }); setDanger('route-path'); return }
    }
    stageStoryOperations(key, [{ type: 'put-route', route: { ...route, ...delta } }])
  }
  const addNode = (kind: StoryNode['kind']) => {
    const id = crypto.randomUUID()
    const title = text(kind === 'branch' ? '新的分支点' : kind === 'merge' ? '新的汇合' : '新的内容', kind === 'branch' ? 'New branch' : kind === 'merge' ? 'New merge' : 'New content')
    stageStoryOperations(key, [{ type: 'put-node', node: { id, kind, title, chapterNumber: null, event: '', body: '',
      ...(kind !== 'branch' ? { chapterBlueprint: { title, role: '', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '', notes: '' } } : {}),
    } }])
    selectNode(id); setSection(kind === 'branch' ? 'node' : 'blueprint')
  }
  const addEdge = () => {
    if (!snapshot || snapshot.nodes.length < 2) return
    const from = node?.id ?? snapshot.nodes[0].id
    for (const candidate of snapshot.nodes.filter(item => item.id !== from)) {
      const plan = planConnect(snapshot, from, candidate.id, text('新的走向', 'New direction'))
      if (!plan.error) { applyPlan(plan); setSection('edges'); return }
    }
    updateStoryWorkspace(key, { error: 'STORY_EDGE_EXISTS' })
  }
  const addRoute = () => {
    if (!snapshot?.nodes.length) return
    const id = crypto.randomUUID()
    stageStoryOperations(key, [{ type: 'put-route', route: { id, title: text(`路线 ${snapshot.routes.length + 1}`, `Route ${snapshot.routes.length + 1}`), nodeIds: [node?.id ?? snapshot.nodes[0].id] } }])
    updateStoryWorkspace(key, { selectedRouteId: id, context: null }); setSection('routes')
  }
  const save = () => { void saveStoryWorkspace(key).catch(() => undefined) }
  const bridgeToNodeId = snapshot?.edges.some(item => item.from === node?.id && item.to === workspace.bridgeToNodeId) ? workspace.bridgeToNodeId : ''
  const contextRequest = node && (workspace.mode === 'shared' || route?.nodeIds.includes(node.id)) ? { nodeId: node.id, routeId: workspace.mode === 'shared' ? null : route?.id ?? null, mode: workspace.mode,
    ...(bridgeToNodeId ? { bridgeToNodeId } : {}),
  } as const : null
  const loadContext = () => { if (contextRequest) void readStoryContext(key, contextRequest) }
  const prepareAssistant = async () => {
    if (!contextRequest) return
    const context = await readStoryContext(key, contextRequest)
    if (!context) return
    if (!context.readyForGeneration) {
      updateStoryWorkspace(key, { error: context.request.mode === 'route'
        ? text('此正文由前情不同的路线共用。请选择共用写作，核对并确认共同前情。', 'This manuscript is shared by routes with different earlier events. Choose shared writing and confirm common continuity.')
        : text('请先核对、确认并保存共同前情。', 'Review, confirm and save common continuity first.') })
      setSection('continuity')
      return
    }
    const prompt = text(
      `请帮助写作剧情节点「${context.target.title}」。先使用 read_story_context 读取 request=${JSON.stringify(contextRequest)}，前情只沿所选路线读取；若指定 continuation 后文，作为衔接目标共同参考，不能当作已发生事实。共用模式只使用已确认的共同事实，并注明入口差异。请用 propose_story_changes 提出节点正文修改，等待我批准后再保存。`,
      `Help write story node “${context.target.title}”. First call read_story_context with request=${JSON.stringify(contextRequest)}. Use established continuity only from the selected route. If continuation is supplied, use it as the later constraint to bridge into, never as an earlier fact. In shared mode use confirmed common facts and distinguish entrance differences. Propose manuscript changes with propose_story_changes and wait for my approval before saving.`,
    )
    if (!prefillAgentInput(session, prompt)) return
    useAgentStore.getState().createConversation()
    useAgentStore.getState().setStoryContext(contextRequest)
    useStageStore.setState({ sheet: { kind: 'assistant' } })
    updateStoryWorkspace(key, { notice: text('已准备助手问题。检查后发送才会请求模型。', 'Assistant input prepared. A model request starts only when you send it.') })
  }
  const generateChapter = async (action: 'draft' | 'review' = 'draft') => {
    if (!contextRequest || disabled || pending || generating) return
    const modelId = availableGenerationModelId(models, selectedModelId)
    if (!modelId) { updateStoryWorkspace(key, { error: text('请先选择一个可用的文本生成模型。', 'Select an available text generation model first.') }); return }
    const context = await readStoryContext(key, contextRequest)
    if (!context) return
    const blueprint = context.target.chapterBlueprint
    if (action === 'draft' && (!blueprint || !blueprint.title.trim() || ![blueprint.purpose, blueprint.keyEvents].some(value => value.trim()))) {
      updateStoryWorkspace(key, { error: text('先填写并保存分支蓝图的标题、本章目标或关键事件，再生成正文。', 'Save a branch blueprint with a title and a purpose or key events before generating its manuscript.') }); return
    }
    if (!context.readyForGeneration) {
      updateStoryWorkspace(key, { error: text('这个节点共用于不同前情的路线，请先核对并确认共同前情。', 'This scene is shared by routes with different earlier events. Review and confirm common continuity first.') })
      setSection('continuity'); return
    }
    if (!sameProjectSessionContext(projectSessionContextFromProject(useProjectStore.getState().currentProject), session) || useAgentStore.getState().generating) return
    const agent = useAgentStore.getState()
    agent.createConversation(); agent.setStoryContext(contextRequest); agent.setMode('fast'); agent.setModelId(modelId)
    useStageStore.setState({ sheet: { kind: 'assistant' } })
    const target = useProjectStore.getState().currentProject?.novelConfig.wordsPerChapter
    const prompt = action === 'review' ? text(
      `请审查「${context.target.title}」的衔接一致性。先用 read_story_context 读取 request=${JSON.stringify(contextRequest)}，核对父级前文、当前正文${bridgeToNodeId ? '和指定后文' : ''}的人物身份与状态、物品归属、时间线、因果和信息获知是否一致。指定后文是待接入的未来约束，不属于已发生的前情。按“冲突/证据/修改建议”列出确切问题，区分无法判断与已证实的冲突；没有冲突则明确说明。本次只读审稿，不调用任何修改提案，不写入正文或蓝图。`,
      `Review continuity for “${context.target.title}”. First read_story_context with request=${JSON.stringify(contextRequest)}. Check identities, character states, ownership, timeline, causality and knowledge between earlier events, this manuscript${bridgeToNodeId ? ' and the selected later scene' : ''}. The later scene is a future constraint, not an earlier fact. List supported conflicts, evidence and suggested edits, distinguishing uncertainty from contradictions. This is a read-only review: do not propose or save any changes.`,
    ) : text(
      `请按目标节点「${context.target.title}」已保存的 chapterBlueprint 生成这一章的完整正文${target ? `，目标约 ${target} 字` : ''}。先用 read_story_context 读取 request=${JSON.stringify(contextRequest)}，逐项落实本章蓝图。${bridgeToNodeId ? '同时考虑父级前文和指定 continuation 后文，生成衔接两端的桥接章节；后文是结尾必须兼容的目标，不能冒充已发生事实。' : '只衔接所选路线的父级前情，不采用任何后文。'}不要使用其他分支或未指定的主线后文。用 propose_story_changes 仅提出目标节点的 body 正文修改，保留节点 ID、蓝图、章节来源和已有连接，等待我批准。不要修改全局主线章节。`,
      `Generate the complete manuscript for “${context.target.title}” from its saved chapterBlueprint${target ? `, aiming for about ${target} words` : ''}. First read_story_context with request=${JSON.stringify(contextRequest)} and fulfill the blueprint. ${bridgeToNodeId ? 'Bridge the selected earlier path and continuation, treating the later scene as a constraint the ending must fit, never as an event already established.' : 'Use only the selected earlier path, with no later scene.'} Exclude other branches and unspecified future chapters. Use propose_story_changes to propose only this target node's body, preserving its ID, blueprint, chapter source and links. Wait for my approval. Do not change global mainline chapters.`,
    )
    await agent.sendMessage(prompt)
    if (sameProjectSessionContext(projectSessionContextFromProject(useProjectStore.getState().currentProject), session)) await loadStoryWorkspace(key, session, true)
  }
  const remove = () => {
    if (!snapshot) return
    let operations: StoryOperation[] = []
    if (danger === 'node' && node) {
      const removedRoutes = snapshot.routes.filter(item => item.nodeIds.includes(node.id))
      operations = [
        ...snapshot.notes.filter(item => item.nodeId === node.id || removedRoutes.some(removed => removed.id === item.routeId)).map(item => ({ type: 'delete-note' as const, id: item.id })),
        ...removedRoutes.map(item => ({ type: 'delete-route' as const, id: item.id })),
        ...snapshot.edges.filter(item => item.from === node.id || item.to === node.id).map(item => ({ type: 'delete-edge' as const, id: item.id })),
        { type: 'delete-node', id: node.id },
      ]
      selectNode('')
    } else if (danger === 'route' && route) operations = [...snapshot.notes.filter(item => item.routeId === route.id).map(item => ({ type: 'delete-note' as const, id: item.id })), { type: 'delete-route', id: route.id }]
    else if (danger === 'route-path' && routeChange) operations = [...routeChange.noteIds.map(id => ({ type: 'delete-note' as const, id })), { type: 'put-route', route: routeChange.route }]
    else if (danger === 'edge' && edge) {
      if (edgeRoutes.length) { updateStoryWorkspace(key, { error: 'STORY_EDGE_IN_USE' }); setDanger(null); return }
      operations = [{ type: 'delete-edge', id: edge.id }]
    }
    if (danger === 'discard') discardStoryWorkspace(key)
    else stageStoryOperations(key, operations)
    setDanger(null); setRouteChange(null)
  }
  return <section className="story-branches" aria-label={text('剧情分支编辑器', 'Story branch editor')} aria-busy={workspace.busy}>
    <header className="story-workspace-head">
      <div><span className="story-eyebrow"><GitBranch size={14} aria-hidden />{text('分支工作台', 'Story workspace')}</span><p className="story-help">{text('在树上展开故事，点击节点编辑，点击连线设置走向。', 'Grow your story on the tree. Select a scene to write, or a link to edit its direction.')}</p></div>
      <div className="story-toolbar story-save-actions">
      <Button variant="secondary" disabled={disabled || !snapshot} onClick={() => addNode('content')}><Plus size={14} aria-hidden />{text('新增内容节点', 'Add content node')}</Button>
      <Button variant="primary" disabled={disabled || !pending || workspace.reviewRequired || Boolean(sharing.length && !workspace.sharedEditConfirmed)} onClick={save}>{text('保存分支内容', 'Save story changes')}</Button>
      <details className="story-more-actions"><summary>{text('更多', 'More')}</summary><div className="story-form">
      <Button variant="secondary" disabled={workspace.busy} onClick={() => void loadStoryWorkspace(key, session, true)}>{pending ? text('重新读取并保留输入', 'Reload and retain input') : text('刷新分支内容', 'Refresh story')}</Button>
      {pending && <Button variant="text" disabled={workspace.busy} onClick={() => setDanger('discard')}>{text('放弃未保存修改', 'Discard unsaved changes')}</Button>}
      <Button variant="text" disabled={disabled} onClick={() => addNode('branch')}>{text('新增分支点', 'Add branch')}</Button>
      <Button variant="text" disabled={disabled} onClick={() => addNode('merge')}>{text('新增汇合节点', 'Add merge')}</Button>
      <p className="story-help">{text('新增独立节点后，可在树上连接到已有剧情。', 'After adding a separate scene, connect it to the story on the tree.')}</p>
      </div></details>
      <Button variant="icon" aria-label={inspectorOpen ? text('收起详情面板', 'Hide details') : text('展开详情面板', 'Show details')} aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}>{inspectorOpen ? <PanelRightClose size={17} aria-hidden /> : <PanelRightOpen size={17} aria-hidden />}</Button>
      </div>
    </header>
    <div className="story-save-state" role="status" data-dirty={pending}><span />{pending ? text('有未保存修改', 'Unsaved changes') : text('已保存', 'Saved')}{snapshot && <span className="story-counts">{text(`${snapshot.nodes.length} 个节点 · ${snapshot.routes.length} 条路线`, `${snapshot.nodes.length} scenes · ${snapshot.routes.length} routes`)}</span>}</div>
    {workspace.error && <p role="alert" className="story-error">{storyMessage(workspace.error, text)}</p>}
    {workspace.notice && <p role="status">{storyMessage(workspace.notice, text)}</p>}
    {stale && <p role="alert">{storyMessage('STORY_SESSION_STALE', text)}</p>}
    {workspace.reviewRequired && <label className="story-check"><input type="checkbox" onChange={event => { if (event.target.checked) updateStoryWorkspace(key, { reviewRequired: false }) }} />{text('我已核对当前版本与保留输入', 'I compared the current version and retained input')}</label>}
    {sharing.length > 0 && <div className="story-shared-warning"><p>{text(`共用内容将影响：${sharing.join('、')}`, `Shared content affects: ${sharing.join(', ')}`)}</p><label className="story-check"><input type="checkbox" checked={workspace.sharedEditConfirmed} disabled={disabled} onChange={event => updateStoryWorkspace(key, { sharedEditConfirmed: event.target.checked })} />{text('确认修改这些路线共用的内容', 'Confirm editing content shared by these routes')}</label></div>}
    {!snapshot ? <p role="status">{text('正在读取分支内容…', 'Loading story…')}</p> : <>
      <nav className="story-route-bar" aria-label={text('选择高亮路线', 'Highlight a route')}>
        <span className="story-route-bar-label">{text('路线', 'Routes')}</span>
        <button type="button" className="story-route-chip" aria-pressed={!route} onClick={() => selectRoute('')}>{text('全图', 'All paths')}</button>
        {[...snapshot.routes].sort((left, right) => left.id.localeCompare(right.id)).map((item, index) => <button type="button" key={item.id} className="story-route-chip" data-route-index={index % 4} aria-pressed={route?.id === item.id} onClick={() => selectRoute(item.id)}><i aria-hidden />{item.title}<span>{item.nodeIds.length}</span></button>)}
        <Button variant="text" size="sm" onClick={() => { setSection('routes'); setInspectorOpen(true) }}>{text('管理路线', 'Manage routes')}</Button>
      </nav>
      {route && <nav className="story-route-journey" aria-label={text('当前路线的剧情顺序', 'Scene order on this route')}><strong>{route.title}</strong>{route.nodeIds.map((id, index) => <span key={id}>{index > 0 && <ChevronRight size={13} aria-hidden />}<button type="button" aria-current={node?.id === id ? 'step' : undefined} onClick={() => selectNode(id)}>{snapshot.nodes.find(item => item.id === id)?.title ?? text('节点已移除', 'Removed scene')}</button></span>)}</nav>}
      <div className={`story-editor-layout${inspectorOpen ? '' : ' is-inspector-closed'}`}>
      <div className="story-tree-main">
        <StoryTreeCanvas snapshot={snapshot} selectedNodeId={workspace.selectedNodeId} selectedEdgeId={workspace.selectedEdgeId} selectedRouteId={workspace.selectedRouteId} disabled={disabled}
          onSelectNode={selectNode} onSelectEdge={selectEdge} onAddChild={continueFrom} onFork={forkFrom} onMerge={beginMerge}
          onConnect={(from, to) => { const plan = planConnect(snapshot, from, to, text('继续', 'Continue')); applyPlan(plan); if (!plan.error) updateStoryWorkspace(key, { bridgeToNodeId: to,
            continuationSelections: { ...workspace.continuationSelections, [continuationKey(from, route?.id ?? '')]: to },
          }) }} onCreateRoot={() => addNode('content')} />
        <p className="story-help story-tree-hint">{text('先选节点，再用节点下方的快捷操作展开故事。连线上的文字可以直接编辑；新分支不会复制或覆盖已有正文。', 'Select a scene to reveal actions. Select a link label to edit it. New branches keep existing manuscripts intact.')}</p>
      </div>
      {inspectorOpen && <aside className="story-inspector" aria-label={text('剧情详情面板', 'Story details')}>
      <header className="story-inspector-head"><div><span className="story-eyebrow">{text('详情', 'Details')}</span><h2>{section === 'edges' ? edge?.label ?? text('连接走向', 'Story links') : section === 'routes' ? route?.title ?? text('路线管理', 'Routes') : node?.title ?? text('选择一个节点', 'Select a scene')}</h2></div><span className="story-kind-label">{node?.kind === 'branch' ? text('分支点', 'Branch') : node?.kind === 'merge' ? text('汇合', 'Merge') : node ? text('正文', 'Content') : ''}</span></header>
      <div className="story-inspector-body">
      <div className="story-selection">
        <label>{text('当前节点', 'Current node')}<select aria-label={text('当前节点', 'Current node')} value={node?.id ?? ''} onChange={event => selectNode(event.target.value)}><option value="">{text('选择节点', 'Choose node')}</option>{snapshot.nodes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <label>{text('当前路线', 'Current route')}<select aria-label={text('当前路线', 'Current route')} value={route?.id ?? ''} onChange={event => selectRoute(event.target.value)}><option value="">{text('选择路线', 'Choose route')}</option>{snapshot.routes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      </div>
      {mergeSources.length > 0 && <section className="story-merge-composer" aria-label={text('建立汇合', 'Create a merge')}>
        <h3>{text('哪些剧情在这里汇合？', 'Which scenes converge here?')}</h3>
        <p className="story-help">{text('选择至少两个入口。原有正文保留，路线终点会接到新的汇合节点。', 'Choose at least two entrances. Keep their manuscripts and continue ending routes into a new merge.')}</p>
        <div className="story-merge-candidates">{snapshot.nodes.map(item => <label className="story-check" key={item.id}><input type="checkbox" disabled={disabled} checked={mergeSources.includes(item.id)} onChange={event => setMergeSources(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />{item.title}</label>)}</div>
        <label>{text('汇合标题', 'Merge title')}<input aria-label={text('汇合标题', 'Merge title')} disabled={disabled} value={mergeTitle} onChange={event => setMergeTitle(event.target.value)} /></label>
        <div className="story-toolbar"><Button variant="primary" disabled={disabled || mergeSources.length < 2 || !mergeTitle.trim()} onClick={createMerge}>{text('建立汇合', 'Create merge')}</Button><Button variant="text" onClick={() => setMergeSources([])}>{text('取消汇合', 'Cancel merge')}</Button></div>
      </section>}
      <SegmentedControl<Section> label={text('分支编辑内容', 'Story editing sections')} value={section} onChange={setSection} options={[
        { value: 'blueprint', label: text('章节蓝图', 'Blueprint') }, { value: 'node', label: text('正文与事件', 'Content') }, { value: 'edges', label: text('连接', 'Links') }, { value: 'routes', label: text('路线', 'Routes') }, { value: 'continuity', label: text('前情', 'Continuity') }, { value: 'history', label: text('历史', 'History') },
      ]} />
      {section === 'blueprint' && (node ? <StoryChapterBlueprintEditor key={node.id} node={node} disabled={disabled} pending={pending} generating={generating}
        models={models} modelId={selectedModelId} onModelChange={setGenerationModelId} canGenerate={Boolean(contextRequest)}
        onChange={(chapterBlueprint: StoryChapterBlueprint) => changeNode({ chapterBlueprint, title: chapterBlueprint.title || node.title })}
        continuationTargets={snapshot.nodes.filter(item => snapshot.edges.some(edge => edge.from === node.id && edge.to === item.id))} bridgeToNodeId={bridgeToNodeId}
        onBridgeChange={id => updateStoryWorkspace(key, { bridgeToNodeId: id, context: null,
          continuationSelections: { ...workspace.continuationSelections, [continuationKey(node.id, route?.id ?? '')]: id } })}
        onGenerate={() => void generateChapter().catch(() => updateStoryWorkspace(key, { error: text('章节生成未完成，请在助手中查看结果或错误。', 'Chapter generation did not finish. Check the assistant for its result or error.') }))}
        onReview={() => void generateChapter('review').catch(() => updateStoryWorkspace(key, { error: text('衔接审稿未完成，请在助手中查看结果或错误。', 'Continuity review did not finish. Check the assistant for its result or error.') }))}
        onShowManuscript={() => setSection('node')} /> : <p className="story-help">{text('选择树上的节点，或从章节蓝图中建立分支，开始规划这一章。', 'Select a scene, or start a branch from a chapter blueprint to plan this chapter.')}</p>)}
      {section === 'node' && (node ? <fieldset className="story-form" disabled={disabled}>
        <legend>{text('节点内容', 'Node content')}</legend>
        <label>{text('节点标题', 'Node title')}<input aria-label={text('节点标题', 'Node title')} value={node.title} onChange={event => changeNode({ title: event.target.value })} /></label>
        <div className="story-selection"><label>{text('节点类型', 'Node kind')}<select aria-label={text('节点类型', 'Node kind')} value={node.kind} onChange={event => changeNode({ kind: event.target.value as StoryNode['kind'] })}><option value="content">{text('内容', 'Content')}</option><option value="branch">{text('分支点', 'Branch')}</option><option value="merge">{text('汇合', 'Merge')}</option></select></label>
          <label>{text('所属章节（可空）', 'Chapter (optional)')}<input type="number" min={1} step={1} value={node.chapterNumber ?? ''} onChange={event => changeNode({ chapterNumber: event.target.value ? Number(event.target.value) : null })} /></label></div>
        <label>{node.kind === 'branch' ? text('分叉原因与事件', 'Branch reason and event') : text('事件描述', 'Event description')}<textarea aria-label={node.kind === 'branch' ? text('分叉原因与事件', 'Branch reason and event') : text('事件描述', 'Event description')} rows={3} value={node.event} onChange={event => changeNode({ event: event.target.value })} /></label>
        <label>{text('节点正文', 'Node manuscript')}<textarea aria-label={text('节点正文', 'Node manuscript')} className="story-manuscript" rows={12} value={node.body} onChange={event => changeNode({ body: event.target.value })} /></label>
        {workspace.reviewRequired && savedNode && <details open><summary>{text('当前保存版本（用于核对）', 'Current saved version for comparison')}</summary><pre>{savedNode.title}{'\n'}{savedNode.event}{'\n'}{savedNode.body}</pre></details>}
        <p className="story-help">{text('节点正文独立于章节草稿保存；章节编号用于整理，不会覆盖章节定稿。', 'Node manuscripts are stored separately from chapter drafts. Chapter numbers organize nodes and do not overwrite chapter finals.')}</p>
        <Button variant="danger" onClick={() => setDanger('node')}>{text('删除当前节点', 'Delete current node')}</Button>
      </fieldset> : <p>{text('选择或新增一个节点来编辑正文。', 'Choose or add a node to edit its manuscript.')}</p>)}
      {section === 'edges' && <div className="story-form">
        <Button variant="secondary" disabled={disabled || snapshot.nodes.length < 2} onClick={addEdge}>{text('新增连接', 'Add link')}</Button>
        <label>{text('当前连接', 'Current link')}<select value={edge?.id ?? ''} onChange={event => updateStoryWorkspace(key, { selectedEdgeId: event.target.value })}><option value="">{text('选择连接', 'Choose link')}</option>{snapshot.edges.map(item => <option key={item.id} value={item.id}>{snapshot.nodes.find(part => part.id === item.from)?.title} → {snapshot.nodes.find(part => part.id === item.to)?.title} · {item.label}</option>)}</select></label>
        {edge && <fieldset className="story-form" disabled={disabled}><legend>{text('编辑连接', 'Edit link')}</legend><div className="story-selection">
          <label>{text('连接起点', 'Link start')}<select disabled={edgeRoutes.length > 0} value={edge.from} onChange={event => changeEdge({ from: event.target.value })}>{snapshot.nodes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <label>{text('连接目标', 'Link destination')}<select disabled={edgeRoutes.length > 0} value={edge.to} onChange={event => changeEdge({ to: event.target.value })}>{snapshot.nodes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        </div><label>{text('走向名称', 'Direction label')}<input value={edge.label} onChange={event => changeEdge({ label: event.target.value })} /></label><label>{text('自然语言条件', 'Condition in natural language')}<textarea rows={3} value={edge.condition} onChange={event => changeEdge({ condition: event.target.value })} /></label>{edgeRoutes.length > 0 && <p className="story-help">{text(`这条连接用于：${edgeRoutes.map(item => item.title).join('、')}。修改端点或删除前，请先缩短或调整这些路线。`, `Used by: ${edgeRoutes.map(item => item.title).join(', ')}. Shorten or update those routes before changing endpoints or removing this link.`)}</p>}<Button variant="danger" disabled={edgeRoutes.length > 0} onClick={() => setDanger('edge')}>{text('删除当前连接', 'Delete current link')}</Button></fieldset>}
      </div>}
      {section === 'routes' && <div className="story-form">
        <Button variant="secondary" disabled={disabled || !snapshot.nodes.length} onClick={addRoute}>{text('新增路线', 'Add route')}</Button>
        {route && <fieldset className="story-form" disabled={disabled}><legend>{text('编辑路线', 'Edit route')}</legend><label>{text('路线名称', 'Route title')}<input value={route.title} onChange={event => changeRoute({ title: event.target.value })} /></label>
          <ol className="story-route-list">{route.nodeIds.map((id, index) => <li key={`${id}:${index}`}><button type="button" className="story-route-stop" onClick={() => selectNode(id)}>{snapshot.nodes.find(item => item.id === id)?.title ?? text('节点已移除', 'Removed node')}</button>{index < route.nodeIds.length - 1 && <Button variant="text" size="sm" aria-label={text(`将路线缩短到第 ${index + 1} 个节点`, `End route at scene ${index + 1}`)} onClick={() => changeRoute({ nodeIds: route.nodeIds.slice(0, index + 1) })}>{text('以此为终点', 'End here')}</Button>}</li>)}</ol>
          <label>{text('追加路线节点', 'Append route node')}<select value={routeNode} onChange={event => setRouteNode(event.target.value)}><option value="">{text('选择已连接的后续节点', 'Choose a linked next scene')}</option>{snapshot.nodes.filter(item => !route.nodeIds.includes(item.id) && snapshot.edges.some(edge => edge.from === route.nodeIds.at(-1) && edge.to === item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <Button variant="secondary" disabled={!routeNode} onClick={() => { changeRoute({ nodeIds: [...route.nodeIds, routeNode] }); setRouteNode('') }}>{text('追加到路线', 'Append to route')}</Button>
          <p className="story-help">{text('路线顺着连线前进。可缩短到某个节点，再追加已连接的后续；在树上“分叉”会自动建立新路线。', 'Routes follow existing links. Shorten to a scene, then append a linked next scene. Forking on the tree creates new routes automatically.')}</p>
          <Button variant="danger" onClick={() => setDanger('route')}>{text('删除当前路线', 'Delete current route')}</Button>
        </fieldset>}
      </div>}
      {section === 'continuity' && <div className="story-form">
        <label>{text('写作上下文', 'Writing context')}<select aria-label={text('写作上下文', 'Writing context')} value={workspace.mode} onChange={event => updateStoryWorkspace(key, { mode: event.target.value as 'route' | 'shared', context: null })}><option value="route">{text('沿当前路线写作', 'Write along the selected route')}</option><option value="shared">{text('汇合后的共用写作', 'Write shared content after a merge')}</option></select></label>
        {graphPending && <p role="status">{text('先保存分支修改，再读取并确认前情。', 'Save story changes before reading and confirming continuity.')}</p>}
        {node && workspace.mode === 'route' && route && !route.nodeIds.includes(node.id) && <p role="status">{text('当前路线不经过这个节点，请先切换路线。', 'This scene is not on the selected route. Choose another route first.')}</p>}
        <Button variant="secondary" disabled={disabled || graphPending || !contextRequest} onClick={loadContext}>{text('读取当前前情', 'Read current continuity')}</Button>
        <Button variant="secondary" disabled={disabled || generating || pending || !contextRequest} onClick={() => void prepareAssistant()}>{text('让助手帮助写作', 'Prepare assistant writing')}</Button>
        {workspace.context && <StoryContinuity key={`${workspace.context.sourceHash}:${workspace.context.contextHash}:${workspace.mode}:${workspace.selectedRouteId}`} context={workspace.context} workspaceKey={key} disabled={disabled} />}
      </div>}
      {section === 'history' && <div className="story-form">
        <label>{text('节点历史版本', 'Node history version')}<select value={historyId} onChange={event => setHistoryId(event.target.value)}><option value="">{text('选择历史版本', 'Choose history version')}</option>{snapshot.revisions.filter(item => !node || item.nodeId === node.id).map(item => <option key={item.id} value={item.id}>{text('记录', 'Record')} {item.id.slice(0, 8)} · {item.node.title}{item.id === node?.revisionId ? text('（当前）', ' (current)') : ''}</option>)}</select></label>
        {snapshot.revisions.filter(item => item.id === historyId).map(revision => <div key={revision.id}><h3>{revision.node.title}</h3><pre>{revision.node.event}{'\n'}{revision.node.body}</pre><Button variant="secondary" disabled={disabled} onClick={() => { stageStoryOperations(key, [{ type: 'restore-node', id: revision.nodeId, revisionId: revision.id }]); setSection('node'); selectNode(revision.nodeId) }}>{text('恢复为新的当前版本', 'Restore as a new current version')}</Button></div>)}
        <p className="story-help">{text('选择节点可筛选历史，未选择时显示全部记录。恢复会新增版本，保留原记录；共用节点仍需核对影响路线。', 'Select a node to filter history, or leave it empty to see every record. Restoring creates a new version and keeps existing records; shared nodes still require confirmation of affected routes.')}</p>
      </div>}
      </div>
      </aside>}
      </div>
    </>}
    <DangerConfirm open={danger !== null} onOpenChange={open => { if (!open) { setDanger(null); setRouteChange(null) } }} title={danger === 'discard' ? text('放弃分支修改？', 'Discard story changes?') : danger === 'route-path' ? text('缩短路线并移除关联前情？', 'Shorten this route and remove continuity?') : text('删除所选内容？', 'Delete selected content?')}
      consequence={danger === 'node' && snapshot && node ? text(`将删除「${node.title}」以及经过它的 ${snapshot.routes.filter(item => item.nodeIds.includes(node.id)).length} 条路线、关联连接和前情。`, `Deletes “${node.title}”, its ${snapshot.routes.filter(item => item.nodeIds.includes(node.id)).length} routes, links and continuity notes.`) : danger === 'route' ? text('将删除这条路线和它的前情记录，节点正文仍保留。', 'Deletes this route and its continuity notes; node manuscripts remain.') : danger === 'route-path' ? text(`新路线不再经过后面的节点，将移除它们在这条路线上的 ${routeChange?.noteIds.length ?? 0} 份前情记录。所有节点正文和其他路线保留。`, `The shorter route removes ${routeChange?.noteIds.length ?? 0} continuity notes for scenes no longer on this path. All manuscripts and other routes remain.`) : danger === 'edge' ? text('将删除这个连接。', 'Deletes this link.') : text('未保存的分支输入会被丢弃。', 'Unsaved story input will be discarded.')}
      recoverability={text('保存前可使用“放弃未保存修改”还原；已保存的节点正文版本仍留在历史中。', 'Before saving, discard pending changes to restore the saved state. Saved node manuscript versions remain in history.')}
      confirmLabel={text('确认', 'Confirm')} cancelLabel={text('继续编辑', 'Keep editing')} onConfirm={remove} />
  </section>
}

export function StoryContinuity({ context, workspaceKey, disabled }: { context: StoryContext; workspaceKey: string; disabled: boolean }) {
  const text = useLocaleStore(state => state.text)
  const existing = context.note
  const workspace = getStoryWorkspace(workspaceKey)
  const retained = workspace && storyPreview(workspace)?.notes.find(note => note.nodeId === context.request.nodeId && note.routeId === context.request.routeId)
  const initial = retained ?? existing
  const [summary, setSummary] = useState(initial?.summary ?? '')
  const [characterStates, setCharacterStates] = useState(initial?.characterStates ?? '')
  const [differences, setDifferences] = useState(initial?.entryDifferences ?? '')
  const [confirmed, setConfirmed] = useState(Boolean(initial?.confirmed && initial.sourceHash === context.sourceHash))
  const [noteId] = useState(initial?.id ?? crypto.randomUUID())
  const shared = context.request.mode === 'shared'
  const stageNote = (delta: Partial<Pick<StoryNoteInput, 'summary' | 'characterStates' | 'entryDifferences'>> = {}, confirm = false) => {
    const note: StoryNoteInput = { id: noteId, routeId: context.request.routeId, nodeId: context.request.nodeId, summary, characterStates, entryDifferences: differences, ...delta }
    stageStoryOperations(workspaceKey, [{ type: 'put-note', note, expectedSourceHash: context.sourceHash, confirm }])
  }
  return <div className="story-form">
    <p>{context.readyForGeneration ? text('当前前情可用于这次写作。', 'Current continuity is ready for this writing context.') : !shared
      ? text('此正文由前情不同的路线共用。请选择“汇合后的共用写作”，核对共同事实与入口差异。', 'This manuscript is shared by routes with different earlier events. Choose shared writing and review common facts and entrance differences.')
      : text('共同前情尚未确认或来源已变化。请核对、确认并保存后再用于共用写作。', 'Common continuity is unconfirmed or its sources changed. Review, confirm and save before shared writing.')}</p>
    {existing && !context.noteCurrent && <p role="alert">{text('这份前情尚未确认或来源已变化，原内容保留供核对。', 'This continuity note is unconfirmed or its sources changed. Its original text is retained for comparison.')}</p>}
    <details open><summary>{shared ? text('所有入口与共同前缀', 'Entrances and common prefix') : text('当前路线此前内容', 'Earlier content on this route')}</summary>
      <ol>{context.prefix.map(item => <li key={item.id}><strong>{item.title}</strong><p>{item.event}</p><pre>{item.body}</pre></li>)}</ol>
      {shared && <ul>{context.entrances.map(entrance => <li key={entrance.routeId}>{entrance.title}</li>)}</ul>}
    </details>
    {context.continuation && <details open className="story-continuation"><summary>{text('待衔接的后文（未来约束）', 'Later scene to connect to (future constraint)')}</summary><strong>{context.continuation.node.title}</strong><p>{context.continuation.node.event}</p><pre>{context.continuation.node.body || context.continuation.node.chapterBlueprint?.keyEvents || text('暂无正文，按已保存蓝图衔接。', 'No prose yet; connect to the saved blueprint.')}</pre><p className="story-help">{text('这一段只用于衔接目标，不会合并进前情摘要，也不会被视为已经发生。', 'Used only as a later constraint. It is excluded from the earlier summary and is not treated as already established.')}</p></details>}
    <fieldset className="story-form" disabled={disabled}>
      <legend>{shared ? text('作者确认的共同前情', 'Author-confirmed common continuity') : text('这条路线的前情', 'Continuity for this route')}</legend>
      <label>{shared ? text('共同事实摘要', 'Common facts summary') : text('前情摘要', 'Continuity summary')}<textarea aria-label={shared ? text('共同事实摘要', 'Common facts summary') : text('前情摘要', 'Continuity summary')} rows={4} value={summary} onChange={event => { setSummary(event.target.value); setConfirmed(false); stageNote({ summary: event.target.value }) }} /></label>
      <label>{text('人物动态状态', 'Character dynamic states')}<textarea aria-label={text('人物动态状态', 'Character dynamic states')} rows={3} value={characterStates} onChange={event => { setCharacterStates(event.target.value); setConfirmed(false); stageNote({ characterStates: event.target.value }) }} /></label>
      <label>{text('入口差异说明', 'Entrance differences')}<textarea aria-label={text('入口差异说明', 'Entrance differences')} rows={3} value={differences} onChange={event => { setDifferences(event.target.value); setConfirmed(false); stageNote({ entryDifferences: event.target.value }) }} /></label>
      <label className="story-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{text('我已核对这些事实、状态与入口差异', 'I checked these facts, states and entrance differences')}</label>
      <Button variant="secondary" disabled={!confirmed} onClick={() => stageNote({}, true)}>{text('确认这份前情', 'Confirm this continuity')}</Button>
      <p className="story-help">{text('前情输入会随分支内容一起保存；未确认的记录不会用于共用写作。', 'Continuity input is saved with story changes. Unconfirmed notes are excluded from shared writing.')}</p>
    </fieldset>
  </div>
}
