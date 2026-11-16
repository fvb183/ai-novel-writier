/** Synthetic pre-1.4.4 books, built through the production Android adapters. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { initializeLegacyBaselineSchema } from '../electron/migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../electron/migrations/desktop-registry'
import { migrateSchema } from '../electron/migrations/runner'
import { SqliteSchemaAdapter } from '../electron/migrations/sqlite-schema-adapter'
import { createCanonicalProjectManifest } from '../src/shared/project-format'
import { ProjectSyncEngine } from '../electron/services/project-sync-engine'
import { projectSyncProjection } from '../electron/services/project-sync-projection'
import { ProjectAssetBlobStore } from '../electron/services/project-asset-blob-store'
import { materializeSelectedProjectAssets } from '../electron/services/project-asset-materializer'
import { recordCapturedProjectAssets, projectAssetIdentity, selectedKnowledgeAssetHash } from '../electron/services/project-sync-assets'
import { setAuthoritativeFinalizedDraft } from '../electron/services/finalized-draft-head'
import { registerSyncKnowledgeReadGuard } from '../electron/services/sync-knowledge-projection'
import { restorePortableKnowledgeSnapshot, replaceSyncKnowledgeDocuments } from '../electron/vector-store'
import { hashSyncKnowledgeDocuments, parseSyncKnowledgeDocument, serializeSyncKnowledgeDocument } from '../src/shared/project-sync-knowledge'
import type { ProjectAuthorAsset } from '../src/shared/project-sync-assets'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const manuscript = '旧书已定稿正文：铜钥匙在左口袋。\r\n升级后仍可继续写作。🧭'
const original = '旧书完整知识原文。\n\n正文分块只保存这一行。\n仅存在于原文副本的结尾🙂'
const document = parseSyncKnowledgeDocument({ version: 1, docId: 'schema11-knowledge', fileName: '旧知识原文.md', corpusKind: 'project-knowledge',
  importedAt: '2026-11-11T00:00:00Z', logicalSource: { kind: 'legacy-unbound' },
  chunks: [{ id: 'schema11-original-chunk', chunkIndex: 0, text: '正文分块只保存这一行。', textHash: digest('正文分块只保存这一行。'), importedAt: '2026-11-11T00:00:00Z' }],
  copy: { availability: 'available', content: original, contentHash: digest(original), indexedHash: digest(original), edited: false, indexDirty: false } })

function database(root: string, projectId: string, name: string) {
  const storage = path.join(root, '.ai-novel'); fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId, createdAt: '2026-11-11T00:00:00Z' })))
  const db = new Database(path.join(storage, 'project.db')); db.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 11)
  db.prepare("INSERT INTO project_core(id,project_name,genre,world_setting) VALUES('main',?,'奇幻','旧世界设定：船已靠岸。')").run(name)
  return { db, storage }
}
function authorContent(db: import('better-sqlite3').Database) {
  const content = db.prepare('INSERT INTO contents(body) VALUES(?)').run(manuscript).lastInsertRowid
  const draftId = Number(db.prepare("INSERT INTO drafts(chapter_number,version,status,source,content_id,word_count) VALUES(1,1,'finalized','write',?,?)").run(content, manuscript.length).lastInsertRowid)
  db.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,target_file_name,publication_status)
    VALUES('schema11-final',?,1,'旧第一章',?,1,?,'old-chapter-1.txt','published')`).run(draftId, digest(manuscript), manuscript)
  setAuthoritativeFinalizedDraft(db, 1, draftId)
  db.prepare("INSERT INTO blueprints(chapter_number,title,user_guidance,notes) VALUES(2,'第二章蓝图','旧作者指导','不能丢失的旧备注')").run()
}
async function materialize(db: import('better-sqlite3').Database, storage: string) {
  const release = registerSyncKnowledgeReadGuard(storage, () => selectedKnowledgeAssetHash(db))
  try {
    await materializeSelectedProjectAssets({ database: db, storageRoot: storage, revalidate: () => {}, replaceKnowledge: async input => {
      await replaceSyncKnowledgeDocuments(storage, input.selected.map(item => parseSyncKnowledgeDocument(JSON.parse(item.bytes.toString()))), {
        expectedBeforeHash: hashSyncKnowledgeDocuments(input.previous.map(item => parseSyncKnowledgeDocument(JSON.parse(item.bytes.toString())))),
        selectionHash: input.selectionHash, verifySelected: input.verifySelected,
      })
    } })
  } finally { release() }
}
export async function createSchema11Book(root: string, kind: 'local' | 'sync-imported') {
  const projectId = randomUUID(), title = kind === 'local' ? '手机原有本地旧书' : '电脑同步加入的旧书'
  const sourceRoot = kind === 'local' ? root : `${root}-source`
  const source = database(sourceRoot, projectId, title)
  try {
    authorContent(source.db)
    if (kind === 'local') {
      await restorePortableKnowledgeSnapshot(source.storage, { version: 1, documents: [{ docId: document.docId, fileName: document.fileName,
        corpusKind: document.corpusKind, chunks: document.chunks.map(chunk => ({ chunkIndex: chunk.chunkIndex, text: chunk.text })),
        copy: { content: original, indexedHash: digest(original), edited: false, indexDirty: false } }] })
      return { root, storage: source.storage, kind, projectId, title, manuscript, original, sourceReplicaId: null, importedReplicaId: null }
    }
    const store = new ProjectAssetBlobStore(source.storage)
    const knowledge: ProjectAuthorAsset = { version: 1, category: 'knowledge', documentId: document.docId,
      blob: store.put(Buffer.from(serializeSyncKnowledgeDocument(document)), 'application/json') }
    const prompt: ProjectAuthorAsset = { version: 1, category: 'files', group: 'prompt', logicalName: 'prompts/draft.zh-cn.json',
      files: [{ path: 'prompts/draft.zh-cn.json', blob: store.put(Buffer.from('{"key":"draft","content":"旧本机提示词保留"}'), 'application/json') }] }
    const assets = [knowledge, prompt].map(value => ({ id: projectAssetIdentity(projectId, value), value }))
    recordCapturedProjectAssets(source.db, assets); await materialize(source.db, source.storage)
    const first = new ProjectSyncEngine(source.db, projectId, projectSyncProjection); first.enable()
    const bundle = first.exportBundle(), sourceReplicaId = first.status().replicaId
    const target = database(root, projectId, title)
    try {
      const targetStore = new ProjectAssetBlobStore(target.storage)
      for (const asset of assets) {
        const blobs = asset.value.category === 'files' ? asset.value.files.map(file => file.blob) : asset.value.blob ? [asset.value.blob] : []
        for (const blob of blobs) targetStore.put(store.read(blob), blob.mime)
      }
      const joined = new ProjectSyncEngine(target.db, projectId, projectSyncProjection)
      joined.join(bundle); await materialize(target.db, target.storage)
      return { root, storage: target.storage, kind, projectId, title, manuscript, original, sourceReplicaId, importedReplicaId: joined.status().replicaId }
    } finally { target.db.close() }
  } finally { source.db.close() }
}

export function schema11BookState(root: string) {
  const storage = path.join(root, '.ai-novel'), db = new Database(path.join(storage, 'project.db'), { readonly: true, fileMustExist: true })
  try {
    const hasCompact = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_sync_compact_meta'").get())
    const clock = hasCompact ? db.prepare('SELECT clock_json,pending_clock_json FROM project_sync_compact_meta WHERE id=1').get() : null
    return { version: Number(db.pragma('user_version', { simple: true })),
      core: db.prepare("SELECT project_name,genre,world_setting FROM project_core WHERE id='main'").get(),
      drafts: db.prepare('SELECT d.chapter_number,d.status,c.body FROM drafts d JOIN contents c ON c.id=d.content_id ORDER BY d.id').all(),
      finalizations: db.prepare('SELECT finalization_id,chapter_number,content_hash,content_snapshot FROM finalization_outbox ORDER BY draft_id').all(),
      heads: db.prepare('SELECT * FROM chapter_finalization_heads').all(),
      blueprints: db.prepare('SELECT chapter_number,title,user_guidance,notes FROM blueprints ORDER BY chapter_number').all(),
      replica: db.prepare('SELECT project_id,replica_id FROM project_sync_meta WHERE id=1').get() ?? null,
      acceptedBatches: Number(db.prepare('SELECT COUNT(*) FROM project_sync_batches WHERE accepted=1').pluck().get()),
      compact: clock ? { clock: JSON.parse(String((clock as { clock_json: string }).clock_json)), pending: JSON.parse(String((clock as { pending_clock_json: string }).pending_clock_json)) } : null }
  } finally { db.close() }
}
