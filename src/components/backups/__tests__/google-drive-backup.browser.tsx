import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import GoogleDriveBackupSection from '../GoogleDriveBackupSection'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import type { DriveBackupGeneration } from '../../../shared/google-drive-backup'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const session = { projectId: '11111111-1111-4111-8111-111111111111', projectPath: 'C:/synthetic/drive-backup', leaseId: 'backup-lease' }
const generation: DriveBackupGeneration = { generationId: '22222222-2222-4222-8222-222222222222', parentGenerationIds: [], createdAt: '2026-10-29T00:00:00Z', originProjectId: session.projectId, snapshotGeneration: '33333333-3333-4333-8333-333333333333', archiveSha256: 'a'.repeat(64), archiveByteSize: 1024, archiveFileId: 'archive', manifestFileId: 'manifest', siblingGenerationIds: [] }
const previous = useProjectStore.getState()
let root: Root, host: HTMLDivElement, invoke: ReturnType<typeof vi.fn>
let prepare = vi.fn(async () => {})
const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)
const click = (name: string) => act(async () => page.getByRole('button', { name, exact: true }).click())
const consent = () => act(async () => page.getByRole('checkbox', { name: '我确认将完整项目快照备份到当前 Google Drive' }).click())
async function mount() { await act(async () => root.render(<GoogleDriveBackupSection session={session} name="合成测试" disabled={false} onBeforeBackup={prepare} />)) }
beforeEach(async () => {
  await page.viewport(1024, 768)
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId } as ProjectData })
  setActiveProjectSessionContext(session); useLocaleStore.setState({ locale: 'zh-CN' })
  prepare = vi.fn(async () => {})
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'dialog:select-project-restore-target') return { grantId: 'synthetic-target' }
    if (channel === 'drive:backup-restore') return { success: true, projectPath: 'C:/synthetic/independent-copy', targetProjectId: 'new-project' }
    return { success: true, generations: [generation] }
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  host = document.createElement('div'); host.className = 'paper-ink stage-shell'; host.style.width = '100%'; document.body.append(host); root = createRoot(host)
  await mount()
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setActiveProjectSessionContext(null); useProjectStore.setState(previous, true); Reflect.deleteProperty(window, 'aiNovelAPI') })
describe('Google Drive history uses the existing account and independent restore', () => {
  it('requires explicit disclosure and saves before creating a generation with selected parents', async () => {
    await expect.element(page.getByRole('button', { name: '保存并备份到 Drive' })).toBeDisabled()
    expect(calls('drive:connect')).toHaveLength(0)
    await click('读取 Drive 历史备份'); await consent(); await click('保存并备份到 Drive')
    expect(prepare).toHaveBeenCalledOnce()
    expect(calls('drive:backup-create')[0][1]).toMatchObject({ projectSession: session, parentGenerationIds: [generation.generationId] })
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[invoke.mock.calls.findIndex(call => call[0] === 'drive:backup-create')])
  })
  it('restores through a destination grant as a new identity without joining or switching the open project', async () => {
    await click('读取 Drive 历史备份'); await click('恢复所选备份为独立新项目')
    expect(calls('drive:backup-restore')[0][1]).toMatchObject({ generationId: generation.generationId, targetGrantId: 'synthetic-target', projectSession: session })
    expect(calls('drive:join')).toHaveLength(0)
    expect(useProjectStore.getState().currentProject?.id).toBe(session.projectId)
    await expect.element(page.getByRole('status')).toHaveTextContent('独立新项目')
  })
  it('retains the operation identity after an unknown result and resumes without resaving a changed snapshot', async () => {
    let first = true
    invoke.mockImplementation(async (channel: string) => channel === 'drive:backup-create' && first ? (first = false, { success: false, error: 'DRIVE_UPLOAD_UNCONFIRMED' }) : { success: true, generations: [generation] })
    await consent(); await click('保存并备份到 Drive'); await click('继续未完成的 Drive 备份')
    expect(calls('drive:backup-create')[0][1].operationId).toBe(calls('drive:backup-create')[1][1].operationId)
    expect(prepare).toHaveBeenCalledOnce()
  })
  it('cancels active work and ignores its late response after unmount', async () => {
    let finish!: (value: unknown) => void
    invoke.mockImplementation(async (channel: string) => channel === 'drive:backup-create' ? new Promise(resolve => { finish = resolve }) : { success: true })
    await consent(); await click('保存并备份到 Drive')
    const operationId = calls('drive:backup-create')[0][1].operationId
    await click('取消备份操作')
    expect(calls('drive:backup-cancel')[0][1]).toEqual({ operationId })
    await act(async () => root.render(<div>其他项目</div>))
    await act(async () => finish({ success: true, projectPath: 'late-copy' }))
    expect(host.textContent).toBe('其他项目')
  })
  it('fits the history controls in a narrow phone viewport', async () => {
    await page.viewport(393, 851); await click('读取 Drive 历史备份')
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1)
    await page.screenshot({ path: '../../../../.runtime/drive-backup-phone.png', element: host })
  })
})
