/** Real mobile backend/IPC and Android fs/config adapters; synthetic Google/Drive only. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createNativeMock } from '../test/mobile-native-mock.mjs'

const root = path.resolve(import.meta.dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'android-account-model-settings-'))
const reportPath = path.join(root, '.runtime/android-account-model-settings-backend-report.json')
const environmentKeys = ['LOCALAPPDATA', 'AI_NOVEL_APP_DATA_HOME', 'AI_NOVEL_LEGACY_SOURCE_HOME', 'AI_NOVEL_VELA_HOME']
const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))
const originalPlatform = process.platform, devices = [], stages = []
const SYNTHETIC_KEY = 'SYNTHETIC_ANDROID_MODEL_KEY_NOT_REAL'
const SYNTHETIC_TOKEN = 'SYNTHETIC_ANDROID_OAUTH_TOKEN_NOT_REAL'
const folders = new Map(), configs = new Map(), legacyProjectId = randomUUID()
let activeAccount = 'synthetic-account-a', sequence = 0, networkRequests = 0, cloudReads = 0
const legacy = { folderId: 'legacy-settings-project', projectId: legacyProjectId, name: 'AI Novel Writer · 合成旧配置来源' }
const hash = value => createHash('sha256').update(value).digest('hex')
const ok = result => { assert.equal(result?.success, true, JSON.stringify(result)); return result }
async function stage(name, action) {
  const started = Date.now()
  try { const detail = await action(); stages.push({ name, passed: true, durationMs: Date.now() - started, ...detail }) }
  catch (error) { stages.push({ name, passed: false, durationMs: Date.now() - started, error: String(error.stack || error) }); throw error }
}
const profile = (id, embedding = false) => ({ id, name: embedding ? '合成向量模型' : '合成写作模型', provider: 'custom', protocol: 'openai',
  modelName: id, baseUrl: 'https://synthetic.invalid/v1', apiKey: SYNTHETIC_KEY, temperature: .7,
  maxTokens: embedding ? 0 : 4096, purposes: [embedding ? 'embedding' : 'generation'],
  ...(embedding ? { embeddingOptions: { chunkSize: 800, chunkOverlap: 100, batchSize: 4 } } : {}) })
function select(device) {
  globalThis.window = device.window; globalThis.AndroidBridge = device.bridge
  globalThis.__androidResolve = device.resolve; globalThis.__androidEvent = device.event
}
function cloudClient(token, check) {
  return {
    async accountId() { assert.equal(await token(), SYNTHETIC_TOKEN); check(); return activeAccount },
    async allocateId() { check(); return `account-folder-${++sequence}` },
    async modelSettingsFolders(accountId) { check(); return [...folders.values()].filter(folder => folder.accountId === accountId) },
    async checkModelSettingsFolder(id, accountId) {
      check(); const folder = folders.get(id)
      assert.ok(folder); if (accountId !== undefined) assert.equal(folder.accountId, accountId)
      return folder
    },
    async createModelSettingsFolder(accountId, id) { check(); folders.set(id, { id, accountId, name: '合成账户模型配置' }); return folders.get(id) },
    async projects() { check(); return [legacy] },
    async checkFolder(id) { check(); assert.equal(id, legacy.folderId); return { id, name: legacy.name, appProperties: { ainwProject: legacy.projectId } } },
    async listObjects(folderId) { check(); return configs.has(folderId) ? [{ id: `${folderId}-settings` }] : [] },
    async readModelSettings(folderId) { check(); cloudReads++; const bytes = configs.get(folderId); assert.ok(bytes); return bytes.slice() },
    async writeModelSettings(folderId, _projectId, bytes) { check(); configs.set(folderId, bytes.slice()) },
  }
}
async function device(name) {
  const native = createNativeMock(path.join(scratch, name), { virtualPaths: true }), operations = new Map()
  const window = new EventTarget()
  const bridge = {
    sync(payload) { const { op } = JSON.parse(payload); operations.set(op, (operations.get(op) || 0) + 1); return native.sync(payload) },
    request(id, payload) {
      const { op } = JSON.parse(payload); operations.set(op, (operations.get(op) || 0) + 1)
      if (op === 'http.request') { networkRequests++; throw new Error('NO_EXTERNAL_NETWORK_IN_ACCOUNT_SETTINGS_TEST') }
      const response = op === 'google.authorize' ? { ok: true, value: { accessToken: SYNTHETIC_TOKEN } }
        : op === 'google.status' ? { ok: true, value: { available: true, authorized: true } }
          : op === 'google.disconnect' || op === 'google.cancel' ? { ok: true, value: {} }
            : JSON.parse(native.sync(payload))
      queueMicrotask(() => globalThis.__androidResolve?.(id, response))
    },
  }
  globalThis.window = window; globalThis.AndroidBridge = bridge
  const filename = path.join(scratch, `${name}.mjs`); fs.copyFileSync(path.join(scratch, 'backend.mjs'), filename)
  const module = await import(pathToFileURL(filename).href), api = module.startMobileBackend()
  const required = ['upload', 'preview', 'apply', 'discard', 'sources'].map(action => `drive:model-settings-${action}`)
  for (const channel of required) assert.ok(module.mobileHandlers.has(channel), `Production registration missing: ${channel}`)
  // Keep all shared production controllers; replace only transport DI, as existing Android integration fixtures do.
  for (const channel of [...module.mobileHandlers.keys()]) if (channel.startsWith('drive:')) module.mobileHandlers.delete(channel)
  module.registerGoogleDriveSyncController({ client: (token, check) => cloudClient(token, check) })
  const device = { name, native, window, bridge, operations, module, api, resolve: globalThis.__androidResolve, event: globalThis.__androidEvent }
  devices.push(device); return device
}
async function noProject(device) {
  select(device); assert.equal((await device.api.invoke('project:get-runtime-context')).activeProjectPath, null)
  assert.deepEqual(await device.api.invoke('project:recent-list'), [])
}
function persistedHash(device) {
  select(device); return hash(device.module.mobileFs.readFileSync(device.module.MODELS_CONFIG_PATH))
}
try {
  await stage('bundle-actual-mobile-backend-and-register-no-project-account-channels', async () => {
    const aliases = Object.fromEntries(['fs', 'path', 'os', 'crypto', 'module', 'util', 'stream'].flatMap(name => [[name, name], [`node:${name}`, name]]))
    Object.assign(aliases, { 'node:fs/promises': 'fs-promises', 'fs/promises': 'fs-promises', 'node:child_process': 'child-process', child_process: 'child-process',
      electron: 'electron', 'better-sqlite3': 'sqlite', '@lancedb/lancedb': 'lancedb', yauzl: 'yauzl' })
    await build({ absWorkingDir: root, stdin: { contents: "export * from './mobile/backend'; export {mobileHandlers} from './mobile/shims/electron'; export {registerGoogleDriveSyncController} from './electron/controllers/google-drive-sync-controller'; export {MODELS_CONFIG_PATH} from './electron/utils/config-utils'; export {default as mobileFs} from './mobile/shims/fs'; export {encodeModelSettings} from './src/shared/model-settings-sync';", resolveDir: root },
      outfile: path.join(scratch, 'backend.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022',
      banner: { js: "import {createRequire as __hostRequire} from 'node:module';const require=__hostRequire(import.meta.url);" },
      plugins: [{ name: 'production-mobile-aliases', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.path === 'stream' && args.importer.includes('node_modules')) return { path: 'node:stream', external: true }
          if (args.path.endsWith('/services/google-drive-authorization')) return { path: path.join(root, 'mobile/shims/google-drive-authorization.ts') }
          if (aliases[args.path]) return { path: path.join(root, 'mobile/shims', `${aliases[args.path]}.ts`) }
          if (args.path.endsWith('/security/windows-safe-file-system')) return { path: path.join(root, 'mobile/shims/secure-fs.ts') }
        })
      } }] })
    return { backendSha256: hash(fs.readFileSync(path.join(scratch, 'backend.mjs'))) }
  })
  for (const key of environmentKeys) delete process.env[key]
  Object.defineProperty(process, 'platform', { value: 'android', configurable: true })
  globalThis.document = Object.assign(new EventTarget(), { documentElement: { dataset: {} }, querySelector: () => null })
  globalThis.location = new URL('https://appassets.androidplatform.net/assets/index.html')
  const source = await device('source'), target = await device('target')
  await stage('upload-real-local-config-and-list-legacy-sources-without-open-book', async () => {
    await noProject(source); await noProject(target)
    select(source)
    for (const model of [profile('writing'), profile('embedding', true)]) ok(await source.api.invoke('llm:save-model', model))
    ok(await source.api.invoke('llm:set-default-model', 'writing'))
    ok(await source.api.invoke('llm:set-default-embedding-model', 'embedding'))
    ok(await source.api.invoke('llm:set-stage-model', { stage: 'drafting', modelId: 'writing' }))
    const response = ok(await source.api.invoke('drive:model-settings-upload', {}))
    assert.equal(response.modelCount, 2); assert.equal(response.modelSettingsSource.kind, 'account')
    assert.ok(!JSON.stringify(response).includes(SYNTHETIC_KEY))
    configs.set(legacy.folderId, source.module.encodeModelSettings({ format: 'ai-novel-model-settings', version: 1,
      models: [profile('legacy-writing')], defaultModelId: 'legacy-writing', defaultEmbeddingModelId: null, stageModelIds: {} }))
    select(target); ok(await target.api.invoke('llm:save-model', profile('local-unrelated')))
    ok(await target.api.invoke('config:set', { theme: 'light', proxy: { enabled: false, type: 'http', host: '127.0.0.1', port: 17891 } }))
    const before = cloudReads, listed = ok(await target.api.invoke('drive:model-settings-sources', {}))
    assert.equal(cloudReads, before); assert.deepEqual(listed.modelSettingsSources.map(item => item.folderId), [legacy.folderId])
    assert.ok(!JSON.stringify(listed).includes(SYNTHETIC_KEY))
    return { accountFolders: folders.size, noProjectSessionArgument: true, legacySourcesListedWithoutDownloadingKeys: true }
  })
  await stage('preview-then-apply-through-ipc-persists-keys-defaults-and-stage-selection', async () => {
    await noProject(target); const before = persistedHash(target)
    const preview = ok(await target.api.invoke('drive:model-settings-preview', {}))
    assert.equal(preview.modelSettingsPreview.total, 2); assert.ok(!JSON.stringify(preview).includes(SYNTHETIC_KEY))
    assert.equal(persistedHash(target), before)
    const applied = ok(await target.api.invoke('drive:model-settings-apply', { token: preview.modelSettingsPreview.token }))
    assert.ok(!JSON.stringify(applied).includes(SYNTHETIC_KEY)); assert.notEqual(persistedHash(target), before)
    const models = await target.api.invoke('llm:list-models')
    assert.deepEqual(models.map(model => model.id), ['local-unrelated', 'writing', 'embedding'])
    assert.equal(models.find(model => model.id === 'embedding').apiKey, SYNTHETIC_KEY)
    assert.equal(await target.api.invoke('llm:get-default-model'), 'writing')
    assert.equal(await target.api.invoke('llm:get-default-embedding-model'), 'embedding')
    assert.deepEqual(await target.api.invoke('llm:get-stage-models'), { drafting: 'writing' })
    const config = await target.api.invoke('config:get'); assert.equal(config.theme, 'light'); assert.equal(config.proxy.port, 17891)
    return { configSha256: persistedHash(target), previewReadOnly: true, exactSyntheticKeyPersisted: true, localProxyPreserved: true, defaultsAndStageSelectionPersisted: true }
  })
  await stage('local-edit-cas-and-explicit-legacy-preview-remain-safe-without-project', async () => {
    await noProject(target)
    const preview = ok(await target.api.invoke('drive:model-settings-preview', {}))
    const writing = (await target.api.invoke('llm:list-models')).find(model => model.id === 'writing')
    ok(await target.api.invoke('llm:save-model', { ...writing, apiKey: 'SYNTHETIC_ANDROID_LATER_LOCAL_EDIT' }))
    const before = persistedHash(target), refused = await target.api.invoke('drive:model-settings-apply', { token: preview.modelSettingsPreview.token })
    assert.equal(refused.success, false); assert.equal(refused.error, 'MODEL_SYNC_LOCAL_CHANGED'); assert.equal(persistedHash(target), before)
    const old = ok(await target.api.invoke('drive:model-settings-preview', { sourceFolderId: legacy.folderId }))
    assert.equal(old.modelSettingsSource.kind, 'project'); assert.equal(old.modelSettingsPreview.total, 1)
    assert.ok(!JSON.stringify(old).includes(SYNTHETIC_KEY))
    ok(await target.api.invoke('drive:model-settings-discard', {}))
    const discarded = await target.api.invoke('drive:model-settings-apply', { token: old.modelSettingsPreview.token })
    assert.equal(discarded.error, 'MODEL_SYNC_PREVIEW_EXPIRED'); assert.equal(persistedHash(target), before)
    return { postPreviewLocalEditPreserved: true, explicitLegacySourceReadable: true, discardedTokenCannotApply: true }
  })
  await stage('google-account-generation-change-invalidates-preview-and-leaves-books-unopened', async () => {
    await noProject(target)
    const preview = ok(await target.api.invoke('drive:model-settings-preview', {})), before = persistedHash(target)
    ok(await target.api.invoke('drive:disconnect')); activeAccount = 'synthetic-account-b'
    const rejected = await target.api.invoke('drive:model-settings-apply', { token: preview.modelSettingsPreview.token })
    assert.equal(rejected.success, false); assert.ok(['DRIVE_ACCOUNT_MISMATCH', 'MODEL_SYNC_PREVIEW_EXPIRED'].includes(rejected.error))
    assert.equal(persistedHash(target), before)
    for (const device of devices) {
      await noProject(device); assert.equal(device.operations.get('sqlite.open') || 0, 0); assert.equal(device.operations.get('sqlite.openVerified') || 0, 0)
      assert.ok((device.operations.get('google.authorize') || 0) > 0)
    }
    return { accountGenerationRejected: true, noProjectSQLiteOpened: true, nativeGoogleAuthorizationBoundaryExercised: true }
  })
} catch (error) { process.exitCode = 1; console.error(error.stack || error) }
finally {
  for (const device of devices) device.native.close()
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  const report = { passed: stages.length === 5 && stages.every(stage => stage.passed), realAndroidDevice: false, realGoogleDrive: false,
    externalNetworkRequests: networkRequests, nativeOperations: devices.map(device => ({ name: device.name, operations: Object.fromEntries(device.operations) })), stages, artifacts: scratch }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
  if (!report.passed || networkRequests) process.exitCode = 1
}
