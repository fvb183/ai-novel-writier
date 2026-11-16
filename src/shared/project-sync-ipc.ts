import type { ExternalFileGrant, ProjectSessionContext } from './ipc-channels'
import type { SyncApplyResult, SyncPreview, SyncResolution, SyncStatus } from './project-sync'
import type { ProjectAssetPreview } from './project-sync-assets'

/** ipc-client injects the captured session into this object, never a later active lease. */
export interface SyncProjectRequest { projectSession?: ProjectSessionContext }
export interface SyncResponse {
  success: boolean
  status?: SyncStatus
  preview?: SyncPreview
  applied?: SyncApplyResult
  error?: string
}
export interface ProjectSyncChannels {
  'sync:status': { args: [request: SyncProjectRequest]; return: SyncResponse }
  'sync:recover-assets': { args: [request: SyncProjectRequest]; return: SyncResponse }
  'sync:asset-preview': { args: [request: SyncProjectRequest & { token: string; assetId: string; revision: string; filePath?: string; offset?: number }]; return: { success: boolean; preview?: ProjectAssetPreview; error?: string } }
  'sync:enable': { args: [request: SyncProjectRequest]; return: SyncResponse }
  'sync:preview': { args: [request: SyncProjectRequest]; return: SyncResponse }
  'sync:export': { args: [request: SyncProjectRequest & { targetGrantId: string }]; return: SyncResponse & { filePath?: string } }
  'sync:import-preview': { args: [request: SyncProjectRequest & { sourceGrantId: string }]; return: SyncResponse }
  'sync:apply': { args: [request: SyncProjectRequest & { token: string; resolutions: SyncResolution[] }]; return: SyncResponse }
  'sync:join': { args: [request: { sourceGrantId: string; targetGrantId: string }]; return: SyncResponse & { projectPath?: string; recentProjectUpdated?: boolean } }
  'dialog:select-sync-export': { args: [suggestedName: string]; return: ExternalFileGrant | null }
  'dialog:select-sync-package': { args: []; return: ExternalFileGrant | null }
  'dialog:select-sync-join-target': { args: [suggestedName: string]; return: ExternalFileGrant | null }
}
