#!/usr/bin/env node
/** Full mobile backend integration using Android's exact JSON bridge protocol.
 * Run with Node >= 24. All controller/repository/service code is the release code.
 * Native boundaries use test/mobile-native-mock.mjs (real SQLite, fs and crypto).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createNativeMock } from '../test/mobile-native-mock.mjs'
import { readBuildFingerprint } from './test-build-fingerprint.mjs'
const root = path.resolve(import.meta.dirname, '..')
const buildFingerprint = readBuildFingerprint(root)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-android-backend-'))
let normalizeNextProjectOpen = false, platformNormalizedOpens = 0
const bridge = createNativeMock(sandbox, { virtualPaths: true, configureSqliteOpen(database, target, options) {
  if (normalizeNextProjectOpen && !options?.readonly && /[\\/]project\.db$/.test(target)) {
    normalizeNextProjectOpen = false; platformNormalizedOpens++
    // Emulate Android changing its own locale metadata while opening a handle.
    database.exec("UPDATE android_metadata SET locale='zh_CN'")
  }
} })
const httpPlans = [], httpCalls = [], canceledHttp = new Set()
const dialogSelections = []
const messageResponses = []
const googleNativeCalls = []
const nativeOperations = new Map()
const nativeQueries = new Map()
function nativeSync(json) {
  const request = JSON.parse(json)
  nativeOperations.set(request.op, (nativeOperations.get(request.op) ?? 0) + 1)
  if (process.env.MOBILE_PERF_ONLY && request.op === 'sqlite.query') nativeQueries.set(request.args[1], (nativeQueries.get(request.args[1]) ?? 0) + 1)
  if (request.op === 'http.cancel') { canceledHttp.add(request.args[0]); return JSON.stringify({ ok: true, value: null }) }
  return bridge.sync(json)
}
function nativeRequest(id, payload) {
  const { op, args } = JSON.parse(payload)
  if (op === 'dialog.message') {
    const response = messageResponses.shift()
    assert.notEqual(response, undefined, 'Unexpected confirmation dialog in isolated test')
    queueMicrotask(() => globalThis.__androidResolve?.(id, { ok: true, value: { response } }))
    return
  }
  if (op.startsWith('google.')) {
    googleNativeCalls.push({ operation: op, interactive: args?.[0]?.interactive })
    const result = op === 'google.status' ? { ok: true, value: { available: false } }
      : op === 'google.cancel' ? { ok: true, value: {} }
      : { ok: false, error: 'GOOGLE_PLAY_SERVICES_UNAVAILABLE', code: 'GOOGLE_PLAY_SERVICES_UNAVAILABLE' }
    queueMicrotask(() => globalThis.__androidResolve?.(id, result))
    return
  }
  if (op === 'dialog.open' || op === 'dialog.save') {
    const selected = dialogSelections.shift()
    if (!selected) throw new Error('Unexpected directory picker in isolated test')
    queueMicrotask(() => globalThis.__androidResolve?.(id, { ok: true, value: { canceled: false, filePaths: [selected], filePath: selected } }))
    return
  }
  if (op !== 'http.request') { queueMicrotask(() => globalThis.__androidResolve?.(id, JSON.parse(bridge.sync(payload)))); return }
  const plan = httpPlans.shift()
  if (!plan) throw new Error('Unexpected HTTP request in isolated backend test')
  const [url, options] = args
  httpCalls.push({ id, url, method: options.method, headers: options.headers, body: options.body ? JSON.parse(Buffer.from(options.body, 'base64').toString('utf8')) : null })
  queueMicrotask(() => {
    if (canceledHttp.has(id)) return
    globalThis.__androidEvent?.(id, 'headers', { status: plan.status || 200, statusText: '', headers: { 'content-type': plan.status ? 'application/json' : 'text/event-stream' }, url })
    const data = Buffer.from(plan.body, 'utf8')
    let offset = 0
    const pump = () => {
      if (canceledHttp.has(id)) return
      if (offset >= data.length) { if (!plan.pause) globalThis.__androidEvent?.(id, 'end', null); return }
      // Single-byte delivery deliberately cuts inside Chinese characters and emoji.
      globalThis.__androidEvent?.(id, 'data', data.subarray(offset, ++offset).toString('base64'))
      queueMicrotask(pump)
    }
    queueMicrotask(pump)
  })
}

const originalPlatform = process.platform
const isolatedEnvironment = ['LOCALAPPDATA', 'AI_NOVEL_APP_DATA_HOME', 'AI_NOVEL_LEGACY_SOURCE_HOME', 'AI_NOVEL_VELA_HOME']
const savedEnvironment = Object.fromEntries(isolatedEnvironment.map(key => [key, process.env[key]]))
const results = []
const started = Date.now()
const reportPath = process.env.ANDROID_TEST_REPORT || path.join(root, 'android-backend-test-report.json')
async function stage(name, action) {
  if (process.env.MOBILE_PERF_ONLY && !['bundle_actual_mobile_backend', 'start_and_register_all_controllers', 'create_and_open_project_with_database_migrations', 'close_cleanly'].includes(name)) return
  const before = Date.now()
  const operationsBefore = new Map(nativeOperations)
  try { const detail = await action(); results.push({ name, passed: true, durationMs: Date.now() - before, nativeOperations: Object.fromEntries([...nativeOperations].map(([key, count]) => [key, count - (operationsBefore.get(key) ?? 0)]).filter(([, count]) => count)), ...(detail === undefined ? {} : { detail }) }) }
  catch (error) { results.push({ name, passed: false, durationMs: Date.now() - before, error: error.stack || String(error) }); throw error }
}
const success = (value, label = 'operation') => { assert.equal(value?.success, true, `${label}: ${JSON.stringify(value)}`); return value }
let api, projectPath, context, draft, draft2, finalization, legacyFixture
const story = async (channel, input = {}) => success(await api.invoke(channel, { ...input, projectSession: context }), channel).data
async function createStoryFixture(prefix) {
  const node = (title, body, kind = 'content') => ({ id: randomUUID(), kind, title: prefix + title, chapterNumber: 1, event: body, body })
  const start = node('分叉', '共同起点', 'branch'), a = node('救人', '甲路线独有：找到钥匙且受伤'),
    b = node('追踪', '乙路线独有：丢失钥匙且健康'), merge = node('汇合', '大厅共用正文', 'merge')
  const routes = [{ id: randomUUID(), title: '甲路线', nodeIds: [start.id, a.id, merge.id] },
    { id: randomUUID(), title: '乙路线', nodeIds: [start.id, b.id, merge.id] }]
  const edges = [[start, a], [start, b], [a, merge], [b, merge]].map(([from, to]) => ({ id: randomUUID(), from: from.id, to: to.id, label: '', condition: '作者定义的自然语言走向' }))
  const before = await story('story:read')
  const snapshot = await story('story:commit', { expectedRevision: before.revision,
    operations: [...[start, a, b, merge].map(value => ({ type: 'put-node', node: value })),
      ...edges.map(edge => ({ type: 'put-edge', edge })), ...routes.map(route => ({ type: 'put-route', route }))] })
  return { start, a, b, merge, routes, edges, snapshot }
}
try {
  await stage('bundle_actual_mobile_backend', async () => {
    const aliases = Object.fromEntries(['fs', 'path', 'os', 'crypto', 'module', 'util', 'stream'].flatMap(name => [[name, name], [`node:${name}`, name]]))
    Object.assign(aliases, { 'node:fs/promises': 'fs-promises', 'fs/promises': 'fs-promises', 'node:child_process': 'child-process', 'child_process': 'child-process', electron: 'electron', 'better-sqlite3': 'sqlite', '@lancedb/lancedb': 'lancedb', yauzl: 'yauzl' })
    await build({ absWorkingDir: root, entryPoints: { backend: 'mobile/backend.ts', 'legacy-fixture': 'test/android-legacy-project-fixture.ts' }, outdir: sandbox, outExtension: { '.js': '.mjs' }, bundle: true, format: 'esm', platform: 'node', target: 'es2022',
      // CommonJS polyfills use Node's events/util in this protocol host. The
      // separate production-bundle browser test checks their browser variants.
      banner: { js: "import {createRequire as __hostRequire} from 'node:module';const require=__hostRequire(import.meta.url);" },
      plugins: [{ name: 'android-aliases', setup(build) { build.onResolve({ filter: /.*/ }, args => {
        // readable-stream's Node entry inherits from the host Stream base; do
        // not resolve that dependency back to its own browser facade.
        if (args.path === 'stream' && args.importer.includes('node_modules')) return { path: 'node:stream', external: true }
        if (args.path.endsWith('/services/google-drive-authorization')) return { path: path.join(root, 'mobile/shims/google-drive-authorization.ts') }
        if (aliases[args.path]) return { path: path.join(root, 'mobile/shims', `${aliases[args.path]}.ts`) }
        if (args.path.endsWith('/security/windows-safe-file-system')) return { path: path.join(root, 'mobile/shims/secure-fs.ts') }
      }) } }] })
  })
  await stage('sqlite_each_handle_matches_android_foreign_keys_default', async () => {
    for (let opened = 0; opened < 2; opened++) {
      const handle = bridge.dispatch('sqlite.open', [':memory:', {}])
      assert.deepEqual(bridge.dispatch('sqlite.query', [handle, 'PRAGMA foreign_keys', []]), [{ foreign_keys: 0 }])
      bridge.dispatch('sqlite.query', [handle, 'PRAGMA foreign_keys = ON', []])
      assert.deepEqual(bridge.dispatch('sqlite.query', [handle, 'PRAGMA foreign_keys', []]), [{ foreign_keys: 1 }])
      bridge.dispatch('sqlite.close', [handle])
    }
    return { eachNewHandleStartsWithForeignKeysOff: true, explicitEnableRequired: true, physicalDevice: false }
  })
  await stage('start_and_register_all_controllers', async () => {
    Object.defineProperty(process, 'platform', { value: 'android', configurable: true })
    for (const key of isolatedEnvironment) delete process.env[key]
    globalThis.window = new EventTarget()
    globalThis.document = Object.assign(new EventTarget(), { documentElement: { dataset: {} }, querySelector: () => null })
    globalThis.location = new URL('https://appassets.androidplatform.net/assets/index.html')
    globalThis.AndroidBridge = {
      sync: nativeSync, request: nativeRequest,
    }
    // Load the fixture first: the production backend must own the final bridge resolver.
    legacyFixture = await import(pathToFileURL(path.join(sandbox, 'legacy-fixture.mjs')))
    const backend = await import(pathToFileURL(path.join(sandbox, 'backend.mjs')))
    api = backend.startMobileBackend()
    assert.equal(typeof window.aiNovelAPI.invoke, 'function')
    assert.equal((await api.invoke('project:get-runtime-context')).activeProjectPath, null)
  })
  await stage('google_drive_unconfigured_android_capability', async () => {
    const requestsBefore = httpCalls.length
    const status = success(await api.invoke('drive:auth-status'))
    assert.deepEqual(status.auth, { platform: 'android', available: false, configured: false, authorized: false, persistence: 'google-play-services' })
    const configure = await api.invoke('drive:configure', { clientId: 'synthetic.apps.googleusercontent.com' })
    assert.equal(configure.success, false)
    assert.equal(configure.error, 'GOOGLE_ANDROID_CONSOLE_REQUIRED')
    const connect = await api.invoke('drive:connect')
    assert.equal(connect.success, false)
    assert.equal(connect.error, 'GOOGLE_PLAY_SERVICES_UNAVAILABLE')
    assert.equal(googleNativeCalls.find(call => call.operation === 'google.authorize')?.interactive, true)
    success(await api.invoke('drive:cancel-auth'))
    assert.equal(httpCalls.length, requestsBefore, 'An unconfigured Android capability check dispatched a model or OAuth network request')
    return { actualAndroidAuthorizationAdapter: true, simulatedGooglePlayAvailable: false, noAccountOrTokenFixture: true, networkRequests: 0 }
  })
  await stage('global_config_atomic_persistence', async () => {
    success(await api.invoke('config:set', { locale: 'zh-CN', theme: 'dark', defaultModelId: null }))
    const config = await api.invoke('config:get'); assert.equal(config.locale, 'zh-CN'); assert.equal(config.theme, 'dark')
    const canonical = path.posix.join(bridge.environment.filesDir, 'ai-novel-writer')
    const receipt = JSON.parse(fs.readFileSync(bridge.hostPath(path.posix.join(canonical, '.migration', 'receipt.json')), 'utf8'))
    assert.equal(JSON.parse(fs.readFileSync(bridge.hostPath(path.posix.join(canonical, 'generations', receipt.generation, 'config.json')), 'utf8')).theme, 'dark')
  })
  await stage('create_and_open_project_with_database_migrations', async () => {
    dialogSelections.push(bridge.environment.filesDir)
    const parent = await api.invoke('dialog:select-folder', 'project-create')
    const created = success(await api.invoke('project:create', { name: '安卓集成测试小说', parentGrantId: parent.grantId, genre: '奇幻', targetAudience: '一般读者', writingLanguage: 'zh-CN' }, 'create-1'), 'create')
    projectPath = created.projectPath
    const opened = success(await api.invoke('project:open', projectPath, 'open-1', null), 'open')
    const project = opened.project
    context = { projectId: project.id, leaseId: project.sessionLease, projectPath }
    assert.ok(context.leaseId)
    assert.equal((await api.invoke('db:project-core-get', projectPath, context)).projectName, '安卓集成测试小说')
    return { projectId: project.id, databaseReady: opened.dbReady }
  })
  const db = (channel, ...args) => api.invoke(channel, ...args, projectPath, context)
  await stage('android_locale_metadata_preserves_business_fingerprint_and_rejects_unknown_schema', async () => legacyFixture.verifyPlatformMetadataContract())
  await stage('legacy_copy_import_then_open_preserves_finalized_source', async () => {
    const originalPath = projectPath, originalContext = context
    const legacy = legacyFixture.createLegacyProject(path.posix.join(bridge.environment.filesDir, '旧格式来源'))
    const tree = directory => fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const file = path.join(directory, entry.name)
      return entry.isDirectory() ? tree(file) : [[path.relative(bridge.hostPath(legacy.root), file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]]
    })
    const before = tree(bridge.hostPath(legacy.root))
    dialogSelections.push(legacy.root)
    const sourceGrant = await api.invoke('dialog:select-legacy-project')
    dialogSelections.push(bridge.environment.filesDir)
    const targetGrant = await api.invoke('dialog:select-project-restore-target', '旧项目独立副本')
    messageResponses.push(1)
    const imported = await api.invoke('project:import-legacy-copy', sourceGrant.grantId, targetGrant.grantId)
    assert.equal(imported.state, 'ready', JSON.stringify(imported))
    assert.deepEqual(tree(bridge.hostPath(legacy.root)), before, 'Legacy source file bytes changed during copy import')
    const opened = success(await api.invoke('project:open', imported.targetRoot, 'legacy-copy-open'))
    const importedSession = { projectId: opened.project.id, leaseId: opened.project.sessionLease, projectPath: imported.targetRoot }
    for (const chapter of legacy.chapters) {
      const versions = await api.invoke('db:draft-list', chapter.chapterNumber, imported.targetRoot, importedSession)
      assert.equal(versions.length, 1)
      assert.equal(versions[0].status, 'finalized')
      const draft = await api.invoke('db:draft-get-full', versions[0].id, imported.targetRoot, importedSession)
      assert.equal(draft.content, chapter.content)
    }
    assert.deepEqual(await api.invoke('db:blueprint-get-all', imported.targetRoot, importedSession), [])
    success(await api.invoke('db:close', imported.targetRoot, importedSession))
    const reopened = success(await api.invoke('project:open', originalPath, 'return-after-legacy-import'))
    projectPath = originalPath
    context = { ...originalContext, leaseId: reopened.project.sessionLease }
    assert.deepEqual(tree(bridge.hostPath(legacy.root)), before)
    return { syntheticLegacySchema: 0, importedFinalizedChapters: 2, noInventedBlueprints: true, legacySourceFilesUnchanged: before.length, freshHandleOpens: true }
  })
  await stage('core_settings_character_roster_and_blueprint', async () => {
    success(await db('db:project-core-update', { totalChapters: 3, synopsis: '旅人寻找失落的灯塔。' }))
    assert.equal((await db('db:project-core-get')).totalChapters, 3)
    const before = await db('db:character-roster-read')
    success(await db('db:character-roster-commit', { operationId: 'android-roster-1', expectedRevision: before.revision, expectedIdentityRevision: before.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries: [{ characterId: 'draft:048fb4e5-a82d-4160-a2c5-ed9b654fbdf3', name: '林舟', role: 'protagonist', gender: '男', age: '25', appearance: '黑发', personality: '谨慎', background: '航海员', abilities: '导航', motivation: '寻找灯塔', relationships: [], arc: '学会信任', notes: '' }] }))
    assert.equal((await db('db:character-get-all'))[0].name, '林舟')
    success(await db('db:blueprint-upsert', { chapterNumber: 1, title: '启航', role: '开端', purpose: '开启旅程', keyEvents: '发现旧地图', characters: ['林舟'], suspenseHook: '灯塔在哪里', userGuidance: '', notes: '海风', notesUpdatedAt: '' }))
    assert.equal((await db('db:blueprint-get', 1)).title, '启航')
  })
  await stage('draft_versions_reviews_revisions_and_atomic_merge', async () => {
    const content = '林舟站在港口，展开了那张泛黄的地图。海风带来遥远灯塔的呼唤。'
    const created = success(await db('db:draft-create', { chapterNumber: 1, version: 1, source: 'write', content, wordCount: content.length }))
    draft = await db('db:draft-get-full', created.id)
    const next = await db('db:draft-next-version', 1); assert.equal(next, 2)
    const second = success(await db('db:draft-create', { chapterNumber: 1, version: 2, source: 'rewrite', content: content + '他迈向了渡船。', wordCount: content.length + 8 }))
    draft2 = await db('db:draft-get-full', second.id)
    assert.equal((await db('db:draft-list', 1)).length, 2)
    const expectedSource = { id: draft.id, chapterNumber: 1, version: 1, status: draft.status, content: draft.content }
    const review = success(await db('db:review-create', { baseDraftId: draft.id, content: '建议强化海风的感官描写。', expectedSource }))
    assert.equal((await db('db:review-get-full', review.id)).content, '建议强化海风的感官描写。')
    const revised = content + '咸涩的海风掠过他的额头。'
    const revision = success(await db('db:revision-create', { baseDraftId: draft.id, revisionType: 'review-fix', reviewSourceId: review.id, content: revised, wordCount: revised.length, expectedSource }))
    const mergeRequest = { revisionId: revision.id, targetDraftId: draft.id, expectedDraftContent: content, mergedContent: revised, wordCount: revised.length }
    success(await db('db:revision-merge', mergeRequest))
    const again = success(await db('db:revision-merge', mergeRequest)); assert.equal(again.receipt.idempotent, true)
    draft = await db('db:draft-get-full', draft.id); assert.equal(draft.content, revised); assert.equal(draft.status, 'revised')
    const stale = await db('db:revision-create', { baseDraftId: draft.id, revisionType: 'refine', content: '旧源稿改写', wordCount: 5, expectedSource })
    assert.equal(stale.success, false); assert.equal(stale.errorCode, 'SOURCE_DRAFT_CHANGED')
  })
  await stage('finalize_immutable_snapshot_and_publish_manuscript', async () => {
    finalization = success(await api.invoke('finalization:commit', { tabId: 'test-draft', projectPath, projectSession: context, draftId: draft.id, chapterNumber: 1, chapterTitle: '启航', content: draft.content, contentRevision: 1 }, context))
    assert.equal(finalization.committed, true)
    assert.equal((await db('db:draft-get-full', draft.id)).status, 'finalized')
    assert.equal((await db('db:draft-update-content', draft.id, '非法替换', 4)).success, false)
    const exported = await db('db:draft-export-snapshot'); assert.equal(exported.length, 1)
    const manuscripts = fs.readdirSync(bridge.hostPath(projectPath)).filter(name => name.endsWith('.txt'))
    assert.equal(manuscripts.length, 1); assert.ok(fs.readFileSync(bridge.hostPath(path.posix.join(projectPath, manuscripts[0])), 'utf8').includes(draft.content))
    return { publicationStatus: finalization.publicationStatus, manuscripts }
  })
  await stage('knowledge_import_persistence_and_fulltext_search', async () => {
    const imported = success(await db('kb:import-text', 'The lighthouse keeper protects the hidden harbor. The map describes a lighthouse on the eastern island.', '灯塔设定.txt'))
    const documents = await db('kb:list-documents'); assert.ok(documents.some(document => document.id === imported.docId))
    const searched = await db('kb:search', 'lighthouse', 5)
    const matches = Array.isArray(searched) ? searched : searched.data
    assert.ok(matches?.length, JSON.stringify(searched)); assert.ok(matches.some(match => /lighthouse/i.test(match.text)))
    return { chunkCount: imported.chunkCount, searchMatches: matches.length }
  })
  await stage('secure_files_atomic_export_and_project_boundary', async () => {
    const target = path.posix.join(projectPath, '测试导出.md')
    success(await api.invoke('fs:write-file', target, '# 手机端导出\n中文正文。', projectPath, context))
    const read = success(await api.invoke('fs:read-file', target, projectPath, context)); assert.equal(read.content, '# 手机端导出\n中文正文。')
    const outside = path.posix.join(bridge.environment.filesDir, 'outside.txt')
    const denied = await api.invoke('fs:write-file', outside, '不允许', projectPath, context)
    assert.equal(denied.success, false); assert.equal(fs.existsSync(bridge.hostPath(outside)), false)
  })
  await stage('close_reopen_preserves_data_and_revokes_old_session', async () => {
    const oldContext = { ...context }
    success(await db('db:close'))
    const reopened = success(await api.invoke('project:open', projectPath, 'open-2', null))
    context = { projectId: reopened.project.id, leaseId: reopened.project.sessionLease, projectPath }
    assert.notEqual(context.leaseId, oldContext.leaseId)
    assert.equal((await db('db:draft-get-full', draft.id)).content, draft.content)
    assert.equal((await db('db:draft-get-full', draft2.id)).content, draft2.content)
    assert.equal((await db('db:character-get-all'))[0].name, '林舟')
    const stale = await api.invoke('db:project-core-update', { totalChapters: 99 }, projectPath, oldContext)
    assert.equal(stale.success, false); assert.equal((await db('db:project-core-get')).totalChapters, 3)
    const documents = await db('kb:list-documents'); assert.equal(documents.length, 1)
    success(await api.invoke('finalization:retry', finalization.finalizationId, context))
  })
  await stage('v140_native_verified_project_open_accepts_platform_metadata_changes', async () => {
    const oldContext = { ...context }
    success(await db('db:close'))
    normalizeNextProjectOpen = true
    const reopened = success(await api.invoke('project:open', projectPath, 'platform-normalized-open', null))
    context = { projectId: reopened.project.id, leaseId: reopened.project.sessionLease, projectPath }
    assert.equal(normalizeNextProjectOpen, false)
    assert.equal(platformNormalizedOpens, 1)
    assert.notEqual(context.leaseId, oldContext.leaseId)
    assert.equal((await db('db:draft-get-full', draft.id)).content, draft.content)
    assert.equal((await db('db:draft-get-full', draft2.id)).content, draft2.content)
    return { actualBackendAndSchemaGate: true, simulatedAndroidLocaleChangeDuringOpen: true, authorBodiesPreserved: true, deviceTest: false }
  })
  await stage('sqlite_nested_transactions_and_rollback_through_bridge', async () => {
    const sqlPath = path.posix.join(bridge.environment.filesDir, 'transaction-check.sqlite')
    const id = bridge.dispatch('sqlite.open', [sqlPath, {}])
    bridge.dispatch('sqlite.exec', [id, 'CREATE TABLE t(id INTEGER); BEGIN; INSERT INTO t VALUES(1); SAVEPOINT nested; INSERT INTO t VALUES(2); ROLLBACK TO nested; RELEASE nested; COMMIT;'])
    assert.deepEqual(bridge.dispatch('sqlite.query', [id, 'SELECT id FROM t', []]), [{ id: 1 }])
    bridge.dispatch('sqlite.close', [id])
  })
  await stage('portable_archive_roundtrip_new_identity_and_single_use_grants', async () => {
    const sourcePath = projectPath
    const sourceId = context.projectId
    const archivePath = path.posix.join(bridge.environment.filesDir, '手机完整备份.ainovel')
    dialogSelections.push(archivePath)
    const exportGrant = await api.invoke('dialog:select-project-archive-export', '手机完整备份')
    const exportRequest = { targetArchiveGrantId: exportGrant.grantId, projectSession: context }
    const exported = success(await api.invoke('project:archive-export', exportRequest), 'archive export')
    assert.ok(exported.receipt.targetByteSize > 0)
    const repeated = await api.invoke('project:archive-export', exportRequest)
    assert.equal(repeated.success, false)
    assert.equal(repeated.errorCode, 'PORTABLE_GRANT_INVALID')
    dialogSelections.push(archivePath)
    const archiveGrant = await api.invoke('dialog:select-project-archive')
    dialogSelections.push(bridge.environment.filesDir)
    const targetGrant = await api.invoke('dialog:select-project-restore-target', '手机恢复副本')
    const restored = success(await api.invoke('project:archive-restore', { archiveGrantId: archiveGrant.grantId, targetGrantId: targetGrant.grantId }), 'archive restore')
    assert.notEqual(restored.receipt.targetProjectId, sourceId)
    const opened = success(await api.invoke('project:open', restored.receipt.targetProjectRoot, 'restored-open'))
    projectPath = opened.project.path
    context = { projectId: opened.project.id, leaseId: opened.project.sessionLease, projectPath }
    assert.equal((await db('db:draft-get-full', draft.id)).content, draft.content)
    assert.equal((await db('db:draft-get-full', draft2.id)).content, draft2.content)
    assert.equal((await db('db:character-get-all'))[0].name, '林舟')
    assert.equal((await db('kb:list-documents')).length, 1)
    const source = success(await api.invoke('project:open', sourcePath, 'source-reopen'))
    projectPath = source.project.path
    context = { projectId: source.project.id, leaseId: source.project.sessionLease, projectPath }
    assert.equal(context.projectId, sourceId)
    assert.equal((await db('db:draft-get-full', draft.id)).content, draft.content)
    return { newIdentity: true, originalPreserved: true, archiveBytes: exported.receipt.targetByteSize }
  })

  const model = protocol => ({ id: `test-${protocol}`, name: `Test ${protocol}`, provider: protocol, protocol, modelName: 'test-generation-model', apiKey: 'test-only-not-a-real-key', baseUrl: protocol === 'openai' ? 'https://mock-api.invalid/v1' : 'https://mock-gemini.invalid', temperature: 0.7, maxTokens: 1024, purposes: ['generation'] })
  const sse = data => `data: ${JSON.stringify(data)}\n\n`
  async function collectStream(protocol, plan, options = {}) {
    const id = `test-stream-${protocol}-${httpCalls.length}`
    httpPlans.push(plan)
    const chunks = [], cancelResults = []
    let resolveTerminal, rejectTerminal
    const terminal = new Promise((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject })
    const timer = setTimeout(() => rejectTerminal(new Error('Timed out waiting for stream termination')), 5000)
    const off = [
      api.on('llm:stream-chunk', event => { if (event.requestId !== id) return; chunks.push(event.chunk); if (options.cancelAfterChunk && chunks.length === 1) cancelResults.push(api.invoke('llm:cancel', id)) }),
      api.on('llm:stream-done', event => { if (event.requestId === id) resolveTerminal({ kind: 'done', ...event }) }),
      api.on('llm:stream-error', event => { if (event.requestId === id) resolveTerminal({ kind: 'error', ...event }) }),
    ]
    try {
      const response = await api.invoke('llm:generate-stream', id, { modelId: model(protocol).id, projectSession: context, messages: [{ role: 'system', content: '你是小说写作助手。' }, { role: 'user', content: '描写海边灯塔。' }] })
      assert.equal(response.started, true, JSON.stringify(response))
      const outcome = await terminal
      for (const promise of cancelResults) success(await promise, 'cancel')
      return { outcome, chunks, request: httpCalls.at(-1) }
    } finally { clearTimeout(timer); off.forEach(dispose => dispose()) }
  }
  await stage('openai_and_gemini_native_stream_utf8_framing', async () => {
    for (const protocol of ['openai', 'gemini']) success(await api.invoke('llm:save-model', model(protocol)))
    const expected = '海风吹过🌊灯塔。'
    const openai = await collectStream('openai', { body: sse({ choices: [{ delta: { content: '海风吹过🌊' }, finish_reason: null }] }) + sse({ choices: [{ delta: { content: '灯塔。' }, finish_reason: 'stop' }] }) + sse({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 } }) + 'data: [DONE]\n\n' })
    assert.equal(openai.outcome.kind, 'done'); assert.equal(openai.outcome.finishReason, 'stop'); assert.equal(openai.outcome.fullText, expected)
    assert.equal(openai.chunks.join(''), expected); assert.equal(openai.outcome.usage.totalTokens, 16)
    assert.match(openai.request.url, /\/v1\/chat\/completions$/); assert.equal(openai.request.headers.authorization, 'Bearer test-only-not-a-real-key')
    assert.equal(openai.request.body.messages[1].content, '描写海边灯塔。')
    const gemini = await collectStream('gemini', { body: sse({ candidates: [{ content: { parts: [{ text: '海风吹过🌊' }] } }] }) + sse({ candidates: [{ content: { parts: [{ text: '灯塔。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 9, totalTokenCount: 16 } }) })
    assert.equal(gemini.outcome.kind, 'done'); assert.equal(gemini.outcome.finishReason, 'stop'); assert.equal(gemini.outcome.fullText, expected)
    assert.equal(gemini.chunks.join(''), expected); assert.equal(gemini.outcome.usage.totalTokens, 16)
    assert.match(gemini.request.url, /:streamGenerateContent\?alt=sse$/); assert.equal(gemini.request.headers['x-goog-api-key'], 'test-only-not-a-real-key')
    assert.equal(gemini.request.body.systemInstruction.parts[0].text, '你是小说写作助手。')
    return { protocols: 2, byteChunkSize: 1, text: expected }
  })
  await stage('v140_stage_models_persist_and_survive_unrelated_config_saves', async () => {
    const requestsBefore = httpCalls.length
    const id = 'android-stage-writer'
    success(await api.invoke('llm:save-model', { ...model('openai'), id, name: 'Android stage writer' }))
    success(await api.invoke('llm:set-stage-model', { stage: 'drafting', modelId: id }))
    assert.deepEqual(await api.invoke('llm:get-stage-models'), { drafting: id })
    success(await api.invoke('config:set', { theme: 'dark', stageModelIds: { drafting: 'test-gemini' } }))
    assert.deepEqual(await api.invoke('llm:get-stage-models'), { drafting: id })
    assert.equal((await api.invoke('llm:set-stage-model', { stage: 'review', modelId: 'missing-model' })).success, false)
    assert.deepEqual(await api.invoke('llm:get-stage-models'), { drafting: id })
    success(await api.invoke('llm:delete-model', id))
    assert.deepEqual(await api.invoke('llm:get-stage-models'), {})
    assert.equal(httpCalls.length, requestsBefore)
    return { nativeBridge: true, blindConfigMergeProtected: true, deletedModelAssignmentsCleared: true, networkRequests: 0 }
  })
  await stage('openai_and_gemini_http_errors', async () => {
    for (const protocol of ['openai', 'gemini']) {
      const result = await collectStream(protocol, { status: 401, body: JSON.stringify({ error: { message: '测试鉴权错误' } }) })
      assert.equal(result.outcome.kind, 'error'); assert.equal(result.outcome.error, 'LLM_REQUEST_FAILED')
      // Both 1.4 providers expose a stable code and keep raw provider bodies private.
      assert.ok(!JSON.stringify(result.outcome).includes('测试鉴权错误'))
      assert.equal(result.chunks.length, 0)
    }
  })
  await stage('openai_and_gemini_abort_native_connection', async () => {
    for (const protocol of ['openai', 'gemini']) {
      const body = protocol === 'openai' ? sse({ choices: [{ delta: { content: '保留已生成正文。' }, finish_reason: null }] }) : sse({ candidates: [{ content: { parts: [{ text: '保留已生成正文。' }] } }] })
      const result = await collectStream(protocol, { body, pause: true }, { cancelAfterChunk: true })
      assert.deepEqual(result.chunks, ['保留已生成正文。'])
      assert.ok(canceledHttp.has(result.request.id), 'AbortSignal must reach native http.cancel')
      assert.notEqual(result.outcome.finishReason, 'stop')
      // A late native callback after cancellation must not deliver another chunk.
      globalThis.__androidEvent(result.request.id, 'data', Buffer.from(body).toString('base64'))
      await Promise.resolve()
      assert.deepEqual(result.chunks, ['保留已生成正文。'])
    }
    assert.equal(httpPlans.length, 0)
    return { nativeConnectionsCanceled: canceledHttp.size }
  })
  await stage('project_identity_and_isolation', async () => {
    const savedProjectPath = projectPath
    const projects = []
    const distinctNames = originalPlatform === 'win32' ? ['CaseBook-A', 'casebook-B'] : ['CaseBook', 'casebook']
    for (const [index, name] of distinctNames.entries()) {
      dialogSelections.push(bridge.environment.filesDir)
      const parent = await api.invoke('dialog:select-folder', 'project-create')
      const created = success(await api.invoke('project:create', { name, parentGrantId: parent.grantId, genre: '奇幻', targetAudience: '一般读者', writingLanguage: 'zh-CN' }, `case-create-${index}`))
      const opened = success(await api.invoke('project:open', created.projectPath, `case-open-${index}`, projectPath))
      projectPath = opened.project.path
      context = { projectId: opened.project.id, leaseId: opened.project.sessionLease, projectPath }
      success(await db('db:project-core-update', { totalChapters: index + 17, synopsis: `${name} independent content` }))
      projects.push({ projectPath, context: { ...context }, name, totalChapters: index + 17 })
    }
    const [upper, lower] = projects
    assert.notEqual(upper.context.projectId, lower.context.projectId)
    const recents = await api.invoke('project:recent-list')
    assert.ok(recents.some(project => project.path === upper.projectPath))
    assert.ok(recents.some(project => project.path === lower.projectPath))
    const forgedContext = { ...context, projectPath: upper.projectPath }
    assert.equal((await api.invoke('db:project-core-update', { totalChapters: 999 }, projectPath, forgedContext)).success, false, 'Case-only root changes must not reuse the active lease')
    assert.equal((await api.invoke('db:project-core-update', { totalChapters: 999 }, upper.projectPath, context)).success, false, 'Case-only expected path mismatch must fail')
    for (const project of projects) {
      const opened = success(await api.invoke('project:open', project.projectPath, `case-reopen-${project.name}`, projectPath))
      projectPath = opened.project.path
      context = { projectId: opened.project.id, leaseId: opened.project.sessionLease, projectPath }
      const core = await db('db:project-core-get')
      assert.equal(core.totalChapters, project.totalChapters)
      assert.equal(core.synopsis, `${project.name} independent content`)
    }
    const restored = success(await api.invoke('project:open', savedProjectPath, 'case-restore-main', projectPath))
    projectPath = restored.project.path
    context = { projectId: restored.project.id, leaseId: restored.project.sessionLease, projectPath }
    return { distinctNames, caseSensitiveFilesystemTested: originalPlatform !== 'win32', recentEntriesPreserved: true, crossProjectWritesRejected: true }
  })
  await stage('story_routes_merge_continuity_confirmation_cas_and_reopen', async () => {
    const graph = await createStoryFixture('安卓剧情')
    const requestA = { nodeId: graph.merge.id, routeId: graph.routes[0].id, mode: 'route' }
    const requestB = { nodeId: graph.merge.id, routeId: graph.routes[1].id, mode: 'route' }
    const a = await story('story:context', requestA), b = await story('story:context', requestB)
    assert.ok(JSON.stringify(a).includes('甲路线独有'))
    assert.equal(JSON.stringify(a).includes('乙路线独有'), false)
    assert.ok(JSON.stringify(b).includes('乙路线独有'))
    assert.equal(JSON.stringify(b).includes('甲路线独有'), false)
    assert.equal(a.readyForGeneration, false, 'A route-specific view cannot authorize writing prose shared with the other route')
    const sharedRequest = { nodeId: graph.merge.id, routeId: null, mode: 'shared' }
    const shared = await story('story:context', sharedRequest)
    assert.equal(shared.readyForGeneration, false)
    assert.deepEqual(shared.prefix.map(node => node.id), [graph.start.id])
    assert.equal(JSON.stringify(shared).includes('甲路线独有'), false)
    assert.equal(JSON.stringify(shared).includes('乙路线独有'), false)
    const note = { id: randomUUID(), nodeId: graph.merge.id, routeId: null, summary: '作者确认双方都已抵达大厅。',
      characterStates: '仅共用身份基础设定，伤势与持物按入口保留差异。', entryDifferences: '甲路线有钥匙且受伤，乙路线无钥匙且健康。' }
    let snapshot = await story('story:commit', { expectedRevision: graph.snapshot.revision,
      operations: [{ type: 'put-note', note, expectedSourceHash: shared.sourceHash, confirm: true }] })
    assert.equal((await story('story:context', sharedRequest)).readyForGeneration, true)
    const stale = await api.invoke('story:commit', { projectSession: context, expectedRevision: graph.snapshot.revision,
      operations: [{ type: 'put-node', node: { ...graph.a, body: '过期写入' } }] })
    assert.deepEqual(stale, { success: false, error: 'STORY_REVISION_STALE' })
    snapshot = await story('story:commit', { expectedRevision: snapshot.revision,
      operations: [{ type: 'put-node', node: { ...graph.a, body: '甲路线前情由作者离线改写' } }] })
    const invalidated = await story('story:context', sharedRequest)
    assert.equal(invalidated.noteCurrent, false)
    assert.equal(invalidated.readyForGeneration, false)
    assert.equal(invalidated.note.summary, note.summary, 'Stale author notes remain readable')
    const oldContext = context
    const reopened = success(await api.invoke('project:open', projectPath, 'story-reopen', projectPath))
    context = { projectId: reopened.project.id, leaseId: reopened.project.sessionLease, projectPath }
    assert.notEqual(context.leaseId, oldContext.leaseId)
    assert.deepEqual(await story('story:read'), snapshot)
    assert.deepEqual(await api.invoke('story:read', { projectSession: oldContext }), { success: false, error: 'STORY_SESSION_STALE' })
    return { routes: 2, isolatedContinuity: true, explicitCommonConfirmation: true, staleCommonNotePreserved: true,
      casRejected: true, persistedImmutableVersions: snapshot.revisions.length, reopenedWithNewLease: true }
  })

  let chapterBranch, insertedChapter, chapterMainlineBefore, savedChapterBlueprint, bridgeRequest, childInput
  const mainlineFacts = async () => {
    const drafts = await db('db:draft-list-all')
    return { blueprints: await db('db:blueprint-get-all'),
      drafts: await Promise.all(drafts.map(draft => db('db:draft-get-full', draft.id))),
      authoritativeFinals: await db('db:draft-export-snapshot') }
  }
  const agent = (channel, input) => api.invoke(channel, input, context)
  const chapterAgentInput = request => ({ mode: 'fast', uiLocale: 'zh-CN', historyMessages: [],
    userMessage: '按照已保存的分支章节蓝图生成正文，兼顾作者指定的前后文，仅提出当前节点 body 修改，等待作者批准。',
    storyContext: request, tools: [
      { name: 'read_story_context', description: 'Read the author-selected earlier path and optional future bridge.',
        inputSchema: { type: 'object', properties: { node_id: { type: 'string' }, route_id: { type: 'string' }, mode: { type: 'string' }, bridge_to_node_id: { type: 'string' } }, required: ['node_id', 'mode'] },
        requiresConfirmation: false, isReadOnly: true, source: 'builtin' },
      { name: 'propose_story_changes', description: 'Propose a story chapter change for author approval.',
        inputSchema: { type: 'object', properties: { operations: { type: 'array' } }, required: ['operations'] },
        requiresConfirmation: true, isReadOnly: false, source: 'builtin' },
    ] })
  await stage('story_chapter_fork_reads_live_mainline_prefix_and_saves_independent_blueprint', async () => {
    for (const [chapterNumber, title, content] of [[2, '主线后文第二章', '主线未来第二章：林舟到达灯塔，守塔人递给他一枚银铃。'],
      [3, '未指定的第三章', '未指定未来第三章：旅人发现地下宝库。']]) {
      success(await db('db:blueprint-upsert', { chapterNumber, title, role: '发展', purpose: `主线章节${chapterNumber}的目的`,
        keyEvents: `主线章节${chapterNumber}的计划`, characters: ['林舟'], suspenseHook: '未来悬念', userGuidance: '', notes: '', notesUpdatedAt: '' }))
      success(await db('db:draft-create', { chapterNumber, source: 'write', content, wordCount: content.length }))
    }
    const inspectStorage = () => {
      const id = bridge.dispatch('sqlite.open', [path.posix.join(projectPath, '.ai-novel', 'project.db'), { readonly: true }])
      try { return { schemaVersion: bridge.dispatch('sqlite.query', [id, 'PRAGMA user_version', []])[0].user_version,
        nodes: bridge.dispatch('sqlite.query', [id, 'SELECT id,payload_json FROM story_nodes ORDER BY id', []]),
        revisions: bridge.dispatch('sqlite.query', [id, 'SELECT id,payload_json FROM story_node_revisions ORDER BY id', []]) } }
      finally { bridge.dispatch('sqlite.close', [id]) }
    }
    const storageBeforeRead = inspectStorage()
    assert.equal(storageBeforeRead.schemaVersion, 11, 'The mobile JSON/SQLite bridge must install the schema-11 format gate')
    const sourceBlueprint = await db('db:blueprint-get', 1)
    success(await db('db:blueprint-delete', 1))
    const imported = await story('story:read'), importedSource = imported.nodes.find(node => node.id === 'chapter:1')
    assert.equal(importedSource.chapterBlueprint, undefined, 'Imported manuscript must remain visible without inventing a blueprint')
    assert.equal(importedSource.body, draft.content)
    assert.deepEqual(importedSource.mainline, { chapterNumber: 1, manuscriptStatus: 'finalized', hasBlueprint: false, hasManuscript: true })
    assert.deepEqual((await story('story:read')).nodes.find(node => node.id === 'chapter:1'), importedSource)
    success(await db('db:blueprint-upsert', sourceBlueprint))
    assert.equal((await story('story:read')).nodes.find(node => node.id === 'chapter:1').id, importedSource.id, 'Restoring its blueprint keeps the imported chapter identity')
    assert.deepEqual(inspectStorage(), storageBeforeRead, 'Live projection never stores copied mainline nodes or version rows')
    chapterMainlineBefore = await mainlineFacts()
    const before = await story('story:read')
    assert.deepEqual(before.routes.find(route => route.id === 'mainline').nodeIds, ['chapter:1', 'chapter:2', 'chapter:3'])
    const mainlineNode = before.nodes.find(node => node.id === 'chapter:1')
    const { revisionId: _mainlineRevision, mainline: _readonly, ...mainlineInput } = mainlineNode
    for (const operation of [{ type: 'put-node', node: { ...mainlineInput, body: '不得覆盖主线' } },
      { type: 'delete-node', id: 'chapter:1' }, { type: 'restore-node', id: 'chapter:1', revisionId: mainlineNode.revisionId },
      { type: 'put-route', route: { id: 'mainline', title: '不得改写主线顺序', nodeIds: ['chapter:1'] } },
      { type: 'delete-edge', id: 'mainline:chapter:1>chapter:2' }]) {
      assert.deepEqual(await api.invoke('story:commit', { projectSession: context, expectedRevision: before.revision, operations: [operation] }), { success: false, error: 'STORY_MAINLINE_READ_ONLY' })
    }
    assert.deepEqual(await story('story:read'), before)
    chapterBranch = await story('story:fork-chapter', { expectedRevision: before.revision, afterChapter: 1, title: '港口调查支线', placement: 'branch' })
    const route = chapterBranch.snapshot.routes.find(route => route.id === chapterBranch.routeId)
    const node = chapterBranch.snapshot.nodes.find(node => node.id === chapterBranch.nodeId)
    assert.equal(node.body, ''); assert.equal(node.chapterSource, undefined)
    assert.equal(node.chapterBlueprint.title, '港口调查支线')
    assert.equal(node.chapterBlueprint.keyEvents, '')
    const request = { nodeId: node.id, routeId: route.id, mode: 'route' }
    const continuity = await story('story:context', request)
    assert.equal(continuity.continuation, undefined)
    assert.deepEqual(continuity.prefix.map(node => node.id), ['chapter:1'])
    assert.deepEqual(continuity.prefix.map(node => node.mainline?.chapterNumber), [1])
    assert.deepEqual(continuity.prefix[0].mainline, { chapterNumber: 1, manuscriptStatus: 'finalized', hasBlueprint: true, hasManuscript: true })
    assert.equal(continuity.prefix[0].body, draft.content, 'The author-selected finalized manuscript wins over newer chapter-1 candidates')
    assert.equal(JSON.stringify(continuity).includes('主线未来第二章'), false)
    assert.equal(JSON.stringify(continuity).includes('未指定未来第三章'), false)
    assert.ok(chapterBranch.snapshot.edges.some(edge => edge.from === route.nodeIds[0] && edge.to === node.id))
    assert.deepEqual(route.nodeIds, ['chapter:1', node.id])
    const storageAfterFork = inspectStorage()
    assert.equal(storageAfterFork.nodes.length, storageBeforeRead.nodes.length + 1, 'Fork stores only its independent chapter, never snapshots of earlier canonical chapters')
    assert.equal(storageAfterFork.nodes.some(item => item.id.startsWith('chapter:')), false)
    savedChapterBlueprint = { ...node.chapterBlueprint, role: '转折', purpose: '追查港口假地图的来历', keyEvents: '询问船夫并发现通往灯塔的旧航线',
      characters: ['林舟', '船夫'], suspenseHook: '船夫为何避谈银铃', userGuidance: '从港口实际前文展开，保留接回灯塔的可能。', notes: '分支独立备注' }
    const { revisionId: _revision, ...input } = node
    const saved = await story('story:commit', { expectedRevision: chapterBranch.snapshot.revision,
      operations: [{ type: 'put-node', node: { ...input, chapterBlueprint: savedChapterBlueprint } }] })
    assert.deepEqual(saved.nodes.find(node => node.id === input.id).chapterBlueprint, savedChapterBlueprint)
    assert.deepEqual(await mainlineFacts(), chapterMainlineBefore)
    return { schemaVersion: storageAfterFork.schemaVersion, liveSourceChapter: 'chapter:1', importedManuscriptWithoutBlueprint: true,
      stableCanonicalIdentity: true, mainlineStoryWritesRejected: true, noCopiedMainlineNodes: true, selectedFinalPreferred: true,
      noFutureInPastContext: true, independentBlueprintSaved: true, mainlineUnchanged: true }
  })
  await stage('story_chapter_insert_keeps_parent_next_edge_and_explicit_future_bridge', async () => {
    const before = await story('story:read')
    insertedChapter = await story('story:fork-chapter', { expectedRevision: before.revision, afterChapter: 1, title: '接回灯塔的插章', placement: 'insert' })
    const route = insertedChapter.snapshot.routes.find(route => route.id === insertedChapter.routeId)
    const [parent, target, next] = route.nodeIds
    assert.deepEqual(route.nodeIds, ['chapter:1', insertedChapter.nodeId, 'chapter:2', 'chapter:3']); assert.equal(target, insertedChapter.nodeId)
    for (const [from, to] of [[parent, next], [parent, target], [target, next]]) assert.ok(insertedChapter.snapshot.edges.some(edge => edge.from === from && edge.to === to))
    assert.deepEqual(insertedChapter.snapshot.routes.find(route => route.id === 'mainline').nodeIds, [parent, next, 'chapter:3'])
    const node = insertedChapter.snapshot.nodes.find(node => node.id === target), { revisionId: _revision, ...input } = node
    childInput = { ...input, chapterBlueprint: { ...savedChapterBlueprint, title: '接回灯塔的插章', purpose: '从港口调查自然走向灯塔开场' } }
    await story('story:commit', { expectedRevision: insertedChapter.snapshot.revision, operations: [{ type: 'put-node', node: childInput }] })
    const request = { nodeId: target, routeId: route.id, mode: 'route' }
    const pastOnly = await story('story:context', request)
    assert.equal(pastOnly.continuation, undefined)
    assert.equal(JSON.stringify(pastOnly).includes('主线未来第二章'), false)
    bridgeRequest = { ...request, bridgeToNodeId: next }
    const bridged = await story('story:context', bridgeRequest)
    assert.equal(bridged.sourceHash, pastOnly.sourceHash)
    assert.notEqual(bridged.contextHash, pastOnly.contextHash)
    assert.deepEqual(bridged.prefix, pastOnly.prefix)
    assert.equal(bridged.continuation.node.id, next)
    assert.match(bridged.continuation.node.body, /主线未来第二章/)
    assert.equal(bridged.continuation.edge.from, target)
    assert.equal(JSON.stringify(bridged).includes('未指定未来第三章'), false)
    const invalid = await api.invoke('story:context', { ...request, bridgeToNodeId: chapterBranch.nodeId, projectSession: context })
    assert.deepEqual(invalid, { success: false, error: 'STORY_CONTINUATION_INVALID' })
    assert.deepEqual(await mainlineFacts(), chapterMainlineBefore)
    return { originalMainlineEdgePreserved: true, independentInsertRoute: true, futureOptional: true, onlySelectedFutureAdmitted: true, unlinkedBridgeRejected: true }
  })
  await stage('story_chapter_agent_generation_approval_commits_body_and_preserves_parent_links', async () => {
    const before = await story('story:read'), requestsBefore = httpCalls.length
    const recovery = await agent('agent-generation:begin', { uiActionNonce: randomUUID(), modelId: model('openai').id, input: chapterAgentInput(bridgeRequest) })
    assert.equal(recovery.sourceStatus, 'current'); assert.equal(httpCalls.length, requestsBefore)
    const generatedBody = '林舟收起港口的地图，向船夫询问旧航线。船夫指向雾中的灯塔，却没有解释银铃的来历。林舟沿岸而行，终于看见守塔人的身影。'
    const toolResponse = '已按独立蓝图提出桥接正文。<tool_call>' + JSON.stringify({ name: 'propose_story_changes', arguments: {
      operations: [{ type: 'put-node', node: { ...childInput, body: generatedBody } }],
    } }) + '</tool_call>'
    httpPlans.push({ body: sse({ choices: [{ delta: { content: toolResponse }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' })
    const result = await agent('agent-generation:round', { handle: recovery.handle, index: 0 })
    const prompt = JSON.stringify(httpCalls.at(-1).body.messages)
    assert.ok(prompt.includes(draft.content)); assert.ok(prompt.includes('主线未来第二章'))
    assert.ok(prompt.includes('从港口调查自然走向灯塔开场')); assert.equal(prompt.includes('未指定未来第三章'), false)
    const action = result.rounds[0].actions[0]
    assert.equal(action.name, 'propose_story_changes')
    assert.equal((await story('story:read')).nodes.find(node => node.id === childInput.id).body, '')
    await assert.rejects(agent('agent-generation:commit-domain-tool', { ref: action.ref }), /GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED/)
    assert.equal((await agent('agent-generation:claim-tool', { ref: action.ref, confirmed: true })).execute, true)
    const receipt = await agent('agent-generation:commit-domain-tool', { ref: action.ref })
    assert.equal(receipt.kind, 'story')
    const saved = await story('story:read')
    assert.equal(saved.nodes.find(node => node.id === childInput.id).body, generatedBody)
    assert.deepEqual(saved.nodes.find(node => node.id === childInput.id).chapterBlueprint, childInput.chapterBlueprint)
    assert.deepEqual(saved.edges, before.edges); assert.deepEqual(saved.routes, before.routes)
    assert.equal(saved.revisions.length, before.revisions.length + 1)
    assert.equal((await agent('agent-generation:commit-domain-tool', { ref: action.ref })).afterHash, receipt.afterHash)
    assert.equal((await story('story:read')).revisions.length, saved.revisions.length)
    assert.deepEqual(await mainlineFacts(), chapterMainlineBefore)
    return { mockedProviderRequests: httpCalls.length - requestsBefore, actualMainAgentAdmission: true, explicitAuthorApproval: true,
      approvedBodyCommitted: true, blueprintPreserved: true, parentEdgesAndRoutesPreserved: true, duplicateCommitIdempotent: true, mainlineUnchanged: true }
  })
  await stage('story_chapter_future_edit_invalidates_context_and_blocks_stale_model_dispatch', async () => {
    const previous = await story('story:context', bridgeRequest), sourceBefore = await mainlineFacts()
    const recovery = await agent('agent-generation:begin', { uiActionNonce: randomUUID(), modelId: model('openai').id, input: chapterAgentInput(bridgeRequest) })
    const futureDraft = sourceBefore.drafts.find(item => item.chapterNumber === 2)
    const newFuture = '主线后文原稿修改：守塔人改为留下一枚铜铃。'
    success(await api.invoke('db:draft-update-content', futureDraft.id, newFuture, newFuture.length, projectPath,
      createHash('sha256').update(futureDraft.content).digest('hex'), context))
    const changed = await story('story:read')
    assert.equal(changed.nodes.find(node => node.id === 'chapter:2').body, newFuture)
    assert.equal(changed.nodes.find(node => node.id === 'chapter:2').mainline.manuscriptStatus, 'draft')
    const current = await story('story:context', bridgeRequest)
    assert.equal(current.sourceHash, previous.sourceHash); assert.notEqual(current.contextHash, previous.contextHash)
    const stale = await api.invoke('story:commit', { projectSession: context, expectedRevision: changed.revision,
      expectedContext: { request: bridgeRequest, contextHash: previous.contextHash },
      operations: [{ type: 'put-node', node: { ...childInput, body: '基于旧后文的过期生成' } }] })
    assert.deepEqual(stale, { success: false, error: 'STORY_CONTEXT_STALE' })
    const requestsBefore = httpCalls.length
    await assert.rejects(agent('agent-generation:round', { handle: recovery.handle, index: 0 }), /SOURCE_CHANGED/)
    assert.equal(httpCalls.length, requestsBefore, 'A changed future must be detected before another provider request')
    assert.deepEqual(await story('story:read'), changed)
    const sourceAfter = await mainlineFacts()
    assert.deepEqual(sourceAfter.blueprints, sourceBefore.blueprints)
    assert.deepEqual(sourceAfter.authoritativeFinals, sourceBefore.authoritativeFinals)
    assert.deepEqual(sourceAfter.drafts.filter(item => item.id !== futureDraft.id), sourceBefore.drafts.filter(item => item.id !== futureDraft.id))
    return { pastConfirmationHashStable: true, bridgeContextHashChanged: true, staleCommitRejected: true,
      staleDispatchRejectedBeforeNetwork: true, canonicalFutureEditReadLive: true, unrelatedMainlineContentPreserved: true }
  })
  await stage('sync_package_join_replica_transaction_apply_and_reopen', async () => {
    // All projects/packages stay inside the synthetic native bridge root.
    dialogSelections.push(bridge.environment.filesDir)
    const parent = await api.invoke('dialog:select-folder', 'project-create')
    const created = success(await api.invoke('project:create', { name: '同步原始副本', parentGrantId: parent.grantId, genre: '奇幻', targetAudience: '一般读者', writingLanguage: 'zh-CN' }, 'sync-create'))
    const activate = async (target, token) => {
      const opened = success(await api.invoke('project:open', target, token, projectPath), token)
      projectPath = opened.project.path
      context = { projectId: opened.project.id, leaseId: opened.project.sessionLease, projectPath }
    }
    await activate(created.projectPath, 'sync-open-source')
    const sourcePath = projectPath, sourceId = context.projectId
    assert.equal(success(await api.invoke('sync:status', { projectSession: context })).status.enabled, false)
    const enabled = success(await api.invoke('sync:enable', { projectSession: context }))
    const sourceReplica = enabled.status.replicaId
    const branch = await createStoryFixture('同步剧情')
    success(await db('db:project-core-update', { totalChapters: 12, synopsis: '主副本开启同步后写入。' }))
    const createdDraft = success(await db('db:draft-create', { chapterNumber: 1, version: 1, source: 'write', content: '同步跨设备正文。', wordCount: 8 }))
    const sourceStory = await story('story:read')
    assert.ok(success(await api.invoke('sync:status', { projectSession: context })).status.localBatches >= 3)
    const exportPackage = async name => {
      const file = path.posix.join(bridge.environment.filesDir, `${name}.ainovelsync`)
      dialogSelections.push(file)
      const grant = await api.invoke('dialog:select-sync-export', name)
      const request = { projectSession: context, targetGrantId: grant.grantId }
      success(await api.invoke('sync:export', request), 'sync export')
      assert.equal((await api.invoke('sync:export', request)).error, 'SYNC_GRANT_INVALID')
      assert.ok(fs.statSync(bridge.hostPath(file)).size > 0)
      return file
    }
    const sourcePackage = await exportPackage('source-sync')
    dialogSelections.push(sourcePackage)
    const sourceGrant = await api.invoke('dialog:select-sync-package')
    dialogSelections.push(bridge.environment.filesDir)
    const targetGrant = await api.invoke('dialog:select-sync-join-target', '同步加入副本')
    const beforeJoinContext = { ...context }
    const joined = success(await api.invoke('sync:join', { sourceGrantId: sourceGrant.grantId, targetGrantId: targetGrant.grantId }), 'sync join')
    assert.equal((await api.invoke('project:get-runtime-context')).activeProjectPath, sourcePath, 'Join must not switch the active project')
    assert.equal(success(await api.invoke('sync:status', { projectSession: context })).status.replicaId, sourceReplica)
    await activate(joined.projectPath, 'sync-open-joined')
    assert.equal(context.projectId, sourceId)
    const joinedReplica = success(await api.invoke('sync:status', { projectSession: context })).status.replicaId
    assert.notEqual(joinedReplica, sourceReplica)
    assert.equal((await db('db:draft-get-full', createdDraft.id)).content, '同步跨设备正文。')
    assert.equal((await db('db:project-core-get')).synopsis, '主副本开启同步后写入。')
    const joinedStory = await story('story:read')
    assert.deepEqual(joinedStory, sourceStory, 'Sync join must preserve branch UUIDs, paths, prose, version ancestry and the live canonical chapter')
    assert.deepEqual(joinedStory.nodes.filter(node => !node.mainline), branch.snapshot.nodes.filter(node => !node.mainline))
    assert.equal(joinedStory.nodes.find(node => node.id === 'chapter:1').body, '同步跨设备正文。')
    assert.equal((await api.invoke('sync:enable', { projectSession: beforeJoinContext })).error, 'SYNC_SESSION_STALE')
    success(await db('db:project-core-update', { synopsis: '加入副本离线修改，随后合并。' }))
    const joinedStoryEdit = await story('story:commit', { expectedRevision: joinedStory.revision,
      operations: [{ type: 'put-node', node: { ...branch.a, body: '加入副本离线改写甲路线正文' } }] })
    const incoming = await exportPackage('joined-sync')
    await activate(sourcePath, 'sync-return-source')
    dialogSelections.push(incoming)
    const incomingGrant = await api.invoke('dialog:select-sync-package')
    const preview = success(await api.invoke('sync:import-preview', { sourceGrantId: incomingGrant.grantId, projectSession: context }))
    assert.equal(preview.preview.canApply, true)
    assert.ok(preview.preview.pendingBatches > 0)
    assert.equal((await db('db:project-core-get')).synopsis, '主副本开启同步后写入。', 'Preview must not change author content')
    const applied = success(await api.invoke('sync:apply', { projectSession: context, token: preview.preview.token, resolutions: [] }))
    assert.equal(applied.applied.applied, true)
    assert.equal(applied.status.pendingBatches, 0)
    await activate(sourcePath, 'sync-reopen-applied')
    assert.equal((await db('db:project-core-get')).synopsis, '加入副本离线修改，随后合并。')
    assert.equal((await db('db:draft-get-full', createdDraft.id)).content, '同步跨设备正文。')
    assert.deepEqual(await story('story:read'), joinedStoryEdit, 'Applied branch changes and immutable revisions must survive a new project session')
    const routeAfterSync = await story('story:context', { nodeId: branch.merge.id, routeId: branch.routes[0].id, mode: 'route' })
    assert.equal(routeAfterSync.prefix.at(-1).body, '加入副本离线改写甲路线正文')
    assert.equal(JSON.stringify(routeAfterSync).includes('乙路线独有'), false)
    assert.equal(routeAfterSync.readyForGeneration, false)
    assert.equal(success(await api.invoke('sync:status', { projectSession: context })).status.replicaId, sourceReplica)
    dialogSelections.push(incoming)
    const repeatedGrant = await api.invoke('dialog:select-sync-package')
    const repeated = success(await api.invoke('sync:import-preview', { sourceGrantId: repeatedGrant.grantId, projectSession: context }))
    assert.equal(repeated.preview.pendingBatches, 0)
    assert.equal(success(await api.invoke('sync:apply', { projectSession: context, token: repeated.preview.token, resolutions: [] })).applied.appliedBatches, 0)
    return { sameProjectIdentity: true, distinctReplicaIdentity: true, previewNonMutating: true, duplicateIdempotent: true,
      reopenedContentVerified: true, branchGraphAndVersionHistoryPreserved: true, routeContextRemainsIsolated: true }
  })
  await stage('close_cleanly', async () => { success(await db('db:close')) })
} catch (error) {
  console.error(error.stack || error)
  process.exitCode = 1
} finally {
  const buildUnchangedDuringRun = JSON.stringify(buildFingerprint) === JSON.stringify(readBuildFingerprint(root))
  if (!buildUnchangedDuringRun) process.exitCode = 1
  const report = { passed: results.every(result => result.passed) && buildUnchangedDuringRun, target: 'actual Android backend bundle with real Node fs/SQLite/crypto protocol host', deviceTest: false,
    build: buildFingerprint, buildUnchangedDuringRun, backendFixtureSha256: fs.existsSync(path.join(sandbox, 'backend.mjs')) ? createHash('sha256').update(fs.readFileSync(path.join(sandbox, 'backend.mjs'))).digest('hex') : null,
    durationMs: Date.now() - started, stages: results, ...(process.env.MOBILE_PERF_ONLY ? { frequentQueries: [...nativeQueries].sort((a,b)=>b[1]-a[1]).slice(0,20) } : {}) }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  bridge.close()
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  for (const key of isolatedEnvironment) {
    if (savedEnvironment[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnvironment[key]
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
}
