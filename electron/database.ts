/**
 * Vela SQLite 数据库服务 — 主进程使用
 *
 * 负责 SQLite 实例的连接、生命周期与建表。
 * 具体业务逻辑由 /repositories 提供。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { parseCanonicalProjectManifest } from '../src/shared/project-format'
import { disposeProjectSyncEngine, wrapProjectDatabase } from './services/project-sync-service'
import { initializeLegacyBaselineSchema } from './migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from './migrations/desktop-registry'
import { migrateSchema } from './migrations/runner'
import { SqliteSchemaAdapter } from './migrations/sqlite-schema-adapter'
import { openCanonicalProjectData, deactivateProjectData, getNewProjectDatabasePath, getProjectDatabasePath } from './services/project-data-locator'
import { openVerifiedProjectHandle } from './services/verified-project-open'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
import type BetterSqlite3 from 'better-sqlite3'

let projectDb: BetterSqlite3.Database | null = null
let currentProjectPath: string | null = null

/** 初始化项目数据库（打开项目时调用） */
export function createProjectDatabase(projectPath: string, importSourceSecret?: Buffer, initialize?: (database: BetterSqlite3.Database) => void): void {
  const file = getNewProjectDatabasePath(projectPath)
  const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd)
  const database = new Database(file, { fileMustExist: true })
  try {
    database.pragma('foreign_keys = ON')
    database.transaction(() => initializeLegacyBaselineSchema(database, importSourceSecret))()
    migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
    if (initialize) database.transaction(() => initialize(database))()
  } finally { database.close() }
}

/** Existing projects are verified before acquiring a writable handle or fencing. */
export function initProjectDatabase(projectPath: string): void {
  closeProjectDatabase()
  let database: BetterSqlite3.Database | undefined
  try {
    const verified = openCanonicalProjectData(projectPath)
    const databasePath = getProjectDatabasePath(projectPath)
    database = openVerifiedProjectHandle(Database, databasePath, verified)
    database.pragma('journal_mode = WAL')
    // Foreign-key enforcement belongs to each handle, including Android's.
    database.pragma('foreign_keys = ON')
    fenceProjectSession(database)
    const manifest = parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(path.join(path.dirname(getProjectDatabasePath(projectPath)), 'project.json'), 'utf8')))
    projectDb = wrapProjectDatabase(database, manifest.projectId)
    currentProjectPath = projectPath
  } catch (error) {
    database?.close(); deactivateProjectData(projectPath); throw error
  }
}

export interface ProjectDatabaseBeforeCloseContext { projectPath: string; database: BetterSqlite3.Database }
const beforeCloseListeners = new Set<(context: ProjectDatabaseBeforeCloseContext) => void>()
let notifyingBeforeClose = false
/** Main owners must synchronously persist pause/cancel and stop new dispatch.
 * Async work must be awaited by their own outer lifecycle before asking to close.
 */
export function onProjectDatabaseBeforeClose(listener: (context: ProjectDatabaseBeforeCloseContext) => void): () => void {
  beforeCloseListeners.add(listener)
  return () => { beforeCloseListeners.delete(listener) }
}

/** 关闭项目数据库 */
export function closeProjectDatabase(): void {
  if (notifyingBeforeClose) throw new Error('PROJECT_DATABASE_CLOSE_REENTRANT')
  if (projectDb && currentProjectPath) {
    notifyingBeforeClose = true
    try {
      for (const listener of beforeCloseListeners) {
        const result: unknown = listener({ projectPath: currentProjectPath, database: projectDb })
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          void Promise.resolve(result).catch(() => {})
          throw new Error('PROJECT_DATABASE_BEFORE_CLOSE_MUST_BE_SYNCHRONOUS')
        }
      }
    } finally { notifyingBeforeClose = false }
  }
  // Clear the process-visible identity before closing the native handle. If
  // the close itself throws, callers still fail closed instead of treating a
  // half-closed database as the active project.
  const closingDatabase = projectDb
  const closingProjectPath = currentProjectPath
  projectDb = null
  currentProjectPath = null
  if (closingProjectPath) deactivateProjectData(closingProjectPath)
  if (closingDatabase) disposeProjectSyncEngine(closingDatabase)
  closingDatabase?.close()
}

/** 获取当前数据库实例 */
export function getProjectDb(): BetterSqlite3.Database | null {
  return projectDb
}

/** 获取当前已打开项目路径 */
export function getCurrentProjectPath(): string | null {
  return currentProjectPath
}

/** Session ownership changes are separate from schema migration. */
export function fenceProjectSession(db: BetterSqlite3.Database): void {
  db.exec(`
    UPDATE import_runs
    SET execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
        updated_at = datetime('now')
    WHERE status = 'running' AND (execution_owner <> '' OR lease_expires_at <> 0)
  `)

}
