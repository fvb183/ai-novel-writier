import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { createProjectDatabase } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { parseSyncKnowledgeDocument, serializeSyncKnowledgeDocument, syncKnowledgeTextHash } from '../../../src/shared/project-sync-knowledge'
import { importText, readDocumentCopy } from '../../knowledge-base'
import { closeConnection, hashSyncKnowledgeDocuments, readSyncKnowledgeDocuments, removeDocument, resolveKnowledgeProjectionStorageRoot } from '../../vector-store'
import { windowsSafeFileSystem } from '../../security/windows-safe-file-system'
import { activateCanonicalProjectData, deactivateProjectData } from '../project-data-locator'
import { captureGenerationKnowledge, verifyGenerationKnowledge } from '../generation-knowledge-source'
import { ProjectAssetBlobStore } from '../project-asset-blob-store'
import { prepareProjectAuthorAssets, recoverProjectAuthorAssets, projectAssetRuntimeContext } from '../project-asset-runtime'
import { getProjectSyncEngine, disposeProjectSyncEngine } from '../project-sync-service'
import { assertProjectAssetsReady, captureProjectAssets, pendingProjectAssets, selectedKnowledgeAssetHash,
  applySelectedProjectAssets, projectAssetIdentity } from '../project-sync-assets'

interface RuntimeKnowledgeFixture {
  project: string; storage: string; projectId: string; db: Database.Database
  engine: ReturnType<typeof getProjectSyncEngine>; session: ReturnType<typeof session>; store: ProjectAssetBlobStore
}
const runs: RuntimeKnowledgeFixture[] = []
const model = { provider: 'custom', baseUrl: 'http://127.0.0.1:1/unused', apiKey: '' }
const original = '铜钥匙藏在旧钟后面。\n\n保留完整原文、空白与🙂。'
function session(db: Database.Database, projectId: string, project: string) {
  const state = { active: true }
  return { state, context: projectAssetRuntimeContext(db, projectId, project, () => {
    if (!state.active || !db.open) throw new Error('SYNTHETIC_PROJECT_SESSION_STALE')
  }) }
}
function fixture(): RuntimeKnowledgeFixture {
  const temporary = fs.realpathSync.native(os.tmpdir())
  if (process.platform === 'win32' && !temporary.toLowerCase().startsWith('c:\\')) throw new Error('C_SCRATCH_REQUIRED')
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, 'rk-'))), storage = path.join(project, '.ai-novel'), projectId = randomUUID()
  fs.mkdirSync(storage)
  fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId, createdAt: '2026-10-29T00:00:00Z' })))
  createProjectDatabase(project, Buffer.alloc(32, 67))
  const db = new Database(path.join(storage, 'project.db')); db.pragma('foreign_keys=ON')
  expect(db.pragma('user_version', { simple: true })).toBe(11)
  db.prepare("INSERT INTO project_core(id,project_name) VALUES('main','实际知识运行时测试')").run()
  const engine = getProjectSyncEngine(db, projectId)
  const run = { project, storage, projectId, db, engine, session: session(db, projectId, project), store: new ProjectAssetBlobStore(storage) }
  runs.push(run)
  engine.enable(); activateCanonicalProjectData(project)
  return run
}
function reopen(run: RuntimeKnowledgeFixture) {
  const previousContext = run.session.context
  run.session.state.active = false
  closeConnection(run.project)
  disposeProjectSyncEngine(run.db)
  if (run.db.open) run.db.close()
  run.db = new Database(path.join(run.storage, 'project.db')); run.db.pragma('foreign_keys=ON')
  run.engine = getProjectSyncEngine(run.db, run.projectId)
  run.session = session(run.db, run.projectId, run.project)
  activateCanonicalProjectData(run.project)
  return previousContext
}
async function writeOriginal(run: RuntimeKnowledgeFixture) {
  const imported = await importText(original, '第3章 序幕 正文.md', run.project, 'openai', model, { mode: 'fts-only' })
  expect(imported.success).toBe(true)
  const docs = await readSyncKnowledgeDocuments(run.storage)
  expect(docs).toHaveLength(1); expect(docs[0]!.docId).toBe(imported.docId)
  expect(docs[0]!.copy).toMatchObject({ availability: 'available', content: original, indexDirty: false })
  expect(docs[0]!.logicalSource).toEqual({ kind: 'legacy-unbound' })
  return docs[0]!
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  for (const run of runs.splice(0)) {
    run.session.state.active = false
    closeConnection(run.project); disposeProjectSyncEngine(run.db)
    if (run.db.open) run.db.close()
    deactivateProjectData(run.project)
    if (!path.basename(run.project).startsWith('rk-') || path.dirname(run.project) !== fs.realpathSync.native(os.tmpdir())) throw new Error('UNSAFE_TEST_CLEANUP')
    fs.rmSync(run.project, { recursive: true, force: true })
  }
})

it('captures the actual saved knowledge into CAS and recovers a committed local catalog before pointer adoption after reopen', async () => {
  const run = fixture(), doc = await writeOriginal(run)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_EMBEDDING_OR_NETWORK') }))
  const originalWrite = windowsSafeFileSystem.writeTextAtomically.bind(windowsSafeFileSystem)
  let interrupted = false
  const write = vi.spyOn(windowsSafeFileSystem, 'writeTextAtomically').mockImplementation((capability, content, beforeReplace, constraints) => originalWrite(capability, content, async () => {
    await beforeReplace?.()
    if (!interrupted && capability.relativePath.replaceAll('\\', '/').endsWith('knowledge-sync-projection.json')) {
      interrupted = true
      const selected = captureProjectAssets(run.db)
      expect(selected).toHaveLength(1)
      expect(pendingProjectAssets(run.db)).toHaveLength(1)
      expect(selectedKnowledgeAssetHash(run.db)).toBeTypeOf('string')
      throw new Error('SYNTHETIC_STOP_AFTER_CATALOG_COMMIT_BEFORE_ADOPT')
    }
  }, constraints))
  await expect(prepareProjectAuthorAssets(run.session.context)).rejects.toThrow('SYNTHETIC_STOP_AFTER_CATALOG_COMMIT_BEFORE_ADOPT')
  write.mockRestore()
  expect(interrupted).toBe(true)
  expect(fs.existsSync(path.join(run.storage, 'knowledge-sync-projection.json'))).toBe(false)
  await expect(readSyncKnowledgeDocuments(run.storage)).rejects.toThrow('KNOWLEDGE_SYNC_NOT_READY')
  const record = captureProjectAssets(run.db)[0]!, value = record.value as { category: 'knowledge'; documentId: string; blob: { sha256: string; byteSize: number; mime: string } }
  expect(value.documentId).toBe(doc.docId)
  expect(parseSyncKnowledgeDocument(JSON.parse(run.store.read(value.blob).toString('utf8')))).toEqual(doc)
  const previousContext = reopen(run)
  await expect(prepareProjectAuthorAssets(previousContext)).rejects.toThrow('SYNTHETIC_PROJECT_SESSION_STALE')
  await recoverProjectAuthorAssets(run.session.context)
  expect(pendingProjectAssets(run.db)).toEqual([]); assertProjectAssetsReady(run.db)
  expect(await readSyncKnowledgeDocuments(run.storage)).toEqual([doc])
  expect(resolveKnowledgeProjectionStorageRoot(run.storage)).toBe(run.storage)
  const snapshot = await captureGenerationKnowledge({ projectStorageRoot: run.storage, query: '铜钥匙' })
  expect(snapshot.items.map(item => item.chunkId)).toEqual(doc.chunks.map(chunk => chunk.id))
  await verifyGenerationKnowledge({ projectStorageRoot: run.storage, snapshot })
  const batches = run.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()
  await prepareProjectAuthorAssets(run.session.context)
  expect(run.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(batches)
  expect(fetch).not.toHaveBeenCalled()
}, 60000)

it('registers an empty knowledge source and captures deletion of every document without losing superseded CAS bytes', async () => {
  const run = fixture()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_EMBEDDING_OR_NETWORK') }))
  await prepareProjectAuthorAssets(run.session.context)
  expect(pendingProjectAssets(run.db)).toEqual([])
  expect(await readSyncKnowledgeDocuments(run.storage)).toEqual([])
  expect((await captureGenerationKnowledge({ projectStorageRoot: run.storage, query: '铜钥匙' })).items).toEqual([])
  const doc = await writeOriginal(run)
  await prepareProjectAuthorAssets(run.session.context)
  const previous = captureProjectAssets(run.db)[0]!, blob = (previous.value as { blob: { sha256: string; byteSize: number; mime: string } }).blob
  const originalBytes = run.store.read(blob)
  expect(await removeDocument(run.project, doc.docId)).toBe(true)
  await prepareProjectAuthorAssets(run.session.context)
  expect(captureProjectAssets(run.db)).toEqual([]); expect(pendingProjectAssets(run.db)).toEqual([])
  expect(selectedKnowledgeAssetHash(run.db)).toBeTypeOf('string')
  expect(await readSyncKnowledgeDocuments(run.storage)).toEqual([])
  expect(run.store.read(blob)).toEqual(originalBytes)
  expect(run.engine.exportBundle().batches.some(batch => batch.changes.some(change => change.kind === 'project-asset' && change.id === previous.id && change.deleted))).toBe(true)
  reopen(run); await recoverProjectAuthorAssets(run.session.context)
  expect(await readSyncKnowledgeDocuments(run.storage)).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
}, 60000)

it('disposes the old engine guard, rebinds a new real SQLite session and rejects old generation snapshots after CAS-backed replacement', async () => {
  const run = fixture(), doc = await writeOriginal(run)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_EMBEDDING_OR_NETWORK') }))
  await prepareProjectAuthorAssets(run.session.context)
  const originalSnapshot = await captureGenerationKnowledge({ projectStorageRoot: run.storage, query: '铜钥匙' })
  await verifyGenerationKnowledge({ projectStorageRoot: run.storage, snapshot: originalSnapshot })
  run.db.close()
  await expect(readSyncKnowledgeDocuments(run.storage)).rejects.toThrow('SYNC_SESSION_STALE')
  disposeProjectSyncEngine(run.db)
  await expect(readSyncKnowledgeDocuments(run.storage)).rejects.toThrow('KNOWLEDGE_SYNC_SELECTION_GUARD_REQUIRED')
  reopen(run)
  await recoverProjectAuthorAssets(run.session.context)
  expect(hashSyncKnowledgeDocuments(await readSyncKnowledgeDocuments(run.storage))).toBe(hashSyncKnowledgeDocuments([doc]))
  await verifyGenerationKnowledge({ projectStorageRoot: run.storage, snapshot: originalSnapshot })
  const body = '铜钥匙已经转移到北门。\n\n完整新原文🙂。', bodyHash = syncKnowledgeTextHash(body)
  const remote = parseSyncKnowledgeDocument({ ...doc, chunks: doc.chunks.map(chunk => ({ ...chunk, text: body, textHash: bodyHash })),
    copy: { availability: 'available', content: body, contentHash: bodyHash, indexedHash: bodyHash, edited: true, indexDirty: false } })
  const value = { version: 1 as const, category: 'knowledge' as const, documentId: remote.docId, blob: run.store.put(Buffer.from(serializeSyncKnowledgeDocument(remote)), 'application/json') }
  run.engine.captureMutation(() => applySelectedProjectAssets(run.db, [{ kind: 'project-asset', id: projectAssetIdentity(run.projectId, value), value }], run.store))
  expect(pendingProjectAssets(run.db)).toHaveLength(1)
  await expect(captureGenerationKnowledge({ projectStorageRoot: run.storage, query: '铜钥匙' })).rejects.toThrow('KNOWLEDGE_SYNC_NOT_READY')
  await recoverProjectAuthorAssets(run.session.context)
  expect(pendingProjectAssets(run.db)).toEqual([])
  expect(resolveKnowledgeProjectionStorageRoot(run.storage)).not.toBe(run.storage)
  expect(await readSyncKnowledgeDocuments(run.storage)).toEqual([remote])
  expect((await readDocumentCopy(remote.docId, run.project)).content).toBe(body)
  await expect(verifyGenerationKnowledge({ projectStorageRoot: run.storage, snapshot: originalSnapshot })).rejects.toThrow('SOURCE_STALE')
  const current = await captureGenerationKnowledge({ projectStorageRoot: run.storage, query: '铜钥匙' })
  expect(current.items[0]?.chunkId).toBe(remote.chunks[0]!.id)
  await verifyGenerationKnowledge({ projectStorageRoot: run.storage, snapshot: current })
  expect(fetch).not.toHaveBeenCalled()
}, 60000)
