/** Real Electron transport probe. No real authorization code, token or secret is used. */
import { app, session, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { DesktopNetworkTransport } from '../network-transport'
import { DesktopGoogleDriveAuthorization } from '../google-drive-authorization'

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-background-networking')
const root = process.env.AI_NOVEL_OAUTH_PROBE_ROOT!
const output = process.env.AI_NOVEL_OAUTH_PROBE_OUTPUT!
const originAppData = process.env.AI_NOVEL_OAUTH_METADATA_APPDATA_ORIGIN!
const sessions: Electron.Session[] = [], servers: http.Server[] = []
const results: Array<Record<string, unknown>> = []
const report: Record<string, unknown> = { runtime: process.versions.electron, local: results, realAuthorizationRequests: 0,
  realCodesTokensSecretsSent: false, credentialDecryptionPerformed: false, userConfigurationWritten: false }
function metadata() {
  const bases = [path.join(root, '.runtime/desktop-profile/app-data'), path.join(originAppData, 'ai-novel-writer-data'), path.join(originAppData, 'ai-novel-writer')]
  const candidates: Array<{ file: string; publicId: string; modified: number }> = []
  const records = []
  for (const base of bases) {
    const files = [path.join(base, 'google-drive-authorization.json')]
    const receipt = path.join(base, '.migration/receipt.json')
    if (fs.existsSync(receipt)) {
      const generation: unknown = JSON.parse(fs.readFileSync(receipt, 'utf8')).generation
      if (typeof generation === 'string' && /^[a-f0-9-]{36}$/.test(generation)) files.push(path.join(base, 'generations', generation, 'google-drive-authorization.json'))
    }
    for (const file of files) {
      if (!fs.existsSync(file)) continue
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))
      const valid = typeof value.clientId === 'string' && /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.clientId)
      records.push({ file, validClientIdPresent: valid, protectedTokenFieldPresent: typeof value.encrypted === 'string' && value.encrypted.length > 0,
        clientSecretFieldPresent: Object.hasOwn(value, 'clientSecret') || Object.hasOwn(value, 'encryptedClientSecret'), version: value.version === 1 ? 1 : 'other' })
      if (valid) candidates.push({ file, publicId: value.clientId, modified: fs.statSync(file).mtimeMs })
    }
  }
  report.configurationMetadata = records
  candidates.sort((left, right) => right.modified - left.modified)
  if (candidates.length) report.selectedConfigurationFile = candidates[0].file
  return candidates[0]?.publicId
}
async function run() {
  await app.whenReady()
  const installed = path.join(process.env.AI_NOVEL_OAUTH_METADATA_LOCAL_ORIGIN!, 'Programs/ai-novel-writer/resources/app.asar')
  if (fs.existsSync(installed)) {
    const require = createRequire(path.join(installed, 'package.json'))
    const manifest = require(path.join(installed, 'package.json'))
    const main = fs.readFileSync(path.join(installed, manifest.main), 'utf8')
    report.installedApplicationMetadata = { version: manifest.version,
      hasDriveOAuthService: main.includes('GOOGLE_AUTH_RESPONSE_INVALID'), hasGoogleTokenEndpoint: main.includes('oauth2.googleapis.com/token'),
      hasDriveFileScope: main.includes('https://www.googleapis.com/auth/drive.file') }
  }
  const transport = new DesktopNetworkTransport({ initialProxy: () => ({ enabled: false, type: 'http', host: '127.0.0.1', port: 9 }), createSession: () => {
    const current = session.fromPartition(`oauth-response-probe-${randomUUID()}`, { cache: false }); sessions.push(current)
    return { setProxy: rule => current.setProxy(rule), closeAllConnections: () => current.closeAllConnections(),
      fetch: (input, init) => current.fetch(input instanceof URL ? input.href : input, init) }
  } })
  for (const encoding of ['plain', 'gzip', 'chunked'] as const) {
    let authUrl: URL | undefined, browser: Promise<number> | undefined, called = false
    const provider = http.createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const fields = new URLSearchParams(Buffer.concat(chunks).toString())
      const correct = request.method === 'POST' && fields.get('grant_type') === 'authorization_code'
        && fields.get('client_id') === '123-synthetic.apps.googleusercontent.com'
        && fields.get('redirect_uri') === authUrl?.searchParams.get('redirect_uri')
        && createHash('sha256').update(fields.get('code_verifier') || '').digest('base64url') === authUrl?.searchParams.get('code_challenge')
      called = correct
      if (!correct) { response.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid_request"}'); return }
      const payload = Buffer.from(JSON.stringify({ access_token: 'SYNTHETIC_ELECTRON_ACCESS', refresh_token: 'SYNTHETIC_ELECTRON_REFRESH', token_type: 'Bearer', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' }))
      if (encoding === 'gzip') {
        const bytes = gzipSync(payload)
        response.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Encoding': 'gzip', 'Content-Length': bytes.length }).end(bytes)
      } else if (encoding === 'chunked') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' }); response.write(payload.subarray(0, 19)); setImmediate(() => response.end(payload.subarray(19)))
      } else response.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': payload.length }).end(payload)
    })
    servers.push(provider); await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const port = (provider.address() as { port: number }).port
    const authorization = new DesktopGoogleDriveAuthorization({ read: () => ({ version: 1, clientId: '123-synthetic.apps.googleusercontent.com' }), write: () => {},
      storage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } },
      fetch: transport.fetch, tokenEndpoint: `http://127.0.0.1:${port}/token`, authorizationEndpoint: `http://127.0.0.1:${port}/authorize`,
      open: async raw => {
        authUrl = new URL(raw); const callback = new URL(authUrl.searchParams.get('redirect_uri')!)
        callback.search = new URLSearchParams({ state: authUrl.searchParams.get('state')!, code: 'SYNTHETIC_ELECTRON_CODE' }).toString()
        browser = new Promise((resolve, reject) => http.get(callback, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)) }).once('error', reject))
      } })
    try {
      assert.equal(await authorization.accessToken(true), 'SYNTHETIC_ELECTRON_ACCESS')
      assert.equal(await browser, 200); assert.equal(called, true)
      results.push({ encoding, passed: true, exactFormAndPkceVerified: true, callbackStatus: 200 })
    } finally { authorization.cancel(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())) }
  }
  {
    const secret = 'SYNTHETIC_ELECTRON_CLIENT_SECRET'
    let document: unknown = { version: 1, clientId: '123-synthetic.apps.googleusercontent.com' }
    let browser: Promise<number> | undefined, starts = 0, refreshes = 0, revokes = 0
    const provider = http.createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const fields = new URLSearchParams(Buffer.concat(chunks).toString())
      if (request.url === '/revoke') {
        assert.equal(fields.has('client_secret'), false); assert.equal(fields.get('token'), 'SYNTHETIC_ELECTRON_REFRESH')
        revokes++; response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return
      }
      if (!fields.has('client_secret')) {
        response.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid_request","error_description":"client_secret is missing."}'); return
      }
      assert.equal(fields.get('client_secret'), secret)
      const refresh = fields.get('grant_type') === 'refresh_token'
      if (refresh) refreshes++; else starts++
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token_type: 'Bearer', expires_in: 3600,
        access_token: 'SYNTHETIC_ELECTRON_ACCESS', ...(!refresh ? { refresh_token: 'SYNTHETIC_ELECTRON_REFRESH' } : {}) }))
    })
    servers.push(provider); await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const port = (provider.address() as { port: number }).port
    const options = { read: () => document, write: (value: unknown) => { document = value }, storage: safeStorage,
      fetch: transport.fetch, tokenEndpoint: `http://127.0.0.1:${port}/token`, revokeEndpoint: `http://127.0.0.1:${port}/revoke`,
      authorizationEndpoint: `http://127.0.0.1:${port}/authorize`, open: async (raw: string) => {
        const url = new URL(raw), callback = new URL(url.searchParams.get('redirect_uri')!)
        callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'SYNTHETIC_ELECTRON_CODE' }).toString()
        browser = new Promise<number>((resolve, reject) => http.get(callback, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)) }).once('error', reject))
      } }
    const authorization = new DesktopGoogleDriveAuthorization(options)
    try {
      await assert.rejects(authorization.accessToken(true), /GOOGLE_CLIENT_SECRET_REQUIRED/)
      assert.equal(await browser, 502)
      await authorization.configure('123-synthetic.apps.googleusercontent.com', secret)
      assert.equal(JSON.stringify(document).includes(secret), false)
      assert.equal(JSON.stringify(await authorization.status()).includes(secret), false)
      assert.equal(await authorization.accessToken(true), 'SYNTHETIC_ELECTRON_ACCESS'); assert.equal(await browser, 200)
      const protectedStore = (await authorization.status()).persistence === 'os-backed'
      const restarted = new DesktopGoogleDriveAuthorization(options)
      assert.equal((await restarted.status()).clientSecretConfigured, protectedStore)
      const active = protectedStore ? restarted : authorization
      await active.invalidate(); assert.equal(await active.accessToken(false), 'SYNTHETIC_ELECTRON_ACCESS')
      await active.disconnect(); assert.equal((await active.status()).authorized, false)
      assert.equal((await active.status()).clientSecretConfigured, true)
      assert.equal(starts, 1); assert.equal(refreshes, 1); assert.equal(revokes, 1)
      results.push({ name: 'client-secret-required-then-configured-start-refresh-revoke-restart', passed: true,
        missingSecretCallbackStatus: 502, configuredCallbackStatus: 200, protectedRestartVerified: protectedStore,
        secretInStatusOrPlaintextDocument: false, grantRequests: starts + refreshes, revokes })
    } finally { authorization.cancel(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())) }
  }
  const publicId = metadata()
  if (process.env.AI_NOVEL_OAUTH_GOOGLE_ONCE === '1' && publicId) {
    // One invalid-code request distinguishes an actual required client secret
    // from a transport/parser guess. It cannot grant account access.
    await transport.configure(undefined)
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: publicId,
      code: `SYNTHETIC_INVALID_${randomUUID()}`, code_verifier: randomBytes(48).toString('base64url'), redirect_uri: 'http://127.0.0.1:9/oauth/google/callback' })
    try {
      const response = await transport.fetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) })
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.ok(bytes.length <= 32768)
      let value: Record<string, unknown> = {}
      try { value = JSON.parse(bytes.toString('utf8')) } catch { /* Only safe shape flags are recorded. */ }
      const errors = new Set(['invalid_request', 'invalid_client', 'unauthorized_client', 'invalid_grant', 'invalid_scope', 'unsupported_grant_type', 'access_denied', 'invalid_dpop_proof', 'use_dpop_nonce', 'temporarily_unavailable', 'server_error'])
      const description = typeof value.error_description === 'string' ? value.error_description : ''
      report.googleInvalidCodeProtocolDiagnostic = { requestCount: 1, status: response.status,
        error: typeof value.error === 'string' && errors.has(value.error) ? value.error : 'other',
        explicitlyRequiresClientSecret: /\bclient_secret\b/i.test(description) && /\b(?:missing|required)\b/i.test(description),
        jsonObject: value !== null && typeof value === 'object' && !Array.isArray(value), tokenFieldPresent: Object.hasOwn(value, 'access_token') }
    } catch {
      report.googleInvalidCodeProtocolDiagnostic = { requestCount: 1, failure: 'NETWORK_OR_BOUNDED_RESPONSE_FAILED', rawDetailsRecorded: false }
    }
  } else report.googleInvalidCodeProtocolDiagnostic = { requestCount: 0, reason: publicId ? 'NOT_REQUESTED' : 'NO_CONFIGURED_PUBLIC_CLIENT_ID' }
  report.outcome = 'PASS'
}
void run().catch(() => { report.outcome = 'FAIL'; report.failure = 'CONTROLLED_PROBE_FAILED_NO_PRIVATE_DETAILS' }).finally(async () => {
  for (const server of servers) { server.closeAllConnections(); server.close() }
  for (const current of sessions) await current.closeAllConnections().catch(() => {})
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ outcome: report.outcome, localChecks: results.length, google: report.googleInvalidCodeProtocolDiagnostic }))
  app.exit(report.outcome === 'PASS' ? 0 : 1)
})
