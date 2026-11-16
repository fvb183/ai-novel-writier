import type { ProjectSessionContext } from './ipc-channels'
export interface DriveBackupGeneration {
  generationId: string; parentGenerationIds: string[]; createdAt: string; originProjectId: string
  snapshotGeneration: string; archiveSha256: string; archiveByteSize: number
  archiveFileId: string; manifestFileId: string; siblingGenerationIds: string[]
}
export interface DriveBackupResponse {
  success: boolean; error?: string; generations?: DriveBackupGeneration[]; pendingOperationId?: string
  generation?: DriveBackupGeneration; projectPath?: string; targetProjectId?: string; cancelled?: boolean
}
export interface GoogleDriveBackupChannels {
  'drive:backup-list': { args: [input: { projectSession?: ProjectSessionContext; operationId?: string }]; return: DriveBackupResponse }
  'drive:backup-create': { args: [input: { projectSession?: ProjectSessionContext; operationId: string; parentGenerationIds: string[] }]; return: DriveBackupResponse }
  'drive:backup-restore': { args: [input: { projectSession?: ProjectSessionContext; operationId: string; generationId: string; targetGrantId: string }]; return: DriveBackupResponse }
  'drive:backup-cancel': { args: [input: { operationId: string }]; return: DriveBackupResponse }
}
