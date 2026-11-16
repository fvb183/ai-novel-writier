/**
 * Android implementation of the LanceDB surface used by electron/vector-store.
 *
 * Each logical table is durable SQLite storage: lossless JSON plus scalar
 * projection columns for SQLite filtering. Vector ranking is exact squared-L2
 * (the upstream default), not an approximate/native Lance index. Keeping this
 * boundary small lets the original embedding-space and recovery logic run
 * unchanged. Native .lance directories are detected, never treated as empty.
 */
import fs from 'node:fs'
import Database from './sqlite'
import * as Arrow from 'apache-arrow'

type Row = Record<string, any>
type Statement = {
  run(...parameters: unknown[]): { changes: number; lastInsertRowid?: number | bigint }
  get(...parameters: unknown[]): any
  all(...parameters: unknown[]): any[]
}
type Sqlite = {
  prepare(sql: string): Statement
  exec(sql: string): unknown
  pragma(sql: string): unknown
  transaction<T extends (...args: any[]) => any>(callback: T): T
  close(): void
}
type Field = { name: string; nullable?: boolean; type?: { listSize?: number; kind?: string; children?: Field[] } }
type Schema = { fields: Field[] }
type StoredTable = { name: string; physical_name: string; schema_json: string }

const CATALOG = '__mobile_lance_catalog'
const MIGRATIONS = '__mobile_lance_migrations'
const REVISIONS = '__mobile_lance_revisions'
const REVISION_CLOCK = '__mobile_lance_revision_clock'
const IMPORT_FILE = 'android-knowledge-import.json'
const RAW_COLUMN = '__mobile_row_json'
const ORDER_COLUMN = '__mobile_row_order'
const NATIVE_FORMAT_ERROR = '该知识库使用桌面 LanceDB 二进制格式；Android 不能直接读取。请在桌面导出知识库原文后重新导入，原文件未修改。'

function quoted(name: string): string {
  if (!name || name.includes('\0')) throw new Error('Invalid table or field name')
  return `"${name.replace(/"/g, '""')}"`
}

function physicalName(name: string): string {
  // Hex encoding has no collisions and never permits SQL fragments.
  return `lance_${Array.from(new TextEncoder().encode(name), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function serializableSchema(input: Schema | undefined, rows: readonly Row[]): Schema {
  const serializeField = (field: any): Field => ({
    name: field.name, nullable: field.nullable ?? true,
    type: { kind: field.type?.kind ?? String(field.type ?? 'unknown'),
      ...(typeof field.type?.listSize === 'number' ? { listSize: field.type.listSize } : {}),
      ...(field.type?.children?.length ? { children: field.type.children.map(serializeField) } : {}) },
  })
  const fields = input?.fields?.map(serializeField) ?? [...new Set(rows.flatMap(row => Object.keys(row)))].map(name => {
    const value = rows.find(row => row[name] !== undefined && row[name] !== null)?.[name]
    return {
      name,
      nullable: true,
      type: Array.isArray(value) ? { listSize: value.length, kind: 'list' } : { kind: typeof value },
    }
  })
  if (fields.some(field => field.name === RAW_COLUMN || field.name === ORDER_COLUMN)) {
    throw new Error('Reserved mobile storage column')
  }
  if (new Set(fields.map(field => field.name)).size !== fields.length) throw new Error('Duplicate schema field')
  return { fields }
}

function arrowField(field: Field): Arrow.Field {
  const kind = field.type?.kind
  let type: Arrow.DataType
  if (field.type?.listSize !== undefined) {
    type = new Arrow.FixedSizeList(field.type.listSize, field.type.children?.[0]
      ? arrowField(field.type.children[0]) : new Arrow.Field('item', new Arrow.Float64(), true))
  } else if (kind === 'Int32') type = new Arrow.Int32()
  else if (kind === 'Float32') type = new Arrow.Float32()
  else if (kind === 'Float64' || kind === 'number') type = new Arrow.Float64()
  else if (kind === 'Bool' || kind === 'boolean') type = new Arrow.Bool()
  else if ((!kind || kind === 'unknown') && ['chunkIndex', 'totalChunks', 'chunkCount', 'chapterNumber'].includes(field.name)) type = new Arrow.Int32()
  else type = new Arrow.Utf8()
  return new Arrow.Field(field.name, type, field.nullable ?? true)
}
function arrowTable(schema: Schema, rows: Row[]): Arrow.Table {
  const fields = schema.fields.map(arrowField)
  return new Arrow.Table(new Arrow.Schema(fields), Object.fromEntries(fields.map(field => [
    field.name, Arrow.vectorFromArray(rows.map(row => row[field.name]), field.type),
  ])))
}

function scalar(value: unknown): string | number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  return JSON.stringify(value)
}

function normalizedRow(row: Row, schema: Schema): Row {
  const result: Row = {}
  for (const field of schema.fields) {
    let value = row[field.name] ?? null
    if (value === null && field.nullable === false) throw new Error(`Field ${field.name} cannot be null`)
    if (field.type?.listSize !== undefined && value !== null) {
      if (!Array.isArray(value) || value.length !== field.type.listSize || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
        throw new Error(`Invalid vector dimension or non-finite vector in ${field.name}`)
      }
      if (field.type.children?.[0]?.type?.kind === 'Float32') {
        value = value.map(Math.fround)
        if (value.some((item: number) => !Number.isFinite(item))) throw new Error(`Float32 overflow in ${field.name}`)
      }
    } else if (value !== null) {
      const kind = field.type?.kind
      if (['Int32', 'Float32', 'Float64', 'number'].includes(kind ?? '')
        && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Invalid numeric field ${field.name}`)
      if (kind === 'Int32' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) throw new Error(`Invalid Int32 field ${field.name}`)
      if (kind === 'Float32') {
        value = Math.fround(value)
        if (!Number.isFinite(value)) throw new Error(`Float32 overflow in ${field.name}`)
      }
    }
    result[field.name] = value
  }
  return result
}

function filterSql(predicate: string | undefined): string {
  if (!predicate?.trim()) return ''
  // Predicate strings are constructed by the original vector-store. Refuse
  // multi-statements/comments as a second boundary, ignoring quoted literals.
  const withoutStrings = predicate.replace(/'(?:''|[^'])*'/g, "''")
  if (/;|--|\/\*/.test(withoutStrings)) throw new Error('Invalid query predicate')
  return ` WHERE ${predicate}`
}

function distance(left: readonly number[], right: readonly number[], metric: string): number {
  let dot = 0
  let normLeft = 0
  let normRight = 0
  let squared = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (!Number.isFinite(b)) return Number.POSITIVE_INFINITY
    squared += (a - b) ** 2
    dot += a * b
    normLeft += a * a
    normRight += b * b
  }
  if (metric === 'cosine') return normLeft && normRight ? Math.max(0, 1 - dot / Math.sqrt(normLeft * normRight)) : 1
  if (metric === 'dot') return 1 - dot
  return squared
}

export class Query {
  private predicate?: string
  private selected?: string[]
  private maximum?: number
  private metric = 'l2'

  constructor(private readonly table: Table, private readonly vector?: number[]) {}

  filter(predicate: string): this { this.predicate = predicate; return this }
  where(predicate: string): this { return this.filter(predicate) }
  select(columns: string[]): this { this.selected = [...columns]; return this }
  limit(maximum: number): this {
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid query limit')
    this.maximum = maximum
    return this
  }
  distanceType(metric: string): this {
    if (!['l2', 'cosine', 'dot'].includes(metric)) throw new Error('Unsupported vector distance')
    this.metric = metric
    return this
  }

  async toArray(): Promise<Row[]> {
    this.table.assertOpen()
    if (this.maximum === 0) return []
    const schema = this.table.readSchema()
    if (this.selected?.some(name => !schema.fields.some(field => field.name === name) && name !== '_distance')) {
      throw new Error('Selected field is absent from schema')
    }
    const where = filterSql(this.predicate)
    const order = ` ORDER BY ${quoted(ORDER_COLUMN)}`
    let rows: Row[]
    if (!this.vector) {
      const limit = this.maximum === undefined ? '' : ` LIMIT ${this.maximum}`
      if (this.selected && !this.selected.includes('_distance')) {
        // Avoid crossing the native bridge with complete vectors when callers
        // only need ids/text during backfill and coverage checks.
        const fields = this.selected.map(name => schema.fields.find(field => field.name === name)!)
        rows = this.table.sql.prepare(`SELECT ${this.selected.map(quoted).join(', ')} FROM ${this.table.physical}${where}${order}${limit}`).all()
        for (const row of rows) {
          for (const field of fields) {
            if (field.type?.listSize !== undefined && typeof row[field.name] === 'string') row[field.name] = JSON.parse(row[field.name])
          }
        }
      } else {
        rows = this.table.sql.prepare(`SELECT ${quoted(RAW_COLUMN)} FROM ${this.table.physical}${where}${order}${limit}`)
          .all().map(record => JSON.parse(record[RAW_COLUMN]))
      }
    } else {
      const dimension = schema.fields.find(field => field.name === 'vector')?.type?.listSize
      if (dimension !== undefined && dimension !== this.vector.length) throw new Error('Query vector dimension mismatch')
      if (!this.vector.length || this.vector.some(value => !Number.isFinite(value))) throw new Error('Invalid query vector')
      const topK = this.maximum ?? 10
      rows = []
      const batchSize = 128
      for (let offset = 0; ; offset += batchSize) {
        const page = this.table.sql.prepare(`SELECT ${quoted(RAW_COLUMN)} FROM ${this.table.physical}${where}${order} LIMIT ${batchSize} OFFSET ${offset}`).all()
        for (const stored of page) {
          const row = JSON.parse(stored[RAW_COLUMN]) as Row
          if (!Array.isArray(row.vector) || row.vector.length !== this.vector.length) continue
          const value = distance(this.vector, row.vector, this.metric)
          if (!Number.isFinite(value)) continue
          const candidate = { ...row, _distance: value }
          if (rows.length < topK || value < rows[rows.length - 1]._distance) {
            let position = rows.findIndex(existing => existing._distance > value)
            if (position < 0) position = rows.length
            rows.splice(position, 0, candidate)
            if (rows.length > topK) rows.pop()
          }
        }
        if (page.length < batchSize) break
        // Let WebView paint/cancel and deliver network events between pages.
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        this.table.assertOpen()
      }
    }
    return this.selected ? rows.map(row => Object.fromEntries(this.selected!.map(key => [key, row[key]]))) : rows
  }
  async toArrow(): Promise<Arrow.Table> {
    const rows = await this.toArray()
    const schema = this.table.readSchema()
    return arrowTable(this.selected ? { fields: schema.fields.filter(field => this.selected!.includes(field.name)) } : schema, rows)
  }
}

export class Table {
  readonly physical: string
  private closed = false
  private checkedOutVersion?: number
  private snapshotDatabase?: Sqlite
  private versions = new Map<number, { schema: Schema; rows: Row[] }>()
  snapshot?: { schema: Schema; rows: Row[] }
  constructor(readonly connection: Connection, readonly name: string, private metadata: StoredTable) {
    this.physical = quoted(metadata.physical_name)
  }
  get sql(): Sqlite { return this.snapshotDatabase ?? this.connection.sql }
  assertOpen(): void { if (this.closed) throw new Error('Vector table is closed'); this.connection.assertOpen() }
  private assertWritable(): void { this.assertOpen(); if (this.snapshot) throw new Error('Checked-out vector snapshot is read only') }
  readSchema(): Schema {
    this.assertOpen()
    if (this.snapshot) return this.snapshot.schema
    const current = this.sql.prepare(`SELECT schema_json FROM ${CATALOG} WHERE name = ?`).get(this.name)
    if (!current) throw new Error(`Table ${this.name} is not open`)
    return JSON.parse(current.schema_json)
  }
  async schema(): Promise<Arrow.Schema> { return new Arrow.Schema(this.readSchema().fields.map(arrowField)) }
  async version(): Promise<number> {
    this.assertOpen()
    if (this.checkedOutVersion !== undefined) return this.checkedOutVersion
    const captured = this.sql.transaction(() => {
      const revision = this.sql.prepare(`SELECT version FROM ${REVISIONS} WHERE name = ?`).get(this.name)
      if (!revision) throw new Error('Vector table revision is missing')
      return {
        version: revision.version as number,
        schema: this.readSchema(),
        rows: this.sql.prepare(`SELECT ${quoted(RAW_COLUMN)} FROM ${this.physical} ORDER BY ${quoted(ORDER_COLUMN)}`).all().map(row => JSON.parse(row[RAW_COLUMN])),
      }
    })()
    this.versions.set(captured.version, captured)
    return captured.version
  }
  async checkout(version: number): Promise<void> {
    this.assertOpen()
    const snapshot = this.versions.get(version)
    if (!snapshot) throw new Error('Vector snapshot version is unavailable')
    this.snapshotDatabase?.close()
    this.snapshotDatabase = new Database(':memory:') as unknown as Sqlite
    this.snapshotDatabase.exec(`CREATE TABLE ${this.physical} (${quoted(ORDER_COLUMN)} INTEGER PRIMARY KEY AUTOINCREMENT, ${quoted(RAW_COLUMN)} TEXT NOT NULL, ${snapshot.schema.fields.map(field => quoted(field.name)).join(', ')})`)
    this.insertRows(snapshot.rows, snapshot.schema)
    this.snapshot = snapshot
    this.checkedOutVersion = version
  }
  async checkoutLatest(): Promise<void> {
    this.assertOpen(); this.snapshotDatabase?.close(); this.snapshotDatabase = undefined
    this.snapshot = undefined; this.checkedOutVersion = undefined
  }
  async restore(): Promise<void> {
    this.assertOpen()
    const snapshot = this.snapshot
    if (!snapshot) throw new Error('A checked-out snapshot is required for restore')
    const pinnedDatabase = this.snapshotDatabase
    this.snapshotDatabase = undefined
    try {
      this.sql.transaction(() => {
        this.sql.exec(`DELETE FROM ${this.physical}`)
        this.insertRows(snapshot.rows, snapshot.schema)
        this.sql.prepare(`UPDATE ${CATALOG} SET schema_json = ? WHERE name = ?`).run(JSON.stringify(snapshot.schema), this.name)
        this.connection.touch(this.name)
      })()
      this.snapshot = undefined; this.checkedOutVersion = undefined
    } finally { pinnedDatabase?.close() }
  }
  close(): void { this.snapshotDatabase?.close(); this.snapshotDatabase = undefined; this.closed = true; this.versions.clear(); this.snapshot = undefined }
  query(): Query { return new Query(this) }
  search(vector: number[]): Query { return new Query(this, [...vector]) }
  vectorSearch(vector: number[]): Query { return this.search(vector) }
  async countRows(predicate?: string): Promise<number> {
    this.assertOpen()
    return this.sql.prepare(`SELECT COUNT(*) AS count FROM ${this.physical}${filterSql(predicate)}`).get().count
  }
  insertRows(rows: readonly Row[], schema: Schema): void {
    const names = [RAW_COLUMN, ...schema.fields.map(field => field.name)]
    const insert = this.sql.prepare(`INSERT INTO ${this.physical} (${names.map(quoted).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    for (const source of rows) {
      const row = normalizedRow(source, schema)
      insert.run(JSON.stringify(row), ...schema.fields.map(field => scalar(row[field.name])))
    }
  }
  async add(rows: readonly Row[]): Promise<void> {
    this.assertWritable()
    const schema = this.readSchema()
    this.sql.transaction(() => { this.insertRows(rows, schema); this.connection.touch(this.name) })()
  }
  async delete(predicate: string): Promise<void> {
    this.assertWritable()
    if (!predicate.trim()) throw new Error('Delete requires a predicate')
    this.sql.transaction(() => { this.sql.prepare(`DELETE FROM ${this.physical}${filterSql(predicate)}`).run(); this.connection.touch(this.name) })()
  }
  async update(options: { where: string; values: Row }): Promise<void> {
    this.assertWritable()
    const schema = this.readSchema()
    if (!options.where?.trim() || Object.keys(options.values).some(name => !schema.fields.some(field => field.name === name))) throw new Error('Invalid vector update')
    this.sql.transaction(() => {
      const records = this.sql.prepare(`SELECT ${quoted(ORDER_COLUMN)}, ${quoted(RAW_COLUMN)} FROM ${this.physical}${filterSql(options.where)}`).all()
      const update = this.sql.prepare(`UPDATE ${this.physical} SET ${quoted(RAW_COLUMN)} = ?, ${schema.fields.map(field => `${quoted(field.name)} = ?`).join(', ')} WHERE ${quoted(ORDER_COLUMN)} = ?`)
      for (const record of records) {
        const row = normalizedRow({ ...JSON.parse(record[RAW_COLUMN]), ...options.values }, schema)
        update.run(JSON.stringify(row), ...schema.fields.map(field => scalar(row[field.name])), record[ORDER_COLUMN])
      }
      this.connection.touch(this.name)
    })()
  }
  mergeInsert(key: string) {
    this.assertWritable()
    const table = this
    let insertMissing = false
    let deleteWhere: string | undefined
    const operation = {
      whenNotMatchedInsertAll() { insertMissing = true; return operation },
      whenNotMatchedBySourceDelete(options: { where: string }) { deleteWhere = options.where; return operation },
      async execute(rows: readonly Row[]) {
        table.assertWritable()
        const schema = table.readSchema()
        if (!schema.fields.some(field => field.name === key) || new Set(rows.map(row => row[key])).size !== rows.length) throw new Error('Invalid merge keys')
        table.sql.transaction(() => {
          const incoming = new Set(rows.map(row => row[key]))
          const existing = table.sql.prepare(`SELECT ${quoted(key)} FROM ${table.physical}`).all()
          if (deleteWhere !== undefined) {
            if (!deleteWhere.trim()) throw new Error('Merge delete requires a predicate')
            const removed = table.sql.prepare(`SELECT ${quoted(ORDER_COLUMN)}, ${quoted(key)} FROM ${table.physical}${filterSql(deleteWhere)}`).all()
            const remove = table.sql.prepare(`DELETE FROM ${table.physical} WHERE ${quoted(ORDER_COLUMN)} = ?`)
            for (const row of removed) if (!incoming.has(row[key])) remove.run(row[ORDER_COLUMN])
          }
          const existingKeys = new Set(existing.map(row => row[key]))
          if (insertMissing) table.insertRows(rows.filter(row => !existingKeys.has(row[key])), schema)
          table.connection.touch(table.name)
        })()
      },
    }
    return operation
  }
  async addColumns(columns: Array<{ name: string; valueSql: string }>): Promise<void> {
    this.assertWritable()
    const schema = this.readSchema()
    this.sql.transaction(() => {
      for (const column of columns) {
        if (schema.fields.some(field => field.name === column.name)) throw new Error('Column already exists')
        if (column.name === RAW_COLUMN || column.name === ORDER_COLUMN) throw new Error('Reserved storage column')
        const literal = /^'((?:''|[^'])*)'$/.exec(column.valueSql.trim())
        if (!literal) throw new Error('Only literal string defaults are supported')
        const value = literal[1].replace(/''/g, "'")
        this.sql.exec(`ALTER TABLE ${this.physical} ADD COLUMN ${quoted(column.name)}`)
        const update = this.sql.prepare(`UPDATE ${this.physical} SET ${quoted(RAW_COLUMN)} = ?, ${quoted(column.name)} = ? WHERE ${quoted(ORDER_COLUMN)} = ?`)
        for (const record of this.sql.prepare(`SELECT ${quoted(ORDER_COLUMN)}, ${quoted(RAW_COLUMN)} FROM ${this.physical}`).all()) {
          const row = JSON.parse(record[RAW_COLUMN])
          row[column.name] = value
          update.run(JSON.stringify(row), value, record[ORDER_COLUMN])
        }
        schema.fields.push({ name: column.name, nullable: true, type: { kind: 'string' } })
      }
      this.sql.prepare(`UPDATE ${CATALOG} SET schema_json = ? WHERE name = ?`).run(JSON.stringify(schema), this.name)
      this.connection.touch(this.name)
    })()
  }
  async createIndex(column: string, _options?: unknown): Promise<void> {
    this.assertWritable()
    if (!this.readSchema().fields.some(field => field.name === column)) throw new Error('Unknown index column')
    // Upstream currently queries text with LIKE; keep the same semantics.
    // An ordinary SQLite index can serve equality predicates. We do not claim
    // to have installed a tokenized Lance full-text index.
    const index = quoted(`${this.metadata.physical_name}_index_${column}`)
    this.sql.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${this.physical} (${quoted(column)})`)
  }
  isOpen(): boolean { return !this.closed && this.connection.isOpen() }
}

export class Connection {
  readonly sql: Sqlite
  private opened = true
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true })
    this.sql = new Database(`${directory.replace(/\/$/, '')}/android-vectors.sqlite3`) as unknown as Sqlite
    this.sql.pragma('journal_mode = WAL')
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${CATALOG} (name TEXT PRIMARY KEY, physical_name TEXT NOT NULL UNIQUE, schema_json TEXT NOT NULL)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS} (migration_id TEXT PRIMARY KEY, registry_json TEXT, source_tables_json TEXT NOT NULL, finalized INTEGER NOT NULL DEFAULT 0)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${REVISIONS} (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ${REVISION_CLOCK} (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO ${REVISION_CLOCK} (id, version) VALUES (1, 0)`)
    this.sql.transaction(() => {
      for (const row of this.sql.prepare(`SELECT name FROM ${CATALOG} WHERE name NOT IN (SELECT name FROM ${REVISIONS})`).all()) this.touch(row.name)
    })()
    try {
      this.importDesktopExport()
    } catch (error) {
      this.sql.close()
      this.opened = false
      throw error
    }
  }
  private registryFile(): string { return `${this.directory.replace(/\/$/, '')}/../embedding-spaces.json` }
  private publishMigrationRegistry(migration: { migration_id: string; registry_json: string | null }): void {
    if (migration.registry_json !== null) {
      const destination = this.registryFile()
      if (fs.existsSync(destination)) {
        if (JSON.stringify(JSON.parse(fs.readFileSync(destination, 'utf8'))) !== migration.registry_json) {
          throw new Error('嵌入空间登记与迁移包不一致，已保留原数据并停止迁移')
        }
      } else {
        const temporary = `${destination}.android-migration.tmp`
        fs.writeFileSync(temporary, migration.registry_json, 'utf8')
        fs.renameSync(temporary, destination)
      }
    }
    this.sql.prepare(`UPDATE ${MIGRATIONS} SET finalized = 1 WHERE migration_id = ?`).run(migration.migration_id)
  }
  private importDesktopExport(): void {
    // A committed table import and registry publication are two resources.
    // Persist the publication intent inside the SQLite transaction and resume
    // it after a process death before serving any table to the application.
    const pending = this.sql.prepare(`SELECT migration_id, registry_json FROM ${MIGRATIONS} WHERE finalized = 0`).all()
    for (const migration of pending) this.publishMigrationRegistry(migration)
    const inputPath = `${this.directory.replace(/\/$/, '')}/${IMPORT_FILE}`
    if (!fs.existsSync(inputPath)) return
    const source: unknown = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('知识库迁移包无效')
    const data = source as Record<string, any>
    if (data.format !== 'ai-novel-writer-android-knowledge' || data.version !== 1
      || typeof data.migrationId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(data.migrationId)
      || !Array.isArray(data.tables) || data.tables.length > 10_000) throw new Error('知识库迁移包版本或表清单无效')
    if (this.sql.prepare(`SELECT migration_id FROM ${MIGRATIONS} WHERE migration_id = ?`).get(data.migrationId)) return
    if (this.sql.prepare(`SELECT COUNT(*) AS count FROM ${CATALOG}`).get().count !== 0) {
      throw new Error('Android 知识库已有数据，拒绝用桌面迁移包覆盖；请导入为独立项目')
    }
    const names = new Set<string>()
    const tables: Array<{ metadata: StoredTable; rows: Row[]; schema: Schema }> = []
    for (const sourceTable of data.tables) {
      if (!sourceTable || typeof sourceTable !== 'object' || typeof sourceTable.name !== 'string'
        || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,255}$/.test(sourceTable.name)
        || names.has(sourceTable.name) || !Array.isArray(sourceTable.rows)
        || !sourceTable.schema || !Array.isArray(sourceTable.schema.fields)
        || sourceTable.schema.fields.some((field: any) => !field || typeof field.name !== 'string')
        || sourceTable.rows.some((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw new Error('知识库迁移包表结构无效')
      }
      names.add(sourceTable.name)
      const schema = serializableSchema(sourceTable.schema, sourceTable.rows)
      tables.push({ metadata: { name: sourceTable.name, physical_name: physicalName(sourceTable.name), schema_json: JSON.stringify(schema) }, rows: sourceTable.rows, schema })
    }
    const registry = data.embeddingRegistry ?? null
    if (registry !== null && (!registry || registry.version !== 1 || !Array.isArray(registry.spaces)
      || registry.spaces.some((space: any) => !space || !names.has(space.tableName)
        || !Number.isInteger(space.generation) || !Number.isInteger(space.vectorDimension) || space.vectorDimension < 1
        || typeof space.modelFingerprint !== 'string' || typeof space.distanceMetric !== 'string'
        || !['active', 'building', 'inactive'].includes(space.status))
      || (registry.activeGeneration !== null && !registry.spaces.some((space: any) => space.generation === registry.activeGeneration)))) {
      throw new Error('知识库迁移包嵌入空间登记无效')
    }
    const registryJson = registry === null ? null : JSON.stringify(registry)
    if (registryJson !== null && fs.existsSync(this.registryFile())
      && JSON.stringify(JSON.parse(fs.readFileSync(this.registryFile(), 'utf8'))) !== registryJson) {
      throw new Error('嵌入空间登记与迁移包不一致，已保留原数据并停止迁移')
    }
    this.sql.transaction(() => {
      for (const { metadata, rows, schema } of tables) {
        const table = new Table(this, metadata.name, metadata)
        this.createStoredTable(table, metadata, schema, rows)
      }
      this.sql.prepare(`INSERT INTO ${MIGRATIONS} (migration_id, registry_json, source_tables_json, finalized) VALUES (?, ?, ?, 0)`)
        .run(data.migrationId, registryJson, JSON.stringify([...names]))
    })()
    this.publishMigrationRegistry({ migration_id: data.migrationId, registry_json: registryJson })
  }
  private createStoredTable(table: Table, metadata: StoredTable, schema: Schema, rows: readonly Row[]): void {
    this.sql.exec(`CREATE TABLE ${table.physical} (${quoted(ORDER_COLUMN)} INTEGER PRIMARY KEY AUTOINCREMENT, ${quoted(RAW_COLUMN)} TEXT NOT NULL${schema.fields.length ? ', ' : ''}${schema.fields.map(field => quoted(field.name)).join(', ')})`)
    this.sql.prepare(`INSERT INTO ${CATALOG} (name, physical_name, schema_json) VALUES (?, ?, ?)`).run(metadata.name, metadata.physical_name, metadata.schema_json)
    table.insertRows(rows, schema)
    this.touch(metadata.name)
  }
  /** Must be called in the same transaction as the logical mutation. */
  touch(name: string): void {
    this.sql.prepare(`UPDATE ${REVISION_CLOCK} SET version = version + 1 WHERE id = 1`).run()
    const revision = this.sql.prepare(`SELECT version FROM ${REVISION_CLOCK} WHERE id = 1`).get().version
    this.sql.prepare(`INSERT OR REPLACE INTO ${REVISIONS} (name, version) VALUES (?, ?)`).run(name, revision)
  }
  assertOpen(): void { if (!this.opened) throw new Error('Vector connection is closed') }
  isOpen(): boolean { return this.opened }
  close(): void { if (this.opened) { this.sql.close(); this.opened = false } }
  async tableNames(): Promise<string[]> {
    this.assertOpen()
    const tables: string[] = this.sql.prepare(`SELECT name FROM ${CATALOG} ORDER BY name`).all().map(record => record.name)
    const migrated = new Set<string>(this.sql.prepare(`SELECT source_tables_json FROM ${MIGRATIONS} WHERE finalized = 1`)
      .all().flatMap(record => JSON.parse(record.source_tables_json)))
    // A native desktop table is never silently ignored (including orphan
    // tables). Existing project migration/recovery checks must see it.
    for (const name of fs.readdirSync(this.directory)) {
      if (typeof name === 'string' && name.endsWith('.lance') && !migrated.has(name.slice(0, -6))) tables.push(name.slice(0, -6))
    }
    return [...new Set(tables)].sort()
  }
  async openTable(name: string): Promise<Table> {
    this.assertOpen()
    const metadata = this.sql.prepare(`SELECT name, physical_name, schema_json FROM ${CATALOG} WHERE name = ?`).get(name) as StoredTable | undefined
    if (!metadata) {
      if (fs.existsSync(`${this.directory}/${name}.lance`)) throw new Error(NATIVE_FORMAT_ERROR)
      throw new Error(`Table ${name} does not exist`)
    }
    return new Table(this, name, metadata)
  }
  async createTable(name: string, input: readonly Row[] | Arrow.Table, options?: { schema?: any; mode?: string }): Promise<Table> {
    this.assertOpen()
    if ((await this.tableNames()).includes(name)) throw new Error(`Table ${name} already exists`)
    const rows: readonly Row[] = Array.isArray(input) ? input : Array.from((input as Arrow.Table).toArray(), row => {
      const record: Row = {}
      for (const field of (input as Arrow.Table).schema.fields) {
        const value = (row as any)[field.name]
        record[field.name] = typeof (field.type as { listSize?: number }).listSize === 'number' && value != null ? Array.from(value) : value
      }
      return record
    })
    const schema = serializableSchema(options?.schema ?? (!Array.isArray(input) ? (input as Arrow.Table).schema : undefined) as any, rows)
    const metadata = { name, physical_name: physicalName(name), schema_json: JSON.stringify(schema) }
    const table = new Table(this, name, metadata)
    this.sql.transaction(() => {
      this.createStoredTable(table, metadata, schema, rows)
    })()
    return table
  }
  async dropTable(name: string): Promise<void> {
    const table = await this.openTable(name)
    this.sql.transaction(() => {
      this.sql.exec(`DROP TABLE ${table.physical}`)
      this.sql.prepare(`DELETE FROM ${CATALOG} WHERE name = ?`).run(name)
      this.sql.prepare(`DELETE FROM ${REVISIONS} WHERE name = ?`).run(name)
    })()
  }
}

export async function connect(directory: string): Promise<Connection> { return new Connection(directory) }
export const Index = { fts: () => ({ type: 'fts' as const }) }
