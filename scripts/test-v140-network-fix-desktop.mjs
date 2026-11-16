/** Packaged proxy-form acceptance. Own D-drive profiles; no proxy/model/OAuth traffic. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { _electron as electron } from 'playwright'
import * as stage from './redesign/pages/stage.mjs'
import { readBuildFingerprint } from './test-build-fingerprint.mjs'

const root = path.resolve(import.meta.dirname, '..')
if (process.argv.includes('--help')) {
  console.log('Run after release/1.4.0-network-fix/win-unpacked/书童.exe is built. Uses a new D-drive profile seeded with the observed synthetic empty-host proxy. Opens real settings, refuses the empty host, fills HTTP / 127.0.0.1 / 17891 through the UI, verifies real config:set + disk persistence, fully exits and restarts, and checks all three restored fields. All HTTP(S) dispatch is blocked; no request is sent to proxy port 17891, a real model or Google. User profiles and novels are never accessed.')
  process.exit(0)
}
const exe = path.resolve(process.argv.find(value => value.startsWith('--executable='))?.slice(13)
  || path.join(root, 'release/1.4.0-network-fix/win-unpacked/书童.exe'))
const asar = path.join(path.dirname(exe), 'resources/app.asar')
assert.ok(fs.existsSync(exe) && fs.existsSync(asar), 'Build the network-fix Windows directory package first')
const runId = randomUUID().slice(0, 8)
const evidence = path.join(root, '.runtime/v140-network-fix-desktop', runId)
const tempRoot = path.join(path.dirname(root), '.t')
const scratch = path.join(tempRoot, `v14-net-${runId}`)
assert.equal(path.parse(scratch).root.toLowerCase(), 'd:\\', 'Acceptance profiles must remain on D')
const roots = Object.fromEntries(['canonical', 'legacy', 'electron', 'home', 'roaming', 'local']
  .map(name => [name, path.join(scratch, name)]))
for (const directory of [evidence, ...Object.values(roots)]) fs.mkdirSync(directory, { recursive: true })
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const build = () => {
  const { main, renderer, desktopBundle } = readBuildFingerprint(root)
  return { main, renderer, desktopBundle, executable: fileHash(exe), asar: fileHash(asar) }
}
const localCalendarDate = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
const expectedProxy = { enabled: true, type: 'http', host: '127.0.0.1', port: 17891 }
const legacyConfig = path.join(roots.legacy, 'config.json')
fs.writeFileSync(legacyConfig, JSON.stringify({ locale: 'zh-CN', theme: 'light',
  proxy: { ...expectedProxy, host: '' },
  // Avoid a startup update check before the post-launch network guards attach.
  updatePreferences: { lastAutomaticCheckDate: localCalendarDate(), lastCheckedAt: new Date().toISOString() },
}), { flag: 'wx' })
const legacyHash = fileHash(legacyConfig)
const report = { runId, evidence, scratch, executable: exe, build: build(), scriptSha256: fileHash(import.meta.filename),
  scope: 'Actual packaged Electron proxy settings and full process restart; synthetic D-drive profiles only',
  checks: [], screenshots: [], processes: [], pageErrors: [], launches: [],
  network: { blockedAttempts: 0, allowedDispatches: 0, modelRequests: 0, googleRequests: 0, realProxyRequestsTriggered: false },
  networkIsolation: 'Synthetic updater preferences skip the automatic check; startup Chromium proxy uses closed loopback port 9; every observed/new Electron session and main/renderer HTTP(S) dispatch is blocked before the form is used.',
  defaultUserProfileRead: false, defaultUserProfileWritten: false, originalNovelsRead: false, originalNovelsWritten: false,
  realProviderAcceptance: false, formalInstallerQualified: false }
let app, page, configFile, step = 'launch-new-package'
const pass = (name, details = {}) => { report.checks.push({ name, outcome: 'PASS', ...details }); console.log(JSON.stringify({ check: name, outcome: 'PASS' })) }
async function bounded(promise, label, milliseconds = 20_000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`NETWORK_FIX_PROBE_TIMEOUT: ${label}`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
const mainEvaluate = (fn, argument) => bounded(app.evaluate(fn, argument), 'main-process evaluation')
const invoke = (channel, ...args) => bounded(page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args }), `IPC ${channel}`)
const configProxy = async () => (await invoke('config:get')).proxy
const proxyCalls = () => mainEvaluate(() => globalThis.__networkFixProbe.proxyCalls)
const bodyText = () => page.locator('body').innerText()
const fields = () => ({ type: page.getByLabel('代理类型', { exact: true }), host: page.getByLabel('主机地址', { exact: true }), port: page.getByLabel('端口', { exact: true }) })
async function screenshot(name) {
  const file = path.join(evidence, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  report.screenshots.push({ name, path: file, sha256: fileHash(file) })
}
async function launch() {
  // The fixture may cross midnight while awaiting a rebuild; only its own
  // update preference is refreshed. Proxy fields are never changed here.
  if (configFile && fs.existsSync(configFile)) {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    if (config.updatePreferences?.lastAutomaticCheckDate !== localCalendarDate()) {
      config.updatePreferences = { ...config.updatePreferences, lastAutomaticCheckDate: localCalendarDate() }
      fs.writeFileSync(configFile, JSON.stringify(config))
    }
  }
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy, AI_NOVEL_VELA_HOME: roots.legacy,
    AI_NOVEL_ELECTRON_USER_DATA_DIR: roots.electron,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.roaming, LOCALAPPDATA: roots.local,
    TMP: tempRoot, TEMP: tempRoot }
  for (const key of Object.keys(env)) if (/^(?:https?_proxy|all_proxy|no_proxy|node_options|node_use_env_proxy|electron_run_as_node|vite_dev_server_url|ai_novel_smoke_.*)$/i.test(key)) delete env[key]
  app = await electron.launch({ cwd: root, executablePath: exe, env, timeout: 40_000,
    args: [`--user-data-dir=${roots.electron}`, '--disable-background-networking', '--disable-component-update',
      '--proxy-server=http=127.0.0.1:9;https=127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost;[::1]'] })
  const runtime = await mainEvaluate(async ({ app, BrowserWindow, session, ipcMain }) => {
    await app.whenReady()
    const probe = globalThis.__networkFixProbe = { blockedAttempts: 0, appliedRules: [], proxyCalls: [], guardedSessions: 0 }
    const guarded = new WeakSet()
    const deny = () => { probe.blockedAttempts++; return Promise.reject(new Error('NETWORK_FIX_PROBE_HTTP_DISABLED')) }
    const guard = active => {
      if (guarded.has(active)) return
      guarded.add(active); probe.guardedSessions++
      active.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { probe.blockedAttempts++; callback({ cancel: true }) })
      active.fetch = deny
      const setProxy = active.setProxy.bind(active)
      active.setProxy = async rule => { await setProxy(rule); probe.appliedRules.push({ ...rule }) }
    }
    guard(session.defaultSession)
    app.on('session-created', guard)
    const fromPartition = session.fromPartition.bind(session)
    const wrappedPartition = (...args) => { const active = fromPartition(...args); guard(active); return active }
    session.fromPartition = wrappedPartition
    if (session.fromPartition !== wrappedPartition) throw new Error('NETWORK_FIX_SESSION_GUARD_NOT_INSTALLED')
    globalThis.fetch = deny
    const original = ipcMain._invokeHandlers.get('config:set')
    if (!original) throw new Error('NETWORK_FIX_CONFIG_HANDLER_MISSING')
    ipcMain.removeHandler('config:set')
    ipcMain.handle('config:set', async (...args) => {
      const input = args[1], result = await original(...args)
      if (input && Object.hasOwn(input, 'proxy')) probe.proxyCalls.push({
        proxy: input.proxy ? { enabled: input.proxy.enabled, type: input.proxy.type, host: input.proxy.host, port: input.proxy.port } : null,
        success: result?.success === true, error: result?.success ? undefined : result?.error,
      })
      return result
    })
    const window = BrowserWindow.getAllWindows()[0]
    if (window) { window.setSize(1440, 900); window.show() }
    return { packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(), userData: app.getPath('userData'), visible: window?.isVisible() }
  })
  assert.equal(runtime.packaged, true); assert.equal(runtime.version, '1.4.0'); assert.match(runtime.appPath, /app\.asar$/iu)
  assert.equal(path.resolve(runtime.userData), path.resolve(roots.electron))
  report.processes.push(app.process().pid)
  page = await app.firstWindow({ timeout: 30_000 }); page.setDefaultTimeout(20_000)
  page.on('pageerror', error => report.pageErrors.push(error.message))
  await page.route(/^https?:\/\//u, route => { report.network.blockedAttempts++; return route.abort() })
  await stage.waitForStage(page); await stage.dismissMigrationNotice(page)
  const startup = await invoke('startup:get-state')
  assert.equal(startup.state, 'ready')
  configFile = path.join(roots.canonical, 'generations', startup.globalGeneration, 'config.json')
  assert.ok(path.resolve(configFile).startsWith(path.resolve(roots.canonical) + path.sep))
  assert.ok(fs.existsSync(configFile)); report.configFile = configFile
  report.launches.push({ ...runtime, pid: app.process().pid, globalGeneration: startup.globalGeneration })
}
async function close() {
  if (!app) return
  const closing = app, child = closing.process()
  const launchReport = report.launches.findLast(item => item.pid === child.pid)
    ?? { pid: child.pid, initializationIncomplete: true }
  if (!report.launches.includes(launchReport)) report.launches.push(launchReport)
  const observed = await bounded(closing.evaluate(() => globalThis.__networkFixProbe), 'read probe before cleanup', 1_500).catch(() => null)
  if (observed) { report.network.blockedAttempts += observed.blockedAttempts; launchReport.network = observed }
  const exited = () => child.exitCode !== null || child.signalCode !== null
  const waitForExit = async milliseconds => {
    const deadline = Date.now() + milliseconds
    while (!exited() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    return exited()
  }
  let shutdown = 'quit'
  await bounded(closing.evaluate(({ app }) => app.quit()), 'quit probe app', 1_500).catch(() => {})
  if (!await waitForExit(5_000)) {
    shutdown = 'forced-probe-exit'
    await bounded(closing.evaluate(({ app }) => app.exit(0)), 'force exit probe app', 1_500).catch(() => {})
    if (!await waitForExit(5_000)) { shutdown = 'killed-probe-child'; child.kill(); await waitForExit(5_000) }
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'The probe-owned app did not fully exit')
  await bounded(closing.close(), 'release exited probe process', 2_000).catch(() => {})
  launchReport.shutdown = shutdown
  app = null; page = null
}
async function openProxySettings() {
  await stage.openSettings(page); await stage.showSettingsPage(page, '网络代理')
  await fields().host.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '保存代理设置', exact: true }).waitFor({ state: 'visible' })
}

try {
  await launch(); await openProxySettings()
  const initial = fields()
  assert.equal(await initial.type.inputValue(), 'http'); assert.equal(await initial.host.inputValue(), '')
  assert.equal(await initial.port.inputValue(), '17891')
  assert.match(await initial.host.getAttribute('placeholder'), /必填/u)
  assert.match(await bodyText(), /已保存的代理地址不完整/u)
  const callsBefore = (await proxyCalls()).length
  await page.getByRole('button', { name: '保存代理设置', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '请填写代理地址' }).waitFor()
  assert.equal((await proxyCalls()).length, callsBefore, 'An empty host escaped local validation')
  assert.equal((await configProxy()).host, '')
  await screenshot('01-legacy-empty-host-explained')
  pass('legacy-empty-host-is-explained-without-silently-selecting-the-placeholder', { hostStillEmpty: true, proxyIpcDispatched: false })

  step = 'enter-real-three-fields-and-save'
  await initial.type.selectOption('http'); await initial.host.fill('127.0.0.1'); await initial.port.fill('17891')
  assert.equal(await initial.type.inputValue(), 'http'); assert.equal(await initial.host.inputValue(), '127.0.0.1'); assert.equal(await initial.port.inputValue(), '17891')
  await page.getByRole('button', { name: '保存代理设置', exact: true }).click()
  await page.locator('.stage-set-saved').filter({ hasText: /^已保存$/u }).waitFor()
  assert.deepEqual(await configProxy(), expectedProxy)
  const calls = await proxyCalls()
  assert.deepEqual(calls.at(-1)?.proxy, expectedProxy); assert.equal(calls.at(-1)?.success, true)
  const rules = await mainEvaluate(() => globalThis.__networkFixProbe.appliedRules)
  assert.ok(rules.some(rule => rule.mode === 'fixed_servers' && rule.proxyRules === 'http://127.0.0.1:17891'))
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).proxy, expectedProxy)
  report.savedConfigSha256 = fileHash(configFile)
  await screenshot('02-real-three-field-proxy-saved')
  pass('real-ui-three-fields-reach-the-original-ipc-handler-chromium-and-durable-config', { proxy: expectedProxy, configSha256: report.savedConfigSha256 })

  step = 'full-process-exit-and-restart'
  const firstPid = app.process().pid
  await close()
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).proxy, expectedProxy)
  await launch(); assert.notEqual(app.process().pid, firstPid)
  await openProxySettings()
  const reopened = fields()
  assert.equal(await reopened.type.inputValue(), 'http'); assert.equal(await reopened.host.inputValue(), '127.0.0.1'); assert.equal(await reopened.port.inputValue(), '17891')
  assert.deepEqual(await configProxy(), expectedProxy)
  assert.match(await bodyText(), /当前使用：自定义代理/u)
  assert.doesNotMatch(await bodyText(), /NETWORK_PROXY_CONFIG_INVALID|已保存的代理地址不完整/u)
  assert.equal((await proxyCalls()).length, 0, 'Reopening settings rewrote the saved proxy')
  await screenshot('03-three-fields-restored-after-real-restart')
  pass('full-process-restart-restores-the-canonical-proxy-without-writing-it-again', { firstPid, reopenedPid: app.process().pid, proxy: expectedProxy })
  report.outcome = 'PASS'
} catch (error) {
  report.outcome = 'FAIL'; report.failure = { step, message: error.stack || String(error) }; process.exitCode = 1
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {})
} finally {
  await close().catch(error => { report.outcome = 'FAIL'; report.cleanupError = String(error); process.exitCode = 1 })
  report.ownAppClosed = !app
  report.buildUnchangedDuringRun = JSON.stringify(build()) === JSON.stringify(report.build)
  report.syntheticLegacyConfigUnchanged = fileHash(legacyConfig) === legacyHash
  report.finishedAt = new Date().toISOString()
  if (!report.buildUnchangedDuringRun || !report.syntheticLegacyConfigUnchanged || report.pageErrors.length) { report.outcome = 'FAIL'; process.exitCode = 1 }
  const json = JSON.stringify(report, null, 2) + '\n'
  fs.writeFileSync(path.join(evidence, 'report.json'), json)
  fs.writeFileSync(path.join(root, '.runtime/v140-network-fix-desktop-report.json'), json)
  console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks.length, realProxyRequestsTriggered: false,
    ownAppClosed: report.ownAppClosed, evidence, failure: report.failure?.step }))
}
