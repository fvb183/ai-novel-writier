import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ProjectSyncPanel from '../ProjectSyncPanel'
import ProjectSyncOperationOverlay from '../ProjectSyncOperationOverlay'
import { registerEditorExitSaveHandler, useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useProjectSyncOperation } from '../../../stores/project-sync-operation'
import { useAgentStore } from '../../../stores/agent-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { registerProjectTransitionDraft } from '../../../services/project-transition'
import { PROJECT_MANUALLY_SAVED } from '../../../services/project-save-events'
import type { ProjectData } from '../../../shared/ipc-channels'
import type { SyncPreview, SyncStatus } from '../../../shared/project-sync'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const session = { projectId: 'sync-fixture', leaseId: 'lease-a', projectPath: 'C:/synthetic/sync' }
const project = { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '测试作品', novelConfig: {} } as ProjectData
const saved = { project: useProjectStore.getState(), editor: useEditorStore.getState(), workflow: useWorkflowStore.getState(), agent: useAgentStore.getState() }
const status: SyncStatus = { enabled: true, projectId: session.projectId, replicaId: 'local', localBatches: 1, acknowledgedBatches: 0, pendingBatches: 1, conflicts: 0 }
const basePreview: SyncPreview = { token: 'preview-a', pendingBatches: 1, changedRecords: 1, missingBatchHashes: [], conflicts: [], canApply: true }
let preview: SyncPreview
let root: Root
let host: HTMLDivElement
let disposers: Array<() => void>
let invoke: ReturnType<typeof vi.fn>
let reopen: ReturnType<typeof vi.fn>
let applyResult: () => Promise<unknown>
let importResult: () => Promise<unknown>
let authorSaveSignal: ReturnType<typeof vi.fn<(event: Event) => void>>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}
const applySuccess = () => ({ success: true, applied: { applied: true, appliedBatches: 1, preview: { ...basePreview, pendingBatches: 0 } } })
const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === name)!
const click = async (name: string) => act(async () => button(name).click())
async function idle() { await expect.poll(() => host.querySelector('section')?.getAttribute('aria-busy')).toBe('false') }

function Input() {
  const tab = useEditorStore(state => state.tabs[0])
  return <textarea aria-label="原稿输入" value={tab?.content ?? ''} onChange={event => useEditorStore.getState().updateTabContent('draft', event.target.value)} />
}
async function mount() {
  host = document.createElement('div')
  host.className = 'stage-shell'
  host.style.cssText = 'height:780px;overflow:auto'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<><Input /><ProjectSyncPanel /><ProjectSyncOperationOverlay /></>))
  await idle()
}

beforeEach(async () => {
  await page.viewport(1024, 768)
  preview = { ...basePreview }
  disposers = []
  authorSaveSignal = vi.fn<(event: Event) => void>()
  window.addEventListener(PROJECT_MANUALLY_SAVED, authorSaveSignal)
  disposers.push(() => window.removeEventListener(PROJECT_MANUALLY_SAVED, authorSaveSignal))
  applyResult = async () => applySuccess()
  importResult = async () => ({ success: true, status, preview })
  reopen = vi.fn(async () => {
    useProjectStore.setState({ currentProject: { ...project, sessionLease: 'lease-reopened' } })
    return true
  })
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'project:recent-list') return []
    if (channel === 'sync:status') return { success: true, status }
    if (channel === 'sync:preview') return { success: true, preview, status }
    if (channel === 'sync:apply') return applyResult()
    if (channel === 'sync:import-preview') return importResult()
    if (channel.startsWith('dialog:select-sync')) return { grantId: channel, displayName: 'fixture.ainovelsync' }
    if (channel === 'sync:join') return { success: true, projectPath: 'C:/synthetic/joined' }
    return { success: true }
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => undefined } })
  useProjectStore.setState({ currentProject: project, openProject: reopen as typeof saved.project.openProject })
  useEditorStore.setState({ tabs: [{ id: 'draft', name: '原稿', type: 'chapter', filePath: 'ai-novel://draft/1', projectKey: session.projectPath, content: '已保存正文', savedContent: '已保存正文', contentRevision: 0, dirty: false }], activeTabId: 'draft', draftLedgers: {} })
  useWorkflowStore.setState({ activeRuns: [] })
  useAgentStore.setState({ generating: false })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectSyncOperation.setState({ phase: null })
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
  disposers.forEach(dispose => dispose())
  useProjectStore.setState(saved.project, true)
  useEditorStore.setState(saved.editor, true)
  useWorkflowStore.setState(saved.workflow, true)
  useAgentStore.setState(saved.agent, true)
  useProjectSyncOperation.setState({ phase: null })
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('local project sync UI', () => {
  it('stages conflicting updates, shows both versions and submits an explicit selection with the captured lease', async () => {
    await mount()
    preview = { ...basePreview, canApply: false, conflicts: [{ kind: 'draft', id: 'stable-id', variants: [
      { revision: 'rev-a', batchId: 'batch-a', replicaId: 'desktop', deleted: false, value: '桌面版本正文' },
      { revision: 'rev-b', batchId: 'batch-b', replicaId: 'phone', deleted: false, value: '手机版本正文' },
    ] }] }
    await click('导入并预览')
    await idle()
    expect(calls('sync:apply')).toHaveLength(0)
    expect(host.textContent).toContain('桌面版本正文')
    expect(host.textContent).toContain('手机版本正文')
    expect(host.textContent).toContain('未解决冲突的双方版本')
    expect(host.textContent).toContain('旧包会自动清理')
    expect(button('保存并应用同步').disabled).toBe(true)
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click())
    expect(button('保存并应用同步').disabled).toBe(false)
    await click('保存并应用同步')
    await expect.poll(() => reopen.mock.calls.length).toBe(1)
    expect(calls('sync:apply')[0]).toEqual(['sync:apply', {
      projectSession: session, token: 'preview-a',
      resolutions: [{ kind: 'draft', id: 'stable-id', expectedHeads: ['rev-a', 'rev-b'], selectedRevision: 'rev-b' }],
    }])
    expect(reopen).toHaveBeenCalledWith(session.projectPath)
    await expect.poll(() => authorSaveSignal.mock.calls.length).toBe(1)
    expect((authorSaveSignal.mock.calls[0][0] as CustomEvent).detail.projectPath).toBe(session.projectPath)
  })

  it.each([
    { name: 'not applied', applied: false, assetsPending: false },
    { name: 'assets still pending', applied: true, assetsPending: true },
  ])('does not announce a manual save when $name', async ({ applied, assetsPending }) => {
    applyResult = async () => ({ success: true, applied: { applied, assetsPending, appliedBatches: applied ? 1 : 0, preview: basePreview } })
    await mount()
    await click('保存并应用同步')
    await idle()
    expect(calls('sync:apply')).toHaveLength(1)
    expect(authorSaveSignal).not.toHaveBeenCalled()
  })

  it('does not apply or reopen when saving local text fails', async () => {
    useEditorStore.getState().updateTabContent('draft', '本地未保存内容')
    disposers.push(registerEditorExitSaveHandler({ tabId: 'draft', type: 'chapter', projectKey: session.projectPath, save: async () => { throw new Error('模拟保存失败') } }))
    await mount()
    await click('保存并应用同步')
    await idle()
    expect(host.textContent).toContain('模拟保存失败')
    expect(calls('sync:apply')).toHaveLength(0)
    expect(reopen).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '本地未保存内容', dirty: true })
    expect(host.inert).toBe(false)
    expect(authorSaveSignal).not.toHaveBeenCalled()
  })

  it('preserves new text arriving while a draft save is in flight', async () => {
    useEditorStore.getState().updateTabContent('draft', '待保存内容')
    const pending = deferred<void>()
    const snapshot = { content: '待保存内容', contentRevision: 1 }
    disposers.push(registerEditorExitSaveHandler({ tabId: 'draft', type: 'chapter', projectKey: session.projectPath, save: async () => {
      await pending.promise
      useEditorStore.getState().settleTabSave('draft', snapshot)
    } }))
    await mount()
    await click('保存并应用同步')
    expect(host.inert).toBe(true)
    await act(async () => {
      useEditorStore.getState().updateTabContent('draft', '保存期间新输入')
      pending.resolve()
    })
    await idle()
    expect(calls('sync:apply')).toHaveLength(0)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '保存期间新输入', savedContent: '待保存内容', dirty: true })
    expect(host.inert).toBe(false)
  })

  it('checks saved input against a fresh preview and requires another review when its token changes', async () => {
    useEditorStore.getState().updateTabContent('draft', '本地修改')
    disposers.push(registerEditorExitSaveHandler({ tabId: 'draft', type: 'chapter', projectKey: session.projectPath, save: async () => {
      const tab = useEditorStore.getState().tabs[0]
      useEditorStore.getState().settleTabSave('draft', { content: tab.content!, contentRevision: tab.contentRevision! })
      preview = { ...preview, token: 'after-save', changedRecords: 2 }
    } }))
    await mount()
    await click('保存并应用同步')
    await idle()
    expect(calls('sync:apply')).toHaveLength(0)
    expect(host.textContent).toContain('已刷新预览')
    expect(host.textContent).toContain('涉及 2 条记录')
    await click('保存并应用同步')
    await expect.poll(() => reopen.mock.calls.length).toBe(1)
    expect(calls('sync:apply')[0][1]).toMatchObject({ token: 'after-save' })
  })

  it('blocks browser input and Android back while applying, preserving assistant input before reopening', async () => {
    let assistantDirty = true
    let assistantValue = '还未发送的助手问题'
    disposers.push(registerProjectTransitionDraft({
      projectKey: session.projectPath, isDirty: () => assistantDirty, version: () => 1,
      save: () => { assistantDirty = false }, discard: () => { assistantValue = '' },
    }))
    const pending = deferred<unknown>()
    applyResult = () => pending.promise
    await mount()
    await click('保存并应用同步')
    await expect.poll(() => calls('sync:apply').length).toBe(1)
    expect(host.inert).toBe(true)
    expect(document.querySelector('.sync-operation-overlay')?.textContent).toContain('正在应用同步')
    const back = new Event('android-back', { cancelable: true })
    const input = new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: '不应输入' })
    window.dispatchEvent(back)
    host.querySelector('textarea')!.dispatchEvent(input)
    expect(back.defaultPrevented).toBe(true)
    expect(input.defaultPrevented).toBe(true)
    expect(assistantDirty).toBe(false)
    await act(async () => pending.resolve(applySuccess()))
    await expect.poll(() => reopen.mock.calls.length).toBe(1)
    expect(assistantValue).toBe('还未发送的助手问题')
    expect(host.inert).toBe(false)
    expect(useProjectSyncOperation.getState().phase).toBeNull()
  })

  it('ignores a late import result after switching projects', async () => {
    const pending = deferred<unknown>()
    importResult = () => pending.promise
    await mount()
    await click('导入并预览')
    await expect.poll(() => calls('sync:import-preview').length).toBe(1)
    await act(async () => {
      useProjectStore.setState({ currentProject: { ...project, id: 'project-b', sessionLease: 'lease-b', path: 'C:/synthetic/other' } })
      pending.resolve({ success: true, preview: { ...basePreview, changedRecords: 999 } })
    })
    await idle()
    expect(host.textContent).not.toContain('涉及 999 条记录')
    expect(calls('sync:import-preview')[0][1]).toMatchObject({ projectSession: session })
    expect(calls('sync:apply')).toHaveLength(0)
  })

  it('retains input and disables the old project if input changes after the backend commits', async () => {
    const pending = deferred<unknown>()
    applyResult = () => pending.promise
    await mount()
    await click('保存并应用同步')
    await expect.poll(() => calls('sync:apply').length).toBe(1)
    await act(async () => {
      useEditorStore.getState().updateTabContent('draft', '程序性晚到输入')
      pending.resolve(applySuccess())
    })
    await expect.poll(() => useProjectSyncOperation.getState().phase).toBeNull()
    expect(reopen).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '程序性晚到输入', dirty: true })
    expect(useProjectStore.getState().currentProject).toBeNull()
  })

  it('disables applying missing history and joins a new copy using only global grants', async () => {
    preview = { ...basePreview, canApply: false, missingBatchHashes: ['missing-parent'] }
    await mount()
    expect(button('保存并应用同步').disabled).toBe(true)
    expect(host.textContent).toContain('缺少前序变更')
    await click('选择变更包并加入')
    await expect.poll(() => reopen.mock.calls.length).toBe(1)
    expect(calls('sync:join')[0]).toEqual(['sync:join', {
      sourceGrantId: 'dialog:select-sync-package', targetGrantId: 'dialog:select-sync-join-target',
    }])
    expect(reopen).toHaveBeenCalledWith('C:/synthetic/joined')
  })

  it('refreshes an expired backend preview without retrying the apply request', async () => {
    applyResult = async () => {
      preview = { ...basePreview, token: 'arrived-during-apply', changedRecords: 8 }
      return { success: false, error: 'SYNC_PREVIEW_STALE' }
    }
    await mount()
    await click('保存并应用同步')
    await idle()
    expect(calls('sync:apply')).toHaveLength(1)
    expect(reopen).not.toHaveBeenCalled()
    expect(host.textContent).toContain('涉及 8 条记录')
    expect(host.textContent).toContain('已刷新预览')
  })

  it('refuses to apply when an unsaved editor ledger cannot be read', async () => {
    useEditorStore.setState({ draftLedgers: { config: '{"damaged":' } })
    await mount()
    await click('保存并应用同步')
    await idle()
    expect(calls('sync:apply')).toHaveLength(0)
    expect(host.textContent).toContain('无法识别的未保存编辑内容')
    expect(useEditorStore.getState().draftLedgers.config).toBe('{"damaged":')
  })

  it('keeps conflict text and controls inside a narrow phone viewport', async () => {
    await page.viewport(393, 820)
    preview = { ...basePreview, canApply: false, conflicts: [{
      kind: 'draft', id: 'stable-record-'.repeat(12), variants: ['desktop', 'phone'].map((replicaId, index) => ({
        revision: 'revision-' + index, batchId: 'batch-' + index, replicaId, deleted: false, value: '一段需要核对的完整正文。'.repeat(100),
      })),
    }] }
    await mount()
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth)
    for (const input of host.querySelectorAll('input[type="radio"]')) {
      const bounds = input.getBoundingClientRect()
      expect(bounds.left).toBeGreaterThanOrEqual(0)
      expect(bounds.right).toBeLessThanOrEqual(393)
    }
    expect(host.querySelectorAll('.sync-variant pre')).toHaveLength(2)
  })
})
