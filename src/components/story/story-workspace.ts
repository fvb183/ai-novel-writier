import { announceProjectManuallySaved } from '../../services/project-save-events'
import { create } from 'zustand'
import { ipc } from '../../services/ipc-client'
import { registerProjectTransitionDraft } from '../../services/project-transition'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { StoryContext, StoryContextRequest, StoryNode, StoryOperation, StorySnapshot } from '../../shared/story-branches'
import { resolveStoryEdgeAlias, resolveStoryNodeAlias, resolveStoryRouteAlias } from '../../shared/story-branches'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import { globalEventBus } from '../../shared/event-bus'
import { isProjectSessionCurrent } from '../project-session-gate'

export interface StoryWorkspace {
  session: ProjectSessionContext
  snapshot: StorySnapshot | null
  pending: StoryOperation[]
  editVersion: number
  selectedNodeId: string
  selectedEdgeId: string
  selectedRouteId: string
  bridgeToNodeId: string
  continuationSelections: Record<string, string>
  mode: 'route' | 'shared'
  context: StoryContext | null
  busy: boolean
  error: string
  notice: string
  sharedEditConfirmed: boolean
  reviewRequired: boolean
}

const disposers = new Map<string, () => void>()
export const storyWorkspaceKey = (session: ProjectSessionContext) => `${session.projectId}|${session.projectPath.replaceAll('\\', '/')}`
export const useStoryWorkspaces = create<{ entries: Record<string, StoryWorkspace> }>(() => ({ entries: {} }))
export const getStoryWorkspace = (key: string) => useStoryWorkspaces.getState().entries[key]
const guardUnsavedStoryInput = (event: BeforeUnloadEvent) => {
  if (Object.values(useStoryWorkspaces.getState().entries).some(workspace => workspace.pending.length)) {
    event.preventDefault(); event.returnValue = ''
  }
}
export function updateStoryWorkspace(key: string, update: Partial<StoryWorkspace> | ((current: StoryWorkspace) => Partial<StoryWorkspace>)): void {
  const current = getStoryWorkspace(key)
  if (!current) return
  useStoryWorkspaces.setState(state => ({ entries: { ...state.entries, [key]: { ...current, ...(typeof update === 'function' ? update(current) : update) } } }))
}

/** Old source selections follow their chapter. Pending author edits keep their own UUID. */
export function resolveStoryWorkspaceRouteId(workspace: StoryWorkspace, snapshot: StorySnapshot, nodeId: string, routeId: string): string {
  const edited = workspace.pending.some(operation => operation.type === 'put-node' ? operation.node.id === nodeId
    : operation.type === 'restore-node' && operation.id === nodeId)
  return edited ? routeId : resolveStoryRouteAlias(snapshot, routeId)
}

export function reconcileStorySelection(workspace: StoryWorkspace, snapshot: StorySnapshot): Partial<StoryWorkspace> {
  const editedSources = new Set(workspace.pending.flatMap(operation => operation.type === 'put-node' ? [operation.node.id]
    : operation.type === 'restore-node' ? [operation.id] : []))
  const nodeId = (id: string) => editedSources.has(id) ? id : resolveStoryNodeAlias(snapshot, id)
  const selectedRouteId = resolveStoryWorkspaceRouteId(workspace, snapshot, workspace.selectedNodeId, workspace.selectedRouteId)
  const continuationSelections: Record<string, string> = {}
  for (const [key, value] of Object.entries(workspace.continuationSelections)) {
    const parts = /^(route|shared):([^:]*):(.*)$/.exec(key)
    const nextKey = parts ? `${parts[1]}:${resolveStoryWorkspaceRouteId(workspace, snapshot, parts[3], parts[2])}:${nodeId(parts[3])}` : key
    continuationSelections[nextKey] = nodeId(value)
  }
  return { selectedNodeId: nodeId(workspace.selectedNodeId), selectedRouteId,
    selectedEdgeId: resolveStoryEdgeAlias(snapshot, workspace.selectedEdgeId), bridgeToNodeId: nodeId(workspace.bridgeToNodeId), continuationSelections }
}

function fresh(session: ProjectSessionContext): StoryWorkspace {
  return { session, snapshot: null, pending: [], editVersion: 0, selectedNodeId: '', selectedEdgeId: '', selectedRouteId: '', bridgeToNodeId: '', continuationSelections: {}, mode: 'route', context: null, busy: false, error: '', notice: '', sharedEditConfirmed: false, reviewRequired: false }
}

/** Registrations intentionally outlive mounted tabs, so project close/sync can save hidden input. */
export function ensureStoryWorkspace(session: ProjectSessionContext): string {
  const key = storyWorkspaceKey(session), existing = getStoryWorkspace(key)
  if (!existing || (!sameProjectSessionContext(existing.session, session) && !existing.pending.length && !existing.busy)) {
    useStoryWorkspaces.setState(state => ({ entries: { ...state.entries, [key]: fresh(session) } }))
  }
  if (!disposers.size && typeof window !== 'undefined') window.addEventListener('beforeunload', guardUnsavedStoryInput)
  if (!disposers.has(key)) {
    const stopDraft = registerProjectTransitionDraft({
    projectKey: session.projectPath,
    isDirty: () => Boolean(getStoryWorkspace(key)?.pending.length),
    version: () => getStoryWorkspace(key)?.editVersion ?? 0,
    save: () => saveStoryWorkspace(key, false),
    discard: () => discardStoryWorkspace(key),
    })
    let needsRefresh = false
    const refresh = () => {
      const current = getStoryWorkspace(key)
      if (!needsRefresh || !current || current.busy) return
      needsRefresh = false
      if (isProjectSessionCurrent(current.session)) void loadStoryWorkspace(key, current.session, true)
    }
    const stopEvents = globalEventBus.on('STORY_CHANGED', event => {
      const current = getStoryWorkspace(key)
      if (current && sameProjectSessionContext(current.session, event.projectSession)) { needsRefresh = true; refresh() }
    })
    const stopResources = globalEventBus.on('REFRESH_RESOURCE', event => {
      const current = getStoryWorkspace(key)
      if (current && sameProjectSessionContext(current.session, event.projectSession)
        && event.resources.some(resource => ['blueprints', 'drafts', 'all'].includes(resource))) {
        needsRefresh = true; refresh()
      }
    })
    const stopFinalization = globalEventBus.on('FINALIZE_COMPLETE', event => {
      const current = getStoryWorkspace(key)
      if (current && sameProjectSessionContext(current.session, event.projectSession)) { needsRefresh = true; refresh() }
    })
    const stopDeletion = globalEventBus.on('CHAPTER_DELETION_UPDATED', event => {
      const current = getStoryWorkspace(key)
      if (current && sameProjectSessionContext(current.session, event.projectSession)) { needsRefresh = true; refresh() }
    })
    const stopChanges = useStoryWorkspaces.subscribe(refresh)
    disposers.set(key, () => { stopEvents(); stopResources(); stopFinalization(); stopDeletion(); stopChanges(); stopDraft() })
  }
  return key
}

function operationKey(operation: StoryOperation): string {
  if (operation.type === 'put-node') return `node:${operation.node.id}`
  if (operation.type === 'put-edge') return `edge:${operation.edge.id}`
  if (operation.type === 'put-route') return `route:${operation.route.id}`
  if (operation.type === 'put-note') return `note:${operation.note.id}`
  return `${operation.type.split('-')[1]}:${operation.id}`
}

export function stageStoryOperations(key: string, operations: StoryOperation[]): void {
  updateStoryWorkspace(key, current => {
    const pending = [...current.pending]
    for (const operation of operations) {
      const index = pending.findIndex(item => operationKey(item) === operationKey(operation))
      if (index >= 0) pending.splice(index, 1)
      if (operation.type.startsWith('delete-')) {
        const collection = operation.type === 'delete-node' ? current.snapshot?.nodes : operation.type === 'delete-edge' ? current.snapshot?.edges : operation.type === 'delete-route' ? current.snapshot?.routes : current.snapshot?.notes
        if (!collection?.some(item => item.id === (operation as { id: string }).id)) continue
      }
      pending.push(operation)
    }
    return { pending, editVersion: current.editVersion + 1, context: operations.every(operation => operation.type === 'put-note') ? current.context : null, error: '', notice: '', sharedEditConfirmed: false }
  })
}

export function storyPreview(workspace: StoryWorkspace): StorySnapshot | null {
  if (!workspace.snapshot) return null
  const result = structuredClone(workspace.snapshot)
  for (const operation of workspace.pending) {
    if (operation.type === 'put-node') {
      const old = result.nodes.find(node => node.id === operation.node.id)
      result.nodes = [...result.nodes.filter(node => node.id !== operation.node.id), { ...operation.node, revisionId: old?.revisionId ?? '' }]
    } else if (operation.type === 'restore-node') {
      const revision = result.revisions.find(item => item.id === operation.revisionId && item.nodeId === operation.id)
      if (revision) result.nodes = [...result.nodes.filter(node => node.id !== operation.id), { ...revision.node, id: operation.id, revisionId: revision.id }]
    } else if (operation.type === 'delete-node') result.nodes = result.nodes.filter(node => node.id !== operation.id)
    else if (operation.type === 'put-edge') result.edges = [...result.edges.filter(edge => edge.id !== operation.edge.id), operation.edge]
    else if (operation.type === 'delete-edge') result.edges = result.edges.filter(edge => edge.id !== operation.id)
    else if (operation.type === 'put-route') result.routes = [...result.routes.filter(route => route.id !== operation.route.id), operation.route]
    else if (operation.type === 'delete-route') result.routes = result.routes.filter(route => route.id !== operation.id)
    else if (operation.type === 'put-note') result.notes = [...result.notes.filter(note => note.id !== operation.note.id), { ...operation.note, sourceHash: operation.expectedSourceHash, confirmed: operation.confirm }]
    else if (operation.type === 'delete-note') result.notes = result.notes.filter(note => note.id !== operation.id)
  }
  return result
}

export function affectedStoryRoutes(workspace: StoryWorkspace): string[] {
  const preview = storyPreview(workspace)
  if (!preview) return []
  const shared = new Set<string>()
  for (const operation of workspace.pending) {
    if (operation.type !== 'put-node' && operation.type !== 'restore-node') continue
    const id = operation.type === 'put-node' ? operation.node.id : operation.id
    const legacyRoutes = workspace.snapshot?.aliases?.affectedRoutes?.[id]
    if (legacyRoutes) {
      if (legacyRoutes.length > 1) legacyRoutes.forEach(title => shared.add(title))
      continue
    }
    if (!workspace.snapshot?.nodes.some(node => node.id === id)) continue
    const priorNode = workspace.snapshot?.nodes.find(node => node.id === id)
    const nextNode = preview.nodes.find(node => node.id === id)
    const planning = (node: StoryNode) => JSON.stringify([
      node.chapterBlueprint ? [node.chapterBlueprint.title, node.chapterBlueprint.role, node.chapterBlueprint.purpose,
        node.chapterBlueprint.keyEvents, node.chapterBlueprint.characters, node.chapterBlueprint.suspenseHook,
        node.chapterBlueprint.userGuidance, node.chapterBlueprint.notes] : null,
      node.chapterSource ? [node.chapterSource.chapterNumber, node.chapterSource.blueprintHash, node.chapterSource.manuscriptHash] : null,
    ])
    if (priorNode && nextNode && priorNode.body === nextNode.body && priorNode.event === nextNode.event && planning(priorNode) === planning(nextNode)) continue
    const priorRoutes = workspace.snapshot?.routes.filter(route => route.nodeIds.includes(id)) ?? []
    const routes = preview.routes.filter(route => route.nodeIds.includes(id))
    if (routes.length > 1 || priorRoutes.length > 1) for (const route of [...priorRoutes, ...routes]) shared.add(route.title)
  }
  return [...shared]
}

export async function loadStoryWorkspace(key: string, session: ProjectSessionContext, rebase = false): Promise<void> {
  const current = getStoryWorkspace(key)
  if (!current || current.busy) return
  // Automatic refresh passes the workspace's frozen lease. Only an explicit
  // rebase may read a reopened session, retaining input for author review.
  if ((!sameProjectSessionContext(current.session, session) && !rebase) || !isProjectSessionCurrent(session)) {
    updateStoryWorkspace(key, { error: 'STORY_SESSION_STALE' })
    return
  }
  if (current.pending.length && !rebase) return
  updateStoryWorkspace(key, { busy: true, error: '' })
  try {
    if (!isProjectSessionCurrent(session)) throw new Error('STORY_SESSION_STALE')
    const result = await ipc.invokeWithProjectSession(session, 'story:read', {})
    if (!result.success) throw new Error(result.error)
    if (!isProjectSessionCurrent(session)) throw new Error('STORY_SESSION_STALE')
    const latest = getStoryWorkspace(key)
    if (!latest || !sameProjectSessionContext(latest.session, current.session)) return
    updateStoryWorkspace(key, { ...reconcileStorySelection(latest, result.data), session, snapshot: result.data, context: null, reviewRequired: Boolean(latest.pending.length), sharedEditConfirmed: false, notice: latest.pending.length ? 'STORY_REVIEW_RETAINED_INPUT' : '' })
  } catch (error) { updateStoryWorkspace(key, { error: error instanceof Error ? error.message : String(error) }) }
  finally { updateStoryWorkspace(key, { busy: false }) }
}

export async function saveStoryWorkspace(key: string, manual = true): Promise<void> {
  const workspace = getStoryWorkspace(key)
  if (!workspace?.snapshot || !workspace.pending.length) return
  if (workspace.busy) throw new Error('STORY_BUSY')
  if (!isProjectSessionCurrent(workspace.session)) throw new Error('STORY_SESSION_STALE')
  if (workspace.reviewRequired) throw new Error('STORY_REVIEW_REQUIRED')
  if (affectedStoryRoutes(workspace).length && !workspace.sharedEditConfirmed) throw new Error('STORY_SHARED_EDIT_CONFIRMATION_REQUIRED')
  const version = workspace.editVersion
  updateStoryWorkspace(key, { busy: true, error: '', notice: '' })
  try {
    const result = await ipc.invokeWithProjectSession(workspace.session, 'story:commit', {
      expectedRevision: workspace.snapshot.revision,
      operations: workspace.pending,
      confirmedSharedEdit: workspace.sharedEditConfirmed,
    })
    if (!result.success) throw new Error(result.error)
    const latest = getStoryWorkspace(key)
    if (!latest) return
    // An explicit late input remains pending over the new baseline; never erase it.
    const acknowledged = new Map(workspace.pending.map(operation => [operationKey(operation), JSON.stringify(operation)]))
    const retained = { ...latest, pending: latest.editVersion === version ? [] : latest.pending.filter(operation => acknowledged.get(operationKey(operation)) !== JSON.stringify(operation)) }
    updateStoryWorkspace(key, { ...reconcileStorySelection(retained, result.data), snapshot: result.data, pending: retained.pending, context: null, sharedEditConfirmed: false, notice: 'STORY_SAVED' })
    if (!isProjectSessionCurrent(workspace.session)) throw new Error('STORY_SESSION_STALE')
    if (latest.editVersion !== version) throw new Error('STORY_INPUT_CHANGED')
    if (manual) announceProjectManuallySaved(workspace.session.projectPath)
  } catch (error) {
    updateStoryWorkspace(key, { error: error instanceof Error ? error.message : String(error) })
    throw error
  } finally { updateStoryWorkspace(key, { busy: false }) }
}

export function discardStoryWorkspace(key: string): void {
  updateStoryWorkspace(key, current => ({ pending: [], context: null, editVersion: current.editVersion + 1, error: '', notice: '', reviewRequired: false, sharedEditConfirmed: false }))
}

export async function readStoryContext(key: string, request: StoryContextRequest): Promise<StoryContext | null> {
  const workspace = getStoryWorkspace(key)
  if (!workspace || workspace.pending.some(operation => operation.type !== 'put-note') || workspace.busy) return null
  updateStoryWorkspace(key, { busy: true, error: '' })
  try {
    if (!isProjectSessionCurrent(workspace.session)) throw new Error('STORY_SESSION_STALE')
    const result = await ipc.invokeWithProjectSession(workspace.session, 'story:context', request)
    if (!result.success) throw new Error(result.error)
    const latest = getStoryWorkspace(key)
    const activeBridge = latest && storyPreview(latest)?.edges.some(edge => edge.from === latest.selectedNodeId && edge.to === latest.bridgeToNodeId) ? latest.bridgeToNodeId : ''
    if (!latest || latest.selectedNodeId !== request.nodeId || (latest.mode === 'shared' ? '' : latest.selectedRouteId) !== (request.routeId ?? '') || latest.mode !== request.mode || activeBridge !== (request.bridgeToNodeId ?? '') || !isProjectSessionCurrent(workspace.session)) return null
    updateStoryWorkspace(key, { context: result.data })
    return result.data
  } catch (error) { updateStoryWorkspace(key, { error: error instanceof Error ? error.message : String(error) }); return null }
  finally { updateStoryWorkspace(key, { busy: false }) }
}

export function nodeInput(node: StoryNode) {
  const { revisionId: _revisionId, ...input } = node
  return input
}

export function resetStoryWorkspacesForTests(): void {
  for (const dispose of disposers.values()) dispose()
  disposers.clear()
  if (typeof window !== 'undefined') window.removeEventListener('beforeunload', guardUnsavedStoryInput)
  useStoryWorkspaces.setState({ entries: {} })
}
