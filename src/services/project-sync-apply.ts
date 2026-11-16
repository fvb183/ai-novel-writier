import { ipc } from './ipc-client'
import { captureProjectTransitionDraftSnapshot, hasProjectTransitionDrafts, isProjectTransitionDraftSnapshotCurrent, saveProjectTransitionDrafts } from './project-transition'
import { isProjectSessionCurrent } from '../components/project-session-gate'
import { toast } from '../components/ui/Toast'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { SyncPreview, SyncResolution } from '../shared/project-sync'
import type { SyncResponse } from '../shared/project-sync-ipc'
import { projectSessionContextFromProject, sameProjectPathKey } from '../shared/project-session-context'
import { useProjectStore } from '../stores/project-store'
import { createProjectScopedEditorTabId, saveDirtyEditorChangesForExit, useEditorStore } from '../stores/editor-store'
import { useWorkflowStore } from '../stores/workflow-store'
import { useAgentStore } from '../stores/agent-store'
import { useProjectSyncOperation } from '../stores/project-sync-operation'
import { useLocaleStore } from '../stores/locale-store'
import { countUnsavedEditorItemsForProject } from '../stores/editor-unsaved'
import { useLayoutStore } from '../stores/layout-store'
import { readResourceContent } from './resource-protocol'

function requireCurrent(session: ProjectSessionContext): void {
  if (!isProjectSessionCurrent(session)) throw new Error('SYNC_SESSION_STALE')
}

function requireIdle(session: ProjectSessionContext): void {
  if (useAgentStore.getState().generating || useWorkflowStore.getState().activeRuns.some(run => sameProjectPathKey(run.projectPath, session.projectPath))) {
    throw new Error('SYNC_PROJECT_BUSY')
  }
}

function snapshot(session: ProjectSessionContext) {
  const editor = useEditorStore.getState()
  return { tabs: editor.tabs, ledgers: editor.draftLedgers, inputs: captureProjectTransitionDraftSnapshot(session.projectPath) }
}

function unchanged(session: ProjectSessionContext, frozen: ReturnType<typeof snapshot>): boolean {
  const editor = useEditorStore.getState()
  return editor.tabs === frozen.tabs && editor.draftLedgers === frozen.ledgers
    && isProjectTransitionDraftSnapshotCurrent(session.projectPath, frozen.inputs)
}

/** Lock native and browser inputs synchronously, before the first save awaits. */
function lockInputs(): () => void {
  const roots = [...document.querySelectorAll<HTMLElement>('.stage-shell')].map(root => ({ root, inert: root.inert }))
  for (const { root } of roots) root.inert = true
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
  const events = ['keydown', 'beforeinput', 'android-back'] as const
  for (const name of events) window.addEventListener(name, stop, true)
  return () => {
    for (const name of events) window.removeEventListener(name, stop, true)
    for (const { root, inert } of roots) root.inert = inert
  }
}

async function saveLocalSyncInput(session: ProjectSessionContext): Promise<void> {
  requireCurrent(session); requireIdle(session)
  for (const content of Object.values(useEditorStore.getState().draftLedgers)) {
    if (!content) continue
    try { JSON.parse(content) } catch { throw new Error('存在无法识别的未保存编辑内容，请先恢复该编辑器') }
  }
  await saveDirtyEditorChangesForExit(session.projectPath, 'project')
  requireCurrent(session)
  await saveProjectTransitionDrafts(session.projectPath)
  requireCurrent(session)
  const editor = useEditorStore.getState()
  if (countUnsavedEditorItemsForProject(editor.tabs, editor.draftLedgers, session.projectPath)) throw new Error('SYNC_INPUT_CHANGED')
  requireIdle(session)
}

/** Save under the existing input lock, then release it before slow cloud transfer. */
export async function prepareGoogleDriveExchange(session: ProjectSessionContext): Promise<void> {
  if (useProjectSyncOperation.getState().phase) throw new Error('SYNC_PROJECT_BUSY')
  requireCurrent(session); requireIdle(session)
  useProjectSyncOperation.setState({ phase: 'saving' })
  const unlock = lockInputs()
  try { await saveLocalSyncInput(session) }
  finally { unlock(); useProjectSyncOperation.setState({ phase: null }) }
}

/** Save local input, validate a fresh preview, apply once, then rebind all stores through normal open. */
export async function applyProjectSync(
  session: ProjectSessionContext, preview: SyncPreview, resolutions: SyncResolution[], automatic = false,
): Promise<SyncResponse> {
  if (useProjectSyncOperation.getState().phase) throw new Error('SYNC_PROJECT_BUSY')
  requireCurrent(session)
  requireIdle(session)
  const hasInput = () => {
    const editor = useEditorStore.getState()
    return countUnsavedEditorItemsForProject(editor.tabs, editor.draftLedgers, session.projectPath) > 0 || hasProjectTransitionDrafts(session.projectPath)
  }
  // Automatic sync transfers saved records only. An editor or assistant draft
  // stays untouched until its author saves or discards it themselves.
  if (automatic && (hasInput() || preview.conflicts.length || !preview.canApply || preview.missingBatchHashes.length)) return { success: false, error: 'SYNC_PROJECT_BUSY' }
  if (automatic && (useLayoutStore.getState().settingsOpen || useLayoutStore.getState().newProjectOpen
    || document.activeElement?.matches('input, textarea, [contenteditable="true"]'))) return { success: false, error: 'SYNC_PROJECT_BUSY' }
  const view = automatic ? { tabs: useEditorStore.getState().tabs.filter(tab => sameProjectPathKey(tab.projectKey, session.projectPath)),
    active: useEditorStore.getState().activeTabId, sidebar: useLayoutStore.getState().sidebarView } : null
  useProjectSyncOperation.setState({ phase: 'saving' })
  const unlock = lockInputs()
  let committed = false
  try {
    if (automatic) { if (hasInput()) return { success: false, error: 'SYNC_PROJECT_BUSY' } }
    else await saveLocalSyncInput(session)
    const frozen = snapshot(session)
    useProjectSyncOperation.setState({ phase: 'checking' })
    const checked = await ipc.invokeWithProjectSession(session, 'sync:preview', {})
    requireCurrent(session)
    if (!unchanged(session, frozen)) throw new Error('SYNC_INPUT_CHANGED')
    if (!checked.success || !checked.preview) return checked
    // Saving can create new heads. An old choice is never silently mapped onto a new conflict.
    if (checked.preview.token !== preview.token) return { ...checked, success: false, error: 'SYNC_PREVIEW_STALE' }
    requireIdle(session)
    useProjectSyncOperation.setState({ phase: 'applying' })
    const result = await ipc.invokeWithProjectSession(session, 'sync:apply', { token: preview.token, resolutions })
    committed = Boolean(result.success && result.applied?.applied)
    if (!committed) {
      if (result.error === 'SYNC_PREVIEW_STALE' && isProjectSessionCurrent(session)) {
        const latest = await ipc.invokeWithProjectSession(session, 'sync:preview', {})
        requireCurrent(session)
        return { ...latest, success: false, error: 'SYNC_PREVIEW_STALE' }
      }
      return result
    }
    requireCurrent(session)
    if (!unchanged(session, frozen)) throw new Error('SYNC_INPUT_CHANGED_AFTER_APPLY')
    requireIdle(session)
    useProjectSyncOperation.setState({ phase: 'reopening' })
    const reopened = await useProjectStore.getState().openProject(session.projectPath)
    if (!reopened) throw new Error('SYNC_REOPEN_FAILED')
    if (view) {
      const next = projectSessionContextFromProject(useProjectStore.getState().currentProject)
      if (next && sameProjectPathKey(next.projectPath, session.projectPath)) {
        let restoredActive: string | null = null
        for (const tab of view.tabs) {
          if (!isProjectSessionCurrent(next)) break
          let content: string | undefined
          let metadata = {}
          if (tab.filePath?.startsWith('ai-novel://')) {
            try {
              content = await readResourceContent(tab.filePath, next)
              if (tab.draftId) {
                const draft = await ipc.invokeWithProjectSession(next, 'db:draft-get-meta', tab.draftId, next.projectPath)
                if (!draft) continue
                metadata = { draftStatus: draft.status, finalizationId: draft.finalizationId, finalizationPublication: draft.publicationStatus }
              }
            } catch { continue /* Deleted remote resources do not reopen stale text. */ }
          } else if (tab.filePath) {
            const file = await ipc.invokeWithProjectSession(next, 'fs:read-file', tab.filePath, next.projectPath)
            if (!file.success) continue
            content = file.content
          }
          if (!isProjectSessionCurrent(next)) break
          const suffix = `:${encodeURIComponent(next.projectPath)}`
          const scoped = createProjectScopedEditorTabId('', tab.type, next.projectPath) === suffix
          const id = scoped && tab.id.endsWith(suffix) ? tab.id.slice(0, -suffix.length) : tab.id
          useEditorStore.getState().openFile({ ...tab, id, ...metadata, content, savedContent: content, dirty: false,
            knowledgeDraft: undefined, projectSessionLease: next.leaseId })
          if (tab.id === view.active) restoredActive = useEditorStore.getState().activeTabId
        }
        if (isProjectSessionCurrent(next)) {
          if (restoredActive) useEditorStore.getState().setActiveTab(restoredActive)
          useLayoutStore.setState({ sidebarView: view.sidebar })
        }
      }
    }
    return result
  } catch (error) {
    if (committed && isProjectSessionCurrent(session)) {
      // Never clear tabs or draft ledgers on this exceptional path. Old non-CAS
      // editors must lose their writable session if rebinding cannot complete.
      useProjectStore.setState({ currentProject: null, fileTree: [] })
      toast.error(useLocaleStore.getState().text(
        '同步已应用，但界面刷新未完成。当前输入已保留，项目编辑已停用；请重新打开项目并核对。',
        'Sync was applied, but the editor could not refresh. Input is preserved and project editing is disabled. Reopen the project and compare your changes.',
      ))
    }
    throw error
  } finally {
    unlock()
    useProjectSyncOperation.setState({ phase: null })
  }
}
