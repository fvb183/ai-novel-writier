import { useEffect, useRef, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { applyProjectSync, prepareGoogleDriveExchange } from '../../services/project-sync-apply'
import { announceProjectManuallySaved } from '../../services/project-save-events'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { SyncConflict, SyncPreview, SyncResolution, SyncStatus } from '../../shared/project-sync'
import type { SyncResponse } from '../../shared/project-sync-ipc'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { Button } from '../ui/Button'
import GoogleDriveSyncSection from './GoogleDriveSyncSection'
import AssetConflictPreview from './AssetConflictPreview'
import { needsLocalAssetRecovery, syncAssetMessage } from './sync-asset-messages'
import './project-sync.css'

type Notice = { error: boolean; message: string } | null
type Text = (zh: string, en: string) => string
const conflictKey = (conflict: Pick<SyncConflict, 'kind' | 'id'>) => JSON.stringify([conflict.kind, conflict.id])

function message(error: unknown, text: Text): string {
  const code = error instanceof Error ? error.message : String(error)
  const assetMessage = syncAssetMessage(code, text)
  if (assetMessage) return assetMessage
  const messages: Record<string, [string, string]> = {
    SYNC_READER_FEATURE_REQUIRED: ['同步包缺少所需的项目同步能力标记，尚未应用。请先更新来源应用，再重新导出或传输。', 'The bundle lacks a required project sync capability marker and was not applied. Update the source app, then export or transfer again.'],
    SYNC_READER_FEATURE_UNSUPPORTED: ['这个同步包需要更新版本的同步能力。请更新两台设备上的应用后再试。', 'This bundle requires newer sync capabilities. Update the app on both devices and retry.'],
    PROJECT_SYNC_NARRATIVE_INVALID: ['伏笔计划或定稿证据引用不完整，更新尚未应用。请在来源设备核对计划与定稿后重新传输。', 'Narrative plans or finalized evidence references are inconsistent. Review them on the source device and transfer again.'],
    PROJECT_SYNC_NARRATIVE_EVENT_IMMUTABLE: ['同步包试图改写或重新排列已保存的伏笔确认，已拒绝应用。请核对来源副本后重新传输。', 'The bundle attempts to rewrite or reorder saved narrative confirmations and was rejected. Review the source copy and transfer again.'],
    SYNC_IMMUTABLE_RECORD_CHANGED: ['变更包试图改写已保存的正文历史，已拒绝导入。请从未改动的来源副本重新导出。', 'The bundle attempts to rewrite saved prose history and was rejected. Export again from an unchanged source copy.'],
    PROJECT_SYNC_STORY_INVALID: ['剧情分支的节点、连接或路线不完整，变更包尚未应用。请先在来源设备核对分支图，再重新导出。', 'Story nodes, connections or routes are inconsistent. The bundle was not applied. Check the story graph on the source device and export again.'],
    SYNC_PREVIEW_STALE: ['本地内容或待收更新已变化。已刷新预览，请重新核对并选择冲突版本。', 'Local content or pending updates changed. Review the refreshed preview and choose conflict versions again.'],
    SYNC_SESSION_STALE: ['项目已切换，请在当前项目重新操作。', 'The project changed. Retry in the current project.'],
    SYNC_PROJECT_BUSY: ['创作任务仍在运行，请先结束任务再应用同步。', 'A creative task is still running. Finish it before applying sync.'],
    SYNC_INPUT_CHANGED: ['检测到新的输入，已取消应用，当前输入已保留。', 'New input was detected. Applying was cancelled and your input is preserved.'],
    SYNC_JOIN_INCOMPLETE: ['变更包缺少前序记录或存在未解决冲突。请在来源设备解决后重新导出。', 'The bundle has missing history or unresolved conflicts. Resolve them on the source device and export again.'],
    SYNC_GRANT_INVALID: ['文件授权已失效，请重新选择文件或目录。', 'File access expired. Select the file or folder again.'],
    SYNC_PROJECT_ID_MISMATCH: ['这个变更包属于另一部作品。可使用“加入同一项目”在新目录建立副本。', 'This bundle belongs to another book. Use “Join the same project” to create a copy in a new folder.'],
    SYNC_ACTIVE_OPERATION: ['项目仍有运行中的生成或导入任务，请结束后重试。', 'A generation or import is still running. Finish it before applying sync.'],
    SYNC_TARGET_EXISTS: ['目标已存在，请选择新的文件名或目录。', 'The destination already exists. Choose a new filename or folder.'],
    SYNC_NOT_ENABLED: ['请先在当前项目启用同步。', 'Enable sync in the current project first.'],
    SYNC_INVALID_RESOLUTION: ['冲突选择无效，请刷新预览后重新选择。', 'The conflict selection is invalid. Refresh and choose again.'],
    SYNC_OPERATION_FAILED: ['同步操作失败，未完成的更新仍需核对，请重试或重新选择变更包。', 'The sync operation failed. Review pending updates and retry or select the bundle again.'],
  }
  return messages[code] ? text(...messages[code]) : /^[A-Z][A-Z_]+$/.test(code) ? text('同步操作未完成，请刷新状态并核对待收内容后重试。', 'The sync operation did not complete. Refresh the status, review pending changes and retry.') : code
}

export default function ProjectSyncPanel() {
  const project = useProjectStore(state => state.currentProject)
  const session = projectSessionContextFromProject(project)
  const key = session ? JSON.stringify(session) : 'no-project'
  return <SyncPanelSession key={key} session={session} name={project?.name ?? ''} />
}

function SyncPanelSession({ session, name }: { session: ProjectSessionContext | null; name: string }) {
  const text = useLocaleStore(state => state.text)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [preview, setPreview] = useState<SyncPreview | null>(null)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [assetRecovery, setAssetRecovery] = useState(false)
  const alive = useRef(true)
  const inFlight = useRef(false)
  const current = () => alive.current && (!session || isProjectSessionCurrent(session))
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const accept = (result: SyncResponse) => {
    if (!current()) return
    if (result.status) setStatus(result.status)
    if (result.preview) {
      setPreview(result.preview)
      setChoices({})
    }
    if (!result.success) throw new Error(result.error || '同步操作失败')
  }

  const run = async (task: () => Promise<void>) => {
    if (inFlight.current || !current()) return
    inFlight.current = true
    setBusy(true)
    setNotice(null)
    try { await task() }
    catch (error) {
      if (current()) {
        setAssetRecovery(needsLocalAssetRecovery(error instanceof Error ? error.message : String(error)))
        setNotice({ error: true, message: message(error, text) })
      }
    } finally {
      inFlight.current = false
      if (current()) setBusy(false)
    }
  }

  const refresh = () => run(async () => {
    if (!session) return
    const result = await ipc.invokeWithProjectSession(session, 'sync:status', {})
    accept(result)
    if (current()) setAssetRecovery(false)
    if (!current() || !result.status?.enabled) return
    accept(await ipc.invokeWithProjectSession(session, 'sync:preview', {}))
  })
  useEffect(() => { void refresh() }, []) // This component is keyed by the complete session.
  useEffect(() => {
    const updated = () => { void refresh() }
    window.addEventListener('ai-novel:drive-sync-updated', updated)
    return () => window.removeEventListener('ai-novel:drive-sync-updated', updated)
  }, [])

  const enable = () => run(async () => {
    if (!session) return
    accept(await ipc.invokeWithProjectSession(session, 'sync:enable', {}))
    if (current()) setNotice({ error: false, message: text('此项目已启用同步。其他设备请从变更包加入。', 'Sync is enabled. Join from a bundle on other devices.') })
  })
  const exportBundle = () => run(async () => {
    if (!session) return
    const grant = await ipc.invoke('dialog:select-sync-export', name || 'project')
    if (!grant || !current()) return
    const result = await ipc.invokeWithProjectSession(session, 'sync:export', { targetGrantId: grant.grantId })
    accept(result)
    if (current()) setNotice({ error: false, message: text('已导出已保存的变更。未保存输入仍留在当前设备。', 'Saved changes exported. Unsaved input remains on this device.') })
  })
  const importBundle = () => run(async () => {
    if (!session) return
    const grant = await ipc.invoke('dialog:select-sync-package')
    if (!grant || !current()) return
    accept(await ipc.invokeWithProjectSession(session, 'sync:import-preview', { sourceGrantId: grant.grantId }))
    if (current()) setNotice({ error: false, message: text('更新已暂存，请核对下面的预览后应用。', 'Updates are staged. Review the preview before applying.') })
  })
  const apply = () => run(async () => {
    if (!session || !preview) return
    const resolutions: SyncResolution[] = preview.conflicts.map(conflict => ({
      kind: conflict.kind, id: conflict.id,
      expectedHeads: conflict.variants.map(variant => variant.revision),
      selectedRevision: choices[conflictKey(conflict)],
    }))
    const result = await applyProjectSync(session, preview, resolutions)
    // Resolving a conflict creates an author revision. Publish it after this
    // explicit action; automatic apply must never announce another save.
    if (result.success && result.applied?.applied && !result.applied.assetsPending) announceProjectManuallySaved(session.projectPath)
    accept(result)
    if (current() && result.applied?.assetsPending) {
      setAssetRecovery(true)
      setNotice({ error: true, message: text('同步记录已采用，本机资料仍待恢复。请重试恢复资料；不要再次应用相同更新。', 'Sync records were adopted, but local assets still need recovery. Retry asset recovery; do not apply the same update again.') })
    } else if (current()) setNotice({ error: result.applied?.applied === false, message: result.applied?.applied === false
      ? text('更新尚未应用，请处理预览中的缺失记录或冲突。', 'Updates were not applied. Resolve the missing history or conflicts shown in the preview.')
      : text('同步已处理。', 'Sync processed.') })
  })
  const join = () => run(async () => {
    const source = await ipc.invoke('dialog:select-sync-package')
    if (!source || !current()) return
    const target = await ipc.invoke('dialog:select-sync-join-target', name || 'synced-project')
    if (!target || !current()) return
    const result = await ipc.invoke('sync:join', { sourceGrantId: source.grantId, targetGrantId: target.grantId })
    if (!current()) return
    if (!result.success || !result.projectPath) throw new Error(result.error || 'SYNC_JOIN_FAILED')
    try { await useProjectStore.getState().loadRecentProjects() } catch { /* The new copy remains openable. */ }
    // The normal project transition protects unsaved input before binding the new copy.
    const opened = await useProjectStore.getState().openProject(result.projectPath)
    if (!opened && current()) setNotice({ error: false, message: text(
      `副本已建立：${result.projectPath}。尚未切换，可稍后打开。`,
      `Copy created at ${result.projectPath}. It has not been opened; you can open it later.`,
    ) })
  })
  const resolved = preview?.conflicts.every(conflict => conflict.variants.some(variant => variant.revision === choices[conflictKey(conflict)])) ?? false
  const applyAllowed = Boolean(preview && !preview.missingBatchHashes.length && resolved
    && (preview.canApply || preview.conflicts.length > 0)
    && (preview.pendingBatches > 0 || preview.conflicts.length > 0))

  return <section className="project-sync-panel" aria-label={text('项目同步', 'Project sync')} aria-busy={busy}>
    <GoogleDriveSyncSection session={session} name={name} onPreview={accept} onBeforeExchange={session ? () => prepareGoogleDriveExchange(session) : undefined} />
    <p>{text('同步已保存的正文、设定、蓝图、剧情路线和知识原文。项目提示词与 Skill 文件由各端单独配置；只传递 Skill 选择，缺少所选 Skill 时会阻止生成并提示安装。审稿报告、运行日志和可重建缓存保留在本机。', 'Sync saved manuscript, settings, blueprints, story routes and knowledge sources. Configure project prompts and Skill files separately on each device. Only Skill selections transfer; a missing selected Skill blocks generation with an installation notice. Review reports, run logs and rebuildable caches stay local.')}</p>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'sync-notice sync-notice-error' : 'sync-notice'}>{notice.message}</p>}
    <details className="sync-guide" open={Boolean(assetRecovery || preview?.conflicts.length || preview?.missingBatchHashes.length)}>
    <summary>{text('冲突处理与文件传输（高级）', 'Conflicts and file transfer (advanced)')}</summary>
    <p>{text('在不同设备继续同一部作品。只保留当前已保存内容和未解决冲突的双方版本；选择版本后，过时的同步正文和旧包会自动清理。', 'Continue the same book across devices. Keep current saved content and unresolved conflict versions. After a choice, obsolete synced text and packages are collected automatically.')}</p>
    <p>{text('不保留完整同步恢复历史。未再引用的旧资料经过宽限期与再次核查后自动删除；来源设备的提示词、Skill 和原始文件不会因此删除。', 'Full sync recovery history is not retained. Unreferenced old assets are collected after a grace period and another check. Local prompts, Skills and source files are preserved.')}</p>
    {!session ? <p>{text('打开项目后可启用同步，也可以从另一设备的变更包加入。', 'Open a project to enable sync, or join from another device’s bundle.')}</p> : <>
      <div className="sync-status" aria-label={text('同步状态', 'Sync status')}>
        <strong>{status ? status.enabled ? text('已启用', 'Enabled') : text('未启用', 'Not enabled') : text('正在读取状态…', 'Loading status…')}</strong>
        {status && <dl>
          <dt>{text('项目身份', 'Project identity')}</dt><dd>{status.projectId}</dd>
          {status.replicaId && <><dt>{text('本设备身份', 'This replica')}</dt><dd>{status.replicaId}</dd></>}
          <dt>{text('本机保存序号', 'Local save sequence')}</dt><dd>{status.localBatches}</dd>
          <dt>{text('待应用更新', 'Pending updates')}</dt><dd>{status.pendingBatches}</dd>
          <dt>{text('冲突记录', 'Conflicts')}</dt><dd>{status.conflicts}</dd>
        </dl>}
      </div>
      <div className="sync-actions">
        {!status?.enabled && <Button variant="primary" disabled={busy || !status} onClick={() => void enable()}>{text('启用此项目同步', 'Enable sync')}</Button>}
        <Button variant="secondary" disabled={busy || !status?.enabled} onClick={() => void exportBundle()}>{text('导出已保存变更包', 'Export saved changes')}</Button>
        <Button variant="secondary" disabled={busy || !status?.enabled} onClick={() => void importBundle()}>{text('导入并预览', 'Import and preview')}</Button>
        <Button variant="text" disabled={busy} onClick={() => void refresh()}>{assetRecovery ? text('重试恢复资料', 'Retry asset recovery') : text('刷新状态', 'Refresh status')}</Button>
      </div>
      {assetRecovery && <p>{text('此操作只恢复已采用资料的本机文件，不会应用待收更新。', 'This only restores local files for adopted assets; it does not apply pending updates.')}</p>}
      {preview && <section className="sync-preview" aria-label={text('待应用预览', 'Pending preview')}>
        <h2>{text('待应用预览', 'Pending preview')}</h2>
        <p>{text(`${preview.pendingBatches} 个批次，涉及 ${preview.changedRecords} 条记录。`, `${preview.pendingBatches} batches affecting ${preview.changedRecords} records.`)}</p>
        {preview.missingBatchHashes.length > 0 && <p role="alert">{text('缺少前序变更，暂时不能应用。请从来源设备导出完整变更包并再次导入。', 'Earlier changes are missing. Export a complete bundle from the source device and import it again.')}</p>}
        {preview.conflicts.map((conflict, index) => <fieldset className="sync-conflict" key={conflictKey(conflict)} disabled={busy}>
          <legend>{text('冲突', 'Conflict')} {index + 1} · {conflict.kind === 'project-asset' ? text('项目资料', 'Project assets') : `${conflict.kind} · ${conflict.id}`}</legend>
          <p>{text('选择当前采用的版本。确认后按所选内容继续同步，过时版本自动清理。', 'Choose the version to use now. After confirmation, sync continues with that version and obsolete versions are collected automatically.')}</p>
          <div className="sync-variants">{conflict.variants.map((variant, variantIndex) => <div className="sync-variant" key={variant.revision}>
            <label><input type="radio" name={conflictKey(conflict)} checked={choices[conflictKey(conflict)] === variant.revision}
              onChange={() => setChoices(value => ({ ...value, [conflictKey(conflict)]: variant.revision }))} />
              {text('采用版本', 'Use version')} {variantIndex + 1}</label>
            {conflict.kind === 'project-asset' && session ? <AssetConflictPreview key={`${preview.token}:${variant.revision}`} session={session} token={preview.token} assetId={conflict.id} revision={variant.revision} deleted={variant.deleted} label={text(`版本 ${variantIndex + 1} 内容`, `Version ${variantIndex + 1} content`)} />
              : <pre>{variant.deleted ? text('删除这条记录', 'Delete this record') : typeof variant.value === 'string' ? variant.value : JSON.stringify(variant.value, null, 2)}</pre>}
          </div>)}</div>
        </fieldset>)}
        <p>{text('应用时会先保存当前项目的全部未保存内容，核对输入并暂时停止编辑，完成后重新打开项目。', 'Applying first saves all unsaved project content, verifies input, pauses editing, then reopens the project.')}</p>
        <Button variant="primary" disabled={busy || !applyAllowed} onClick={() => void apply()}>{text('保存并应用同步', 'Save and apply sync')}</Button>
      </section>}
    </>}
    <section className="sync-join">
      <h2>{text('从文件导入作品副本', 'Import a book copy from a file')}</h2>
      <p>{text('选择另一设备的完整变更包，在新目录建立相同项目身份的副本，保留正文、设定、头像、知识原文及来源记录。项目提示词与 Skill 文件各端单独配置；所选 Skill 缺失会明确阻止生成。', 'Choose a complete bundle to create another copy of the same project with manuscript, settings, avatars, knowledge sources and provenance. Configure project prompts and Skill files separately on each device. A missing selected Skill blocks generation explicitly.')}</p>
      <p>{text('手动文件包总量上限为 64 MiB（含资产编码）；较大资产可通过 Google Drive 分块传输。历史备份恢复会创建独立的新项目。', 'Manual bundles have a total limit of 64 MiB including asset encoding. Use Google Drive chunked transfer for larger assets. Restoring a history backup creates an independent new project.')}</p>
      <Button variant="secondary" disabled={busy} onClick={() => void join()}>{text('选择变更包并加入', 'Choose bundle and join')}</Button>
    </section>
    <details className="sync-guide">
      <summary>{text('通过文件传递同步包', 'Transfer sync bundles as files')}</summary>
      <ol>
        <li>{text('先在一台设备启用同步，保存内容并导出变更包。另一台设备从该包“加入同一项目”。', 'Enable sync on one device, save your work and export a bundle. Join the same project from that bundle on the other device.')}</li>
        <li>{text('通过你已配置的文件传输方式（如 Google Drive 文件夹）传递变更包，再在目标设备导入预览。', 'Transfer the bundle using your configured file transfer method, such as a Google Drive folder, then import and preview it on the receiving device.')}</li>
        <li>{text('使用文件传递时，继续写作前先导入并处理冲突，写作后保存并导出。使用上方 Google Drive 时，由应用传输同一类变更，仍在同一预览中核对和应用。', 'For file transfer, import and resolve conflicts before writing, then save and export. Google Drive above transports the same changes; review and apply them in this shared preview.')}</li>
        <li>{text('Google Drive 按需传输缺少的资料，旧同步包自动归并并删除；未引用资料经过 24 小时宽限期和再次核查后自动清理。电脑与手机均需更新到 1.4.4 或更高版本。', 'Google Drive transfers missing assets on demand and automatically replaces and deletes old sync packages. Unreferenced assets are collected after a 24-hour grace period and another check. Update both desktop and phone to 1.4.4 or newer.')}</li>
      </ol>
    </details>
    </details>
  </section>
}
