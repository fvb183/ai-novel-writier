/** Real Electron main-process probe. Run through scripts/test-desktop-network-proxy.mjs. */
import { app, session } from 'electron'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID, X509Certificate } from 'node:crypto'
import { DesktopNetworkTransport, type NetworkProxy } from '../network-transport'
import { installNetworkTransport, networkFetch, commitNetworkProxy } from '../network-fetch'
import { OpenAIProvider } from '../../llm/openai-provider'
import { GeminiProvider } from '../../llm/gemini-provider'
import { ModelDiscoveryService } from '../model-discovery-service'
import { embedOpenAI, embedGemini } from '../../embedding'
import { GoogleDriveClient } from '../google-drive-client'
import { DesktopGoogleDriveAuthorization } from '../google-drive-authorization'
import { installDesktopNetworkTransport } from '../desktop-network'
import { prepareGlobalDataFixture } from './global-data-fixture'
import { DEFAULT_GLOBAL_CONFIG, GLOBAL_CONFIG_PATH, writeJsonFile } from '../../utils/config-utils'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('disable-background-networking')
app.disableHardwareAcceleration()

type Traffic = { via: string; method?: string; path?: string }
const traffic: Traffic[] = [], sockets = new Set<net.Socket>()
const results: Array<{ name: string; passed: boolean; traffic: Traffic[] }> = []
const output = path.join(__dirname, 'results.json')
let failure: { name: string; message: string } | undefined
let currentTest = 'bootstrap', finishSlow: (() => void) | undefined, sinkHits = 0
let allowSyntheticCertificate = false
const openedSessions: Electron.Session[] = []
const tlsChecks: Array<{ hostname: string; error: number; matched: boolean; allowed: boolean }> = []
const servers: Array<http.Server | https.Server | net.Server> = []
function track(socket: net.Socket) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) }
function listen(server: http.Server | https.Server | net.Server): Promise<number> {
  servers.push(server); server.on('connection', track)
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)) })
}
async function test(name: string, action: () => Promise<void>, expectedVia?: string) {
  currentTest = name; const at = traffic.length
  fs.writeFileSync(path.join(__dirname, 'progress.json'), JSON.stringify({ currentTest, passed: results.length }))
  let timeout!: ReturnType<typeof setTimeout>
  try { await Promise.race([action(), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('CONTROLLED_CASE_TIMEOUT')), 10000) })]) }
  finally { clearTimeout(timeout) }
  const observed = traffic.slice(at)
  if (expectedVia) assert.deepEqual(observed.filter(item => item.via === expectedVia).map(item => item.path), observed.filter(item => item.via === 'target').map(item => item.path))
  results.push({ name, passed: true, traffic: observed })
  fs.writeFileSync(path.join(__dirname, 'progress.json'), JSON.stringify({ currentTest, passed: results.length }))
}
function json(response: http.ServerResponse, value: unknown) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }

async function run() {
  await app.whenReady()
  const sinkPort = await listen(http.createServer((_request, response) => { sinkHits++; response.end('forbidden redirect destination') }))
  let tokenCalls = 0
  const target = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    traffic.push({ via: 'target', method: request.method, path: pathname })
    const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part))
    const body = Buffer.concat(chunks).toString()
    if (pathname === '/redirect') { response.writeHead(302, { Location: `http://127.0.0.1:${sinkPort}/must-not-receive-credentials` }); response.end(); return }
    if (pathname === '/hang') return
    if (pathname === '/slow-stream' || pathname === '/abort-stream') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: first\n\n')
      if (pathname === '/slow-stream') finishSlow = () => { response.end('data: 铜钥匙\n\n') }
      return
    }
    if (pathname === '/cookie-set') { response.setHeader('Set-Cookie', 'synthetic_cookie=not-an-account; Path=/'); json(response, {}); return }
    if (pathname === '/cookie-check') { json(response, { cookie: request.headers.cookie ?? null }); return }
    if (pathname.endsWith('/chat/completions')) {
      assert.equal(request.headers.authorization, 'Bearer SYNTHETIC_LOCAL_TOKEN')
      const payload = JSON.parse(body)
      if (payload.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const encoded = Buffer.from('data: {"choices":[{"delta":{"content":"铜钥匙仍在。"}}]}\n\n')
        const split = encoded.indexOf(Buffer.from('铜')) + 1
        response.write(encoded.subarray(0, split))
        setImmediate(() => response.end(Buffer.concat([encoded.subarray(split), Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')])))
      } else json(response, { choices: [{ message: { content: '本机合成正文。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })
      return
    }
    if (pathname.endsWith(':generateContent')) { json(response, { candidates: [{ content: { parts: [{ text: '本机 Gemini 正文。' }] }, finishReason: 'STOP' }] }); return }
    if (pathname.endsWith(':batchEmbedContents')) { json(response, { embeddings: [{ values: [0.1, 0.2, 0.3] }] }); return }
    if (pathname.endsWith('/embeddings')) { json(response, { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }); return }
    if (pathname === '/v1/models') { json(response, { data: [{ id: 'synthetic-model' }] }); return }
    if (pathname === '/v1beta/models') { json(response, { models: [{ name: 'models/synthetic-model', supportedGenerationMethods: ['generateContent'] }] }); return }
    if (pathname === '/token') {
      const parameters = new URLSearchParams(body)
      assert.ok(['authorization_code', 'refresh_token'].includes(parameters.get('grant_type') ?? ''))
      tokenCalls++
      json(response, { token_type: 'Bearer', access_token: `SYNTHETIC_ACCESS_${tokenCalls}`, refresh_token: 'SYNTHETIC_REFRESH', expires_in: tokenCalls === 1 ? 1 : 3600 })
      return
    }
    if (pathname === '/revoke') { json(response, {}); return }
    if (pathname === '/drive/v3/about') { json(response, { user: { permissionId: 'synthetic-user-id' } }); return }
    json(response, { synthetic: true })
  })
  const targetPort = await listen(target), base = `http://127.0.0.1:${targetPort}`
  const cert = fs.readFileSync(path.join(__dirname, 'synthetic-cert.pem'))
  const syntheticCertificate = new X509Certificate(cert).raw
  const tlsPort = await listen(https.createServer({ key: fs.readFileSync(path.join(__dirname, 'synthetic-key.pem')), cert }, (_request, response) => {
    traffic.push({ via: 'tls-target' }); json(response, { secure: true })
  }))
  const allowedPorts = new Set([targetPort, tlsPort])
  function proxy(name: string) {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '')
      if (url.hostname !== '127.0.0.1' || !allowedPorts.has(Number(url.port)) || url.protocol !== 'http:') { response.writeHead(403); response.end(); return }
      traffic.push({ via: name, method: request.method, path: url.pathname })
      const upstream = http.request(url, { method: request.method, headers: request.headers }, incoming => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response)
      })
      upstream.on('socket', track); upstream.on('error', () => { response.writeHead(502); response.end() })
      request.pipe(upstream)
    })
    server.on('connect', (request, socket, head) => {
      const [host, rawPort] = (request.url ?? '').split(':')
      if (host !== '127.0.0.1' || !allowedPorts.has(Number(rawPort))) { socket.destroy(); return }
      traffic.push({ via: name, method: 'CONNECT' })
      const upstream = net.connect(Number(rawPort), '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream); upstream.pipe(socket)
      })
      track(upstream)
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
    })
    return server
  }
  const proxyAPort = await listen(proxy('proxy-a')), proxyBPort = await listen(proxy('proxy-b'))
  const socks = net.createServer(socket => {
    let bytes = Buffer.alloc(0), greeting = true
    const receive = (part: Buffer) => {
      bytes = Buffer.concat([bytes, part])
      if (greeting) {
        if (bytes.length < 2 || bytes.length < 2 + bytes[1]) return
        assert.equal(bytes[0], 5); assert.ok(bytes.subarray(2, 2 + bytes[1]).includes(0))
        bytes = bytes.subarray(2 + bytes[1]); socket.write(Buffer.from([5, 0])); greeting = false
      }
      if (bytes.length < 5) return
      const size = bytes[3] === 1 ? 10 : bytes[3] === 3 ? 7 + bytes[4] : 0
      if (!size) { socket.destroy(); return }
      if (bytes.length < size) return
      const host = bytes[3] === 1 ? Array.from(bytes.subarray(4, 8)).join('.') : bytes.subarray(5, 5 + bytes[4]).toString()
      const port = bytes.readUInt16BE(size - 2)
      if (!['127.0.0.1', 'localhost'].includes(host) || !allowedPorts.has(port)) { socket.destroy(); return }
      const head = bytes.subarray(size); socket.removeListener('data', receive); socket.pause()
      traffic.push({ via: 'socks5', method: 'CONNECT' })
      const upstream = net.connect(port, '127.0.0.1', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
        if (head.length) upstream.write(head)
        socket.pipe(upstream); upstream.pipe(socket); socket.resume()
      })
      track(upstream); socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
    }
    socket.on('data', receive); socket.on('error', () => {})
  })
  const socksPort = await listen(socks)
  const proxyA: NetworkProxy = { enabled: true, type: 'http', host: '127.0.0.1', port: proxyAPort }
  const proxyB: NetworkProxy = { ...proxyA, port: proxyBPort }
  const socksProxy: NetworkProxy = { ...proxyA, type: 'socks5', port: socksPort }
  const appliedModes: string[] = []
  const transport = new DesktopNetworkTransport({ initialProxy: () => undefined, createSession: () => {
    const current = session.fromPartition(`synthetic-network-probe-${randomUUID()}`, { cache: false }); openedSessions.push(current)
    current.setCertificateVerifyProc((request, callback) => {
      let matched = false
      try { matched = request.hostname === '127.0.0.1' && new X509Certificate(request.certificate.data).raw.equals(syntheticCertificate) } catch { /* Invalid certificates remain rejected. */ }
      tlsChecks.push({ hostname: request.hostname, error: request.errorCode, matched, allowed: allowSyntheticCertificate })
      callback(allowSyntheticCertificate && matched ? 0 : -3)
    })
    return { setProxy: rule => { appliedModes.push(rule.mode); return current.setProxy(rule) }, fetch: (input, init) => current.fetch(input instanceof URL ? input.href : input, init), closeAllConnections: () => current.closeAllConnections() }
  } })
  installNetworkTransport(transport)
  const model: ModelProfile = { id: 'synthetic', name: 'Synthetic', provider: 'novelai', protocol: 'openai', baseUrl: `${base}/oa/v1`,
    modelName: 'synthetic-model', apiKey: 'SYNTHETIC_LOCAL_TOKEN', temperature: 0.7, maxTokens: 128, purposes: ['generation'] }

  await test('direct HTTP ignores ambient proxy settings', async () => {
    await transport.configure({ ...proxyA, enabled: false })
    process.env.HTTP_PROXY = process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyAPort}`
    try {
      const start = traffic.length
      assert.equal((await (await networkFetch(`${base}/ping`)).json()).synthetic, true)
      assert.deepEqual(traffic.slice(start).map(item => item.via), ['target'])
    } finally { delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY }
  })
  await test('unset application route selects native system mode and preserves explicit direct selection', async () => {
    await transport.configure(undefined)
    assert.equal(appliedModes.at(-1), 'system')
    const reference = session.fromPartition(`synthetic-system-reference-${randomUUID()}`, { cache: false })
    openedSessions.push(reference)
    await reference.setProxy({ mode: 'system' })
    assert.equal(await openedSessions.at(-2)!.resolveProxy(`${base}/system-check`), await reference.resolveProxy(`${base}/system-check`))
    assert.equal((await (await networkFetch(`${base}/system-check`)).json()).synthetic, true)
    await transport.configure({ ...proxyA, enabled: false })
    assert.equal(appliedModes.at(-1), 'direct')
  })
  await test('HTTP proxy A and dynamic B then explicitly disabled direct', async () => {
    for (const [selection, expected] of [[proxyA, 'proxy-a'], [proxyB, 'proxy-b'], [{ ...proxyA, enabled: false }, 'direct']] as const) {
      await commitNetworkProxy(selection, () => {})
      const start = traffic.length; await (await networkFetch(`${base}/ping`)).text()
      const routes = traffic.slice(start).map(item => item.via)
      assert.equal(routes.includes('proxy-a'), expected === 'proxy-a'); assert.equal(routes.includes('proxy-b'), expected === 'proxy-b')
    }
  })
  await test('SOCKS5 reaches the same target without a direct fallback', async () => {
    await transport.configure(socksProxy); const start = traffic.length
    assert.equal((await (await networkFetch(`${base}/socks`)).json()).synthetic, true)
    assert.ok(traffic.slice(start).some(item => item.via === 'socks5'))
  })
  await test('in-flight SSE retains A while new requests use B', async () => {
    await transport.configure(proxyA)
    const response = await networkFetch(`${base}/slow-stream`), reader = response.body!.getReader()
    let text = new TextDecoder().decode((await reader.read()).value)
    await transport.configure(proxyB)
    const start = traffic.length; await (await networkFetch(`${base}/ping`)).text()
    assert.ok(traffic.slice(start).some(item => item.via === 'proxy-b'))
    finishSlow!()
    const decoder = new TextDecoder()
    for (;;) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }) }
    assert.equal(text + decoder.decode(), 'data: first\n\ndata: 铜钥匙\n\n')
  })
  await test('abort and timeout propagate before headers and during a body', async () => {
    await assert.rejects(networkFetch(`${base}/hang`, { signal: AbortSignal.timeout(60) }), error => error instanceof Error && error.name === 'TimeoutError')
    const controller = new AbortController(), response = await networkFetch(`${base}/abort-stream`, { signal: controller.signal })
    const reader = response.body!.getReader(); await reader.read(); controller.abort()
    await assert.rejects(reader.read(), error => error instanceof Error && error.name === 'AbortError')
  })
  await test('redirect rejection prevents credential-bearing traffic reaching a second server', async () => {
    await assert.rejects(networkFetch(`${base}/redirect`, { headers: { Authorization: 'Bearer SYNTHETIC_REDIRECT_SENTINEL' }, redirect: 'error' }))
    assert.equal(sinkHits, 0)
  })
  await test('session cookies are never attached to API requests', async () => {
    await (await networkFetch(`${base}/cookie-set`)).text()
    assert.equal((await (await networkFetch(`${base}/cookie-check`)).json()).cookie, null)
  })
  await test('NovelAI JSON and split UTF-8 SSE use the actual shared transport', async () => {
    const result = await new OpenAIProvider().generate(model, [{ role: 'user', content: '本机测试' }], { temperature: 0.2, maxTokens: 128 })
    assert.equal(result.success, true); assert.equal(result.content, '本机合成正文。')
    let text = '', completed = false
    await new OpenAIProvider().generateStream(model, [{ role: 'user', content: '本机测试' }], {
      temperature: 0.2, maxTokens: 128, signal: new AbortController().signal, visibleOnly: true, onChunk: chunk => { text += chunk }, onDone: () => { completed = true }, onError: () => { throw new Error('synthetic SSE failed') },
    })
    assert.equal(text, '铜钥匙仍在。'); assert.equal(completed, true)
  }, 'proxy-b')
  await test('OpenAI Gemini discovery and both embedding protocols share the route', async () => {
    const openai = { ...model, provider: 'custom' as const, baseUrl: base }
    assert.equal((await new OpenAIProvider().generate(openai, [{ role: 'user', content: '本机测试' }], { temperature: 0.2, maxTokens: 128 })).success, true)
    const gemini = { ...openai, provider: 'gemini' as const, protocol: 'gemini' as const }
    assert.equal((await new GeminiProvider().generate(gemini, [{ role: 'user', content: '本机测试' }], { temperature: 0.2, maxTokens: 128 })).success, true)
    assert.equal((await new ModelDiscoveryService().discoverModels(openai)).success, true)
    assert.equal((await new ModelDiscoveryService().discoverModels(gemini)).success, true)
    assert.deepEqual(await embedOpenAI(['本机文本'], openai), [[0.1, 0.2, 0.3]])
    assert.deepEqual(await embedGemini(['本机文本'], gemini), [[0.1, 0.2, 0.3]])
  }, 'proxy-b')
  await test('Google PKCE token refresh revoke and Drive default fetch all use the route', async () => {
    let document: unknown = { version: 1, clientId: '123-synthetic.apps.googleusercontent.com' }
    const authorization = new DesktopGoogleDriveAuthorization({ read: () => document, write: value => { document = value },
      storage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } },
      authorizationEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token`, revokeEndpoint: `${base}/revoke`,
      open: async raw => {
        const url = new URL(raw), callback = new URL(url.searchParams.get('redirect_uri')!)
        callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'SYNTHETIC_CODE' }).toString()
        await new Promise<void>((resolve, reject) => http.get(callback, response => { response.resume(); response.on('end', resolve) }).on('error', reject))
      },
    })
    await authorization.accessToken(true); await authorization.accessToken(false)
    assert.equal(tokenCalls, 2)
    assert.equal(await new GoogleDriveClient(() => authorization.accessToken(false), { apiBase: base }).accountId(), 'synthetic-user-id')
    await authorization.disconnect()
    assert.equal((await authorization.status()).authorized, false)
  }, 'proxy-b')
  await test('HTTPS rejects an untrusted certificate through HTTP CONNECT', async () => {
    await transport.configure(proxyA)
    await assert.rejects(networkFetch(`https://127.0.0.1:${tlsPort}/untrusted`, { signal: AbortSignal.timeout(5000) }), error => error instanceof TypeError && error.message === 'NETWORK_REQUEST_FAILED')
  })
  await test('pinned synthetic HTTPS is transported by HTTP CONNECT and SOCKS5', async () => {
    allowSyntheticCertificate = true
    for (const [selection, expected] of [[proxyB, 'proxy-b'], [socksProxy, 'socks5']] as const) {
      await transport.configure(selection); const start = traffic.length
      assert.equal((await (await networkFetch(`https://127.0.0.1:${tlsPort}/tls`, { signal: AbortSignal.timeout(5000) })).json()).secure, true)
      assert.ok(traffic.slice(start).some(item => item.via === expected && item.method === 'CONNECT'))
    }
  })
  await test('unavailable HTTP and SOCKS5 proxies fail without contacting the target directly', async () => {
    const unused = net.createServer(), port = await new Promise<number>(resolve => unused.listen(0, '127.0.0.1', () => resolve((unused.address() as net.AddressInfo).port)))
    await new Promise<void>(resolve => unused.close(() => resolve()))
    for (const type of ['http', 'socks5'] as const) {
      await transport.configure({ ...proxyA, type, port }); const start = traffic.length
      await assert.rejects(networkFetch(`${base}/must-not-fallback`, { signal: AbortSignal.timeout(3000) }), error => error instanceof TypeError && error.message === 'NETWORK_REQUEST_FAILED')
      assert.equal(traffic.slice(start).filter(item => item.via === 'target').length, 0)
    }
  })
  await test('production desktop adapter reads saved startup proxy and commits a direct route', async () => {
    await prepareGlobalDataFixture(path.join(__dirname, `startup-fixture-${randomUUID()}`))
    writeJsonFile(GLOBAL_CONFIG_PATH, { ...DEFAULT_GLOBAL_CONFIG, proxy: proxyA })
    installDesktopNetworkTransport()
    let start = traffic.length
    await (await networkFetch(`${base}/production-startup`)).text()
    assert.ok(traffic.slice(start).some(item => item.via === 'proxy-a'))
    const disabled = { ...proxyA, enabled: false }
    await commitNetworkProxy(disabled, () => writeJsonFile(GLOBAL_CONFIG_PATH, { ...DEFAULT_GLOBAL_CONFIG, proxy: disabled }))
    start = traffic.length
    await (await networkFetch(`${base}/production-direct`)).text()
    assert.deepEqual(traffic.slice(start).map(item => item.via), ['target'])
  })
}

run().catch(error => { failure = { name: currentTest, message: error instanceof Error ? error.message : 'probe failed' } }).finally(async () => {
  for (const current of openedSessions) void current.closeAllConnections().catch(() => {})
  for (const socket of sockets) socket.destroy()
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()))
  const report = { date: new Date().toISOString(), runtime: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
    scope: 'loopback only; synthetic credentials; fixture certificate pinned only inside this probe', passed: results.length, failure: failure ?? null, results, tlsChecks }
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: results.length, failure: failure ?? null }))
  app.exit(failure ? 1 : 0)
})
