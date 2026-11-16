import { create } from 'zustand'
import { projectPathKey } from '../shared/project-session-context'
export const drivePathKey = (path: string) => projectPathKey(path) ?? path
export type DriveSyncStage = 'authorization' | 'catalog' | 'download' | 'assets' | 'apply' | 'complete' | 'project-status' | 'transfer'
export const useDriveSyncStore = create<{
  projects: Record<string, boolean>
  phase: 'idle' | 'syncing' | 'error'
  stage: DriveSyncStage | null
  message: string
  errorCode: string | null
  nextRetryAt: number | null
  lastChecked: number | null
}>()(() => ({ projects: {}, phase: 'idle', stage: null, message: '', errorCode: null, nextRetryAt: null, lastChecked: null }))

export function acceptDriveProjects(projects?: { path: string; enabled: boolean }[]) {
  if (projects) useDriveSyncStore.setState({ projects: Object.fromEntries(projects.map(project => [drivePathKey(project.path), project.enabled])) })
}
