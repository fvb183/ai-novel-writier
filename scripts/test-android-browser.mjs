/** Runs the shipped browser bundle against a local protocol host, never real user data. */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createNativeMock } from '../test/mobile-native-mock.mjs'
import { readBuildFingerprint } from './test-build-fingerprint.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildFingerprint = readBuildFingerprint(root)
const output = path.join(root, '.runtime', 'android-browser')
fs.mkdirSync(output, { recursive: true })
const run = fs.mkdtempSync(path.join(output, 'run-'))
const native = createNativeMock(run, { virtualPaths: true })
const selection = []
const googleNativeCalls = []
const bridge = `globalThis.AndroidBridge={
  sync(payload){const request=new XMLHttpRequest();request.open('POST','/__native',false);request.setRequestHeader('Content-Type','application/json');request.send(payload);return request.responseText},
  request(id,payload){fetch('/__request',{method:'POST',headers:{'Content-Type':'application/json'},body:payload}).then(r=>r.json()).then(r=>globalThis.__androidResolve(id,r)).catch(e=>globalThis.__androidResolve(id,{ok:false,error:String(e)}))}
};`
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/__bridge.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(bridge); return
    }
    if (request.method === 'POST') {
      let raw = ''
      for await (const chunk of request) raw += chunk
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/__native') { response.end(native.sync(raw)); return }
      if (request.url === '/__request') {
        const { op } = JSON.parse(raw)
        if (op.startsWith('google.')) {
          googleNativeCalls.push(op)
          const result = op === 'google.status' ? { ok: true, value: { available: false } }
            : op === 'google.cancel' ? { ok: true, value: {} }
            : { ok: false, error: 'GOOGLE_PLAY_SERVICES_UNAVAILABLE', code: 'GOOGLE_PLAY_SERVICES_UNAVAILABLE' }
          response.end(JSON.stringify(result)); return
        }
        if (op === 'dialog.open' || op === 'dialog.save') {
          const selected = selection.shift()
          assert.ok(selected, 'Unexpected native dialog')
          response.end(JSON.stringify({ ok: true, value: { canceled: false, filePaths: [selected], filePath: selected } })); return
        }
        throw new Error(`Unexpected asynchronous native operation: ${op}`)
      }
    }
    const url = new URL(request.url, 'http://localhost')
    const directory = path.join(root, 'mobile-dist')
    const file = path.resolve(directory, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    const relative = path.relative(directory, file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Outside asset directory')
    let bytes = fs.readFileSync(file)
    if (file.endsWith('index.html')) bytes = bytes.toString().replace('<head>', '<head><script src="/__bridge.js"></script>')
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' })
    response.end(bytes)
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: String(error) }))
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const executable = process.env.AI_NOVEL_VITEST_CHROMIUM
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined)
let browser
let diagnosticPage
const checks = [], errors = []
async function observeProjectCalls(page) {
  await page.evaluate(() => {
    const invoke = window.aiNovelAPI.invoke
    globalThis.__testSyncCalls = []
    globalThis.__testStoryCalls = []
    window.aiNovelAPI.invoke = async (...args) => {
      const result = await invoke(...args)
      if (args[0] === 'project:open' && result.success) globalThis.__testOpenedProject = result.project
      if (args[0].startsWith('sync:')) globalThis.__testSyncCalls.push({ channel: args[0], result })
      if (args[0].startsWith('story:') || args[0].startsWith('agent-generation:')) globalThis.__testStoryCalls.push({ channel: args[0], result })
      return result
    }
    globalThis.__testInvokeProject = (channel, ...args) => {
      const project = globalThis.__testOpenedProject
      return window.aiNovelAPI.invoke(channel, ...args, {
        projectId: project.id, projectPath: project.path, leaseId: project.sessionLease,
      })
    }
    globalThis.__testStoryInvoke = (channel, payload = {}) => {
      const project = globalThis.__testOpenedProject
      return window.aiNovelAPI.invoke(channel, { ...payload, projectSession: {
        projectId: project.id, projectPath: project.path, leaseId: project.sessionLease,
      } })
    }
  })
}
async function projectSyncState(page) {
  return page.evaluate(async () => {
    const project = globalThis.__testOpenedProject
    const result = await window.aiNovelAPI.invoke('sync:status', {
      projectSession: { projectId: project.id, projectPath: project.path, leaseId: project.sessionLease },
    })
    return { project, ...result }
  })
}
try {
  browser = await chromium.launch({ headless: true, executablePath: executable })
  const page = await browser.newPage({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  diagnosticPage = page
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' })
  await observeProjectCalls(page)
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  await page.getByLabel('作品名', { exact: true }).fill('安卓浏览器验证')
  selection.push(native.environment.filesDir)
  await page.getByRole('button', { name: '选择', exact: true }).click()
  await page.getByRole('button', { name: '创建作品', exact: true }).click()
  await page.getByRole('button', { name: 'AI 写作助手', exact: true }).waitFor()
  checks.push('Real bundled startup and UI create/open with schema migration')
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  assert.ok(dimensions.document <= dimensions.viewport + 1, JSON.stringify(dimensions))
  await page.getByRole('button', { name: 'AI 写作助手', exact: true }).click()
  await page.getByRole('complementary', { name: 'AI 写作助手', exact: true }).waitFor()
  await page.screenshot({ path: path.join(run, 'phone-assistant.png'), fullPage: true })
  await page.evaluate(() => globalThis.__androidBack())
  await page.getByRole('complementary', { name: 'AI 写作助手', exact: true }).waitFor({ state: 'hidden' })
  checks.push('Mobile assistant entry and native Back dismissal')
  const archive = '/android/files/browser-test.ainovel'
  selection.push(archive)
  const exported = await page.evaluate(async () => {
    const api = window.aiNovelAPI
    const project = globalThis.__testOpenedProject
    const grant = await api.invoke('dialog:select-project-archive-export', 'browser-test')
    return api.invoke('project:archive-export', { targetArchiveGrantId: grant.grantId, projectSession: { projectId: project.id, projectPath: project.path, leaseId: project.sessionLease } })
  })
  assert.equal(exported.success, true, JSON.stringify(exported))
  checks.push('Browser stream/crypto/SQLite archive export through full bundle')
  selection.push(archive, native.environment.filesDir)
  const restored = await page.evaluate(async () => {
    const api = window.aiNovelAPI
    const archiveGrant = await api.invoke('dialog:select-project-archive')
    const targetGrant = await api.invoke('dialog:select-project-restore-target', 'browser-restored')
    return api.invoke('project:archive-restore', { archiveGrantId: archiveGrant.grantId, targetGrantId: targetGrant.grantId })
  })
  assert.equal(restored.success, true, JSON.stringify(restored))
  checks.push('Browser random-access ZIP restoration with a new project identity')
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.getByRole('button', { name: 'AI 写作助手', exact: true }).click()
  await page.getByRole('complementary', { name: 'AI 写作助手', exact: true }).waitFor()
  await page.screenshot({ path: path.join(run, 'tablet-assistant.png'), fullPage: true })
  checks.push('Same workspace remains usable after viewport resize')

  // Construct only draft fixtures through IPC; navigation and sync actions use real UI buttons.
  await page.evaluate(() => globalThis.__androidBack())
  await page.getByRole('complementary', { name: 'AI 写作助手', exact: true }).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '《安卓浏览器验证》作品菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '项目同步', exact: true }).click()
  await page.locator('.project-sync-panel > details > summary').click()
  await page.getByRole('button', { name: '启用此项目同步', exact: true }).click()
  await page.getByText('此项目已启用同步。其他设备请从变更包加入。', { exact: true }).waitFor()
  const firstState = await projectSyncState(page)
  assert.equal(firstState.success, true)
  assert.equal(firstState.status.enabled, true)
  const unavailableGoogle = await page.evaluate(() => window.aiNovelAPI.invoke('drive:auth-status'))
  assert.equal(unavailableGoogle.success, true)
  assert.deepEqual(unavailableGoogle.auth, { platform: 'android', available: false, configured: false, authorized: false, persistence: 'google-play-services' })
  assert.ok(Object.keys(unavailableGoogle.auth).every(key => !/token|credential|secret/i.test(key)))
  checks.push('Unconfigured Google capability remains separate from local sync and exposes no token or authorization prompt')
  const firstContent = '同步起点：第一台设备保存的章节。'
  const firstDraft = await page.evaluate(async content => {
    const project = globalThis.__testOpenedProject
    return globalThis.__testInvokeProject('db:draft-create', {
      chapterNumber: 1, version: 1, source: 'write', content, wordCount: content.length,
    }, project.path)
  }, firstContent)
  assert.equal(firstDraft.success, true, JSON.stringify(firstDraft))
  const firstBundle = '/android/files/browser-sync-first.ainovelsync'
  selection.push(firstBundle)
  await page.getByRole('button', { name: '导出已保存变更包', exact: true }).click()
  await page.getByText('已导出已保存的变更。未保存输入仍留在当前设备。', { exact: true }).waitFor()
  assert.ok(fs.statSync(native.hostPath(firstBundle)).size > 0)
  checks.push('Actual settings UI enables sync and exports a saved draft through the production bundle')

  // A fresh renderer starts in the library, so joining also exercises the no-open-project route.
  const replica = await browser.newPage({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  replica.on('pageerror', error => errors.push(error.message))
  await replica.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' })
  await observeProjectCalls(replica)
  await replica.getByRole('button', { name: '设置', exact: true }).click()
  await replica.getByRole('button', { name: '项目同步', exact: true }).click()
  await replica.locator('.project-sync-panel > details > summary').click()
  await replica.getByText('打开项目后可启用同步，也可以从另一设备的变更包加入。', { exact: true }).waitFor()
  await replica.screenshot({ path: path.join(run, 'phone-sync-library.png'), fullPage: true })
  selection.push(firstBundle, native.environment.filesDir)
  await replica.getByRole('button', { name: '选择变更包并加入', exact: true }).click()
  await replica.waitForFunction(() => Boolean(globalThis.__testOpenedProject))
  const secondState = await projectSyncState(replica)
  assert.equal(secondState.success, true, JSON.stringify(secondState))
  assert.equal(secondState.project.id, firstState.project.id)
  assert.notEqual(secondState.project.path, firstState.project.path)
  assert.notEqual(secondState.status.replicaId, firstState.status.replicaId)
  const joinedDraft = await replica.evaluate(async () => {
    const project = globalThis.__testOpenedProject
    const drafts = await globalThis.__testInvokeProject('db:draft-list', 1, project.path)
    return globalThis.__testInvokeProject('db:draft-get-full', drafts[0].id, project.path)
  })
  assert.equal(joinedDraft.content, firstContent)
  checks.push('Library settings UI joins a bundle without an open project, preserving project identity and allocating a different replica')

  const remoteContent = '同步回传：另一副本新增的第二章。'
  const remoteDraft = await replica.evaluate(async content => {
    const project = globalThis.__testOpenedProject
    return globalThis.__testInvokeProject('db:draft-create', {
      chapterNumber: 2, version: 1, source: 'write', content, wordCount: content.length,
    }, project.path)
  }, remoteContent)
  assert.equal(remoteDraft.success, true, JSON.stringify(remoteDraft))
  await replica.getByRole('button', { name: '《安卓浏览器验证》作品菜单', exact: true }).click()
  await replica.getByRole('menuitem', { name: '项目同步', exact: true }).click()
  await replica.locator('.project-sync-panel > details > summary').click()
  const secondBundle = '/android/files/browser-sync-return.ainovelsync'
  selection.push(secondBundle)
  await replica.getByRole('button', { name: '导出已保存变更包', exact: true }).click()
  await replica.getByText('已导出已保存的变更。未保存输入仍留在当前设备。', { exact: true }).waitFor()
  const syncDimensions = await replica.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  assert.ok(syncDimensions.document <= syncDimensions.viewport + 1, JSON.stringify(syncDimensions))
  await replica.screenshot({ path: path.join(run, 'phone-sync.png'), fullPage: true })
  selection.push(secondBundle)
  await page.getByRole('button', { name: '导入并预览', exact: true }).click()
  await page.getByText('更新已暂存，请核对下面的预览后应用。', { exact: true }).waitFor()
  const staged = await page.evaluate(async () => ({
    drafts: await globalThis.__testInvokeProject('db:draft-list', 2, globalThis.__testOpenedProject.path),
    preview: globalThis.__testSyncCalls.findLast(call => call.channel === 'sync:import-preview').result.preview,
  }))
  assert.deepEqual(staged.drafts, [])
  assert.ok(staged.preview.pendingBatches > 0)
  assert.equal(staged.preview.conflicts.length, 0)
  await page.screenshot({ path: path.join(run, 'tablet-sync-preview.png'), fullPage: true })
  checks.push('Actual import button stages another replica’s changes and leaves the live draft table unchanged before apply')

  await page.getByRole('button', { name: '保存并应用同步', exact: true }).click()
  await page.waitForFunction(previousLease => globalThis.__testOpenedProject?.sessionLease !== previousLease, firstState.project.sessionLease)
  const appliedState = await projectSyncState(page)
  assert.equal(appliedState.project.path, firstState.project.path)
  assert.equal(appliedState.project.id, firstState.project.id)
  assert.equal(appliedState.status.pendingBatches, 0)
  const applied = await page.evaluate(async () => {
    const project = globalThis.__testOpenedProject
    const drafts = await globalThis.__testInvokeProject('db:draft-list', 2, project.path)
    return {
      draft: await globalThis.__testInvokeProject('db:draft-get-full', drafts[0].id, project.path),
      calls: globalThis.__testSyncCalls.filter(call => call.channel === 'sync:apply'),
    }
  })
  assert.equal(applied.draft.content, remoteContent)
  assert.equal(applied.calls.length, 1)
  assert.equal(applied.calls[0].result.applied.applied, true)
  await page.screenshot({ path: path.join(run, 'tablet-sync-applied.png'), fullPage: true })
  checks.push('Actual save-and-apply button commits once, reopens the project with a new lease and exposes the remote draft')

  // Seed only authored fixtures through the real controller. Editing and confirmation use shipped UI.
  const storySeed = await page.evaluate(async () => {
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID())
    const nodes = [
      { id: ids[0], kind: 'branch', title: '山路岔口', chapterNumber: 1, event: '决定从森林或海港前进', body: '共同开场' },
      { id: ids[1], kind: 'content', title: '森林', chapterNumber: 2, event: '得到绿钥匙', body: '森林路线原稿' },
      { id: ids[2], kind: 'content', title: '海港', chapterNumber: 2, event: '旧地图遗失', body: '海港路线原稿' },
      { id: ids[3], kind: 'merge', title: '山顶重逢', chapterNumber: 3, event: '两条路线在山顶汇合', body: '共同到达山顶' },
      { id: ids[4], kind: 'content', title: '共同的后续', chapterNumber: 4, event: '讨论下一步行动', body: '共用的后续正文' },
    ]
    const routes = [
      { id: crypto.randomUUID(), title: '森林路线', nodeIds: [ids[0], ids[1], ids[3], ids[4]] },
      { id: crypto.randomUUID(), title: '海港路线', nodeIds: [ids[0], ids[2], ids[3], ids[4]] },
    ]
    const edges = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]].map(([from, to]) => ({ id: crypto.randomUUID(), from: ids[from], to: ids[to], label: '继续前进', condition: '作者选择这条走向' }))
    const before = await globalThis.__testStoryInvoke('story:read')
    if (!before.success) throw new Error(before.error)
    const saved = await globalThis.__testStoryInvoke('story:commit', { expectedRevision: before.data.revision,
      operations: [...nodes.map(node => ({ type: 'put-node', node })), ...edges.map(edge => ({ type: 'put-edge', edge })), ...routes.map(route => ({ type: 'put-route', route }))] })
    return { ...saved, ids, routes }
  })
  assert.equal(storySeed.success, true, JSON.stringify(storySeed))
  async function openBlueprintEditor() {
    const navigation = page.getByRole('navigation', { name: '创作流程', exact: true })
    if (!await navigation.isVisible()) await page.getByRole('button', { name: '作品导航', exact: true }).click()
    await navigation.getByRole('button', { name: /^蓝图/ }).click()
    await page.getByRole('region', { name: '章节树工作台', exact: true }).waitFor()
  }
  async function selectStoryChapter(id, routeId = storySeed.routes[0].id) {
    await page.getByLabel('当前章节路线', { exact: true }).selectOption(routeId)
    await page.locator(`.stage-bp .story-tree-card[data-story-node="${id}"] .story-tree-card-select`).click()
    await page.locator(`.stage-bp .chapter-tree-inspector[data-selected-story-node="${id}"]`).waitFor()
  }
  async function openStoryProse(id, routeId = storySeed.routes[0].id) {
    await openBlueprintEditor(); await selectStoryChapter(id, routeId)
    await page.locator('.stage-bp').getByRole('button', { name: '打开正文', exact: true }).click()
    await page.getByRole('region', { name: '分支正文', exact: true }).waitFor()
    return page.getByRole('region', { name: '分支正文', exact: true })
  }
  async function waitStory(predicate, label) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await page.evaluate(() => globalThis.__testStoryInvoke('story:read'))
      assert.equal(result.success, true)
      if (predicate(result.data)) return result.data
      await page.waitForTimeout(50)
    }
    throw new Error(`Production story state did not converge: ${label}`)
  }
  await page.setViewportSize({ width: 393, height: 851 })
  await openBlueprintEditor()
  // The fixture wrote via the public controller, outside the editor's retained
  // workspace. Explicitly reload once before authoring; never refresh over dirty input.
  await page.locator('.stage-bp').getByRole('button', { name: '刷新章节树', exact: true }).click()
  await page.getByLabel('当前章节路线', { exact: true }).locator(`option[value="${storySeed.routes[0].id}"]`).waitFor({ state: 'attached' })
  await selectStoryChapter('chapter:1', 'mainline')
  await page.locator('.stage-bp').getByRole('button', { name: '打开正文', exact: true }).click()
  const mainlineEditor = page.locator('.stage-content .cm-content[contenteditable="true"]')
  await mainlineEditor.waitFor()
  const editorDocument = () => mainlineEditor.evaluate(element => {
    const view = element.cmTile?.root?.view ?? element.cmView?.view
    if (!view?.state?.doc) throw new Error('Production CodeMirror document unavailable')
    return view.state.doc.toString()
  })
  assert.equal(await editorDocument(), firstContent)
  await mainlineEditor.click()
  await page.keyboard.press('Control+End')
  const unicodeSuffix = '\n生产编辑器输入：中文、标点与🙂均保留。'
  await page.keyboard.insertText(unicodeSuffix)
  const editedMainlineContent = firstContent + unicodeSuffix
  assert.equal(await editorDocument(), editedMainlineContent)
  await openBlueprintEditor(); await selectStoryChapter('chapter:1', 'mainline')
  await page.locator('.stage-bp').getByRole('button', { name: '打开正文', exact: true }).click()
  await mainlineEditor.waitFor()
  assert.equal(await editorDocument(), editedMainlineContent, 'Switching to the blueprint discarded unsaved CodeMirror input')
  await page.getByRole('button', { name: '保存文稿', exact: true }).click()
  await page.waitForFunction(async ({ draftId, expected }) => {
    const full = await globalThis.__testInvokeProject('db:draft-get-full', draftId, globalThis.__testOpenedProject.path)
    return full.content === expected
  }, { draftId: firstDraft.id, expected: editedMainlineContent })
  checks.push('Production CodeMirror retains Unicode and unsaved input through blueprint navigation, then persists the exact manuscript; browser input is not a real IME test')

  await openBlueprintEditor(); await selectStoryChapter(storySeed.ids[1])
  await page.getByRole('button', { name: '添加分支蓝图', exact: true }).click()
  await page.locator('.stage-bp-card').getByLabel(/主角小目标/).fill('只为森林路线独立寻找绿钥匙。')
  await page.locator('.stage-bp-card').getByRole('button', { name: '保存此章', exact: true }).click()
  await waitStory(snapshot => snapshot.nodes.find(node => node.id === storySeed.ids[1])?.chapterBlueprint?.purpose === '只为森林路线独立寻找绿钥匙。', 'independent blueprint saved')
  let prose = await openStoryProse(storySeed.ids[1])
  await prose.getByLabel('分支正文内容', { exact: true }).fill('森林路线通过真实页面保存的新正文')
  prose = await openStoryProse(storySeed.ids[2], storySeed.routes[1].id)
  assert.equal(await prose.getByLabel('分支正文内容', { exact: true }).inputValue(), '海港路线原稿')
  prose = await openStoryProse(storySeed.ids[1])
  assert.equal(await prose.getByLabel('分支正文内容', { exact: true }).inputValue(), '森林路线通过真实页面保存的新正文', 'Switching chapters erased unsaved branch input')
  await prose.getByRole('button', { name: '保存正文', exact: true }).click()
  await waitStory(snapshot => snapshot.nodes.find(node => node.id === storySeed.ids[1])?.body === '森林路线通过真实页面保存的新正文', 'independent manuscript saved')
  const persistedStory = await page.evaluate(() => globalThis.__testStoryInvoke('story:read'))
  assert.equal(persistedStory.data.nodes.find(node => node.id === storySeed.ids[1]).body, '森林路线通过真实页面保存的新正文')
  assert.equal(persistedStory.data.nodes.find(node => node.id === storySeed.ids[2]).body, '海港路线原稿')
  assert.equal(persistedStory.data.nodes.find(node => node.id === 'chapter:1').body, editedMainlineContent)
  checks.push('Unique blueprint canvas saves an independent plan and route manuscript while retaining unsaved input across chapter changes')

  const storyLease = (await projectSyncState(page)).project.sessionLease
  selection.push((await projectSyncState(page)).project.path)
  await page.getByRole('button', { name: '《安卓浏览器验证》作品菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '打开其他作品…', exact: true }).click()
  await page.waitForFunction(previousLease => globalThis.__testOpenedProject?.sessionLease !== previousLease, storyLease)
  prose = await openStoryProse(storySeed.ids[1])
  assert.equal(await prose.getByLabel('分支正文内容', { exact: true }).inputValue(), '森林路线通过真实页面保存的新正文')
  checks.push('Story node manuscripts and complete routes survive normal project reopen with a new lease')

  prose = await openStoryProse(storySeed.ids[4])
  await prose.getByLabel('分支正文内容', { exact: true }).fill('两条路线共用的新正文')
  assert.equal(await prose.getByRole('button', { name: '保存正文', exact: true }).isDisabled(), true)
  await prose.getByRole('checkbox', { name: '确认修改共用内容', exact: true }).check()
  await prose.getByRole('button', { name: '保存正文', exact: true }).click()
  await waitStory(snapshot => snapshot.nodes.find(node => node.id === storySeed.ids[4])?.body === '两条路线共用的新正文', 'shared manuscript saved after explicit confirmation')
  await prose.getByRole('button', { name: '章节蓝图', exact: true }).click()
  await page.locator('.chapter-tree-management > summary').click()
  await page.getByLabel('生成依据', { exact: true }).selectOption('shared')
  await page.getByRole('button', { name: '查看并核对前情', exact: true }).click()
  await page.getByLabel('共同事实摘要', { exact: true }).waitFor()
  await page.getByLabel('共同事实摘要', { exact: true }).fill('两条路线都已经抵达山顶，决定一起前进。')
  await page.getByLabel('人物动态状态', { exact: true }).fill('共同状态：都已在山顶重逢。')
  await page.getByLabel('入口差异说明', { exact: true }).fill('森林路线持有绿钥匙；海港路线丢失旧地图。两种状态分别保留，不当作共同事实。')
  await page.getByRole('checkbox', { name: '我已核对这些事实、状态与入口差异', exact: true }).check()
  await page.getByRole('button', { name: '确认这份前情', exact: true }).click()
  await page.getByRole('button', { name: '保存分支内容', exact: true }).click()
  await waitStory(snapshot => snapshot.notes.some(note => note.nodeId === storySeed.ids[4] && note.routeId === null && note.confirmed), 'author-confirmed common continuity saved')
  const commonContext = await page.evaluate(nodeId => globalThis.__testStoryInvoke('story:context', { nodeId, routeId: null, mode: 'shared' }), storySeed.ids[4])
  assert.equal(commonContext.success, true, JSON.stringify(commonContext))
  assert.equal(commonContext.data.readyForGeneration, true)
  assert.deepEqual(commonContext.data.prefix.map(node => node.id), [storySeed.ids[0]])
  const storyDimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  assert.ok(storyDimensions.document <= storyDimensions.viewport + 1, JSON.stringify(storyDimensions))
  await page.screenshot({ path: path.join(run, 'phone-story-branches.png'), fullPage: true })
  checks.push('Shared manuscript edits require affected-route confirmation and author-confirmed common continuity remains separate from entrance differences')

  const plotResource = page.getByRole('button', { name: '剧情与伏笔', exact: true })
  if (!await plotResource.isVisible()) await page.getByRole('button', { name: '作品导航', exact: true }).click()
  await plotResource.click()
  await page.getByRole('region', { name: '线索计划', exact: true }).waitFor()
  assert.equal(await page.locator('.stage-plot .story-tree,.stage-plot .chapter-tree-workspace').count(), 0)
  assert.equal(await page.getByRole('button', { name: '伏笔线索', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: '剧情梳理', exact: true }).click()
  await page.getByText('还没有剧情梳理', { exact: true }).waitFor()
  assert.equal(await page.locator('.stage-plot .story-tree,.stage-plot .chapter-tree-workspace').count(), 0)
  await page.getByRole('button', { name: '前往章节蓝图', exact: true }).click()
  await page.locator(`.stage-bp .chapter-tree-inspector[data-selected-story-node="${storySeed.ids[4]}"]`).waitFor()
  assert.equal(await page.getByLabel('当前章节路线', { exact: true }).inputValue(), storySeed.routes[0].id)
  checks.push('Plot defaults to foreshadowing management and offers a read-only overview while structural editing returns to the same unique blueprint node and route')

  const modelStartsBefore = await page.evaluate(() => globalThis.__testStoryCalls.filter(call => call.channel.startsWith('agent-generation:')).length)
  await page.getByRole('button', { name: 'AI 写作助手', exact: true }).click()
  const assistant = page.getByRole('complementary', { name: 'AI 写作助手', exact: true })
  await assistant.waitFor()
  const retainedPrompt = 'SYNTHETIC_UNSENT_PROMPT：先保留这段写作请求，不自动发送。'
  await assistant.locator('textarea').fill(retainedPrompt)
  await page.evaluate(() => globalThis.__androidBack())
  await assistant.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'AI 写作助手', exact: true }).click()
  await assistant.waitFor()
  assert.equal(await assistant.locator('textarea').inputValue(), retainedPrompt, 'Closing the mobile assistant discarded unsent author input')
  assert.equal(await page.evaluate(() => globalThis.__testStoryCalls.filter(call => call.channel.startsWith('agent-generation:')).length), modelStartsBefore)
  checks.push('Opening and dismissing the mobile assistant retains unsent author input and never starts an implicit model request')
  assert.equal(googleNativeCalls.filter(operation => operation === 'google.authorize').length, 0)
  assert.deepEqual(selection, [])
  assert.deepEqual(errors, [])
} catch (error) {
  errors.push(error.stack || String(error)); process.exitCode = 1
  if (diagnosticPage) {
    await diagnosticPage.screenshot({ path: path.join(run, 'failure.png'), fullPage: true }).catch(() => undefined)
    const diagnostic = await diagnosticPage.evaluate(() => ({
      text: document.querySelector('.chapter-tree-workspace,.story-manuscript')?.textContent,
      labels: [...document.querySelectorAll('.chapter-tree-workspace label,.story-manuscript label')].map(label => ({ text: label.textContent, field: label.querySelector('input,textarea,select')?.outerHTML })),
    })).catch(() => null)
    fs.writeFileSync(path.join(run, 'failure-dom.json'), JSON.stringify(diagnostic, null, 2) + '\n')
  }
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  native.close()
  const buildUnchangedDuringRun = JSON.stringify(buildFingerprint) === JSON.stringify(readBuildFingerprint(root))
  if (!buildUnchangedDuringRun) { errors.push('Production builds changed during isolated validation'); process.exitCode = 1 }
  const report = { passed: errors.length === 0, deviceTest: false, target: 'production browser bundle with Node protocol host', build: buildFingerprint, buildUnchangedDuringRun, checks, errors, artifacts: run,
    googleAuthorizationRequested: googleNativeCalls.includes('google.authorize'),
    acceptanceChanges: { baseline: 'R1 production-browser 13 checks', kept: ['startup/editor surfaces', 'archive export/restore', 'assistant and native Back', 'viewport resize', 'local sync preview/apply', 'route isolation', 'project reopen', 'shared-write confirmation', 'common continuity'],
      replaced: { legacyBranchTab: 'unique chapter blueprint canvas and linked branch manuscript', legacyAssistantPrefillButton: 'retained unsent assistant input without implicit dispatch' },
      added: ['native Google capability with no account', 'independent chapter blueprint save', 'unsaved prose retained across chapter changes', 'Plot default threads and no duplicate editor'] } }
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'story-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
