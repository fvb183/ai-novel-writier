/** Actual Android backend/IPC, native filesystem/SQLite and synthetic model SSE. No Chrome or real account. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createNativeMock } from '../test/mobile-native-mock.mjs'

const root = path.resolve(import.meta.dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'android-blueprint-recovery-'))
const reportPath = path.join(root, '.runtime/android-blueprint-recovery-backend-report.json')
const native = createNativeMock(scratch, { virtualPaths: true })
const originalPlatform = process.platform, savedFetch = globalThis.fetch
const keys = ['LOCALAPPDATA', 'AI_NOVEL_APP_DATA_HOME', 'AI_NOVEL_LEGACY_SOURCE_HOME', 'AI_NOVEL_VELA_HOME']
const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]))
const stages = [], operations = new Map()
let module, api, opened, session, recoveryHandle, formal, syntheticRequests = 0, unexpectedRequests = 0
const hash = value => createHash('sha256').update(value).digest('hex')
const ok = result => { assert.equal(result?.success, true, JSON.stringify(result)); return result }
const db = (channel, ...args) => api.invoke(channel, ...args, session)
async function stage(name, run) {
  const started = Date.now()
  try { const detail = await run(); stages.push({ name, passed: true, durationMs: Date.now() - started, ...detail }) }
  catch (error) { stages.push({ name, passed: false, durationMs: Date.now() - started, error: String(error.stack || error) }); throw error }
}
try {
  await stage('bundle-real-android-backend-and-register-delete-channel', async () => {
    const aliases = Object.fromEntries(['fs', 'path', 'os', 'crypto', 'module', 'util', 'stream'].flatMap(name => [[name, name], [`node:${name}`, name]]))
    Object.assign(aliases, { 'node:fs/promises': 'fs-promises', 'fs/promises': 'fs-promises', 'node:child_process': 'child-process', child_process: 'child-process', electron: 'electron', 'better-sqlite3': 'sqlite', '@lancedb/lancedb': 'lancedb', yauzl: 'yauzl' })
    await build({ absWorkingDir: root, stdin: { contents: "export * from './mobile/backend'; export {mobileHandlers} from './mobile/shims/electron';", resolveDir: root },
      outfile: path.join(scratch, 'backend.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022',
      banner: { js: "import {createRequire as __hostRequire} from 'node:module';const require=__hostRequire(import.meta.url);" },
      plugins: [{ name: 'actual-mobile-aliases', setup(builder) { builder.onResolve({ filter: /.*/ }, args => {
        if (args.path === 'stream' && args.importer.includes('node_modules')) return { path: 'node:stream', external: true }
        if (args.path.endsWith('/services/google-drive-authorization')) return { path: path.join(root, 'mobile/shims/google-drive-authorization.ts') }
        if (aliases[args.path]) return { path: path.join(root, 'mobile/shims', `${aliases[args.path]}.ts`) }
        if (args.path.endsWith('/security/windows-safe-file-system')) return { path: path.join(root, 'mobile/shims/secure-fs.ts') }
      }) } }] })
    for (const key of keys) delete process.env[key]
    Object.defineProperty(process, 'platform', { value: 'android', configurable: true })
    globalThis.window = new EventTarget()
    globalThis.document = Object.assign(new EventTarget(), { documentElement: { dataset: {} }, querySelector: () => null })
    globalThis.location = new URL('https://appassets.androidplatform.net/assets/index.html')
    globalThis.AndroidBridge = {
      sync(payload) {
        const { op } = JSON.parse(payload); operations.set(op, (operations.get(op) || 0) + 1)
        return op === 'http.cancel' ? JSON.stringify({ ok: true, value: null }) : native.sync(payload)
      },
      request(id, payload) {
        const { op, args } = JSON.parse(payload); operations.set(op, (operations.get(op) || 0) + 1)
        if (op === 'http.request') {
          assert.equal(args[0], 'https://blueprint.synthetic.invalid/v1/chat/completions')
          syntheticRequests++
          const text = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '{"blueprints":[{"chapterNumber":1,"title":"合成未完成恢复稿' }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n'
          queueMicrotask(() => {
            globalThis.__androidEvent(id, 'headers', { status: 200, headers: { 'content-type': 'text/event-stream' }, url: args[0] })
            globalThis.__androidEvent(id, 'data', Buffer.from(text).toString('base64'))
            globalThis.__androidEvent(id, 'end', {})
          })
          return
        }
        if (op.startsWith('google.')) { unexpectedRequests++; throw new Error('NO_REAL_ACCOUNT_IN_BLUEPRINT_TEST') }
        const response = op === 'dialog.open' ? { ok: true, value: { canceled: false, filePaths: [native.environment.filesDir] } } : JSON.parse(native.sync(payload))
        queueMicrotask(() => globalThis.__androidResolve(id, response))
      },
    }
    module = await import(pathToFileURL(path.join(scratch, 'backend.mjs')).href)
    api = module.startMobileBackend()
    assert.ok(module.mobileHandlers.has('generation:delete-blueprint-recovery'))
    return { backendSha256: hash(fs.readFileSync(path.join(scratch, 'backend.mjs'))), registeredChannels: module.mobileHandlers.size }
  })
  await stage('create-and-open-synthetic-project-and-preserve-formal-blueprint', async () => {
    const grant = await api.invoke('dialog:select-folder', 'project-create')
    const created = ok(await api.invoke('project:create', { name: 'recovery-delete-book', parentGrantId: grant.grantId, genre: '奇幻', targetAudience: '成人', writingLanguage: 'zh-CN' }, 'create-backend-recovery', null))
    opened = ok(await api.invoke('project:open', created.projectPath, 'open-backend-recovery', null)).project
    session = { projectPath: opened.path, projectId: opened.id, leaseId: opened.sessionLease }
    ok(await db('db:project-core-update', { totalChapters: 3 }, opened.path))
    ok(await db('db:blueprint-upsert', { chapterNumber: 3, title: '正式蓝图保留', role: '发展', purpose: '正式目标', keyEvents: '正式事件', characters: [], suspenseHook: '', userGuidance: '作者正式指导', notes: '', notesUpdatedAt: '' }, opened.path))
    formal = await db('db:blueprint-get-all', opened.path)
    ok(await api.invoke('llm:save-model', { id: 'blueprint-recovery-synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'synthetic-model', apiKey: 'SYNTHETIC_NOT_A_REAL_KEY', baseUrl: 'https://blueprint.synthetic.invalid/v1', temperature: .7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: false, usage: false } }))
    return { projectCreatedAndOpenedThroughRealIPC: true, formalBlueprintHash: hash(JSON.stringify(formal)) }
  })
  await stage('generate-one-recovery-draft-through-native-synthetic-sse', async () => {
    const selection = { operation: 'chapter-blueprint-directory', uiActionNonce: 'synthetic-recovery', modelId: 'blueprint-recovery-synthetic', selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [1, 2, 3], promptKeys: ['chapter_blueprint_chunk'], skillStages: ['planning'], output: 'structured-data', authorInputs: [
      { id: 'planning:target-units', text: '700' }, { id: 'directory:pacing-guidance', text: '只使用合成夹具。' }, { id: 'directory:author-config', text: '{"totalChapters":3}' }, { id: 'directory:requested-range', text: '{"mode":"full","startChapter":1,"endChapter":3}' },
    ] }
    const view = await db('generation:begin', selection); recoveryHandle = view.handle
    assert.ok(recoveryHandle?.runId)
    await db('generation:execute', { handle: recoveryHandle, invocationNonce: 'synthetic-interrupted', task: { purpose: 'chapter-blueprint-directory', output: 'structured-data', messages: [{ role: 'user', content: '合成恢复稿测试。' }] } })
    const recovery = await db('generation:find-blueprint-recovery')
    assert.equal(recovery.handle.runId, recoveryHandle.runId); assert.match(recovery.blueprintRecovery.draft, /合成未完成恢复稿/)
    assert.equal(syntheticRequests, 1)
    return { recoveryHandleMatches: true, syntheticSSERequests: syntheticRequests }
  })
  await stage('delete-exact-recovery-through-actual-ipc-and-reject-old-handle', async () => {
    const result = await db('generation:delete-blueprint-recovery', recoveryHandle)
    assert.ok(result.deletedRunIds.includes(recoveryHandle.runId))
    assert.equal(await db('generation:find-blueprint-recovery'), null)
    assert.deepEqual(await db('db:blueprint-get-all', opened.path), formal)
    await assert.rejects(db('generation:read-context', { handle: recoveryHandle }), /GENERATION_BLUEPRINT_RECOVERY_DELETED/)
    return { permanentDeletionChannelSucceeded: true, formalBlueprintUnchanged: true, staleHandleRejected: true }
  })
  await stage('reopen-project-and-confirm-recovery-does-not-reappear', async () => {
    ok(await db('db:close', opened.path))
    opened = ok(await api.invoke('project:open', opened.path, 'reopen-backend-recovery', null)).project
    session = { projectPath: opened.path, projectId: opened.id, leaseId: opened.sessionLease }
    assert.equal(await db('generation:find-blueprint-recovery'), null)
    assert.deepEqual(await db('db:blueprint-get-all', opened.path), formal)
    await assert.rejects(db('generation:read-context', { handle: recoveryHandle }), /GENERATION_BLUEPRINT_RECOVERY_DELETED/)
    ok(await db('db:close', opened.path))
    return { closeAndReopen: true, noRecoveryBannerSource: true, formalBlueprintUnchanged: true, oldHandleStillRejected: true }
  })
} catch (error) { process.exitCode = 1; console.error(error.stack || error) }
finally {
  native.close(); globalThis.fetch = savedFetch
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  const report = { passed: stages.length === 5 && stages.every(stage => stage.passed), realAndroidDevice: false, realAccountOrModel: false, externalNetworkRequests: unexpectedRequests, syntheticSSERequests: syntheticRequests, nativeOperations: Object.fromEntries(operations), stages, artifacts: scratch }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
  if (!report.passed || unexpectedRequests) process.exitCode = 1
}
