import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as lance from '@lancedb/lancedb'
import { Schema, Field, Utf8, Int32, FixedSizeList, Float32 } from 'apache-arrow'
import { afterEach, expect, it, vi } from 'vitest'
import { adoptSyncKnowledgeSelection, hashSyncKnowledgeDocuments, readSyncKnowledgeDocuments, readPortableKnowledgeSnapshot,
  recoverSyncKnowledgeProjection, registerSyncKnowledgeReadGuard, replaceSyncKnowledgeDocuments, resolveKnowledgeProjectionStorageRoot,
  writeKnowledgeCopy } from '../../vector-store'
import { captureGenerationKnowledge, verifyGenerationKnowledge } from '../generation-knowledge-source'
import { parseSyncKnowledgeDocument, syncKnowledgeTextHash, type SyncKnowledgeDocument } from '../../../src/shared/project-sync-knowledge'
import { windowsSafeFileSystem } from '../../security/windows-safe-file-system'

const roots: string[] = [], releases: Array<() => void> = []
const fixture = () => { const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-knowledge-'))); roots.push(root); return root }
const selection = (name: string) => syncKnowledgeTextHash(name)
const empty = hashSyncKnowledgeDocuments([])
const document = (id = 'project-doc', kind: SyncKnowledgeDocument['corpusKind'] = 'project-knowledge'): SyncKnowledgeDocument => ({
  version: 1, docId: id, fileName: `${id}.md`, corpusKind: kind, importedAt: '2026-10-21T08:00:00Z',
  logicalSource: { kind: 'bound', references: [{ type: 'draft', id: 'stable-draft-UUID', contentHash: selection('final prose') }] },
  chunks: ['铜钥匙藏在旧钟后面。', '迷宫铜门只能在月圆时开启。'].map((text, chunkIndex) => ({
    id: `${id}:original:${chunkIndex}`, text, textHash: syncKnowledgeTextHash(text), chunkIndex,
    importedAt: '2026-10-21T08:01:00Z', chapterNumber: 3, chapterTitle: '原章节展示标题',
  })),
  copy: { availability: 'available', content: '完整原文保留分段与空白。\n\n铜钥匙藏在旧钟后面。\n迷宫铜门只能在月圆时开启。🙂',
    contentHash: selection('unused'), indexedHash: selection('unused'), edited: false, indexDirty: false },
})
function cleanDocument(id?: string, kind?: SyncKnowledgeDocument['corpusKind']): SyncKnowledgeDocument {
  const value = document(id, kind)
  if (value.copy.availability === 'available') value.copy.contentHash = value.copy.indexedHash = syncKnowledgeTextHash(value.copy.content)
  return parseSyncKnowledgeDocument(value)
}
function guard(root: string, initial: string) {
  let current = initial, closed = false
  releases.push(registerSyncKnowledgeReadGuard(root, () => { if (closed) throw new Error('SYNTHETIC_DB_CLOSED'); return current }))
  return { set(value: string) { current = value }, close() { closed = true }, reopen() { closed = false } }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const release of releases.splice(0)) release()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it('rechecks a frozen project session in the real secure-helper beforeReplace boundary without replacing its pointer', async () => {
  const root = fixture(), doc = cleanDocument(), first = selection('before-session-freeze'), selected = guard(root, first)
  await replaceSyncKnowledgeDocuments(root, [doc], { expectedBeforeHash: empty, selectionHash: first })
  const pointer = path.join(root, 'knowledge-sync-projection.json'), previousBytes = fs.readFileSync(pointer, 'utf8')
  const originalWrite = windowsSafeFileSystem.writeTextAtomically.bind(windowsSafeFileSystem)
  let frozen = false, boundaryReached = false
  vi.spyOn(windowsSafeFileSystem, 'writeTextAtomically').mockImplementation((capability, content, beforeReplace, constraints) => originalWrite(capability, content, async () => {
    if (capability.relativePath.replaceAll('\\', '/').endsWith('knowledge-sync-projection.json')) {
      boundaryReached = true; frozen = true
      expect(beforeReplace).toBeTypeOf('function')
    }
    await beforeReplace?.()
  }, constraints))
  const next = selection('session-selected-successor'); selected.set(next)
  await expect(replaceSyncKnowledgeDocuments(root, [doc], { expectedBeforeHash: hashSyncKnowledgeDocuments([doc]), selectionHash: next,
    verifySelected: () => { if (frozen) throw new Error('SYNTHETIC_PROJECT_SESSION_FROZEN') } })).rejects.toThrow('SYNTHETIC_PROJECT_SESSION_FROZEN')
  expect(boundaryReached).toBe(true)
  expect(fs.readFileSync(pointer, 'utf8')).toBe(previousBytes)
  await expect(readSyncKnowledgeDocuments(root)).rejects.toThrow('KNOWLEDGE_SYNC_NOT_READY')
})

it('strictly rejects capabilities, paths, vectors, forged hashes and conflicting chunk identities', () => {
  const doc = cleanDocument()
  for (const extra of [{ filePath: 'C:\\private' }, { vector: [1, 2] }, { taskLease: 'remote-capability' }]) {
    expect(() => parseSyncKnowledgeDocument({ ...doc, ...extra })).toThrow('SYNC_KNOWLEDGE_INVALID')
  }
  expect(() => parseSyncKnowledgeDocument({ ...doc, chunks: [{ ...doc.chunks[0], textHash: selection('forged') }] })).toThrow()
  expect(() => hashSyncKnowledgeDocuments([doc, { ...doc, docId: 'different-doc' }])).toThrow()
  expect(() => parseSyncKnowledgeDocument({ ...doc, logicalSource: { kind: 'bound', references: [{ type: 'import', id: 'source', contentHash: selection('source'), executionLease: 'forbidden' }] } })).toThrow()
})

it('roundtrips exact IDs, ordered chunks, chapter metadata, source identity, dirty copy and corpus without embeddings', async () => {
  const root = fixture(), selected = selection('selected-roundtrip'); guard(root, selected)
  const clean = cleanDocument(), dirty = cleanDocument('dirty-doc'), reference = cleanDocument('reference-doc', 'reference')
  if (dirty.copy.availability === 'available') { dirty.copy.content += '\n尚未重建的用户修改。'; dirty.copy.contentHash = syncKnowledgeTextHash(dirty.copy.content); dirty.copy.edited = true; dirty.copy.indexDirty = true }
  const docs = [clean, dirty, reference]
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NO_EMBEDDING_NETWORK') }))
  await replaceSyncKnowledgeDocuments(root, docs, { expectedBeforeHash: empty, selectionHash: selected,
    afterWriteVerify: actual => { expect(hashSyncKnowledgeDocuments(actual)).toBe(hashSyncKnowledgeDocuments(docs)) } })
  expect(await readSyncKnowledgeDocuments(root)).toEqual([...docs].sort((a, b) => a.docId.localeCompare(b.docId)))
  const physical = resolveKnowledgeProjectionStorageRoot(root), db = await lance.connect(path.join(physical, 'lancedb'))
  try { expect((await db.tableNames()).sort()).toEqual(['chunks', 'documents']) } finally { db.close() }
  const captured = await captureGenerationKnowledge({ projectStorageRoot: root, query: '铜钥匙' })
  expect(captured.items.map(item => item.chunkId)).toEqual([clean.chunks[0]!.id])
  expect(captured.items[0]?.documentId).toBe(clean.docId)
  await verifyGenerationKnowledge({ projectStorageRoot: root, snapshot: captured })
  const portable = await readPortableKnowledgeSnapshot(root)
  expect(portable.documents.map(doc => doc.docId)).toEqual([...docs].map(doc => doc.docId).sort())
  expect(portable.documents.find(doc => doc.docId === dirty.docId)?.copy?.indexDirty).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
})

it('preserves legacy chunk-only originals as unavailable and never reads their old machine path', async () => {
  const source = fixture(), db = await lance.connect(path.join(source, 'lancedb'))
  const doc = cleanDocument()
  const schema = new Schema([new Field('id', new Utf8()), new Field('docId', new Utf8()), new Field('fileName', new Utf8()),
    new Field('text', new Utf8()), new Field('chunkIndex', new Int32()), new Field('totalChunks', new Int32()),
    new Field('importedAt', new Utf8()), new Field('corpusKind', new Utf8())])
  const chunks = await db.createTable('chunks', doc.chunks.map(chunk => ({ id: chunk.id, docId: doc.docId, fileName: doc.fileName,
    text: chunk.text, chunkIndex: chunk.chunkIndex, totalChunks: doc.chunks.length, importedAt: chunk.importedAt, corpusKind: doc.corpusKind })), { schema })
  const docs = await db.createTable('documents', [{ id: doc.docId, fileName: doc.fileName, corpusKind: doc.corpusKind,
    filePath: 'C:\\must-never-read\\source-original.md', importedAt: doc.importedAt, chunkCount: doc.chunks.length }])
  chunks.close(); docs.close(); db.close()
  const read = await readSyncKnowledgeDocuments(source)
  expect(read[0]?.copy).toEqual({ availability: 'unavailable' })
  expect(read[0]?.logicalSource).toEqual({ kind: 'legacy-unbound' })
  // First registration adopts the existing tables and local embedding cache.
  const legacy = await lance.connect(path.join(source, 'lancedb'))
  const originalChunks = await legacy.openTable('chunks'), originalVersion = await originalChunks.version()
  const vectorRows = (await originalChunks.query().toArray()).map(row => ({ ...row, vector: [0.1, 0.2] }))
  originalChunks.close()
  const vectors = await legacy.createTable('chunks__space_1', vectorRows, { schema: new Schema([
    ...schema.fields, new Field('vector', new FixedSizeList(2, new Field('item', new Float32())), false),
  ]) })
  vectors.close(); legacy.close()
  const registry = JSON.stringify({ version: 1, activeGeneration: 1, spaces: [{ generation: 1, tableName: 'chunks__space_1',
    modelFingerprint: 'local-fixture-model', vectorDimension: 2, distanceMetric: 'l2', status: 'active', createdAt: '2026-10-21' }] })
  fs.writeFileSync(path.join(source, 'embedding-spaces.json'), registry)
  const sourceSelection = selection('first-registered-legacy'); guard(source, sourceSelection)
  await adoptSyncKnowledgeSelection(source, { selectionHash: sourceSelection, expectedCanonicalHash: hashSyncKnowledgeDocuments(read) })
  expect(resolveKnowledgeProjectionStorageRoot(source)).toBe(source)
  expect(fs.readFileSync(path.join(source, 'embedding-spaces.json'), 'utf8')).toBe(registry)
  const unchanged = await lance.connect(path.join(source, 'lancedb')), canonical = await unchanged.openTable('chunks')
  expect(await canonical.version()).toBe(originalVersion); canonical.close(); unchanged.close()
  const indexed = await captureGenerationKnowledge({ projectStorageRoot: source, query: '铜钥匙', queryVector: [0.1, 0.2],
    embeddingSpace: { modelFingerprint: 'local-fixture-model', distanceMetric: 'l2' } })
  expect(indexed.items).toHaveLength(2)
  const target = fixture(), selected = selection('selected-legacy'); guard(target, selected)
  await replaceSyncKnowledgeDocuments(target, read, { expectedBeforeHash: empty, selectionHash: selected })
  expect(await readSyncKnowledgeDocuments(target)).toEqual(read)
})

it.each(['prepared', 'built'] as const)('recovers a process stop after %s while retaining the complete previous generation', async phase => {
  const root = fixture(), first = cleanDocument(), originalSelection = selection('original'), selected = guard(root, originalSelection)
  await replaceSyncKnowledgeDocuments(root, [first], { expectedBeforeHash: empty, selectionHash: originalSelection })
  const previous = resolveKnowledgeProjectionStorageRoot(root), next = cleanDocument('next-doc'), nextSelection = selection(`next-${phase}`)
  selected.set(nextSelection)
  await expect(replaceSyncKnowledgeDocuments(root, [next], { expectedBeforeHash: hashSyncKnowledgeDocuments([first]), selectionHash: nextSelection,
    onPhase: current => { if (current === phase) throw new Error('SYNTHETIC_PROCESS_STOP') } })).rejects.toThrow('SYNTHETIC_PROCESS_STOP')
  await expect(readSyncKnowledgeDocuments(root)).rejects.toThrow('KNOWLEDGE_SYNC_NOT_READY')
  await expect(captureGenerationKnowledge({ projectStorageRoot: root, query: '铜钥匙' })).rejects.toThrow('KNOWLEDGE_SYNC_NOT_READY')
  const old = await lance.connect(path.join(previous, 'lancedb'))
  try { const table = await old.openTable('chunks'); try { expect(await table.countRows()).toBe(2) } finally { table.close() } } finally { old.close() }
  expect(await recoverSyncKnowledgeProjection(root)).toBe(true)
  expect(await readSyncKnowledgeDocuments(root)).toEqual([next])
  expect(fs.existsSync(previous)).toBe(true)
  expect(JSON.parse(fs.readFileSync(path.join(root, 'knowledge-sync-journal.json'), 'utf8'))).toBeNull()
  const successor = cleanDocument('after-recovery-doc'), successorSelection = selection(`after-recovery-${phase}`)
  selected.set(successorSelection)
  await replaceSyncKnowledgeDocuments(root, [successor], { expectedBeforeHash: hashSyncKnowledgeDocuments([next]), selectionHash: successorSelection })
  expect(await readSyncKnowledgeDocuments(root)).toEqual([successor])
  expect(JSON.parse(fs.readFileSync(path.join(root, 'knowledge-sync-journal.json'), 'utf8'))).toBeNull()
})

it('clears completed journals across consecutive remote selections without an intermediate adopt', async () => {
  const root = fixture(), first = cleanDocument(), firstSelection = selection('remote-first'), selected = guard(root, firstSelection)
  await replaceSyncKnowledgeDocuments(root, [first], { expectedBeforeHash: empty, selectionHash: firstSelection })
  expect(JSON.parse(fs.readFileSync(path.join(root, 'knowledge-sync-journal.json'), 'utf8'))).toBeNull()
  expect(await recoverSyncKnowledgeProjection(root)).toBe(false)
  const second = cleanDocument('remote-second'), secondSelection = selection('remote-second-selection')
  selected.set(secondSelection)
  await replaceSyncKnowledgeDocuments(root, [second], { expectedBeforeHash: hashSyncKnowledgeDocuments([first]), selectionHash: secondSelection })
  expect(await readSyncKnowledgeDocuments(root)).toEqual([second])
  expect(JSON.parse(fs.readFileSync(path.join(root, 'knowledge-sync-journal.json'), 'utf8'))).toBeNull()
  expect(await recoverSyncKnowledgeProjection(root)).toBe(false)
})

it('does not replay a selected-but-not-cleaned old intent after SQLite selects a successor, and preserves session/database failures', async () => {
  const root = fixture(), first = cleanDocument(), firstSelection = selection('initial-selected'), selected = guard(root, firstSelection)
  await replaceSyncKnowledgeDocuments(root, [first], { expectedBeforeHash: empty, selectionHash: firstSelection })
  const interrupted = cleanDocument('interrupted-selected-doc'), interruptedSelection = selection('interrupted-selection')
  selected.set(interruptedSelection)
  await expect(replaceSyncKnowledgeDocuments(root, [interrupted], { expectedBeforeHash: hashSyncKnowledgeDocuments([first]), selectionHash: interruptedSelection,
    onPhase: phase => { if (phase === 'selected') throw new Error('SYNTHETIC_STOP_AFTER_POINTER_COMMIT') } })).rejects.toThrow('SYNTHETIC_STOP_AFTER_POINTER_COMMIT')
  const pointer = JSON.parse(fs.readFileSync(path.join(root, 'knowledge-sync-projection.json'), 'utf8'))
  expect(pointer.selectionHash).toBe(interruptedSelection)
  const journalPath = path.join(root, 'knowledge-sync-journal.json'), originalIntent = fs.readFileSync(journalPath, 'utf8')
  expect(JSON.parse(originalIntent)).toMatchObject({ phase: 'built', generation: pointer.generation, selectionHash: interruptedSelection })
  expect(await readSyncKnowledgeDocuments(root)).toEqual([interrupted])
  const retainedGeneration = resolveKnowledgeProjectionStorageRoot(root)
  const successor = cleanDocument('new-authoritative-doc'), successorSelection = selection('new-authoritative-selection')
  selected.set(successorSelection)
  selected.close(); await expect(recoverSyncKnowledgeProjection(root)).rejects.toThrow('SYNTHETIC_DB_CLOSED'); selected.reopen()
  await expect(recoverSyncKnowledgeProjection(root, () => { throw new Error('SYNTHETIC_PROJECT_SESSION_FROZEN') })).rejects.toThrow('SYNTHETIC_PROJECT_SESSION_FROZEN')
  const check = vi.fn()
  expect(await recoverSyncKnowledgeProjection(root, check)).toBe(false)
  expect(check).toHaveBeenCalledOnce()
  expect(fs.readFileSync(journalPath, 'utf8')).toBe(originalIntent)
  expect(JSON.parse(fs.readFileSync(path.join(root, 'knowledge-sync-projection.json'), 'utf8'))).toEqual(pointer)
  await replaceSyncKnowledgeDocuments(root, [successor], { expectedBeforeHash: hashSyncKnowledgeDocuments([interrupted]), selectionHash: successorSelection })
  expect(await readSyncKnowledgeDocuments(root)).toEqual([successor])
  expect(fs.existsSync(retainedGeneration)).toBe(true)
  expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).toBeNull()
})

it('rejects a stale baseline and invalidates generation captures even when new table revisions start at the same number', async () => {
  const root = fixture(), doc = cleanDocument(), firstSelection = selection('first'), selected = guard(root, firstSelection)
  await replaceSyncKnowledgeDocuments(root, [doc], { expectedBeforeHash: empty, selectionHash: firstSelection })
  const snapshot = await captureGenerationKnowledge({ projectStorageRoot: root, query: '铜钥匙' })
  await expect(replaceSyncKnowledgeDocuments(root, [doc], { expectedBeforeHash: empty, selectionHash: firstSelection })).rejects.toThrow('BASE_CHANGED')
  const secondSelection = selection('second'); selected.set(secondSelection)
  await replaceSyncKnowledgeDocuments(root, [doc], { expectedBeforeHash: hashSyncKnowledgeDocuments([doc]), selectionHash: secondSelection })
  await expect(verifyGenerationKnowledge({ projectStorageRoot: root, snapshot })).rejects.toThrow('SOURCE_STALE')
  const current = await captureGenerationKnowledge({ projectStorageRoot: root, query: '铜钥匙' })
  expect(current.items[0]?.chunkId).toBe(snapshot.items[0]?.chunkId)
  await verifyGenerationKnowledge({ projectStorageRoot: root, snapshot: current })
})

it('adopts observed local copy edits without rebuilding the selected Lance tables or discarding local registry', async () => {
  const root = fixture(), doc = cleanDocument(), first = selection('adopt-first'), selected = guard(root, first)
  await replaceSyncKnowledgeDocuments(root, [doc], { expectedBeforeHash: empty, selectionHash: first })
  const physical = resolveKnowledgeProjectionStorageRoot(root)
  fs.writeFileSync(path.join(physical, 'embedding-spaces.json'), JSON.stringify({ version: 1, activeGeneration: null, spaces: [] }))
  const db = await lance.connect(path.join(physical, 'lancedb')), table = await db.openTable('chunks'), beforeVersion = await table.version()
  table.close(); db.close()
  if (doc.copy.availability !== 'available') throw new Error('fixture copy missing')
  const { content, indexedHash, edited, indexDirty } = doc.copy
  writeKnowledgeCopy(root, doc.docId, { content: content + '\n本机编辑。', indexedHash, edited: !edited, indexDirty: !indexDirty })
  const changed = await readSyncKnowledgeDocuments(root), next = selection('adopt-next'); selected.set(next)
  await expect(readSyncKnowledgeDocuments(root)).rejects.toThrow('NOT_READY')
  await adoptSyncKnowledgeSelection(root, { selectionHash: next, expectedCanonicalHash: hashSyncKnowledgeDocuments(changed) })
  expect(resolveKnowledgeProjectionStorageRoot(root)).toBe(physical)
  expect(await readSyncKnowledgeDocuments(root)).toEqual(changed)
  const reopened = await lance.connect(path.join(physical, 'lancedb')), after = await reopened.openTable('chunks')
  expect(await after.version()).toBe(beforeVersion); after.close(); reopened.close()
  expect(fs.existsSync(path.join(physical, 'embedding-spaces.json'))).toBe(true)
})
