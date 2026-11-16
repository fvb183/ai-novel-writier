import type { GoogleDriveAutoSyncReport, GoogleDriveProject } from '../../src/shared/google-drive-sync'

export interface AutomaticLocalProject { projectId: string; path: string }
export interface AutomaticSyncDependencies {
  projects(): Promise<GoogleDriveProject[]>
  locals(): AutomaticLocalProject[]
  join(project: GoogleDriveProject): Promise<void>
  exchange(project: AutomaticLocalProject, remote: GoogleDriveProject): Promise<'updated' | 'conflict' | 'unchanged'>
  check(): void
  canJoin?(project: GoogleDriveProject): boolean
}

/** Catalog discovery never switches the editor. An incomplete book retries at
 * the same identity on the next tick; one failed book cannot starve the rest. */
export async function synchronizeDriveCatalog(deps: AutomaticSyncDependencies): Promise<GoogleDriveAutoSyncReport> {
  const report: GoogleDriveAutoSyncReport = { imported: 0, updated: 0, conflicts: [], failures: [] }
  const projects = await deps.projects(); deps.check()
  const duplicates = new Set(projects.filter((p, index) => projects.findIndex(other => other.projectId === p.projectId) !== index).map(p => p.projectId))
  for (const remote of projects) {
    deps.check()
    if (remote.autoSync === false) continue
    try {
      if (duplicates.has(remote.projectId)) throw new Error('DRIVE_FOLDER_SELECTION_REQUIRED')
      const locals = deps.locals().filter(local => local.projectId === remote.projectId)
      if (!locals.length) {
        if (deps.canJoin?.(remote) === false) continue
        await deps.join(remote); deps.check(); report.imported++; continue
      }
      for (const local of locals) {
        const result = await deps.exchange(local, remote); deps.check()
        if (result === 'updated') report.updated++
        if (result === 'conflict' && !report.conflicts.includes(remote.projectId)) report.conflicts.push(remote.projectId)
      }
    } catch (error) {
      deps.check()
      const code = error instanceof Error ? error.message : ''
      report.failures.push({ projectId: remote.projectId, error: /^(?:DRIVE|GOOGLE|SYNC|PROJECT_SYNC)_[A-Z0-9_]+$/.test(code) ? code : 'DRIVE_OPERATION_FAILED' })
    }
    // The Android backend shares the UI thread. Yield between complete books.
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return report
}
