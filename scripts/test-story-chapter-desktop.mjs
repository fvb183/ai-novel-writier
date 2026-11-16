/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import * as stage from './redesign/pages/stage.mjs'
import * as blueprint from './redesign/pages/blueprint.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv.includes('--help')) {
  console.log('Run after the final desktop build and Electron native preparation. Uses independent workspace profiles/projects and a loopback-only synthetic OpenAI server. Does not use real provider accounts or close existing app instances.')
  process.exit(0)
}
const runId = randomUUID().slice(0, 8)
const scratch = path.join(path.dirname(repository), '.e2e', runId)
const evidence = path.join(repository, '.runtime', 'story-chapter-desktop', runId)
const roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'projects'].map(name => [name, path.join(scratch, name)]))
for (const [name, directory] of Object.entries(roots)) if (name !== 'canonical') fs.mkdirSync(directory, { recursive: true })
fs.mkdirSync(evidence, { recursive: true })
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const marker = chapter => `E2E_SOURCE_CHAPTER_${chapter}_${runId}`
const projectName = 'Story'
const model = { id: `story-e2e-${runId}`, name: '本地分支验收模型', provider: 'openai', protocol: 'openai', modelName: 'story-fixture',
  baseUrl: '', apiKey: 'synthetic-loopback-only', maxTokens: 4096, temperature: 0.4, purposes: ['generation'],
  capabilities: { contextWindowTokens: 32768, maxOutputTokens: 4096, reasoning: false, structuredOutput: true, usage: true } }
const report = { runId, scratch, evidence, realProviderRequests: 0, checks: [], requests: [], pageErrors: [],
  build: { main: fileHash(path.join(repository, 'dist-electron/main.js')), renderer: fileHash(path.join(repository, 'dist/index.html')) } }
let phase, providerFailure, application, page, session, projectPath
const draftIds = []
let step = 'start-loopback-provider'
const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const storyRead = async () => {
  const response = await invoke('story:read', { projectSession: session })
  assert.equal(response.success, true, response.error)
  return response.data
}
async function waitFor(read, predicate, name, timeout = 30_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (providerFailure) throw providerFailure
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`STORY_DESKTOP_TIMEOUT: ${name}`)
}
const passed = (name, observations = {}) => report.checks.push({ name, outcome: 'PASS', ...observations })

const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, `Bearer ${model.apiKey}`)
    assert.ok(phase, 'A model request was sent before the author started a chapter')
    const parts = []
    for await (const part of request) parts.push(part)
    const payload = JSON.parse(Buffer.concat(parts).toString('utf8'))
    assert.equal(payload.model, model.modelName)
    assert.equal(payload.stream, true)
    const prompt = (payload.messages ?? []).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')).join('\n')
    const round = ++phase.round
    assert.ok(round <= (phase.reviewOnly ? 1 : 3), 'The synthetic agent exceeded its expected model turns')
    const boundary = { phase: phase.name, round, parentPresent: prompt.includes(marker(phase.afterChapter)),
      blueprintPresent: prompt.includes(phase.purpose), excludedFutureAbsent: !prompt.includes(marker(4)),
      bridgePresent: !phase.bridgeToNodeId || prompt.includes(marker(3)),
      messageRoles: payload.messages.map(message => message.role) }
    report.requests.push(boundary)
    assert.equal(boundary.parentPresent, true, 'Parent manuscript was missing from the selected writing context')
    assert.equal(boundary.blueprintPresent, true, 'The independent branch blueprint was missing')
    assert.equal(boundary.excludedFutureAbsent, true, 'Unselected future mainline content leaked into the prompt')
    assert.equal(boundary.bridgePresent, true, 'The explicitly selected continuation was missing')
    if (phase.reviewOnly) {
      assert.ok(prompt.includes('本次只读审稿'), 'The review omitted its read-only author instruction')
      assert.ok(prompt.includes(phase.prose), 'The review omitted the current saved manuscript')
    }
    const requestContext = { node_id: phase.nodeId, route_id: phase.routeId, mode: 'route',
      ...(phase.bridgeToNodeId ? { bridge_to_node_id: phase.bridgeToNodeId } : {}) }
    const { revisionId: _revision, ...target } = phase.target
    const content = phase.reviewOnly ? phase.reviewText : round === 1
      ? `<tool_call>${JSON.stringify({ name: 'read_story_context', arguments: requestContext })}</tool_call>`
      : round === 2
        ? `以下是按独立蓝图撰写的候选，请作者审核。\n<tool_call>${JSON.stringify({ name: 'propose_story_changes', arguments: {
          operations: [{ type: 'put-node', node: { ...target, body: phase.prose } }],
        } })}</tool_call>`
        : '候选已按作者批准保存，父级连接与主线正文保持原样。'
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.write('data: {"choices":[],"usage":{"prompt_tokens":300,"completion_tokens":180,"total_tokens":480}}\n\n')
    response.end('data: [DONE]\n\n')
  } catch (error) {
    providerFailure = error
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Synthetic story provider assertion failed' } }))
  }
})

async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy,
    AI_NOVEL_VELA_HOME: roots.legacy, HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  application = await electron.launch({ cwd: repository, args: ['.', `--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  page = await application.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => report.pageErrors.push(error.message))
  await page.route(/^https?:\/\//, route => new URL(route.request().url()).origin === new URL(model.baseUrl).origin ? route.continue() : route.abort())
  await page.locator(stage.STAGE_SHELL).waitFor({ state: 'visible' })
  assert.equal((await invoke('startup:get-state')).state, 'ready')
  await application.evaluate(({ ipcMain }, origin) => {
    // Test observation only: return the production handler's result unchanged.
    const original = ipcMain._invokeHandlers.get('project:open')
    if (!original) throw new Error('PROJECT_OPEN_OBSERVER_UNAVAILABLE')
    ipcMain.removeHandler('project:open')
    ipcMain.handle('project:open', async (...args) => {
      const response = await original(...args)
      if (response.success) globalThis.__storyDesktopProject = response.project
      return response
    })
    globalThis.__storyDesktopWrites = []
    for (const channel of ['story:commit', 'story:fork-chapter', 'agent-generation:commit-domain-tool']) {
      const handler = ipcMain._invokeHandlers.get(channel)
      if (!handler) throw new Error('STORY_WRITE_OBSERVER_UNAVAILABLE')
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        globalThis.__storyDesktopWrites.push(channel)
        return handler(...args)
      })
    }
    globalThis.__storyDesktopExternalRequests = 0
    const productionFetch = globalThis.fetch
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
      if (url.origin !== origin || url.pathname !== '/v1/chat/completions' || url.search) {
        globalThis.__storyDesktopExternalRequests++
        throw new Error('STORY_DESKTOP_EXTERNAL_NETWORK_BLOCKED')
      }
      return productionFetch(input, options)
    }
  }, new URL(model.baseUrl).origin)
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(roots.userData))
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible())), true)
}
async function closeOwnApplication() {
  if (!application) return
  report.realProviderRequests += await application.evaluate(() => globalThis.__storyDesktopExternalRequests ?? 0).catch(() => 0)
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await application.close().catch(() => {})
  application = null
}
async function currentSession() {
  const opened = await application.evaluate(() => globalThis.__storyDesktopProject)
  assert.ok(opened?.sessionLease, 'The UI did not open the fixture project')
  return { projectId: opened.id, projectPath: opened.path, leaseId: opened.sessionLease }
}
async function mainlineState() {
  return { blueprints: await invoke('db:blueprint-get-all', projectPath, session),
    drafts: await Promise.all(draftIds.map(id => invoke('db:draft-get-full', id, projectPath, session))) }
}
async function openBlueprint(number) {
  await blueprint.open(page)
  await blueprint.planItem(page, number).click()
  await page.getByRole('region', { name: `第 ${number} 章蓝图`, exact: true }).waitFor()
}
async function captureOverview(name) {
  const editor = page.getByRole('region', { name: '剧情分支编辑器', exact: true })
  await editor.getByRole('button', { name: '章节蓝图', exact: true }).click()
  await editor.getByRole('button', { name: '适应画布', exact: true }).click()
  await page.evaluate(() => {
    document.querySelector('.story-inspector-body')?.scrollTo({ top: 0 })
    const frame = document.querySelector('.stage-plot-frame'), tree = document.querySelector('.story-editor-layout')
    if (frame && tree) frame.scrollTop += tree.getBoundingClientRect().top - frame.getBoundingClientRect().top - 12
  })
  await page.screenshot({ path: path.join(evidence, `${name}-tree-overview.png`), fullPage: true })
  await page.screenshot({ path: path.join(evidence, 'desktop-tree-overview.png'), fullPage: true })
}
async function reviewSavedContinuity() {
  step = 'insert-read-only-continuity-review'
  const editor = page.getByRole('region', { name: '剧情分支编辑器', exact: true })
  const beforeStory = await storyRead(), beforeMainline = await mainlineState()
  const beforeWrites = await application.evaluate(() => [...globalThis.__storyDesktopWrites])
  const reviewMarker = `E2E_REVIEW_${runId}`
  const previous = phase
  phase = { ...previous, name: 'insert-review', round: 0, reviewOnly: true,
    target: beforeStory.nodes.find(node => node.id === previous.nodeId),
    reviewText: `${reviewMarker}\n\n冲突：暂未发现已证实的衔接冲突。\n证据：当前正文承接父级灯信，指定后文是未来约束，未当作已发生事实。\n修改建议：保持物品归属和灯信因果；不足以判断的状态留给作者核对。` }
  assert.equal(await editor.getByLabel('接入后文（可选）', { exact: true }).inputValue(), phase.bridgeToNodeId)
  await editor.getByRole('button', { name: '审查衔接一致性', exact: true }).click()
  const assistant = page.getByRole('complementary', { name: 'AI 写作助手', exact: true })
  await assistant.getByText(reviewMarker, { exact: false }).waitFor({ timeout: 45_000 })
  await waitFor(() => editor.getByRole('button', { name: '审查衔接一致性', exact: true }).isEnabled(), value => value, 'read-only review completion')
  assert.equal(phase.round, 1)
  assert.equal(await assistant.getByRole('region', { name: '剧情分支变更预览', exact: true }).count(), 0)
  assert.equal(await assistant.getByRole('button', { name: '批准执行', exact: true }).count(), 0)
  assert.deepEqual(await storyRead(), beforeStory, 'The read-only review changed story records or manuscript history')
  assert.deepEqual(await mainlineState(), beforeMainline, 'The read-only review changed mainline records')
  assert.deepEqual(await application.evaluate(() => [...globalThis.__storyDesktopWrites]), beforeWrites, 'The review invoked a story/domain write channel')
  await page.screenshot({ path: path.join(evidence, 'insert-read-only-review.png'), fullPage: true })
  passed('insert-read-only-continuity-review', { physicalModelRequests: 1, storyWriteChannels: 0, noProposal: true,
    wholeStoryAndHistoryUnchanged: true, mainlineUnchanged: true, explicitBridge: phase.bridgeToNodeId })
  await assistant.getByRole('button', { name: '收起助手', exact: true }).click()
  await captureOverview('insert')
}
async function createAndGenerate({ afterChapter, placement, name, bridge }) {
  step = `${name}-source-entry`
  await openBlueprint(afterChapter)
  if (placement === 'branch') await page.getByLabel('章节标题', { exact: true }).fill('第三章父级蓝图已保存修订')
  await page.getByRole('button', { name: placement === 'insert' ? '在两章间插入' : '从本章分支', exact: true }).click()
  if (placement === 'insert') await page.getByRole('dialog', { name: '插入独立章节', exact: true }).getByRole('button', { name: '创建插章', exact: true }).click()
  const editor = page.getByRole('region', { name: '剧情分支编辑器', exact: true })
  await editor.waitFor()
  await editor.getByLabel('分支章节标题', { exact: true }).waitFor()
  const nodeId = await editor.getByLabel('当前节点', { exact: true }).inputValue()
  const routeId = await editor.getByLabel('当前路线', { exact: true }).inputValue()
  assert.ok(nodeId && routeId)
  const purpose = `${name.toUpperCase()}_BLUEPRINT_PURPOSE_${runId}`
  await editor.getByLabel('分支章节标题', { exact: true }).fill(name === 'branch' ? '支线：沿北堤调查' : '插章：雨夜灯信')
  await editor.getByLabel('本章目标', { exact: true }).fill(purpose)
  await editor.getByLabel('冲突与关键事件', { exact: true }).fill('林岚沿岸调查，发现灯信，再决定下一步行动。')
  await editor.getByLabel('作者微操指导', { exact: true }).fill('只落实本章蓝图，保留此前事实。')
  assert.equal(await editor.getByRole('button', { name: '按蓝图生成章节', exact: true }).isDisabled(), true)
  await editor.getByRole('button', { name: '保存分支内容', exact: true }).click()
  await page.getByText('分支内容已保存。', { exact: true }).waitFor()
  let snapshot = await storyRead()
  const target = snapshot.nodes.find(node => node.id === nodeId)
  const parentEdges = snapshot.edges.filter(edge => edge.to === nodeId)
  assert.equal(target.body, '')
  assert.equal(target.chapterBlueprint.purpose, purpose)
  assert.equal(parentEdges.length, 1)
  assert.equal(snapshot.nodes.find(node => node.id === parentEdges[0].from).chapterSource.chapterNumber, afterChapter)
  let bridgeToNodeId
  if (bridge) {
    bridgeToNodeId = snapshot.edges.find(edge => edge.from === nodeId && snapshot.nodes.find(node => node.id === edge.to)?.chapterSource?.chapterNumber === 3)?.to
    assert.ok(bridgeToNodeId, 'The inserted chapter did not reconnect to chapter 3')
    await editor.getByLabel('接入后文（可选）', { exact: true }).selectOption(bridgeToNodeId)
  }
  const request = { nodeId, routeId, mode: 'route', ...(bridgeToNodeId ? { bridgeToNodeId } : {}) }
  const context = await invoke('story:context', { ...request, projectSession: session })
  assert.equal(context.success, true, context.error)
  assert.equal(context.data.readyForGeneration, true)
  assert.equal(context.data.prefix.some(node => node.body.includes(marker(4))), false)
  if (bridgeToNodeId) assert.equal(context.data.continuation.node.id, bridgeToNodeId)
  const beforeMainline = await mainlineState()
  const prose = `${name.toUpperCase()}_APPROVED_PROSE_${runId}：林岚沿北堤前行，循父级留下的灯信找到了线索。`
  phase = { name, nodeId, routeId, afterChapter, bridgeToNodeId, purpose, prose, target, round: 0 }
  await editor.getByLabel('本次生成模型', { exact: true }).selectOption(model.id)
  await page.screenshot({ path: path.join(evidence, `${name}-blueprint.png`), fullPage: true })
  step = `${name}-generate-and-confirm`
  await editor.getByRole('button', { name: '按蓝图生成章节', exact: true }).click()
  const assistant = page.getByRole('complementary', { name: 'AI 写作助手', exact: true })
  await assistant.getByRole('region', { name: '剧情分支变更预览', exact: true }).waitFor({ timeout: 45_000 })
  assert.equal((await storyRead()).nodes.find(node => node.id === nodeId).body, '', 'The candidate was committed before author approval')
  await page.screenshot({ path: path.join(evidence, `${name}-candidate.png`), fullPage: true })
  await assistant.getByRole('button', { name: '批准执行', exact: true }).click()
  snapshot = await waitFor(storyRead, value => value.nodes.find(node => node.id === nodeId)?.body === prose && phase.round === 3, `${name} approved manuscript`)
  const savedTarget = snapshot.nodes.find(node => node.id === nodeId)
  assert.deepEqual(savedTarget.chapterBlueprint, target.chapterBlueprint)
  assert.deepEqual(snapshot.edges.filter(edge => edge.to === nodeId), parentEdges)
  assert.deepEqual(await mainlineState(), beforeMainline, 'Story generation changed mainline blueprints or drafts')
  assert.equal(phase.round, 3)
  await assistant.getByRole('button', { name: '收起助手', exact: true }).click()
  await editor.getByRole('button', { name: '正文与事件', exact: true }).click()
  await editor.getByLabel('节点正文', { exact: true }).waitFor()
  await waitFor(() => editor.getByLabel('节点正文', { exact: true }).inputValue(), value => value === prose, `${name} manuscript UI refresh`)
  await page.screenshot({ path: path.join(evidence, `${name}-saved.png`), fullPage: true })
  await captureOverview(name)
  passed(`${name}-real-ui-model-confirmation`, { nodeId, routeId, parentConnected: true, sourceBlueprintIndependent: true,
    mainlineUnchanged: true, explicitBridge: bridgeToNodeId ?? null, physicalModelRequests: phase.round })
}

try {
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve) })
  model.baseUrl = `http://127.0.0.1:${provider.address().port}/v1`
  step = 'seed-independent-profile-and-project'
  await launch()
  assert.equal((await invoke('llm:save-model', model)).success, true)
  assert.equal((await invoke('llm:set-default-model', model.id)).success, true)
  const grant = await chooseProjectDirectoryGrant(application, page, roots.projects)
  const created = await invoke('project:create', { parentGrantId: grant.grantId, name: projectName, genre: '合成验收', targetAudience: '合成读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  projectPath = created.projectPath
  const opened = await invoke('project:open', projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  session = { projectId: created.projectId, projectPath, leaseId: opened.project.sessionLease }
  for (const chapterNumber of [1, 2, 3, 4]) {
    assert.equal((await invoke('db:blueprint-upsert', { chapterNumber, title: `主线第${chapterNumber}章`, role: '发展', purpose: `调查灯信 ${marker(chapterNumber)}`,
      keyEvents: `主线事件 ${chapterNumber}`, characters: ['林岚'] }, projectPath, session)).success, true)
    const draft = await invoke('db:draft-create', { chapterNumber, version: 1, source: 'write', content: `${marker(chapterNumber)}：主线原稿只保存在原章节。`, wordCount: 40 }, projectPath, session)
    assert.equal(draft.success, true, draft.error)
    draftIds.push(draft.id)
  }
  passed('isolated-source-project-seeded', { chapters: 4, actualSourceDrafts: 4 })
  await closeOwnApplication()
  step = 'reopen-through-real-library'
  await launch()
  await stage.dismissMigrationNotice(page)
  await stage.showLibrary(page)
  await stage.openFromLibrary(page, projectName)
  await stage.waitForWork(page, projectName)
  session = await currentSession()
  await createAndGenerate({ afterChapter: 3, placement: 'branch', name: 'branch', bridge: false })
  await createAndGenerate({ afterChapter: 2, placement: 'insert', name: 'insert', bridge: true })
  await reviewSavedContinuity()
  assert.deepEqual(report.pageErrors, [])
  assert.equal(providerFailure, undefined)
  report.outcome = 'PASS'
} catch (error) {
  report.outcome = 'FAIL'; report.failure = { step, message: error.stack ?? String(error) }
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {})
    report.failure.visibleText = await page.locator('body').innerText().then(text => text.slice(-6000)).catch(() => '')
  }
  process.exitCode = 1
} finally {
  await closeOwnApplication()
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  if (report.realProviderRequests !== 0) {
    report.outcome = 'FAIL'
    report.failure ??= { step: 'network-isolation', message: 'A non-fixture request was attempted and blocked' }
    process.exitCode = 1
  }
  fs.writeFileSync(path.join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(path.join(repository, '.runtime', 'story-chapter-desktop-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks.length, physicalMockRequests: report.requests.length, realProviderRequests: report.realProviderRequests, evidence }))
}
