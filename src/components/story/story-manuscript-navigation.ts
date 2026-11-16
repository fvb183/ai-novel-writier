import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { isMainlineStoryNodeId, resolveStoryNodeAlias } from '../../shared/story-branches'
import { useEditorStore } from '../../stores/editor-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { isProjectSessionCurrent } from '../project-session-gate'
import { ensureStoryWorkspace, getStoryWorkspace, resolveStoryWorkspaceRouteId, storyPreview, updateStoryWorkspace } from './story-workspace'

export function openStoryManuscript(session: ProjectSessionContext, nodeId: string, routeId: string): void {
  if (!isProjectSessionCurrent(session)) return
  const key = ensureStoryWorkspace(session), workspace = getStoryWorkspace(key)
  const snapshot = workspace && storyPreview(workspace)
  const node = snapshot && (snapshot.nodes.find(item => item.id === nodeId) ?? snapshot.nodes.find(item => item.id === resolveStoryNodeAlias(snapshot, nodeId)))
  if (!node) return
  nodeId = node.id
  if (snapshot && workspace) routeId = resolveStoryWorkspaceRouteId(workspace, snapshot, nodeId, routeId)
  updateStoryWorkspace(key, { selectedNodeId: nodeId, selectedRouteId: routeId, context: null })
  if (isMainlineStoryNodeId(nodeId)) {
    navigate({ kind: 'chapter', chapterNumber: node.chapterNumber! })
    return
  }
  useEditorStore.getState().openFile({
    id: `story-manuscript:${session.projectId}:${nodeId}:${routeId}`,
    type: 'chapter', name: node.title, projectKey: session.projectPath, projectSessionLease: session.leaseId,
    storyNodeId: nodeId, storyRouteId: routeId,
  })
}

export function openStoryBlueprint(session: ProjectSessionContext, nodeId: string, routeId: string): void {
  if (!isProjectSessionCurrent(session)) return
  const key = ensureStoryWorkspace(session), workspace = getStoryWorkspace(key), snapshot = workspace && storyPreview(workspace)
  updateStoryWorkspace(key, { selectedNodeId: snapshot && !snapshot.nodes.some(node => node.id === nodeId) ? resolveStoryNodeAlias(snapshot, nodeId) : nodeId,
    selectedRouteId: snapshot && workspace ? resolveStoryWorkspaceRouteId(workspace, snapshot, nodeId, routeId) : routeId, context: null })
  // An earlier "open chapter 3 blueprint" request must not override this
  // explicit UUID selection when the existing blueprint tab mounts again.
  useEditorStore.setState(state => ({ tabs: state.tabs.map(tab => tab.type === 'chapter-card' && !tab.planningRecovery && tab.projectKey === session.projectPath
    ? { ...tab, chapterNumber: undefined, chapterSelectRequest: undefined } : tab) }))
  navigate({ kind: 'stage', stage: 'blueprint' })
}
