import { useState } from 'react'
import { BookOpen, Sparkles } from 'lucide-react'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { StoryNode } from '../../shared/story-branches'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../shared/project-session-context'
import { availableGenerationModelId } from '../../services/workflows/chapter-write-launch'
import { useAgentStore } from '../../stores/agent-store'
import { useProjectStore } from '../../stores/project-store'
import { useLLMStore } from '../../stores/llm-store'
import { routeStageModel } from '../../shared/model-stage-routing'
import { useLocaleStore } from '../../stores/locale-store'
import { useStageStore } from '../../stores/navigation/stage-store'
import { Button } from '../ui/Button'
import { loadStoryWorkspace, readStoryContext, storyPreview, updateStoryWorkspace, useStoryWorkspaces } from './story-workspace'

/** The blueprint and manuscript surfaces share one scoped generation action. */
export default function StoryChapterActions({ session, node, workspaceKey, onShowManuscript }: {
  session: ProjectSessionContext
  node: StoryNode
  workspaceKey: string
  onShowManuscript?: () => void
}) {
  const text = useLocaleStore(state => state.text)
  const workspace = useStoryWorkspaces(state => state.entries[workspaceKey])
  const models = useLLMStore(state => state.models)
  const draftingModelId = useLLMStore(state => routeStageModel('drafting', state).modelId)
  const generating = useAgentStore(state => state.generating)
  const [modelChoice, setModelChoice] = useState<string | null>(null)
  if (!workspace) return null
  const snapshot = storyPreview(workspace)
  const route = snapshot?.routes.find(item => item.id === workspace.selectedRouteId)
  const modelId = modelChoice ?? draftingModelId
  const later = snapshot?.edges.filter(edge => edge.from === node.id).map(edge => snapshot.nodes.find(item => item.id === edge.to)).filter((item): item is StoryNode => Boolean(item)) ?? []
  const bridgeToNodeId = later.some(item => item.id === workspace.bridgeToNodeId) ? workspace.bridgeToNodeId : ''
  const valid = workspace.selectedNodeId === node.id && (workspace.mode === 'shared' || Boolean(route?.nodeIds.includes(node.id)))
  const disabled = !sameProjectSessionContext(workspace.session, session) || workspace.busy || workspace.pending.length > 0 || generating || !valid
  const request = { nodeId: node.id, routeId: workspace.mode === 'shared' ? null : route?.id ?? null, mode: workspace.mode,
    ...(bridgeToNodeId ? { bridgeToNodeId } : {}),
  } as const
  const generate = async (review: boolean) => {
    if (disabled) return
    const chosen = availableGenerationModelId(models, modelId)
    if (!chosen) { updateStoryWorkspace(workspaceKey, { error: text('请先选择一个可用的文本生成模型。', 'Select an available text generation model first.') }); return }
    const context = await readStoryContext(workspaceKey, request)
    if (!context) return
    const blueprint = context.target.chapterBlueprint
    if (!review && (!blueprint?.title.trim() || ![blueprint.purpose, blueprint.keyEvents].some(value => value.trim()))) {
      updateStoryWorkspace(workspaceKey, { error: text('先保存蓝图的标题、本章目标或关键事件，再生成正文。', 'Save a blueprint title and a purpose or key events before generating.') }); return
    }
    if (!context.readyForGeneration) { updateStoryWorkspace(workspaceKey, { error: text('请先在共同前情中确认不同路线的衔接。', 'Confirm continuity across the shared routes first.') }); return }
    if (!sameProjectSessionContext(projectSessionContextFromProject(useProjectStore.getState().currentProject), session) || useAgentStore.getState().generating) return
    const agent = useAgentStore.getState()
    agent.createConversation(); agent.setStoryContext(request); agent.setMode('fast'); agent.setModelId(chosen)
    useStageStore.setState({ sheet: { kind: 'assistant' } })
    const target = useProjectStore.getState().currentProject?.novelConfig.wordsPerChapter
    const prompt = review ? text(
      `请审查「${context.target.title}」的衔接一致性。先用 read_story_context 读取 request=${JSON.stringify(request)}，核对父级前文、当前正文${bridgeToNodeId ? '和指定后文' : ''}的人物状态、物品归属、时间线、因果和信息获知。指定后文是未来衔接约束，不是已发生的前情；源章蓝图计划也不能当成已发生事实，存在正文时以正文为准。按“冲突/证据/修改建议”列出问题，区分无法判断与已证实冲突。本次只读审稿，不调用修改提案，不写入正文或蓝图。`,
      `Review continuity for “${context.target.title}”. First read_story_context with request=${JSON.stringify(request)}. Compare character states, ownership, timeline, causality and knowledge in the earlier path, this manuscript${bridgeToNodeId ? ' and the selected later scene' : ''}. Later text is a future constraint, and source chapter plans are not established facts; actual manuscript takes precedence. List conflicts, evidence and suggested edits, distinguishing uncertainty. This is read-only: do not propose or save changes.`,
    ) : text(
      `请按「${context.target.title}」已保存的 chapterBlueprint 逐项生成这一章的完整正文${target ? `，目标约 ${target} 字` : ''}。先用 read_story_context 读取 request=${JSON.stringify(request)}。${bridgeToNodeId ? '同时参考父级前文和指定 continuation 后文，衔接两端；后文只是未来目标，不能当成已发生事实。' : '只参考所选路线的父级前文，不使用后文。'}源章蓝图是计划，有正文以正文为事实，没有正文不能假设计划已实现。不采用其他分支或未指定主线后文。用 propose_story_changes 仅提出目标节点 body 修改，保留 ID、蓝图、章节来源和连接，等待作者批准。不要修改其他主线章节。`,
      `Generate this chapter from every part of “${context.target.title}”'s saved chapterBlueprint${target ? `, aiming for about ${target} words` : ''}. First read_story_context with request=${JSON.stringify(request)}. ${bridgeToNodeId ? 'Bridge the earlier path and selected continuation; later text is a future constraint, never earlier fact.' : 'Use only the selected earlier path, without later text.'} Source blueprints are plans; manuscript takes precedence, and unwritten plans are not established states. Exclude other branches and unspecified later chapters. Propose only this target node's body with propose_story_changes, preserving its ID, blueprint, chapter source and links. Wait for approval. Do not modify other mainline chapters.`,
    )
    await agent.sendMessage(prompt)
    if (sameProjectSessionContext(projectSessionContextFromProject(useProjectStore.getState().currentProject), session)) await loadStoryWorkspace(workspaceKey, session, true)
  }
  return <section className="chapter-tree-actions" aria-label={text('章节写作与衔接', 'Chapter writing and continuity')}>
    <div className="chapter-tree-action-fields">
      <label>{text('写作模型', 'Writing model')}<select aria-label={text('章节写作模型', 'Chapter writing model')} value={modelId ?? ''} onChange={event => setModelChoice(event.target.value)}><option value="">{text('请选择模型', 'Choose a model')}</option>{models.filter(model => availableGenerationModelId(models, model.id)).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      <label>{text('衔接后文', 'Later scene')}<select aria-label={text('衔接后文', 'Later scene')} disabled={workspace.busy} value={bridgeToNodeId} onChange={event => updateStoryWorkspace(workspaceKey, { bridgeToNodeId: event.target.value, context: null, continuationSelections: { ...workspace.continuationSelections, [`${workspace.mode}:${workspace.selectedRouteId}:${node.id}`]: event.target.value } })}><option value="">{text('仅参考前文', 'Earlier text only')}</option>{later.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    </div>
    <div className="chapter-tree-action-buttons">{onShowManuscript && <Button variant="secondary" onClick={onShowManuscript}><BookOpen size={14} aria-hidden />{text('打开正文', 'Open manuscript')}</Button>}<Button variant="primary" disabled={disabled || !node.chapterBlueprint} onClick={() => void generate(false)}><Sparkles size={14} aria-hidden />{text('按蓝图生成正文', 'Generate from blueprint')}</Button><Button variant="secondary" disabled={disabled || !node.body} onClick={() => void generate(true)}>{text('审查衔接', 'Review continuity')}</Button></div>
    <p className="story-help">{text('后文选择只控制本次生成或审稿的上下文，不会更改树上的连接。', 'The later-text choice controls this generation or review context; it does not change tree links.')}</p>
    {workspace.pending.length > 0 && <p>{text('先保存树上的修改，再请求写作或审稿。', 'Save tree changes before writing or reviewing.')}</p>}
  </section>
}
