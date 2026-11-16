import { useState } from 'react'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { StoryNode, StoryOperation } from '../../shared/story-branches'
import { MAINLINE_STORY_ROUTE_ID } from '../../shared/story-branches'
import { useLocaleStore } from '../../stores/locale-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { Button } from '../ui/Button'
import { DangerConfirm } from '../ui/DangerConfirm'
import { StoryContinuity } from './StoryBranches'
import { readStoryContext, stageStoryOperations, storyPreview, updateStoryWorkspace, useStoryWorkspaces } from './story-workspace'
import { useStoryChapterDeletion } from './use-story-chapter-deletion'

/** Preserve author route/continuity/history management inside the chapter-blueprint surface. */
export default function StoryRouteManager({ session, node, workspaceKey }: { session: ProjectSessionContext; node: StoryNode; workspaceKey: string }) {
  const text = useLocaleStore(state => state.text)
  const workspace = useStoryWorkspaces(state => state.entries[workspaceKey])
  const [danger, setDanger] = useState<'route' | null>(null)
  const [revisionId, setRevisionId] = useState('')
  const snapshot = workspace ? storyPreview(workspace) : null
  const deletion = useStoryChapterDeletion({ workspaceKey, snapshot, onDeleteMainline: () => {} })
  if (!workspace || node.mainline) return null
  if (!snapshot) return null
  const route = snapshot.routes.find(item => item.id === workspace.selectedRouteId)
  const versions = snapshot.revisions.filter(item => item.nodeId === node.id)
  const revision = versions.find(item => item.id === revisionId)
  const disabled = workspace.busy || !isProjectSessionCurrent(session)
  const entrances = snapshot.routes.flatMap(item => {
    const offset = item.nodeIds.indexOf(node.id)
    return offset >= 0 ? [JSON.stringify(item.nodeIds.slice(0, offset))] : []
  })
  const shared = new Set(entrances).size > 1
  const context = workspace.context?.target.id === node.id ? workspace.context : null
  const inspectContext = () => {
    const bridge = snapshot.edges.some(edge => edge.from === node.id && edge.to === workspace.bridgeToNodeId) ? workspace.bridgeToNodeId : ''
    void readStoryContext(workspaceKey, { nodeId: node.id, routeId: workspace.mode === 'shared' ? null : route?.id ?? null, mode: workspace.mode,
      ...(bridge ? { bridgeToNodeId: bridge } : {}),
    })
  }
  const remove = () => {
    const removedRoutes = route ? [route] : []
    const operations: StoryOperation[] = [
      ...snapshot.notes.filter(note => removedRoutes.some(item => item.id === note.routeId)).map(note => ({ type: 'delete-note' as const, id: note.id })),
      ...removedRoutes.filter(item => item.id !== MAINLINE_STORY_ROUTE_ID).map(item => ({ type: 'delete-route' as const, id: item.id })),
    ]
    stageStoryOperations(workspaceKey, operations)
    updateStoryWorkspace(workspaceKey, { selectedRouteId: MAINLINE_STORY_ROUTE_ID, context: null })
    setDanger(null)
  }
  return <details className="chapter-tree-management"><summary>{text('路线、前情与版本管理', 'Routes, continuity and versions')}</summary>
    {route && route.id !== MAINLINE_STORY_ROUTE_ID && <section className="chapter-tree-edge-editor"><h3>{text('当前路线', 'Current route')}</h3>
      <label>{text('路线名称', 'Route name')}<input aria-label={text('路线名称', 'Route name')} value={route.title} disabled={disabled} onChange={event => stageStoryOperations(workspaceKey, [{ type: 'put-route', route: { ...route, title: event.target.value } }])} /></label>
      <Button variant="text" disabled={disabled} onClick={() => setDanger('route')}>{text('删除这条路线…', 'Delete this route…')}</Button>
    </section>}
    <section className="chapter-tree-edge-editor"><h3>{text('前情衔接', 'Earlier continuity')}</h3>
      {shared && <label>{text('生成依据', 'Writing context')}<select aria-label={text('生成依据', 'Writing context')} value={workspace.mode} disabled={disabled} onChange={event => updateStoryWorkspace(workspaceKey, { mode: event.target.value as 'route' | 'shared', context: null })}><option value="route">{text('当前路线前情', 'Current route')}</option><option value="shared">{text('各路线共用前情', 'Common continuity')}</option></select></label>}
      <Button variant="secondary" disabled={disabled || workspace.pending.length > 0 || (!route && workspace.mode !== 'shared')} onClick={inspectContext}>{text('查看并核对前情', 'Inspect continuity')}</Button>
      {context && <StoryContinuity key={`${node.id}:${context.request.mode}:${context.request.routeId ?? ''}:${context.sourceHash}`} context={context} workspaceKey={workspaceKey} disabled={disabled} />}
    </section>
    <section className="chapter-tree-edge-editor"><h3>{text('章节历史版本', 'Chapter versions')}</h3>
      <select aria-label={text('章节历史版本', 'Chapter versions')} value={revisionId} onChange={event => setRevisionId(event.target.value)}><option value="">{text('选择已保存版本', 'Choose a saved version')}</option>{versions.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.node.title}{item.id === node.revisionId ? text('（当前）', ' (current)') : ''}</option>)}</select>
      {revision && <><pre className="story-version-preview">{revision.node.body || text('此版本尚无正文', 'This version has no manuscript')}</pre><Button variant="secondary" disabled={disabled || revision.id === node.revisionId} onClick={() => stageStoryOperations(workspaceKey, [{ type: 'restore-node', id: node.id, revisionId: revision.id }])}>{text('恢复此版本为待保存稿', 'Restore version as pending draft')}</Button></>}
      <Button variant="text" disabled={disabled} onClick={() => deletion.requestDeleteNode(node.id)}>{text('删除这个分支章节…', 'Delete branch chapter…')}</Button>
    </section>
    {deletion.dialog}
    <DangerConfirm open={danger !== null} onOpenChange={open => { if (!open) setDanger(null) }} title={text('删除这条路线？', 'Delete this route?')}
      consequence={text('移除路线及其前情记录，章节正文保留。保存后生效。', 'Remove this route and its continuity notes. Manuscripts remain. Takes effect after saving.')}
      recoverability={text('保存前可放弃分支修改。已保存的正文版本历史保留。', 'Discard pending story changes before saving to undo. Saved manuscript history remains.')}
      confirmLabel={text('确认移除', 'Confirm removal')} cancelLabel={text('取消', 'Cancel')} onConfirm={remove} />
  </details>
}
