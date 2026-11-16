import type { ProjectSessionContext } from './ipc-channels'
import type { ModelSettingsPreview } from './model-settings-sync'
import type { SyncResponse } from './project-sync-ipc'

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export interface GoogleDriveAuthStatus {
  platform: 'desktop' | 'android'
  available: boolean
  configured: boolean
  authorized: boolean
  clientId?: string
  /** Presence only; the desktop client secret is never returned to renderers. */
  clientSecretConfigured?: boolean
  persistence: 'os-backed' | 'session-only' | 'google-play-services'
}
export interface GoogleDriveAuthorization {
  status(signal?: AbortSignal): Promise<GoogleDriveAuthStatus>
  configure(clientId: string, clientSecret?: string): Promise<void>
  accessToken(interactive: boolean, signal?: AbortSignal): Promise<string>
  disconnect(): Promise<void>
  invalidate(): Promise<void>
  cancel(): void
}
export interface GoogleDriveProject { folderId: string; projectId: string; name: string; autoSync?: boolean }
export interface GoogleDriveSyncProgress {
  operationId: string
  stage: 'authorization' | 'catalog' | 'download' | 'assets' | 'apply' | 'complete'
  projectId?: string
  completed?: number
  total?: number
}
export type GoogleDriveProgressReporter = (progress: Omit<GoogleDriveSyncProgress, 'operationId'>) => void
export interface GoogleDriveSyncEvents { 'drive:sync-progress': GoogleDriveSyncProgress }
export interface GoogleDriveAutoSyncReport {
  imported: number
  updated: number
  conflicts: string[]
  failures: { projectId: string; error: string }[]
  cleanupWarnings?: { projectId: string; error: string }[]
}
export interface GoogleDriveProjectStatus {
  bound: boolean
  autoSync?: boolean
  preferencePending?: boolean
  folderId?: string
  lastTransferredAt?: string
  lastUploadedHash?: string
  receivedFiles?: number
  historyCleanupError?: string
  error?: string
}
export interface GoogleDriveResponse extends SyncResponse {
  automatic?: GoogleDriveAutoSyncReport
  localProjects?: { path: string; enabled: boolean }[]
  modelSettingsPreview?: ModelSettingsPreview
  modelCount?: number
  modelSettingsSources?: ModelSettingsSource[]
  modelSettingsSource?: ModelSettingsSource
  auth?: GoogleDriveAuthStatus
  drive?: GoogleDriveProjectStatus
  projects?: GoogleDriveProject[]
  uploaded?: boolean
  downloaded?: number
  projectPath?: string
}
export interface ModelSettingsSource { kind: 'account' | 'project'; folderId: string; projectId: string; name: string }
export interface GoogleDriveSyncChannels {
  'drive:auto-sync': { args: [input?: { operationId: string }]; return: GoogleDriveResponse }
  'drive:cancel-auto-sync': { args: [input: { operationId: string }]; return: GoogleDriveResponse }
  'drive:local-projects': { args: []; return: GoogleDriveResponse }
  'drive:toggle-project': { args: [input: { path: string; enabled: boolean; projectSession?: ProjectSessionContext }]; return: GoogleDriveResponse }
  'drive:model-settings-sources': { args: [input: {projectSession?: ProjectSessionContext}]; return: GoogleDriveResponse }
  'drive:model-settings-upload': { args: [input: {projectSession?: ProjectSessionContext}]; return: GoogleDriveResponse }
  'drive:model-settings-preview': { args: [input: {projectSession?: ProjectSessionContext;sourceFolderId?:string}]; return: GoogleDriveResponse }
  'drive:model-settings-apply': { args: [input: {projectSession?: ProjectSessionContext;token:string}]; return: GoogleDriveResponse }
  'drive:model-settings-discard': { args: [input: {projectSession?: ProjectSessionContext}]; return: GoogleDriveResponse }
  'drive:auth-status': { args: []; return: GoogleDriveResponse }
  'drive:configure': { args: [input: { clientId: string; clientSecret?: string }]; return: GoogleDriveResponse }
  'drive:connect': { args: []; return: GoogleDriveResponse }
  'drive:disconnect': { args: []; return: GoogleDriveResponse }
  'drive:cancel-auth': { args: []; return: GoogleDriveResponse }
  'drive:list-projects': { args: []; return: GoogleDriveResponse }
  'drive:project-status': { args: [input: { projectSession?: ProjectSessionContext }]; return: GoogleDriveResponse }
  'drive:bind': { args: [input: { projectSession?: ProjectSessionContext; folderId?: string; name?: string }]; return: GoogleDriveResponse }
  'drive:exchange': { args: [input: { projectSession?: ProjectSessionContext }]; return: GoogleDriveResponse }
  'drive:set-auto-sync': { args: [input: { projectSession?: ProjectSessionContext; enabled: boolean }]; return: GoogleDriveResponse }
  'drive:join': { args: [input: { folderId: string; targetGrantId: string }]; return: GoogleDriveResponse }
}
