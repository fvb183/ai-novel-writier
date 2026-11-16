import type { ProjectSessionContext } from '../../shared/ipc-channels'

export const GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED = 'ai-novel:google-drive-sync-preference-changed'

/** Local lifecycle hint only; no tokens, source text, or queued network requests. */
export function announceGoogleDriveSyncPreference(session: ProjectSessionContext): void {
  window.dispatchEvent(new CustomEvent(GOOGLE_DRIVE_SYNC_PREFERENCE_CHANGED, { detail: { projectSession: { ...session } } }))
}
