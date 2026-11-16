import path from 'node:path'
import type Database from 'better-sqlite3'
import type { SyncApplyResult, SyncResolution } from '../../src/shared/project-sync'
import { CANONICAL_PROJECT_DIRECTORY } from '../../src/shared/project-format'
import { parseSyncKnowledgeDocument, hashSyncKnowledgeDocuments, serializeSyncKnowledgeDocument } from '../../src/shared/project-sync-knowledge'
import { ProjectAssetBlobStore } from './project-asset-blob-store'
import { materializeSelectedProjectAssets } from './project-asset-materializer'
import { snapshotSavedProjectAssets } from './project-asset-source-service'
import { assertProjectAssetsReady, captureProjectAssets, markProjectAssetMaterialized, pendingProjectAssets, recordCapturedProjectAssets, selectedKnowledgeAssetHash } from './project-sync-assets'
import { referencedProjectAssetBlobs } from './project-sync-asset-manifest'
import { getProjectSyncEngine } from './project-sync-service'
import { withProjectAssetMutation } from './project-asset-access'
import { adoptSyncKnowledgeSelection, readSyncKnowledgeDocuments, recoverSyncKnowledgeProjection,
  replaceSyncKnowledgeDocuments, withSyncKnowledgeDocuments } from '../vector-store'

export interface ProjectAssetRuntimeContext {
  database: Database.Database
  projectId: string
  storageRoot: string
  revalidate(): void
}
function decode(bytes: Buffer) {
  try { return parseSyncKnowledgeDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
  catch { throw new Error('PROJECT_SYNC_ASSET_INVALID') }
}
function requireContext(context: ProjectAssetRuntimeContext): void {
  context.revalidate()
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  if (normalize(path.dirname(context.database.name)) !== normalize(context.storageRoot)) throw new Error('SYNC_SESSION_STALE')
  getProjectSyncEngine(context.database, context.projectId)
}
/** Installs only local projections of an already selected manifest. It does not
 * replay model calls, accept inbox batches, or initiate network transfers. */
async function materialize(context: ProjectAssetRuntimeContext): Promise<void> {
  context.revalidate()
  await materializeSelectedProjectAssets({ ...context, replaceKnowledge: async input => {
    const documents = input.selected.map(item => {
      const document = decode(item.bytes)
      if (document.docId !== item.documentId) throw new Error('PROJECT_SYNC_ASSET_INVALID')
      return document
    }), previous = input.previous.map(item => decode(item.bytes))
    const canonicalHash = hashSyncKnowledgeDocuments(documents)
    // A local save may have committed the catalog just before a process exit,
    // leaving its already-edited physical source waiting to adopt the new identity.
    try {
      await adoptSyncKnowledgeSelection(context.storageRoot, { selectionHash: input.selectionHash,
        expectedCanonicalHash: canonicalHash, verifySelected: input.verifySelected })
      return
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'KNOWLEDGE_SYNC_BASE_CHANGED') throw error
    }
    if (await recoverSyncKnowledgeProjection(context.storageRoot, input.verifySelected)) {
      input.verifySelected()
      const recovered = await readSyncKnowledgeDocuments(context.storageRoot)
      if (hashSyncKnowledgeDocuments(recovered) !== canonicalHash) throw new Error('PROJECT_SYNC_ASSET_SOURCE_CHANGED')
      return
    }
    await replaceSyncKnowledgeDocuments(context.storageRoot, documents, {
      selectionHash: input.selectionHash, expectedBeforeHash: hashSyncKnowledgeDocuments(previous), verifySelected: input.verifySelected,
    })
  } })
  context.revalidate(); assertProjectAssetsReady(context.database)
}
export async function recoverProjectAuthorAssets(context: ProjectAssetRuntimeContext): Promise<void> {
  requireContext(context)
  await withProjectAssetMutation(context.storageRoot, context.revalidate, async () => {
    if (pendingProjectAssets(context.database).length) await materialize(context)
  })
}
/** Runs synchronously inside the author-asset gate, only after adopted files are
 * ready. Preserve both pending/conflicting heads and current local manifests:
 * a received successor must not reclaim the still-adopted previous bytes. */
function pruneRetiredAuthorAssetBytes(context: ProjectAssetRuntimeContext, store: ProjectAssetBlobStore): void {
  context.revalidate(); assertProjectAssetsReady(context.database)
  const engine = getProjectSyncEngine(context.database, context.projectId)
  if (typeof engine.liveCompactRecords !== 'function') return
  const liveAssets = typeof engine.liveCompactAssetRecords === 'function' ? engine.liveCompactAssetRecords(true) : engine.liveCompactRecords(true)
  const records = [
    ...liveAssets,
    ...captureProjectAssets(context.database).map(record => ({ kind: record.kind, id: record.id, heads: [{ deleted: false, value: record.value }] })),
  ]
  const references = referencedProjectAssetBlobs({ batches: [], compact: { records } })
  store.pruneUnreferenced(references, context.revalidate)
}
/** Freeze saved sources under both the author-file and knowledge mutation gates.
 * The accepted causal batch and selected manifests commit in one SQLite transaction. */
async function prepareUnderGate(context: ProjectAssetRuntimeContext): Promise<ProjectAssetBlobStore> {
    await materialize(context)
    await withSyncKnowledgeDocuments(context.storageRoot, async (documents, canonicalHash, lease) => {
      const snapshot = await snapshotSavedProjectAssets({ ...context, readKnowledge: async () => ({
        documents: documents.map(document => ({ documentId: document.docId, bytes: Buffer.from(serializeSyncKnowledgeDocument(document), 'utf8') })),
        canonicalHash,
        verifyUnchanged: async () => hashSyncKnowledgeDocuments(await readSyncKnowledgeDocuments(context.storageRoot, lease)) === canonicalHash,
      }) })
      await snapshot.verifyUnchanged(); context.revalidate()
      getProjectSyncEngine(context.database, context.projectId).captureMutation(() => recordCapturedProjectAssets(context.database, snapshot.records))
      const selectionHash = selectedKnowledgeAssetHash(context.database)
      const pendingKnowledge = pendingProjectAssets(context.database).filter(item => item.selected?.category === 'knowledge' || item.materialized?.category === 'knowledge')
      if (selectionHash && pendingKnowledge.length) {
        const verifySelected = () => {
          context.revalidate()
          if (selectedKnowledgeAssetHash(context.database) !== selectionHash) throw new Error('PROJECT_SYNC_ASSET_SELECTION_CHANGED')
        }
        await adoptSyncKnowledgeSelection(context.storageRoot, { selectionHash, expectedCanonicalHash: snapshot.knowledgeCanonicalHash, verifySelected, lease })
        verifySelected()
        context.database.transaction(() => {
          for (const item of pendingKnowledge) markProjectAssetMaterialized(context.database, item.id, item.selected)
        })()
      }
    })
    context.revalidate(); assertProjectAssetsReady(context.database)
    const store = new ProjectAssetBlobStore(context.storageRoot)
    pruneRetiredAuthorAssetBytes(context, store)
    return store
}
export async function prepareProjectAuthorAssets(context: ProjectAssetRuntimeContext): Promise<ProjectAssetBlobStore> {
  requireContext(context)
  return withProjectAssetMutation(context.storageRoot, context.revalidate, () => prepareUnderGate(context))
}
export async function applyProjectAuthorSync(context: ProjectAssetRuntimeContext, token: string,
  resolutions: SyncResolution[]): Promise<SyncApplyResult> {
  requireContext(context)
  return withProjectAssetMutation(context.storageRoot, context.revalidate, async () => {
    await prepareUnderGate(context)
    context.revalidate()
    const applied = getProjectSyncEngine(context.database, context.projectId).apply(token, resolutions)
    if (applied.applied) {
      try { await materialize(context); pruneRetiredAuthorAssetBytes(context, new ProjectAssetBlobStore(context.storageRoot)) }
      catch (error) {
        context.revalidate()
        const code = error instanceof Error && /^PROJECT_SYNC_ASSET_[A-Z0-9_]+$/.test(error.message)
          ? error.message : 'PROJECT_SYNC_ASSET_NOT_READY'
        // SQLite already committed. The caller must rebind its editors and
        // recover the local journal, never treat this as an unapplied sync.
        return { ...applied, assetsPending: true, assetsError: code }
      }
    }
    return applied
  })
}
export function projectAssetRuntimeContext(database: Database.Database, projectId: string, projectRoot: string,
  revalidate: () => void): ProjectAssetRuntimeContext {
  return { database, projectId, storageRoot: path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY), revalidate }
}
