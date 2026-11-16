/** Production Android web bundle, real shelf/store/controllers/client, isolated
 * native fs/SQLite protocol host and deterministic Drive REST boundary. No real
 * account, external network, product handler replacement or project-root override.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { createNativeMock } from '../test/mobile-native-mock.mjs'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, '.runtime/mobile-drive-lifecycle')
fs.mkdirSync(output, { recursive: true })
const run = fs.mkdtempSync(path.join(output, 'run-'))
const recoveryReportArgument = process.argv.find(value => value.startsWith('--recovery-only='))?.slice('--recovery-only='.length)
const bundleDirectory = path.join(run, 'production-web')
fs.cpSync(path.join(root, 'mobile-dist'), bundleDirectory, { recursive: true })
const files = new Map(), sessions = new Map(), devices = new Map(), checks = [], errors = [], requests = []
let sequence = 0, browser, server, pageForFailure
let hardLinkAttempts = 0, exclusiveInstalls = 0
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const reply = (status, value, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(value)) })
function rest(target, options, device) {
  const url = new URL(target), method = (options.method || 'GET').toUpperCase(), headers = options.headers || {}
  assert.equal(url.origin, 'https://www.googleapis.com', 'External network is prohibited')
  assert.equal(headers.authorization, 'Bearer SYNTHETIC_MOBILE_LIFECYCLE')
  const bytes = options.body ? Buffer.from(options.body, 'base64') : Buffer.alloc(0)
  requests.push({ device: device.id, path: url.pathname, method, bytes: bytes.length })
  if (device.offline) return { error: { message: 'Synthetic offline boundary', code: 'NETWORK_ERROR' } }
  if (url.pathname === '/drive/v3/about') return reply(200, { user: { permissionId: 'synthetic-lifecycle-account' } })
  if (url.pathname === '/drive/v3/files/generateIds') return reply(200, { ids: ['synthetic_' + ++sequence] })
  if (url.pathname === '/drive/v3/changes/startPageToken') return reply(200, { startPageToken: String(sequence) })
  if (url.pathname === '/drive/v3/changes') return reply(200, { newStartPageToken: String(sequence), changes: [...files.values()].map(item => ({ fileId: item.file.id, file: clone(item.file) })) })
  if (url.pathname === '/drive/v3/files' && method === 'GET') {
    const query = url.searchParams.get('q') || '', parent = /'([^']+)' in parents/.exec(query)?.[1]
    const properties = [...query.matchAll(/key='([^']+)' and value='([^']+)'/g)]
    const found = [...files.values()].filter(({ file }) => !file.trashed && (!parent || file.parents?.includes(parent))
      && (!query.includes("mimeType = 'application/vnd.google-apps.folder'") || file.mimeType === 'application/vnd.google-apps.folder')
      && properties.every(([, key, value]) => file.appProperties?.[key] === value)).map(item => clone(item.file))
    return reply(200, { files: found })
  }
  if (url.pathname === '/drive/v3/files' && method === 'POST') {
    const file = JSON.parse(bytes); assert.ok(file.id); assert.equal(files.has(file.id), false)
    files.set(file.id, { file }); return reply(200, file)
  }
  if (url.pathname === '/upload/drive/v3/files' && method === 'POST' && url.searchParams.get('uploadType') === 'resumable') {
    const file = JSON.parse(bytes), sessionId = 'session_' + ++sequence
    sessions.set(sessionId, { file, bytes: Buffer.alloc(0), length: Number(headers['x-upload-content-length']) })
    return reply(200, {}, { location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${sessionId}` })
  }
  if (url.pathname === '/upload/drive/v3/files' && method === 'PUT') {
    const upload = sessions.get(url.searchParams.get('upload_id')); if (!upload) return reply(404, {})
    if (device.failUploadProjectName && [...files.values()].some(item => item.file.name === 'AI Novel Writer · ' + device.failUploadProjectName
      && item.file.appProperties.ainwProject === upload.file.appProperties.ainwProject)) {
      device.uploadFailures++; return reply(503, { error: { code: 503, message: 'Synthetic first upload interruption' } })
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range'] || '')
    if (!range) return files.has(upload.file.id) ? reply(200, {}) : reply(308, {}, upload.bytes.length ? { range: `bytes=0-${upload.bytes.length - 1}` } : {})
    assert.equal(Number(range[1]), upload.bytes.length); assert.equal(Number(range[2]) + 1, upload.bytes.length + bytes.length); assert.equal(Number(range[3]), upload.length)
    upload.bytes = Buffer.concat([upload.bytes, bytes])
    if (upload.bytes.length < upload.length) return reply(308, {}, { range: `bytes=0-${upload.bytes.length - 1}` })
    assert.equal(upload.bytes.length, upload.length)
    assert.equal(hash(upload.bytes), upload.file.appProperties.ainwDigest)
    upload.file.size = String(upload.bytes.length); upload.file.md5Checksum = hash(upload.bytes, 'md5')
    files.set(upload.file.id, { file: upload.file, bytes: upload.bytes }); return reply(200, upload.file)
  }
  const id = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1]
  if (id) {
    const item = files.get(id); if (!item) return reply(404, {})
    if (method === 'PATCH') { const data = JSON.parse(bytes); item.file = { ...item.file, ...data, appProperties: { ...item.file.appProperties, ...data.appProperties } }; return reply(200, item.file) }
    if (method === 'GET' && url.searchParams.get('alt') === 'media') return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: item.bytes }
    if (method === 'GET') return reply(200, item.file)
  }
  throw new Error(`Unhandled synthetic Drive request ${method} ${url.pathname}`)
}
function device(id) {
  // Keep Windows SQLite paths short; Android sees production-shaped app paths.
  const nativeRoot = fs.mkdtempSync(path.join(path.dirname(root), 'as-'))
  const value = { id, nativeRoot, native: createNativeMock(nativeRoot, { virtualPaths: true, allowHardLinks: false }), selections: [], offline: false, authorized: true, failRecentWrites: 0, failuresInjected: 0, failUploadProjectName: '', uploadFailures: 0 }
  devices.set(id, value); return value
}
function bridgeScript(id) {
  return `(() => { const hostFetch=globalThis.fetch.bind(globalThis); globalThis.AndroidBridge={
    sync(payload){const req=new XMLHttpRequest();req.open('POST','/__native/${id}',false);req.setRequestHeader('Content-Type','application/json');req.send(payload);return req.responseText},
    request(id,payload){hostFetch('/__request/${id}',{method:'POST',headers:{'Content-Type':'application/json'},body:payload}).then(r=>r.json()).then(result=>{if(result.events){for(const event of result.events)globalThis.__androidEvent(id,event.name,event.data)}else globalThis.__androidResolve(id,result)}).catch(e=>globalThis.__androidResolve(id,{ok:false,error:String(e)}))}
  };})();`
}
function recentWrite(op, args) {
  return ['fs.writeFile', 'fs.rename', 'fs.securePrepare'].includes(op) && args.some(value => typeof value === 'string' ? /recent-projects\.json/.test(value) : value && typeof value === 'object' && /recent-projects\.json/.test(String(value.relativePath || '')))
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }
async function stage(name, action) {
  const started = Date.now()
  console.log('Checking ' + name)
  try { const detail = await action(); checks.push({ name, passed: true, durationMs: Date.now() - started, ...detail }) }
  catch (error) { checks.push({ name, passed: false, error: error.stack }); throw error }
}
async function newPage(d) {
  const context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  // Fail closed on every network origin besides this local protocol host.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = await context.newPage(); pageForFailure = page
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/?device=' + d.id)
  await page.getByRole('button', { name: '新建作品', exact: true }).waitFor()
  await page.evaluate(() => {
    const invoke = window.aiNovelAPI.invoke
    window.aiNovelAPI.invoke = async (...args) => {
      const result = await invoke(...args)
      if (args[0] === 'project:open' && result.success) globalThis.__lifecycleOpenedProject = result.project
      return result
    }
  })
  return page
}
async function shelfRecents(page) { return page.evaluate(() => window.aiNovelAPI.invoke('project:recent-list')) }
async function until(predicate, message) {
  // One WebView protocol host also downloads previously published books before
  // retrying the current book. Allow the real foreground/backoff cycle to finish
  // naturally; this is still shorter than the production five-minute budget.
  const deadline = Date.now() + 120000
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 100)) }
}
function stateFile(d) {
  const visit = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? visit(path.join(directory, entry.name)) : entry.name === 'google-drive-projects.json' ? [path.join(directory, entry.name)] : [])
  const found = visit(d.nativeRoot); assert.equal(found.length, 1); return found[0]
}
function treeSnapshot(directory) {
  const entries = []
  const visit = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), info = fs.lstatSync(file)
      assert.equal(info.isSymbolicLink(), false, 'Synthetic fixture must not contain links')
      if (info.isDirectory()) visit(file)
      else if (info.isFile()) entries.push([path.relative(directory, file).replaceAll('\\', '/'), hash(fs.readFileSync(file))])
    }
  }
  visit(directory); return entries
}
function draftSnapshot(directory) {
  const data = []
  for (const [relative] of treeSnapshot(directory)) if (relative.endsWith('/.ai-novel/project.db')) {
    const db = new DatabaseSync(path.join(directory, relative), { readOnly: true })
    try { data.push([relative, db.prepare('SELECT d.id,c.body FROM drafts d JOIN contents c ON c.id=d.content_id ORDER BY d.id').all()]) } finally { db.close() }
  }
  return data
}
const book = '手机原生同步生命周期验证'
const expectedNames = [book, '首次手机上传中断后自动恢复当前作品', '首次手机上传中断后自动恢复重启'].sort()
const knowledgeOriginal = '完整知识原文：铜钥匙在旧钟后。\n\n末尾保留标记：手机原文逐字验证🙂'
let origin, a, b, c, pageA, pageB
try {
  a = device('phone-a'); b = device('phone-b'); c = device('phone-recovery')
  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      const nativeRoute = /^\/__(native|request)\/(.+)$/.exec(url.pathname)
      if (nativeRoute) {
        const d = devices.get(nativeRoute[2]); assert.ok(d)
        let raw = ''; for await (const chunk of request) raw += chunk
        const { op, args = [] } = JSON.parse(raw); response.setHeader('Content-Type', 'application/json')
        if (op === 'fs.link') hardLinkAttempts++
        if (op === 'fs.installExclusive') exclusiveInstalls++
        if (op === 'http.cancel') { response.end(JSON.stringify({ ok: true, value: null })); return }
        if (nativeRoute[1] === 'native') {
          if (d.failRecentWrites && recentWrite(op, args)) { d.failRecentWrites--; d.failuresInjected++; response.end(JSON.stringify({ ok: false, code: 'EIO', error: 'Synthetic recent-projects write interruption' })); return }
          response.end(d.native.sync(raw)); return
        }
        if (op === 'google.status') { response.end(JSON.stringify({ ok: true, value: { available: true, authorized: d.authorized } })); return }
        if (op === 'google.authorize') { response.end(JSON.stringify(d.authorized ? { ok: true, value: { accessToken: 'SYNTHETIC_MOBILE_LIFECYCLE' } } : { ok: false, error: 'GOOGLE_AUTH_REQUIRED', code: 'GOOGLE_AUTH_REQUIRED' })); return }
        if (op === 'google.cancel') { response.end(JSON.stringify({ ok: true, value: null })); return }
        if (op === 'dialog.open') { const selected = d.selections.shift() || '/android/files/Projects'; d.native.dispatch('fs.mkdir', [selected, { recursive: true }]); response.end(JSON.stringify({ ok: true, value: { canceled: false, filePaths: [selected] } })); return }
        if (op === 'http.request') {
          const result = rest(args[0], args[1], d)
          const events = result.error ? [{ name: 'error', data: result.error }] : [
            { name: 'headers', data: { status: result.status, statusText: '', headers: result.headers, url: args[0] } },
            ...(result.body?.length ? [{ name: 'data', data: result.body.toString('base64') }] : []), { name: 'end', data: null }]
          response.end(JSON.stringify({ events })); return
        }
        throw new Error(`Unexpected native asynchronous operation ${op}`)
      }
      const directory = bundleDirectory, target = path.resolve(directory, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
      const relative = path.relative(directory, target); assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative))
      let bytes = fs.readFileSync(target)
      if (target.endsWith('index.html')) { const id = url.searchParams.get('device'); assert.ok(devices.has(id)); bytes = bytes.toString().replace('<head>', '<head><script>' + bridgeScript(id) + '</script>') }
      response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' }); response.end(bytes)
    } catch (error) { errors.push(String(error)); response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: String(error) })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.AI_NOVEL_VITEST_CHROMIUM || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' })
  if (recoveryReportArgument) {
    const fixtureReport = JSON.parse(fs.readFileSync(path.resolve(recoveryReportArgument), 'utf8'))
    assert.equal(fixtureReport.realGoogleDrive, false); assert.equal(fixtureReport.externalRequests, 0); assert.equal(fixtureReport.productHandlerReplacements, 0)
    const source = path.resolve(fixtureReport.nativeRoots[2]), relative = path.relative(path.dirname(root), source)
    assert.match(relative, /^as-[A-Za-z0-9]+$/, 'Only a prior isolated protocol fixture is admitted')
    const sourceBefore = treeSnapshot(source)
    for (const missingIndex of [true, false]) await stage(`offline-legacy-project-titles-${missingIndex ? 'without-index' : 'with-uuid-placeholders'}`, async () => {
      const d = device('title-recovery-' + missingIndex); d.native.close()
      fs.cpSync(source, d.nativeRoot, { recursive: true }); d.native = createNativeMock(d.nativeRoot, { virtualPaths: true, allowHardLinks: false }); d.offline = true
      for (const [file] of treeSnapshot(d.nativeRoot)) if (file.endsWith('/recent-projects.json')) {
        const target = path.join(d.nativeRoot, file)
        fs.writeFileSync(target, missingIndex ? '[]' : JSON.stringify(JSON.parse(fs.readFileSync(target, 'utf8')).map(project => ({ ...project, name: path.posix.basename(project.path) }))))
      }
      const beforeDrafts = draftSnapshot(d.nativeRoot)
      const contentFiles = treeSnapshot(d.nativeRoot).filter(([file]) => file.includes('/.ai-novel/') && !file.endsWith('-shm'))
      const page = await newPage(d)
      await page.waitForFunction(() => document.querySelectorAll('.stage-book').length === 3, null, { timeout: 30000 })
      const recents = await shelfRecents(page); assert.deepEqual(recents.map(value => value.name).sort(), expectedNames)
      for (const title of expectedNames) assert.equal(await page.getByRole('button', { name: `预览《${title}》`, exact: true }).count(), 1)
      assert.deepEqual(treeSnapshot(d.nativeRoot).filter(([file]) => file.includes('/.ai-novel/') && !file.endsWith('-shm')), contentFiles, 'Library title recovery must not rewrite project DB, WAL, manifests or knowledge files')
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
      assert.ok(dimensions.document <= dimensions.viewport + 1)
      await page.screenshot({ path: path.join(run, `offline-titles-${missingIndex ? 'missing' : 'uuid'}.png`), fullPage: true })
      await page.getByRole('button', { name: `预览《${book}》`, exact: true }).dblclick()
      await page.getByRole('button', { name: `《${book}》作品菜单`, exact: true }).waitFor()
      assert.deepEqual(draftSnapshot(d.nativeRoot), beforeDrafts, 'Opening a recovered project must preserve saved manuscript rows')
      const knowledgeFiles = contentFiles.filter(([file]) => /knowledge|\.blob$/.test(file))
      for (const [file, digest] of knowledgeFiles) assert.equal(hash(fs.readFileSync(path.join(d.nativeRoot, file))), digest, 'Opening a recovered project must preserve knowledge bytes')
      await page.context().close(); d.native.close()
      assert.deepEqual(treeSnapshot(source), sourceBefore, 'Original fixture must stay untouched')
      return { chineseTitles: 3, privateCopy: d.nativeRoot, filesUnchangedOnDiscovery: contentFiles.length, sourceFilesUnchanged: sourceBefore.length,
        savedDraftsUnchangedOnOpen: true, horizontalOverflow: false, knowledgeFilesPresent: knowledgeFiles.length, knowledgeBytesUnchangedOnOpen: true }
    })
  } else {
  await stage('phone-create-and-ui-toggle-publish-through-production-client', async () => {
    pageA = await newPage(a)
    await pageA.getByRole('button', { name: '新建作品', exact: true }).click()
    await pageA.getByLabel('作品名', { exact: true }).fill(book)
    await pageA.getByRole('button', { name: '选择', exact: true }).click()
    await pageA.getByRole('button', { name: '创建作品', exact: true }).click()
    await pageA.getByRole('button', { name: `《${book}》作品菜单`, exact: true }).waitFor()
    const seeded = await pageA.evaluate(async original => {
      const p = globalThis.__lifecycleOpenedProject
      const context = { projectPath: p.path, projectId: p.id, leaseId: p.sessionLease }
      const draft = await window.aiNovelAPI.invoke('db:draft-create', { chapterNumber: 1, source: 'write', content: '合成正文：手机保存的第一章🙂', wordCount: 16 }, p.path, context)
      const knowledge = await window.aiNovelAPI.invoke('kb:import-text', original, '同步原文验证.txt', p.path, context)
      return { draft: draft.success, knowledge: knowledge.success }
    }, knowledgeOriginal)
    assert.deepEqual(seeded, { draft: true, knowledge: true })
    await pageA.getByRole('button', { name: `《${book}》作品菜单`, exact: true }).click()
    await pageA.getByRole('menuitem', { name: '回到书房', exact: true }).click()
    await pageA.getByRole('switch', { name: '开启同步', exact: true }).click()
    await pageA.waitForFunction(() => document.querySelector('.sync-book-toggle input')?.checked === true, null, { timeout: 45000 })
    assert.ok([...files.values()].some(item => item.file.appProperties.ainwKind === 'sync'))
    assert.equal([...files.values()].filter(item => item.file.appProperties.ainwKind === 'project').length, 1)
    assert.ok(requests.some(item => item.method === 'PUT')); assert.ok(requests.some(item => item.method === 'PATCH'))
    return { productionGoogleClient: true, nativeNetworkProtocol: true, externalRequests: 0 }
  })
  await stage('empty-phone-auto-download-renders-shelf-without-manual-refresh', async () => {
    pageB = await newPage(b)
    await pageB.getByRole('switch', { name: '开启同步', exact: true }).waitFor({ timeout: 45000 })
    assert.equal((await shelfRecents(pageB)).length, 1)
    await pageB.screenshot({ path: path.join(run, 'auto-joined-shelf.png'), fullPage: true })
    return { renderedBook: true, projectRootOverride: false }
  })
  await stage('webview-restart-preserves-one-book-and-sync-switch', async () => {
    await pageB.context().close(); b.native.close(); b.native = createNativeMock(b.nativeRoot, { virtualPaths: true, allowHardLinks: false })
    pageB = await newPage(b)
    await pageB.getByRole('switch', { name: '开启同步', exact: true }).waitFor({ timeout: 30000 })
    assert.equal((await shelfRecents(pageB)).length, 1)
    return { freshRenderer: true, reopenedNativeHandles: true, duplicateBooks: 0 }
  })
  // Each phone has its own WebView in reality. Stop completed replicas so this
  // single Node synchronous-XHR host is not burdened by irrelevant idle loops.
  await pageA.context().close(); await pageB.context().close()
  for (const restart of [false, true]) await stage(`failed-first-phone-upload-resumes-${restart ? 'after-restart' : 'with-current-book'}-with-one-cloud-identity`, async () => {
    const d = device('phone-upload-retry-' + restart), name = '首次手机上传中断后自动恢复' + (restart ? '重启' : '当前作品')
    // Connect this fixture's account after local creation. This avoids adding
    // unrelated offline backoff before the specific first-upload failure.
    d.authorized = false
    const page = await newPage(d)
    await page.getByRole('button', { name: '新建作品', exact: true }).click()
    await page.getByLabel('作品名', { exact: true }).fill(name)
    await page.getByRole('button', { name: '选择', exact: true }).click()
    await page.getByRole('button', { name: '创建作品', exact: true }).click()
    await page.getByRole('button', { name: `《${name}》作品菜单`, exact: true }).click()
    await page.getByRole('menuitem', { name: '回到书房', exact: true }).click()
    d.authorized = true; d.failUploadProjectName = name
    const card = page.locator('.stage-book').filter({ has: page.getByRole('button', { name: `预览《${name}》`, exact: true }) })
    await card.getByRole('switch', { name: '开启同步', exact: true }).click()
    await card.getByRole('alert').waitFor({ timeout: 45000 })
    assert.ok(d.uploadFailures >= 1)
    const cloud = [...files.values()].filter(item => item.file.name === 'AI Novel Writer · ' + name)
    assert.equal(cloud.length, 1); assert.equal(cloud[0].file.appProperties.ainwAutoSync, '0', 'Incomplete first upload must stay hidden from peer discovery')
    const before = JSON.parse(fs.readFileSync(stateFile(d), 'utf8')), projectId = cloud[0].file.appProperties.ainwProject
    assert.ok(Object.values(before.enabling || {}).some(intent => intent.projectId === projectId), 'Explicit enable intent must survive failure')
    const folderId = cloud[0].file.id
    d.failUploadProjectName = ''
    if (restart) { await page.context().close(); d.native.close(); d.native = createNativeMock(d.nativeRoot, { virtualPaths: true, allowHardLinks: false }) }
    const restarted = restart ? await newPage(d) : page
    const restartedCard = restarted.locator('.stage-book').filter({ has: restarted.getByRole('button', { name: `预览《${name}》`, exact: true }) })
    await restartedCard.getByRole('switch', { name: '开启同步', exact: true }).waitFor()
    await restarted.waitForFunction(title => [...document.querySelectorAll('.stage-book')].find(card => card.querySelector('.stage-book-name')?.textContent === title)?.querySelector('input[role=switch]')?.checked === true, name, { timeout: 45000 })
    await until(() => cloud[0].file.appProperties.ainwAutoSync === '1', 'First upload did not resume automatically after restart')
    assert.equal(cloud[0].file.appProperties.ainwAutoSync, '1')
    assert.deepEqual([...files.values()].filter(item => item.file.appProperties.ainwProject === projectId && item.file.appProperties.ainwKind === 'project').map(item => item.file.id), [folderId])
    assert.ok([...files.values()].some(item => item.file.appProperties.ainwProject === projectId && item.file.appProperties.ainwKind === 'sync'))
    // The server commits PATCH before the client receives and verifies its
    // acknowledgement; only then can the local intent be cleared.
    await until(() => !Object.values(JSON.parse(fs.readFileSync(stateFile(d), 'utf8')).enabling || {}).some(intent => intent.projectId === projectId), 'Successful upload was not acknowledged locally')
    const after = JSON.parse(fs.readFileSync(stateFile(d), 'utf8'))
    assert.equal(Object.values(after.enabling || {}).some(intent => intent.projectId === projectId), false)
    await restarted.context().close()
    return { firstUploadFailure: true, durableIntent: true, automaticRetryAfterRestart: restart, currentProjectPreserved: !restart, cloudFolderDuplicates: 0 }
  })
  await stage('committed-project-recovers-offline-after-recent-registration-interruption', async () => {
    // Keep the index unavailable throughout discovery, so the next startup must
    // reconstruct from committed folders rather than relying on a later write.
    c.failRecentWrites = 1000
    const page = await newPage(c)
    await page.waitForFunction(() => document.querySelectorAll('.stage-book').length === 3, null, { timeout: 120000 })
    assert.ok(c.failuresInjected >= 1)
    c.failRecentWrites = 0
    await page.context().close(); c.native.close(); c.native = createNativeMock(c.nativeRoot, { virtualPaths: true, allowHardLinks: false }); c.offline = true
    const recovered = await newPage(c)
    await recovered.getByRole('switch', { name: '开启同步', exact: true }).first().waitFor({ timeout: 15000 })
    const recoveredBooks = await shelfRecents(recovered)
    assert.deepEqual(recoveredBooks.map(value => value.name).sort(), expectedNames)
    const imported = recoveredBooks.find(value => value.name === book), storage = c.native.hostPath(imported.path + '/.ai-novel')
    const exactOriginal = treeSnapshot(storage).some(([file]) => {
      if (file === 'project.db' || file.startsWith('project.db-')) return false
      try { const value = JSON.parse(fs.readFileSync(path.join(storage, file), 'utf8')); return value.copy?.content === knowledgeOriginal && value.copy.contentHash === hash(Buffer.from(knowledgeOriginal)) } catch { return false }
    })
    assert.equal(exactOriginal, true, 'Recovered full knowledge original must match its source bytes and hash')
    await recovered.screenshot({ path: path.join(run, 'offline-recovered-shelf.png'), fullPage: true })
    return { injectedRecentWriteFailure: true, recoveredOffline: true, bookCopies: 3, chineseTitles: 3, exactKnowledgeOriginal: true }
  })
  }
} catch (error) {
  process.exitCode = 1
  if (pageForFailure) { try { await pageForFailure.screenshot({ path: path.join(run, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(run, 'failure-body.txt'), await pageForFailure.locator('body').innerText()) } catch {} }
  console.error(error.stack || error)
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve())
  for (const d of devices.values()) d.native.close()
  const passed = checks.length === (recoveryReportArgument ? 2 : 6) && checks.every(item => item.passed) && errors.length === 0 && hardLinkAttempts === 0
  const report = { passed, deviceTest: false, realGoogleDrive: false, externalRequests: 0, productionWebBundle: true, productHandlerReplacements: 0,
    bundleIndexSha256: hash(fs.readFileSync(path.join(bundleDirectory, 'index.html'))), sourceFingerprint: JSON.parse(fs.readFileSync(path.join(bundleDirectory, 'android-web-source.json'), 'utf8')),
    checks, errors, requests, hardLinksAllowed: false, hardLinkAttempts, exclusiveInstalls, artifacts: run, nativeRoots: [...devices.values()].map(d => d.nativeRoot) }
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(root, recoveryReportArgument ? '.runtime/r5-mobile-recovery-titles-report.json' : '.runtime/mobile-drive-lifecycle-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed, checks, errors, artifacts: run })); if (!passed) process.exitCode = 1
}
