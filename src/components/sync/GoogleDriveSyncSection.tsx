import { useEffect, useRef, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import type { GoogleDriveAuthStatus, GoogleDriveProject, GoogleDriveProjectStatus, GoogleDriveResponse } from '../../shared/google-drive-sync'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { Button } from '../ui/Button'
import { announceGoogleDriveSyncPreference } from './google-drive-sync-events'
import GoogleDriveBackupSection from '../backups/GoogleDriveBackupSection'
import { driveMessage } from './drive-error-message'
import ModelSettingsSyncSection from './ModelSettingsSyncSection'
import { drivePathKey, useDriveSyncStore } from '../../stores/drive-sync-store'

export interface GoogleDriveSyncSectionProps {
  session: ProjectSessionContext | null
  name: string
  onPreview(result: GoogleDriveResponse): void
  onBeforeExchange?(): Promise<void>
  modelSettingsOnly?: boolean
}

/** Project changes discard only this UI's pending reply, never the author's editor input. */
export default function GoogleDriveSyncSection(props: GoogleDriveSyncSectionProps) {
  return <DriveSession key={props.session ? JSON.stringify(props.session) : 'no-project'} {...props} />
}
function DriveSession({ session, name, onPreview, onBeforeExchange, modelSettingsOnly = false }: GoogleDriveSyncSectionProps) {
  const text = useLocaleStore(state => state.text)
  const [auth, setAuth] = useState<GoogleDriveAuthStatus | null>(null)
  const [drive, setDrive] = useState<GoogleDriveProjectStatus | null>(null)
  const [projects, setProjects] = useState<GoogleDriveProject[]>([])
  const [folderId, setFolderId] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [configurationOpen, setConfigurationOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const automaticMessage = useDriveSyncStore(state => state.message)
  const automaticEnabled = useDriveSyncStore(state => session ? state.projects[drivePathKey(session.projectPath)] : undefined)
  const alive = useRef(true), inFlight = useRef(false), authorizing = useRef(false), inputDirty = useRef(false)
  const current = () => alive.current && (!session || isProjectSessionCurrent(session))
  const accept = (result: GoogleDriveResponse) => {
    if (!current()) return
    if (result.auth) {
      setAuth(result.auth)
      if (!inputDirty.current) setClientId(result.auth.clientId ?? '')
    }
    if (result.drive) {
      setDrive(result.drive); if (result.drive.folderId) setFolderId(result.drive.folderId)
      if (session) useDriveSyncStore.setState(state => ({ projects: { ...state.projects, [drivePathKey(session.projectPath)]: result.drive!.autoSync === true } }))
    }
    if (result.projects) setProjects(result.projects)
    if (!result.success && result.error === 'GOOGLE_AUTH_REQUIRED' && !result.auth) setAuth(previous => previous ? { ...previous, authorized: false } : previous)
    if (!result.success) throw new Error(result.error || 'DRIVE_OPERATION_FAILED')
  }
  const run = async (task: () => Promise<void>) => {
    if (inFlight.current || !current()) return
    inFlight.current = true; setBusy(true); setNotice(null)
    try { await task() }
    catch (error) { if (current()) {
      if (error instanceof Error && error.message === 'GOOGLE_CLIENT_SECRET_REQUIRED') setConfigurationOpen(true)
      setNotice({ error: true, text: driveMessage(error, text) })
    } }
    finally { inFlight.current = false; if (current()) setBusy(false) }
  }
  const refresh = () => run(async () => {
    accept(await ipc.invoke('drive:auth-status'))
    if (session && current()) accept(await ipc.invokeWithProjectSession(session, 'drive:project-status', {}))
  })
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
      if (authorizing.current) void ipc.invoke('drive:cancel-auth').catch(() => {})
    }
  }, [])
  const configure = () => run(async () => {
    accept(await ipc.invoke('drive:configure', { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) }))
    if (!current()) return
    inputDirty.current = false
    setClientSecret('')
    setNotice({ error: false, text: text('应用配置已保存，请连接 Google 账户。', 'Application setup saved. Connect your Google account.') })
  })
  const removeClientSecret = () => run(async () => {
    if (!auth?.clientId) return
    accept(await ipc.invoke('drive:configure', { clientId: auth.clientId, clientSecret: '' }))
    if (!current()) return
    inputDirty.current = false; setClientSecret('')
    setNotice({ error: false, text: text('已移除本机客户端密钥，授权状态已清除。', 'The local client secret was removed and authorization cleared.') })
  })
  const connect = () => run(async () => {
    authorizing.current = true; setConnecting(true)
    try {
      const result = await ipc.invoke('drive:connect')
      try { accept(result) }
      catch (error) {
        if (!result.auth?.authorized) throw error
        if (current()) setNotice({ error: true, text: text('Google 账户授权已完成，但云端访问检查未通过。', 'Google account authorization completed, but the cloud access check failed. ') + driveMessage(error, text) })
        return
      }
      if (current()) setNotice({ error: false, text: text('Google 授权已完成，可读取或创建云端作品。', 'Google authorization completed. Read or create a cloud project.') })
    } finally { authorizing.current = false; if (current()) setConnecting(false) }
  })
  const cancel = async () => {
    if (!authorizing.current) return
    try { const result = await ipc.invoke('drive:cancel-auth'); if (current() && !result.success) throw new Error(result.error) }
    catch (error) { if (current()) setNotice({ error: true, text: driveMessage(error, text) }) }
  }
  const disconnect = () => run(async () => {
    accept(await ipc.invoke('drive:disconnect'))
    if (current()) { setProjects([]); setNotice({ error: false, text: text('本设备已断开 Google 授权。', 'Google authorization disconnected on this device.') }) }
  })
  const list = () => run(async () => {
    const result = await ipc.invoke('drive:list-projects'); accept(result)
    if (current() && !result.projects?.length) setNotice({ error: false, text: text('尚无可访问的云端作品。打开本地项目后可创建云端副本。', 'No accessible cloud projects yet. Open a local project to create a cloud copy.') })
  })
  const bind = () => run(async () => {
    if (!session) return
    const result = await ipc.invokeWithProjectSession(session, 'drive:bind', { ...(folderId ? { folderId } : {}), ...(name.trim() ? { name: name.trim() } : {}) })
    accept(result)
    if (!current()) return
    onPreview(result)
    setNotice({ error: false, text: text('当前作品已关联云端。点击“保存并传输”上传和检查更新。', 'This project is linked to the cloud. Choose “Save and transfer” to upload and check for updates.') })
  })
  const exchange = () => run(async () => {
    if (!session) return
    if (!onBeforeExchange) throw new Error('DRIVE_LOCAL_SAVE_FAILED')
    try { await onBeforeExchange() }
    catch (error) { throw error instanceof Error && error.message.startsWith('SYNC_') ? error : new Error('DRIVE_LOCAL_SAVE_FAILED') }
    if (!current()) return
    const result = await ipc.invokeWithProjectSession(session, 'drive:exchange', {})
    accept(result)
    if (!current()) return
    onPreview(result)
    const pending = result.preview && (result.preview.pendingBatches > 0 || result.preview.conflicts.length > 0)
    setNotice({ error: false, text: pending
      ? text('云端变更已下载，请在下方预览中核对并应用；冲突内容保留双方版本。', 'Cloud changes downloaded. Review and apply them below. Both conflict versions are retained.')
      : text('传输已完成，暂无待应用的云端更新。', 'Transfer completed. No cloud updates need applying.') })
  })
  const setAutoSync = (enabled: boolean) => run(async () => {
    if (!session) return
    const result = await ipc.invokeWithProjectSession(session, 'drive:set-auto-sync', { enabled })
    if (!result.success && current()) {
      // The intent can be durable even if initial transfer failed. Reflect its
      // real state without replacing the original failure or starting a loop.
      try { accept(await ipc.invokeWithProjectSession(session, 'drive:project-status', {})) } catch { /* Keep the original operation's diagnostic. */ }
    }
    accept(result)
    if (!current()) return
    onPreview(result)
    announceGoogleDriveSyncPreference(session)
    setNotice({ error: false, text: result.drive?.preferencePending
      ? text('本机已暂停同步，联网并连接原 Google 账户后会自动关闭另一端的同步。', 'Sync is paused here. Reconnect to the original Google account to propagate this to the other device.') : enabled
      ? text('已开启同步。其他设备连接同一 Google 账户，启动或回到前台时会收到作品。', 'Sync enabled. Other devices connected to the same Google account receive this book on startup or foreground return.')
      : text('已关闭这部作品的自动同步。两端现有内容继续保留。', 'Automatic sync is off for this book. Existing content is retained on both devices.') })
  })
  const join = () => run(async () => {
    if (!folderId) return
    const selected = projects.find(project => project.folderId === folderId)
    const target = await ipc.invoke('dialog:select-sync-join-target', selected?.name || name || 'synced-project')
    if (!target || !current()) return
    const result = await ipc.invoke('drive:join', { folderId, targetGrantId: target.grantId })
    accept(result)
    if (!result.projectPath) throw new Error('DRIVE_JOIN_FAILED')
    try { await useProjectStore.getState().loadRecentProjects() } catch { /* The new copy can still be opened if shelf metadata is unavailable. */ }
    if (!current()) return
    // Normal project transition protects the original editor's unsaved input.
    const opened = await useProjectStore.getState().openProject(result.projectPath)
    if (!opened && current()) setNotice({ error: false, text: text(`同步副本已建立：${result.projectPath}。尚未切换，可稍后打开。`, `Sync copy created at ${result.projectPath}. Open it later if you choose.`) })
  })
  const selected = projects.find(project => project.folderId === folderId)
  const wrongProject = Boolean(session && selected && selected.projectId !== session.projectId)
  const canConfigure = auth?.platform === 'desktop'
  const ready = Boolean(auth?.available && auth.configured && auth.authorized)
  const validClientId = /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId.trim()) && clientId.trim().length <= 300
  const cleanupMessage = text('旧历史清理尚未完成；下次同步时自动重试。', 'Old history cleanup is pending and will retry on the next sync.')
  return <section className="sync-status" aria-label={text('Google Drive 云同步', 'Google Drive cloud sync')} aria-busy={busy} style={{ display: 'grid', gap: 14 }}>
    <h2>{modelSettingsOnly ? text('Google 账户', 'Google account') : text('Google Drive 云同步', 'Google Drive cloud sync')}</h2>
    <p>{modelSettingsOnly ? text('连接同一 Google 账户后，在本机上传，在另一端读取并应用模型/API 配置。无需打开或同步小说。', 'Connect the same Google account, upload on this device, then read and apply model/API settings on the other device. No book needs to be open or synced.') : text('在书房为小说打开“开启同步”。手动保存后同步；回到前台时先保存再同步。应用启动时检查云端作品，本地写作可离线使用。', 'Enable sync for a book on the shelf. Manual saves sync changes; returning to the foreground saves and then syncs. Cloud books are checked on app startup. Local writing works offline.')}</p>
    <p role="status">{!auth ? text('正在读取 Google 授权状态…', 'Reading Google authorization status…') : auth.authorized
      ? text('Google 账户已连接', 'Google account connected') : auth.configured ? text('尚未连接 Google 账户', 'Google account not connected') : text('尚未完成 Google 应用配置', 'Google application setup is incomplete')}</p>
    {auth && !auth.available && <p role="alert">{text('当前设备无法使用 Google 授权。请检查 Google Play 服务或应用构建配置；本地项目仍可正常使用。', 'Google authorization is unavailable on this device. Check Google Play services or the app configuration. Local projects remain available.')}</p>}
    {auth?.persistence === 'session-only' && auth.authorized && <p>{text('此设备无法安全保存授权，关闭应用后需重新连接。', 'This device cannot securely persist authorization. Reconnect after closing the app.')}</p>}
    {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'sync-notice sync-notice-error' : 'sync-notice'}>{notice.text}</p>}
    {auth && <details open={!auth.configured || configurationOpen} onToggle={event => setConfigurationOpen(event.currentTarget.open)} className="sync-guide">
      <summary>{text('Google 应用配置指引', 'Google application setup')}</summary>
      <ol>
        <li>{text('在自己的 Google Cloud 项目启用 Google Drive API，并完成 OAuth 同意页面及测试用户设置。', 'Enable Google Drive API in your Google Cloud project and configure OAuth consent and test users.')}</li>
        <li>{canConfigure ? text('创建“桌面应用”OAuth 客户端，填写客户端 ID。若 Google 要求客户端密钥，从该客户端下载的 Desktop OAuth JSON 中复制 client_secret；不要填写访问令牌或 refresh token。', 'Create a Desktop OAuth client and enter its client ID. If Google requires a client secret, copy client_secret from that client’s downloaded Desktop OAuth JSON. Do not enter an access token or refresh token.') : text('为此 Android 应用的包名与签名 SHA-1 创建 Android OAuth 客户端。它必须与所安装 APK 的包名和签名一致。', 'Create an Android OAuth client for this app’s package name and signing SHA-1. Both must match the installed APK.')}</li>
        <li>{text('点击连接后，在系统浏览器或 Google 授权窗口选择账户并授权。手机已有 Drive App 的授权不能直接复用。', 'Choose Connect, then finish in the system browser or Google authorization window. The Drive app’s existing permission cannot be reused.')}</li>
      </ol>
      {canConfigure && <div style={{ display: 'grid', gap: 10 }}>
        <label className="pi-field">{text('Desktop OAuth 客户端 ID', 'Desktop OAuth client ID')}<input className="pi-input" aria-label={text('Desktop OAuth 客户端 ID', 'Desktop OAuth client ID')} autoComplete="off" spellCheck={false} value={clientId} disabled={busy} style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} onChange={event => { inputDirty.current = true; setClientId(event.target.value) }} /></label>
        <label className="pi-field">{text('Desktop OAuth 客户端密钥（可选）', 'Desktop OAuth client secret (optional)')}<input type="password" className="pi-input" aria-label={text('Desktop OAuth 客户端密钥（可选）', 'Desktop OAuth client secret (optional)')} autoComplete="off" spellCheck={false} value={clientSecret} disabled={busy} placeholder={auth.clientSecretConfigured ? text('已设置；留空保留，不会回显', 'Configured; leave blank to keep it. Never displayed.') : text('仅在 Google 要求时填写 client_secret', 'Enter client_secret only if Google requires it')} style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} onChange={event => { inputDirty.current = true; setClientSecret(event.target.value) }} /></label>
        <small>{text('密钥仅保存在本机，不进入作品或云同步。有设备保护存储时加密保存，否则只在本次打开期间保留。', 'The secret stays on this device and never enters projects or sync. It is encrypted with device protection when available; otherwise it is kept only for this session.')}</small>
        {auth.clientSecretConfigured && <p role="status">{text('客户端密钥已设置。', 'A client secret is configured.')}{auth.persistence === 'session-only' ? text('设备保护存储不可用，关闭应用后需重新填写。', 'Device-protected storage is unavailable; enter it again after closing the app.') : ''}</p>}
        <div className="sync-actions"><Button variant="secondary" disabled={busy || !validClientId} onClick={() => void configure()}>{text('保存 Google 应用配置', 'Save Google application setup')}</Button>
          {auth.clientSecretConfigured && <Button variant="text" disabled={busy || inputDirty.current} onClick={() => void removeClientSecret()}>{text('移除客户端密钥', 'Remove client secret')}</Button>}
        </div>
      </div>}
    </details>}
    <div className="sync-actions">
      {!auth?.authorized && <Button variant="primary" disabled={busy || !auth?.available || !auth.configured} onClick={() => void connect()}>{text('连接 Google 账户', 'Connect Google account')}</Button>}
      {connecting && <Button variant="secondary" onClick={() => void cancel()}>{text('取消 Google 授权', 'Cancel Google authorization')}</Button>}
      {auth?.authorized && <Button variant="secondary" disabled={busy} onClick={() => void disconnect()}>{text('断开 Google 账户', 'Disconnect Google account')}</Button>}
      <Button variant="text" disabled={busy} onClick={() => void refresh()}>{text('刷新云同步状态', 'Refresh cloud status')}</Button>
    </div>
    {!modelSettingsOnly && session && (ready || drive?.bound) && <label className="sync-auto-check"><span><input type="checkbox" role="switch" checked={automaticEnabled ?? drive?.autoSync === true} disabled={busy} onChange={event => void setAutoSync(event.target.checked)} />{text('开启同步', 'Enable sync')}</span><small>{text('同步小说正文和知识库原文等已保存资料。无冲突时自动应用；有未保存输入时等你保存，有内容冲突时保留双方版本供选择。', 'Sync saved manuscript and knowledge sources. Updates apply automatically when conflict-free; unsaved input waits for your save and conflicting versions are retained for your choice.')}</small></label>}
    {!modelSettingsOnly && ready && !session && <p>{text('应用启动、回到前台或点击“立即同步”时，已开启同步的云端作品会加入书房，无需选择目录。', 'On startup, foreground return or “Sync now”, cloud books with sync enabled join your shelf without choosing a directory.')}</p>}
    {!modelSettingsOnly && ready && <><p role="status">{automaticMessage || text('手动保存后、回到前台保存后同步；没有定时检查。', 'Sync runs after manual saves and foreground saving. There are no periodic checks.')}{drive?.historyCleanupError && !automaticMessage.includes(cleanupMessage) ? ` ${cleanupMessage}` : ''}</p><Button variant="secondary" disabled={busy} onClick={() => window.dispatchEvent(new Event('ai-novel:google-drive-sync-preference-changed'))}>{text('立即同步', 'Sync now')}</Button></>}
    {!modelSettingsOnly && ready && <details className="sync-guide"><summary>{text('手动云端操作（高级）', 'Manual cloud operations (advanced)')}</summary>
      <div className="sync-actions"><Button variant="secondary" disabled={busy} onClick={() => void list()}>{text('读取云端作品', 'Read cloud projects')}</Button></div>
      <label className="pi-field">{text('云端作品', 'Cloud project')}<select className="pi-input" aria-label={text('云端作品', 'Cloud project')} value={folderId} disabled={busy} style={{ width: '100%', minWidth: 0 }} onChange={event => setFolderId(event.target.value)}>
        <option value="">{session ? text('为当前作品新建云端副本', 'Create a cloud copy of the current project') : text('请选择已读取的云端作品', 'Choose a cloud project from the list')}</option>
        {folderId && !selected && <option value={folderId}>{text('当前已关联的云端作品', 'Currently linked cloud project')}</option>}
        {projects.map(project => <option key={project.folderId} value={project.folderId}>{project.name}</option>)}
      </select></label>
      {session ? <>
        <p>{drive?.bound ? text('当前本地作品已关联云端。', 'The current local project is linked to the cloud.') : text('当前本地作品尚未关联云端。可创建云端副本，或选择同一作品已有的云端副本。', 'The current local project is not linked. Create a cloud copy or choose its existing cloud copy.')}</p>
        {drive?.lastTransferredAt && <p>{text(`上次传输：${drive.lastTransferredAt}`, `Last transfer: ${drive.lastTransferredAt}`)}</p>}
        {wrongProject && <p>{text('所选云端项目属于另一部作品。请在新目录加入它，或选择当前作品的云端副本。', 'The selected cloud project belongs to another book. Join it in a new folder or choose the current book’s cloud copy.')}</p>}
        <div className="sync-actions"><Button variant="secondary" disabled={busy || wrongProject} onClick={() => void bind()}>{text('关联当前作品', 'Link current project')}</Button><Button variant="primary" disabled={busy || !drive?.bound || !onBeforeExchange} onClick={() => void exchange()}>{text('保存并传输云端变更', 'Save and transfer cloud changes')}</Button></div>
      </> : <p>{text('打开本地项目可创建云端副本，也可以直接从所选云端作品加入。', 'Open a local project to create a cloud copy, or join the selected cloud project.')}</p>}
      <p>{text('加入会在新目录建立同一作品身份的副本，切换项目时仍会检查本地未保存输入。', 'Joining creates a copy of the same project in a new folder. Switching still checks for unsaved local input.')}</p>
      <div className="sync-actions"><Button variant="secondary" disabled={busy || !folderId} onClick={() => void join()}>{text('在新目录加入所选作品', 'Join selected project in a new folder')}</Button></div>
    </details>}
    {ready && <ModelSettingsSyncSection key="account-model-settings" session={session ?? undefined} disabled={busy} />}
    {!modelSettingsOnly && ready && session && drive?.bound && <GoogleDriveBackupSection key={drive.folderId} session={session} name={name} disabled={busy} onBeforeBackup={onBeforeExchange} />}
  </section>
}
