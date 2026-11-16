/** Old installed books, not new-project smoke: exact mobile backend/bridge aliases. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createNativeMock } from '../test/mobile-native-mock.mjs'

const root = path.resolve(import.meta.dirname, '..'), baseline = process.argv.includes('--baseline-144')
const product = baseline ? path.resolve(root, '../AI-Novel-Writer-1.4.4-sync-optimization') : root
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'android-schema11-upgrade-'))
const reportPath = path.join(root, '.runtime', baseline ? 'android-schema11-baseline-144.json' : 'android-schema11-candidate-145.json')
let normalize = false, platformNormalizedOpens = 0
const native = createNativeMock(scratch, { virtualPaths: true, configureSqliteOpen(database, target, options) {
  if (normalize && !options?.readonly && /[\\/]project\.db$/.test(target)) { database.exec("UPDATE android_metadata SET locale='zh_CN'"); platformNormalizedOpens++ }
} })
const selections = [], operations = new Map(), stages = [], originalPlatform = process.platform
const savedEnvironment = Object.fromEntries(['LOCALAPPDATA', 'AI_NOVEL_APP_DATA_HOME', 'AI_NOVEL_LEGACY_SOURCE_HOME', 'AI_NOVEL_VELA_HOME'].map(name => [name, process.env[name]]))
let networkRequests = 0, api, module
const digest = value => createHash('sha256').update(value).digest('hex')
const domain = state => ({ core: state.core, drafts: state.drafts, finalizations: state.finalizations, heads: state.heads, blueprints: state.blueprints })
async function stage(name, action) {
  const started = Date.now()
  try { const detail = await action(); stages.push({ name, passed: true, durationMs: Date.now() - started, ...detail }) }
  catch (error) { stages.push({ name, passed: false, durationMs: Date.now() - started, error: String(error.stack || error) }); throw error }
}
const success = result => { assert.equal(result?.success, true, JSON.stringify(result)); return result }
try {
  const aliases = Object.fromEntries(['fs', 'path', 'os', 'crypto', 'module', 'util', 'stream'].flatMap(name => [[name, name], [`node:${name}`, name]]))
  Object.assign(aliases, { 'node:fs/promises': 'fs-promises', 'fs/promises': 'fs-promises', 'node:child_process': 'child-process', child_process: 'child-process', electron: 'electron', 'better-sqlite3': 'sqlite', '@lancedb/lancedb': 'lancedb', yauzl: 'yauzl' })
  await stage('bundle-production-mobile-backend-and-old-schema-fixture', async () => {
    const filename = value => JSON.stringify(value.replaceAll('\\', '/'))
    await build({ absWorkingDir: root, stdin: { contents: `export * from ${filename(path.join(product, 'mobile/backend.ts'))}; export {registerRecentProject} from ${filename(path.join(product, 'electron/controllers/project-controller.ts'))}; export {readSyncKnowledgeDocuments} from ${filename(path.join(product, 'electron/vector-store.ts'))}; export * from ${filename(path.join(root, 'test/android-schema11-upgrade-fixture.ts'))};`, resolveDir: root },
      outfile: path.join(scratch, 'backend.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022',
      banner: { js: "import {createRequire as __hostRequire} from 'node:module';const require=__hostRequire(import.meta.url);" }, plugins: [{ name: 'actual-mobile-aliases', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.path === 'stream' && args.importer.includes('node_modules')) return { path: 'node:stream', external: true }
          if (args.path.endsWith('/services/google-drive-authorization')) return { path: path.join(product, 'mobile/shims/google-drive-authorization.ts') }
          if (aliases[args.path]) return { path: path.join(product, 'mobile/shims', `${aliases[args.path]}.ts`) }
          if (args.path.endsWith('/security/windows-safe-file-system')) return { path: path.join(product, 'mobile/shims/secure-fs.ts') }
        })
      } }] })
    return { sourceRoot: product, backendSha256: digest(fs.readFileSync(path.join(scratch, 'backend.mjs'))) }
  })
  for (const name of Object.keys(savedEnvironment)) delete process.env[name]
  Object.defineProperty(process, 'platform', { value: 'android', configurable: true })
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { documentElement: { dataset: {} }, querySelector: () => null })
  globalThis.location = new URL('https://appassets.androidplatform.net/assets/index.html')
  globalThis.AndroidBridge = {
    sync(payload) { const { op } = JSON.parse(payload); operations.set(op, (operations.get(op) || 0) + 1); return native.sync(payload) },
    request(id, payload) {
      const { op } = JSON.parse(payload)
      if (op === 'http.request' || op.startsWith('google.')) { networkRequests++; throw new Error('NO_NETWORK_OR_REAL_ACCOUNT_IN_UPGRADE_TEST') }
      const response = op === 'dialog.open' ? { ok: true, value: { canceled: false, filePaths: [selections.shift()] } } : JSON.parse(native.sync(payload))
      queueMicrotask(() => globalThis.__androidResolve?.(id, response))
    },
  }
  module = await import(pathToFileURL(path.join(scratch, 'backend.mjs')).href)
  api = module.startMobileBackend()
  for (const kind of ['local', 'sync-imported']) await stage(`schema11-${kind}-${baseline ? 'reproduces-upgrade-rejection' : 'upgrades-and-reopens-losslessly'}`, async () => {
    const rootPath = `/android/files/${kind === 'local' ? 'old-local-book' : 'Synced-Novels/old-imported-book'}`
    const fixture = await module.createSchema11Book(rootPath, kind)
    const before = module.schema11BookState(rootPath), beforeHash = digest(JSON.stringify(domain(before)))
    assert.equal(before.version, 11)
    if (kind === 'sync-imported') {
      assert.equal(before.replica.replica_id, fixture.importedReplicaId)
      assert.notEqual(fixture.importedReplicaId, fixture.sourceReplicaId)
      module.registerRecentProject({ path: rootPath, name: fixture.title, projectId: fixture.projectId, updatedAt: '2026-11-11T00:00:00Z' }, { automatic: true })
    } else selections.push(rootPath)
    const grant = kind === 'local' ? await api.invoke('dialog:select-folder', 'project-open') : null
    normalize = true
    const opened = await api.invoke('project:open', grant ? { grantId: grant.grantId } : rootPath, `upgrade-${kind}`)
    normalize = false
    if (baseline) {
      assert.equal(opened.success, false); assert.match(opened.error, /CANONICAL_SCHEMA_UPGRADE_UNSUPPORTED/)
      const rejected = module.schema11BookState(rootPath)
      assert.equal(rejected.version, 11); assert.equal(digest(JSON.stringify(domain(rejected))), beforeHash)
      assert.deepEqual(rejected.replica, before.replica)
      return { error: opened.error, schemaBefore: 11, schemaAfter: 11, authorDataHash: beforeHash, rejectedWithoutAuthorChanges: true, importedReplicaPreserved: kind === 'sync-imported' }
    }
    success(opened); assert.equal(opened.project.id, fixture.projectId)
    const session = { projectPath: rootPath, projectId: fixture.projectId, leaseId: opened.project.sessionLease }
    const upgraded = module.schema11BookState(rootPath)
    assert.equal(upgraded.version, 12); assert.equal(digest(JSON.stringify(domain(upgraded))), beforeHash)
    const drafts = await api.invoke('db:draft-list', 1, rootPath, session)
    assert.equal(drafts.length, 1); assert.equal(drafts[0].status, 'finalized')
    const full = await api.invoke('db:draft-get-full', drafts[0].id, rootPath, session); assert.equal(full.content, fixture.manuscript)
    const knowledge = await module.readSyncKnowledgeDocuments(fixture.storage)
    assert.equal(knowledge.length, 1); assert.equal(knowledge[0].copy.content, fixture.original)
    let compactClock = null
    if (kind === 'sync-imported') {
      success(await api.invoke('sync:status', { projectSession: session }))
      const current = module.schema11BookState(rootPath)
      assert.equal(current.replica.replica_id, fixture.importedReplicaId)
      assert.ok(current.compact.clock[fixture.sourceReplicaId] >= 1)
      compactClock = current.compact.clock
    }
    success(await api.invoke('db:close', rootPath, session))
    const reopened = success(await api.invoke('project:open', rootPath, `reopen-${kind}`))
    const next = { projectPath: rootPath, projectId: fixture.projectId, leaseId: reopened.project.sessionLease }
    const again = module.schema11BookState(rootPath)
    assert.equal(again.version, 12); assert.equal(digest(JSON.stringify(domain(again))), beforeHash)
    if (compactClock) { success(await api.invoke('sync:status', { projectSession: next })); assert.deepEqual(module.schema11BookState(rootPath).compact.clock, compactClock) }
    assert.equal((await module.readSyncKnowledgeDocuments(fixture.storage))[0].copy.content, fixture.original)
    success(await api.invoke('db:close', rootPath, next))
    return { schemaBefore: 11, schemaAfter: 12, authorDataHash: beforeHash, projectIdentityPreserved: true, exactFinalizedBody: true,
      exactFullKnowledgeOriginal: true, closeAndReopen: true, importedReplicaPreserved: kind === 'sync-imported', compactClock }
  })
} catch (error) { process.exitCode = 1; console.error(error.stack || error) }
finally {
  native.close(); Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  for (const [name, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  const report = { passed: stages.length === 3 && stages.every(stage => stage.passed), baseline144: baseline, deviceTest: false, realGoogleDrive: false,
    networkRequests, platformNormalizedOpens, nativeOperations: Object.fromEntries(operations), stages, sourceRoot: product, artifacts: scratch }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
  if (!report.passed || networkRequests) process.exitCode = 1
}
