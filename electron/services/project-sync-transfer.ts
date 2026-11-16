import { installProjectFileExclusive } from './project-file-install'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import type { SyncApplyResult, SyncBundle } from '../../src/shared/project-sync'
import { CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE, createCanonicalProjectManifest } from '../../src/shared/project-format'
import { DIR_PROMPTS } from '../../src/shared/project-paths'
import { createProjectDatabase } from '../database'
import { migrationRealpath, validatePlatformDirectoryChain } from './migration-file-system'
import { verifySchema } from '../migrations/runner'
import { SqliteSchemaAdapter } from '../migrations/sqlite-schema-adapter'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../migrations/desktop-registry'
import { windowsSafeFileSystem, type SecureFileCapability } from '../security/windows-safe-file-system'
import { disposeProjectSyncEngine } from './project-sync-service'
import { validateSyncBundle } from './project-sync-engine'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof BetterSqlite3
export const MAX_SYNC_PACKAGE_BYTES = 64 * 1024 * 1024
function fail(code: string): never { throw new Error(code) }
const normalized = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
const same = (left: fs.BigIntStats, right: fs.BigIntStats) => left.dev === right.dev && left.ino === right.ino

function directory(file: string): fs.BigIntStats {
  if (!validatePlatformDirectoryChain(file)) {
    for (let cursor = path.resolve(file);; cursor = path.dirname(cursor)) {
      const info = fs.lstatSync(cursor, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink()) fail('SYNC_UNSAFE_PATH')
      if (cursor === path.dirname(cursor)) break
    }
  }
  const info = fs.lstatSync(file, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || normalized(migrationRealpath(file)) !== normalized(file)) fail('SYNC_UNSAFE_PATH')
  return info
}
function assertDirectoryIdentity(file: string, expected: fs.BigIntStats): void {
  if (!same(directory(file), expected)) fail('SYNC_UNSAFE_PATH')
}
function absent(file: string): void {
  try { fs.lstatSync(file); fail('SYNC_TARGET_EXISTS') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
function unlinkOwned(file: string, expected: fs.BigIntStats): void {
  try {
    const info = fs.lstatSync(file, { bigint: true })
    if (info.isFile() && !info.isSymbolicLink() && same(info, expected)
      && normalized(migrationRealpath(file)) === normalized(file)) fs.unlinkSync(file)
  } catch { /* Unknown replacements are never removed. */ }
}

/** Only a consumed exact-file capability reaches this reader. No renderer path. */
export async function readSyncPackage(capability: SecureFileCapability): Promise<SyncBundle> {
  let bytes: Buffer
  try { bytes = await windowsSafeFileSystem.readBytes(capability, MAX_SYNC_PACKAGE_BYTES) }
  catch (error) {
    if (error instanceof Error && error.message === 'SECURE_FS_FILE_TOO_LARGE') fail('SYNC_PACKAGE_TOO_LARGE')
    return fail('SYNC_PACKAGE_UNREADABLE')
  }
  if (bytes.length > MAX_SYNC_PACKAGE_BYTES) fail('SYNC_PACKAGE_TOO_LARGE')
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SYNC_PACKAGE_INVALID')
    return value as SyncBundle // The engine validates every field, batch and hash before mutation.
  } catch { return fail('SYNC_PACKAGE_INVALID') }
}

/** Publish complete JSON from an owned temporary file: never replace a target. */
export function writeSyncPackage(file: string, bundle: SyncBundle, beforePublish: () => void): void {
  const content = Buffer.from(JSON.stringify(bundle), 'utf8')
  if (content.length > MAX_SYNC_PACKAGE_BYTES) fail('SYNC_PACKAGE_TOO_LARGE')
  const target = path.resolve(file), parent = path.dirname(target), parentIdentity = directory(parent)
  absent(target)
  const temporary = path.join(parent, `.ainovelsync-${randomUUID()}.tmp`)
  const fd = fs.openSync(temporary, 'wx', 0o600)
  const identity = fs.fstatSync(fd, { bigint: true })
  try {
    assertDirectoryIdentity(parent, parentIdentity)
    fs.writeFileSync(fd, content); fs.fsyncSync(fd)
    beforePublish()
    assertDirectoryIdentity(parent, parentIdentity)
    const current = fs.lstatSync(temporary, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !same(current, identity)) fail('SYNC_UNSAFE_PATH')
    try { installProjectFileExclusive(temporary, target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('SYNC_TARGET_EXISTS')
      fail('SYNC_PUBLISH_UNSUPPORTED')
    }
    const published = fs.lstatSync(target, { bigint: true })
    if (!published.isFile() || published.isSymbolicLink() || !same(published, identity)) fail('SYNC_UNSAFE_PATH')
  } finally { try { fs.closeSync(fd) } finally { unlinkOwned(temporary, identity) } }
}

export interface JoinSyncProjectInput {
  bundle: SyncBundle
  targetProjectPath: string
  assertTargetAuthorized(): void
  join(database: BetterSqlite3.Database, projectId: string, bundle: SyncBundle): SyncApplyResult
  prepareAssets?(database: BetterSqlite3.Database, storageRoot: string): Promise<void>
  materializeAssets?(database: BetterSqlite3.Database, storageRoot: string): Promise<void>
}

/** A separate join protocol, never an identity-preserving option on archive restore.
 * The active database/lease is untouched. A complete canonical directory is
 * atomically installed inside an exclusively created project root. */
export async function joinSyncProject(input: JoinSyncProjectInput): Promise<{ projectPath: string; projectId: string; applied: SyncApplyResult }> {
  input.assertTargetAuthorized()
  validateSyncBundle(input.bundle)
  if (input.bundle.requiredFeatures?.includes('project-assets-v1') && (!input.prepareAssets || !input.materializeAssets)) fail('SYNC_JOIN_ASSETS_REQUIRED')
  const manifest = createCanonicalProjectManifest({ projectId: input.bundle.projectId, createdAt: new Date().toISOString() })
  const target = path.resolve(input.targetProjectPath), parent = path.dirname(target)
  const parentIdentity = directory(parent)
  absent(target)
  const staging = fs.mkdtempSync(path.join(parent, '.ainovelsync-join-'))
  const stagingIdentity = directory(staging)
  const storage = path.join(staging, CANONICAL_PROJECT_DIRECTORY)
  let database: BetterSqlite3.Database | undefined
  let targetIdentity: fs.BigIntStats | undefined
  let promptsIdentity: fs.BigIntStats | undefined
  let storageIdentity: fs.BigIntStats | undefined
  const ownedFiles = new Map<string, fs.BigIntStats>()
  let published = false
  try {
    fs.mkdirSync(storage, { mode: 0o700 })
    storageIdentity = directory(storage)
    fs.mkdirSync(path.join(staging, DIR_PROMPTS), { mode: 0o700 })
    promptsIdentity = directory(path.join(staging, DIR_PROMPTS))
    fs.writeFileSync(path.join(storage, 'project.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 })
    ownedFiles.set(path.join(storage, 'project.json'), fs.lstatSync(path.join(storage, 'project.json'), { bigint: true }))
    createProjectDatabase(staging)
    const databasePath = path.join(storage, CANONICAL_PROJECT_DATABASE)
    ownedFiles.set(databasePath, fs.lstatSync(databasePath, { bigint: true }))
    database = new Database(databasePath, { fileMustExist: true })
    database.pragma('foreign_keys = ON')
    await input.prepareAssets?.(database, storage)
    input.assertTargetAuthorized()
    const applied = input.join(database, manifest.projectId, input.bundle)
    if (!applied.applied) fail('SYNC_JOIN_INCOMPLETE')
    await input.materializeAssets?.(database, storage)
    input.assertTargetAuthorized()
    const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok'
      || (database.pragma('foreign_key_check') as unknown[]).length) fail('SYNC_JOIN_INVALID')
    verifySchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
    disposeProjectSyncEngine(database); database.close(); database = undefined
    assertDirectoryIdentity(storage, storageIdentity)
    for (const name of ['project.json', CANONICAL_PROJECT_DATABASE]) {
      const file = path.join(storage, name), info = fs.lstatSync(file, { bigint: true })
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || !same(info, ownedFiles.get(file)!)) fail('SYNC_UNSAFE_PATH')
      const fd = fs.openSync(file, 'r+')
      try {
        if (!same(fs.fstatSync(fd, { bigint: true }), info)) fail('SYNC_UNSAFE_PATH')
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
    }
    assertDirectoryIdentity(parent, parentIdentity)
    assertDirectoryIdentity(staging, stagingIdentity)
    input.assertTargetAuthorized()
    absent(target)
    fs.mkdirSync(target, { mode: 0o700 })
    targetIdentity = directory(target)
    assertDirectoryIdentity(parent, parentIdentity)
    assertDirectoryIdentity(target, targetIdentity)
    absent(path.join(target, CANONICAL_PROJECT_DIRECTORY))
    fs.renameSync(storage, path.join(target, CANONICAL_PROJECT_DIRECTORY))
    published = true
    assertDirectoryIdentity(parent, parentIdentity)
    assertDirectoryIdentity(target, targetIdentity)
    assertDirectoryIdentity(path.join(target, CANONICAL_PROJECT_DIRECTORY), storageIdentity)
    return { projectPath: target, projectId: manifest.projectId, applied }
  } finally {
    if (database) disposeProjectSyncEngine(database)
    database?.close()
    // Staging is private and only these fixed files can be created by this service.
    // Preserve unexpected entries rather than recursively deleting unknown content.
    try {
      assertDirectoryIdentity(staging, stagingIdentity)
      if (storageIdentity && fs.existsSync(storage)) {
        assertDirectoryIdentity(storage, storageIdentity)
        for (const [file, info] of ownedFiles) unlinkOwned(file, info)
        if (promptsIdentity) {
          assertDirectoryIdentity(path.join(staging, DIR_PROMPTS), promptsIdentity)
          fs.rmdirSync(path.join(staging, DIR_PROMPTS))
        }
        fs.rmdirSync(storage)
      }
      fs.rmdirSync(staging)
    } catch { /* Retain an uncertain staging tree. */ }
    if (!published && targetIdentity) {
      try {
        assertDirectoryIdentity(target, targetIdentity)
        fs.rmdirSync(target)
      } catch { /* Never remove unknown target contents. */ }
    }
  }
}
