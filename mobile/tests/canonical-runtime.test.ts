import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Arrow from 'apache-arrow'
import { connect } from '../shims/lancedb'
import Database from '../shims/sqlite'
import { installRendererAPI, ipcMain, mobileSender } from '../shims/electron'
import { captureGenerationKnowledge, verifyGenerationKnowledge } from '../../electron/services/generation-knowledge-source'
import { projectPathKey, sameProjectPathKey } from '../../src/shared/project-session-context'
import { assertExpectedProjectPath } from '../../electron/utils/project-context'
import { exportVectorStoreForMigration, importVectorStoreForMigration, verifyVectorStoreForMigration } from '../../electron/services/vector-migration-snapshot'

const roots: string[] = []
const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-mobile-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('Canonical Android vector runtime', () => {
  it('supports all transaction variants and rolls back the selected native transaction', () => {
    const root = fixture(), database = new Database(path.join(root, 'variants.sqlite'))
    try {
      database.exec('CREATE TABLE author_text(body TEXT)')
      const write = database.transaction((body: string) => {
        database.prepare('INSERT INTO author_text VALUES(?)').run(body)
        if (body === 'rollback') throw new Error('synthetic rollback')
      })
      for (const mode of ['default', 'deferred', 'immediate', 'exclusive'] as const) write[mode](mode)
      expect(database.prepare('SELECT body FROM author_text ORDER BY rowid').pluck().all()).toEqual(['default', 'deferred', 'immediate', 'exclusive'])
      expect(write.database).toBe(database)
      expect(() => write.exclusive('rollback')).toThrow('synthetic rollback')
      expect(database.prepare('SELECT COUNT(*) FROM author_text').pluck().get()).toBe(4)
      expect(database.inTransaction).toBe(false)
    } finally { database.close() }
  })
  it('roundtrips shared migration hashes with Float32 vectors and a Float64 document count', async () => {
    const root = fixture()
    const source = path.join(root, 'source'), copy = path.join(root, 'copy'), target = path.join(root, 'target')
    fs.mkdirSync(source); fs.mkdirSync(target)
    const connection = await connect(path.join(source, 'lancedb'))
    const row = { id: 'chunk', docId: 'doc', fileName: '资料.md', text: '中文资料', chunkIndex: 0,
      totalChunks: 1, importedAt: '2026-10-21', corpusKind: 'project-knowledge', vector: [0.123456789, 0.5] }
    const fields = Object.entries(row).map(([name, value]) => new Arrow.Field(name, name === 'vector'
      ? new Arrow.FixedSizeList(2, new Arrow.Field('item', new Arrow.Float32(), true))
      : typeof value === 'number' ? new Arrow.Int32() : new Arrow.Utf8(), true))
    const schema = new Arrow.Schema(fields)
    const table = new Arrow.Table(schema, Object.fromEntries(fields.map(field => [
      field.name, Arrow.vectorFromArray([(row as any)[field.name]], field.type),
    ])))
    await connection.createTable('chunks', table, { schema })
    const documents = { id: 'doc', fileName: '资料.md', importedAt: '2026-10-21', chunkCount: 1, filePath: '', corpusKind: 'project-knowledge' }
    const docFields = Object.keys(documents).map(name => new Arrow.Field(name, name === 'chunkCount' ? new Arrow.Float64() : new Arrow.Utf8(), true))
    const docSchema = new Arrow.Schema(docFields)
    const docs = new Arrow.Table(docSchema, Object.fromEntries(docFields.map(field => [
      field.name, Arrow.vectorFromArray([(documents as any)[field.name]], field.type),
    ])))
    await connection.createTable('documents', docs, { schema: docSchema })
    connection.close()
    fs.cpSync(source, copy, { recursive: true })
    const snapshot = await exportVectorStoreForMigration({ storageRoot: copy, originalSourceRoot: source })
    expect(await importVectorStoreForMigration({ targetStorageRoot: target, snapshot })).toEqual(snapshot.summary)
    expect(await verifyVectorStoreForMigration({ storageRoot: target, snapshot })).toEqual(snapshot.summary)
    const restored = await connect(path.join(target, 'lancedb'))
    expect((await (await restored.openTable('documents')).schema()).fields.find(field => field.name === 'chunkCount')!.type.toString()).toBe('Float64')
    restored.close()
  })
  it('captures and verifies actual generation knowledge at stable revisions and rejects a later edit', async () => {
    const root = fs.realpathSync.native(fixture())
    const connection = await connect(path.join(root, 'lancedb'))
    const chunks = await connection.createTable('chunks', [{ id: 'chunk', docId: 'doc', fileName: '资料.md',
      text: '原始中文资料', chunkIndex: 0, totalChunks: 1, corpusKind: 'project-knowledge' }])
    await connection.createTable('documents', [{ id: 'doc', fileName: '资料.md', chunkCount: 1,
      filePath: '', corpusKind: 'project-knowledge' }])
    const before = await chunks.version()
    expect(await chunks.version()).toBe(before)
    const snapshot = await captureGenerationKnowledge({ projectStorageRoot: root, query: '中文' })
    expect(snapshot.items.map(item => item.chunkId)).toEqual(['chunk'])
    await verifyGenerationKnowledge({ projectStorageRoot: root, snapshot })
    await chunks.update({ where: "id = 'chunk'", values: { text: '更新后的中文资料' } })
    expect(await chunks.version()).toBeGreaterThan(before)
    await expect(verifyGenerationKnowledge({ projectStorageRoot: root, snapshot })).rejects.toThrow('SOURCE_STALE')
    connection.close()
  })
  it.each([new Arrow.Float32(), new Arrow.Float64()])('preserves Arrow types, nullable fields and vector values for %s', async type => {
    const root = fixture()
    const schema = new Arrow.Schema([
      new Arrow.Field('id', new Arrow.Utf8(), false),
      new Arrow.Field('vector', new Arrow.FixedSizeList(2, new Arrow.Field('item', type, false)), false),
      new Arrow.Field('corpusKind', new Arrow.Utf8(), true),
    ])
    const input = new Arrow.Table(schema, {
      id: Arrow.vectorFromArray(['one'], new Arrow.Utf8()),
      vector: Arrow.vectorFromArray([[0.123456789, 1.25]], schema.fields[1].type),
      corpusKind: Arrow.vectorFromArray([null], new Arrow.Utf8()),
    })
    const connection = await connect(root)
    const created = await connection.createTable('chunks', input, { schema })
    created.close()
    const table = await connection.openTable('chunks')
    const version = await table.version()
    await table.checkout(version)
    const result = await table.query().toArrow()
    expect(result.schema.toString()).toEqual(input.schema.toString())
    expect(result.schema.fields.map(field => field.nullable)).toEqual([false, false, true])
    expect(Array.from((result.getChild('vector')!.get(0) as any).toArray()))
      .toEqual(Array.from((input.getChild('vector')!.get(0) as any).toArray()))
    await expect(table.add([{ id: 'two', vector: [2, 3] }])).rejects.toThrow('read only')
    connection.close()
  })

  it('restores captured rows after mutation and atomically replaces document chunks', async () => {
    const connection = await connect(fixture())
    const table = await connection.createTable('chunks', [
      { id: 'old', docId: 'book', text: '原文', chunkCount: 1 },
      { id: 'other', docId: 'other', text: '另一篇', chunkCount: 1 },
    ])
    const version = await table.version()
    await table.mergeInsert('id').whenNotMatchedInsertAll().whenNotMatchedBySourceDelete({ where: "docId = 'book'" })
      .execute([{ id: 'new', docId: 'book', text: '新文', chunkCount: 2 }])
    await table.update({ where: "id = 'other'", values: { chunkCount: 3 } })
    expect((await table.query().toArray()).map(row => [row.id, row.chunkCount])).toEqual([['other', 3], ['new', 2]])
    await table.checkout(version)
    await table.restore()
    expect((await table.query().toArray()).map(row => row.id)).toEqual(['old', 'other'])
    connection.close()
  })
})

describe('Canonical mobile IPC contract', () => {
  it('preserves Android path case while normalizing Windows paths', () => {
    expect(projectPathKey('/data/user/0/../0/Novel/./')).toBe('/data/user/0/Novel')
    expect(sameProjectPathKey('/data/Novel', '/data/novel')).toBe(false)
    expect(sameProjectPathKey('C:\\Novel\\Book', 'c:/novel/book/')).toBe(true)
    vi.stubGlobal('process', { ...process, platform: 'android' })
    try { expect(() => assertExpectedProjectPath('/data/Novel', '/data/novel')).toThrow('PROJECT_CONTEXT_CHANGED') }
    finally { vi.unstubAllGlobals() }
  })
  it('passes project leases unchanged and publishes generation events with unsubscribe', async () => {
    const previousWindow = (globalThis as any).window
    ;(globalThis as any).window = {}
    try {
      const { api } = installRendererAPI()
      expect((globalThis as any).window.aiNovelAPI).toBe(api)
      expect((globalThis as any).window.velaAPI).toBeUndefined()
      const lease = { projectId: 'project', leaseId: 'lease', projectPath: '/private/project' }
      ipcMain.handle('test:session', (event, context) => ({ context, trusted: event.senderFrame === mobileSender.mainFrame }))
      expect(await api.invoke('test:session', lease)).toEqual({ context: lease, trusted: true })
      const received: unknown[] = []
      const unsubscribe = api.on('generation:snapshot', value => received.push(value))
      mobileSender.send('generation:snapshot', { runId: 'one' })
      unsubscribe()
      mobileSender.send('generation:snapshot', { runId: 'two' })
      expect(received).toEqual([{ runId: 'one' }])
      ipcMain.removeHandler('test:session')
    } finally { (globalThis as any).window = previousWindow }
  })
})

describe('Mobile SQLite snapshot contract', () => {
  it('rejects snapshot creation inside active transactions', async () => {
    const root = fixture()
    const database = new Database(path.join(root, 'source.db'))
    database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT); BEGIN')
    await expect(database.backup(path.join(root, 'copy.db'))).rejects.toThrow('transaction')
    expect(() => database.serialize()).toThrow('transaction')
    database.exec('ROLLBACK')
    database.close()
    expect(fs.existsSync(path.join(root, 'copy.db'))).toBe(false)
  })
})
