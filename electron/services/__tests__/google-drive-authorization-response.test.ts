import http from 'node:http'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: {}, shell: {} }))
import { DesktopGoogleDriveAuthorization, type GoogleAuthorizationOptions } from '../google-drive-authorization'

const CLIENT = '123-local-oauth-response.apps.googleusercontent.com'
const DRIVE = 'https://www.googleapis.com/auth/drive.file'
const access = 'SYNTHETIC_RESPONSE_ACCESS'
const privateMarker = 'SYNTHETIC_PROVIDER_PRIVATE_DO_NOT_EXPOSE'
const good = { access_token: access, refresh_token: 'SYNTHETIC_RESPONSE_REFRESH', token_type: 'Bearer', expires_in: 3600, scope: DRIVE }
function fixture(response: () => Response | Promise<Response>, options: Partial<GoogleAuthorizationOptions> = {}) {
  let saved: unknown = { version: 1, clientId: CLIENT }
  let callback: Promise<Response> | undefined
  const fetchToken = vi.fn(async () => response())
  const auth = new DesktopGoogleDriveAuthorization({
    read: () => saved, write: value => { saved = structuredClone(value) },
    storage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('not used') }, decryptString: () => { throw new Error('not used') } },
    fetch: fetchToken,
    open: async raw => {
      const url = new URL(raw), result = new URL(url.searchParams.get('redirect_uri')!)
      result.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'SYNTHETIC_RESPONSE_CODE' }).toString()
      callback = fetch(result)
    },
    ...options,
  })
  return { auth, fetchToken, saved: () => saved, callback: () => callback! }
}

describe('Google OAuth response handling without real accounts', () => {
  it.each([
    ['invalid_request', 'The request is not valid.', 'GOOGLE_AUTH_REQUEST_REJECTED'],
    ['invalid_request', 'client_secret is missing.', 'GOOGLE_CLIENT_SECRET_REQUIRED'],
    ['invalid_client', privateMarker, 'GOOGLE_CLIENT_REJECTED'],
    ['invalid_grant', privateMarker, 'GOOGLE_AUTH_REQUIRED'],
    ['invalid_scope', privateMarker, 'GOOGLE_AUTH_SCOPE_INVALID'],
  ])('classifies a provider %s response using fixed private-data-free codes', async (error, description, code) => {
    const run = fixture(() => new Response(JSON.stringify({ error, error_description: description }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
    try {
      const result = await run.auth.accessToken(true).catch(value => value)
      expect(result).toBeInstanceOf(Error)
      expect(result.message).toBe(code)
      expect(result.message).not.toContain(privateMarker)
      const browser = await run.callback(), text = await browser.text()
      expect(browser.status).toBe(502)
      expect(text).toContain('Google connection did not complete')
      expect(text).not.toContain(description)
      expect(text).not.toContain('SYNTHETIC_')
      expect((await run.auth.status()).authorized).toBe(false)
      expect(run.saved()).toEqual({ version: 1, clientId: CLIENT })
    } finally { run.auth.cancel() }
  })

  it.each([
    [{ ...good, token_type: 'bearer' }, true, 'token type is case-insensitive'],
    [{ ...good, token_type: ' Bearer ' }, false, 'whitespace is not a token type'],
    [{ ...good, expires_in: '3600' }, false, 'numeric string is not an OAuth JSON number'],
    [{ ...good, expires_in: 0 }, false, 'expired lifetime is rejected'],
    [{ ...good, scope: `openid  ${DRIVE}   email` }, true, 'the required granted scope can be among other scopes'],
    [{ ...good, scope: undefined }, true, 'omitted scope means the originally requested scope'],
  ])('%s', async (payload, accepted, _description) => {
    const run = fixture(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }))
    try {
      if (accepted) expect(await run.auth.accessToken(true)).toBe(access)
      else await expect(run.auth.accessToken(true)).rejects.toThrow('GOOGLE_AUTH_RESPONSE_INVALID')
      const browser = await run.callback(); await browser.text()
      expect(browser.status).toBe(accepted ? 200 : 502)
      expect((await run.auth.status()).authorized).toBe(accepted)
    } finally { run.auth.cancel() }
  })

  it('classifies a valid token with no granted Drive permission as a scope failure', async () => {
    const run = fixture(() => new Response(JSON.stringify({ ...good, scope: 'openid email' })))
    try {
      await expect(run.auth.accessToken(true)).rejects.toThrow('GOOGLE_AUTH_SCOPE_INVALID')
      await (await run.callback()).text()
      expect((await run.auth.status()).authorized).toBe(false)
    } finally { run.auth.cancel() }
  })

  it('accepts gzip-compressed JSON through a real local HTTP token endpoint', async () => {
    const compressed = gzipSync(JSON.stringify(good))
    let calls = 0
    const provider = http.createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part))
      const parameters = new URLSearchParams(Buffer.concat(chunks).toString())
      expect(request.method).toBe('POST')
      expect(parameters.get('grant_type')).toBe('authorization_code')
      expect(parameters.get('client_id')).toBe(CLIENT)
      calls++
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': compressed.length }).end(compressed)
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const port = (provider.address() as { port: number }).port
    const run = fixture(() => { throw new Error('unused injected token fetch') }, { fetch, tokenEndpoint: `http://127.0.0.1:${port}/token` })
    try {
      expect(await run.auth.accessToken(true)).toBe(access)
      expect(calls).toBe(1)
      expect((await run.callback()).status).toBe(200)
    } finally { run.auth.cancel(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())) }
  })

  it('normalizes a private body-stream transport error instead of exposing its text', async () => {
    const run = fixture(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateMarker)) } })))
    try {
      await expect(run.auth.accessToken(true)).rejects.toThrow('GOOGLE_AUTH_NETWORK_FAILED')
      const browser = await run.callback(); expect(await browser.text()).not.toContain(privateMarker)
      expect((await run.auth.status()).authorized).toBe(false)
    } finally { run.auth.cancel() }
  })

  it.each([
    ['duplicate state', (url: URL) => url.searchParams.append('state', url.searchParams.get('state')!)],
    ['duplicate code', (url: URL) => url.searchParams.append('code', 'SYNTHETIC_AMBIGUOUS_CODE')],
    ['code and error', (url: URL) => url.searchParams.set('error', 'access_denied')],
    ['duplicate error', (url: URL) => { url.searchParams.delete('code'); url.searchParams.append('error', 'access_denied'); url.searchParams.append('error', 'temporarily_unavailable') }],
  ])('rejects %s without consuming or exchanging the pending authorization', async (_name, mutate) => {
    const run = fixture(() => new Response(JSON.stringify(good)))
    let rejectedStatus: number | undefined, acceptedStatus: number | undefined, exchangesAfterRejected: number | undefined
    let browserFlow: Promise<void> | undefined
    // The production system-browser hook is replaced solely to issue local HTTP
    // callbacks. No authorization request is sent to Google.
    const authorization = run.auth as unknown as { options: GoogleAuthorizationOptions }
    authorization.options.open = raw => browserFlow = (async () => {
      const start = new URL(raw), goodCallback = new URL(start.searchParams.get('redirect_uri')!)
      goodCallback.search = new URLSearchParams({ state: start.searchParams.get('state')!, code: 'SYNTHETIC_RESPONSE_CODE' }).toString()
      const ambiguous = new URL(goodCallback); mutate(ambiguous)
      const rejected = await fetch(ambiguous)
      rejectedStatus = rejected.status; await rejected.text()
      exchangesAfterRejected = run.fetchToken.mock.calls.length
      if (rejected.status !== 400) return
      const accepted = await fetch(goodCallback)
      acceptedStatus = accepted.status; await accepted.text()
    })()
    try {
      const outcome = await run.auth.accessToken(true).catch(error => error)
      await browserFlow
      expect(rejectedStatus).toBe(400)
      expect(exchangesAfterRejected).toBe(0)
      expect(acceptedStatus).toBe(200)
      expect(outcome).toBe(access)
      expect(run.fetchToken).toHaveBeenCalledTimes(1)
    } finally { run.auth.cancel() }
  })
})
