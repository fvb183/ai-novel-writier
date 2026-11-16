import fs from 'node:fs'
import { migrationRealpath } from './migration-file-system'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as lancedb from '@lancedb/lancedb'
import { createRequire } from 'node:module'
import { hasVerifiedAndroidMetadata } from '../migrations/sqlite-schema-adapter'
import type { Table as ArrowTable, Field as ArrowField } from 'apache-arrow'
// LanceDB returns CommonJS Arrow instances; use that same runtime for IPC serialization.
const { tableFromIPC, tableToIPC, Table, Schema, Field, Utf8, Int32, Float32, Float64, Bool, FixedSizeList, vectorFromArray } =
  createRequire(import.meta.url)('apache-arrow') as typeof import('apache-arrow')
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

export interface VectorMigrationSummary { documents: number; chunks: number; tableCount: number; logicalHash: string }
export interface VectorMigrationSnapshot {
  version: 1
  tables: Array<{ name: string; arrowIpc: Uint8Array; rowCount: number; logicalHash: string }>
  registryBytes: Uint8Array | null
  summary: VectorMigrationSummary
}
const registryName = 'embedding-spaces.json'
const vectorObjects = ['lancedb', registryName, 'vectors.json', 'vectors.json.migrated', 'vectors.json.migration-journal.json']
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const fail = (code: string): never => { throw new Error(code) }
function checkedRoot(root: string): string {
  if (!path.isAbsolute(root)) fail('VECTOR_MIGRATION_ABSOLUTE_ROOT_REQUIRED')
  const resolved = path.resolve(root)
  if (!fs.lstatSync(resolved).isDirectory() || fs.lstatSync(resolved).isSymbolicLink()
    || migrationRealpath(resolved).toLocaleLowerCase() !== resolved.toLocaleLowerCase()) fail('VECTOR_MIGRATION_UNSAFE_ROOT')
  return resolved
}
function disjoint(a: string, b: string): boolean {
  const inside = (root: string, child: string) => { const relative = path.relative(root, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) }
  return !inside(a, b) && !inside(b, a)
}
/** Only vector-owned assets. SQLite consistency and all other assets remain coordinator-owned. */
function physicalManifest(root: string): string {
  const files: Array<[string, string]> = []
  const walk = (relative: string) => {
    const absolute = path.join(root, relative)
    const info = fs.lstatSync(absolute)
    if (info.isSymbolicLink()) fail('VECTOR_MIGRATION_REPARSE_UNSUPPORTED')
    if (info.isDirectory()) {
      files.push([relative + '/', 'directory'])
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(relative, name))
    } else if (info.isFile() && info.nlink === 1) files.push([relative, digest(fs.readFileSync(absolute))])
    else fail('VECTOR_MIGRATION_NONREGULAR_UNSUPPORTED')
  }
  for (const name of vectorObjects) if (fs.existsSync(path.join(root, name))) walk(name)
  return digest(JSON.stringify(files))
}
function plain(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object' && Symbol.iterator in value) return Array.from(value as Iterable<unknown>, plain)
  return fail('VECTOR_MIGRATION_FIELD_TYPE_UNSUPPORTED')
}
function rows(table: ArrowTable): Record<string, unknown>[] {
  return table.toArray().map(row => Object.fromEntries(table.schema.fields.map(field => [field.name, plain(row[field.name])])))
}
function fieldSchema(field: ArrowField): unknown[] {
  if (field.metadata.size) fail('VECTOR_MIGRATION_SCHEMA_METADATA_UNSUPPORTED')
  return [field.name, field.type.toString(), field.nullable, (field.type.children ?? []).map(fieldSchema)]
}
function tableHash(name: string, table: ArrowTable): string {
  const schema = table.schema.fields.map(fieldSchema)
  const records = rows(table).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return digest(JSON.stringify([name, schema, records]))
}
function validateTables(snapshot: Pick<VectorMigrationSnapshot, 'tables' | 'registryBytes'>): VectorMigrationSummary {
  const tables = new Map<string, { arrow: ArrowTable; rows: Record<string, unknown>[] }>()
  for (const item of snapshot.tables) {
    if (!/^(chunks|documents|chunks__space_[0-9]+)$/.test(item.name) || tables.has(item.name)) fail('VECTOR_MIGRATION_UNKNOWN_TABLE')
    const arrow = tableFromIPC(item.arrowIpc)
    if (arrow.schema.metadata.size) fail('VECTOR_MIGRATION_SCHEMA_METADATA_UNSUPPORTED')
    arrow.schema.fields.forEach(fieldSchema)
    const recordRows = rows(arrow)
    const allowed = item.name === 'documents' ? ['id', 'fileName', 'importedAt', 'chunkCount', 'filePath', 'corpusKind']
      : ['id', 'docId', 'fileName', 'chapterNumber', 'chapterTitle', 'text', 'vector', 'chunkIndex', 'totalChunks', 'importedAt', 'corpusKind']
    if (arrow.schema.fields.some(field => !allowed.includes(field.name))) fail('VECTOR_MIGRATION_UNKNOWN_FIELD')
    const required = item.name === 'documents' ? ['id', 'fileName', 'importedAt', 'chunkCount', 'filePath']
      : ['id', 'docId', 'fileName', 'text', 'chunkIndex', 'totalChunks', 'importedAt']
    if (required.some(name => !arrow.schema.fields.some(field => field.name === name))) fail('VECTOR_MIGRATION_MISSING_FIELD:' + item.name + ':' + required.filter(name => !arrow.schema.fields.some(field => field.name === name)).join(','))
    const ids = new Set<string>()
    for (const row of recordRows) {
      if (typeof row.id !== 'string' || !row.id || ids.has(row.id)) fail('VECTOR_MIGRATION_DUPLICATE_ID')
      ids.add(row.id as string)
      for (const key of item.name === 'documents' ? ['fileName', 'importedAt', 'filePath'] : ['docId', 'fileName', 'text', 'importedAt']) {
        if (typeof row[key] !== 'string') fail('VECTOR_MIGRATION_INVALID_TEXT')
      }
      if ('corpusKind' in row && !['reference', 'project-knowledge', 'unknown'].includes(String(row.corpusKind))) fail('VECTOR_MIGRATION_CORPUS_UNSUPPORTED')
    }
    if (recordRows.length !== item.rowCount || tableHash(item.name, arrow) !== item.logicalHash) fail('VECTOR_MIGRATION_HASH_MISMATCH')
    tables.set(item.name, { arrow, rows: recordRows })
  }
  const chunks = tables.get('chunks')?.rows ?? []
  const documents = tables.get('documents')?.rows ?? []
  const docs = new Map(documents.map(row => [row.id, row]))
  const canonical = new Map(chunks.map(row => [row.id, row]))
  for (const chunk of chunks) if (!docs.has(chunk.docId)) fail('VECTOR_MIGRATION_ORPHAN_CHUNK')
  for (const doc of documents) {
    const documentChunks = chunks.filter(chunk => chunk.docId === doc.id)
    if (!Number.isSafeInteger(doc.chunkCount) || doc.chunkCount !== documentChunks.length) fail('VECTOR_MIGRATION_DOCUMENT_COUNT_MISMATCH')
    const indexes = new Set<unknown>()
    for (const chunk of documentChunks) {
      if (!Number.isSafeInteger(chunk.chunkIndex) || Number(chunk.chunkIndex) < 0 || Number(chunk.chunkIndex) >= documentChunks.length
        || indexes.has(chunk.chunkIndex) || chunk.totalChunks !== documentChunks.length) fail('VECTOR_MIGRATION_CHUNK_ORDER_INVALID')
      indexes.add(chunk.chunkIndex)
    }
  }
  const registered = new Set<string>()
  if (snapshot.registryBytes) {
    const registry = JSON.parse(Buffer.from(snapshot.registryBytes).toString('utf8'))
    if (registry?.version !== 1 || !Array.isArray(registry.spaces)) fail('VECTOR_MIGRATION_REGISTRY_INVALID')
    const generations = new Set<number>()
    let active: number | null = null
    for (const space of registry.spaces) {
      if (!Number.isSafeInteger(space.generation) || space.generation < 0 || generations.has(space.generation)
        || typeof space.tableName !== 'string' || registered.has(space.tableName)
        || !tables.has(space.tableName) || !['active', 'inactive', 'building'].includes(space.status)
        || typeof space.modelFingerprint !== 'string' || !space.modelFingerprint || typeof space.createdAt !== 'string'
        || !['l2', 'cosine', 'dot'].includes(space.distanceMetric) || !Number.isSafeInteger(space.vectorDimension) || space.vectorDimension < 1) fail('VECTOR_MIGRATION_SPACE_INVALID')
      generations.add(space.generation); registered.add(space.tableName)
      const table = tables.get(space.tableName)!
      const dimension = (table.arrow.schema.fields.find(field => field.name === 'vector')?.type as { listSize?: number } | undefined)?.listSize
      if (dimension !== space.vectorDimension) fail('VECTOR_MIGRATION_DIMENSION_MISMATCH')
      for (const row of table.rows) {
        const source = canonical.get(row.id)
        if (!source || source.text !== row.text || source.docId !== row.docId || !Array.isArray(row.vector)
          || row.vector.length !== dimension || row.vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('VECTOR_MIGRATION_VECTOR_INVALID')
      }
      if (space.status === 'active') {
        if (active !== null || table.rows.length !== chunks.length) fail('VECTOR_MIGRATION_ACTIVE_INCOMPLETE')
        active = space.generation
      }
    }
    if (registry.activeGeneration !== active) fail('VECTOR_MIGRATION_ACTIVE_POINTER_INVALID')
  }
  for (const name of tables.keys()) if (name.startsWith('chunks__space_') && !registered.has(name)) fail('VECTOR_MIGRATION_UNREGISTERED_SPACE')
  const logicalHash = digest(JSON.stringify([snapshot.tables.map(item => [item.name, item.logicalHash]).sort(), snapshot.registryBytes ? digest(snapshot.registryBytes) : null]))
  return { documents: documents.length, chunks: chunks.length, tableCount: tables.size, logicalHash }
}

/** Read the old Android logical store only after the coordinator has copied its
 * SQLite/WAL files. Native LanceDB otherwise treats this directory as empty. */
function readAndroidTables(directory: string): VectorMigrationSnapshot['tables'] {
  const database = new Database(path.join(directory, 'android-vectors.sqlite3'), { readonly: true, fileMustExist: true })
  const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"'
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok'
      || (database.pragma('foreign_key_check') as unknown[]).length) fail('VECTOR_MIGRATION_ANDROID_DATABASE_INVALID')
    const catalog = database.prepare('SELECT name,physical_name,schema_json FROM __mobile_lance_catalog ORDER BY name')
      .all() as Array<{ name: string; physical_name: string; schema_json: string }>
    const migrations = database.prepare('SELECT registry_json,source_tables_json,finalized FROM __mobile_lance_migrations')
      .all() as Array<{ registry_json: string | null; source_tables_json: string; finalized: number }>
    if (migrations.some(item => item.finalized !== 1)) fail('VECTOR_MIGRATION_ANDROID_PENDING')
    const retiredNative = new Set<string>()
    for (const migration of migrations) {
      const names: unknown = JSON.parse(migration.source_tables_json)
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) fail('VECTOR_MIGRATION_ANDROID_DATABASE_INVALID')
      for (const name of names as string[]) retiredNative.add(name)
    }
    for (const name of fs.readdirSync(directory)) {
      if (name.endsWith('.lance') && !retiredNative.has(name.slice(0, -6))) fail('VECTOR_MIGRATION_MIXED_STORAGE')
    }
    const allowedTables = new Set(['__mobile_lance_catalog', '__mobile_lance_migrations',
      '__mobile_lance_revisions', '__mobile_lance_revision_clock', 'sqlite_sequence',
      ...catalog.map(item => item.physical_name)])
    if (hasVerifiedAndroidMetadata(database)) allowedTables.add('android_metadata')
    const actualTables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    if (actualTables.some(item => !allowedTables.has(item.name))) fail('VECTOR_MIGRATION_UNKNOWN_TABLE')
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') LIMIT 1").get()) {
      fail('VECTOR_MIGRATION_ANDROID_SCHEMA_INVALID')
    }
    return catalog.map(item => {
      if (!/^(chunks|documents|chunks__space_[0-9]+)$/.test(item.name)
        || item.physical_name !== `lance_${Buffer.from(item.name, 'utf8').toString('hex')}`) fail('VECTOR_MIGRATION_UNKNOWN_TABLE')
      type StoredField = { name: string; nullable?: boolean; type?: { kind?: string; listSize?: number; children?: StoredField[] } }
      const schema = JSON.parse(item.schema_json) as { fields?: StoredField[] }
      if (!Array.isArray(schema.fields) || !schema.fields.length
        || schema.fields.some(field => !field || typeof field.name !== 'string')
        || new Set(schema.fields.map(field => field.name)).size !== schema.fields.length) fail('VECTOR_MIGRATION_ANDROID_SCHEMA_INVALID')
      const schemaFields = schema.fields!
      const columns = (database.prepare(`PRAGMA table_info(${quoted(item.physical_name)})`).all() as Array<{ name: string }>)
        .map(column => column.name).sort()
      if (JSON.stringify(columns) !== JSON.stringify(['__mobile_row_json', '__mobile_row_order',
        ...schemaFields.map(field => field.name)].sort())) fail('VECTOR_MIGRATION_ANDROID_SCHEMA_INVALID')
      const stored = database.prepare(`SELECT * FROM ${quoted(item.physical_name)} ORDER BY __mobile_row_order`)
        .all() as Array<Record<string, unknown>>
      const records = stored.map(row => JSON.parse(String(row.__mobile_row_json)) as Record<string, unknown>)
      const fieldFromStored = (field: StoredField): ArrowField => {
        if (!field || typeof field.name !== 'string' || field.nullable !== undefined && typeof field.nullable !== 'boolean') {
          return fail('VECTOR_MIGRATION_ANDROID_SCHEMA_INVALID')
        }
        const dimension = field.type?.listSize, kind = field.type?.kind
        let type: ArrowField['type']
        if (dimension !== undefined) {
          if (!Number.isSafeInteger(dimension) || dimension < 1) return fail('VECTOR_MIGRATION_ANDROID_SCHEMA_INVALID')
          const children = field.type?.children
          if (children !== undefined && (!Array.isArray(children) || children.length !== 1)) return fail('VECTOR_MIGRATION_ANDROID_SCHEMA_INVALID')
          // Old Android stored JSON doubles but omitted vector child metadata.
          // New imports retain complete Arrow children for exact round trips.
          type = new FixedSizeList(dimension, children ? fieldFromStored(children[0]!) : new Field('item', new Float64(), true))
        } else if (kind === 'Utf8' || kind === 'string') type = new Utf8()
        else if (kind === 'Int32') type = new Int32()
        else if (kind === 'Float32') type = new Float32()
        else if (kind === 'Float64' || kind === 'number') type = new Float64()
        else if (kind === 'Bool' || kind === 'boolean') type = new Bool()
        else return fail('VECTOR_MIGRATION_ANDROID_SCHEMA_INVALID')
        return new Field(field.name, type, field.nullable ?? true)
      }
      const fields = schemaFields.map(field => {
        const integer = ['chunkIndex', 'totalChunks', 'chunkCount', 'chapterNumber'].includes(field.name)
        const dimension = field.type?.listSize
        if (field.name === 'vector' && (!Number.isSafeInteger(dimension) || dimension! < 1)
          || field.name !== 'vector' && dimension !== undefined) fail('VECTOR_MIGRATION_ANDROID_SCHEMA_INVALID')
        for (const [index, row] of records.entries()) {
          if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.hasOwn(row, field.name)
            || Object.keys(row).length !== schemaFields.length) fail('VECTOR_MIGRATION_ANDROID_ROW_INVALID')
          const value = row[field.name]
          if (stored[index]![field.name] !== (Array.isArray(value) ? JSON.stringify(value) : value)) {
            fail('VECTOR_MIGRATION_ANDROID_ROW_INVALID')
          }
          if (value === null && field.nullable !== false) continue
          if (field.name === 'vector'
            ? !Array.isArray(value) || value.length !== dimension || value.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))
            : integer ? !Number.isSafeInteger(value) || Number(value) < -2147483648 || Number(value) > 2147483647
              : typeof value !== 'string') fail('VECTOR_MIGRATION_ANDROID_ROW_INVALID')
        }
        return fieldFromStored(field)
      })
      const arrow = new Table(new Schema(fields), Object.fromEntries(fields.map(field => [
        field.name, vectorFromArray(records.map(row => row[field.name]), field.type),
      ])))
      // Metadata cannot coerce an author's JSON row into a different value.
      if (JSON.stringify(rows(arrow)) !== JSON.stringify(records.map(row =>
        Object.fromEntries(fields.map(field => [field.name, row[field.name]]))))) fail('VECTOR_MIGRATION_ANDROID_ROW_INVALID')
      return { name: item.name, arrowIpc: tableToIPC(arrow), rowCount: arrow.numRows, logicalHash: tableHash(item.name, arrow) }
    })
  } finally { database.close() }
}

async function readSnapshot(storageRoot: string): Promise<VectorMigrationSnapshot> {
  if (fs.existsSync(path.join(storageRoot, 'vectors.json')) || fs.existsSync(path.join(storageRoot, 'vectors.json.migration-journal.json'))) fail('VECTOR_MIGRATION_LEGACY_PENDING')
  const registryFile = path.join(storageRoot, registryName)
  const registryBytes = fs.existsSync(registryFile) ? fs.readFileSync(registryFile) : null
  const tables: VectorMigrationSnapshot['tables'] = []
  const dbPath = path.join(storageRoot, 'lancedb')
  if (fs.existsSync(dbPath)) {
    if (fs.existsSync(path.join(dbPath, 'android-vectors.sqlite3'))) tables.push(...readAndroidTables(dbPath))
    else {
      const connection = await lancedb.connect(dbPath)
      try {
        for (const name of (await connection.tableNames()).sort()) {
          const table = await connection.openTable(name)
          try {
            const version = await table.version(); await table.checkout(version)
            const arrow = await table.query().toArrow()
            tables.push({ name, arrowIpc: tableToIPC(arrow), rowCount: arrow.numRows, logicalHash: tableHash(name, arrow) })
          } finally { table.close() }
        }
      } finally { connection.close() }
    }
  }
  const summary = validateTables({ tables, registryBytes })
  return { version: 1, tables, registryBytes, summary }
}
/** The coordinator owns exclusion and creates a physical copy before this call. Never connects to originalSourceRoot. */
export async function exportVectorStoreForMigration({ storageRoot, originalSourceRoot }: { storageRoot: string; originalSourceRoot: string }): Promise<VectorMigrationSnapshot> {
  const copy = checkedRoot(storageRoot), source = checkedRoot(originalSourceRoot)
  if (!disjoint(copy, source)) fail('VECTOR_MIGRATION_COPY_REQUIRED')
  const before = physicalManifest(source)
  if (physicalManifest(copy) !== before) fail('VECTOR_MIGRATION_COPY_MISMATCH')
  try { return await readSnapshot(copy) } finally {
    if (physicalManifest(source) !== before) fail('VECTOR_MIGRATION_SOURCE_CHANGED')
  }
}
/** Reads only attempt-owned staging, not the author's source. */
export async function verifyVectorStoreForMigration({ storageRoot, snapshot }: { storageRoot: string; snapshot: VectorMigrationSnapshot }): Promise<VectorMigrationSummary> {
  checkedRoot(storageRoot); physicalManifest(storageRoot)
  const expected = validateTables(snapshot)
  if (snapshot.version !== 1 || expected.logicalHash !== snapshot.summary.logicalHash) fail('VECTOR_MIGRATION_SNAPSHOT_INVALID')
  const actual = await readSnapshot(storageRoot)
  if (actual.summary.logicalHash !== expected.logicalHash) fail('VECTOR_MIGRATION_VERIFY_FAILED')
  return actual.summary
}
/** Writes only a pre-created staging root and never overwrites vector-owned objects. No embedding provider is used. */
export async function importVectorStoreForMigration({ targetStorageRoot, snapshot }: { targetStorageRoot: string; snapshot: VectorMigrationSnapshot }): Promise<VectorMigrationSummary> {
  const root = checkedRoot(targetStorageRoot)
  const expected = validateTables(snapshot)
  if (snapshot.version !== 1 || expected.logicalHash !== snapshot.summary.logicalHash) fail('VECTOR_MIGRATION_SNAPSHOT_INVALID')
  if (vectorObjects.some(name => fs.existsSync(path.join(root, name)))) fail('VECTOR_MIGRATION_TARGET_NOT_EMPTY')
  if (snapshot.tables.length) {
    const connection = await lancedb.connect(path.join(root, 'lancedb'))
    try {
      for (const item of snapshot.tables) {
        const arrow = tableFromIPC(item.arrowIpc)
        const table = await connection.createTable(item.name, arrow, { mode: 'create', schema: arrow.schema })
        table.close()
      }
    } finally { connection.close() }
  }
  if (snapshot.registryBytes) fs.writeFileSync(path.join(root, registryName), snapshot.registryBytes, { flag: 'wx' })
  return verifyVectorStoreForMigration({ storageRoot: root, snapshot })
}
