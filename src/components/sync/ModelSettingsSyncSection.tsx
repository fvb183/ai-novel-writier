import { useEffect, useRef, useState } from 'react'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { ModelSettingsPreview } from '../../shared/model-settings-sync'
import type { GoogleDriveResponse } from '../../shared/google-drive-sync'
import { ipc } from '../../services/ipc-client'
import { useLLMStore } from '../../stores/llm-store'
import { useLocaleStore } from '../../stores/locale-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { Button } from '../ui/Button'

type Source = { kind: 'account' | 'project'; folderId: string; projectId?: string; name: string }
export default function ModelSettingsSyncSection({ session, disabled = false }: { session?: ProjectSessionContext; disabled?: boolean }) {
  const text = useLocaleStore(s => s.text), alive = useRef(true), working = useRef(false), token = useRef<string | null>(null)
  const [busy, setBusy] = useState(false), [preview, setPreview] = useState<ModelSettingsPreview | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [sources, setSources] = useState<Source[] | null>(null), [sourceFolderId, setSourceFolderId] = useState('')
  const [origin, setOrigin] = useState<Source | null>(null)
  const current = () => alive.current && (!session || isProjectSessionCurrent(session))
  const context = () => session ? { projectSession: session } : {}
  const discard = () => ipc.invoke('drive:model-settings-discard', context()).catch(() => {})
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (token.current) void discard() } }, [])
  const errorText = (code: string | undefined) => {
    switch (code) {
      case 'MODEL_SYNC_NOT_FOUND': return text('账户里还没有模型配置。请先在已配置的设备上传，或从下方旧版作品配置迁移。', 'No account model settings yet. Upload from a configured device, or import legacy project settings below.')
      case 'MODEL_SYNC_LOCAL_CHANGED': return text('本机模型设置已变化，请重新读取云端配置后核对。', 'Local model settings changed. Read the cloud settings again before applying.')
      case 'MODEL_SYNC_PREVIEW_EXPIRED': return text('这次预览已过期，请重新读取云端模型配置。', 'This preview expired. Read the cloud model settings again.')
      case 'MODEL_SYNC_CONFIG_INVALID': case 'MODEL_SYNC_LOCAL_CONFIG_INVALID': return text('模型配置格式不完整，本次没有导入。请检查来源设备的模型设置。', 'Model settings are invalid. Nothing was imported. Check the source device settings.')
      case 'MODEL_SYNC_IMPORT_ROLLBACK_FAILED': return text('模型设置未能完整写入或恢复，请检查本机设置后再使用。', 'Model settings could not be fully saved or restored. Check local settings before using them.')
      case 'MODEL_SYNC_CLOUD_CONFLICT': case 'MODEL_SYNC_CLOUD_CHANGED': return text('云端模型配置有多个版本或正在变化，已停止覆盖，请重新读取并核对来源。', 'Cloud model settings conflict or changed. Nothing was overwritten. Read again and check the source.')
      case 'GOOGLE_AUTH_REQUIRED': case 'GOOGLE_AUTH_CHANGED': return text('Google 账户已断开或变化，请连接后重新读取配置。', 'The Google account disconnected or changed. Connect and read settings again.')
      case 'DRIVE_ACCOUNT_MISMATCH': return text('Google 账户与配置来源不同，请核对账户。', 'The Google account differs from the settings source. Check the account.')
      case 'DRIVE_BUSY': return text('另一项云端操作正在处理，请完成后再传递模型配置。', 'Another cloud operation is running. Wait before transferring model settings.')
      default: return text('模型配置传递未完成，请检查网络后重试。', 'Model settings transfer did not complete. Check the network and retry.')
    }
  }
  const run = async (task: () => Promise<GoogleDriveResponse>, done: (result: GoogleDriveResponse) => void | Promise<void>) => {
    if (working.current || disabled || !current()) return
    working.current = true; setBusy(true); setNotice(null)
    try { const result = await task(); if (!current()) return; if (!result.success) { setNotice({ error: true, text: errorText(result.error) }); return }; await done(result) }
    catch { if (current()) setNotice({ error: true, text: errorText(undefined) }) }
    finally { working.current = false; if (current()) setBusy(false) }
  }
  const upload = () => run(async () => {
    if (token.current) { token.current = null; await discard() }
    setPreview(null); setOrigin(null)
    return ipc.invoke('drive:model-settings-upload', context())
  }, result => {
    setNotice({ error: false, text: text(`已上传本机 ${result.modelCount ?? 0} 个模型配置。可在另一端读取并应用。`, `Uploaded ${result.modelCount ?? 0} model settings. Read and apply them on the other device.`) })
  })
  const read = (legacyFolderId?: string) => run(async () => {
    if (token.current) { token.current = null; await discard() }
    setPreview(null); setOrigin(null)
    return ipc.invoke('drive:model-settings-preview', { ...context(), ...(legacyFolderId ? { sourceFolderId: legacyFolderId } : {}) })
  }, result => {
    if (!result.modelSettingsPreview) throw new Error('invalid preview')
    token.current = result.modelSettingsPreview.token; setPreview(result.modelSettingsPreview)
    setOrigin(result.modelSettingsSource ?? null)
  })
  const listSources = () => run(() => ipc.invoke('drive:model-settings-sources', context()), result => {
    setSources(result.modelSettingsSources ?? []); setSourceFolderId('')
  })
  const apply = () => {
    if (!preview) return
    return run(() => ipc.invoke('drive:model-settings-apply', { ...context(), token: preview.token }), async result => {
      token.current = null; setPreview(null)
      useLLMStore.setState({ loaded: false }); await useLLMStore.getState().init()
      if (current()) setNotice({ error: false, text: text(`已应用 ${result.modelCount ?? 0} 个模型，默认及分工模型选择已同步。`, `Applied ${result.modelCount ?? 0} models, including default and stage selections.`) })
    })
  }
  return <section className="sync-model-settings" aria-label={text('模型配置同步', 'Model settings sync')} aria-busy={busy}>
    <h3>{text('模型/API 配置同步', 'Model/API settings sync')}</h3>
    <p>{text('通过当前 Google 账户直接传递文本与向量模型配置，包括 API Key、接口地址、参数及默认和分工选择。配置保存在独立的账户配置目录，无需打开小说；导入影响本机所有作品。', 'Transfer text and embedding model settings through the current Google account, including API keys, endpoints, parameters, and default and stage selections. A separate account settings folder is used without opening a book; importing affects all local projects.')}</p>
    <p>{text('代理地址和 Google 授权信息各端保留。修改配置后，请再次上传，并在另一端读取应用。', 'Proxy addresses and Google authorization stay device-local. After changing settings, upload again and read/apply them on the other device.')}</p>
    <div className="sync-actions"><Button variant="secondary" disabled={disabled || busy} onClick={() => void upload()}>{text('上传本机模型配置', 'Upload local model settings')}</Button><Button variant="secondary" disabled={disabled || busy} onClick={() => void read()}>{text('读取云端模型配置', 'Read cloud model settings')}</Button></div>
    {preview && <div>
      {origin && <p>{text('配置来源：', 'Settings source: ')}{origin.name}{origin.kind === 'project' ? text('（旧版作品配置，应用后可再上传以迁移到账户目录）', ' (legacy project settings; upload after applying to migrate to the account folder)') : ''}</p>}
      <p>{text(`共 ${preview.total} 个模型，其中 ${preview.embeddings} 个向量模型；新增 ${preview.added} 个，更新 ${preview.updated} 个。同一条模型配置会更新，本机其他模型保留。`, `Models: ${preview.total}, including ${preview.embeddings} embedding models. Add ${preview.added}, update ${preview.updated}. Matching model records are updated; other local models are retained.`)}</p>
      <ul>{preview.modelNames.map((name, index) => <li key={index}>{name}</li>)}</ul>
      <p>{text('API Key 随配置传递，预览中不显示；应用后采用云端的默认和分工模型选择。', 'API keys transfer with settings and are hidden in the preview. Applying adopts the cloud default and stage selections.')}</p>
      <div className="sync-actions"><Button variant="primary" disabled={disabled || busy} onClick={() => void apply()}>{text('应用云端模型配置', 'Apply cloud model settings')}</Button><Button variant="text" disabled={busy} onClick={() => { token.current = null; setPreview(null); void discard() }}>{text('取消导入', 'Cancel import')}</Button></div>
    </div>}
    <details className="sync-guide"><summary>{text('从旧版作品配置迁移', 'Import legacy project settings')}</summary>
      <p>{text('旧版把模型配置放在作品目录中。先读取来源，再明确选择要采用的作品配置；不会自动合并不同来源。', 'Older versions kept model settings in book folders. List the sources, then explicitly choose one; different sources are never silently merged.')}</p>
      <Button variant="secondary" disabled={disabled || busy} onClick={() => void listSources()}>{text('读取旧版配置来源', 'List legacy settings sources')}</Button>
      {sources !== null && (sources.length ? <div className="sync-actions"><label className="pi-field">{text('旧版配置来源', 'Legacy settings source')}<select className="pi-input" aria-label={text('旧版配置来源', 'Legacy settings source')} value={sourceFolderId} disabled={disabled || busy} onChange={event => setSourceFolderId(event.target.value)}><option value="">{text('请选择来源作品', 'Choose a source book')}</option>{sources.map(source => <option key={source.folderId} value={source.folderId}>{source.name}</option>)}</select></label><Button variant="secondary" disabled={disabled || busy || !sourceFolderId} onClick={() => void read(sourceFolderId)}>{text('读取所选旧配置', 'Read selected legacy settings')}</Button></div> : <p>{text('没有找到旧版作品配置。', 'No legacy project settings found.')}</p>)}
    </details>
    {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </section>
}
