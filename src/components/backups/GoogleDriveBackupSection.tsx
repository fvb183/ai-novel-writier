import { useEffect, useRef, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { DriveBackupGeneration, DriveBackupResponse } from '../../shared/google-drive-backup'
import { useLocaleStore } from '../../stores/locale-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { randomUUID } from '../../utils/id'
import { Button } from '../ui/Button'
import '../sync/project-sync.css'

export default function GoogleDriveBackupSection({ session, name, disabled, onBeforeBackup }: {
  session: ProjectSessionContext; name: string; disabled: boolean; onBeforeBackup?(): Promise<void>
}) {
  const text = useLocaleStore(state => state.text)
  const [generations, setGenerations] = useState<DriveBackupGeneration[]>([])
  const [selected, setSelected] = useState(''), [parents, setParents] = useState<string[]>([])
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<string | undefined>(), [notice, setNotice] = useState('')
  const active = useRef<string | null>(null), alive = useRef(true), working = useRef(false)
  const current = () => alive.current && isProjectSessionCurrent(session)
  const accept = (result: DriveBackupResponse) => {
    if (!current()) return
    if (!result.success) throw new Error(result.error || 'DRIVE_OPERATION_FAILED')
    if (result.generations) {
      setGenerations(result.generations)
      setSelected(previous => result.generations!.some(item => item.generationId === previous) ? previous : result.generations![0]?.generationId ?? '')
      const ancestors = new Set(result.generations.flatMap(item => item.parentGenerationIds))
      setParents(result.generations.filter(item => !ancestors.has(item.generationId)).map(item => item.generationId))
    }
    setPending(result.pendingOperationId)
  }
  const run = async (task: (operationId: string) => Promise<void>, resume?: string) => {
    if (working.current || disabled || !current()) return
    const id = resume ?? randomUUID(); active.current = id; working.current = true; setBusy(true); setNotice('')
    try { await task(id) }
    catch (error) {
      if (current()) {
        const code = error instanceof Error ? error.message : ''
        if (code === 'DRIVE_BACKUP_PENDING') setPending(undefined)
        setNotice(code === 'DRIVE_CANCELLED' ? text('已请求取消。未完成代际不会显示为可恢复备份；可以显式继续原快照。', 'Cancelled. Incomplete generations are not restorable; you can explicitly resume the same snapshot.')
          : code === 'DRIVE_BACKUP_PENDING' ? text('存在未完成备份，请先读取历史备份并继续原快照。', 'An unfinished backup exists. Read backup history and resume that snapshot.')
            : text(`备份操作未完成（${/^(?:DRIVE|GOOGLE|SYNC|PORTABLE)_[A-Z0-9_]+$/.test(code) ? code : 'DRIVE_OPERATION_FAILED'}）。本地内容已保留。`, `Backup operation incomplete (${code || 'DRIVE_OPERATION_FAILED'}). Local content is preserved.`))
      }
    } finally { active.current = null; working.current = false; if (current()) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; if (active.current) void ipc.invoke('drive:backup-cancel', { operationId: active.current }).catch(() => {}) }
  }, [])
  const list = () => run(async operationId => accept(await ipc.invokeWithProjectSession(session, 'drive:backup-list', { operationId })))
  const backup = () => run(async operationId => {
    if (!consent) return
    if (!pending) await onBeforeBackup?.()
    if (!current()) return
    // Keep this exact operation identity after an unknown response; never create a replacement snapshot implicitly.
    setPending(operationId)
    const result = await ipc.invokeWithProjectSession(session, 'drive:backup-create', { operationId, parentGenerationIds: parents })
    accept(result)
    if (current()) setNotice(text('完整快照已保存到 Google Drive。恢复会创建独立新项目。', 'Complete snapshot saved to Google Drive. Restoring creates an independent new project.'))
  }, pending)
  const restore = () => run(async operationId => {
    const generation = generations.find(item => item.generationId === selected)
    if (!generation) return
    const target = await ipc.invoke('dialog:select-project-restore-target', `${name}-Drive恢复副本`)
    if (!target || !current()) return
    const result = await ipc.invokeWithProjectSession(session, 'drive:backup-restore', { operationId, generationId: selected, targetGrantId: target.grantId })
    accept(result)
    if (current()) setNotice(text(`已恢复为独立新项目：${result.projectPath}。当前项目与同步身份保持原状。`, `Restored as an independent project: ${result.projectPath}. Your current project and sync identity are preserved.`))
  })
  const cancel = async () => { if (active.current) await ipc.invoke('drive:backup-cancel', { operationId: active.current }) }
  return <section className="sync-drive-backups" aria-label={text('Google Drive 历史备份', 'Google Drive backup history')}>
    <h3>{text('Google Drive 历史备份', 'Google Drive backup history')}</h3>
    <p>{text('完整归档包含已保存的正文、蓝图、分支、项目提示词、Skills、头像和知识源。恢复创建独立新项目；继续双端编辑请使用上方同步。', 'Archives include saved prose, blueprints, branches, project prompts, Skills, avatars and knowledge sources. Restore creates a new independent project; use sync above to continue across devices.')}</p>
    <label className="sync-auto-check"><span><input type="checkbox" checked={consent} disabled={busy || disabled} onChange={event => setConsent(event.target.checked)} />{text('我确认将完整项目快照备份到当前 Google Drive', 'Back up this complete project snapshot to the current Google Drive')}</span></label>
    <div className="sync-actions"><Button variant="secondary" disabled={busy || disabled} onClick={() => void list()}>{text('读取 Drive 历史备份', 'Read Drive backup history')}</Button><Button variant="primary" disabled={busy || disabled || !consent || !onBeforeBackup} onClick={() => void backup()}>{pending ? text('继续未完成的 Drive 备份', 'Resume unfinished Drive backup') : text('保存并备份到 Drive', 'Save and back up to Drive')}</Button>{busy && <Button variant="secondary" onClick={() => void cancel()}>{text('取消备份操作', 'Cancel backup operation')}</Button>}</div>
    {pending && <p>{text('继续会上传先前冻结的快照。当前新修改请在它完成后另建备份。', 'Resume uploads the previously frozen snapshot. Create another backup afterwards for newer edits.')}</p>}
    {notice && <p role="status">{notice}</p>}
    {generations.length > 0 && <><label className="pi-field">{text('可恢复的完整备份', 'Complete restorable backups')}<select className="pi-input" aria-label={text('可恢复的完整备份', 'Complete restorable backups')} value={selected} disabled={busy || disabled} onChange={event => setSelected(event.target.value)}>{generations.map(item => <option key={item.generationId} value={item.generationId}>{item.createdAt} · {Math.ceil(item.archiveByteSize / 1024)} KiB{item.siblingGenerationIds.length ? text(' · 并发备份', ' · concurrent backup') : ''}</option>)}</select></label>
      <details><summary>{text('下一备份的父代（可多选）', 'Parents of the next backup (multiple allowed)')}</summary>{generations.map(item => <label key={item.generationId} className="sync-auto-check"><span><input type="checkbox" checked={parents.includes(item.generationId)} disabled={busy || disabled || Boolean(pending)} onChange={event => setParents(previous => event.target.checked ? [...previous, item.generationId] : previous.filter(id => id !== item.generationId))} />{item.createdAt} · {item.generationId.slice(0, 8)}</span></label>)}</details>
      <Button variant="secondary" disabled={busy || disabled || !selected} onClick={() => void restore()}>{text('恢复所选备份为独立新项目', 'Restore selected backup as an independent project')}</Button></>}
  </section>
}
