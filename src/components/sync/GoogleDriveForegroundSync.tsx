import { useEffect, useRef } from 'react'
import { ipc } from '../../services/ipc-client'
import { applyProjectSync, prepareGoogleDriveExchange } from '../../services/project-sync-apply'
import { PROJECT_MANUALLY_SAVED } from '../../services/project-save-events'
import { projectSessionContextFromProject, sameProjectSessionContext, sameProjectPathKey } from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { acceptDriveProjects, useDriveSyncStore, type DriveSyncStage } from '../../stores/drive-sync-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED } from './google-drive-sync-events'
import { driveMessage, safeDriveErrorCode } from './drive-error-message'
import { randomUUID } from '../../utils/id'

const visible = () => document.visibilityState !== 'hidden' && navigator.onLine !== false

type Trigger = 'startup' | 'foreground' | 'explicit' | 'saved'
type Operation = { id: string; epoch: number; canceled: boolean; catalogPending: boolean; session: ProjectSessionContext | null }

/** Event-driven only: author saves, foreground return and explicit sync. There
 * is no polling timer and internal database changes never schedule cloud work. */
export default function GoogleDriveForegroundSync() {
  const project = useProjectStore(state => state.currentProject)
  const running = useRef<Operation | null>(null)
  const queuedExplicit = useRef(false), queuedSave = useRef(false), queuedForeground = useRef(false), refreshShelf = useRef(false)
  const initialized = useRef(false), epoch = useRef(0)
  const triggerRef = useRef<(source: Trigger) => void>(() => {})
  useEffect(() => {
    let alive = true
    const ownerEpoch = ++epoch.current
    const text = useLocaleStore.getState().text
    const currentEffect = () => alive && epoch.current === ownerEpoch
    const idle = (message: string, errorCode: string | null = null) => {
      if (currentEffect()) useDriveSyncStore.setState({ phase: 'idle', stage: null, message, errorCode, nextRetryAt: null })
    }
    const trigger = (source: Trigger) => {
      if (!currentEffect() || !ipc.isElectron || (source === 'foreground' ? document.visibilityState === 'hidden' : !visible())) return
      if (running.current) {
        if (source === 'explicit') queuedExplicit.current = true
        if (source === 'saved') queuedSave.current = true
        if (source === 'foreground') queuedForeground.current = true
        if (running.current.epoch !== ownerEpoch) idle(text('项目已切换，正在结束上一次同步检查。', 'The project changed. Finishing the previous sync check.'))
        return
      }
      const initialSession = projectSessionContextFromProject(useProjectStore.getState().currentProject)
      const operation: Operation = { id: randomUUID(), epoch: ownerEpoch, canceled: false, catalogPending: false, session: initialSession }
      const ownsUI = () => currentEffect() && running.current === operation
      const sessionUnchanged = () => {
        const active = projectSessionContextFromProject(useProjectStore.getState().currentProject)
        return !initialSession && !active || sameProjectSessionContext(initialSession, active)
      }
      const current = () => ownsUI() && !operation.canceled && sessionUnchanged() && visible()
      const stage = (value: DriveSyncStage, message: string) => {
        if (current()) useDriveSyncStore.setState({ phase: 'syncing', stage: value, message, errorCode: null, nextRetryAt: null })
      }
      running.current = operation
      initialized.current = true
      void (async () => {
        let checked = false
        try {
          if (source === 'foreground' && initialSession) {
            stage('apply', text('正在保存当前作品，完成后同步…', 'Saving this book before syncing…'))
            await prepareGoogleDriveExchange(initialSession)
            if (!current()) return
          }
          // A previous owner may have committed a downloaded book just before a
          // project switch. Refresh local navigation without accepting its UI reply.
          if (refreshShelf.current) {
            await useProjectStore.getState().loadRecentProjects()
            refreshShelf.current = false
            if (!current()) return
          }
          stage('authorization', text('正在检查 Google 授权…', 'Checking Google authorization…'))
          operation.catalogPending = true
          const catalog = await ipc.invoke('drive:auto-sync', { operationId: operation.id }).finally(() => { operation.catalogPending = false })
          // A directory may have committed before the last catalog/index write
          // failed. Recover the local shelf independently of cloud success.
          if (!catalog.success || catalog.automatic?.imported || catalog.automatic?.updated || catalog.automatic?.failures.length
            || catalog.localProjects?.some(book => !useProjectStore.getState().recentProjects.some(recent => sameProjectPathKey(recent.path, book.path)))) refreshShelf.current = true
          if (!current()) return
          if (refreshShelf.current) {
            try { await useProjectStore.getState().loadRecentProjects(); refreshShelf.current = false } catch { /* Retry on next check or library entry. */ }
          }
          if (!current()) return
          if (!catalog.success) throw new Error(catalog.error)
          if (catalog.auth && (!catalog.auth.authorized || !catalog.auth.available || !catalog.auth.configured)) {
            idle(catalog.auth.available && catalog.auth.configured
              ? text('请连接 Google 账户后继续同步。', 'Connect Google to continue syncing.') : '')
            return
          }
          checked = true
          acceptDriveProjects(catalog.localProjects)
          if (!current()) return
          if (!visible()) { idle(text('已收到云端检查结果，回到前台后继续同步。', 'Cloud check received. Sync will continue in the foreground.')); return }
          const session = initialSession
          let deferred = false, historyCleanupPending = Boolean(catalog.automatic?.cleanupWarnings?.length), conflicted = Boolean(catalog.automatic?.conflicts.length)
          if (session) {
            stage('project-status', text('正在核对当前作品的同步状态…', 'Checking the current book’s sync status…'))
            let settings = await ipc.invokeWithProjectSession(session, 'drive:project-status', {})
            if (!current() || !isProjectSessionCurrent(session)) return
            if (!settings.success) throw new Error(settings.error)
            if (!settings.drive?.bound && settings.drive?.autoSync && settings.drive.preferencePending) {
              // The first switch-on was interrupted after its account-bound
              // intent was saved. Resume the reserved folder, including when
              // it is still hidden until its first complete upload.
              stage('transfer', text('正在继续首次上传…', 'Resuming the first upload…'))
              settings = await ipc.invokeWithProjectSession(session, 'drive:bind', {})
              if (!current()) return
              if (!settings.success) throw new Error(settings.error)
            }
            if (!settings.drive?.bound) {
              const remote = await ipc.invoke('drive:list-projects')
              if (!current()) return
              if (!remote.success) throw new Error(remote.error)
              const matching = remote.projects?.filter(book => book.projectId === session.projectId && book.autoSync !== false)
              if (matching?.length === 1) {
                settings = await ipc.invokeWithProjectSession(session, 'drive:bind', { folderId: matching[0].folderId })
                if (!current()) return
                if (!settings.success) throw new Error(settings.error)
                settings = await ipc.invokeWithProjectSession(session, 'drive:set-auto-sync', { enabled: true })
                if (!current()) return
                if (!settings.success) throw new Error(settings.error)
              }
            }
            if (settings.drive?.bound && settings.drive.autoSync === true) {
              stage('transfer', text('正在传输当前作品已保存的变更…', 'Transferring saved changes for this book…'))
              const result = await ipc.invokeWithProjectSession(session, 'drive:exchange', {})
              if (!current() || !isProjectSessionCurrent(session)) return
              if (!result.success) throw new Error(result.error)
              historyCleanupPending ||= Boolean(result.drive?.historyCleanupError)
              const preview = result.preview
              if (preview?.conflicts.length || preview?.missingBatchHashes.length) conflicted = true
              else if (preview?.pendingBatches) {
                stage('apply', text('正在应用已保存的云端变更…', 'Applying saved cloud changes…'))
                const applied = await applyProjectSync(session, preview, [], true)
                if (!current()) return
                if (!applied.success && applied.error !== 'SYNC_PROJECT_BUSY') throw new Error(applied.error)
                deferred = !applied.success
              }
            }
          }
          const failure = catalog.automatic?.failures[0]
          if (failure) throw new Error(failure.error)
          const completedMessage = conflicted
              ? text('有内容冲突，请在对应作品的同步设置中选择版本；双方内容已保留。', 'Resolve content conflicts in the book’s Sync settings. Both versions are retained.')
              : deferred ? text('云端更新已收到，保存并结束当前输入后会自动应用。', 'Cloud changes received. Save and finish your current input to apply them automatically.')
                : text('已同步已保存的内容', 'Saved content is up to date')
          const cleanupMessage = historyCleanupPending
            ? text('旧历史清理尚未完成；下次同步时自动重试。', 'Old history cleanup is pending and will retry on the next sync.') : ''
          if (current()) useDriveSyncStore.setState({ phase: 'idle', stage: null, lastChecked: Date.now(), errorCode: null, nextRetryAt: null,
            message: [completedMessage, cleanupMessage].filter(Boolean).join(' ') })
        } catch (error) {
          if (!current()) return
          const code = safeDriveErrorCode(error)
          const busy = ['DRIVE_BUSY', 'GOOGLE_AUTH_BUSY', 'SYNC_PROJECT_BUSY'].includes(code)
          const ended = ['GOOGLE_AUTH_CHANGED', 'SYNC_SESSION_STALE', 'DRIVE_CANCELLED'].includes(code)
          if (busy || ended) {
            idle(busy
              ? text('当前任务仍在处理，请保存后或回到前台时再同步，也可点击“立即同步”。', 'A task is still running. Sync after saving or returning to the foreground, or choose “Sync now”.')
              : text('本次检查已结束。下次保存、回到前台或点击“立即同步”时重新检查。', 'This check ended. Save, return to the foreground, or choose “Sync now” to check again.'), code)
            return
          }
          const explanation = driveMessage(code, text)
          const retry = text('下次手动保存、回到前台或点击“立即同步”时重试。', 'Save manually, return to the foreground, or choose “Sync now” to retry.')
          useDriveSyncStore.setState({ phase: 'error', stage: null, errorCode: code || 'DRIVE_OPERATION_FAILED', nextRetryAt: null,
            message: explanation + ' ' + retry })
        } finally {
          const wasOwner = running.current === operation, finishUI = ownsUI() && sessionUnchanged()
          if (wasOwner) running.current = null
          if (finishUI && useDriveSyncStore.getState().phase === 'syncing') {
            idle(text('本次检查已结束，等待下一次同步。', 'This check ended. Waiting for the next sync.'))
          }
          if (currentEffect() && checked && !operation.canceled && sessionUnchanged()) window.dispatchEvent(new Event('ai-novel:drive-sync-updated'))
          if (wasOwner) {
            const explicit = queuedExplicit.current, saved = queuedSave.current, foreground = queuedForeground.current
            queuedExplicit.current = false; queuedSave.current = false; queuedForeground.current = false
            if (explicit || saved || foreground) queueMicrotask(() => triggerRef.current(foreground ? 'foreground' : explicit ? 'explicit' : 'saved'))
          }
        }
      })()
    }
    triggerRef.current = trigger
    const explicit = () => trigger('explicit')
    let leftForeground = document.visibilityState === 'hidden'
    const background = () => { leftForeground = true }
    const foreground = () => {
      if (!leftForeground || document.visibilityState === 'hidden') return
      leftForeground = false
      trigger('foreground')
    }
    const visibility = () => {
      if (document.visibilityState !== 'hidden') foreground()
      else {
        background()
        if (currentEffect() && !running.current) idle(text('回到前台后会先保存，再同步。', 'Returning to the foreground will save and then sync.'))
      }
    }
    let savedTimer: ReturnType<typeof setTimeout> | undefined
    const saved = (event: Event) => {
      const path = (event as CustomEvent<{ projectPath?: string }>).detail?.projectPath
      if (!path || !sameProjectPathKey(path, useProjectStore.getState().currentProject?.path)) return
      clearTimeout(savedTimer)
      savedTimer = setTimeout(() => trigger('saved'), 150)
    }
    const stopProgress = ipc.isElectron ? ipc.on('drive:sync-progress', progress => {
      const operation = running.current
      if (!currentEffect() || !operation || operation.epoch !== ownerEpoch || operation.canceled || !operation.catalogPending || progress.operationId !== operation.id) return
      const liveSession = projectSessionContextFromProject(useProjectStore.getState().currentProject)
      if ((liveSession || operation.session) && !sameProjectSessionContext(liveSession, operation.session)) return
      const labels: Record<string, string> = {
        authorization: text('正在检查 Google 授权…', 'Checking Google authorization…'),
        catalog: text('正在读取云端作品列表…', 'Reading cloud books…'),
        download: text('正在下载云端作品…', 'Downloading cloud books…'),
        assets: text('正在同步知识原文和项目资料…', 'Syncing knowledge sources and project assets…'),
        apply: text('正在应用已保存的云端变更…', 'Applying saved cloud changes…'),
        complete: text('云端检查完成，正在核对当前作品…', 'Cloud check complete. Checking the current book…'),
      }
      const label = labels[progress.stage]
      if (!label) return
      const count = Number.isFinite(progress.total) && Number.isFinite(progress.completed) && progress.total! > 0
        ? ` (${progress.completed}/${progress.total})` : ''
      useDriveSyncStore.setState({ phase: 'syncing', stage: progress.stage as DriveSyncStage, message: label + count, errorCode: null })
    }) : () => {}
    window.addEventListener('blur', background); window.addEventListener('focus', foreground)
    window.addEventListener('android-background', background)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener(PROJECT_MANUALLY_SAVED, saved)
    window.addEventListener(GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED, explicit)
    // React StrictMode mounts an effect twice. Defer the one startup discovery
    // until ownership is stable, rather than starting and canceling two requests.
    if (!initialized.current) queueMicrotask(() => { if (currentEffect()) trigger('startup') })
    return () => {
      alive = false
      stopProgress(); clearTimeout(savedTimer)
      const operation = running.current
      if (operation?.epoch === ownerEpoch) {
        operation.canceled = true
        void ipc.invoke('drive:cancel-auto-sync', { operationId: operation.id }).catch(() => {})
      }
      window.removeEventListener('blur', background); window.removeEventListener('focus', foreground)
      window.removeEventListener('android-background', background)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener(PROJECT_MANUALLY_SAVED, saved)
      window.removeEventListener(GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED, explicit)
    }
  }, [project?.id, project?.path, project?.sessionLease])
  return null
}
