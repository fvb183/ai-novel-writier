import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { ProjectData } from '../../../shared/ipc-channels'
import type { ProjectAssetPreview } from '../../../shared/project-sync-assets'
import type { SyncPreview, SyncStatus } from '../../../shared/project-sync'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useAgentStore } from '../../../stores/agent-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useProjectSyncOperation } from '../../../stores/project-sync-operation'
import { useLocaleStore } from '../../../stores/locale-store'
import AssetConflictPreview from '../AssetConflictPreview'
import ProjectSyncPanel from '../ProjectSyncPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const session = { projectId: 'asset-review-project', leaseId: 'review-lease', projectPath: 'C:/synthetic/asset-review' }
const project = { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '资料核对' } as ProjectData
const saved = { project: useProjectStore.getState(), editor: useEditorStore.getState(), agent: useAgentStore.getState(), workflow: useWorkflowStore.getState(), locale: useLocaleStore.getState() }
const status: SyncStatus = { enabled: true, projectId: session.projectId, replicaId: 'desktop', localBatches: 1, acknowledgedBatches: 0, pendingBatches: 1, conflicts: 1 }
const conflict = (id = 'asset-id') => ({ kind: 'project-asset', id, variants: ['desktop', 'phone'].map((replicaId, index) => ({ revision: `rev-${index}`, batchId: `batch-${index}`, replicaId, deleted: false, value: { hiddenHashes: 'not a content preview' } })) })
const files = ['skills/story/SKILL.md', 'skills/story/examples/long-example.md']
let preview: SyncPreview, root: Root, host: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>, reopen: ReturnType<typeof vi.fn>
let readAsset: (input: Record<string, unknown>) => Promise<{ success: boolean; preview?: ProjectAssetPreview; error?: string }>
let readStatus: () => Promise<unknown>
const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)
const button = (name: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name)!
const click = async (name: string, scope: ParentNode = host) => { expect(button(name, scope)).toBeTruthy(); await act(async () => button(name, scope).click()) }
const idle = async () => expect.poll(() => host.querySelector('.project-sync-panel')?.getAttribute('aria-busy')).toBe('false')
const firstContent = () => host.querySelector<HTMLElement>('.sync-asset-content')!
function deferred<T>() { let resolve!: (result: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const content = (text: string): ProjectAssetPreview => ({ category: 'files', title: '剧情 Skill', filePaths: files, filePath: files[0], text, offset: 0, nextOffset: 17 })
async function mountPanel() { await act(async () => root.render(<ProjectSyncPanel />)); await idle() }
async function renderSingle(token = 'preview-a', deleted = false) {
  await act(async () => root.render(<AssetConflictPreview key={token} session={session} token={token} assetId="asset-id" revision="rev-0" deleted={deleted} label="版本内容" />))
}

beforeEach(async () => {
  await page.viewport(1024, 768)
  preview = { token: 'preview-a', pendingBatches: 1, changedRecords: 2, canApply: false, missingBatchHashes: [], conflicts: [conflict()] }
  readStatus = async () => ({ success: true, status })
  readAsset = async input => ({ success: true, preview: input.filePath === files[1]
    ? { ...content('独立辅助文件的内容'), filePath: files[1], nextOffset: undefined }
    : input.offset === 17 ? { ...content('第 2 段，保留中文与 emoji 🧭'), offset: 17, nextOffset: undefined }
      : content(`${input.revision === 'rev-1' ? '手机' : '桌面'}的 Skill 正文第 1 段`) })
  reopen = vi.fn(async () => true)
  invoke = vi.fn(async (channel: string, input: Record<string, unknown>) => {
    if (channel === 'drive:auth-status') return { success: true, auth: { platform: 'desktop', available: false, configured: false, authorized: false, persistence: 'none' } }
    if (channel === 'drive:project-status') return { success: true, drive: { bound: false } }
    if (channel === 'sync:status') return readStatus()
    if (channel === 'sync:preview') return { success: true, status, preview }
    if (channel === 'sync:asset-preview') return readAsset(input)
    if (channel === 'sync:apply') return { success: true, applied: { applied: true, appliedBatches: 1, preview: { ...preview, pendingBatches: 0 } } }
    throw new Error(`Unexpected asset-review channel: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: project, openProject: reopen as typeof saved.project.openProject })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useAgentStore.setState({ generating: false }); useWorkflowStore.setState({ activeRuns: [] }); useProjectSyncOperation.setState({ phase: null })
  useLocaleStore.setState({ locale: 'zh-CN' }); setActiveProjectSessionContext(session)
  host = document.createElement('div'); host.className = 'paper-ink stage-shell'; host.style.cssText = 'width:100%;min-width:0;height:852px;overflow:auto'; document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  useProjectStore.setState(saved.project, true); useEditorStore.setState(saved.editor, true); useAgentStore.setState(saved.agent, true)
  useWorkflowStore.setState(saved.workflow, true); useLocaleStore.setState(saved.locale, true); useProjectSyncOperation.setState({ phase: null })
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('read-only asset conflict review', () => {
  it('reads candidate bytes and paginates/files without choosing a version, then applies exactly one explicit radio selection', async () => {
    await mountPanel()
    await expect.poll(() => host.textContent).toContain('桌面的 Skill 正文第 1 段')
    expect(host.textContent).toContain('手机的 Skill 正文第 1 段')
    expect(host.textContent).not.toContain('hiddenHashes')
    expect(host.textContent).toContain('采用时整组选择')
    expect(button('保存并应用同步').disabled).toBe(true)
    await click('下一段', firstContent())
    await expect.poll(() => firstContent().textContent).toContain('第 2 段，保留中文与 emoji 🧭')
    expect(calls('sync:asset-preview').at(-1)?.[1]).toMatchObject({ token: 'preview-a', assetId: 'asset-id', revision: 'rev-0', offset: 17, projectSession: session })
    await click('上一段', firstContent())
    await expect.poll(() => firstContent().textContent).toContain('桌面的 Skill 正文第 1 段')
    await act(async () => { const select = firstContent().querySelector('select')!; select.value = files[1]; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await expect.poll(() => firstContent().textContent).toContain('独立辅助文件的内容')
    expect([...host.querySelectorAll<HTMLInputElement>('input[type=radio]')].every(input => !input.checked)).toBe(true)
    expect(button('保存并应用同步').disabled).toBe(true)
    expect(host.querySelector('.sync-asset-content')?.closest('label')).toBeNull()
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click())
    await click('保存并应用同步')
    await expect.poll(() => reopen.mock.calls.length).toBe(1)
    expect(calls('sync:apply')).toEqual([['sync:apply', { projectSession: session, token: 'preview-a', resolutions: [{ kind: 'project-asset', id: 'asset-id', expectedHeads: ['rev-0', 'rev-1'], selectedRevision: 'rev-1' }] }]])
  })

  it('ignores late content from an older preview token after the user refreshes', async () => {
    const old = deferred<{ success: boolean; preview: ProjectAssetPreview }>()
    readAsset = input => input.token === 'preview-a' ? old.promise : Promise.resolve({ success: true, preview: content('新预览的资料') })
    await mountPanel(); await expect.poll(() => calls('sync:asset-preview').length).toBe(2)
    preview = { ...preview, token: 'preview-b' }
    await click('刷新状态'); await idle()
    await expect.poll(() => host.textContent).toContain('新预览的资料')
    await act(async () => old.resolve({ success: true, preview: content('不得显示的旧资料') }))
    expect(host.textContent).not.toContain('不得显示的旧资料')
    expect([...host.querySelectorAll<HTMLInputElement>('input[type=radio]')].every(input => !input.checked)).toBe(true)
    expect(calls('sync:apply')).toHaveLength(0)
  })

  it('discards a late read after its originating lease is invalidated and keeps author input', async () => {
    const old = deferred<{ success: boolean; preview: ProjectAssetPreview }>()
    readAsset = () => old.promise
    useEditorStore.setState({ draftLedgers: { fixture: '未保存的独立输入' } })
    await renderSingle(); expect(calls('sync:asset-preview')[0][1]).toMatchObject({ projectSession: session })
    await act(async () => { setActiveProjectSessionContext({ ...session, leaseId: 'replacement-lease' }); old.resolve({ success: true, preview: content('旧会话资料不可显示') }) })
    expect(host.textContent).not.toContain('旧会话资料不可显示')
    expect(useEditorStore.getState().draftLedgers.fixture).toBe('未保存的独立输入')
    expect(calls('sync:apply')).toHaveLength(0)
  })

  it('explains a backend-stale preview without retrying or selecting a version', async () => {
    readAsset = async () => ({ success: false, error: 'SYNC_PREVIEW_STALE' })
    await mountPanel(); await expect.poll(() => host.textContent).toContain('同步预览已变化，请刷新状态后重新核对')
    expect(button('保存并应用同步').disabled).toBe(true)
    expect(calls('sync:asset-preview')).toHaveLength(2)
    expect(calls('sync:apply')).toHaveLength(0)
  })

  it('labels partial knowledge evidence and an index awaiting rebuild without implying the original is present', async () => {
    readAsset = async () => ({ success: true, preview: { category: 'knowledge', title: '知识资料', text: '仅存的规范分块', document: { corpusKind: 'partial_arch', chunkCount: 3, originalAvailable: false, indexDirty: true } } })
    await renderSingle(); await expect.poll(() => host.textContent).toContain('仅存的规范分块')
    expect(host.textContent).toContain('原文不可用，仅分块预览')
    expect(host.textContent).toContain('原文已修改，尚未重建索引')
    expect(host.querySelectorAll('textarea,[contenteditable=true]')).toHaveLength(0)
  })

  it('renders an avatar image and displays an explicit empty file rather than a hash summary', async () => {
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMhkAAAAASUVORK5CYII='
    readAsset = async () => ({ success: true, preview: { category: 'avatar', title: '人物头像', image: { mime: 'image/png', base64: pixel } } })
    await renderSingle(); await expect.poll(() => host.querySelector('img')?.src).toBe(`data:image/png;base64,${pixel}`)
    readAsset = async () => ({ success: true, preview: { category: 'files', title: '空白辅助文件', filePath: 'skills/story/empty.txt', byteSize: 0, text: '' } })
    await renderSingle('preview-b'); await expect.poll(() => host.textContent).toContain('（空文件）')
    expect(host.querySelector('img')).toBeNull()
  })

  it('keeps a deletion candidate readable without requesting absent file bytes', async () => {
    await renderSingle('preview-a', true)
    expect(host.textContent).toContain('此版本删除这项资产')
    expect(calls('sync:asset-preview')).toHaveLength(0)
  })

  it('reuses status refresh to recover local assets without applying inbox updates or adding a duplicate recovery action', async () => {
    let first = true
    readStatus = async () => { if (first) { first = false; return { success: false, error: 'PROJECT_SYNC_ASSET_NOT_READY' } } return { success: true, status } }
    await mountPanel()
    expect(host.textContent).toContain('不会应用待收更新')
    expect(button('重试恢复资料')).toBeTruthy()
    expect(button('刷新状态')).toBeUndefined()
    await click('重试恢复资料'); await idle()
    expect(button('刷新状态')).toBeTruthy()
    expect(button('重试恢复资料')).toBeUndefined()
    expect(calls('sync:status')).toHaveLength(2)
    expect(calls('sync:recover-assets')).toHaveLength(0)
    expect(calls('sync:apply')).toHaveLength(0)
  })

  it('explains an adopted update with pending local recovery and recovers without applying the same records twice', async () => {
    const handler = invoke.getMockImplementation() as (channel: string, input: Record<string, unknown>) => Promise<unknown>
    invoke.mockImplementation(async (channel: string, input: Record<string, unknown>) => {
      if (channel !== 'sync:apply') return handler(channel, input)
      preview = { ...preview, pendingBatches: 0, conflicts: [], canApply: false }
      return { success: true, status: { ...status, pendingBatches: 0, conflicts: 0 }, preview,
        applied: { applied: true, appliedBatches: 1, preview, assetsPending: true, assetsError: 'PROJECT_SYNC_ASSET_WRITE_FAILED' } }
    })
    await mountPanel(); await expect.poll(() => host.textContent).toContain('桌面的 Skill 正文')
    await act(async () => host.querySelector<HTMLInputElement>('input[type=radio]')!.click())
    await click('保存并应用同步'); await idle()
    expect(host.textContent).toContain('同步记录已采用，本机资料仍待恢复')
    expect(host.textContent).toContain('不要再次应用相同更新')
    await click('重试恢复资料'); await idle()
    expect(calls('sync:apply')).toHaveLength(1)
    expect(button('保存并应用同步').disabled).toBe(true)
    expect(button('刷新状态')).toBeTruthy()
  })

  it.each([
    ['PROJECT_SYNC_ASSET_INVALID', '项目资料校验未通过'],
    ['PROJECT_SYNC_ASSET_INLINE_INVALID', '资料不完整或编码无效'],
    ['SYNC_INLINE_ASSET_INVALID', '资料不完整或编码无效'],
    ['PROJECT_SYNC_ASSET_HASH_MISMATCH', '资料未通过完整性校验'],
    ['SYNC_PACKAGE_TOO_LARGE', '64 MiB 总上限'],
    ['SYNC_READER_FEATURE_REQUIRED', '项目同步能力标记'],
  ])('explains %s in the existing sync notice', async (error, expected) => {
    readStatus = async () => ({ success: false, error })
    await mountPanel()
    expect(host.querySelector('.project-sync-panel > [role=alert]')?.textContent).toContain(expected)
    expect(host.querySelector('.project-sync-panel > [role=alert]')?.textContent).not.toContain(error)
  })

  it('keeps read-only files, warnings, pagination and explicit radios inside a 393px layout', async () => {
    await page.viewport(393, 852)
    preview = { ...preview, conflicts: [conflict('long-asset-'.repeat(10))] }
    readAsset = async input => ({ success: true, preview: input.revision === 'rev-0' ? { ...content('中文资料需要逐项核对。'.repeat(36)), filePaths: [files[0], `skills/story/${'long-file-name-'.repeat(12)}.md`] }
      : { category: 'knowledge', title: '仅有历史分块的知识资料', text: '仍可核对的规范内容。'.repeat(20), document: { corpusKind: 'partial_arch', chunkCount: 4, originalAvailable: false, indexDirty: true } } })
    await mountPanel(); await expect.poll(() => host.textContent).toContain('仍可核对的规范内容')
    const panel = host.querySelector<HTMLElement>('.sync-preview')!
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1)
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1)
    for (const control of panel.querySelectorAll('input,select,button')) {
      const box = control.getBoundingClientRect()
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(393)
    }
    host.scrollTop = panel.offsetTop
    await page.screenshot({ path: '../../../../.runtime/asset-conflict-phone.png', element: host })
    host.scrollTop += Math.floor(host.clientHeight * 0.75)
    await page.screenshot({ path: '../../../../.runtime/asset-conflict-phone-detail.png', element: host })
    expect(calls('sync:apply')).toHaveLength(0)
  })
})
