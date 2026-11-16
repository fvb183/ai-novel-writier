import type BetterSqlite3 from 'better-sqlite3'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../migrations/desktop-registry'
import { SchemaMigrationError } from '../migrations/registry'
import { verifySchema } from '../migrations/runner'
import { SqliteSchemaAdapter } from '../migrations/sqlite-schema-adapter'
import { readSqliteContentIdentity, type SqliteContentIdentity } from './sqlite-project-migration'

type SqliteFactory = {
  new(file: string, options: { fileMustExist: true }): BetterSqlite3.Database
  openVerified?: (file: string, options: { fileMustExist: true }, expected: SqliteContentIdentity) => BetterSqlite3.Database
}

/** Acquire the handle that will be published, before any session fencing.
 * Android's explicit capability compares input bytes and opens in one native
 * critical section. Its platform connection setup may then normalize WAL or
 * android_metadata, so verify the actual handle's schema rather than comparing
 * those expected platform changes to pre-open bytes. Desktop constructors do
 * not run SQL; retain their strict byte comparison before the first statement.
 */
export function openVerifiedProjectHandle(Factory: SqliteFactory, file: string, expected: SqliteContentIdentity): BetterSqlite3.Database {
  if (typeof Factory.openVerified === 'function') {
    let database: BetterSqlite3.Database
    try {
      database = Factory.openVerified(file, { fileMustExist: true }, expected)
    } catch (error) {
      const failure = error as { code?: unknown; message?: unknown } | null
      if (failure?.code === 'SOURCE_CHANGED_SINCE_PROBE' || failure?.message === 'SOURCE_CHANGED_SINCE_PROBE') {
        throw new SchemaMigrationError('SOURCE_CHANGED_SINCE_PROBE')
      }
      throw error
    }
    try {
      database.pragma('foreign_keys = ON')
      verifySchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      return database
    } catch (error) {
      database.close()
      throw error
    }
  }

  const database = new Factory(file, { fileMustExist: true })
  try {
    const current = readSqliteContentIdentity(file)
    if (current.database !== expected.database || current.wal !== expected.wal) {
      throw new SchemaMigrationError('SOURCE_CHANGED_SINCE_PROBE')
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
