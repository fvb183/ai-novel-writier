import type Database from 'better-sqlite3'
import { CompactProjectSyncEngine } from './compact-project-sync-engine'
import { compactProjectSyncProjection } from './project-sync-projection'
import path from 'node:path'
import { assertProjectAssetsReady, hasProjectAssetSchema, selectedKnowledgeAssetHash } from './project-sync-assets'
import { registerSyncKnowledgeReadGuard } from './sync-knowledge-projection'
import { registerProjectAssetAccess } from './project-asset-access'
import { isPortableProjectMutation } from './project-sync-mutation-policy'

const rawDatabases = new WeakMap<Database.Database, Database.Database>()
const engines = new WeakMap<Database.Database, CompactProjectSyncEngine>()
const wrappedDatabases = new WeakMap<Database.Database, Database.Database>()
const cleanup = new WeakMap<Database.Database, () => void>()
const savedListeners = new Set<(projectId: string) => void>()
export function onProjectSyncSaved(listener: (projectId: string) => void) {
  savedListeners.add(listener)
  return () => { savedListeners.delete(listener) }
}

export function getProjectSyncEngine(database: Database.Database, projectId: string): CompactProjectSyncEngine {
  const raw = rawDatabases.get(database) ?? database
  let engine = engines.get(raw)
  if (engine && engine.projectId !== projectId) throw new Error('SYNC_PROJECT_ID_MISMATCH')
  if (!engine) {
    engine = new CompactProjectSyncEngine(raw, projectId, compactProjectSyncProjection, id => {
      for (const listener of savedListeners) { try { listener(id) } catch { /* Keep author saves independent of view lifetime. */ } }
    }); engines.set(raw, engine)
    if (raw.name !== ':memory:' && hasProjectAssetSchema(raw)) {
      const root = path.dirname(raw.name)
      const current = () => { if (!raw.open) throw new Error('SYNC_SESSION_STALE') }
      const releaseKnowledge = registerSyncKnowledgeReadGuard(root, () => { current(); return selectedKnowledgeAssetHash(raw) })
      const releaseFiles = registerProjectAssetAccess(root, () => { current(); assertProjectAssetsReady(raw) })
      cleanup.set(raw, () => { releaseKnowledge(); releaseFiles() })
    }
  }
  return engine
}
export function disposeProjectSyncEngine(database: Database.Database): void {
  const raw = rawDatabases.get(database) ?? database
  cleanup.get(raw)?.(); cleanup.delete(raw); engines.delete(raw); wrappedDatabases.delete(raw)
}

/** All repository writes share the same transaction as their immutable outbox.
 * The engine and projector retain the raw connection to avoid recursive capture.
 * Explicit repository transactions form one batch, including nested statements.
 */
export function wrapProjectDatabase(database: Database.Database, projectId: string): Database.Database {
  const existing = wrappedDatabases.get(database)
  if (existing) return existing
  const engine = getProjectSyncEngine(database, projectId)
  let wrapped: Database.Database
  const wrapStatement = (statement: Database.Statement, sql: string): Database.Statement => {
    const mutating = isPortableProjectMutation(sql)
    // Native statements expose non-configurable .database; a separate facade
    // avoids Proxy invariants while keeping the raw handle private.
    const proxy = new Proxy(Object.create(Object.getPrototypeOf(statement)) as Database.Statement, {
      get(_facade, property) {
        const target = statement
        if (property === 'database') return wrapped
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        if (mutating && (property === 'run' || property === 'get' || property === 'all')) {
          return (...args: unknown[]) => engine.captureMutation(() => value.apply(target, args))
        }
        // Lazy RETURNING iterators cannot commit an outbox after the iterator escapes.
        if (mutating && property === 'iterate') return () => { throw new Error('SYNC_MUTATING_ITERATOR_FORBIDDEN') }
        return (...args: unknown[]) => { const result = value.apply(target, args); return result === target ? proxy : result }
      },
    })
    return proxy
  }
  const proxy = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrapStatement(target.prepare(sql), sql)
      if (property === 'exec') return (sql: string) => {
        if (isPortableProjectMutation(sql)) engine.captureMutation(() => target.exec(sql))
        else target.exec(sql)
        return wrapped
      }
      if (property === 'transaction') return (operation: (...args: unknown[]) => unknown) => {
        const transaction = target.transaction(function (this: unknown, ...args: unknown[]) {
          return engine.captureTransaction(() => operation.apply(this, args))
        })
        const variants = new Map<Function, Function>()
        const wrapTransaction = (callback: typeof transaction): typeof transaction => {
          const cached = variants.get(callback)
          if (cached) return cached as typeof transaction
          const captured = new Proxy((...args: unknown[]) => callback(...args), {
            apply(_facade, receiver, args) { return Reflect.apply(callback, receiver, args) },
            get(_facade, name) {
              const callable = callback
              if (name === 'database') return wrapped
              const member = Reflect.get(callable, name, callable)
              return ['default', 'deferred', 'immediate', 'exclusive'].includes(String(name)) && typeof member === 'function'
                ? wrapTransaction(member) : member
            },
          })
          variants.set(callback, captured)
          return captured as typeof transaction
        }
        return wrapTransaction(transaction)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? (...args: unknown[]) => {
        const result = value.apply(target, args)
        return result === target ? wrapped : result
      } : value
    },
  })
  wrapped = proxy
  rawDatabases.set(proxy, database); wrappedDatabases.set(database, proxy)
  return proxy
}
