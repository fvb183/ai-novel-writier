import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { createProjectDatabase } from '../../database'
import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { hashSyncKnowledgeDocuments } from '../../../src/shared/project-sync-knowledge'
import { parseProjectAuthorAsset, projectAssetBlobs } from '../../../src/shared/project-sync-assets'
import { prepareProjectAuthorAssets, recoverProjectAuthorAssets, applyProjectAuthorSync, type ProjectAssetRuntimeContext } from '../project-asset-runtime'
import { getProjectSyncEngine, disposeProjectSyncEngine } from '../project-sync-service'
import { attachBundleAssets, stageBundleAssets } from '../project-sync-asset-transfer'
import { joinSyncProject } from '../project-sync-transfer'
import { ProjectAssetBlobStore } from '../project-asset-blob-store'
import { captureProjectAssets, pendingProjectAssets, selectedKnowledgeAssetHash } from '../project-sync-assets'
import { activateCanonicalProjectData, deactivateProjectData } from '../project-data-locator'
import { restorePortableKnowledgeSnapshot, readSyncKnowledgeDocuments, replaceDocumentChunks, removeDocument, closeConnection } from '../../vector-store'
import { captureGenerationKnowledge, verifyGenerationKnowledge } from '../generation-knowledge-source'
import { syncDigest } from '../project-sync-engine'
import { windowsSafeFileSystem } from '../../security/windows-safe-file-system'
import { PromptCatalog, ipcPromptPersistence } from '../../../src/services/prompt-catalog'
import type { PromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { assertProjectAssetFileAccess } from '../project-asset-access'
import { PLOT_OUTLINE_PROTOCOL } from '../../../src/shared/plot-outline-contract'

type Replica = { project: string; root: string; projectId: string; db: Database.Database; context: ProjectAssetRuntimeContext }
const roots: string[] = [], replicas: Replica[] = []
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const prompt = (content: string, localized = false) => JSON.stringify({ key: 'draft', name: '合成草稿模板', description: '真实文件流程测试',
  content, variables: {}, ...(localized ? { writingLanguage: 'zh-CN' } : {}) })
function scratch() {
  const temporary = fs.realpathSync.native(os.tmpdir())
  vi.stubEnv('LOCALAPPDATA', temporary)
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, 'ainw-ar-'))); roots.push(root); return root
}
function open(project: string, projectId: string): Replica {
  const root = path.join(project, '.ai-novel'), db = new Database(path.join(root, 'project.db')); db.pragma('foreign_keys=ON')
  expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
  const replica = { project, root, projectId, db, context: { database: db, storageRoot: root, projectId, revalidate: () => { if (!db.open) throw new Error('SYNC_SESSION_STALE') } } }
  replicas.push(replica); activateCanonicalProjectData(project); return replica
}
function create(): Replica {
  const project = scratch(), root = path.join(project, '.ai-novel'), projectId = randomUUID(); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId, createdAt: '2026-10-29T00:00:00Z' })))
  createProjectDatabase(project, Buffer.alloc(32, 97)); const replica = open(project, projectId)
  replica.db.prepare("INSERT INTO project_core(id,project_name) VALUES('main','真实资产同步合成项目')").run()
  return replica
}
function write(replica: Replica, relative: string, content: string) {
  const file = path.resolve(replica.root, relative)
  if (path.relative(replica.root, file).startsWith('..')) throw new Error('fixture write escaped root')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content)
}
async function seed(replica: Replica, fullOriginal = false) {
  write(replica, 'prompts/draft.json', prompt('base'))
  write(replica, 'skills/scene/SKILL.md', 'base Skill'); write(replica, 'skills/scene/example.md', 'base complete example')
  const content = 'base 铜钥匙线索。' + (fullOriginal ? '\n\n仅存在于完整原文、没有进入分块的结尾。🙂' : '')
  await restorePortableKnowledgeSnapshot(replica.root, { version: 1, documents: [{ docId: 'shared-doc', fileName: 'shared-doc.md', corpusKind: 'project-knowledge',
    chunks: [{ chunkIndex: 0, text: 'base 铜钥匙线索。' }], copy: { content, indexedHash: sha(content), edited: false, indexDirty: false } }] })
}
async function join(left: Replica): Promise<Replica> {
  const store = await prepareProjectAuthorAssets(left.context), engine = getProjectSyncEngine(left.db, left.projectId)
  engine.enable()
  const bundle = attachBundleAssets(engine.exportBundle(), store), parent = scratch(), target = path.join(parent, 'joined')
  expect(bundle.inlineBlobs?.length).toBeGreaterThan(0)
  const joined = await joinSyncProject({ bundle, targetProjectPath: target, assertTargetAuthorized: () => {},
    prepareAssets: async (_database, storageRoot) => stageBundleAssets(bundle, new ProjectAssetBlobStore(storageRoot)),
    join: (database, projectId, incoming) => getProjectSyncEngine(database, projectId).join(incoming),
    materializeAssets: (database, storageRoot) => recoverProjectAuthorAssets({ database, storageRoot, projectId: bundle.projectId, revalidate: () => {} }),
  })
  expect(joined.applied.applied).toBe(true); expect(joined.projectId).toBe(left.projectId)
  const right = open(joined.projectPath, joined.projectId); getProjectSyncEngine(right.db, right.projectId)
  return right
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  for (const replica of replicas.splice(0)) {
    closeConnection(replica.project); disposeProjectSyncEngine(replica.db); if (replica.db.open) replica.db.close(); deactivateProjectData(replica.project)
  }
  const temporary = fs.realpathSync.native(os.tmpdir())
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== temporary || !path.basename(root).startsWith('ainw-ar-')) throw new Error('unsafe runtime fixture cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('prepares saved author assets, exports complete inline bytes, asynchronously joins and reopens guarded real knowledge for generation', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('NO_NETWORK_IN_REAL_ASSET_RUNTIME') })
  const left = create(); await seed(left, true)
  const initialKnowledge = await readSyncKnowledgeDocuments(left.root)
  const right = await join(left)
  const joinedKnowledge=await readSyncKnowledgeDocuments(right.root)
  expect(joinedKnowledge[0].copy.availability).toBe('available')
  if(joinedKnowledge[0].copy.availability==='available')expect(joinedKnowledge[0].copy.content).toContain('仅存在于完整原文、没有进入分块的结尾。🙂')
  expect(hashSyncKnowledgeDocuments(await readSyncKnowledgeDocuments(right.root))).toBe(hashSyncKnowledgeDocuments(initialKnowledge))
  expect(pendingProjectAssets(right.db)).toEqual([])
  expect(fs.existsSync(path.join(right.root, 'prompts/draft.json'))).toBe(false)
  expect(fs.existsSync(path.join(right.root, 'skills/scene/example.md'))).toBe(false)
  const firstReplica = getProjectSyncEngine(right.db, right.projectId).status().replicaId
  expect(firstReplica).not.toBe(getProjectSyncEngine(left.db, left.projectId).status().replicaId)
  disposeProjectSyncEngine(right.db); right.db.close(); deactivateProjectData(right.project)
  await expect(readSyncKnowledgeDocuments(right.root)).rejects.toThrow('KNOWLEDGE_SYNC_SELECTION_GUARD_REQUIRED')
  const reopened = open(right.project, right.projectId)
  await recoverProjectAuthorAssets(reopened.context)
  expect(getProjectSyncEngine(reopened.db, reopened.projectId).status().replicaId).toBe(firstReplica)
  expect(hashSyncKnowledgeDocuments(await readSyncKnowledgeDocuments(reopened.root))).toBe(hashSyncKnowledgeDocuments(initialKnowledge))
  const snapshot = await captureGenerationKnowledge({ projectStorageRoot: reopened.root, query: '铜钥匙' })
  expect(snapshot.items.some(item => item.text.includes('base 铜钥匙线索'))).toBe(true)
  await verifyGenerationKnowledge({ projectStorageRoot: reopened.root, snapshot })
}, 90000)

it('resolves canonical knowledge conflicts while keeping prompts and Skills local and retiring the discarded CAS alternative', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('NO_NETWORK_IN_REAL_ASSET_RUNTIME') })
  const left = create(); await seed(left); const right = await join(left)
  for (const [replica, label] of [[left, 'left'], [right, 'right']] as const) {
    write(replica, label === 'left' ? 'prompts/draft.zh-CN.json' : 'prompts/draft.json', prompt(label, label === 'left'))
    write(replica, 'skills/scene/SKILL.md', `${label} complete Skill`); write(replica, 'skills/scene/example.md', `${label} complete example`)
    const content = `${label} 铜钥匙线索已重新索引。`
    const changed = await replaceDocumentChunks(replica.project, 'shared-doc', [content], { content, indexedHash: sha(content), edited: true, indexDirty: false })
    expect(changed.success).toBe(true)
    await prepareProjectAuthorAssets(replica.context)
    expect(pendingProjectAssets(replica.db)).toEqual([])
  }
  const leftEngine = getProjectSyncEngine(left.db, left.projectId), rightEngine = getProjectSyncEngine(right.db, right.projectId)
  const selected = captureProjectAssets(left.db), rightStore = new ProjectAssetBlobStore(right.root)
  const losingBytes = captureProjectAssets(right.db).flatMap(record => projectAssetBlobs(parseProjectAuthorAsset(record.value))).map(blob => ({ blob, bytes: rightStore.read(blob) }))
  const bundle = attachBundleAssets(leftEngine.exportBundle(), new ProjectAssetBlobStore(left.root))
  stageBundleAssets(bundle, rightStore)
  const preview = rightEngine.receive(bundle)
  expect(preview.conflicts).toHaveLength(1); expect(preview.conflicts.every(conflict => conflict.kind === 'project-asset')).toBe(true)
  const orphan = rightStore.put(Buffer.from('unreachable old temporary author bytes'))
  await prepareProjectAuthorAssets(right.context)
  expect(rightStore.contains(orphan)).toBe(false)
  // Automatic local collection runs before conflict resolution too, retaining
  // the adopted value and every unresolved received alternative.
  for (const record of losingBytes) expect(rightStore.read(record.blob)).toEqual(record.bytes)
  for (const record of selected) for (const blob of projectAssetBlobs(parseProjectAuthorAsset(record.value))) expect(rightStore.contains(blob)).toBe(true)
  const choices = preview.conflicts.map(conflict => {
    const wanted = selected.find(record => record.id === conflict.id)!
    const chosen = conflict.variants.find(variant => syncDigest(variant.value) === syncDigest(wanted.value))!
    expect(chosen).toBeDefined()
    return { kind: 'project-asset', id: conflict.id, expectedHeads: conflict.variants.map(variant => variant.revision), selectedRevision: chosen.revision }
  })
  const applied = await applyProjectAuthorSync(right.context, preview.token, choices)
  expect(applied.applied).toBe(true); expect(applied.assetsPending).not.toBe(true)
  expect(pendingProjectAssets(right.db)).toEqual([])
  expect(JSON.parse(fs.readFileSync(path.join(right.root, 'prompts/draft.json'), 'utf8')).content).toBe('right')
  expect(fs.existsSync(path.join(right.root, 'prompts/draft.zh-CN.json'))).toBe(false)
  const session = { projectPath: right.project, projectId: right.projectId, leaseId: 'synthetic-runtime-prompt-read' }
  const catalog = new PromptCatalog([], { ...ipcPromptPersistence, loadGlobal: async () => ({ templates: [], diagnostics: [] }),
    loadProject: async () => {
      const directory = path.join(right.root, 'prompts')
      assertProjectAssetFileAccess(right.root, directory)
      return { templates: fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
        const file = path.join(directory, name); assertProjectAssetFileAccess(right.root, file)
        return JSON.parse(fs.readFileSync(file, 'utf8')) as PromptTemplate
      }), diagnostics: [] }
    } }, () => session)
  expect((await catalog.resolve('draft', session, 'zh-CN'))?.template.content).toBe('right')
  expect(fs.readFileSync(path.join(right.root, 'skills/scene/SKILL.md'), 'utf8')).toBe('right complete Skill')
  expect(fs.readFileSync(path.join(right.root, 'skills/scene/example.md'), 'utf8')).toBe('right complete example')
  expect(hashSyncKnowledgeDocuments(await readSyncKnowledgeDocuments(right.root))).toBe(hashSyncKnowledgeDocuments(await readSyncKnowledgeDocuments(left.root)))
  for (const record of losingBytes) expect(rightStore.contains(record.blob)).toBe(false)
  const generation = await captureGenerationKnowledge({ projectStorageRoot: right.root, query: 'left 铜钥匙' })
  expect(generation.items.some(item => item.text.includes('left 铜钥匙线索'))).toBe(true)
  expect(generation.items.some(item => item.text.includes('right 铜钥匙线索'))).toBe(false)
  await verifyGenerationKnowledge({ projectStorageRoot: right.root, snapshot: generation })
}, 90000)

it('rolls back first local knowledge registration when SQLite rejects the catalog commit', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('NO_NETWORK_IN_REAL_ASSET_RUNTIME') })
  const replica = create(); await seed(replica)
  const original = await readSyncKnowledgeDocuments(replica.root)
  replica.db.exec("CREATE TRIGGER reject_asset_capture BEFORE INSERT ON project_author_assets BEGIN SELECT RAISE(ABORT,'INJECTED_BEFORE_CATALOG_COMMIT'); END")
  await expect(prepareProjectAuthorAssets(replica.context)).rejects.toThrow('INJECTED_BEFORE_CATALOG_COMMIT')
  expect(captureProjectAssets(replica.db)).toEqual([]); expect(pendingProjectAssets(replica.db)).toEqual([])
  expect(fs.existsSync(path.join(replica.root, 'knowledge-sync-projection.json'))).toBe(false)
  expect(hashSyncKnowledgeDocuments(await readSyncKnowledgeDocuments(replica.root))).toBe(hashSyncKnowledgeDocuments(original))
  replica.db.exec('DROP TRIGGER reject_asset_capture')
  await prepareProjectAuthorAssets(replica.context)
  expect(pendingProjectAssets(replica.db)).toEqual([])
  expect(hashSyncKnowledgeDocuments(await readSyncKnowledgeDocuments(replica.root))).toBe(hashSyncKnowledgeDocuments(original))
}, 90000)

it('recovers first local knowledge capture after the SQLite commit and before adopt publishes its pointer', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('NO_NETWORK_IN_REAL_ASSET_RUNTIME') })
  const replica = create(); await seed(replica)
  const original = await readSyncKnowledgeDocuments(replica.root)
  const actual = windowsSafeFileSystem.writeTextAtomically.bind(windowsSafeFileSystem)
  let interrupted = false
  vi.spyOn(windowsSafeFileSystem, 'writeTextAtomically').mockImplementation((capability, content, beforeReplace, constraints) => actual(capability, content, async () => {
    await beforeReplace?.()
    if (capability.relativePath.replaceAll('\\', '/').endsWith('knowledge-sync-projection.json') && !interrupted) {
      interrupted = true; throw new Error('INJECTED_AFTER_CATALOG_BEFORE_ADOPT')
    }
  }, constraints))
  await expect(prepareProjectAuthorAssets(replica.context)).rejects.toThrow('INJECTED_AFTER_CATALOG_BEFORE_ADOPT')
  expect(interrupted).toBe(true)
  expect(captureProjectAssets(replica.db).some(record => parseProjectAuthorAsset(record.value).category === 'knowledge')).toBe(true)
  expect(pendingProjectAssets(replica.db).some(item => item.selected?.category === 'knowledge')).toBe(true)
  await expect(readSyncKnowledgeDocuments(replica.root)).rejects.toThrow('KNOWLEDGE_SYNC_NOT_READY')
  vi.restoreAllMocks(); await recoverProjectAuthorAssets(replica.context)
  expect(pendingProjectAssets(replica.db)).toEqual([])
  expect(hashSyncKnowledgeDocuments(await readSyncKnowledgeDocuments(replica.root))).toBe(hashSyncKnowledgeDocuments(original))
}, 90000)

it('handles an initially empty corpus and propagates an all-document deletion to another actual replica', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('NO_NETWORK_IN_REAL_ASSET_RUNTIME') })
  const empty = create(); await prepareProjectAuthorAssets(empty.context)
  expect(await readSyncKnowledgeDocuments(empty.root)).toEqual([])
  expect((await captureGenerationKnowledge({ projectStorageRoot: empty.root, query: 'empty' })).items).toEqual([])
  const left = create(); await seed(left); const right = await join(left)
  expect(await removeDocument(left.project, 'shared-doc')).toBe(true)
  await prepareProjectAuthorAssets(left.context)
  expect(await readSyncKnowledgeDocuments(left.root)).toEqual([])
  expect(selectedKnowledgeAssetHash(left.db)).not.toBeNull()
  const leftEngine = getProjectSyncEngine(left.db, left.projectId), rightEngine = getProjectSyncEngine(right.db, right.projectId)
  const bundle = attachBundleAssets(leftEngine.exportBundle(), new ProjectAssetBlobStore(left.root))
  stageBundleAssets(bundle, new ProjectAssetBlobStore(right.root))
  const preview = rightEngine.receive(bundle); expect(preview.conflicts).toEqual([])
  const applied = await applyProjectAuthorSync(right.context, preview.token, [])
  expect(applied.applied).toBe(true); expect(applied.assetsPending).not.toBe(true)
  expect(pendingProjectAssets(right.db)).toEqual([]); expect(await readSyncKnowledgeDocuments(right.root)).toEqual([])
  expect((await captureGenerationKnowledge({ projectStorageRoot: right.root, query: '铜钥匙' })).items).toEqual([])
}, 90000)

it('transfers checkpoint author candidates without execution handles while retaining local raw bytes and accepting a remote successor', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('NO_NETWORK_IN_REAL_ASSET_RUNTIME') })
  const left = create()
  const handle = { projectId: left.projectId, epoch: 'left-device-private-epoch', rootActionId: 'left-private-root', runId: 'left-private-world-run' }
  const checkpoint = { premise_result: '作者前提原文\r\n第二行🌙', world_building_partial_result: '未审世界设定候选，保持作者原文。',
    world_building_incomplete: true, world_building_generation_handle: handle, world_building_facts_fingerprint: sha('frozen facts'),
    world_building_db_hash: sha('old author world'), world_building_step_guidance: '作者指定的创作范围',
    synopsis_protocol: PLOT_OUTLINE_PROTOCOL, synopsis_result: '第1至6章作者剧情候选。', synopsis_incomplete: true,
    synopsis_covered_to: 6, synopsis_range: { from: 7, to: 12 }, synopsis_db_hash: sha('author plot'), synopsis_body_hash: sha('plot candidate'),
    synopsis_generation_handle: { ...handle, runId: 'left-private-synopsis-run' },
    author_candidates: [{ chapter: 7, title: '候选章节', notes: ['不丢候选', '不改变范围和进度'] }] }
  const expected = { ...checkpoint } as Record<string, unknown>
  delete expected.world_building_generation_handle; delete expected.synopsis_generation_handle
  const originalBytes = Buffer.from(JSON.stringify(checkpoint, null, 4).replaceAll('\n', '\r\n') + '\r\n')
  write(left, 'partial_arch.json', originalBytes.toString())
  const unrelated = '其它文本保持CRLF\r\n和缩进\t🙂\r\n'
  write(left, 'skills/byte-proof/SKILL.md', unrelated)
  const store = await prepareProjectAuthorAssets(left.context), engine = getProjectSyncEngine(left.db, left.projectId)
  engine.enable()
  expect(fs.readFileSync(path.join(left.root, 'partial_arch.json'))).toEqual(originalBytes)
  expect(fs.existsSync(path.join(store.root, sha(originalBytes.toString())))).toBe(false)
  const stableBatchCount = left.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()
  await prepareProjectAuthorAssets(left.context)
  expect(left.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(stableBatchCount)
  const refreshedLocal = { ...checkpoint, world_building_generation_handle: { ...handle, runId: 'left-private-new-run' } }
  const refreshedBytes = Buffer.from(JSON.stringify(refreshedLocal, null, 3) + '\n')
  write(left, 'partial_arch.json', refreshedBytes.toString()); await prepareProjectAuthorAssets(left.context)
  expect(left.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(stableBatchCount)
  expect(fs.readFileSync(path.join(left.root, 'partial_arch.json'))).toEqual(refreshedBytes)
  const firstBundle = attachBundleAssets(engine.exportBundle(), store)
  expect(firstBundle.inlineBlobs?.some(blob => blob.sha256 === sha(originalBytes.toString()) || blob.sha256 === sha(refreshedBytes.toString()))).toBe(false)
  for (const inline of firstBundle.inlineBlobs ?? []) expect(Buffer.from(inline.base64, 'base64').toString()).not.toMatch(/left-private-(?:world|synopsis|new)-run/)
  const right = await join(left)
  expect(JSON.parse(fs.readFileSync(path.join(right.root, 'partial_arch.json'), 'utf8'))).toEqual(expected)
  expect(fs.existsSync(path.join(right.root, 'skills/byte-proof/SKILL.md'))).toBe(false)
  const remote = { ...expected, synopsis_result: '远端追加且由作者保存的新候选全文。', synopsis_covered_to: 8,
    synopsis_generation_handle: { ...handle, epoch: 'right-device-private-epoch', runId: 'right-private-run' } }
  const remoteBytes = Buffer.from(JSON.stringify(remote, null, 4) + '\r\n')
  write(right, 'partial_arch.json', remoteBytes.toString())
  const rightStore = await prepareProjectAuthorAssets(right.context), rightEngine = getProjectSyncEngine(right.db, right.projectId)
  expect(fs.readFileSync(path.join(right.root, 'partial_arch.json'))).toEqual(remoteBytes)
  const remoteBundle = attachBundleAssets(rightEngine.exportBundle(), rightStore)
  expect(remoteBundle.inlineBlobs?.some(blob => blob.sha256 === sha(remoteBytes.toString()))).toBe(false)
  for (const inline of remoteBundle.inlineBlobs ?? []) expect(Buffer.from(inline.base64, 'base64').toString()).not.toContain('right-private-run')
  stageBundleAssets(remoteBundle, store)
  const preview = engine.receive(remoteBundle); expect(preview.conflicts).toEqual([])
  const applied = await applyProjectAuthorSync(left.context, preview.token, [])
  expect(applied.applied).toBe(true); expect(applied.assetsPending).not.toBe(true)
  const received = JSON.parse(fs.readFileSync(path.join(left.root, 'partial_arch.json'), 'utf8'))
  const remoteAuthor = { ...remote } as Record<string, unknown>; delete remoteAuthor.synopsis_generation_handle
  expect(received).toEqual(remoteAuthor)
  expect(pendingProjectAssets(left.db)).toEqual([])
  const backups = fs.readdirSync(path.join(left.root, 'sync-assets/materialize-backups')).map(name => fs.readFileSync(path.join(left.root, 'sync-assets/materialize-backups', name)))
  expect(backups.some(bytes => bytes.equals(refreshedBytes))).toBe(true)
  expect(fs.existsSync(path.join(store.root, sha(originalBytes.toString())))).toBe(false)
  const afterApply = left.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()
  await prepareProjectAuthorAssets(left.context)
  expect(left.db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(afterApply)
}, 90000)
