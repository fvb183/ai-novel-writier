/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from 'react'
import type { ToolCallInfo } from '../../../services/agent/agent-engine'
import { ipc } from '../../../services/ipc-client'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../../shared/project-session-context'
import { prepareStoryProposal, type StoryProposal } from '../../../shared/story-proposal'
import type { StoryContextRequest, StoryNodeInput, StorySnapshot } from '../../../shared/story-branches'

export type StoryProposalPreview = { kind: 'none' | 'loading' | 'invalid' | 'stale'; error?: string }
  | { kind: 'valid'; proposal: StoryProposal; snapshot: StorySnapshot }

export function useStoryProposalPreview(toolCall: ToolCallInfo): StoryProposalPreview {
  const currentProject = useProjectStore(state => state.currentProject)
  const [preview, setPreview] = useState<StoryProposalPreview>({ kind: 'loading' })
  const isStory = toolCall.toolName === 'propose_story_changes'
  const session = toolCall.projectSession
  const current = Boolean(session && sameProjectSessionContext(session, projectSessionContextFromProject(currentProject)))
  useEffect(() => {
    if (!isStory || !session || !current) return
    let alive = true
    setPreview({ kind: 'loading' })
    void (async () => {
      const response = await ipc.invokeWithProjectSession(session, 'story:read', {})
      if (!response.success) throw new Error(response.error)
      const request = (toolCall.arguments.context ?? toolCall.storyContext) as StoryContextRequest | undefined
      const scoped = request ? await ipc.invokeWithProjectSession(session, 'story:context', request) : undefined
      if (scoped && !scoped.success) throw new Error(scoped.error)
      const proposal = prepareStoryProposal(toolCall.arguments, response.data, toolCall.storyContext, scoped?.success ? scoped.data : undefined)
      if (alive) setPreview({ kind: 'valid', proposal, snapshot: response.data })
    })().catch(error => { if (alive) setPreview({ kind: 'invalid', error: error instanceof Error ? error.message : 'STORY_PROPOSAL_INVALID' }) })
    return () => { alive = false }
  }, [isStory, current, session, toolCall.arguments, toolCall.storyContext])
  if (!isStory) return { kind: 'none' }
  if (!current) return { kind: 'stale' }
  return preview
}

const show = (value: unknown) => value === undefined ? '—' : typeof value === 'string' ? value || '—' : JSON.stringify(value, null, 2)
const chapterNode = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) && 'body' in value ? value as StoryNodeInput : undefined
function ChapterBlueprintView({ value, title }: { value?: StoryNodeInput; title: string }) {
  const text = useLocaleStore(state => state.text)
  const blueprint = value?.chapterBlueprint, source = value?.chapterSource
  return <div>
    <strong>{title}</strong>
    {source ? <p>{text(`来源：主线第 ${source.chapterNumber} 章的独立副本`, `Source: independent copy of mainline chapter ${source.chapterNumber}`)}</p> : <p>{text('来源：独立剧情节点，未绑定主线章节', 'Source: standalone story node without a mainline chapter binding')}</p>}
    {blueprint ? <dl style={{ margin: '8px 0', display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '4px 10px', fontSize: 12 }}>
      {([
        ['title', text('蓝图标题', 'Blueprint title')], ['role', text('章节作用', 'Chapter role')], ['purpose', text('写作目的', 'Purpose')],
        ['keyEvents', text('关键事件', 'Key events')], ['characters', text('出场人物', 'Characters')], ['suspenseHook', text('悬念钩子', 'Suspense hook')],
        ['userGuidance', text('作者指导', 'Author guidance')], ['notes', text('备注', 'Notes')],
      ] as const).map(([field, label]) => <div key={field} style={{ display: 'contents' }}><dt>{label}</dt><dd style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{show(field === 'characters' ? blueprint.characters.join('、') : blueprint[field])}</dd></div>)}
    </dl> : <p>{text('没有章节蓝图', 'No chapter blueprint')}</p>}
    {source && <details><summary>{text('来源快照标识', 'Source snapshot identities')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11 }}>{show(source)}</pre></details>}
  </div>
}
export default function StoryProposalDiff({ preview }: { preview: StoryProposalPreview }) {
  const text = useLocaleStore(state => state.text)
  if (preview.kind === 'none') return null
  if (preview.kind === 'loading') return <p>{text('正在读取剧情分支当前值…', 'Loading current story values…')}</p>
  if (preview.kind === 'stale') return <p role="alert">{text('项目会话已变化，此候选不能提交。', 'The project session changed. This candidate cannot be committed.')}</p>
  if (preview.kind === 'invalid') {
    const descriptions: Record<string, [string, string]> = {
      STORY_ROUTE_CONTEXT_REQUIRED: ['请从剧情分支页选中路线和节点，再点击“让助手帮助写作”。新建节点请先留空正文。', 'Select a route and node in the story editor, then choose Prepare assistant writing. Leave new structural nodes’ prose empty first.'],
      STORY_SHARED_CONTEXT_REQUIRED: ['这个节点由不同前情的路线共用，请选择共用写作并确认共同前情。', 'Routes with different histories share this node. Select shared writing and confirm common continuity first.'],
      STORY_CONTEXT_SCOPE_MISMATCH: ['候选指向了另一条路线或节点，请在目标路线重新提出。', 'The candidate targets another route or node. Prepare it again from the intended route.'],
      STORY_AUTHOR_CONFIRMATION_REQUIRED: ['助手不能代作者确认共同前情，请先保存为未确认候选。', 'The assistant cannot confirm common facts for the author. Save an unconfirmed candidate first.'],
      STORY_PROSE_REQUIRES_SEPARATE_PROPOSAL: ['请把单个节点正文或事件修改作为独立提案，以便核对路线前情。', 'Propose one node’s prose or event separately so its route continuity can be checked.'],
      STORY_BLUEPRINT_SEPARATE_PROPOSAL: ['按蓝图生成正文时不能同时改写蓝图。请保留现有蓝图，若要调整计划，请另外提出蓝图修改。', 'Generating prose must preserve its blueprint. Propose plan changes separately.'],
      STORY_CHAPTER_SOURCE_READ_ONLY: ['章节来源由作者导入时确定。助手不能编造、更换或删除这份来源绑定，请保留当前来源。', 'The author’s import establishes the chapter source. The assistant must preserve this binding rather than invent, replace or remove it.'],
      STORY_CHAPTER_PROSE_ONLY: ['章节生成只应修改当前节点正文。请保留节点标题、类型、章节编号和事件；这些内容需要单独调整。', 'Chapter generation should change only the current node’s prose. Keep its title, kind, chapter number and event; propose those changes separately.'],
    }
    const description = descriptions[preview.error ?? '']
    return <p role="alert">{description ? text(...description) : text(`剧情提案不可提交：${preview.error}`, `The story proposal cannot be committed: ${preview.error}`)}</p>
  }
  if (preview.kind !== 'valid') return null
  const { proposal, snapshot } = preview
  return <section aria-label={text('剧情分支变更预览', 'Story change preview')}>
    {proposal.affectsSharedContent && <p role="alert">{text(
      `这会修改共享节点，影响路线：${proposal.affectedRoutes.join('、')}。批准即确认对这些路线一起修改。`,
      `This changes a shared node used by: ${proposal.affectedRoutes.join(', ')}. Approval confirms the change for these routes.`)}</p>}
    {proposal.operations.map((operation, index) => {
      const id = 'id' in operation ? operation.id : 'node' in operation ? operation.node.id : 'edge' in operation ? operation.edge.id : 'route' in operation ? operation.route.id : operation.note.id
      const before = operation.type.includes('node') ? snapshot.nodes.find(row => row.id === id)
        : operation.type.includes('edge') ? snapshot.edges.find(row => row.id === id)
          : operation.type.includes('route') ? snapshot.routes.find(row => row.id === id) : snapshot.notes.find(row => row.id === id)
      const after = operation.type.startsWith('delete-') ? text('删除', 'Delete')
        : operation.type === 'restore-node' ? snapshot.revisions.find(row => row.id === operation.revisionId)?.node
          : 'node' in operation ? operation.node : 'edge' in operation ? operation.edge : 'route' in operation ? operation.route : 'note' in operation ? operation.note : operation
      return <details key={index} open style={{ marginBlock: 8 }}>
        <summary>{operation.type} · {before && 'title' in before ? before.title : id}</summary>
        {(chapterNode(before)?.chapterBlueprint || chapterNode(after)?.chapterBlueprint || chapterNode(before)?.chapterSource || chapterNode(after)?.chapterSource) && <section aria-label={text('章节蓝图及来源对比', 'Chapter blueprint and source comparison')} style={{ marginBlock: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 16 }}>
          <ChapterBlueprintView title={text('当前蓝图与来源', 'Current blueprint and source')} value={chapterNode(before)} />
          <ChapterBlueprintView title={text('候选蓝图与来源', 'Candidate blueprint and source')} value={chapterNode(after)} />
        </section>}
        <div style={{ display: 'grid', gap: 8 }}>
          <div><strong>{text('当前', 'Current')}</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflowY: 'auto' }}>{show(before)}</pre></div>
          <div><strong>{text('候选', 'Candidate')}</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflowY: 'auto' }}>{show(after)}</pre></div>
        </div>
      </details>
    })}
    <p>{text('生成的前情只作为未确认候选保存。请在剧情分支页核对后确认共同事实。', 'Generated continuity is stored as an unconfirmed candidate. Review and confirm common facts in the story editor.')}</p>
  </section>
}
