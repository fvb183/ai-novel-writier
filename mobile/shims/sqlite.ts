/** The subset of better-sqlite3 used by the unchanged application repositories.
 * Every operation runs synchronously on the same Android SQLite connection.
 */
import { Buffer } from 'buffer'
import { nativeCall } from './fs'
type Row = Record<string, any>
function parameter(value: any): any {
  if (value === undefined) throw new TypeError('SQLite parameters cannot be undefined')
  if (value === null || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') {
    const number = Number(value)
    if (!Number.isSafeInteger(number)) return { $int64: value.toString() }
    return number
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $blob: Buffer.from(value).toString('base64') }
  throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null')
}
function decodeValue(value: any, safeIntegers: boolean): any {
  if (value && typeof value === 'object') {
    if ('$blob' in value) return Buffer.from(value.$blob, 'base64')
    if ('$int64' in value) return safeIntegers ? BigInt(value.$int64) : Number(value.$int64)
  }
  return safeIntegers && typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : value
}
/** Rewrite only actual SQL placeholders; literals, comments and quoted names are preserved. */
export function bindParameters(sql: string, supplied: any[]): { sql: string; params: any[] } {
  const flat: any[] = []
  for (const item of supplied) Array.isArray(item) ? flat.push(...item) : flat.push(item)
  let named: Record<string, any> = {}
  const positional: any[] = []
  for (const item of flat) {
    if (item && typeof item === 'object' && !Buffer.isBuffer(item) && !(item instanceof Uint8Array)) named = { ...named, ...item }
    else positional.push(item)
  }
  let result = '', index = 0, sequential = 0
  const params: any[] = []
  while (index < sql.length) {
    const c = sql[index], next = sql[index + 1]
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? ']' : c
      result += c; index++
      while (index < sql.length) {
        const quoted = sql[index++]; result += quoted
        if (quoted === end) { if (sql[index] === end) { result += sql[index++]; continue }; break }
      }
      continue
    }
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2); const until = end < 0 ? sql.length : end
      result += sql.slice(index, until); index = until; continue
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2); const until = end < 0 ? sql.length : end + 2
      result += sql.slice(index, until); index = until; continue
    }
    if (c === '?' || ((c === '@' || c === ':' || c === '$') && /[\p{L}\p{N}_]/u.test(next || ''))) {
      let end = index + 1
      if (c === '?') while (end < sql.length && /\d/.test(sql[end])) end++
      else while (end < sql.length && /[\p{L}\p{N}_]/u.test(sql[end])) end++
      const token = sql.slice(index, end)
      if (c === '?') {
        const offset = token.length > 1 ? Number(token.slice(1)) - 1 : sequential++
        if (offset < 0 || offset >= positional.length) throw new RangeError('Too few parameter values were provided')
        params.push(parameter(positional[offset]))
      } else {
        const key = token.slice(1)
        if (!(key in named) && !(token in named)) throw new RangeError(`Missing named parameter "${key}"`)
        params.push(parameter(key in named ? named[key] : named[token]))
      }
      result += '?'; index = end; continue
    }
    result += c; index++
  }
  return { sql: result, params }
}
export class Statement {
  readonly source: string
  readonly database: Database
  readonly reader: boolean
  readonly readonly: boolean
  readonly busy = false
  private bindings: any[] | undefined
  private plucked = false
  private rawRows = false
  private integerMode = false
  constructor(database: Database, sql: string) {
    this.database = database; this.source = sql
    this.reader = /^\s*(?:select|pragma|with|explain)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)
    this.readonly = /^\s*(?:select|explain)\b/i.test(sql)
  }
  private request(supplied: any[]) {
    if (!this.database.open) throw new TypeError('The database connection is not open')
    if (this.bindings && supplied.length) throw new TypeError('This statement already has bound parameters')
    return bindParameters(this.source, this.bindings || supplied)
  }
  run(...supplied: any[]) {
    const request = this.request(supplied)
    const result = nativeCall<{ changes: number; lastInsertRowid: any }>('sqlite.run', this.database.id, request.sql, request.params)
    return { changes: result.changes, lastInsertRowid: this.integerMode ? BigInt(result.lastInsertRowid) : Number(result.lastInsertRowid) }
  }
  all(...supplied: any[]): any[] {
    const request = this.request(supplied)
    return nativeCall<Row[]>('sqlite.query', this.database.id, request.sql, request.params).map(row => {
      const converted = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, decodeValue(value, this.integerMode)]))
      const values = Object.values(converted)
      return this.plucked ? values[0] : this.rawRows ? values : converted
    })
  }
  get(...supplied: any[]): any { return this.all(...supplied)[0] }
  *iterate(...supplied: any[]) { yield* this.all(...supplied) }
  bind(...supplied: any[]) { if (this.bindings) throw new TypeError('The bind() method can only be invoked once per statement'); this.bindings = supplied; return this }
  pluck(toggle = true) { this.plucked = toggle; if (toggle) this.rawRows = false; return this }
  raw(toggle = true) { this.rawRows = toggle; if (toggle) this.plucked = false; return this }
  safeIntegers(toggle = true) { this.integerMode = toggle; return this }
  expand() { throw new Error('SQLite column expansion is not used by this application') }
}
let transactionSequence = 0
const VERIFIED_NATIVE_HANDLE = Symbol('verified Android SQLite handle')
export interface VerifiedSqliteContentIdentity { database: string; wal: string }
export class Database {
  readonly id: any
  readonly name: string
  readonly readonly: boolean
  readonly memory: boolean
  open = true
  private transactionDepth = 0
  private explicitTransaction = false
  private integerMode = false
  constructor(path: string, options: any = {}, opened?: { token: symbol; id: any }) {
    this.name = path; this.readonly = Boolean(options.readonly); this.memory = path === ':memory:' || path === ''
    this.id = opened?.token === VERIFIED_NATIVE_HANDLE ? opened.id : nativeCall('sqlite.open', path, options)
  }
  /** Verification and Android's potentially mutating connection setup share one
   * native ownership boundary. The ordinary constructor keeps its original API. */
  static openVerified(path: string, options: { fileMustExist: true }, expected: VerifiedSqliteContentIdentity): Database {
    const id = nativeCall('sqlite.openVerified', path, options, expected)
    return new Database(path, options, { token: VERIFIED_NATIVE_HANDLE, id })
  }
  get inTransaction() { return this.transactionDepth > 0 || this.explicitTransaction }
  schemaSnapshot() {
    if (!this.open) throw new TypeError('The database connection is not open')
    return nativeCall('sqlite.schemaSnapshot', this.id)
  }
  prepare(sql: string) { if (!this.open) throw new TypeError('The database connection is not open'); return new Statement(this, sql).safeIntegers(this.integerMode) }
  exec(sql: string) {
    if (!this.open) throw new TypeError('The database connection is not open')
    nativeCall('sqlite.exec', this.id, sql)
    if (/^\s*BEGIN\b/i.test(sql)) this.explicitTransaction = true
    if (/^\s*(?:COMMIT|END|ROLLBACK(?!\s+TO))\b/i.test(sql)) this.explicitTransaction = false
    return this
  }
  pragma(source: string, options: any = {}) {
    const result = this.prepare(`PRAGMA ${source}`).all()
    return options.simple ? result.length ? Object.values(result[0])[0] : undefined : result
  }
  transaction<T extends (...args: any[]) => any>(fn: T): T & { default: T; deferred: T; immediate: T; exclusive: T; database: Database } {
    if (typeof fn !== 'function') throw new TypeError('Expected first argument to be a function')
    const database = this
    const make = (mode: string) => function(this: any, ...args: any[]) {
      const nested = database.inTransaction
      const savepoint = `android_tx_${++transactionSequence}`
      database.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`)
      database.transactionDepth++
      try {
        const result = fn.apply(this, args)
        if (result && typeof result.then === 'function') throw new TypeError('Transaction function must be synchronous')
        database.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
        return result
      } catch (error) {
        try { database.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK'); if (nested) database.exec(`RELEASE SAVEPOINT ${savepoint}`) } catch { /* Preserve the original SQLite or application error. */ }
        throw error
      } finally { database.transactionDepth-- }
    }
    const deferred = make('DEFERRED') as any
    deferred.deferred = deferred; deferred.immediate = make('IMMEDIATE'); deferred.exclusive = make('EXCLUSIVE')
    for (const variant of [deferred, deferred.immediate, deferred.exclusive]) {
      variant.default = deferred; variant.deferred = deferred; variant.immediate = deferred.immediate
      variant.exclusive = deferred.exclusive; variant.database = database
    }
    return deferred
  }
  close() { if (this.open) { nativeCall('sqlite.close', this.id); this.open = false }; return this }
  defaultSafeIntegers(toggle = true) { this.integerMode = toggle; return this }
  unsafeMode() { return this }
  async backup(destination: string, options: { attached?: string } = {}) {
    if (!this.open) throw new TypeError('The database connection is not open')
    if (this.inTransaction) throw new Error('Cannot back up a database inside a transaction')
    if (options.attached && options.attached !== 'main') throw new Error('Android backup only supports the main database')
    return nativeCall<{ totalPages: number; remainingPages: number }>('sqlite.backup', this.id, destination)
  }
  serialize() {
    if (!this.open || this.inTransaction) throw new Error('Cannot serialize a closed database or an active transaction')
    return Buffer.from(nativeCall<string>('sqlite.serialize', this.id), 'base64')
  }
}
export default Database
