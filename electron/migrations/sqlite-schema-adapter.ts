import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import type { SchemaWriter } from './registry'

/** Android's SQLite framework owns this locale table. Admit only its stock
 * shape and locale value; a similarly named author table or attached object
 * remains an unknown schema. Never remove or rewrite the physical table.
 */
interface SqliteSchemaSnapshot { schema: { name: string }[]; objects: any[]; columns: any[]; rows: any[] }
export function hasVerifiedAndroidMetadata(db: BetterSqlite3.Database, snapshot?: SqliteSchemaSnapshot): boolean {
  const objects = (snapshot?.objects ?? db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='android_metadata' OR tbl_name='android_metadata'").all()) as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  if (objects.length === 0) return false
  const table = objects[0]
  if (objects.length !== 1 || table.type !== 'table' || table.name !== 'android_metadata' || table.tbl_name !== 'android_metadata'
    || !/^CREATE\s+TABLE\s+android_metadata\s*\(\s*locale\s+TEXT\s*\)$/iu.test(table.sql ?? '')) {
    throw new Error('UNRECOGNIZED_ANDROID_SQLITE_METADATA')
  }
  const columns = (snapshot?.columns ?? db.prepare('PRAGMA table_info(android_metadata)').all()) as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>
  const rows = (snapshot?.rows ?? db.prepare('SELECT locale FROM android_metadata').all()) as Array<{ locale: unknown }>
  if (columns.length !== 1 || columns[0].cid !== 0 || columns[0].name !== 'locale' || columns[0].type !== 'TEXT'
    || columns[0].notnull !== 0 || columns[0].dflt_value !== null || columns[0].pk !== 0 || rows.length > 1
    || rows.some(row => typeof row.locale !== 'string' || !/^[A-Za-z][A-Za-z0-9_#@.=-]{0,127}$/u.test(row.locale))) {
    throw new Error('UNRECOGNIZED_ANDROID_SQLITE_METADATA')
  }
  return true
}

export function sqliteSchemaFingerprint(db: BetterSqlite3.Database): string {
  const snapshot = (db as BetterSqlite3.Database & { schemaSnapshot?(): SqliteSchemaSnapshot }).schemaSnapshot?.()
  const schema = snapshot?.schema ?? db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ name: string }>
  const androidMetadata = hasVerifiedAndroidMetadata(db, snapshot)
  // Exact DDL, including constraints, indexes, triggers and views. Unknown forks
  // cannot be admitted merely because selected table/column names look familiar.
  return createHash('sha256').update(JSON.stringify(androidMetadata ? schema.filter(row => row.name !== 'android_metadata') : schema)).digest('hex')
}

export class SqliteSchemaAdapter implements SchemaWriter {
  private reads: Map<string, unknown> | null = null
  readonly database: BetterSqlite3.Database
  constructor(raw: BetterSqlite3.Database) {
    this.database = new Proxy(raw, { get: (target, property) => {
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql)
        if (!this.reads || !/^\s*(?:SELECT|PRAGMA)\b/i.test(sql) || /=/.test(sql) && /^\s*PRAGMA/i.test(sql)) return statement
        return new Proxy(Object.create(Object.getPrototypeOf(statement)) as BetterSqlite3.Statement, { get: (_facade, member) => {
          const method = Reflect.get(statement, member, statement)
          if (member === 'all' || member === 'get') return (...args: unknown[]) => {
            const key = JSON.stringify([sql, member, args])
            if (!this.reads) return method.apply(statement, args)
            if (!this.reads.has(key)) this.reads.set(key, method.apply(statement, args))
            // A verifier cannot mutate rows used by another invariant.
            return structuredClone(this.reads.get(key))
          }
          return typeof method === 'function' ? method.bind(statement) : method
        } })
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  withVerificationReads<T>(operation: () => T): T {
    if (this.reads) return operation()
    this.reads = new Map()
    try { return operation() } finally { this.reads = null }
  }
  readUserVersion(): number { return this.database.pragma('user_version', { simple: true }) as number }
  readSchemaFingerprint(): string { return sqliteSchemaFingerprint(this.database) }
  integrityCheck(): boolean { return this.database.pragma('integrity_check', { simple: true }) === 'ok' }
  foreignKeyCheck(): boolean { return (this.database.pragma('foreign_key_check') as unknown[]).length === 0 }
  transaction<T>(operation: () => T): T { return this.database.transaction(operation)() }
  writeUserVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('INVALID_SCHEMA_VERSION')
    this.database.pragma(`user_version = ${version}`)
  }
  executeMigrationSql(sql: string): void { this.database.exec(sql) }
}
