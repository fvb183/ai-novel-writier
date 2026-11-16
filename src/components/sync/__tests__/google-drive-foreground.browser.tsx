import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { registerEditorExitSaveHandler, useEditorStore } from '../../../stores/editor-store'
import { useAgentStore } from '../../../stores/agent-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useDriveSyncStore } from '../../../stores/drive-sync-store'
import { useProjectSyncOperation } from '../../../stores/project-sync-operation'
import { registerProjectTransitionDraft } from '../../../services/project-transition'
import { announceProjectManuallySaved } from '../../../services/project-save-events'
import { GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED } from '../google-drive-sync-events'
import GoogleDriveForegroundSync from '../GoogleDriveForegroundSync'

const session = { projectId: 'auto-book', projectPath: 'D:/synthetic/book', leaseId: 'lease-a' }
const project = { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '合成小说', novelConfig: {} } as ProjectData
const preview = { token: 'remote-token', pendingBatches: 1, canApply: true, conflicts: [], missingBatchHashes: [], changedRecords: 1 }
const original = { project: useProjectStore.getState(), editor: useEditorStore.getState(), layout: useLayoutStore.getState(), agent: useAgentStore.getState(), workflow: useWorkflowStore.getState() }
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement, invoke: ReturnType<typeof vi.fn>, reopen: ReturnType<typeof vi.fn>, recent: ReturnType<typeof vi.fn>
let visible: string, online: boolean, catalog: () => Promise<any>, exchange: () => Promise<any>, auth: boolean, disposers: (() => void)[]
let callbacks: Record<string, (data?: any) => void>
const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)
const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const explicit = async () => { await act(async () => window.dispatchEvent(new Event(GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED))); await flush(); await flush() }
const manualSave = async (path = session.projectPath) => { await act(async () => { announceProjectManuallySaved(path); await new Promise(resolve => setTimeout(resolve, 180)) }); await flush() }
const returnForeground = async () => {
  visible = 'hidden'; await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  visible = 'visible'; await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await flush(); await flush()
}
async function mount(strict = false) {
  await act(async () => root.render(strict ? <StrictMode><GoogleDriveForegroundSync /></StrictMode> : <GoogleDriveForegroundSync />))
  await flush(); await flush()
}
beforeEach(() => {
  visible = 'visible'; online = true; auth = true; disposers = []; callbacks = {}
  vi.spyOn(window, 'setInterval')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible })
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  catalog = async () => ({ success: true, automatic: { imported: 0, updated: 0, conflicts: [], failures: [] }, localProjects: [] })
  exchange = async () => ({ success: true, preview: { ...preview, pendingBatches: 0 } })
  recent = vi.fn(async () => {})
  reopen = vi.fn(async () => {
    const next = { ...project, sessionLease: 'lease-b' }
    useProjectStore.setState({ currentProject: next }); setActiveProjectSessionContext({ ...session, leaseId: 'lease-b' })
    useEditorStore.setState({ tabs: [], activeTabId: null }); return true
  })
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'drive:auto-sync') return auth ? catalog() : { success: true, auth: { available: true, configured: true, authorized: false } }
    if (channel === 'drive:cancel-auto-sync') return { success: true }
    if (channel === 'drive:project-status') return { success: true, drive: { bound: true, autoSync: true } }
    if (channel === 'drive:exchange') return exchange()
    if (channel === 'sync:preview') return { success: true, preview }
    if (channel === 'sync:apply') return { success: true, applied: { applied: true, appliedBatches: 1, preview: { ...preview, pendingBatches: 0 } } }
    if (channel === 'db:draft-get-full') return { content: '云端最新正文' }
    if (channel === 'db:draft-get-meta') return { id: 1, status: 'draft', chapterNumber: 1 }
    throw Error('Unexpected ' + channel)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: (channel: string, callback: (data?: any) => void) => { callbacks[channel] = callback; return () => { delete callbacks[channel] } } } })
  useProjectStore.setState({ currentProject: project, openProject: reopen as any, loadRecentProjects: recent as typeof original.project.loadRecentProjects })
  useEditorStore.setState({ tabs: [{ id: 'draft', filePath: 'ai-novel://draft/1', draftId: 1, name: '第一章', type: 'chapter', projectKey: session.projectPath, content: '本地已保存正文', savedContent: '本地已保存正文', dirty: false }], activeTabId: 'draft', draftLedgers: {} })
  useLayoutStore.setState({ settingsOpen: false, newProjectOpen: false, sidebarView: 'home' })
  useAgentStore.setState({ generating: false }); useWorkflowStore.setState({ activeRuns: [] }); useProjectSyncOperation.setState({ phase: null })
  useDriveSyncStore.setState({ projects: {}, phase: 'idle', stage: null, errorCode: null, nextRetryAt: null, message: '', lastChecked: null })
  setActiveProjectSessionContext(session)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); disposers.forEach(fn => fn())
  useProjectStore.setState(original.project, true); useEditorStore.setState(original.editor, true); useLayoutStore.setState(original.layout, true)
  useAgentStore.setState(original.agent, true); useWorkflowStore.setState(original.workflow, true)
  setActiveProjectSessionContext(null); Reflect.deleteProperty(window, 'aiNovelAPI'); vi.restoreAllMocks()
})

describe('event-driven cloud sync', () => {
  it('performs one startup discovery under React StrictMode without leaving canceled progress', async () => {
    await mount(true); expect(calls('drive:auto-sync')).toHaveLength(1)
    expect(useDriveSyncStore.getState().phase).toBe('idle')
  })
  it('does not install a polling timer or subscribe to internal database save notifications', async () => {
    await mount(); expect(calls('drive:auto-sync')).toHaveLength(1)
    expect(window.setInterval).not.toHaveBeenCalled(); expect(callbacks['sync:saved-changed']).toBeUndefined()
    await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')) }); await flush()
    expect(calls('drive:auto-sync')).toHaveLength(1)
  })
  it('discovers cloud books once on an empty shelf without switching projects', async () => {
    useProjectStore.setState({ currentProject: null }); setActiveProjectSessionContext(null)
    catalog = async () => ({ success: true, automatic: { imported: 1, updated: 0, conflicts: [], failures: [] }, localProjects: [{ path: 'D:/synthetic/download', enabled: true }] })
    await mount(); expect(recent).toHaveBeenCalledOnce(); expect(reopen).not.toHaveBeenCalled(); expect(calls('drive:exchange')).toHaveLength(0)
  })
  it('syncs a successful manual save and ignores another book save', async () => {
    await mount(); await manualSave('D:/other-book'); expect(calls('drive:auto-sync')).toHaveLength(1)
    await manualSave(); expect(calls('drive:auto-sync')).toHaveLength(2)
  })
  it('coalesces a group of manual save completions into one exchange', async () => {
    await mount()
    await act(async () => { announceProjectManuallySaved(session.projectPath); announceProjectManuallySaved(session.projectPath); await new Promise(resolve => setTimeout(resolve, 180)) })
    await flush(); expect(calls('drive:auto-sync')).toHaveLength(2)
  })
  it('saves dirty author input before exchanging on foreground return', async () => {
    await mount(); const save = vi.fn(async () => { useEditorStore.getState().markTabSaved('draft', '回前台保存') })
    disposers.push(registerEditorExitSaveHandler({ tabId: 'draft', type: 'chapter', projectKey: session.projectPath, save }))
    useEditorStore.getState().updateTabContent('draft', '回前台保存')
    catalog = async () => { expect(save).toHaveBeenCalledOnce(); expect(useEditorStore.getState().tabs[0].dirty).toBe(false); return { success: true } }
    await returnForeground(); expect(save).toHaveBeenCalledOnce(); expect(calls('drive:auto-sync')).toHaveLength(2)
    await act(async () => window.dispatchEvent(new Event('focus'))); await flush(); expect(calls('drive:auto-sync')).toHaveLength(2)
  })
  it('keeps local foreground saving available offline without network traffic', async () => {
    await mount(); online = false
    const save = vi.fn(async () => { useEditorStore.getState().markTabSaved('draft', '离线输入') })
    disposers.push(registerEditorExitSaveHandler({ tabId: 'draft', type: 'chapter', projectKey: session.projectPath, save }))
    useEditorStore.getState().updateTabContent('draft', '离线输入')
    await returnForeground(); expect(save).toHaveBeenCalledOnce(); expect(calls('drive:auto-sync')).toHaveLength(1)
  })
  it('preserves input and skips cloud transfer when foreground saving fails', async () => {
    await mount()
    disposers.push(registerEditorExitSaveHandler({ tabId: 'draft', type: 'chapter', projectKey: session.projectPath, save: async () => { throw Error('disk-full') } }))
    useEditorStore.getState().updateTabContent('draft', '未保存内容')
    await returnForeground(); expect(calls('drive:auto-sync')).toHaveLength(1); expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '未保存内容', dirty: true })
  })
  it('does not force-save dirty input on startup or automatically apply over it', async () => {
    exchange = async () => ({ success: true, preview })
    useEditorStore.getState().updateTabContent('draft', '未保存内容')
    await mount(); expect(calls('sync:apply')).toHaveLength(0); expect(reopen).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '未保存内容', dirty: true })
  })
  it('applies clean updates and does not start another exchange just because the lease reopened', async () => {
    exchange = async () => ({ success: true, preview })
    await mount(); expect(calls('sync:apply')).toHaveLength(1); expect(reopen).toHaveBeenCalledWith(session.projectPath)
    expect(useEditorStore.getState().tabs.find(tab => tab.draftId === 1)).toMatchObject({ content: '云端最新正文', savedContent: '云端最新正文', projectSessionLease: 'lease-b', dirty: false })
    expect(calls('drive:auto-sync')).toHaveLength(1)
  })
  it('retains both conflicting variants for author resolution', async () => {
    exchange = async () => ({ success: true, preview: { ...preview, canApply: false, conflicts: [{ kind: 'draft', id: 'stable-id', variants: [{ revision: 'a', value: '电脑稿' }, { revision: 'b', value: '手机稿' }] }] } })
    await mount(); expect(calls('sync:apply')).toHaveLength(0); expect(useDriveSyncStore.getState().message).toContain('双方内容已保留')
  })
  it('reports pending history cleanup after a successful content exchange', async () => {
    exchange = async () => ({ success: true, drive: { bound: true, autoSync: true, historyCleanupError: 'DRIVE_NETWORK_FAILED' }, preview: { ...preview, pendingBatches: 0 } })
    await mount()
    expect(useDriveSyncStore.getState()).toMatchObject({ phase: 'idle', errorCode: null })
    expect(useDriveSyncStore.getState().message).toContain('已同步已保存的内容')
    expect(useDriveSyncStore.getState().message).toContain('旧历史清理尚未完成')
    expect(useDriveSyncStore.getState().message).toContain('下次同步时自动重试')
  })
  it('retains an inactive book cleanup warning after the active book sync succeeds', async () => {
    catalog = async () => ({ success: true, automatic: { imported: 0, updated: 0, conflicts: [], failures: [], cleanupWarnings: [{ projectId: 'inactive-book', error: 'DRIVE_NETWORK_FAILED' }] } })
    await mount()
    expect(useDriveSyncStore.getState().message).toContain('旧历史清理尚未完成')
    expect(useDriveSyncStore.getState().phase).toBe('idle')
  })
  it('waits for pending story drafts and settings rather than replacing them', async () => {
    exchange = async () => ({ success: true, preview }); const save = vi.fn()
    disposers.push(registerProjectTransitionDraft({ projectKey: session.projectPath, isDirty: () => true, version: () => 1, save, discard: () => {} }))
    await mount(); expect(save).not.toHaveBeenCalled(); expect(calls('sync:apply')).toHaveLength(0)
    disposers.splice(0).forEach(fn => fn()); useLayoutStore.setState({ settingsOpen: true }); await explicit(); expect(calls('sync:apply')).toHaveLength(0)
  })
  it('retains failure feedback without scheduling a retry and retries on the next author save', async () => {
    catalog = async () => ({ success: false, error: 'DRIVE_NETWORK_FAILED' }); await mount()
    expect(useDriveSyncStore.getState()).toMatchObject({ phase: 'error', errorCode: 'DRIVE_NETWORK_FAILED', nextRetryAt: null })
    expect(useDriveSyncStore.getState().message).toContain('下次手动保存')
    expect(window.setInterval).not.toHaveBeenCalled()
    catalog = async () => ({ success: true }); await manualSave(); expect(calls('drive:auto-sync')).toHaveLength(2)
  })
  it('coalesces explicit requests while a transfer is running', async () => {
    let finish!: (value: any) => void; catalog = () => new Promise(resolve => { finish = resolve }); await mount()
    await act(async () => { window.dispatchEvent(new Event(GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED)); window.dispatchEvent(new Event(GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED)) })
    catalog = async () => ({ success: true }); await act(async () => finish({ success: true })); await flush(); await flush()
    expect(calls('drive:auto-sync')).toHaveLength(2)
  })
  it('ignores stale progress and cancels an old project operation', async () => {
    let finish!: (value: any) => void; catalog = () => new Promise(resolve => { finish = resolve }); await mount()
    const id = (calls('drive:auto-sync')[0][1] as any).operationId
    await act(async () => callbacks['drive:sync-progress']?.({ operationId: id, stage: 'assets', completed: 2, total: 5 }))
    expect(useDriveSyncStore.getState().stage).toBe('assets')
    await act(async () => callbacks['drive:sync-progress']?.({ operationId: 'other', stage: 'download' })); expect(useDriveSyncStore.getState().stage).toBe('assets')
    await act(async () => { const next = { ...project, id: 'other', path: 'D:/synthetic/other', sessionLease: 'other' }; useProjectStore.setState({ currentProject: next }); setActiveProjectSessionContext({ projectId: next.id, projectPath: next.path, leaseId: next.sessionLease }) })
    expect(calls('drive:cancel-auto-sync').some(call => (call[1] as any).operationId === id)).toBe(true)
    await act(async () => finish({ success: false, error: 'DRIVE_NETWORK_FAILED' })); await flush()
    expect(calls('drive:auto-sync')).toHaveLength(1); expect(useDriveSyncStore.getState().phase).not.toBe('error')
  })
  it.each(['DRIVE_BUSY', 'GOOGLE_AUTH_BUSY', 'GOOGLE_AUTH_CHANGED', 'SYNC_SESSION_STALE', 'SYNC_PROJECT_BUSY', 'DRIVE_CANCELLED'])('ends %s without installing a retry loop', async error => {
    catalog = async () => ({ success: false, error }); await mount()
    expect(useDriveSyncStore.getState()).toMatchObject({ phase: 'idle', stage: null, nextRetryAt: null })
    expect(calls('drive:auto-sync')).toHaveLength(1); expect(window.setInterval).not.toHaveBeenCalled()
  })
  it('does not start traffic or Google login while unauthorized', async () => {
    auth = false; await mount(); expect(calls('drive:connect')).toHaveLength(0); expect(calls('drive:project-status')).toHaveLength(0)
    expect(useDriveSyncStore.getState()).toMatchObject({ phase: 'idle', stage: null, message: '请连接 Google 账户后继续同步。' })
  })
})
