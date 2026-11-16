import fs from 'node:fs'
import { app } from 'electron'
import path from 'node:path'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { parseCanonicalProjectManifest } from '../../src/shared/project-format'
import { sameProjectPathKey } from '../../src/shared/project-session-context'
import { getCurrentProjectPath } from '../database'
import { loadRecentProjects, registerRecentProject } from '../controllers/project-controller'
import { captureSecureRootIdentity } from '../security/windows-safe-file-system'
import { openCanonicalProjectData, deactivateProjectData } from './project-data-locator'
import { openVerifiedProjectHandle } from './verified-project-open'
import { disposeProjectSyncEngine, getProjectSyncEngine } from './project-sync-service'
import { applyProjectAuthorSync, prepareProjectAuthorAssets, recoverProjectAuthorAssets } from './project-asset-runtime'
import { ProjectAssetBlobStore } from './project-asset-blob-store'
import { joinSyncProject } from './project-sync-transfer'
import { synchronizeDriveCatalog } from './google-drive-automatic-sync'
import type { GoogleDriveClient } from './google-drive-client'
import type { GoogleDriveStateStore } from './google-drive-state'
import type { GoogleDriveSyncService } from './google-drive-sync-service'
import type { GoogleDriveProgressReporter } from '../../src/shared/google-drive-sync'
import { androidProjectLibraryRoots } from './android-project-library'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof BetterSqlite3
const fail = (code: string): never => { throw new Error(code) }

export class GoogleDriveLocalProjects {
  private checked = new Map<string, { projectId: string; stamp: string; at: number; result: 'updated' | 'conflict' | 'unchanged' }>()
  constructor(private state: GoogleDriveStateStore, private service: GoogleDriveSyncService, private locks: Set<string>) {}
  invalidate(projectId: string) {
    for (const [key, value] of this.checked) if (value.projectId === projectId) this.checked.delete(key)
  }
  /** A short-lived metadata hint can skip idle DB/asset revalidation, never an
   * incoming apply. Any new remote package takes the full verified path. */
  private stamp(projectPath: string): string | undefined {
    try {
      const root = path.join(projectPath, '.ai-novel'), entries: unknown[] = []
      const sourceDirectories = new Set(['prompts', 'skills', 'partial_arch', 'avatars', 'knowledge-copies', 'lancedb'])
      const walk = (directory: string, all: boolean) => {
        for (const name of fs.readdirSync(directory).sort()) {
          if (name.endsWith('-shm')) continue
          const file = path.join(directory, name), stat = fs.lstatSync(file)
          if (stat.isSymbolicLink() || entries.length > 2000) throw new Error('uncacheable')
          if (stat.isDirectory()) { if (all || sourceDirectories.has(name)) walk(file, true) }
          else if (stat.isFile()) entries.push([file, stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino])
        }
      }
      walk(root, false)
      const pointer = path.join(root, 'knowledge-sync-projection.json')
      if (fs.existsSync(pointer)) {
        const stat = fs.lstatSync(pointer)
        if (stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) return
        const generation: unknown = JSON.parse(fs.readFileSync(pointer, 'utf8')).generation
        if (typeof generation === 'string' && /^[0-9a-f-]{36}$/i.test(generation)) walk(path.join(root, 'knowledge-sync-generations', generation), true)
        else if (generation !== null) return
      }
      return JSON.stringify(entries)
    } catch { return undefined }
  }
  private managedRoot(create = false) {
    // Novel roots must stay stable across config generations and short enough
    // for Windows SQLite/knowledge files. Android maps documents to app files.
    const root = path.resolve(process.env.AI_NOVEL_SYNC_PROJECTS_HOME || (process.platform === 'android'
      ? androidProjectLibraryRoots(app.getPath('appData'))[0] : path.join(app.getPath('documents'), 'AI-Novel-Writer')))
    if (create) fs.mkdirSync(root, { recursive: true })
    if (fs.existsSync(root)) captureSecureRootIdentity(root)
    return root
  }
  locals() {
    const candidates = new Set(loadRecentProjects().map(project => project.path))
    for (const binding of Object.values(this.state.read().bindings)) if (binding.localPath) candidates.add(binding.localPath)
    const roots = new Set([this.managedRoot(), ...(process.platform === 'android' ? androidProjectLibraryRoots(app.getPath('appData')) : [])])
    for (const root of roots) if (fs.existsSync(root)) for (const name of fs.readdirSync(root).slice(0, 1000)) if (!name.startsWith('.')
      && (process.platform === 'android' || /^[0-9a-f-]{12,36}$/i.test(name))) candidates.add(path.join(root, name))
    const result: { path: string; projectId: string }[] = []
    for (const directory of candidates) {
      try {
        const file = path.join(directory, '.ai-novel', 'project.json'), info = fs.lstatSync(file)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) continue
        const manifest = parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(file, 'utf8')))
        if (fs.existsSync(path.join(directory, '.ai-novel', 'project.db')) && !result.some(p => sameProjectPathKey(p.path, directory))) result.push({ path: directory, projectId: manifest.projectId })
      } catch { /* Missing, legacy and incomplete projects are never opened by a timer. */ }
    }
    return result
  }
  preferences() {
    const snapshot = this.state.read(), bindings = Object.values(snapshot.bindings), enabling = Object.values(snapshot.enabling ?? {})
    return this.locals().map(project => ({ path: project.path, enabled: bindings.some(binding => binding.projectId === project.projectId
      && (!binding.localPath || sameProjectPathKey(binding.localPath, project.path)) && binding.autoSync === true)
      || enabling.some(intent => intent.projectId === project.projectId && sameProjectPathKey(intent.localPath, project.path)) }))
  }
  async withClosedProject<T>(project: { path: string; projectId: string }, check: () => void,
    action: (database: BetterSqlite3.Database, revalidate: () => void) => Promise<T>): Promise<T> {
    const identity = captureSecureRootIdentity(project.path)
    const revalidate = () => {
      check()
      if (sameProjectPathKey(getCurrentProjectPath(), project.path)) fail('SYNC_PROJECT_BUSY')
      const live = captureSecureRootIdentity(project.path)
      if (identity.volumeSerialNumber !== live.volumeSerialNumber || identity.fileIndex !== live.fileIndex) fail('SYNC_SESSION_STALE')
    }
    revalidate()
    const verified = openCanonicalProjectData(project.path)
    let database: BetterSqlite3.Database | undefined
    try {
      const file = path.join(project.path, '.ai-novel', 'project.db')
      const manifest = parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'project.json'), 'utf8')))
      if (manifest.projectId !== project.projectId) fail('SYNC_PROJECT_ID_MISMATCH')
      revalidate(); database = openVerifiedProjectHandle(Database, file, verified)
      database.pragma('foreign_keys = ON')
      return await action(database, revalidate)
    } finally {
      if (database) { disposeProjectSyncEngine(database); database.close() }
      if (!sameProjectPathKey(getCurrentProjectPath(), project.path)) deactivateProjectData(project.path)
    }
  }
  rememberPath(projectId: string, replicaId: string, localPath: string) {
    this.state.update(state => { const binding = state.bindings[`${projectId}|${replicaId}`]; if (binding) binding.localPath = localPath })
  }
  async synchronize(client: GoogleDriveClient, check: () => void, progress?: GoogleDriveProgressReporter) {
    progress?.({ stage: 'authorization' })
    const accountId = await client.accountId(); check()
    const enableFailures: { projectId: string; error: string }[] = []
    // Retry an interrupted explicit switch-on even if no cloud folder exists
    // yet, or its first baseline is still hidden from catalog discovery.
    for (const intent of Object.values(this.state.read().enabling ?? {})) {
      if (intent.accountId !== accountId) { enableFailures.push({ projectId: intent.projectId, error: 'DRIVE_ACCOUNT_MISMATCH' }); continue }
      if (this.locks.has(intent.projectId) || sameProjectPathKey(getCurrentProjectPath(), intent.localPath)) continue
      const local = this.locals().find(project => project.projectId === intent.projectId && sameProjectPathKey(project.path, intent.localPath))
      if (!local) continue
      this.locks.add(local.projectId)
      try {
        await this.withClosedProject(local, check, async (database, revalidate) => {
          const engine = getProjectSyncEngine(database, local.projectId)
          engine.enable()
          if (engine.status().replicaId !== intent.replicaId) fail('DRIVE_BINDING_CHANGED')
          let binding = this.state.binding(local.projectId, intent.replicaId)
          if (!binding) binding = await this.service.bind(client, local.projectId, intent.replicaId, intent.name, undefined, revalidate)
          if (binding.accountId !== accountId) fail('DRIVE_ACCOUNT_MISMATCH')
          this.rememberPath(local.projectId, intent.replicaId, local.path)
          const context = { database, projectId: local.projectId, storageRoot: path.dirname(database.name), revalidate }
          const store = await prepareProjectAuthorAssets(context); revalidate()
          await this.service.exchange(client, local.projectId, engine, revalidate, store, progress); revalidate()
        })
      } catch (error) {
        check()
        const code = error instanceof Error ? error.message : ''
        enableFailures.push({ projectId: local.projectId, error: /^(?:DRIVE|GOOGLE|SYNC|PROJECT_SYNC)_[A-Z0-9_]+$/.test(code) ? code : 'DRIVE_UPLOAD_FAILED' })
      } finally { this.locks.delete(local.projectId) }
    }
    for (const binding of Object.values(this.state.read().bindings)) if (binding.pendingDisable && binding.accountId === accountId) {
      if (this.locks.has(binding.projectId)) continue
      this.locks.add(binding.projectId)
      try {
        await client.setProjectAutoSync(binding.folderId, binding.projectId, false); check()
        this.state.update(state => { const live = state.bindings[`${binding.projectId}|${binding.replicaId}`]; if (live?.pendingDisable) live.pendingDisable = false })
      } finally { this.locks.delete(binding.projectId) }
    }
    const report = await synchronizeDriveCatalog({ projects: async () => {
      progress?.({ stage: 'catalog' })
      const projects = await client.projects(); check()
      this.state.update(state => {
        for (const binding of Object.values(state.bindings)) {
          const remote = projects.find(project => project.folderId === binding.folderId && project.projectId === binding.projectId)
          if (remote && binding.accountId === accountId && !binding.pendingDisable && !state.enabling?.[`${binding.projectId}|${binding.replicaId}`]
            && !this.locks.has(binding.projectId)) binding.autoSync = remote.autoSync !== false
        }
      })
      return projects
    }, locals: () => this.locals(), check, canJoin: project => !this.state.read().excludedProjects?.[accountId]?.includes(project.projectId),
      join: async remote => {
        const root = this.managedRoot(true), target = path.join(root, remote.projectId.slice(0, 13)), identity = captureSecureRootIdentity(root)
        const checked = () => {
          check(); const live = captureSecureRootIdentity(root)
          if (identity.volumeSerialNumber !== live.volumeSerialNumber || identity.fileIndex !== live.fileIndex) fail('SYNC_SESSION_STALE')
        }
        const downloaded = await this.service.downloadProject(client, remote.folderId, checked, progress)
        if (downloaded.bundle.projectId !== remote.projectId) fail('DRIVE_PROJECT_MISMATCH')
        let replicaId = ''
        const result = await joinSyncProject({ bundle: downloaded.bundle, targetProjectPath: target, assertTargetAuthorized: checked,
          prepareAssets: async (_database, storageRoot) => {
            progress?.({ stage: 'assets', projectId: remote.projectId })
            await this.service.hydrateBundleAssets(client, downloaded.bundle, remote.folderId, new ProjectAssetBlobStore(storageRoot), checked)
            progress?.({ stage: 'apply', projectId: remote.projectId })
          },
          materializeAssets: (database, storageRoot) => recoverProjectAuthorAssets({ database, projectId: remote.projectId, storageRoot, revalidate: checked }),
          join: (database, id, bundle) => { const engine = getProjectSyncEngine(database, id), applied = engine.join(bundle); replicaId = engine.status().replicaId!; return applied } })
        this.service.rememberJoined({ ...downloaded.binding, autoSync: true, localPath: result.projectPath }, replicaId)
        registerRecentProject({ path: result.projectPath, projectId: result.projectId, name: remote.name.replace(/^AI Novel Writer · /, ''), updatedAt: new Date().toISOString() }, { automatic: true })
      },
      exchange: async (local, remote) => {
        if (sameProjectPathKey(getCurrentProjectPath(), local.path) || this.locks.has(local.projectId)) return 'unchanged'
        this.locks.add(local.projectId)
        try {
          const before = this.stamp(local.path), previous = this.checked.get(local.path)
          const binding = Object.values(this.state.read().bindings).find(binding => binding.projectId === local.projectId
            && binding.accountId === accountId && binding.folderId === remote.folderId && binding.localPath && sameProjectPathKey(binding.localPath, local.path))
          if (before && previous?.stamp === before && Date.now() - previous.at < 120_000 && binding?.assetPolicyVersion === 1 && !binding.historyCleanupError) {
            const discovered = await client.discover(remote.folderId, local.projectId, binding.files, binding.cursor); check()
            if (sameProjectPathKey(getCurrentProjectPath(), local.path)) return 'unchanged'
            const unchanged = discovered.files.every(file => {
              const prior = binding.files.find(old => old.id === file.id)
              return binding.received[file.id] === file.appProperties?.ainwDigest && prior?.size === file.size && prior?.md5Checksum === file.md5Checksum
            })
            if (unchanged && before === this.stamp(local.path)) {
              this.state.update(state => {
                const live = state.bindings[`${binding.projectId}|${binding.replicaId}`]
                if (live?.accountId === accountId && live.folderId === remote.folderId) { live.cursor = discovered.cursor; live.files = discovered.files }
              })
              return previous.result === 'conflict' ? 'conflict' : 'unchanged'
            }
          }
          const result = await this.withClosedProject(local, check, async (database, revalidate) => {
            const engine = getProjectSyncEngine(database, local.projectId), context = { database, projectId: local.projectId, storageRoot: path.dirname(database.name), revalidate }
            engine.enable(); const replicaId = engine.status().replicaId!
            let binding = this.state.binding(local.projectId, replicaId)
            if (!binding) binding = await this.service.bind(client, local.projectId, replicaId, remote.name, remote.folderId, revalidate)
            if (binding.folderId !== remote.folderId) fail('DRIVE_PROJECT_MISMATCH')
            if (binding.accountId !== accountId) fail('DRIVE_ACCOUNT_MISMATCH')
            this.rememberPath(local.projectId, replicaId, local.path)
            this.service.setAutoSync(local.projectId, replicaId, true)
            const store = await prepareProjectAuthorAssets(context); revalidate()
            const exchanged = await this.service.exchange(client, local.projectId, engine, revalidate, store, progress); revalidate()
            if (exchanged.preview.conflicts.length || exchanged.preview.missingBatchHashes.length) return 'conflict'
            if (!exchanged.preview.pendingBatches) return 'unchanged'
            progress?.({ stage: 'apply', projectId: local.projectId })
            const applied = await applyProjectAuthorSync(context, exchanged.preview.token, []); revalidate()
            if (!applied.applied || applied.assetsPending) fail('PROJECT_SYNC_ASSET_NOT_READY')
            return 'updated'
          })
          const stamp = this.stamp(local.path)
          if (stamp) this.checked.set(local.path, { projectId: local.projectId, stamp, at: Date.now(), result })
          if (!loadRecentProjects().some(project => sameProjectPathKey(project.path, local.path))) {
            registerRecentProject({ ...local, name: remote.name.replace(/^AI Novel Writer · /, ''), updatedAt: new Date().toISOString() }, { automatic: true })
            return result === 'conflict' ? 'conflict' : 'updated'
          }
          return result
        } finally { this.locks.delete(local.projectId) }
      },
    })
    for (const failure of enableFailures) if (!report.failures.some(item => item.projectId === failure.projectId)) report.failures.push(failure)
    const cleanupWarnings = new Map<string, string>()
    for (const binding of Object.values(this.state.read().bindings)) {
      if (binding.accountId === accountId && binding.autoSync && binding.historyCleanupError) {
        cleanupWarnings.set(binding.projectId, binding.historyCleanupError)
      }
    }
    if (cleanupWarnings.size) report.cleanupWarnings = [...cleanupWarnings].map(([projectId, error]) => ({ projectId, error }))
    return report
  }
}
