import { useState } from 'react'
import type { StorySnapshot } from '../../shared/story-branches'
import { useLocaleStore } from '../../stores/locale-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { DangerConfirm } from '../ui/DangerConfirm'
import { planDeleteStoryBlueprint, planDeleteStoryChapter, storyChapterHasManuscript } from './story-chapter-deletion'
import { affectedStoryRoutes, getStoryWorkspace, nodeInput, saveStoryWorkspace, stageStoryOperations, storyPreview, updateStoryWorkspace } from './story-workspace'

interface DeleteRequest { nodeId: string; kind: 'blueprint' | 'chapter'; title: string; nodeValue: string; editVersion: number; revision: string; hasManuscript: boolean; routes: string[]; pending: boolean }

export function useStoryChapterDeletion({ workspaceKey, snapshot, onDeleteMainline }: {
  workspaceKey: string; snapshot: StorySnapshot | null; onDeleteMainline(chapterNumber: number): void
}) {
  const text = useLocaleStore(state => state.text)
  const [request, setRequest] = useState<DeleteRequest | null>(null)
  const canDeleteNode = (id: string) => {
    const node = snapshot?.nodes.find(node => node.id === id)
    return Boolean(node && (!node.mainline || node.mainline.hasBlueprint))
  }
  const ask = (nodeId: string, kind: 'blueprint' | 'chapter') => {
    const node = snapshot?.nodes.find(node => node.id === nodeId), workspace = getStoryWorkspace(workspaceKey)
    if (!node || !snapshot || !workspace || workspace.busy || !isProjectSessionCurrent(workspace.session)) return
    if (node.mainline) { if (node.mainline.hasBlueprint) onDeleteMainline(node.mainline.chapterNumber); return }
    if (workspace.reviewRequired) { updateStoryWorkspace(workspaceKey, { error: 'STORY_REVIEW_REQUIRED' }); return }
    setRequest({ nodeId, kind, title: node.title, nodeValue: JSON.stringify(nodeInput(node)), editVersion: workspace.editVersion,
      revision: snapshot.revision, hasManuscript: storyChapterHasManuscript(snapshot, node),
      routes: [...new Set([...snapshot.routes.filter(route => route.nodeIds.includes(nodeId)).map(route => route.title), ...affectedStoryRoutes(workspace)])],
      pending: workspace.pending.length > 0,
    })
  }
  const confirm = async () => {
    if (!request) return
    const workspace = getStoryWorkspace(workspaceKey), current = workspace && storyPreview(workspace)
    const node = current?.nodes.find(node => node.id === request.nodeId)
    if (!workspace || workspace.busy || !current || !node || !isProjectSessionCurrent(workspace.session)) return
    if (workspace.editVersion !== request.editVersion || current.revision !== request.revision || JSON.stringify(nodeInput(node)) !== request.nodeValue) {
      updateStoryWorkspace(workspaceKey, { error: text('章节或连接已变化，请重新核对后删除。', 'The chapter or its links changed. Review it again before deleting.') }); return
    }
    const plan = request.kind === 'blueprint' ? planDeleteStoryBlueprint(current, node.id) : planDeleteStoryChapter(current, node.id)
    if (plan.error) { updateStoryWorkspace(workspaceKey, { error: plan.error }); return }
    stageStoryOperations(workspaceKey, plan.operations)
    updateStoryWorkspace(workspaceKey, { sharedEditConfirmed: true, context: null,
      ...(plan.selectedNodeId !== undefined ? { selectedNodeId: plan.selectedNodeId } : {}),
      ...(plan.selectedRouteId !== undefined ? { selectedRouteId: plan.selectedRouteId } : {}), selectedEdgeId: '',
    })
    try {
      await saveStoryWorkspace(workspaceKey)
      updateStoryWorkspace(workspaceKey, { notice: request.kind === 'blueprint' && request.hasManuscript
        ? text('蓝图已删除，正文与章节保留。', 'Blueprint deleted. Manuscript and chapter retained.')
        : text('章节已删除，其他章节与历史保留。', 'Chapter deleted. Other chapters and history retained.') })
    } catch { /* The workspace retains failed operations and shows the precise error. */ }
  }
  const deletingChapter = request?.kind === 'chapter' || request && !request.hasManuscript
  const dialog = <DangerConfirm open={request !== null} onOpenChange={open => { if (!open) setRequest(null) }}
    title={deletingChapter ? text('删除这个分支章节？', 'Delete this branch chapter?') : text('删除这份分支蓝图？', 'Delete this branch blueprint?')}
    consequence={(deletingChapter
      ? text(`将删除「${request?.title ?? ''}」及其连接。保留其他章节，经过它的路线会连接前后章节；只剩主线的重复路线会移除。`, `Delete “${request?.title ?? ''}” and its links. Keep other chapters and connect their surviving paths. Routes containing only mainline chapters are removed.`)
      : text(`只删除「${request?.title ?? ''}」的蓝图字段，原正文和章节连接保留。`, `Delete only the blueprint for “${request?.title ?? ''}”. Keep its manuscript and chapter links.`))
      + (request?.routes.length ? text(` 影响路线：${request.routes.join('、')}。`, ` Affected routes: ${request.routes.join(', ')}.`) : '')
      + (request?.pending ? text(' 当前未保存的分支修改也会一起保存。', ' Current unsaved story changes are saved together.') : '')}
    recoverability={text('已保存的章节版本历史仍保留；请核对后确认。', 'Saved chapter history remains. Review before confirming.')}
    confirmLabel={text('删除并保存', 'Delete and save')} cancelLabel={text('取消', 'Cancel')} onConfirm={() => void confirm()} />
  return { canDeleteNode, requestDeleteNode: (id: string) => ask(id, 'chapter'), requestDeleteBlueprint: (id: string) => ask(id, 'blueprint'), dialog }
}
