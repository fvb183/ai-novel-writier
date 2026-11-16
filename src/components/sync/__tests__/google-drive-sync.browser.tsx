import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { page } from 'vitest/browser'
import type { ProjectData } from '../../../shared/ipc-channels'
import type { GoogleDriveAuthStatus, GoogleDriveResponse } from '../../../shared/google-drive-sync'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useDriveSyncStore } from '../../../stores/drive-sync-store'
import DriveBookToggle from '../DriveBookToggle'
import GoogleDriveSyncSection, { type GoogleDriveSyncSectionProps } from '../GoogleDriveSyncSection'
import { GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED } from '../google-drive-sync-events'
import '../project-sync.css'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const session = { projectId: 'drive-project', leaseId: 'drive-lease', projectPath: 'C:/synthetic/drive' }
const project = { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '本机作品' } as ProjectData
const saved = { project: useProjectStore.getState(), locale: useLocaleStore.getState(), editor: useEditorStore.getState() }
const preview = { token: 'cloud-preview', pendingBatches: 1, changedRecords: 2, missingBatchHashes: [], conflicts: [], canApply: true }
let auth: GoogleDriveAuthStatus, bound: boolean, autoSync: boolean, root: Root, host: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>, reopen: ReturnType<typeof vi.fn>
let onPreview: Mock<(result: GoogleDriveResponse) => void>, before: Mock<() => Promise<void>>
let exchange: () => Promise<GoogleDriveResponse>, connecting: () => Promise<GoogleDriveResponse>, cancelling: () => Promise<GoogleDriveResponse>
const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name)!
const click = async (name: string) => { expect(button(name)).toBeTruthy(); await act(async () => button(name).click()) }
const idle = async () => { await expect.poll(() => host.querySelector('section')?.getAttribute('aria-busy')).toBe('false') }
const select = async (id: string) => act(async () => { const input = host.querySelector<HTMLSelectElement>('select[aria-label="云端作品"]')!; input.value = id; input.dispatchEvent(new Event('change', { bubbles: true })) })
async function mount(overrides: Partial<GoogleDriveSyncSectionProps> = {}) {
  await act(async () => root.render(<GoogleDriveSyncSection session={session} name={project.name} onPreview={onPreview} onBeforeExchange={before} {...overrides} />))
  await idle()
}
beforeEach(async () => {
  await page.viewport(1024, 768)
  auth = { platform: 'desktop', available: true, configured: true, authorized: false, clientId: 'synthetic.apps.googleusercontent.com', persistence: 'os-backed' }
  bound = false; autoSync = false
  onPreview = vi.fn(); before = vi.fn(async () => {}); reopen = vi.fn(async () => false)
  exchange = async () => ({ success: true, drive: { bound: true, folderId: 'cloud-current' }, preview, uploaded: true, downloaded: 1 })
  connecting = async () => { auth = { ...auth, authorized: true }; return { success: true, auth } }
  cancelling = async () => ({ success: true })
  invoke = vi.fn(async (channel: string, input: Record<string, unknown>) => {
    if (channel === 'project:recent-list') return []
    if (channel === 'drive:auth-status') return { success: true, auth }
    if (channel === 'drive:project-status') return { success: true, drive: { bound, autoSync, ...(bound ? { folderId: 'cloud-current' } : {}) } }
    if (channel === 'drive:set-auto-sync') { autoSync = input.enabled as boolean; return { success: true, drive: { bound, autoSync, folderId: 'cloud-current' } } }
    if (channel === 'drive:configure') { auth = { ...auth, configured: true, clientId: input.clientId as string,
      ...(input.clientSecret !== undefined ? { clientSecretConfigured: Boolean(input.clientSecret), authorized: false } : {}) }; return { success: true, auth } }
    if (channel === 'drive:connect') return connecting()
    if (channel === 'drive:cancel-auth') return cancelling()
    if (channel === 'drive:disconnect') { auth = { ...auth, authorized: false }; return { success: true, auth } }
    if (channel === 'drive:list-projects') return { success: true, projects: [
      { folderId: 'cloud-current', projectId: session.projectId, name: '本机作品的云端副本' },
      { folderId: 'cloud-other', projectId: 'other-project', name: '另一部作品' },
    ] }
    if (channel === 'drive:bind') { bound = true; return { success: true, drive: { bound, folderId: (input.folderId as string) || 'cloud-created' } } }
    if (channel === 'drive:exchange') return exchange()
    if (channel === 'dialog:select-sync-join-target') return { grantId: 'selected-new-directory', displayName: '新目录' }
    if (channel === 'drive:join') return { success: true, projectPath: 'C:/synthetic/joined' }
    throw new Error(`Unexpected cloud UI channel: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: project, openProject: reopen as typeof saved.project.openProject })
  useLocaleStore.setState({ locale: 'zh-CN' }); setActiveProjectSessionContext(session)
  useEditorStore.setState({ tabs: [{ id: 'dirty', type: 'chapter', name: '原稿', projectKey: session.projectPath, content: '本地未保存稿', savedContent: '已保存稿', dirty: true, contentRevision: 2 }], activeTabId: 'dirty' })
  host = document.createElement('div'); host.className = 'paper-ink project-sync-panel'; host.style.width = '100%'; document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); setActiveProjectSessionContext(null)
  useProjectStore.setState(saved.project, true); useLocaleStore.setState(saved.locale, true); useEditorStore.setState(saved.editor, true)
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('Google Drive sync user flow', () => {
  it('explains unconfigured OAuth without blocking local content or asking for tokens', async () => {
    auth = { ...auth, configured: false, clientId: '' }
    await mount()
    expect(host.textContent).toContain('本地写作可离线使用')
    expect(host.textContent).toContain('尚未完成 Google 应用配置')
    expect(host.querySelector('details')?.open).toBe(true)
    expect(host.querySelectorAll('input')).toHaveLength(2)
    expect(host.querySelector('input')?.getAttribute('aria-label')).toBe('Desktop OAuth 客户端 ID')
    expect(host.querySelector('input[type="password"]')).toBeTruthy()
    expect(button('连接 Google 账户').disabled).toBe(true)
    expect(calls('drive:connect')).toHaveLength(0)
    expect(calls('drive:list-projects')).toHaveLength(0)
    expect(useEditorStore.getState().tabs[0].content).toBe('本地未保存稿')
  })
  it('saves only the public client ID and waits for the authorization receipt', async () => {
    auth = { ...auth, configured: false, clientId: '' }
    await mount()
    const input = host.querySelector<HTMLInputElement>('input')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'desktop-client.apps.googleusercontent.com'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click('保存 Google 应用配置'); await idle()
    expect(calls('drive:configure')[0]).toEqual(['drive:configure', { clientId: 'desktop-client.apps.googleusercontent.com' }])
    await click('连接 Google 账户'); await idle()
    expect(calls('drive:connect')[0]).toEqual(['drive:connect'])
    expect(host.textContent).toContain('Google 账户已连接')
  })
  it('can cancel a pending explicit authorization without inventing a connected state', async () => {
    let finish!: (value: GoogleDriveResponse) => void
    connecting = () => new Promise(resolve => { finish = resolve })
    cancelling = async () => { finish({ success: false, error: 'GOOGLE_AUTH_CANCELLED', auth }); return { success: true } }
    await mount(); await click('连接 Google 账户')
    expect(host.textContent).not.toContain('Google 账户已连接')
    await click('取消 Google 授权'); await idle()
    expect(calls('drive:cancel-auth')).toHaveLength(1)
    expect(host.textContent).toContain('已取消 Google 授权')
    expect(calls('drive:list-projects')).toHaveLength(0)
  })
  it('saves an optional desktop secret only on explicit save and clears the masked input without echoing it', async () => {
    auth = { ...auth, configured: false, clientId: '' }
    await mount()
    const id = host.querySelector<HTMLInputElement>('input[aria-label="Desktop OAuth 客户端 ID"]')!
    const password = host.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(id, 'desktop-client.apps.googleusercontent.com'); id.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(password, 'SYNTHETIC_UI_SECRET'); password.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(calls('drive:configure')).toHaveLength(0)
    await click('保存 Google 应用配置'); await idle()
    expect(calls('drive:configure')[0]).toEqual(['drive:configure', { clientId: 'desktop-client.apps.googleusercontent.com', clientSecret: 'SYNTHETIC_UI_SECRET' }])
    expect(password.value).toBe('')
    expect(host.textContent).not.toContain('SYNTHETIC_UI_SECRET')
    expect(host.textContent).toContain('客户端密钥已设置')
    await click('移除客户端密钥'); await idle()
    expect(calls('drive:configure').at(-1)).toEqual(['drive:configure', { clientId: 'desktop-client.apps.googleusercontent.com', clientSecret: '' }])
    expect(auth.clientSecretConfigured).toBe(false)
  })
  it('retains completed authorization and explains a failed Drive check without restarting login or transferring', async () => {
    connecting = async () => {
      auth = { ...auth, authorized: true }
      return { success: false, error: 'DRIVE_NETWORK_FAILED', auth }
    }
    await mount(); await click('连接 Google 账户'); await idle()
    expect(host.textContent).toContain('Google 账户已连接')
    expect(host.querySelector('[role=alert]')?.textContent).toContain('授权已完成，但云端访问检查未通过')
    expect(host.querySelector('[role=alert]')?.textContent).toContain('暂时无法访问 Google Drive')
    expect(button('连接 Google 账户')).toBeUndefined()
    expect(button('读取云端作品').disabled).toBe(false)
    expect(calls('drive:connect')).toHaveLength(1)
    expect(calls('drive:list-projects')).toHaveLength(0)
    expect(calls('drive:exchange')).toHaveLength(0)
    expect(onPreview).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs[0].content).toBe('本地未保存稿')
  })
  it.each([
    ['GOOGLE_CLIENT_REJECTED', 'Desktop 客户端 ID'],
    ['GOOGLE_AUTH_REQUEST_REJECTED', '授权码兑换请求'],
    ['GOOGLE_CLIENT_SECRET_REQUIRED', 'client_secret'],
    ['GOOGLE_CLIENT_SECRET_INVALID', '客户端密钥格式无效'],
    ['GOOGLE_AUTH_SCOPE_INVALID', '授权范围'],
    ['GOOGLE_AUTH_RESPONSE_INVALID', '有效的授权结果'],
    ['GOOGLE_AUTH_INTERRUPTED', '授权流程中断'],
    ['GOOGLE_AUTH_RESULT_MISSING', '完整的授权结果'],
    ['GOOGLE_OAUTH_CONFIGURATION_REQUIRED', '包名与签名 SHA-1'],
    ['GOOGLE_NETWORK_ERROR', '网络及 VPN'],
    ['GOOGLE_PLAY_SERVICES_CONNECTION_FAILED', '连接中断或正在更新'],
    ['GOOGLE_PLAY_SERVICES_ERROR', 'Google Play 服务暂时出错'],
    ['GOOGLE_ACCOUNT_INVALID', '系统设置'],
  ])('explains authorization failure %s without treating it as user cancellation', async (error, expected) => {
    auth = { platform: 'android', available: true, configured: true, authorized: false, persistence: 'google-play-services' }
    connecting = async () => ({ success: false, error })
    await mount({ session: null }); await click('连接 Google 账户'); await idle()
    expect(host.querySelector('[role=alert]')?.textContent).toContain(expected)
    expect(host.querySelector('[role=alert]')?.textContent).not.toContain('已取消')
    expect(host.querySelector('[role=alert]')?.textContent).toContain(error)
    expect(host.textContent).not.toContain('Google 账户已连接')
    expect(button('连接 Google 账户').disabled).toBe(false)
    expect(calls('drive:exchange')).toHaveLength(0)
    expect(calls('drive:configure')).toHaveLength(0)
  })
  it('creates a cloud association with the captured local project lease', async () => {
    auth.authorized = true
    await mount(); await click('关联当前作品'); await idle()
    expect(calls('drive:project-status')[0]).toEqual(['drive:project-status', { projectSession: session }])
    expect(calls('drive:bind')[0]).toEqual(['drive:bind', { name: '本机作品', projectSession: session }])
    expect(host.textContent).toContain('当前本地作品已关联云端')
  })
  it('separates linking the same book from joining a different cloud book', async () => {
    auth.authorized = true
    await mount(); await click('读取云端作品'); await idle(); await select('cloud-other')
    expect(button('关联当前作品').disabled).toBe(true)
    expect(button('在新目录加入所选作品').disabled).toBe(false)
    expect(host.textContent).toContain('所选云端项目属于另一部作品')
    await select('cloud-current'); await click('关联当前作品'); await idle()
    expect(calls('drive:bind')[0]).toEqual(['drive:bind', { folderId: 'cloud-current', name: '本机作品', projectSession: session }])
  })
  it('joins through a new-directory grant and the normal input-preserving project transition', async () => {
    auth.authorized = true
    await mount(); await click('读取云端作品'); await idle(); await select('cloud-other'); await click('在新目录加入所选作品'); await idle()
    expect(calls('dialog:select-sync-join-target')[0]).toEqual(['dialog:select-sync-join-target', '另一部作品'])
    expect(calls('drive:join')[0]).toEqual(['drive:join', { folderId: 'cloud-other', targetGrantId: 'selected-new-directory' }])
    expect(reopen).toHaveBeenCalledWith('C:/synthetic/joined')
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '本地未保存稿', dirty: true })
    expect(host.textContent).toContain('尚未切换，可稍后打开')
  })
  it('does not transfer if saving local input fails', async () => {
    auth.authorized = true; bound = true; before.mockRejectedValue(new Error('synthetic save failure'))
    await mount(); await click('保存并传输云端变更'); await idle()
    expect(host.textContent).toContain('本地内容尚未保存，已停止云端传输')
    expect(calls('drive:exchange')).toHaveLength(0)
    expect(onPreview).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
  })
  it('saves first and hands downloaded changes to the single existing preview instead of auto-applying', async () => {
    auth.authorized = true; bound = true
    const order: string[] = []
    before.mockImplementation(async () => { order.push('save') })
    exchange = async () => { order.push('exchange'); return { success: true, preview, uploaded: true, downloaded: 1 } }
    await mount(); await click('保存并传输云端变更'); await idle()
    expect(order).toEqual(['save', 'exchange'])
    expect(calls('drive:exchange')[0]).toEqual(['drive:exchange', { projectSession: session }])
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ success: true, preview }))
    expect(calls('sync:apply')).toHaveLength(0)
    expect(reopen).not.toHaveBeenCalled()
    expect(host.textContent).toContain('请在下方预览中核对并应用')
  })
  it('stops an old-project transfer if the lease changes while saving', async () => {
    auth.authorized = true; bound = true
    let finish!: () => void
    before.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    await mount(); await click('保存并传输云端变更')
    await act(async () => { setActiveProjectSessionContext({ ...session, leaseId: 'replacement-lease' }); finish() })
    expect(calls('drive:exchange')).toHaveLength(0)
    expect(onPreview).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs[0].content).toBe('本地未保存稿')
  })
  it('shows an expired authorization as disconnected and retains local text', async () => {
    auth.authorized = true; bound = true
    exchange = async () => ({ success: false, error: 'GOOGLE_AUTH_REQUIRED' })
    await mount(); await click('保存并传输云端变更'); await idle()
    expect(host.textContent).toContain('请先连接 Google 账户')
    expect(host.textContent).not.toContain('Google 账户已连接')
    expect(button('连接 Google 账户')).toBeTruthy()
    expect(onPreview).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs[0].content).toBe('本地未保存稿')
  })
  it.each([
    ['DRIVE_PREPARE_FAILED', '读取或整理本地作品资料时失败'],
    ['DRIVE_LOCAL_ACCESS_DENIED', '系统拒绝了同步所需的本地文件操作'],
    ['DRIVE_LOCAL_STORAGE_FULL', '本地存储空间不足'],
    ['DRIVE_REQUEST_TIMEOUT', '连接 Google Drive 超时'],
    ['DRIVE_SYNC_TIMEOUT', '本次同步等待超时'],
    ['DRIVE_CANCELLED', '本次云端操作已停止'],
    ['PROJECT_SYNC_ASSET_MISSING_BYTES', '资料文件尚未收齐'],
    ['PROJECT_SYNC_ASSET_SOURCE_CHANGED', '资料在读取期间发生变化'],
    ['SYNC_INLINE_ASSET_INVALID', '资料不完整或编码无效'],
    ['SYNC_READER_FEATURE_REQUIRED', '项目同步能力标记'],
  ])('explains sync failure %s with a safe diagnostic code and without applying', async (error, expected) => {
    auth.authorized = true; bound = true
    exchange = async () => ({ success: false, error })
    await mount(); await click('保存并传输云端变更'); await idle()
    expect(host.querySelector('[role=alert]')?.textContent).toContain(expected)
    expect(host.querySelector('[role=alert]')?.textContent).toContain(error)
    expect(calls('sync:apply')).toHaveLength(0)
    expect(useEditorStore.getState().tabs[0].content).toBe('本地未保存稿')
  })
  it('supports projectless cloud joining without a fake local project session', async () => {
    auth.authorized = true
    setActiveProjectSessionContext(null)
    await mount({ session: null }); await click('读取云端作品'); await idle(); await select('cloud-current'); await click('在新目录加入所选作品'); await idle()
    expect(calls('drive:project-status')).toHaveLength(0)
    expect(calls('drive:join')[0][1]).not.toHaveProperty('projectSession')
    expect(reopen).toHaveBeenCalledWith('C:/synthetic/joined')
  })
  it('uses Android package and signing guidance without a desktop client or token form', async () => {
    auth = { platform: 'android', available: true, configured: false, authorized: false, persistence: 'google-play-services' }
    await mount()
    expect(host.textContent).toContain('Android 应用的包名与签名 SHA-1')
    expect(host.querySelectorAll('input')).toHaveLength(0)
    expect(button('连接 Google 账户').disabled).toBe(true)
    expect(calls('drive:configure')).toHaveLength(0)
  })
  it('keeps cloud setup and controls within a 393px screen', async () => {
    await page.viewport(393, 852)
    auth = { ...auth, configured: false, clientId: '' }
    await mount()
    const box = host.getBoundingClientRect()
    expect(host.scrollWidth).toBeLessThanOrEqual(Math.ceil(box.width) + 1)
    expect(host.querySelector('section')!.getBoundingClientRect().right).toBeLessThanOrEqual(393)
    expect(button('连接 Google 账户').getBoundingClientRect().width).toBeGreaterThanOrEqual(140)
  })
  it('persists explicit foreground opt-in and broadcasts only the captured project session', async () => {
    auth.authorized = true; bound = true
    const changed = vi.fn()
    window.addEventListener(GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED, changed)
    try {
      await mount()
      const checkbox = () => host.querySelector<HTMLInputElement>('.sync-auto-check input')!
      expect(checkbox().checked).toBe(false)
      expect(host.textContent).toContain('无冲突时自动应用')
      await act(async () => checkbox().click()); await idle()
      expect(checkbox().checked).toBe(true)
      expect(calls('drive:set-auto-sync')[0]).toEqual(['drive:set-auto-sync', { enabled: true, projectSession: session }])
      expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({ projectSession: session })
      expect(before).not.toHaveBeenCalled()
      expect(calls('drive:exchange')).toHaveLength(0)
      expect(useEditorStore.getState().tabs[0].content).toBe('本地未保存稿')
    } finally { window.removeEventListener(GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED, changed) }
  })
  it('can turn off foreground checks without reconnecting an unavailable account', async () => {
    bound = true; autoSync = true; auth.authorized = false
    await mount()
    const checkbox = host.querySelector<HTMLInputElement>('.sync-auto-check input')!
    expect(checkbox.checked).toBe(true)
    await act(async () => checkbox.click()); await idle()
    expect(calls('drive:set-auto-sync')[0][1]).toMatchObject({ enabled: false, projectSession: session })
    expect(calls('drive:connect')).toHaveLength(0)
    expect(calls('drive:exchange')).toHaveLength(0)
  })
})

// The library switch uses the same backend path without a project-opening flow.
describe('per-book shelf switch',()=>{
  it('keeps the saved opt-in after failure and clears its old error after a successful automatic retry',async()=>{
    invoke.mockImplementation(async(channel:string)=>channel==='drive:local-projects'
      ?{success:true,localProjects:[{path:session.projectPath,enabled:true}]}:{success:false,error:'DRIVE_REQUEST_TIMEOUT'})
    useDriveSyncStore.setState({projects:{},phase:'idle',lastChecked:null})
    await act(async()=>root.render(<DriveBookToggle path={session.projectPath}/>))
    await act(async()=>host.querySelector<HTMLInputElement>('input')!.click())
    expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
    expect(host.querySelector('[role=alert]')?.textContent).toContain('DRIVE_REQUEST_TIMEOUT')
    await act(async()=>useDriveSyncStore.setState({phase:'idle',lastChecked:Date.now()+1000}))
    expect(host.querySelector('[role=alert]')).toBeNull()
    useDriveSyncStore.setState({projects:{},phase:'idle',lastChecked:null})
  })
  it('shows a safe diagnostic code and retry advice when a first upload fails',async()=>{
    invoke.mockImplementation(async()=>({success:false,error:'DRIVE_REQUEST_TIMEOUT'}))
    await act(async()=>root.render(<DriveBookToggle path={session.projectPath}/>))
    await act(async()=>host.querySelector<HTMLInputElement>('input')!.click())
    const message=host.querySelector('[role=alert]')?.textContent
    expect(message).toContain('DRIVE_REQUEST_TIMEOUT');expect(message).toContain('超时')
    expect(host.querySelector<HTMLInputElement>('input')!.disabled).toBe(false)
    expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(false)
  })
  it('never displays raw native errors that can contain credentials or paths',async()=>{
    invoke.mockImplementation(async()=>{throw new Error('Bearer synthetic-private-token /data/user/0/private-file')})
    await act(async()=>root.render(<DriveBookToggle path={session.projectPath}/>))
    await act(async()=>host.querySelector<HTMLInputElement>('input')!.click())
    const message=host.querySelector('[role=alert]')?.textContent
    expect(message).toContain('DRIVE_OPERATION_FAILED')
    expect(message).not.toContain('synthetic-private-token');expect(message).not.toContain('/data/')
  })
  it('enables an unbound current novel with one action and its captured session',async()=>{
    const previous=invoke.getMockImplementation()! as (channel:string,input:Record<string,unknown>)=>Promise<unknown>
    invoke.mockImplementation(async(channel,input)=>channel==='drive:toggle-project'?{success:true,drive:{bound:true,autoSync:true}}:channel==='drive:local-projects'?{success:true,localProjects:[{path:session.projectPath,enabled:true}]}:previous(channel,input))
    host=document.createElement('div');document.body.append(host);root=createRoot(host)
    await act(async()=>root.render(<DriveBookToggle path={session.projectPath}/>))
    await act(async()=>host.querySelector<HTMLInputElement>('input')!.click())
    await expect.poll(()=>host.querySelector<HTMLInputElement>('input')?.checked).toBe(true)
    expect(calls('drive:toggle-project')[0][1]).toMatchObject({path:session.projectPath,enabled:true,projectSession:session})
    expect(calls('project:open')).toHaveLength(0);expect(calls('drive:join')).toHaveLength(0);expect(calls('dialog:select-sync-join-target')).toHaveLength(0)
  })
  it('asks to configure Google for a different shelf book without switching the current editor',async()=>{
    invoke.mockImplementation(async()=>({success:false,error:'GOOGLE_AUTH_REQUIRED'}))
    host=document.createElement('div');document.body.append(host);root=createRoot(host)
    await act(async()=>root.render(<DriveBookToggle path="D:/synthetic/other-book"/>))
    await act(async()=>host.querySelector<HTMLInputElement>('input')!.click())
    expect(host.querySelector('[role=alert]')?.textContent).toContain('连接 Google 账户')
    expect(calls('drive:toggle-project')[0][1]).not.toHaveProperty('projectSession');expect(reopen).not.toHaveBeenCalled()
  })
})
