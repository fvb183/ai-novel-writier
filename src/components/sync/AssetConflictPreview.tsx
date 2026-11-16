import { useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { ProjectAssetPreview } from '../../shared/project-sync-assets'
import { useLocaleStore } from '../../stores/locale-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { Button } from '../ui/Button'
import { syncAssetMessage } from './sync-asset-messages'

/** Reads immutable candidate bytes; pagination never chooses or writes a variant. */
export default function AssetConflictPreview({ session, token, assetId, revision, deleted, label }: {
  session: ProjectSessionContext; token: string; assetId: string; revision: string; deleted: boolean; label: string
}) {
  const text = useLocaleStore(state => state.text)
  const [preview, setPreview] = useState<ProjectAssetPreview | null>(null)
  const [filePath, setFilePath] = useState<string | undefined>(), [offset, setOffset] = useState(0)
  const [back, setBack] = useState<number[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const sessionKey = JSON.stringify(session)
  useEffect(() => {
    if (deleted || !isProjectSessionCurrent(session)) return
    let active = true
    setLoading(true); setError(''); setPreview(null)
    void ipc.invokeWithProjectSession(session, 'sync:asset-preview', { token, assetId, revision,
      ...(filePath === undefined ? {} : { filePath }), ...(offset ? { offset } : {}) }).then(result => {
      if (!active || !isProjectSessionCurrent(session)) return
      if (!result.success || !result.preview) {
        setError(result.error === 'SYNC_PREVIEW_STALE'
          ? text('同步预览已变化，请刷新状态后重新核对。', 'The sync preview changed. Refresh the status and review again.')
          : result.error === 'SYNC_SESSION_STALE'
            ? text('项目会话已变化，请在当前项目重新读取。', 'The project session changed. Read the current project again.')
            : syncAssetMessage(result.error ?? '', text) ?? text('此版本内容暂时无法读取，请继续传输或刷新预览后核对。', 'This version is unavailable. Complete the transfer or refresh the preview.'))
        return
      }
      setPreview(result.preview)
    }).catch(() => {
      if (active && isProjectSessionCurrent(session)) setError(text('无法读取资产内容，请刷新预览后重试。', 'Unable to read the asset. Refresh the preview and retry.'))
    }).finally(() => { if (active && isProjectSessionCurrent(session)) setLoading(false) })
    return () => { active = false }
  }, [sessionKey, token, assetId, revision, deleted, filePath, offset, text])

  if (deleted) return <section className="sync-asset-content" aria-label={label}><p>{text('此版本删除这项资产；其他版本仍保留在同步历史中。', 'This version deletes the asset; other versions remain in sync history.')}</p></section>
  const image = preview?.image && ['image/png', 'image/jpeg', 'image/webp'].includes(preview.image.mime) ? preview.image : null
  return <section className="sync-asset-content" aria-label={label} aria-busy={loading}>
    {loading && <p role="status">{text('正在读取此版本内容…', 'Reading this version…')}</p>}
    {error && <p role="alert">{error}</p>}
    {preview && <><strong className="sync-asset-title">{preview.title}</strong>
      {preview.filePaths && preview.filePaths.length > 1 ? <><p>{text(`此版本包含 ${preview.filePaths.length} 个文件，采用时整组选择。`, `This version contains ${preview.filePaths.length} files and is selected as a group.`)}</p><label className="sync-asset-file">{text('查看版本文件', 'Version file')}<select aria-label={text('查看版本文件', 'Version file')} value={filePath ?? preview.filePath ?? ''} disabled={loading} onChange={event => {
        setFilePath(event.target.value); setOffset(0); setBack([])
      }}>{preview.filePaths.map(path => <option value={path} key={path}>{path}</option>)}</select></label></> : preview.filePath && <code className="sync-asset-file-name">{preview.filePath}</code>}
      {preview.document && <><p>{text(`知识资料 · ${preview.document.chunkCount} 个分块`, `Knowledge source · ${preview.document.chunkCount} chunks`)}</p>
        {!preview.document.originalAvailable && <p className="sync-asset-warning">{text('原文不可用，仅分块预览', 'Original unavailable; chunk preview only')}</p>}
        {preview.document.indexDirty && <p className="sync-asset-warning">{text('原文已修改，尚未重建索引。', 'The source was edited and its index has not been rebuilt.')}</p>}</>}
      {image && <img className="sync-asset-image" src={`data:${image.mime};base64,${image.base64}`} alt={`${preview.title} · ${label}`} />}
      {preview.text !== undefined && <pre tabIndex={0}>{preview.text || text('（空文件）', '(Empty file)')}</pre>}
      {preview.binary && !image && <p>{text(`二进制文件，${preview.byteSize ?? 0} 字节，无法按文字预览。`, `Binary file, ${preview.byteSize ?? 0} bytes; text preview is unavailable.`)}</p>}
      {preview.text === undefined && !image && !preview.binary && <p>{text('此项没有可用的文件内容。', 'No file content is available for this entry.')}</p>}
      {(back.length > 0 || preview.nextOffset !== undefined) && <div className="sync-asset-pages"><Button variant="text" size="sm" disabled={loading || !back.length} onClick={() => {
        setOffset(back.at(-1)!); setBack(previous => previous.slice(0, -1))
      }}>{text('上一段', 'Previous part')}</Button><span>{text(`片段 ${back.length + 1}`, `Part ${back.length + 1}`)}</span><Button variant="text" size="sm" disabled={loading || preview.nextOffset === undefined} onClick={() => {
        if (preview.nextOffset === undefined) return
        setBack(previous => [...previous, offset]); setOffset(preview.nextOffset)
      }}>{text('下一段', 'Next part')}</Button></div>}
    </>}
  </section>
}
