import { useEffect, useRef, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { driveMessage } from './drive-error-message'
import { projectSessionContextFromProject, sameProjectPathKey } from '../../shared/project-session-context'
import { acceptDriveProjects, drivePathKey, useDriveSyncStore } from '../../stores/drive-sync-store'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED } from './google-drive-sync-events'

export default function DriveBookToggle({ path }: { path: string }) {
  const text = useLocaleStore(state => state.text)
  const enabled = useDriveSyncStore(state => state.projects[drivePathKey(path)] === true)
  const phase = useDriveSyncStore(state => state.phase), lastChecked = useDriveSyncStore(state => state.lastChecked)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const inFlight = useRef(false), failedAt = useRef(0)
  useEffect(() => {
    if (enabled && phase === 'idle' && lastChecked && lastChecked > failedAt.current) setError('')
  }, [enabled, phase, lastChecked])
  const change = async (checked: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError('')
    try {
      const current = useProjectStore.getState().currentProject
      const session = sameProjectPathKey(current?.path, path) ? projectSessionContextFromProject(current) : null
      const result = await ipc.invoke('drive:toggle-project', { path, enabled: checked, ...(session ? { projectSession: session } : {}) })
      if (!result.success) throw new Error(result.error)
      acceptDriveProjects((await ipc.invoke('drive:local-projects')).localProjects)
      window.dispatchEvent(new Event(GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED))
    } catch (error) {
      failedAt.current = Date.now()
      setError(driveMessage(error, text))
      // The backend can have saved the user's opt-in before the first upload
      // failed. Show that persisted choice; the scheduler owns the retry.
      try { acceptDriveProjects((await ipc.invoke('drive:local-projects')).localProjects) } catch { /* Keep the original transfer error visible. */ }
    } finally { inFlight.current = false; setBusy(false) }
  }
  return <div className="sync-book-toggle">
    <label><input type="checkbox" role="switch" aria-label={text('开启同步', 'Enable sync')} checked={enabled} disabled={busy} onChange={event => void change(event.target.checked)} />
      {busy ? text('正在连接…', 'Connecting…') : text('开启同步', 'Enable sync')}</label>
    {error && <small role="alert">{error}</small>}
  </div>
}
