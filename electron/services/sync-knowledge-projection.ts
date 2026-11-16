/** Device-local, recoverable projection selection. SQLite/CAS remains the authority. */
import fs from 'node:fs'
import path from 'node:path'
import { createSecureFileCapability, windowsSafeFileSystem } from '../security/windows-safe-file-system'
import { migrationRealpath, validatePlatformDirectoryChain } from './migration-file-system'

export const SYNC_KNOWLEDGE_GENERATIONS = 'knowledge-sync-generations'
export const SYNC_KNOWLEDGE_METADATA = 'sync-knowledge-documents.json'
export const SYNC_KNOWLEDGE_JOURNAL = 'knowledge-sync-journal.json'
const POINTER = 'knowledge-sync-projection.json'
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const guards = new Map<string, () => string | null>()
const key = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)
export interface SyncKnowledgeProjection {
  version: 1; generation: string | null; selectionHash: string; canonicalHash: string
}
export interface SyncKnowledgeJournal extends SyncKnowledgeProjection { beforeHash: string; phase: 'prepared' | 'built' }
export function assertSyncKnowledgePhysicalDirectory(root: string): void {
  if (!path.isAbsolute(root)) throw new Error('KNOWLEDGE_SYNC_UNSAFE_PATH')
  if (validatePlatformDirectoryChain(root)) return
  let current = root
  while (true) {
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || key(migrationRealpath(current)) !== key(current)) throw new Error('KNOWLEDGE_SYNC_UNSAFE_PATH')
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}
export function readSyncKnowledgeJson(root: string, relative: string): unknown | null {
  assertSyncKnowledgePhysicalDirectory(root)
  const file = path.join(root, relative)
  if (!fs.existsSync(file)) return null
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024
    || key(migrationRealpath(file)) !== key(file)) throw new Error('KNOWLEDGE_SYNC_UNSAFE_PATH')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
export async function writeSyncKnowledgeJson(root: string, relative: string, value: unknown, beforeReplace?: () => void | Promise<void>): Promise<void> {
  assertSyncKnowledgePhysicalDirectory(root)
  await windowsSafeFileSystem.writeTextAtomically(createSecureFileCapability(root, path.join(root, relative)), `${JSON.stringify(value)}\n`, beforeReplace)
}
export function parseSyncKnowledgeProjection(value: unknown): SyncKnowledgeProjection {
  const item = value as Partial<SyncKnowledgeProjection> | null
  if (!item || item.version !== 1 || (item.generation !== null && (typeof item.generation !== 'string' || !UUID.test(item.generation)))
    || typeof item.selectionHash !== 'string' || !HASH.test(item.selectionHash) || typeof item.canonicalHash !== 'string' || !HASH.test(item.canonicalHash)) {
    throw new Error('KNOWLEDGE_SYNC_INVALID_PROJECTION')
  }
  return { version: 1, generation: item.generation, selectionHash: item.selectionHash, canonicalHash: item.canonicalHash }
}
/** The guard must read the live selected SQLite manifest; never close over an old hash. */
export function registerSyncKnowledgeReadGuard(root: string, guard: () => string | null): () => void {
  const id = key(root)
  if (guards.has(id)) throw new Error('KNOWLEDGE_SYNC_GUARD_ALREADY_REGISTERED')
  guards.set(id, guard)
  return () => { if (guards.get(id) === guard) guards.delete(id) }
}
export function assertSyncKnowledgeSelected(root: string, selectionHash: string, verifySelected?: () => void): void {
  if (!HASH.test(selectionHash)) throw new Error('KNOWLEDGE_SYNC_INVALID_SELECTION')
  const guard = guards.get(key(root))
  if (!guard) throw new Error('KNOWLEDGE_SYNC_SELECTION_GUARD_REQUIRED')
  if (guard() !== selectionHash) throw new Error('KNOWLEDGE_SYNC_SELECTION_CHANGED')
  verifySelected?.()
}
export function readSyncKnowledgeSelectedHash(root: string): string | null {
  const guard = guards.get(key(root))
  if (!guard) throw new Error('KNOWLEDGE_SYNC_SELECTION_GUARD_REQUIRED')
  const selected = guard()
  if (selected !== null && (typeof selected !== 'string' || !HASH.test(selected))) throw new Error('KNOWLEDGE_SYNC_INVALID_SELECTION')
  return selected
}
/** Internal adapter access can inspect a previous complete generation after SQLite selected a successor. */
export function readSyncKnowledgeProjection(root: string, allowPending = false): SyncKnowledgeProjection | null {
  const raw = readSyncKnowledgeJson(root, POINTER)
  const projection = raw === null ? null : parseSyncKnowledgeProjection(raw)
  if (!allowPending) {
    const guard = guards.get(key(root))
    if (projection && !guard) throw new Error('KNOWLEDGE_SYNC_SELECTION_GUARD_REQUIRED')
    const selected = guard?.() ?? null
    if (selected !== null && (!projection || projection.selectionHash !== selected)) throw new Error('KNOWLEDGE_SYNC_NOT_READY')
    const journal = readSyncKnowledgeJson(root, SYNC_KNOWLEDGE_JOURNAL) as Partial<SyncKnowledgeJournal> | null
    if (journal && (!projection || projection.generation !== journal.generation || projection.canonicalHash !== journal.canonicalHash
      || projection.selectionHash !== journal.selectionHash)) throw new Error('KNOWLEDGE_SYNC_NOT_READY')
  }
  return projection
}
export function syncKnowledgePhysicalRoot(root: string, projection: SyncKnowledgeProjection | null): string {
  if (!projection?.generation) return root
  const directory = path.join(root, SYNC_KNOWLEDGE_GENERATIONS, projection.generation)
  assertSyncKnowledgePhysicalDirectory(directory)
  return directory
}
/** All canonical readers, local imports/edits/removals, registry and copy I/O use this resolver. */
export function resolveKnowledgeProjectionStorageRoot(root: string): string {
  return syncKnowledgePhysicalRoot(root, readSyncKnowledgeProjection(root))
}
export function knowledgeProjectionIdentity(root: string): string | undefined {
  const state = readSyncKnowledgeProjection(root)
  return state ? `${state.generation ?? 'legacy'}:${state.selectionHash}` : undefined
}
export async function selectSyncKnowledgeProjection(root: string, projection: SyncKnowledgeProjection, verifySelected?: () => void): Promise<void> {
  assertSyncKnowledgeSelected(root, projection.selectionHash, verifySelected)
  syncKnowledgePhysicalRoot(root, projection)
  await writeSyncKnowledgeJson(root, POINTER, parseSyncKnowledgeProjection(projection),
    () => assertSyncKnowledgeSelected(root, projection.selectionHash, verifySelected))
  assertSyncKnowledgeSelected(root, projection.selectionHash, verifySelected)
}
