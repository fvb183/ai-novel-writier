import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

/** Synthetic old Android catalog/JSON rows, matching mobile/shims/lancedb.ts. */
export function seedAndroidVectorFixture(storage: string, originalPath = ''): void {
  const directory = path.join(storage, 'lancedb')
  fs.mkdirSync(directory, { recursive: true })
  const database = new Database(path.join(directory, 'android-vectors.sqlite3'))
  try {
    database.exec(`CREATE TABLE __mobile_lance_catalog(name TEXT PRIMARY KEY,physical_name TEXT NOT NULL UNIQUE,schema_json TEXT NOT NULL);
      CREATE TABLE __mobile_lance_migrations(migration_id TEXT PRIMARY KEY,registry_json TEXT,source_tables_json TEXT NOT NULL,finalized INTEGER NOT NULL DEFAULT 0)`)
    const chunk = { id: 'android-chunk', docId: 'android-doc', fileName: '资料.md',
      chapterNumber: null, chapterTitle: null, text: '铜钥匙藏在旧钟后面。', chunkIndex: 0, totalChunks: 1,
      importedAt: '2026-10-20', corpusKind: 'reference' }
    const tables = [
      { name: 'chunks', rows: [chunk] },
      { name: 'documents', rows: [{ id: 'android-doc', fileName: '资料.md', filePath: originalPath,
        importedAt: '2026-10-20', chunkCount: 1, corpusKind: 'reference' }] },
      { name: 'chunks__space_1', rows: [{ ...chunk, vector: [0.123456789012345, 0.25] }] },
    ]
    const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
    for (const item of tables) {
      const physical = `lance_${Buffer.from(item.name).toString('hex')}`
      const names = Object.keys(item.rows[0]!)
      const fields = names.map(name => ({ name, nullable: true, type: name === 'vector'
        ? { listSize: 2, kind: 'FixedSizeList[2]<Float32>' }
        : { kind: ['chunkIndex', 'totalChunks', 'chunkCount', 'chapterNumber'].includes(name) ? 'Int32' : 'Utf8' } }))
      database.prepare('INSERT INTO __mobile_lance_catalog VALUES(?,?,?)')
        .run(item.name, physical, JSON.stringify({ fields }))
      database.exec(`CREATE TABLE ${quote(physical)}(__mobile_row_order INTEGER PRIMARY KEY AUTOINCREMENT,
        __mobile_row_json TEXT NOT NULL,${names.map(quote).join(',')})`)
      const insert = database.prepare(`INSERT INTO ${quote(physical)}(__mobile_row_json,${names.map(quote).join(',')})
        VALUES(${names.map(() => '?').join(',')},?)`)
      for (const row of item.rows) {
        const values = row as Record<string, unknown>
        insert.run(JSON.stringify(row), ...names.map(name => Array.isArray(values[name]) ? JSON.stringify(values[name]) : values[name]))
      }
    }
  } finally { database.close() }
  fs.writeFileSync(path.join(storage, 'embedding-spaces.json'), JSON.stringify({
    version: 1, activeGeneration: 1, spaces: [{ generation: 1, tableName: 'chunks__space_1',
      vectorDimension: 2, modelFingerprint: 'synthetic-android-model', distanceMetric: 'l2', status: 'active',
      createdAt: '2026-10-20' }],
  }))
}
