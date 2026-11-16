/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import * as stage from './redesign/pages/stage.mjs'
import { readBuildFingerprint } from './test-build-fingerprint.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagedExecutable = process.argv.find(value => value.startsWith('--executable='))?.slice('--executable='.length)
if (packagedExecutable) assert.ok(fs.existsSync(path.resolve(packagedExecutable)), 'Packaged executable is missing')
if (process.argv.includes('--help')) {
  console.log('Build this independent checkout first. Optional --executable=<unpacked EXE> requires app.isPackaged and app.asar. Opens a per-run copy of .runtime/project-copies/轮回迷宫x; keeps source files and mainline prose unchanged. Uses an isolated app profile and loopback models only, including NovelAI-compatible JSON/SSE. Reports hashes, chapter metadata and synthetic branch content, never original prose or provider credentials.')
  process.exit(0)
}
const canonicalJson = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
    : `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex')
const runId = randomUUID().slice(0, 8)
const allowedSources = path.join(repository, '.runtime', 'project-copies')
const argument = process.argv.find(value => value.startsWith('--project-copy='))?.slice('--project-copy='.length)
const sourceProject = path.resolve(argument || path.join(allowedSources, '轮回迷宫x'))
const relativeSource = path.relative(allowedSources, sourceProject)
assert.ok(relativeSource && !relativeSource.startsWith('..') && !path.isAbsolute(relativeSource), 'Only a prepared project copy inside this checkout may be used')
assert.ok(fs.existsSync(path.join(sourceProject, '.ai-novel', 'project.db')), 'Prepared canonical project copy missing')
const physicalSource = path.relative(fs.realpathSync(allowedSources), fs.realpathSync(sourceProject))
assert.ok(physicalSource && !physicalSource.startsWith('..') && !path.isAbsolute(physicalSource), 'Prepared project copy resolves outside this checkout')
const projectPath = path.join(allowedSources, `验收-${runId}`)
const evidence = path.join(repository, '.runtime', 'blueprint-tree-desktop', runId)
fs.mkdirSync(evidence, { recursive: true })
const roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData'].map(name => [name, path.join(evidence, name)]))
for (const [name, directory] of Object.entries(roots)) if (name !== 'canonical') fs.mkdirSync(directory, { recursive: true })
const inventory = directory => {
  const files = []
  const visit = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) files.push([path.relative(directory, file).replaceAll('\\', '/'), digest(fs.readFileSync(file))])
    }
  }
  visit(directory)
  return files.sort(([left], [right]) => left.localeCompare(right))
}
const sourceInventory = inventory(sourceProject)
fs.cpSync(sourceProject, projectPath, { recursive: true, errorOnExist: true, force: false })
assert.equal(digest(inventory(projectPath)), digest(sourceInventory), 'The per-run project copy was not byte-identical')
assert.equal(digest(inventory(sourceProject)), digest(sourceInventory), 'The prepared source changed during copying')
const model = { id: `blueprint-tree-${runId}`, name: '本地蓝图树验收模型', provider: 'openai', protocol: 'openai', modelName: 'blueprint-tree-fixture',
  baseUrl: '', apiKey: 'synthetic-loopback-only', maxTokens: 4096, temperature: 0.4, purposes: ['generation'],
  capabilities: { contextWindowTokens: 262144, maxOutputTokens: 4096, reasoning: false, structuredOutput: true, usage: true } }
const report = { runId, evidence, projectCopy: projectPath, originalSourceRead: false, oldCheckoutModified: false,
  sourceCopyDigest: digest(sourceInventory), sourceCopyFiles: sourceInventory.length, checks: [], requests: [], pageErrors: [], blockedExternalRequests: 0,
  diagnosticCodes: [], agentDiagnostics: [], novelAIProtocolRequests: [],
  launchTarget: packagedExecutable ? 'packaged executable with isolated profile' : 'source production build with isolated profile',
  acceptanceChanges: { baseline: '2026-10-23/f3f2b77f:16 checks', removed: ['plot-and-blueprint-share-one-tree'],
    added: ['google-drive-unconfigured-desktop-credentials', 'plot-default-threads-and-confirmed-final-evidence', 'plot-overview-generation-and-read-only-sources', 'plot-returns-to-unique-blueprint-editor', 'plot-compact-393-layout'],
    unchanged: 'The other 15 chapter, generation, deletion, history and resize checks remain.', additionalLoopbackRequests: 1 },
  syntheticModel: { loopbackOnly: true, contextWindowTokens: model.capabilities.contextWindowTokens, realProviderAcceptance: false },
  build: readBuildFingerprint(repository) }
let application, page, session, phase, providerFailure, originalState, originalLegacyEvidence
let step = 'start-loopback-provider'
const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const pass = (name, details = {}) => report.checks.push({ name, outcome: 'PASS', ...details })
async function waitFor(read, predicate, name, timeout = 35_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (providerFailure) throw providerFailure
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`BLUEPRINT_TREE_TIMEOUT: ${name}`)
}
async function storyRead() {
  const response = await invoke('story:read', { projectSession: session })
  assert.equal(response.success, true, 'Story projection read failed')
  return response.data
}
async function mainlineState() {
  const blueprints = await invoke('db:blueprint-get-all', projectPath, session)
  const drafts = []
  for (const chapterNumber of [1, 2, 3, 4, 5]) {
    const list = await invoke('db:draft-list', chapterNumber, projectPath, session)
    for (const item of list) {
      const full = await invoke('db:draft-get-full', item.id, projectPath, session)
      drafts.push({ id: full.id, chapterNumber, version: full.version, status: full.status, bodyDigest: digest(full.content), length: full.content.length })
    }
  }
  return { blueprintChapters: blueprints.map(item => item.chapterNumber).sort((a, b) => a - b), blueprintDigest: digest(blueprints), drafts }
}
async function assertMainlineUnchanged() {
  assert.equal(digest(await mainlineState()), digest(originalState), 'Original mainline blueprints or drafts changed')
}
async function storedStoryMetadata() {
  return application.evaluate(({ app }, databasePath) => {
    const testRequire = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = testRequire('better-sqlite3'), { createHash } = process.getBuiltinModule('crypto')
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const database = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      const rows = database.prepare('SELECT id,payload_json FROM story_nodes ORDER BY id').all()
      const revisions = database.prepare('SELECT id,payload_json FROM story_node_revisions ORDER BY id').all()
      const legacy = rows.filter(row => Boolean(JSON.parse(row.payload_json).chapterSource))
      const sourceIds = new Set(legacy.map(row => row.id))
      const sourceRevisions = revisions.filter(row => sourceIds.has(JSON.parse(row.payload_json).nodeId))
      return { schemaVersion: database.pragma('user_version', { simple: true }), storedNodes: rows.length,
        nodeRows: rows.map(row => ({ id: row.id, payloadDigest: hash(row.payload_json) })),
        revisionRows: revisions.map(row => ({ id: row.id, payloadDigest: hash(row.payload_json) })),
        legacySources: legacy.map(row => { const node = JSON.parse(row.payload_json); return { id: row.id, chapterNumber: node.chapterSource.chapterNumber,
          bodyLength: node.body.length, bodyDigest: createHash('sha256').update(node.body).digest('hex') } }),
        legacyPayloadDigest: hash(legacy), legacyRevisionDigest: hash(sourceRevisions), legacyRevisionCount: sourceRevisions.length,
      }
    } finally { database.close() }
  }, path.join(projectPath, '.ai-novel', 'project.db'))
}
async function assertLegacySourcesPreserved() {
  const metadata = await storedStoryMetadata()
  for (const field of ['legacyPayloadDigest', 'legacyRevisionDigest', 'legacyRevisionCount']) {
    assert.equal(metadata[field], originalLegacyEvidence[field], 'Normalizing the chapter tree changed original legacy payload or history')
  }
  for (const field of ['nodeRows', 'revisionRows']) {
    const originalIds = new Set(originalLegacyEvidence[field].map(row => row.id))
    assert.equal(digest(metadata[field].filter(row => originalIds.has(row.id))), digest(originalLegacyEvidence[field]), 'A pre-existing story row or immutable revision was changed')
  }
}
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST')
    const bytes = []
    for await (const chunk of request) bytes.push(chunk)
    const payload = JSON.parse(Buffer.concat(bytes).toString('utf8'))
    if (request.url === '/oa/v1/chat/completions') {
      assert.equal(request.headers.authorization, 'Bearer SYNTHETIC_LOCAL_TOKEN')
      assert.equal(payload.model, 'synthetic-novelai-model')
      assert.equal(payload.messages.at(-1)?.content, 'SYNTHETIC_NOVELAI_LOCAL_PROTOCOL')
      report.novelAIProtocolRequests.push({ path: request.url, stream: Boolean(payload.stream), syntheticMessageOnly: true })
      if (payload.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const encoded = Buffer.from('data: {"choices":[{"delta":{"content":"铜钥匙🙂仍在。"}}]}\n\n')
        const split = encoded.indexOf(Buffer.from('铜')) + 1
        response.write(encoded.subarray(0, split))
        setImmediate(() => response.end(Buffer.concat([encoded.subarray(split), Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')])))
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: '本机合成正文。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }))
      }
      return
    }
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, `Bearer ${model.apiKey}`)
    assert.ok(phase, 'Model request preceded the synthetic branch generation action')
    assert.equal(payload.model, model.modelName); assert.equal(payload.stream, true)
    const prompt = payload.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')).join('\n')
    const round = ++phase.round
    if (phase.plotOverview) {
      assert.equal(round, 1, 'Plot overview unexpectedly issued another model request')
      report.requests.push({ round, phase: 'plot-overview-generation', explicitGraphAction: true, referencedFinalChapter: 3, referencedBlueprintChapter: 5,
        messageRoles: payload.messages.map(message => message.role) })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(phase.plotOverview) }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    assert.ok(round <= (phase.review ? 1 : 3), 'Synthetic agent sent an unexpected additional model turn')
    const boundary = { round, independentBlueprintPresent: prompt.includes(phase.purpose), parentPresent: prompt.includes(phase.parentAnchor),
      unselectedFutureAbsent: !phase.futureAnchor || !prompt.includes(phase.futureAnchor),
      ...(phase.continuationAnchor ? { selectedContinuationPresent: prompt.includes(phase.continuationAnchor) } : {}),
      phase: phase.review ? 'read-only-review' : phase.bridgeToNodeId ? 'explicit-bridge-generation' : 'earlier-path-generation',
      messageRoles: payload.messages.map(message => message.role) }
    report.requests.push(boundary)
    assert.equal(boundary.independentBlueprintPresent, true, 'Independent blueprint was absent from the dispatched prompt')
    assert.equal(boundary.parentPresent, true, 'Selected parent context was absent from the dispatched prompt')
    assert.equal(boundary.unselectedFutureAbsent, true, 'Unselected future mainline prose entered the dispatched prompt')
    if (phase.continuationAnchor) assert.equal(boundary.selectedContinuationPresent, true, 'The explicitly selected later manuscript was absent')
    const { revisionId: _revision, mainline: _mainline, ...node } = phase.target
    const content = phase.review ? `BLUEPRINT_TREE_READ_ONLY_REVIEW_${runId}\n冲突：合成验收无已证实冲突。\n证据：只核对前文、当前支线和作者指定后文。\n建议：保持章节状态与线索的衔接。`
      : round === 1
      ? `<tool_call>${JSON.stringify({ name: 'read_story_context', arguments: { node_id: node.id, route_id: phase.routeId, mode: 'route', ...(phase.bridgeToNodeId ? { bridge_to_node_id: phase.bridgeToNodeId } : {}) } })}</tool_call>`
      : round === 2 ? `请核对这一份独立支线候选。\n<tool_call>${JSON.stringify({ name: 'propose_story_changes', arguments: {
        operations: [{ type: 'put-node', node: { ...node, body: phase.prose } }],
      } })}</tool_call>` : '作者批准的支线正文已保存。原主线蓝图与正文保持原样。'
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  } catch {
    providerFailure = new Error('BLUEPRINT_TREE_LOCAL_PROVIDER_BOUNDARY_FAILED')
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: providerFailure.message } }))
  }
})
async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy,
    AI_NOVEL_VELA_HOME: roots.legacy, HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
  application = await electron.launch({ cwd: repository,
    ...(packagedExecutable ? { executablePath: path.resolve(packagedExecutable) } : {}),
    args: [...(packagedExecutable ? [] : ['.']), `--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  page = await application.firstWindow({ timeout: 30_000 }); page.setDefaultTimeout(20_000)
  page.on('pageerror', () => report.pageErrors.push('RENDERER_PAGE_ERROR'))
  page.on('console', message => report.diagnosticCodes.push(...(message.text().match(/\b(?:STORY|GENERATION|AGENT)_[A-Z0-9_]+\b/g) ?? [])))
  await page.route(/^https?:\/\//, route => {
    if (new URL(route.request().url()).origin === new URL(model.baseUrl).origin) return route.continue()
    report.blockedExternalRequests++
    return route.abort()
  })
  await stage.waitForStage(page)
  const actualRuntime = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }))
  if (packagedExecutable) {
    assert.equal(actualRuntime.packaged, true, 'Packaged launch fell back to the source runtime')
    assert.match(actualRuntime.appPath, /app\.asar$/i, 'Packaged launch did not load its ASAR')
  }
  report.actualRuntime = actualRuntime
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
  const windowState = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { visible: window.isVisible(), minimized: window.isMinimized(), destroyed: window.isDestroyed(), contentSize: window.getContentSize() }
  })
  assert.equal(windowState.visible, true, 'The isolated desktop window was hidden')
  assert.equal(windowState.destroyed, false)
  assert.ok(windowState.contentSize.every(value => value > 0), 'The isolated desktop had an empty render area')
  const rendered = await page.locator('[data-shell-presentation="stage"]').boundingBox()
  assert.ok(rendered && rendered.width > 0 && rendered.height > 0, 'The visible window did not render the application shell')
  report.visibleWindow = { ...windowState, renderedWidth: rendered.width, renderedHeight: rendered.height }
  assert.equal((await invoke('startup:get-state')).state, 'ready')
  await application.evaluate(({ ipcMain }, origin) => {
    globalThis.__blueprintTreeProject = null
    globalThis.__blueprintTreeWrites = []
    globalThis.__blueprintTreeAgentDiagnostics = []
    for (const channel of ['agent-generation:begin', 'agent-generation:round', 'graph-generation:begin', 'graph-generation:execute']) {
      const original = ipcMain._invokeHandlers.get(channel)
      if (!original) throw new Error('BLUEPRINT_TREE_AGENT_OBSERVER_UNAVAILABLE')
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        try {
          const response = await original(...args)
          globalThis.__blueprintTreeAgentDiagnostics.push({ channel, sourceStatus: response?.sourceStatus,
            storyRequest: response?.context?.input?.storyContext,
            rounds: response?.rounds?.map(round => ({ index: round.index, status: round.status })) })
          return response
        } catch (error) {
          globalThis.__blueprintTreeAgentDiagnostics.push({ channel, codes: String(error).match(/\b(?:STORY|GENERATION|AGENT)_[A-Z0-9_]+\b/g) ?? [], failed: true })
          throw error
        }
      })
    }
    for (const channel of ['project:open', 'story:fork-chapter', 'story:commit', 'db:blueprint-upsert', 'db:blueprint-upsert-many', 'db:blueprint-delete', 'agent-generation:commit-domain-tool',
      'db:narrative-thread-plan-create', 'db:narrative-thread-event-confirm', 'graph-generation:confirm']) {
      const original = ipcMain._invokeHandlers.get(channel)
      if (!original) throw new Error('BLUEPRINT_TREE_OBSERVER_UNAVAILABLE')
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        if (channel !== 'project:open') globalThis.__blueprintTreeWrites.push(channel)
        const response = await original(...args)
        if (channel === 'project:open' && response.success) globalThis.__blueprintTreeProject = { id: response.project.id, path: response.project.path, sessionLease: response.project.sessionLease, name: response.project.name }
        return response
      })
    }
    globalThis.__blueprintTreeBlockedExternalRequests = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
      if (url.origin !== origin || !['/v1/chat/completions', '/oa/v1/chat/completions'].includes(url.pathname) || url.search) {
        globalThis.__blueprintTreeBlockedExternalRequests++
        throw new Error('BLUEPRINT_TREE_EXTERNAL_NETWORK_BLOCKED')
      }
      return originalFetch(input, options)
    }
  }, new URL(model.baseUrl).origin)
}
async function closeOwnApplication() {
  if (!application) return
  report.blockedExternalRequests += await application.evaluate(() => globalThis.__blueprintTreeBlockedExternalRequests ?? 0).catch(() => 0)
  report.agentDiagnostics.push(...await application.evaluate(() => globalThis.__blueprintTreeAgentDiagnostics ?? []).catch(() => []))
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await application.close().catch(() => {}); application = null
}
async function verifyNovelAILocalProtocol() {
  const id = `local-novelai-${runId}`
  const configuration = { id, name: 'Local NovelAI protocol acceptance', provider: 'novelai', protocol: 'openai',
    baseUrl: `${new URL(model.baseUrl).origin}/oa/v1`, modelName: 'synthetic-novelai-model', apiKey: 'SYNTHETIC_LOCAL_TOKEN',
    temperature: 0.2, maxTokens: 128, purposes: ['generation'] }
  assert.equal((await invoke('llm:save-model', configuration)).success, true)
  try {
    const request = { modelId: id, messages: [{ role: 'user', content: 'SYNTHETIC_NOVELAI_LOCAL_PROTOCOL' }], maxTokens: 128 }
    const plain = await invoke('llm:generate', request)
    assert.equal(plain.success, true); assert.equal(plain.content, '本机合成正文。'); assert.equal(plain.finishReason, 'stop')
    const streamed = await page.evaluate(({ requestId, request }) => new Promise((resolve, reject) => {
      const chunks = [], unsubscribers = [], timer = setTimeout(() => { cleanup(); reject(new Error('NOVELAI_LOCAL_STREAM_TIMEOUT')) }, 15_000)
      const cleanup = () => { clearTimeout(timer); for (const unsubscribe of unsubscribers) unsubscribe() }
      unsubscribers.push(window.aiNovelAPI.on('llm:stream-chunk', value => { if (value.requestId === requestId) chunks.push(value.chunk) }))
      unsubscribers.push(window.aiNovelAPI.on('llm:stream-done', value => { if (value.requestId === requestId) { cleanup(); resolve({ chunks, ...value }) } }))
      unsubscribers.push(window.aiNovelAPI.on('llm:stream-error', value => { if (value.requestId === requestId) { cleanup(); reject(new Error('NOVELAI_LOCAL_STREAM_FAILED')) } }))
      window.aiNovelAPI.invoke('llm:generate-stream', requestId, request).then(result => {
        if (!result.started) { cleanup(); reject(new Error('NOVELAI_LOCAL_STREAM_NOT_STARTED')) }
      }).catch(error => { cleanup(); reject(error) })
    }), { requestId: `novelai-local-stream-${runId}`, request })
    assert.equal(streamed.finishReason, 'stop'); assert.equal(streamed.fullText, '铜钥匙🙂仍在。'); assert.equal(streamed.chunks.join(''), streamed.fullText)
    assert.deepEqual(report.novelAIProtocolRequests.map(item => item.stream), [false, true])
    report.novelAIProtocol = { publicIPC: true, actualFactoryProviderTransport: true, endpointPrefixPreserved: true, duplicatedV1Absent: true,
      jsonAndSplitUtf8SsePassed: true, realNovelAIAccount: false, requests: 2 }
  } finally { assert.equal((await invoke('llm:delete-model', id)).success, true) }
}
async function openPreparedCopy() {
  await stage.dismissMigrationNotice(page)
  await application.evaluate(({ dialog }, directory) => {
    globalThis.__blueprintTreeOriginalDialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, projectPath)
  try { await page.getByRole('button', { name: '打开作品', exact: true }).click() }
  finally {
    await application.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__blueprintTreeOriginalDialog; delete globalThis.__blueprintTreeOriginalDialog })
  }
  const opened = await waitFor(() => application.evaluate(() => globalThis.__blueprintTreeProject), value => Boolean(value?.sessionLease), 'open prepared project copy')
  assert.equal(path.resolve(opened.path), path.resolve(projectPath))
  session = { projectId: opened.id, projectPath: opened.path, leaseId: opened.sessionLease }
  await stage.waitForWork(page, opened.name)
}
async function openBlueprint() {
  await stage.stageButton(page, '蓝图').click()
  await page.locator('.stage-bp .story-tree-card[data-story-node="chapter:1"]').waitFor()
}
async function reopenPreparedCopy() {
  await closeOwnApplication()
  await launch()
  await openPreparedCopy()
  await openBlueprint()
}
const selectedCard = () => page.locator('.stage-bp-card')
async function selectTreeNode(id, scope = page.locator('.stage-bp')) {
  await scope.locator(`.story-tree-card[data-story-node="${id}"] .story-tree-card-select`).click()
}
async function savePendingTree() {
  const scope = page.locator('.chapter-tree-workspace')
  const save = scope.getByRole('button', { name: '保存分支内容', exact: true })
  if (await save.count() && await save.isVisible()) {
    await save.click()
    await save.waitFor({ state: 'detached' })
  }
}
async function confirmChapterDeletion() {
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /删除|移除|清空/ }) })
  await dialog.waitFor()
  await dialog.getByRole('button').last().click()
  await dialog.waitFor({ state: 'detached' })
}
async function clickTreeDelete(id, screenshot) {
  await selectTreeNode(id)
  await page.locator(`.stage-bp .story-tree-card[data-story-node="${id}"]`).getByRole('button', { name: /^删除/ }).click()
  if (screenshot) {
    await page.getByRole('dialog').waitFor()
    await page.screenshot({ path: path.join(evidence, screenshot), fullPage: true })
  }
  await confirmChapterDeletion()
}
async function assertChapterAbsentAfterRefresh(id) {
  await page.locator('.stage-bp').getByRole('button', { name: '刷新章节树', exact: true }).click()
  await waitFor(storyRead, snapshot => !snapshot.nodes.some(node => node.id === id), 'deleted chapter absent from refreshed projection')
  await page.locator(`.stage-bp .story-tree-card[data-story-node="${id}"]`).waitFor({ state: 'detached' })
}
async function createTemporaryMainlineSix(save) {
  await openBlueprint()
  await page.locator('.stage-bp').getByRole('button', { name: '更多蓝图操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '新建章节', exact: true }).click()
  await selectTreeNode('chapter:6')
  await selectedCard().getByLabel('章节标题', { exact: true }).fill(`SYNTHETIC_DELETE_CHAPTER_6_${runId}`)
  if (save) {
    await selectedCard().getByLabel(/主角小目标/).fill('合成验收：删除尚无正文的规划章节。')
    await selectedCard().getByRole('button', { name: '保存此章', exact: true }).click()
    await waitFor(storyRead, snapshot => snapshot.nodes.some(node => node.id === 'chapter:6' && node.mainline?.hasBlueprint), 'temporary mainline blueprint saved')
  }
  const drafts = await invoke('db:draft-list', 6, projectPath, session)
  assert.equal(drafts.length, 0, 'The temporary unwritten blueprint fabricated a chapter draft')
}
const normalizeProse = value => value.replaceAll('\r\n', '\n')
const proseDocument = () => stage.prose(page).evaluate(element => {
  // CodeMirror virtualizes lines; read the mounted editor document rather than
  // confusing only the visible paragraph DOM with the complete manuscript.
  const view = element.cmTile?.root?.view ?? element.cmView?.view
  if (!view?.state?.doc) throw new Error('BLUEPRINT_TREE_EDITOR_DOCUMENT_UNAVAILABLE')
  return view.state.doc.toString()
})
async function assertImportedTabsClean(snapshot) {
  const tabs = await page.locator('.stage-tabs').evaluate(element => {
    const selectedId = element.querySelector('[role="tab"][aria-selected="true"]')?.id
    // Inspect the production component's mounted props without exporting a
    // test store or mutating it. No manuscript text enters report diagnostics.
    let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))]
    while (fiber) {
      for (const candidate of [fiber, fiber.alternate]) {
        const props = candidate?.memoizedProps
        if (Array.isArray(props?.tabs) && props.tabDomId?.(props.activeTabId) === selectedId) {
          return props.tabs.filter(tab => tab.type === 'chapter' && [1, 2].includes(tab.chapterNumber))
            .map(tab => ({ chapterNumber: tab.chapterNumber, dirty: Boolean(tab.dirty), content: tab.content, savedContent: tab.savedContent }))
        }
      }
      fiber = fiber.return
    }
    throw new Error('BLUEPRINT_TREE_MOUNTED_TABS_UNAVAILABLE')
  })
  for (const tab of tabs) {
    const expected = snapshot.nodes.find(node => node.id === `chapter:${tab.chapterNumber}`)?.body
    assert.equal(tab.dirty, false, 'Opening an imported manuscript marked its tab dirty')
    assert.equal(digest(tab.content), digest(expected), 'Opening an imported manuscript changed its original editor content')
    assert.equal(digest(tab.savedContent), digest(expected), 'Opening an imported manuscript changed its saved-content baseline')
  }
  assert.equal(await page.locator('.stage-tabs .stage-tab[data-dirty="true"]').count(), 0, 'Opening original manuscripts displayed an unsaved tab indicator')
  return tabs.map(tab => ({ chapterNumber: tab.chapterNumber, dirty: tab.dirty, originalContentDigest: digest(tab.content), savedContentDigest: digest(tab.savedContent) }))
}
function anchorFor(body, excluded = []) {
  const passages = body.match(/[\p{Script=Han}\p{L}\p{N}，。；：、！？]{32,}/gu) ?? []
  for (const passage of passages) for (let offset = 0; offset + 32 <= passage.length; offset += 16) {
    const candidate = passage.slice(offset, offset + 32)
    if (!excluded.some(text => text.includes(candidate))) return candidate
  }
  return null
}
async function screenshotSyntheticCard(name, fit = true, stageClass = '.stage-bp') {
  const tree = page.locator(`${stageClass} .story-tree`)
  if (fit) await tree.getByRole('button', { name: '适应画布', exact: true }).click()
  else {
    for (let count = 0; count < 12; count++) {
      const percent = Number((await tree.getByLabel('画布缩放比例', { exact: true }).innerText()).replace('%', ''))
      if (percent >= 95 && percent <= 110) break
      await tree.getByRole('button', { name: percent < 95 ? '放大' : '缩小', exact: true }).click()
    }
    await tree.getByRole('button', { name: '定位当前节点', exact: true }).click()
  }
  await page.evaluate(stageClass => {
    const frame = document.querySelector(stageClass)
    frame?.querySelector('.chapter-tree-inspector')?.scrollTo({ top: 0 })
    frame?.querySelector('.chapter-tree-workspace')?.scrollIntoView({ block: 'start' })
  }, stageClass)
  await page.screenshot({ path: path.join(evidence, name), fullPage: true })
}

try {
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve) })
  model.baseUrl = `http://127.0.0.1:${provider.address().port}/v1`
  step = 'prepare-isolated-model-profile'
  await launch()
  assert.equal((await invoke('llm:save-model', model)).success, true)
  assert.equal((await invoke('llm:set-default-model', model.id)).success, true)
  step = 'novelai-compatible-public-ipc-local-json-and-sse'
  await verifyNovelAILocalProtocol()
  await closeOwnApplication(); await launch()
  step = 'google-drive-unconfigured-desktop-credentials'
  const windowsStorage = await application.evaluate(({ safeStorage }) => {
    const result = { platform: process.platform, encryptionAvailable: safeStorage.isEncryptionAvailable(), backendGetterExists: typeof safeStorage.getSelectedStorageBackend === 'function' }
    if (result.backendGetterExists) {
      try { result.backend = safeStorage.getSelectedStorageBackend(); result.backendGetter = 'returned' }
      catch (error) { result.backendGetter = 'unsupported'; result.backendGetterError = error instanceof Error ? error.name : 'Error' }
    }
    if (result.encryptionAvailable) {
      const value = 'SYNTHETIC_DEVICE_STORAGE_PROBE'
      result.encryptDecryptRoundTrip = safeStorage.decryptString(safeStorage.encryptString(value)) === value
    }
    return result
  })
  report.deviceStorage = windowsStorage
  const unauthenticatedDrive = await invoke('drive:auth-status')
  assert.equal(unauthenticatedDrive.success, true)
  assert.equal(unauthenticatedDrive.auth.platform, 'desktop')
  assert.equal(unauthenticatedDrive.auth.configured, false)
  assert.equal(unauthenticatedDrive.auth.authorized, false)
  assert.ok(Object.keys(unauthenticatedDrive.auth).every(key => !/token|secret|credential|encrypted/i.test(key)), 'Auth status exposed a private credential field')
  if (windowsStorage.platform === 'win32' && windowsStorage.encryptionAvailable) {
    assert.equal(windowsStorage.encryptDecryptRoundTrip, true, 'Windows device encryption failed to round trip a synthetic value')
    assert.equal(unauthenticatedDrive.auth.persistence, 'os-backed', 'Windows encryption was available but Google credentials fell back to session-only storage')
  }
  pass('google-drive-unconfigured-desktop-credentials', { ...windowsStorage, persistence: unauthenticatedDrive.auth.persistence,
    configured: false, authorized: false, tokenFieldsExposed: false, authorizationRequested: false, googleNetworkRequests: 0 })
  step = 'open-real-project-copy'
  originalLegacyEvidence = await storedStoryMetadata()
  await openPreparedCopy()
  report.schemaVersion = (await storedStoryMetadata()).schemaVersion
  await assertLegacySourcesPreserved()
  assert.equal(report.schemaVersion, 11, 'The production project copy did not use schema 11')
  originalState = await mainlineState()
  assert.equal(digest(originalState.blueprintChapters), digest([3, 4, 5]), 'Expected original chapter blueprints 3..5 only')
  report.originalMetadata = { blueprintChapters: originalState.blueprintChapters, drafts: originalState.drafts.map(({ bodyDigest: _digest, ...item }) => item) }
  let snapshot = await storyRead()
  assert.equal(originalLegacyEvidence.legacySources.length, 5, 'The real R1 snapshot fixture did not contain its five original source chapters')
  assert.equal(originalLegacyEvidence.legacyRevisionCount, 5, 'The original R1 source history was unavailable')
  assert.equal(originalLegacyEvidence.storedNodes, 6, 'The original R1 node rows were missing')
  assert.equal(snapshot.nodes.length, 6, 'The tree duplicated frozen mainline sources instead of resolving their canonical identity')
  assert.ok(originalLegacyEvidence.legacySources.every(source => !snapshot.nodes.some(node => node.id === source.id)), 'A legacy source UUID still appeared as a second chapter node')
  for (const source of originalLegacyEvidence.legacySources) assert.equal(snapshot.aliases?.nodes[source.id], `chapter:${source.chapterNumber}`, 'A legacy chapter identity did not resolve to its canonical node')
  assert.ok(Object.values(snapshot.aliases?.routes ?? {}).includes('mainline'), 'The frozen source-only route was duplicated instead of resolving to mainline')
  const liveChapterFive = snapshot.nodes.find(node => node.id === 'chapter:5')
  const currentDraftFive = originalState.drafts.filter(draft => draft.chapterNumber === 5 && ['draft', 'revised'].includes(draft.status)).sort((left, right) => right.version - left.version)[0]
  const frozenChapterFive = originalLegacyEvidence.legacySources.find(node => node.chapterNumber === 5)
  assert.equal(digest(liveChapterFive.body), currentDraftFive.bodyDigest, 'The tree used an obsolete frozen source instead of the current manuscript')
  assert.notEqual(digest(liveChapterFive.body), frozenChapterFive.bodyDigest, 'The real stale-source fixture no longer exercised differing source and current manuscripts')
  const mainline = snapshot.routes.find(route => route.id === 'mainline')
  assert.equal(digest(mainline?.nodeIds), digest([1, 2, 3, 4, 5].map(number => `chapter:${number}`)), 'The mainline projection omitted imported manuscripts')
  for (const number of [1, 2]) {
    const node = snapshot.nodes.find(item => item.id === `chapter:${number}`)
    assert.equal(node.mainline.hasBlueprint, false)
    assert.equal(node.chapterBlueprint, undefined)
    assert.ok(node.body.trim().length > 0, 'An imported mainline manuscript was missing')
  }
  const retainedStoryIds = snapshot.nodes.filter(node => !node.mainline).map(node => node.id)
  assert.equal(retainedStoryIds.length, 1, 'A true independent chapter was removed or an old mainline source was duplicated')
  pass('live-mainline-projection', { mainlineChapters: [1, 2, 3, 4, 5], manuscriptOnlyChapters: [1, 2], visibleNodeCount: 6,
    normalizedLegacySources: 5, retainedIndependentScenes: retainedStoryIds.length, legacyPayloadAndHistoryPreserved: true, chapterFiveUsesCurrentDraft: true })
  await openBlueprint()
  const mainlinePositions = await page.locator('.stage-bp .story-tree-card[data-mainline="true"]').evaluateAll(elements => elements.map(element => ({ id: element.dataset.storyNode, x: element.getBoundingClientRect().x })))
  assert.equal(mainlinePositions.length, 5)
  assert.ok(mainlinePositions.every(item => Math.abs(item.x - mainlinePositions[0].x) <= 1), 'An unbranched mainline still appeared in multiple tree columns')
  await screenshotSyntheticCard('desktop-normalized-mainline.png')
  pass('legacy-mainline-renders-one-column', { mainlineNodeCount: 5, oneColumn: true, legacyDuplicateColumnsAbsent: true })
  step = 'imported-manuscript-only-entry'
  for (const number of [1, 2]) {
    await openBlueprint(); await selectTreeNode(`chapter:${number}`)
    assert.equal(await selectedCard().count(), 0, 'Imported manuscript-only chapter displayed a fabricated blueprint card')
    assert.equal(await page.locator(`.stage-bp .story-tree-card[data-story-node="chapter:${number}"]`).getByRole('button', { name: /^删除/ }).count(), 0, 'An imported manuscript without a blueprint displayed destructive blueprint deletion')
    await page.locator('.stage-bp').getByRole('button', { name: '打开本章正文', exact: true }).click()
    await stage.prose(page).waitFor()
    const expected = snapshot.nodes.find(node => node.id === `chapter:${number}`).body
    await waitFor(proseDocument, actual => digest(normalizeProse(actual)) === digest(normalizeProse(expected)), 'imported manuscript editor document')
    await assertMainlineUnchanged()
  }
  const importedTabState = await assertImportedTabsClean(snapshot)
  assert.equal(importedTabState.length, 2)
  pass('imported-chapters-open-prose-only', { chapters: [1, 2], originalBlueprintsUnchanged: true, importedTabs: importedTabState })
  step = 'mainline-original-card-and-layout'
  await openBlueprint(); await selectTreeNode('chapter:3')
  await selectedCard().getByLabel('章节标题', { exact: true }).waitFor()
  const originalBlueprints = await invoke('db:blueprint-get-all', projectPath, session)
  assert.equal(digest(await selectedCard().getByLabel('章节标题', { exact: true }).inputValue()), digest(originalBlueprints.find(row => row.chapterNumber === 3).title), 'The original chapter card showed another chapter blueprint')
  const treeBounds = await page.locator('.stage-bp .story-tree').boundingBox(), cardBounds = await selectedCard().boundingBox()
  assert.ok(treeBounds && cardBounds && cardBounds.x >= treeBounds.x + treeBounds.width - 2, 'The desktop blueprint tree and original card were not side by side')
  await assertMainlineUnchanged()
  pass('left-tree-right-original-blueprint-card', { preservedMainlineChapter: 3, sideBySide: true })
  step = 'drag-splitter-and-reload-width-preference'
  const splitter = page.getByRole('separator', { name: '调整章节树与蓝图宽度', exact: true })
  await splitter.locator(':scope > span').scrollIntoViewIfNeeded()
  const splitterBox = await splitter.locator(':scope > span').boundingBox()
  assert.ok(splitterBox, 'The desktop split control was unavailable')
  const widthBefore = (await page.locator('.stage-bp .chapter-tree-map').boundingBox()).width
  const cardWidthBefore = (await selectedCard().boundingBox()).width
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(splitterBox.x + splitterBox.width / 2 + 100, splitterBox.y + splitterBox.height / 2, { steps: 10 })
  await page.mouse.up()
  const widthAfter = (await page.locator('.stage-bp .chapter-tree-map').boundingBox()).width
  const cardWidthAfter = (await selectedCard().boundingBox()).width
  assert.ok(widthAfter - widthBefore >= 60 && cardWidthBefore - cardWidthAfter >= 60, 'Dragging the separator did not resize both columns')
  const storedWidth = await page.evaluate(() => localStorage.getItem('ai-novel:chapter-tree:column-width'))
  assert.ok(storedWidth, 'The resized desktop preference was not saved')
  await screenshotSyntheticCard('desktop-resized-columns.png', false)
  await reopenPreparedCopy()
  const reloadedWidth = (await page.locator('.stage-bp .chapter-tree-map').boundingBox()).width
  assert.ok(Math.abs(reloadedWidth - widthAfter) <= 2, 'The split width was lost after reopening the app')
  await selectTreeNode('chapter:3')
  await assertMainlineUnchanged(); await assertLegacySourcesPreserved()
  pass('splitter-drag-and-reopen-preference', { widthBefore, widthAfter, reloadedWidth, rightCardResized: true })
  step = 'fork-and-save-independent-blueprint'
  const beforeForkIds = new Set(snapshot.nodes.map(node => node.id))
  await page.locator('.stage-bp').getByRole('button', { name: '从本章分支', exact: true }).click()
  snapshot = await waitFor(storyRead, value => value.nodes.some(node => !beforeForkIds.has(node.id) && !node.mainline), 'new independent branch')
  const branch = snapshot.nodes.find(node => !beforeForkIds.has(node.id) && !node.mainline)
  const branchRoute = snapshot.routes.find(route => route.id !== 'mainline' && route.nodeIds.includes(branch.id))
  assert.ok(branchRoute, 'The branch route was not created')
  assert.ok(snapshot.edges.some(edge => edge.from === 'chapter:3' && edge.to === branch.id), 'The branch was not linked to its real mainline parent')
  const purpose = `BLUEPRINT_TREE_SYNTHETIC_PURPOSE_${runId}`
  await selectedCard().getByLabel('章节标题', { exact: true }).fill('验收支线：独立调查')
  await selectedCard().getByLabel(/主角小目标/).fill(purpose)
  await selectedCard().getByLabel('冲突与转折', { exact: true }).fill('合成验收事件：调查灯信，保持此前状态。')
  await selectedCard().getByRole('button', { name: '保存此章', exact: true }).click()
  snapshot = await waitFor(storyRead, value => value.nodes.find(node => node.id === branch.id)?.chapterBlueprint?.purpose === purpose, 'independent blueprint saved')
  assert.ok(snapshot.edges.some(edge => edge.from === 'chapter:3' && edge.to === 'chapter:4'), 'Creating an independent branch removed the canonical next chapter')
  const forkPositions = await page.locator(`.stage-bp .story-tree-card[data-story-node="${branch.id}"],.stage-bp .story-tree-card[data-story-node="chapter:4"]`).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x))
  assert.equal(forkPositions.length, 2)
  assert.ok(Math.abs(forkPositions[0] - forkPositions[1]) > 20, 'A real alternate chapter did not create a visible tree fork')
  await assertMainlineUnchanged()
  pass('branch-reuses-card-and-saves-separately', { parentChapter: 3, independentSceneId: branch.id, routeId: branchRoute.id, mainlineUnchanged: true, trueForkVisible: true })
  await screenshotSyntheticCard('desktop-blueprint-tree-readable.png', false)
  await screenshotSyntheticCard('desktop-blueprint-tree.png')
  step = 'generate-synthetic-branch-with-author-approval'
  const target = snapshot.nodes.find(node => node.id === branch.id)
  const context = await invoke('story:context', { projectSession: session, nodeId: branch.id, routeId: branchRoute.id, mode: 'route' })
  assert.equal(context.success, true, 'Selected branch context unavailable')
  assert.equal(context.data.readyForGeneration, true)
  const parentBody = context.data.prefix.find(node => node.id === 'chapter:3')?.body
  const futureBody = snapshot.nodes.find(node => node.id === 'chapter:5')?.body ?? ''
  const parentAnchor = anchorFor(parentBody ?? ''), futureAnchor = anchorFor(futureBody, context.data.prefix.map(node => node.body))
  assert.ok(parentAnchor && futureAnchor, 'Unique prose-boundary anchors could not be selected without publishing source text')
  const prose = `BLUEPRINT_TREE_APPROVED_${runId}：这是一段仅用于独立验收支线的合成正文。`
  const savedConnections = digest({ edges: snapshot.edges, routes: snapshot.routes })
  const savedBranchBlueprint = digest(target.chapterBlueprint)
  phase = { target, routeId: branchRoute.id, purpose, parentAnchor, futureAnchor, prose, round: 0 }
  await page.locator('.stage-bp').getByLabel('章节写作模型', { exact: true }).selectOption(model.id)
  await page.locator('.stage-bp').getByRole('button', { name: '按蓝图生成正文', exact: true }).click()
  const assistant = page.getByRole('complementary', { name: 'AI 写作助手', exact: true })
  await assistant.getByRole('region', { name: '剧情分支变更预览', exact: true }).waitFor({ timeout: 45_000 })
  assert.equal((await storyRead()).nodes.find(node => node.id === branch.id).body.length, 0, 'The proposal wrote a body before author approval')
  await assistant.getByRole('button', { name: '批准执行', exact: true }).click()
  snapshot = await waitFor(storyRead, value => value.nodes.find(node => node.id === branch.id)?.body === prose && phase.round === 3, 'approved synthetic branch prose')
  assert.equal(digest({ edges: snapshot.edges, routes: snapshot.routes }), savedConnections, 'Approved prose changed saved parent connections or routes')
  assert.equal(digest(snapshot.nodes.find(node => node.id === branch.id).chapterBlueprint), savedBranchBlueprint, 'Approved prose replaced its saved independent blueprint')
  await assertMainlineUnchanged()
  await assertImportedTabsClean(snapshot)
  await assistant.getByRole('button', { name: '收起助手', exact: true }).click()
  pass('branch-blueprint-model-and-author-approval', { physicalLoopbackModelRequests: phase.round, mainlineUnchanged: true, parentIncluded: true, futureExcluded: true,
    savedParentConnectionsPreserved: true, independentBlueprintPreserved: true })
  step = 'sidebar-routes-and-manuscript-edit'
  await page.locator('.stage-bp').getByRole('button', { name: '打开正文', exact: true }).click()
  const manuscript = page.getByRole('region', { name: '分支正文', exact: true })
  await manuscript.waitFor()
  const routes = page.locator('.stage-manuscript-routes')
  await routes.waitFor()
  const mainlineButtons = await routes.locator('button[data-story-route="mainline"]').evaluateAll(elements => elements.map(element => element.dataset.storyNode))
  assert.equal(digest(mainlineButtons), digest([1, 2, 3, 4, 5].map(number => `chapter:${number}`)))
  const branchButton = routes.locator(`button[data-story-node="${branch.id}"][data-story-route="${branchRoute.id}"]`)
  await branchButton.waitFor(); await branchButton.click()
  const bodyInput = manuscript.getByLabel('分支正文内容', { exact: true })
  assert.equal(digest(await bodyInput.inputValue()), digest(prose))
  const edited = `${prose}\n合成手工补写：支线正文继续独立保存。`
  await bodyInput.fill(edited)
  await manuscript.getByRole('button', { name: '保存正文', exact: true }).click()
  await waitFor(storyRead, value => value.nodes.find(node => node.id === branch.id)?.body === edited, 'sidebar branch manuscript saved')
  await assertMainlineUnchanged()
  await page.screenshot({ path: path.join(evidence, 'desktop-sidebar-branch-manuscript.png'), fullPage: true })
  pass('sidebar-groups-lines-and-edits-branch-prose', { mainlineChapters: [1, 2, 3, 4, 5], branchRouteVisible: true, manualBranchSave: true, mainlineUnchanged: true })
  step = 'plot-default-threads-and-confirmed-final-evidence'
  await stage.stageButton(page, '蓝图').click()
  await selectTreeNode(branch.id)
  await stage.spine(page).getByRole('button', { name: '剧情与伏笔', exact: true }).click()
  const plotPage = page.locator('.stage-plot')
  const threadPlans = plotPage.getByRole('region', { name: '线索计划', exact: true })
  await threadPlans.waitFor()
  assert.equal(await plotPage.locator('.chapter-tree-workspace,.story-tree,.stage-bp-card').count(), 0, 'Plot still duplicated the chapter-branch editor')
  assert.equal(await plotPage.getByRole('button', { name: '伏笔线索', exact: true }).getAttribute('aria-pressed'), 'true', 'Plot did not default to thread management')
  const syntheticThreadTitle = `验收伏笔_${runId}`
  await threadPlans.getByRole('button', { name: '新建线索', exact: true }).first().click()
  const threadDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建线索', exact: true }) })
  await threadDialog.getByLabel('名称', { exact: true }).fill(syntheticThreadTitle)
  await threadDialog.getByLabel('类型', { exact: true }).fill('人物')
  await threadDialog.getByLabel('埋设章', { exact: true }).fill('3')
  await threadDialog.getByLabel('回收章', { exact: true }).fill('5')
  await threadDialog.getByLabel('你的打算', { exact: true }).fill('合成验收：确认定稿引文后记录埋设，不改写正文。')
  await threadDialog.getByRole('button', { name: '保存线索', exact: true }).click()
  await threadDialog.waitFor({ state: 'detached' })
  const thread = await waitFor(() => invoke('db:narrative-thread-list', projectPath, session), plans => plans.some(item => item.title === syntheticThreadTitle), 'synthetic narrative thread saved')
    .then(plans => plans.find(item => item.title === syntheticThreadTitle))
  assert.equal(thread.events.length, 0, 'New thread fabricated a confirmed final event')
  await plotPage.getByRole('button', { name: `「${syntheticThreadTitle}」的更多操作`, exact: true }).click()
  await page.getByRole('menuitem', { name: '记录定稿里的变化', exact: true }).click()
  const evidenceSection = plotPage.getByRole('region', { name: '定稿里的线索变化', exact: true })
  const finalDraft = originalState.drafts.find(item => item.chapterNumber === 3 && item.status === 'finalized')
  assert.ok(finalDraft)
  // The wrapping label's DOM text includes the select options; match its
  // leading caption while still selecting the exact authoritative draft ID.
  await evidenceSection.getByLabel(/^定稿章节/).selectOption(String(finalDraft.id))
  await evidenceSection.getByLabel('定稿里的原文', { exact: true }).fill(parentAnchor)
  await evidenceSection.getByLabel('理由', { exact: true }).fill('合成验收：仅将用户核对的原文记录为已埋设的证据。')
  assert.equal((await invoke('db:narrative-thread-list', projectPath, session)).find(item => item.id === thread.id).events.length, 0, 'Typing evidence confirmed it without an author action')
  await evidenceSection.getByRole('button', { name: '记入线索', exact: true }).click()
  const confirmedThread = await waitFor(() => invoke('db:narrative-thread-list', projectPath, session), plans => plans.some(item => item.id === thread.id && item.events.length === 1), 'final evidence explicitly confirmed')
    .then(plans => plans.find(item => item.id === thread.id))
  assert.equal(confirmedThread.status, 'planted')
  assert.equal(digest(confirmedThread.events[0].evidence), digest(parentAnchor))
  await assertMainlineUnchanged()
  pass('plot-default-threads-and-confirmed-final-evidence', { duplicateChapterEditorAbsent: true, defaultView: 'plans', explicitFinalEvidenceConfirmation: true, finalEvidenceChapter: 3, originalManuscriptsUnchanged: true })

  step = 'plot-overview-generation-and-read-only-sources'
  await plotPage.getByRole('button', { name: '剧情梳理', exact: true }).click()
  await plotPage.getByLabel('本次整理用的模型', { exact: true }).selectOption(model.id)
  const plotSources = await invoke('db:plot-tree-read', projectPath, session)
  const overviewFinal = plotSources.finalizedChapters.find(item => item.chapterNumber === 3)
  assert.ok(overviewFinal && plotSources.blueprints.some(item => item.chapterNumber === 5), 'Original plot overview sources were unavailable')
  const plotFinalMarker = `SYNTHETIC_PLOT_FINAL_${runId}`, plotPlanMarker = `SYNTHETIC_PLOT_PLAN_${runId}`
  phase = { round: 0, plotOverview: { tracks: [{ id: `synthetic-main-${runId}`, title: '合成验收主线梳理', role: 'main', startChapter: 3, endChapter: 5,
    summary: '只读索引区分已定稿事实与未来蓝图计划。', events: [
      { chapterNumber: 3, status: 'occurred', summary: plotFinalMarker, sources: [{ type: 'finalized-chapter', chapterNumber: 3, draftId: overviewFinal.draftId }] },
      { chapterNumber: 5, status: 'planned', summary: plotPlanMarker, sources: [{ type: 'blueprint', chapterNumber: 5 }] },
    ] }] } }
  const storyBeforeOverview = digest(await storyRead())
  await plotPage.getByRole('button', { name: /^(整理剧情|重新整理剧情)$/ }).click()
  await plotPage.getByRole('table', { name: '剧情梳理', exact: true }).getByRole('button', { name: plotFinalMarker, exact: true }).waitFor({ timeout: 45_000 })
  await waitFor(() => invoke('db:plot-tree-read', projectPath, session), sources => sources.snapshot?.tracks.some(track => track.events.some(event => event.summary === plotPlanMarker)), 'main-owner plot overview saved')
  assert.equal(phase.round, 1)
  assert.equal(await plotPage.locator('.chapter-tree-workspace,.story-tree,.stage-bp-card').count(), 0)
  const writesBeforePlotBrowse = await application.evaluate(() => globalThis.__blueprintTreeWrites.length)
  const plotGrid = plotPage.getByRole('table', { name: '剧情梳理', exact: true })
  assert.equal(await plotGrid.getByRole('button', { name: plotFinalMarker, exact: true }).getAttribute('data-state'), 'occurred')
  assert.equal(await plotGrid.getByRole('button', { name: plotPlanMarker, exact: true }).getAttribute('data-state'), 'planned')
  await plotGrid.getByRole('button', { name: plotPlanMarker, exact: true }).click()
  await plotPage.getByRole('region', { name: '事件详情', exact: true }).getByRole('button', { name: '打开来源：第 5 章蓝图', exact: true }).waitFor()
  await page.screenshot({ path: path.join(evidence, 'desktop-plot-read-only-overview.png'), fullPage: true })
  assert.equal(digest(await storyRead()), storyBeforeOverview, 'Plot overview generation or browsing modified chapter structure or manuscript')
  assert.equal(await application.evaluate(() => globalThis.__blueprintTreeWrites.length), writesBeforePlotBrowse, 'Read-only plot browsing attempted a domain write')
  await assertMainlineUnchanged(); await assertLegacySourcesPreserved()
  pass('plot-overview-generation-and-read-only-sources', { actualGraphOwnerLoopbackRequests: 1, storedSnapshot: true, finalAndPlannedEventsDistinct: true, sourceLinkAvailable: true, readOnlyBrowseDomainWrites: 0, originalChaptersUnchanged: true })

  step = 'plot-compact-393-layout'
  const originalWindow = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], original = { minimum: window.getMinimumSize(), size: window.getContentSize() }
    window.setMinimumSize(320, 480); window.setContentSize(393, 852)
    return original
  })
  await page.waitForFunction(() => window.innerWidth === 393)
  await page.getByRole('table', { name: '剧情梳理', exact: true }).waitFor()
  const compact = await page.evaluate(() => ({ width: window.innerWidth, pageWidth: document.documentElement.scrollWidth,
    gridWidth: document.querySelector('.stage-plot-grid-wrap')?.clientWidth, gridScrollWidth: document.querySelector('.stage-plot-grid-wrap')?.scrollWidth,
    duplicateEditorCount: document.querySelectorAll('.stage-plot .story-tree,.stage-plot .chapter-tree-workspace').length,
    navigation: [...document.querySelectorAll('.stage-plot-head button')].map(element => {
      const bounds = element.getBoundingClientRect()
      return { label: element.textContent.trim(), left: bounds.left, right: bounds.right }
    }) }))
  assert.ok(compact.pageWidth <= compact.width + 1, 'Plot controls overflowed the compact document')
  assert.equal(compact.duplicateEditorCount, 0)
  assert.ok(compact.navigation.every(control => control.left >= -1 && control.right <= compact.width + 1), 'Plot navigation was clipped outside the compact viewport')
  await page.screenshot({ path: path.join(evidence, 'desktop-plot-393-layout.png'), fullPage: true })
  await application.evaluate(({ BrowserWindow }, original) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(...original.size); window.setMinimumSize(...original.minimum)
  }, originalWindow)
  await page.waitForFunction(() => window.innerWidth > 1000)
  pass('plot-compact-393-layout', { ...compact, deviceTest: false, desktopNarrowWindowOnly: true })

  step = 'plot-returns-to-unique-blueprint-editor'
  await plotPage.getByRole('region', { name: '事件详情', exact: true }).getByRole('button', { name: '打开来源：第 5 章蓝图', exact: true }).click()
  await page.locator('.stage-bp .chapter-tree-inspector[data-selected-story-node="chapter:5"]').waitFor()
  await selectTreeNode(branch.id)
  await page.locator('.stage-bp').getByLabel('当前章节路线', { exact: true }).selectOption(branchRoute.id)
  await stage.spine(page).getByRole('button', { name: '剧情与伏笔', exact: true }).click()
  await plotPage.getByRole('button', { name: '前往章节蓝图', exact: true }).click()
  await page.locator(`.stage-bp .chapter-tree-inspector[data-selected-story-node="${branch.id}"]`).waitFor()
  assert.equal(await page.locator('.stage-bp').getByLabel('当前章节路线', { exact: true }).inputValue(), branchRoute.id)
  assert.equal(digest(await selectedCard().getByLabel('章节标题', { exact: true }).inputValue()), digest('验收支线：独立调查'))
  snapshot = await storyRead()
  assert.ok(retainedStoryIds.every(id => snapshot.nodes.some(node => node.id === id)), 'Previously authored independent nodes were lost')
  await assertMainlineUnchanged()
  await screenshotSyntheticCard('desktop-plot-returns-to-blueprint.png', false)
  pass('plot-returns-to-unique-blueprint-editor', { sourceOpenedCanonicalChapter: 5, sameSelectedBranchAndRoute: true, retainedOriginalIndependentScenes: retainedStoryIds.length, sameBranchCard: true })
  step = 'manual-reconnect-and-explicit-bridge-generation'
  await openBlueprint(); await selectTreeNode(branch.id)
  await page.locator(`.stage-bp .story-tree-card[data-story-node="${branch.id}"]`).getByRole('button', { name: /连接现有节点/ }).click()
  await selectTreeNode('chapter:4')
  await savePendingTree()
  snapshot = await waitFor(storyRead, value => value.edges.some(edge => edge.from === branch.id && edge.to === 'chapter:4'), 'manually reconnected later chapter')
  await selectTreeNode(branch.id)
  await page.locator('.stage-bp').getByLabel('衔接后文', { exact: true }).selectOption('chapter:4')
  const bridgeContext = await invoke('story:context', { projectSession: session, nodeId: branch.id, routeId: branchRoute.id, mode: 'route', bridgeToNodeId: 'chapter:4' })
  assert.equal(bridgeContext.success, true)
  assert.equal(bridgeContext.data.readyForGeneration, true, 'The manually connected branch lacked confirmed generation context')
  assert.equal(bridgeContext.data.continuation.node.id, 'chapter:4')
  const bridgeTarget = snapshot.nodes.find(node => node.id === branch.id)
  const bridgedProse = `BLUEPRINT_TREE_BRIDGED_${runId}：合成支线按指定前后文衔接。`
  const continuationAnchor = anchorFor(bridgeContext.data.continuation.node.body, bridgeContext.data.prefix.map(node => node.body))
  const bridgeFutureAnchor = anchorFor(futureBody, [...bridgeContext.data.prefix.map(node => node.body), bridgeContext.data.continuation.node.body])
  assert.ok(continuationAnchor && bridgeFutureAnchor, 'Selected continuation or excluded future lacked a unique private boundary anchor')
  phase = { target: bridgeTarget, routeId: branchRoute.id, purpose, parentAnchor, futureAnchor: bridgeFutureAnchor, continuationAnchor,
    bridgeToNodeId: 'chapter:4', prose: bridgedProse, round: 0 }
  const bridgeConnections = digest({ edges: snapshot.edges, routes: snapshot.routes })
  await page.locator('.stage-bp').getByLabel('章节写作模型', { exact: true }).selectOption(model.id)
  await page.locator('.stage-bp').getByRole('button', { name: '按蓝图生成正文', exact: true }).click()
  await assistant.getByRole('region', { name: '剧情分支变更预览', exact: true }).waitFor({ timeout: 45_000 })
  assert.equal(digest((await storyRead()).nodes.find(node => node.id === branch.id).body), digest(bridgeTarget.body), 'Bridge generation overwrote prose before author approval')
  await assistant.getByRole('button', { name: '批准执行', exact: true }).click()
  snapshot = await waitFor(storyRead, value => value.nodes.find(node => node.id === branch.id)?.body === bridgedProse && phase.round === 3, 'approved explicit bridge prose')
  assert.equal(digest({ edges: snapshot.edges, routes: snapshot.routes }), bridgeConnections)
  await assertMainlineUnchanged(); await assertLegacySourcesPreserved()
  await assistant.getByRole('button', { name: '收起助手', exact: true }).click()
  pass('manual-reconnect-and-explicit-bridge-generation', { parentChapter: 3, selectedContinuationChapter: 4, unselectedFutureChapterExcluded: 5, approvedBodyOnly: true })
  step = 'read-only-continuity-review'
  const beforeReview = await storyRead()
  const writesBeforeReview = await application.evaluate(() => globalThis.__blueprintTreeWrites.length)
  phase = { ...phase, target: beforeReview.nodes.find(node => node.id === branch.id), review: true, round: 0 }
  await page.locator('.stage-bp').getByRole('button', { name: '审查衔接', exact: true }).click()
  await assistant.getByText(`BLUEPRINT_TREE_READ_ONLY_REVIEW_${runId}`, { exact: false }).waitFor({ timeout: 45_000 })
  await waitFor(() => page.locator('.stage-bp').getByRole('button', { name: '按蓝图生成正文', exact: true }).isEnabled(), Boolean, 'read-only review completed')
  assert.equal(phase.round, 1)
  assert.equal(digest(await storyRead()), digest(beforeReview), 'A read-only continuity review changed the story or its history')
  assert.equal(await application.evaluate(() => globalThis.__blueprintTreeWrites.length), writesBeforeReview, 'Read-only review attempted a story or domain write')
  await assertMainlineUnchanged()
  await assistant.getByRole('button', { name: '收起助手', exact: true }).click()
  pass('continuity-review-is-read-only', { localModelRounds: 1, storyAndHistoryUnchanged: true, storyOrDomainWrites: 0, parentAndSpecifiedLaterOnly: true })
  step = 'delete-blueprint-of-written-branch-retains-chapter'
  await selectTreeNode(branch.id)
  const branchConnectionsBeforeBlueprintRemoval = digest({ edges: beforeReview.edges, routes: beforeReview.routes })
  await selectedCard().getByRole('button', { name: /更多操作$/ }).click()
  await page.getByRole('menuitem', { name: /^删除/ }).click()
  await confirmChapterDeletion()
  await waitFor(storyRead, value => value.nodes.some(node => node.id === branch.id && node.chapterBlueprint === undefined), 'written branch blueprint removed')
  await reopenPreparedCopy()
  snapshot = await storyRead()
  const branchWithoutBlueprint = snapshot.nodes.find(node => node.id === branch.id)
  assert.ok(branchWithoutBlueprint && branchWithoutBlueprint.chapterBlueprint === undefined)
  assert.equal(digest(branchWithoutBlueprint.body), digest(bridgedProse))
  assert.equal(digest({ edges: snapshot.edges, routes: snapshot.routes }), branchConnectionsBeforeBlueprintRemoval)
  await assertMainlineUnchanged(); await assertLegacySourcesPreserved()
  pass('delete-blueprint-retains-written-independent-chapter', { sameNodeId: true, sameManuscriptHash: true, sameConnectionsAndRoutes: true, absentBlueprintAfterReopen: true })
  step = 'delete-unsaved-mainline-blueprint'
  await createTemporaryMainlineSix(false)
  const deletesBeforeUnsavedDiscard = await application.evaluate(() => globalThis.__blueprintTreeWrites.filter(channel => channel === 'db:blueprint-delete').length)
  await selectedCard().getByRole('button', { name: '第 6 章更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: /^删除/ }).click()
  await confirmChapterDeletion()
  assert.equal(await application.evaluate(() => globalThis.__blueprintTreeWrites.filter(channel => channel === 'db:blueprint-delete').length), deletesBeforeUnsavedDiscard, 'Discarding an unsaved blueprint attempted to delete a database chapter')
  await assertChapterAbsentAfterRefresh('chapter:6')
  await reopenPreparedCopy()
  await assertChapterAbsentAfterRefresh('chapter:6')
  await assertMainlineUnchanged()
  pass('delete-unsaved-unwritten-mainline-no-ghost', { chapterNumber: 6, databaseDeleteCalls: 0, absentAfterRefreshAndReopen: true })
  step = 'delete-saved-unwritten-mainline-from-tree'
  await createTemporaryMainlineSix(true)
  await clickTreeDelete('chapter:6', 'desktop-delete-unwritten-confirmation.png')
  await assertChapterAbsentAfterRefresh('chapter:6')
  await reopenPreparedCopy()
  await assertChapterAbsentAfterRefresh('chapter:6')
  await assertMainlineUnchanged()
  pass('delete-saved-unwritten-mainline-no-ghost', { chapterNumber: 6, noDraftFabricated: true, treeDelete: true, absentAfterRefreshAndReopen: true })
  step = 'delete-empty-independent-chapter-from-tree'
  await selectTreeNode('chapter:3')
  const beforeEmptyBranchIds = new Set((await storyRead()).nodes.map(node => node.id))
  await page.locator('.stage-bp').getByRole('button', { name: '从本章分支', exact: true }).click()
  const withEmptyBranch = await waitFor(storyRead, value => value.nodes.some(node => !beforeEmptyBranchIds.has(node.id)), 'temporary empty independent chapter')
  const emptyBranch = withEmptyBranch.nodes.find(node => !beforeEmptyBranchIds.has(node.id))
  assert.equal(emptyBranch.body, '')
  await clickTreeDelete(emptyBranch.id)
  await assertChapterAbsentAfterRefresh(emptyBranch.id)
  await reopenPreparedCopy()
  await assertChapterAbsentAfterRefresh(emptyBranch.id)
  await assertMainlineUnchanged(); await assertLegacySourcesPreserved()
  pass('delete-empty-independent-chapter-no-ghost', { independentSceneId: emptyBranch.id, treeDelete: true, absentAfterRefreshAndReopen: true, originalIndependentChapterPreserved: retainedStoryIds.every(id => withEmptyBranch.nodes.some(node => node.id === id)) })
  step = 'delete-blueprint-of-existing-manuscript-retains-chapter'
  snapshot = await storyRead()
  const originalChapterThreeBody = digest(snapshot.nodes.find(node => node.id === 'chapter:3').body)
  await clickTreeDelete('chapter:3')
  snapshot = await waitFor(storyRead, value => value.nodes.some(node => node.id === 'chapter:3' && !node.mainline.hasBlueprint && node.chapterBlueprint === undefined), 'existing chapter blueprint removed')
  assert.equal(digest(snapshot.nodes.find(node => node.id === 'chapter:3').body), originalChapterThreeBody)
  await reopenPreparedCopy()
  snapshot = await storyRead()
  const retainedChapter = snapshot.nodes.find(node => node.id === 'chapter:3')
  assert.ok(retainedChapter && !retainedChapter.mainline.hasBlueprint && retainedChapter.chapterBlueprint === undefined)
  assert.equal(digest(retainedChapter.body), originalChapterThreeBody)
  const afterIntentionalBlueprintRemoval = await mainlineState()
  assert.equal(digest(afterIntentionalBlueprintRemoval.drafts), digest(originalState.drafts), 'Removing a blueprint changed original manuscript versions')
  const remainingBlueprints = await invoke('db:blueprint-get-all', projectPath, session)
  assert.equal(digest(remainingBlueprints), digest(originalBlueprints.filter(row => row.chapterNumber !== 3)), 'Removing one blueprint changed another chapter')
  assert.ok(retainedStoryIds.every(id => snapshot.nodes.some(node => node.id === id)), 'A pre-existing independent chapter was removed during deletion tests')
  await assertLegacySourcesPreserved()
  await selectTreeNode('chapter:3')
  await screenshotSyntheticCard('desktop-deleted-blueprint-kept-manuscript.png', false)
  pass('delete-blueprint-retains-written-chapter', { chapterNumber: 3, sameNodeId: true, sameManuscriptHash: true, allOriginalDraftsUnchanged: true, otherBlueprintsUnchanged: true, absentBlueprintAfterReopen: true })
  report.legacyEvidence = { normalizedSourceRows: originalLegacyEvidence.legacySources.length, retainedSourceHistory: originalLegacyEvidence.legacyRevisionCount,
    originalNodeRowsPreserved: originalLegacyEvidence.nodeRows.length, originalRevisionRowsPreserved: originalLegacyEvidence.revisionRows.length,
    originalPayloadDigest: originalLegacyEvidence.legacyPayloadDigest, originalHistoryDigest: originalLegacyEvidence.legacyRevisionDigest }
  report.buildUnchangedDuringRun = digest(report.build) === digest(readBuildFingerprint(repository))
  assert.equal(report.buildUnchangedDuringRun, true, 'Production build changed during validation')
  assert.equal(report.pageErrors.length, 0)
  report.outcome = 'PASS'
} catch (error) {
  report.outcome = 'FAIL'
  report.failure = { step, code: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : 'Unknown failure' }
  if (page) report.uiFailureState = await page.evaluate(() => ({
    selectedNodeId: document.querySelector('.chapter-tree-inspector')?.getAttribute('data-selected-story-node'),
    selectedRouteId: document.querySelector('[aria-label="当前章节路线"]')?.value,
    selectedBridgeId: document.querySelector('[aria-label="衔接后文"]')?.value,
    selectedModelId: document.querySelector('[aria-label="章节写作模型"]')?.value,
    reviewRequired: [...document.querySelectorAll('button')].some(button => button.textContent === '已核对保留的输入'),
    pendingSaveVisible: [...document.querySelectorAll('button')].some(button => button.textContent === '保存分支内容'),
    workspaceErrorCodes: [...document.querySelectorAll('.chapter-tree-message.is-error')].flatMap(element => element.textContent.match(/\b(?:STORY|GENERATION|AGENT)_[A-Z0-9_]+\b/g) ?? []),
    assistantReportedFailure: document.querySelector('.stage-agent-conversation')?.textContent.includes('生成失败'),
    plotRegions: [...document.querySelectorAll('.stage-plot section[aria-label]')].map(element => ({ label: element.getAttribute('aria-label'), visible: Boolean(element.getBoundingClientRect().height) })),
    plotFieldLabels: [...document.querySelectorAll('.stage-plot label')].map(element => element.firstChild?.textContent),
  })).catch(() => ({ unavailable: true }))
  // Original prose and prompts deliberately stay out of diagnostics. Synthetic
  // branch screenshots are taken only after its independent card is selected.
  process.exitCode = 1
} finally {
  await closeOwnApplication()
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
  report.sourceCopyUnchanged = digest(inventory(sourceProject)) === digest(sourceInventory)
  if (!report.sourceCopyUnchanged || report.blockedExternalRequests) { report.outcome = 'FAIL'; process.exitCode = 1 }
  fs.writeFileSync(path.join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(path.join(repository, '.runtime', 'blueprint-tree-desktop-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks.length, localModelRequests: report.requests.length,
    localNovelAIProtocolRequests: report.novelAIProtocolRequests.length,
    blockedExternalRequests: report.blockedExternalRequests, sourceCopyUnchanged: report.sourceCopyUnchanged, evidence }))
}
