/** Production Android aliases plus the native JSON protocol; synthetic copies only. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createNativeMock } from '../test/mobile-native-mock.mjs'

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, '.runtime', 'android-canonical-upgrade')
fs.mkdirSync(output, { recursive: true })
const sandbox = fs.mkdtempSync(path.join(output, 'case-')), native = createNativeMock(sandbox, { virtualPaths: true })
const aliases = Object.fromEntries(['fs', 'path', 'os', 'crypto', 'module', 'util', 'stream'].flatMap(name => [[name, name], [`node:${name}`, name]]))
Object.assign(aliases, { electron: 'electron', 'better-sqlite3': 'sqlite', '@lancedb/lancedb': 'lancedb', yauzl: 'yauzl',
  'node:fs/promises': 'fs-promises', 'fs/promises': 'fs-promises', 'node:child_process': 'child-process', child_process: 'child-process' })
const originalPlatform = process.platform, savedLocalAppData = process.env.LOCALAPPDATA
const results = [], reproduce = process.argv.includes('--reproduce-v144')
let failNextM12 = false
try {
  await build({ absWorkingDir: root, entryPoints: ['test/android-canonical-upgrade-fixture.ts'], outfile: path.join(sandbox, 'fixture.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    banner: { js: "import {createRequire as __hostRequire} from 'node:module';const require=__hostRequire(import.meta.url);" },
    plugins: [{ name: 'android-production-aliases', setup(builder) { builder.onResolve({ filter: /.*/ }, args => {
      if (args.path === 'stream' && args.importer.includes('node_modules')) return { path: 'node:stream', external: true }
      if (aliases[args.path]) return { path: path.join(root, 'mobile/shims', `${aliases[args.path]}.ts`) }
      if (args.path.endsWith('/security/windows-safe-file-system')) return { path: path.join(root, 'mobile/shims/secure-fs.ts') }
    }) } }] })
  Object.defineProperty(process, 'platform', { value: 'android', configurable: true }); delete process.env.LOCALAPPDATA
  globalThis.AndroidBridge = { sync(json) {
    const { op, args } = JSON.parse(json)
    if (failNextM12 && op === 'sqlite.exec' && /CREATE TABLE project_sync_compact_meta/.test(args[1] ?? '')) { failNextM12 = false; return JSON.stringify({ ok: false, error: 'SYNTHETIC_M12_INTERRUPTED', code: 'EIO' }) }
    return native.sync(json)
  } }
  const fixture = await import(pathToFileURL(path.join(sandbox, 'fixture.mjs')))
  const test = async (name, action) => { console.log(`[android-canonical] ${name}`); const started = Date.now(); await action(); results.push({ name, passed: true, durationMs: Date.now() - started }) }
  for (const synchronized of [false, true]) await test(`schema11_${synchronized ? 'synchronized_copy' : 'existing_local_book'}`, () => {
    const project = path.posix.join(native.environment.filesDir, synchronized ? '同步旧作品' : '手机旧作品')
    const before = fixture.createOldCanonicalProject(project, randomUUID(), 11, synchronized)
    if (reproduce) {
      assert.throws(() => fixture.openOldCanonicalProject(project), /CANONICAL_SCHEMA_UPGRADE_UNSUPPORTED/)
      assert.deepEqual(fixture.inspectOldCanonicalProject(project), before)
      return
    }
    const opened = fixture.openOldCanonicalProject(project, synchronized)
    assert.equal(opened.version, 12); assert.equal(opened.foreignKeys, 1)
    const after = fixture.inspectOldCanonicalProject(project)
    assert.equal(after.domainHash, before.domainHash); assert.deepEqual(after.meta, before.meta); assert.equal(after.compactTables, 2)
    if (synchronized) { assert.equal(opened.sync.replicaId, before.meta.replica_id); assert.equal(after.batches, 0) }
    assert.equal(fixture.openOldCanonicalProject(project).version, 12)
  })
  if (!reproduce) {
    for (const version of [7, 8, 9, 10, 12]) await test(`schema${version}_canonical_project`, () => {
      const project = path.posix.join(native.environment.filesDir, `旧作品-${version}`), before = fixture.createOldCanonicalProject(project, randomUUID(), version)
      assert.equal(fixture.openOldCanonicalProject(project).version, 12)
      assert.equal(fixture.inspectOldCanonicalProject(project).domainHash, before.domainHash)
    })
    await test('interrupted_m12_rolls_back_and_reopens', () => {
      const project = path.posix.join(native.environment.filesDir, '中断重试'), before = fixture.createOldCanonicalProject(project, randomUUID(), 11)
      failNextM12 = true; assert.throws(() => fixture.openOldCanonicalProject(project), /SYNTHETIC_M12_INTERRUPTED/)
      assert.deepEqual(fixture.inspectOldCanonicalProject(project), before)
      assert.equal(fixture.openOldCanonicalProject(project).version, 12)
      assert.equal(fixture.inspectOldCanonicalProject(project).domainHash, before.domainHash)
    })
  }
  fs.writeFileSync(path.join(output, reproduce ? 'v144-reproduction.json' : 'validation.json'), JSON.stringify({ passed: true, physicalDevice: false, mode: reproduce ? 'unmodified-v144-source-reproduction' : 'android-production-alias-native-protocol', results }, null, 2))
  console.log(JSON.stringify({ passed: results.length, physicalDevice: false, reproduce }, null, 2))
} finally {
  native.close(); delete globalThis.AndroidBridge
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocalAppData
}
