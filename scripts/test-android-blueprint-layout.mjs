/** Focused shipped-bundle layout acceptance. Only synthetic private files and a local native host are used. */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createNativeMock } from '../test/mobile-native-mock.mjs'
import { readBuildFingerprint } from './test-build-fingerprint.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const build = readBuildFingerprint(root)
const output = path.join(root, '.runtime', 'android-blueprint-layout')
fs.mkdirSync(output, { recursive: true })
const run = fs.mkdtempSync(path.join(output, 'run-'))
const native = createNativeMock(run, { virtualPaths: true })
const selection = [], nativeOperations = [], errors = [], checks = [], screenshots = [], layout = []
const bridge = `globalThis.AndroidBridge={
  sync(payload){const r=new XMLHttpRequest();r.open('POST','/__native',false);r.setRequestHeader('Content-Type','application/json');r.send(payload);return r.responseText},
  request(id,payload){fetch('/__request',{method:'POST',headers:{'Content-Type':'application/json'},body:payload}).then(r=>r.json()).then(r=>globalThis.__androidResolve(id,r)).catch(e=>globalThis.__androidResolve(id,{ok:false,error:String(e)}))}
};`
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/__bridge.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(bridge); return }
    if (request.method === 'POST') {
      let raw = ''; for await (const chunk of request) raw += chunk
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/__native') { response.end(native.sync(raw)); return }
      if (request.url === '/__request') {
        const { op } = JSON.parse(raw); nativeOperations.push(op)
        if (op === 'google.status') { response.end(JSON.stringify({ ok: true, value: { available: false } })); return }
        if (op === 'google.cancel' || op === 'app.background') { response.end(JSON.stringify({ ok: true, value: {} })); return }
        if (op === 'dialog.open' || op === 'dialog.save') {
          const selected = selection.shift(); assert.ok(selected, 'Unexpected native dialog')
          response.end(JSON.stringify({ ok: true, value: { canceled: false, filePaths: [selected], filePath: selected } })); return
        }
        throw new Error(`Unexpected native operation: ${op}`)
      }
    }
    const url = new URL(request.url, 'http://localhost'), directory = path.join(root, 'mobile-dist')
    const file = path.resolve(directory, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    const relative = path.relative(directory, file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Outside asset directory')
    let bytes = fs.readFileSync(file)
    if (file.endsWith('index.html')) bytes = bytes.toString().replace('<head>', '<head><script src="/__bridge.js"></script>')
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); response.end(bytes)
  } catch (error) {
    errors.push(String(error)); response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: String(error) }))
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser, diagnosticPage
async function observe(page) {
  page.on('pageerror', error => errors.push(error.stack || error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1') return route.continue()
    errors.push(`Unexpected external request: ${url.origin}`); return route.abort()
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => {
    const invoke = window.aiNovelAPI.invoke
    globalThis.__layoutCalls = []
    window.aiNovelAPI.invoke = async (...args) => {
      const result = await invoke(...args)
      if (args[0] === 'project:open' && result.success) globalThis.__layoutProject = result.project
      globalThis.__layoutCalls.push({ channel: args[0], success: result?.success })
      return result
    }
    globalThis.__layoutDb = (channel, ...args) => {
      const p = globalThis.__layoutProject
      return window.aiNovelAPI.invoke(channel, ...args, { projectId: p.id, projectPath: p.path, leaseId: p.sessionLease })
    }
    globalThis.__layoutStory = (channel, payload = {}) => {
      const p = globalThis.__layoutProject
      return window.aiNovelAPI.invoke(channel, { ...payload, projectSession: { projectId: p.id, projectPath: p.path, leaseId: p.sessionLease } })
    }
  })
}
async function openBlueprint(page) {
  const navigation = page.getByRole('navigation', { name: '创作流程', exact: true })
  if (!await navigation.isVisible()) await page.getByRole('button', { name: '作品导航', exact: true }).click()
  await navigation.getByRole('button', { name: /^蓝图/ }).click()
  await page.getByRole('region', { name: '章节树工作台', exact: true }).waitFor()
}
async function tree(page) {
  const button = page.getByRole('button', { name: '返回剧情树', exact: true })
  if (await button.isVisible()) await button.click()
}
async function selectChapter(page, id) {
  await tree(page)
  await page.locator(`.stage-bp [data-story-node="${id}"] .story-tree-card-select`).click()
  await page.locator(`.stage-bp .chapter-tree-inspector[data-selected-story-node="${id}"]`).waitFor()
}
async function screenshot(page, name) {
  const file = path.join(run, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file)
}
async function assertDetailLayout(page, label, narrow) {
  const measurements = await page.evaluate(() => {
    const rectangle = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const workspace = document.querySelector('.stage-bp > .chapter-tree-workspace')
    const map = document.querySelector('.stage-bp .chapter-tree-split-map'), editor = document.querySelector('.stage-bp .chapter-tree-split-editor')
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      clip: rectangle(document.querySelector('.stage-content')), title: rectangle(document.querySelector('.stage-bp-card [aria-label="章节标题"]')),
      card: rectangle(document.querySelector('.stage-bp-card')), workspace: rectangle(workspace), overflowY: getComputedStyle(workspace).overflowY,
      pane: document.querySelector('.stage-bp .chapter-tree-split').dataset.mobilePane, mapHidden: map.hidden, editorHidden: editor.hidden,
      separatorVisible: document.querySelector('.chapter-tree-separator').getClientRects().length > 0 }
  })
  assert.ok(measurements.documentWidth <= measurements.viewport.width + 1, JSON.stringify(measurements))
  assert.equal(measurements.overflowY, 'auto')
  assert.ok(measurements.workspace.height > 0 && measurements.workspace.bottom <= measurements.clip.bottom + 1, JSON.stringify(measurements))
  assert.ok(measurements.title.x >= measurements.clip.x && measurements.title.right <= measurements.clip.right + 1, JSON.stringify(measurements))
  assert.ok(measurements.title.y >= measurements.clip.y && measurements.title.bottom <= measurements.clip.bottom + 1, JSON.stringify(measurements))
  if (narrow) {
    assert.equal(measurements.pane, 'details'); assert.equal(measurements.mapHidden, true); assert.equal(measurements.editorHidden, false)
    assert.ok(measurements.card.width >= measurements.clip.width - 50, JSON.stringify(measurements))
  }
  layout.push({ label, ...measurements })
}
async function saveAndVerify(page, id, purpose) {
  await page.locator('.stage-bp-card').getByRole('button', { name: '保存此章', exact: true }).click()
  await page.waitForFunction(async ({ id, purpose }) => {
    if (id.startsWith('chapter:')) {
      const values = await globalThis.__layoutDb('db:blueprint-get-all', globalThis.__layoutProject.path)
      return values.find(value => value.chapterNumber === Number(id.slice(8)))?.purpose === purpose
    }
    const result = await globalThis.__layoutStory('story:read')
    return result.data?.nodes.find(node => node.id === id)?.chapterBlueprint?.purpose === purpose
  }, { id, purpose })
}
async function editReturnSave(page, id, label, nativeBack = false) {
  await selectChapter(page, id)
  await assertDetailLayout(page, label, true)
  const purpose = page.locator('.stage-bp-card').getByLabel(/主角小目标/)
  const value = `合成布局回归 ${label}：返回剧情树后保留这段未保存输入。`
  await purpose.fill(value)
  if (label === '393-mainline') {
    await page.locator('.stage-bp-card').getByRole('button', { name: '第 2 章更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '删除此章…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '删除第 2 章蓝图？', exact: true })
    await dialog.waitFor()
    await page.evaluate(() => globalThis.__androidBack())
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.stage-bp .chapter-tree-split').getAttribute('data-mobile-pane'), 'details')
    assert.equal(await purpose.inputValue(), value)
    checks.push('Android Back dismisses the delete-confirmation layer before returning from detail; no author draft is lost')
  }
  await page.evaluate(() => { globalThis.__layoutInput = document.querySelector('.stage-bp-card [aria-label="章节标题"]') })
  const savesBefore = await page.evaluate(() => globalThis.__layoutCalls.filter(call => ['db:blueprint-upsert', 'db:blueprint-upsert-many', 'story:commit'].includes(call.channel)).length)
  if (nativeBack) {
    const backgroundBefore = nativeOperations.filter(op => op === 'app.background').length
    await page.evaluate(() => globalThis.__androidBack())
    await page.waitForFunction(() => document.querySelector('.stage-bp .chapter-tree-split').dataset.mobilePane === 'tree')
    assert.equal(nativeOperations.filter(op => op === 'app.background').length, backgroundBefore)
  } else await page.getByRole('button', { name: '返回剧情树', exact: true }).click()
  assert.equal(await page.locator(`.stage-bp [data-story-node="${id}"] .story-tree-card-select`).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.evaluate(() => globalThis.__layoutCalls.filter(call => ['db:blueprint-upsert', 'db:blueprint-upsert-many', 'story:commit'].includes(call.channel)).length), savesBefore)
  await screenshot(page, `${label}-tree`)
  await page.getByRole('button', { name: '章节详情', exact: true }).click()
  assert.equal(await purpose.inputValue(), value)
  assert.equal(await page.evaluate(() => globalThis.__layoutInput === document.querySelector('.stage-bp-card [aria-label="章节标题"]')), true)
  const notes = page.locator('.stage-bp-card').getByLabel(/章节要点/)
  await notes.scrollIntoViewIfNeeded()
  const scrolled = await page.evaluate(() => {
    const w = document.querySelector('.stage-bp > .chapter-tree-workspace'), field = [...document.querySelectorAll('.stage-bp-card textarea')].at(-1).getBoundingClientRect(), clip = document.querySelector('.stage-content').getBoundingClientRect()
    return { scrollTop: w.scrollTop, reachable: field.top >= clip.top && field.bottom <= clip.bottom }
  })
  assert.ok(scrolled.scrollTop > 0 && scrolled.reachable, JSON.stringify(scrolled))
  await page.locator('.stage-bp > .chapter-tree-workspace').evaluate(element => { element.scrollTop = 0 })
  await screenshot(page, `${label}-details`)
  await saveAndVerify(page, id, value)
  checks.push(`${label}: full-width detail, reachable final field, same mounted editor, selection and unsaved draft retained, explicit save persisted${nativeBack ? ', Android Back returns to tree' : ''}`)
}
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.AI_NOVEL_VITEST_CHROMIUM || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined), args: ['--password-store=basic', '--use-mock-keychain'] })
  const page = await browser.newPage({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  diagnosticPage = page; await observe(page)
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  await page.getByLabel('作品名', { exact: true }).fill('手机蓝图布局合成夹具')
  selection.push(native.environment.filesDir)
  await page.getByRole('button', { name: '选择', exact: true }).click()
  await page.getByRole('button', { name: '创建作品', exact: true }).click()
  await page.getByRole('button', { name: 'AI 写作助手', exact: true }).waitFor()
  const seeded = await page.evaluate(async () => {
    const p = globalThis.__layoutProject
    for (let chapterNumber = 1; chapterNumber <= 3; chapterNumber++) {
      const saved = await globalThis.__layoutDb('db:blueprint-upsert', { chapterNumber, title: `主线第${chapterNumber}章`, role: '发展', purpose: '初始目标', keyEvents: '合成事件', characters: ['合成人物'], suspenseHook: '', userGuidance: '', notes: '', notesUpdatedAt: '' }, p.path)
      if (!saved.success) throw new Error(saved.error)
    }
    const before = await globalThis.__layoutStory('story:read'), id = crypto.randomUUID(), routeId = crypto.randomUUID()
    const saved = await globalThis.__layoutStory('story:commit', { expectedRevision: before.data.revision, operations: [
      { type: 'put-node', node: { id, kind: 'content', title: '独立支线章节', chapterNumber: 2, event: '支线事件', body: '', chapterBlueprint: { title: '独立支线章节', role: '发展', purpose: '支线初始目标', keyEvents: '合成支线事件', characters: [], suspenseHook: '', userGuidance: '', notes: '' } } },
      { type: 'put-route', route: { id: routeId, title: '独立支线', nodeIds: [id] } },
    ] })
    if (!saved.success) throw new Error(saved.error)
    return { projectPath: p.path, branchId: id, routeId }
  })
  checks.push('Real new-project UI and authored-only fixture creation via shipped controllers')
  await openBlueprint(page)
  await editReturnSave(page, 'chapter:2', '393-mainline', true)
  await page.getByLabel('当前章节路线', { exact: true }).selectOption(seeded.routeId)
  await editReturnSave(page, seeded.branchId, '393-branch')
  await page.setViewportSize({ width: 360, height: 800 })
  await editReturnSave(page, seeded.branchId, '360-branch', true)
  await page.getByLabel('当前章节路线', { exact: true }).selectOption('mainline')
  await editReturnSave(page, 'chapter:1', '360-mainline')

  // A normal reopen is an existing-workspace fixture, not a claim of old-schema migration coverage.
  const previousLease = await page.evaluate(() => globalThis.__layoutProject.sessionLease)
  selection.push(seeded.projectPath)
  await page.getByRole('button', { name: '《手机蓝图布局合成夹具》作品菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '打开其他作品…', exact: true }).click()
  await page.waitForFunction(lease => globalThis.__layoutProject?.sessionLease !== lease, previousLease)
  await openBlueprint(page)
  await editReturnSave(page, 'chapter:2', '360-reopened-mainline')
  await page.getByLabel('当前章节路线', { exact: true }).selectOption(seeded.routeId)
  await editReturnSave(page, seeded.branchId, '360-reopened-branch')
  checks.push('Previously saved synthetic project reopened with a new session lease; both mainline and branch remain editable')

  const retained = '横竖屏切换保留的合成标题'
  await page.locator('.stage-bp-card').getByLabel('章节标题', { exact: true }).fill(retained)
  for (const [width, height, label] of [[844, 390, '844-landscape'], [1440, 1000, '1440-desktop'], [393, 851, '393-restored-portrait']]) {
    await page.setViewportSize({ width, height })
    await page.waitForFunction(() => { const split = document.querySelector('.stage-bp .chapter-tree-split'); return split.dataset.stacked === String(split.getBoundingClientRect().width <= 899) })
    await page.locator('.stage-bp > .chapter-tree-workspace').evaluate(element => { element.scrollTop = 0 })
    assert.equal(await page.locator('.stage-bp-card').getByLabel('章节标题', { exact: true }).inputValue(), retained)
    if (width === 1440) {
      assert.equal(await page.getByRole('separator', { name: '调整章节树与蓝图宽度', exact: true }).isVisible(), true)
      assert.equal(await page.locator('.stage-bp .chapter-tree-split-map').evaluate(element => element.hidden), false)
      assert.equal(await page.locator('.stage-bp .chapter-tree-split-editor').evaluate(element => element.hidden), false)
    }
    await assertDetailLayout(page, label, width < 900)
    await screenshot(page, label)
    checks.push(`${label}: no horizontal page overflow, draft retained; ${width === 1440 ? 'desktop split and divider visible' : 'detail remains reachable'}`)
  }
  assert.deepEqual(selection, [])
  assert.equal(nativeOperations.includes('google.authorize'), false)
  assert.deepEqual(errors, [])
} catch (error) {
  errors.push(error.stack || String(error)); process.exitCode = 1
  if (diagnosticPage) {
    await screenshot(diagnosticPage, 'failure').catch(() => undefined)
    fs.writeFileSync(path.join(run, 'failure-dom.json'), JSON.stringify(await diagnosticPage.evaluate(() => ({ text: document.body.innerText, panes: [...document.querySelectorAll('.chapter-tree-split,.chapter-tree-workspace,.stage-content')].map(element => ({ className: element.className, height: element.clientHeight, scrollHeight: element.scrollHeight, overflow: getComputedStyle(element).overflow, pane: element.dataset.mobilePane })) })).catch(() => null), null, 2))
  }
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); native.close()
  const buildUnchangedDuringRun = JSON.stringify(build) === JSON.stringify(readBuildFingerprint(root))
  if (!buildUnchangedDuringRun) { errors.push('Production bundle changed during layout validation'); process.exitCode = 1 }
  const report = { passed: errors.length === 0, deviceTest: false, target: 'real production Android browser bundle, actual Stage shell and isolated Node native-protocol host', dataBoundary: 'synthetic private project only; no real project files, credentials, Google account, model request or external network', existingProjectCoverage: 'normal reopen of synthetic saved project; old-schema migration is covered separately', build, buildUnchangedDuringRun, checks, layout, screenshots, errors, artifacts: run }
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
