/** Actual mobile backend aliases with native fs/SQLite/crypto protocol host; no network. */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createNativeMock } from '../test/mobile-native-mock.mjs'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, '.runtime/knowledge-sync-mobile-backend')
fs.mkdirSync(output, { recursive: true })
const run = fs.mkdtempSync(path.join(output, 'run-')), stages = []
// Windows sqlite3 cannot open a >260-character host filename. Keep only the
// synthetic native filesystem at a short sibling within the allowed workspace.
const nativeRoot = fs.mkdtempSync(path.join(path.dirname(root), 'kb-'))
let native = createNativeMock(nativeRoot, { virtualPaths: true }), release
const authority = new DatabaseSync(path.join(run, 'selected-manifest.sqlite'))
authority.exec('CREATE TABLE selected_manifest(hash TEXT); INSERT INTO selected_manifest VALUES(NULL)')
const originalPlatform = process.platform, previousBridge = globalThis.AndroidBridge, previousFetch = globalThis.fetch
let networkRequests = 0
async function stage(name, operation) {
  try { const details = await operation(); stages.push({ name, passed: true, ...details }) }
  catch (error) { stages.push({ name, passed: false, error: String(error.stack || error) }); throw error }
}
try {
  const aliases = Object.fromEntries(['fs', 'path', 'os', 'crypto', 'module', 'util', 'stream'].flatMap(name => [[name, name], [`node:${name}`, name]]))
  Object.assign(aliases, { 'node:fs/promises': 'fs-promises', 'fs/promises': 'fs-promises', 'node:child_process': 'child-process', child_process: 'child-process', electron: 'electron', 'better-sqlite3': 'sqlite', '@lancedb/lancedb': 'lancedb', yauzl: 'yauzl' })
  await build({ absWorkingDir: root, stdin: { contents: "export * from './electron/vector-store'; export * from './electron/services/generation-knowledge-source'; export * from './src/shared/project-sync-knowledge'; export * from './src/shared/model-settings-sync'; export { ModelSettingsStore } from './electron/services/model-settings-sync'; export { default as fs } from './mobile/shims/fs';", resolveDir: root },
    outfile: path.join(run, 'backend.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'es2022',
    banner: { js: "import {createRequire as __hostRequire} from 'node:module';const require=__hostRequire(import.meta.url);" },
    plugins: [{ name: 'actual-mobile-aliases', setup(builder) { builder.onResolve({ filter: /.*/ }, args => {
      if (args.path === 'stream' && args.importer.includes('node_modules')) return { path: 'node:stream', external: true }
      if (aliases[args.path]) return { path: path.join(root, 'mobile/shims', `${aliases[args.path]}.ts`) }
      if (args.path.endsWith('/security/windows-safe-file-system')) return { path: path.join(root, 'mobile/shims/secure-fs.ts') }
    }) } }] })
  Object.defineProperty(process, 'platform', { value: 'android', configurable: true })
  globalThis.AndroidBridge = { sync: payload => native.sync(payload), request() { throw new Error('UNEXPECTED_ASYNC_NATIVE_OR_NETWORK') } }
  globalThis.fetch = () => { networkRequests++; throw new Error('NO_NETWORK_IN_KNOWLEDGE_SYNC') }
  const api = await import(pathToFileURL(path.join(run, 'backend.mjs')).href)
  const storage = '/android/files/knowledge-project'; api.fs.mkdirSync(storage, { recursive: true })
  const liveSelection = () => authority.prepare('SELECT hash FROM selected_manifest').get().hash
  release = api.registerSyncKnowledgeReadGuard(storage, liveSelection)
  const hash = api.syncKnowledgeTextHash, empty = api.hashSyncKnowledgeDocuments([])
  const body = '完整原文\n\n铜钥匙藏在旧钟后面。🙂'
  const doc = { version: 1, docId: 'stable-document-id', fileName: '知识原文.md', corpusKind: 'project-knowledge', importedAt: '2026-10-21T08:00:00Z',
    logicalSource: { kind: 'legacy-unbound' }, chunks: [{ id: 'original-chunk-id', chunkIndex: 0, text: '铜钥匙藏在旧钟后面。',
      textHash: hash('铜钥匙藏在旧钟后面。'), importedAt: '2026-10-21T08:01:00Z', chapterNumber: 3, chapterTitle: '同章号只作展示' }],
    copy: { availability: 'available', content: body, contentHash: hash(body), indexedHash: hash(body), edited: false, indexDirty: false } }
  await stage('mobile-native-fs-sqlite-crypto-lossless-canonical-roundtrip-and-generation-retrieval', async () => {
    authority.prepare('UPDATE selected_manifest SET hash=?').run(hash('manifest-one'))
    await api.replaceSyncKnowledgeDocuments(storage, [doc], { expectedBeforeHash: empty, selectionHash: liveSelection() })
    assert.deepEqual(await api.readSyncKnowledgeDocuments(storage), [doc])
    const snapshot = await api.captureGenerationKnowledge({ projectStorageRoot: storage, query: '铜钥匙' })
    assert.equal(snapshot.items[0].chunkId, 'original-chunk-id'); assert.equal(snapshot.items[0].documentId, doc.docId)
    await api.verifyGenerationKnowledge({ projectStorageRoot: storage, snapshot })
    return { exactChunkIdentity: true, generationRetrieval: true, selectedAuthority: 'live SQLite row', embeddingRequests: 0 }
  })
  const next = { ...doc, docId: 'next-document-id', fileName: '后续资料.md', chunks: doc.chunks.map(chunk => ({ ...chunk, id: 'next-original-chunk-id' })) }
  await stage('pending-selection-fails-closed-and-native-host-reopen-replays-local-journal', async () => {
    const beforeRoot = api.resolveKnowledgeProjectionStorageRoot(storage)
    authority.prepare('UPDATE selected_manifest SET hash=?').run(hash('manifest-two'))
    await assert.rejects(api.replaceSyncKnowledgeDocuments(storage, [next], { expectedBeforeHash: api.hashSyncKnowledgeDocuments([doc]), selectionHash: liveSelection(),
      onPhase: phase => { if (phase === 'prepared') throw new Error('SYNTHETIC_PROCESS_STOP') } }), /SYNTHETIC_PROCESS_STOP/)
    await assert.rejects(api.readSyncKnowledgeDocuments(storage), /KNOWLEDGE_SYNC_NOT_READY/)
    release(); release = undefined; native.close(); native = createNativeMock(nativeRoot, { virtualPaths: true })
    release = api.registerSyncKnowledgeReadGuard(storage, liveSelection)
    assert.equal(await api.recoverSyncKnowledgeProjection(storage), true)
    assert.deepEqual(await api.readSyncKnowledgeDocuments(storage), [next])
    assert.equal(api.fs.existsSync(beforeRoot), true)
    return { oldGenerationRetained: true, pendingBlocksReaders: true, nativeHostReopened: true, actualAndroidProcessDeath: false }
  })
  await stage('same-gate-observed-manifest-adopt-and-portable-v1-read-current-projection', async () => {
    const physical = api.resolveKnowledgeProjectionStorageRoot(storage)
    await api.withSyncKnowledgeDocuments(storage, async (documents, canonicalHash, lease) => {
      assert.deepEqual(documents, [next]); authority.prepare('UPDATE selected_manifest SET hash=?').run(hash('manifest-local-observed'))
      await api.adoptSyncKnowledgeSelection(storage, { selectionHash: liveSelection(), expectedCanonicalHash: canonicalHash, lease })
    })
    assert.equal(api.resolveKnowledgeProjectionStorageRoot(storage), physical)
    assert.equal((await api.readPortableKnowledgeSnapshot(storage)).documents[0].docId, next.docId)
    assert.equal(networkRequests, 0)
    return { sameGateCaptureAndAdopt: true, portableCurrentProjection: true, networkRequests }
  })
  await stage('text-and-embedding-model-keys-and-defaults-import-through-actual-android-crypto-fs-and-reopen', async () => {
    const folder='/android/files/model-settings-fixture';api.fs.mkdirSync(folder,{recursive:true})
    const configFile=folder+'/config.json',modelsFile=folder+'/models.json'
    const localConfig={theme:'light',editorFontSize:16,editorFontFamily:'font',autoSaveInterval:30,defaultModelId:null,proxy:{enabled:false,type:'http',host:'',port:0}}
    api.fs.writeFileSync(configFile,JSON.stringify(localConfig));api.fs.writeFileSync(modelsFile,'[]')
    const store=()=>new api.ModelSettingsStore({readModels:()=>JSON.parse(api.fs.readFileSync(modelsFile,'utf8')),readConfig:()=>JSON.parse(api.fs.readFileSync(configFile,'utf8')),
      writeModels:value=>api.fs.writeFileSync(modelsFile,JSON.stringify(value)),updateConfig:update=>{api.fs.writeFileSync(configFile,JSON.stringify(update(JSON.parse(api.fs.readFileSync(configFile,'utf8')))));return true}})
    const text={id:'synthetic-text',name:'写作模型🙂',provider:'custom',protocol:'openai',modelName:'text-fixture',apiKey:'SYNTHETIC_MODEL_TRANSFER_KEY',baseUrl:'https://synthetic.invalid/v1',temperature:0.7,maxTokens:4096,purposes:['generation']}
    const embedding={...text,id:'synthetic-embedding',name:'向量模型',modelName:'embed-fixture',maxTokens:0,purposes:['embedding'],embeddingOptions:{chunkSize:800,chunkOverlap:100,batchSize:4}}
    const snapshot=api.parseModelSettingsSnapshot({format:'ai-novel-model-settings',version:1,models:[text,embedding],defaultModelId:text.id,defaultEmbeddingModelId:embedding.id,stageModelIds:{drafting:text.id}})
    const current=store();assert.equal(current.apply(api.decodeModelSettings(api.encodeModelSettings(snapshot)),current.capture().revision,()=>{}),2)
    native.close();native=createNativeMock(nativeRoot,{virtualPaths:true})
    const reopened=store().capture();assert.deepEqual(reopened.models,[text,embedding]);assert.equal(reopened.config.defaultModelId,text.id);assert.equal(reopened.config.defaultEmbeddingModelId,embedding.id)
    assert.deepEqual(reopened.config.stageModelIds,{drafting:text.id});assert.deepEqual(reopened.config.proxy,localConfig.proxy);assert.equal(networkRequests,0)
    const java=fs.readFileSync(path.join(root,'android/java/io/github/ethanyoq/ainovelwriter/NativeBridge.java'),'utf8')
    assert.ok(java.includes('同步包含项目知识原文'));assert.ok(!java.includes('同步包不含知识库原文'))
    return{modelsImported:2,keysAndDefaultsExact:true,proxyPreserved:true,nativeHostReopened:true,obsoleteNativeWarningRemoved:true,networkRequests}
  })
} catch (error) { process.exitCode = 1; console.error(error.stack || error) }
finally {
  release?.(); native.close(); authority.close()
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  if (previousBridge === undefined) delete globalThis.AndroidBridge; else globalThis.AndroidBridge = previousBridge
  globalThis.fetch = previousFetch
  const report = { passed: stages.length === 4 && stages.every(stage => stage.passed), target: 'actual bundled Android fs/SQLite/crypto/Lance aliases', deviceTest: false,
    networkRequests, stages, artifacts: run, syntheticNativeFilesystem: nativeRoot,
    backendSha256: fs.existsSync(path.join(run, 'backend.mjs')) ? createHash('sha256').update(fs.readFileSync(path.join(run, 'backend.mjs'))).digest('hex') : null }
  fs.writeFileSync(path.join(root, '.runtime/knowledge-sync-android-backend-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (!report.passed) process.exitCode = 1
}
