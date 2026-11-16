/** Actual packaged Electron acceptance; all profiles, prose and models are synthetic. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { _electron as electron } from 'playwright'
import * as stage from './redesign/pages/stage.mjs'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { readBuildFingerprint } from './test-build-fingerprint.mjs'

const root = path.resolve(import.meta.dirname, '..')
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
if (process.argv.includes('--help')) {
  console.log('Run only after the 1.4.0 Windows directory package is ready. Launches the actual packaged Electron app visibly with entirely synthetic D-drive profiles/projects and a loopback SSE model. Checks imported final read-only safety, mainline continuation, independent branch routes, Models by stage, note-driven selection rewrite and real process reopen. No original novel, default user profile or real model account is accessed. Not a formal installer or real provider/device acceptance.')
  process.exit(0)
}
const exe = path.resolve(process.argv.find(value => value.startsWith('--executable='))?.slice(13)
  || path.join(root, 'release/1.4.0/win-unpacked/书童.exe'))
const asar = path.join(path.dirname(exe), 'resources/app.asar')
assert.ok(fs.existsSync(exe) && fs.existsSync(asar), 'Build the actual 1.4.0 packaged application first')
const id = randomUUID().slice(0, 8)
const evidence = path.join(root, '.runtime/v140-desktop', id)
const tempRoot = path.join(path.dirname(root), '.t')
const scratch = path.join(tempRoot, `v14-${id}`)
assert.equal(path.parse(scratch).root.toLowerCase(), 'd:\\', 'All acceptance data must remain on D')
const roots = Object.fromEntries(['canonical', 'legacy', 'electron', 'home', 'roaming', 'local', 'projects']
  .map(name => [name, path.join(scratch, name === 'projects' ? 'p' : name)]))
assert.ok(path.join(roots.projects, `V140-${id}`).length <= 85, 'Synthetic Windows project root exceeds the 85-character budget')
for (const directory of [evidence, ...Object.values(roots)]) fs.mkdirSync(directory, { recursive: true })
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const fileHash = file => hash(fs.readFileSync(file))
const desktopBuild = () => {
  const { main, renderer, desktopBundle } = readBuildFingerprint(root)
  return { main, renderer, desktopBundle, executable: fileHash(exe), asar: fileHash(asar) }
}
const countUnits = text => {
  const normalized = text.normalize('NFC'), han = normalized.match(/\p{Script=Han}/gu)?.length ?? 0
  const other = normalized.replace(/\p{Script=Han}/gu, ' '), words = /\p{L}[\p{L}\p{M}]*(?:['’]\p{L}[\p{L}\p{M}]*)*/gu
  return han + (other.match(words)?.length ?? 0) + [...other.replace(words, '').replace(/[\s\p{P}\p{S}]/gu, '')].length
}
const prose = '林岚走进北塔，发现一盏仍然亮着的灯。'
const rewritten = '我走进北塔，发现一盏仍然亮着的灯。'
const instruction = '把所选句子的第三人称改成第一人称，保留北塔和灯的事实。'
const report = { runId: id, evidence, scratch, scope: 'actual packaged Electron window; entirely synthetic fixture',
  executable: exe, build: desktopBuild(), scriptSha256: fileHash(import.meta.filename), checks: [], screenshots: [],
  loopbackRequests: [], pageErrors: [], network: { externalRequestsSent: 0, blockedAttempts: 0 },
  networkIsolation: 'Startup proxy routes non-loopback Electron traffic to closed loopback port; session request and main fetch guards admit only the fixture origin',
  originalNovelsRead: false, originalNovelsWritten: false, defaultUserProfileRead: false,
  browserTestSubstitutedForElectron: false, formalInstallerQualified: false, realProviderAcceptance: false }
let app, page, projectPath, session, draftId, providerFailure, phase, step = 'start-loopback-model'
let branchId, branchRouteId, originalFinals
const modelA = { id: `v140-default-${id}`, name: '合成默认模型 A', provider: 'openai', protocol: 'openai', modelName: 'v140-default-fixture',
  baseUrl: '', apiKey: 'SYNTHETIC_LOCAL_ONLY', maxTokens: 4096, temperature: 0.3, purposes: ['generation'],
  capabilities: { contextWindowTokens: 262144, maxOutputTokens: 4096, reasoning: false, structuredOutput: true, usage: true } }
const modelB = { ...modelA, id: `v140-drafting-${id}`, name: '合成写稿模型 B', modelName: 'v140-drafting-fixture' }
const pass = (name, details = {}) => {
  report.checks.push({ name, outcome: 'PASS', ...details })
  console.log(JSON.stringify({ check: name, outcome: 'PASS' }))
}
const success = value => { assert.equal(value?.success, true, value?.error || 'Public IPC operation failed'); return value }
const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
async function waitFor(read, predicate, label, timeout = 35_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (providerFailure) throw providerFailure
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`V140_DESKTOP_TIMEOUT: ${label}`)
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, `Bearer ${modelB.apiKey}`)
    assert.equal(phase, 'selection-rewrite', 'Model call preceded the explicit synthetic rewrite action')
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(payload.model, modelB.modelName, 'The inline operation ignored the real Models by stage assignment')
    assert.equal(payload.stream, true)
    const prompt = payload.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    assert.ok(prompt.includes(instruction)); assert.ok(prompt.includes('林岚走进北塔'))
    report.loopbackRequests.push({ modelName: payload.model, action: phase, instructionPresent: true, selectedTextPresent: true, stream: true })
    assert.equal(report.loopbackRequests.length, 1, 'Unexpected additional model request')
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: rewritten }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  } catch (error) {
    providerFailure = error
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Synthetic desktop model boundary failed' } }))
  }
})
async function launch() {
  const env = { ...process.env, AI_NOVEL_SYNC_PROJECTS_HOME: path.join(scratch, 's'), AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy,
    AI_NOVEL_VELA_HOME: roots.legacy, AI_NOVEL_ELECTRON_USER_DATA_DIR: roots.electron,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.roaming, LOCALAPPDATA: roots.local,
    TMP: tempRoot, TEMP: tempRoot }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
  app = await electron.launch({ cwd: root, executablePath: exe, args: [`--user-data-dir=${roots.electron}`,
    '--proxy-server=http=127.0.0.1:9;https=127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost;[::1]'], env, timeout: 40_000 })
  const runtime = await app.evaluate(async ({ app, BrowserWindow, session, ipcMain }, origin) => {
    await app.whenReady()
    globalThis.__v140Network = { blocked: 0 }; globalThis.__v140Project = null
    const admit = value => {
      try { return new URL(value).origin === origin } catch { return false }
    }
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      if (admit(details.url)) callback({})
      else { globalThis.__v140Network.blocked++; callback({ cancel: true }) }
    })
    await session.defaultSession.setProxy({ proxyRules: 'http=127.0.0.1:9;https=127.0.0.1:9', proxyBypassRules: '127.0.0.1;localhost;[::1]' })
    const fetchOriginal = globalThis.fetch
    globalThis.fetch = (input, options) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      if (!admit(url)) { globalThis.__v140Network.blocked++; throw new Error('V140_EXTERNAL_NETWORK_BLOCKED') }
      return fetchOriginal(input, options)
    }
    const window = BrowserWindow.getAllWindows()[0]
    if (window) { window.setSize(1440, 900); window.show() }
    return { packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(), userData: app.getPath('userData'),
      visible: window?.isVisible(), minimized: window?.isMinimized() }
  }, new URL(modelA.baseUrl).origin)
  assert.equal(runtime.packaged, true); assert.equal(runtime.version, expectedVersion); assert.match(runtime.appPath, /app\.asar$/i)
  assert.equal(path.resolve(runtime.userData), path.resolve(roots.electron))
  report.actualRuntime = runtime
  page = await app.firstWindow({ timeout: 35_000 }); page.setDefaultTimeout(25_000)
  const windowState = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(1440, 900); window.show()
    return { visible: window.isVisible(), minimized: window.isMinimized(), contentSize: window.getContentSize() }
  })
  assert.equal(windowState.visible, true); report.actualRuntime = { ...runtime, ...windowState }
  page.on('pageerror', error => report.pageErrors.push(error.message))
  await page.route(/^https?:\/\//, route => {
    if (new URL(route.request().url()).origin === new URL(modelA.baseUrl).origin) return route.continue()
    report.network.blockedAttempts++; return route.abort()
  })
  await stage.waitForStage(page); await stage.dismissMigrationNotice(page)
  assert.equal((await invoke('startup:get-state')).state, 'ready')
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('project:open')
    if (!original) throw new Error('V140_PROJECT_OBSERVER_UNAVAILABLE')
    ipcMain.removeHandler('project:open'); ipcMain.handle('project:open', async (...args) => {
      const result = await original(...args)
      if (result.success) globalThis.__v140Project = { id: result.project.id, path: result.project.path, name: result.project.name, sessionLease: result.project.sessionLease }
      return result
    })
  })
}
async function close() {
  if (!app) return
  report.network.blockedAttempts += await app.evaluate(() => globalThis.__v140Network?.blocked || 0).catch(() => 0)
  await app.evaluate(({ app }) => app.quit()).catch(() => {})
  await app.close().catch(() => {}); app = null
}
async function screenshot(name) {
  const file = path.join(evidence, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true }); report.screenshots.push({ name, path: file, sha256: fileHash(file) })
}
async function openProjectUi() {
  await stage.showLibrary(page); await stage.openFromLibrary(page, `V140-${id}`); await stage.waitForWork(page, `V140-${id}`)
  const opened = await waitFor(() => app.evaluate(() => globalThis.__v140Project), value => Boolean(value?.sessionLease), 'UI project open')
  assert.equal(path.resolve(opened.path), path.resolve(projectPath))
  session = { projectId: opened.id, projectPath, leaseId: opened.sessionLease }
}
const readStory = async () => success(await invoke('story:read', { projectSession: session })).data
const blueprints = () => invoke('db:blueprint-get-all', projectPath, session)
const card = () => page.locator('.stage-bp-card')
async function openBlueprint() { await stage.stageButton(page, '蓝图').click(); await page.locator('.stage-bp .story-tree-card[data-story-node="chapter:1"]').waitFor() }
async function selectNode(nodeId) {
  await page.locator(`.stage-bp .story-tree-card[data-story-node="${nodeId}"] .story-tree-card-select`).click()
  await page.locator(`.chapter-tree-inspector[data-selected-story-node="${nodeId}"]`).waitFor()
}
async function openMainline(number) {
  await stage.stageButton(page, '正文').click()
  await page.locator('.stage-manuscript-routes,.stage-chapters').first().waitFor()
  const routed = stage.spine(page).locator(`button[data-story-node="chapter:${number}"][data-story-route="mainline"]`)
  if (await routed.count()) await routed.click()
  else await stage.spine(page).getByRole('button', { name: new RegExp(`^${number}\\D`) }).first().click()
  await page.locator('.stage-ch .cm-content').waitFor()
}
const currentDocument = () => page.locator('.stage-ch .cm-content').evaluate(element => {
  const view = element.cmTile?.root?.view ?? element.cmView?.view
  if (!view?.state?.doc) throw new Error('V140_CODEMIRROR_DOCUMENT_UNAVAILABLE')
  return view.state.doc.toString()
})
async function finals() {
  const rows = []
  for (const number of [1, 2]) {
    const drafts = await invoke('db:draft-list', number, projectPath, session)
    for (const draft of drafts) rows.push(await invoke('db:draft-get-full', draft.id, projectPath, session))
  }
  return rows.map(row => ({ id: row.id, chapterNumber: row.chapterNumber, version: row.version, status: row.status,
    authoritativeFinalized: row.authoritativeFinalized, contentSha256: hash(row.content), wordCount: row.wordCount }))
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  modelA.baseUrl = modelB.baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  step = 'launch-real-package-and-seed-synthetic-fixture'
  await launch()
  success(await invoke('llm:save-model', modelA)); success(await invoke('llm:save-model', modelB)); success(await invoke('llm:set-default-model', modelA.id))
  const grant = await chooseProjectDirectoryGrant(app, page, roots.projects)
  const created = success(await invoke('project:create', { parentGrantId: grant.grantId, name: `V140-${id}`, genre: '合成验收', targetAudience: '合成读者', writingLanguage: 'zh-CN' }, randomUUID(), null))
  projectPath = created.projectPath
  assert.ok(projectPath.length <= 85, 'Created Windows fixture project exceeds the path budget')
  assert.ok(path.relative(roots.projects, projectPath) && !path.relative(roots.projects, projectPath).startsWith('..'))
  const opened = success(await invoke('project:open', projectPath, randomUUID(), null))
  session = { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
  const imported = success(await invoke('db:draft-import-finalized-batch', { operationId: `v140-import-${id}`, chapters: [1, 2].map(number => {
    const content = number === 1 ? '林岚沿着河岸来到北塔，铜钥匙一直握在手中。' : '林岚推开北塔的门，看见楼梯上留着一盏灯。'
    return { chapterNumber: number, title: `合成定稿第${number}章`, content, wordCount: countUnits(content) }
  }) }, projectPath, session))
  for (const item of imported.receipt.drafts) success(await invoke('finalization:retry', item.finalizationId, session))
  originalFinals = await finals(); assert.equal(originalFinals.length, 2); assert.deepEqual(await blueprints(), [])
  pass('packaged-electron-and-synthetic-finalized-import', { packaged: true, visibleWindow: true, importedChapters: 2, fabricatedBlueprints: 0 })
  await close(); await launch(); await openProjectUi()

  step = 'continue-imported-mainline-tail'
  await openBlueprint(); await selectNode('chapter:2')
  await page.locator('.chapter-tree-inspector').getByRole('button', { name: '继续下一章', exact: true }).click()
  await page.locator('.chapter-tree-inspector[data-selected-story-node="chapter:3"]').waitFor()
  await card().getByLabel('章节标题', { exact: true }).fill('合成主线第三章：北塔的灯')
  await card().getByLabel(/主角小目标/).fill('查清北塔灯光的来源，保持钥匙仍由林岚持有。')
  await card().getByRole('button', { name: '保存此章', exact: true }).click()
  await waitFor(blueprints, rows => rows.length === 1 && rows[0].chapterNumber === 3, 'new mainline blueprint saved')
  let story = await readStory()
  assert.deepEqual(story.routes.find(route => route.id === 'mainline').nodeIds, ['chapter:1', 'chapter:2', 'chapter:3'])
  assert.equal(story.nodes.filter(node => !node.mainline).length, 0)
  assert.deepEqual(await finals(), originalFinals)
  await screenshot('01-mainline-continuation')
  pass('imported-tail-continues-to-mainline-three', { onlyBlueprintChapter: 3, importedFinalsUnchanged: true })

  step = 'independent-branch-route'
  await selectNode('chapter:2')
  await page.locator('.stage-bp').getByRole('button', { name: '从本章分支', exact: true }).click()
  story = await waitFor(readStory, value => value.nodes.some(node => !node.mainline), 'new independent chapter')
  const branch = story.nodes.find(node => !node.mainline)
  branchId = branch.id; branchRouteId = story.routes.find(route => route.id !== 'mainline' && route.nodeIds.includes(branch.id))?.id
  assert.ok(branchRouteId); assert.notEqual(branchId, 'chapter:3')
  await card().getByLabel('章节标题', { exact: true }).fill('合成支线：沿河调查')
  await card().getByLabel(/主角小目标/).fill(`SYNTHETIC_BRANCH_PURPOSE_${id}`)
  await card().getByRole('button', { name: '保存此章', exact: true }).click()
  await waitFor(readStory, value => value.nodes.find(node => node.id === branchId)?.chapterBlueprint?.purpose === `SYNTHETIC_BRANCH_PURPOSE_${id}`, 'branch blueprint saved')
  story = await readStory()
  assert.ok(story.edges.some(edge => edge.from === 'chapter:2' && edge.to === branchId))
  assert.ok(story.edges.some(edge => edge.from === 'chapter:2' && edge.to === 'chapter:3'))
  await page.locator('.stage-bp .story-tree').getByRole('button', { name: '适应画布', exact: true }).click()
  await screenshot('02-independent-branch-and-mainline')
  pass('independent-branch-keeps-mainline-and-route-identity', { branchId, branchRouteId, independentUuid: true })

  step = 'real-models-by-stage-settings'
  await stage.openSettings(page); await stage.showSettingsPage(page, '分工模型')
  const drafting = page.locator('[data-stage="drafting"] select')
  await drafting.selectOption(modelB.id)
  await waitFor(() => invoke('config:get'), config => config.stageModelIds?.drafting === modelB.id, 'persisted drafting assignment')
  assert.equal(await drafting.inputValue(), modelB.id)
  await screenshot('03-v140-models-by-stage')
  pass('v140-models-by-stage-saved-through-real-settings-window', { defaultModel: modelA.id, draftingModel: modelB.id })
  await stage.closeSettings(page)

  step = 'synthetic-editable-draft'
  const createdDraft = success(await invoke('db:draft-create', { chapterNumber: 3, version: 1, source: 'write', content: prose, wordCount: countUnits(prose) }, projectPath, session))
  draftId = createdDraft.id
  const oldLease = session.leaseId
  await close(); await launch(); await openProjectUi(); assert.notEqual(session.leaseId, oldLease)
  await openMainline(3); await waitFor(currentDocument, body => body === prose, 'editable synthetic third chapter')
  assert.equal(await page.locator('.stage-ch .cm-content').getAttribute('contenteditable'), 'true')
  step = 'real-selection-note-and-loopback-dispatch'
  await page.locator('.stage-ch .cm-line').filter({ hasText: prose }).click({ clickCount: 3 })
  await page.getByRole('button', { name: '按意见改', exact: true }).click()
  await page.getByRole('textbox', { name: '修改意见', exact: true }).fill(instruction)
  phase = 'selection-rewrite'
  await page.getByRole('button', { name: '改写', exact: true }).click()
  await page.getByText('按意见改预览', { exact: true }).waitFor()
  await page.locator('.cm-selbar-text').filter({ hasText: rewritten }).waitFor()
  assert.equal(await currentDocument(), prose, 'The model candidate was applied without author approval')
  assert.equal(report.loopbackRequests.length, 1)
  await screenshot('04-v140-selection-rewrite-preview')
  await page.getByRole('button', { name: '替换', exact: true }).click()
  await waitFor(currentDocument, body => body === rewritten, 'author-accepted replacement')
  await page.locator('.stage-ch .cm-content').click(); await page.keyboard.press('Control+s')
  await waitFor(() => invoke('db:draft-get-full', draftId, projectPath, session), draft => draft.content === rewritten, 'saved accepted rewrite')
  await screenshot('05-v140-selection-rewrite-saved')
  pass('v140-note-driven-selection-rewrite-uses-drafting-model-after-author-approval', { physicalLoopbackModelRequests: 1, requestedModelName: modelB.modelName, saved: true, preApprovalDocumentUnchanged: true })

  step = 'imported-finals-remain-readonly'
  await openMainline(2)
  const originalBody = await currentDocument()
  await page.locator('.stage-ch-prose[data-readonly="true"] .cm-content').waitFor()
  assert.equal(await page.locator('.stage-ch .cm-content').getAttribute('contenteditable'), 'false')
  await page.locator('.stage-ch .cm-content').click(); await page.keyboard.type('不可写入的合成探针')
  assert.equal(await currentDocument(), originalBody)
  assert.deepEqual(await finals(), originalFinals)
  await screenshot('06-imported-final-readonly')
  pass('imported-final-draft-identities-and-text-remain-readonly', { chapters: [1, 2], contentHashesUnchanged: true, keyboardProbeBlocked: true })

  step = 'real-process-reopen-persistence'
  const priorLease = session.leaseId
  await close(); await launch(); await openProjectUi(); assert.notEqual(session.leaseId, priorLease)
  assert.equal((await invoke('config:get')).stageModelIds?.drafting, modelB.id)
  assert.equal((await invoke('db:draft-get-full', draftId, projectPath, session)).content, rewritten)
  assert.deepEqual(await finals(), originalFinals)
  story = await readStory(); assert.ok(story.routes.find(route => route.id === branchRouteId)?.nodeIds.includes(branchId))
  assert.deepEqual((await blueprints()).map(item => item.chapterNumber), [3])
  await openMainline(3); await waitFor(currentDocument, body => body === rewritten, 'persisted rewritten draft after full process restart')
  await screenshot('07-reopened-v140-persistence')
  pass('real-process-reopen-preserves-model-routing-branch-and-rewritten-draft', { freshLease: true, unchangedImportedFinals: true })
  report.outcome = 'PASS'
} catch (error) {
  report.outcome = 'FAIL'; report.failure = { step, message: error.stack || String(error) }; process.exitCode = 1
  if (page && !page.isClosed()) { await screenshot('failure').catch(() => {}); report.failure.visibleSyntheticText = await page.locator('body').innerText().then(value => value.slice(-7000)).catch(() => '') }
} finally {
  await close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  report.buildUnchangedDuringRun = JSON.stringify(desktopBuild()) === JSON.stringify(report.build)
  report.ownAppClosed = !app
  report.finishedAt = new Date().toISOString()
  if (!report.buildUnchangedDuringRun || report.pageErrors.length || providerFailure) { report.outcome = 'FAIL'; process.exitCode = 1 }
  const json = JSON.stringify(report, null, 2) + '\n'
  fs.writeFileSync(path.join(evidence, 'report.json'), json)
  fs.writeFileSync(path.join(root, '.runtime/v140-desktop-report.json'), json)
  console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks.length, loopbackRequests: report.loopbackRequests.length,
    externalRequestsSent: report.network.externalRequestsSent, blockedExternalAttempts: report.network.blockedAttempts, failure: report.failure?.step, evidence }))
}
