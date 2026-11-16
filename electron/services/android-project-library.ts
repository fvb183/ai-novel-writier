import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { parseCanonicalProjectManifest } from '../../src/shared/project-format'
import { sameProjectPathKey } from '../../src/shared/project-session-context'
import { getGlobalDataRoot } from './app-data-locator'
import { tryReadJsonFile, writeJsonFile } from '../utils/config-utils'

export interface LibraryProject { name: string; path: string; projectId?: string; updatedAt: string }

/** These are app-owned locations, never user-selected external folders. Keep
 * the former automatic-sync location readable after switching to Projects. */
export const androidProjectLibraryRoots = (filesRoot: string) => [path.join(filesRoot, 'Projects'), path.join(filesRoot, 'AI-Novel-Writer')]

/** Read only the title of a previously admitted file. Android maps this to
 * OPEN_READONLY: no migration, metadata repair, or whole-database snapshot. */
export function readAndroidLibraryProjectName(databasePath: string): string | undefined {
  const Database = createRequire(import.meta.url)('better-sqlite3') as typeof BetterSqlite3
  let database: BetterSqlite3.Database | undefined
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 250 })
    const row = database.prepare("SELECT project_name FROM project_core WHERE id='main' LIMIT 1").get() as { project_name?: unknown } | undefined
    const name = row?.project_name
    return typeof name === 'string' && name.trim() && name.length <= 200 && !/[\u0000-\u001f]/.test(name) ? name : undefined
  } catch { return undefined }
  finally { database?.close() }
}

const exclusionsPath = () => path.join(getGlobalDataRoot(), 'project-library-exclusions.json')
function exclusions(): string[] {
  const result = tryReadJsonFile<{ version: number; paths: string[] }>(exclusionsPath())
  if (result.status === 'missing') return []
  if (result.status !== 'ok' || result.value?.version !== 1 || !Array.isArray(result.value.paths)
    || result.value.paths.some(value => typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))) throw new Error('PROJECT_LIBRARY_INDEX_INVALID')
  return result.value.paths
}
export function isAndroidLibraryProjectHidden(projectPath: string): boolean {
  return exclusions().some(value => sameProjectPathKey(value, projectPath))
}
export function setAndroidLibraryProjectHidden(projectPath: string, hidden: boolean): void {
  const current = exclusions(), next = current.filter(value => !sameProjectPathKey(value, projectPath))
  if (hidden) next.push(projectPath)
  if (JSON.stringify(current) !== JSON.stringify(next)) writeJsonFile(exclusionsPath(), { version: 1, paths: next })
}

function directory(value: string): void {
  const info = fs.lstatSync(value)
  if (!info.isDirectory() || info.isSymbolicLink() || !sameProjectPathKey(fs.realpathSync(value), value)) throw new Error('PROJECT_LIBRARY_UNSAFE_PATH')
}
function regular(value: string): fs.Stats {
  const info = fs.lstatSync(value)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('PROJECT_LIBRARY_UNSAFE_PATH')
  return info
}

/** A completed on-disk book must not depend on the last cloud request or the
 * recent-list write having succeeded. Discovery grants only a shelf entry;
 * opening still follows normal schema/identity validation and project leases. */
export function recoverAndroidLibraryProjects(filesRoot: string, known: readonly LibraryProject[], hidden: readonly string[] = exclusions(),
  readName: (databasePath: string) => string | undefined = readAndroidLibraryProjectName): LibraryProject[] {
  const recovered: LibraryProject[] = []
  for (const root of androidProjectLibraryRoots(filesRoot)) {
    try { directory(root) } catch { continue }
    for (const name of fs.readdirSync(root).slice(0, 1000)) {
      if (name.startsWith('.')) continue // In-progress join staging never enters the shelf.
      const projectPath = path.join(root, name)
      const existing = known.find(project => sameProjectPathKey(project.path, projectPath))
      const unnamed = existing?.name === name && /^[0-9a-f]{8}-[0-9a-f]{4}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i.test(name)
      if (existing && !unnamed || hidden.some(value => sameProjectPathKey(value, projectPath))) continue
      try {
        directory(projectPath)
        const storage = path.join(projectPath, '.ai-novel'); directory(storage)
        const manifestPath = path.join(storage, 'project.json'), databasePath = path.join(storage, 'project.db')
        if (regular(manifestPath).size > 4096 || regular(databasePath).size < 100) continue
        const manifest = parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
        const migrationJournal = path.join(projectPath, '.ai-novel-migration', 'journal.json')
        if (fs.existsSync(migrationJournal)) {
          directory(path.dirname(migrationJournal))
          if (regular(migrationJournal).size > 64 * 1024) continue
          const journal = JSON.parse(fs.readFileSync(migrationJournal, 'utf8'))
          if (journal.version !== 1 || journal.phase !== 'switched' || journal.projectId !== manifest.projectId) continue
        }
        if (fs.existsSync(databasePath + '-journal')) continue
        // Admit the file before the one-row read-only title query.
        const header = Buffer.alloc(16), fd = fs.openSync(databasePath, 'r')
        try { if (fs.readSync(fd, header, 0, header.length, 0) !== 16 || header.toString('binary') !== 'SQLite format 3\0') continue }
        finally { fs.closeSync(fd) }
        const title = readName(databasePath)
        if (existing && (!title || existing.projectId && existing.projectId !== manifest.projectId)) continue
        recovered.push({ name: title || name, path: projectPath, projectId: manifest.projectId, updatedAt: existing?.updatedAt || manifest.createdAt })
      } catch { /* Incomplete, linked, unreadable and legacy directories stay untouched. */ }
    }
  }
  return recovered
}
