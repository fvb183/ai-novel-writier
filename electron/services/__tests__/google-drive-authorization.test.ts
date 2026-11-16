import { createHash } from 'node:crypto'
import http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ safeStorage: {}, shell: {} }))
import { DesktopGoogleDriveAuthorization, type GoogleAuthorizationOptions } from '../google-drive-authorization'
import { deviceProtectedStorageAvailable } from '../device-protected-storage'

const clientId = '123-synthetic.apps.googleusercontent.com'
const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
  encryptString: vi.fn((value: string) => Buffer.from(`protected:${Buffer.from(value).toString('base64')}`)),
  decryptString: (value: Buffer) => Buffer.from(value.toString().replace(/^protected:/, ''), 'base64').toString() }
const tokenResponse = () => new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'SYNTHETIC_ACCESS', refresh_token: 'SYNTHETIC_REFRESH', expires_in: 3600 }))
function fixture(changes: Partial<GoogleAuthorizationOptions> = {}) {
  let document: any = { version: 1, clientId }
  const options: GoogleAuthorizationOptions = { storage, read: () => document, write: value => { document = structuredClone(value) }, open: async () => {}, fetch: vi.fn(async () => tokenResponse()), ...changes }
  return { auth: new DesktopGoogleDriveAuthorization(options), options, read: () => document }
}

describe('desktop Google authorization uses a bounded system-browser PKCE flow', () => {
  it('waits for the real HTTP token exchange before showing success, then restores the protected credential', async () => {
    let release!: () => void, entered!: () => void
    const pending = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    let authorization: URL | undefined, response!: Promise<Response>, callbackSettled = false
    const server = http.createServer(async (request, result) => {
      expect(request.url).toBe('/token'); expect(request.method).toBe('POST')
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part))
      const parameters = new URLSearchParams(Buffer.concat(parts).toString())
      expect(parameters.get('grant_type')).toBe('authorization_code')
      expect(parameters.get('redirect_uri')).toBe(authorization!.searchParams.get('redirect_uri'))
      expect(createHash('sha256').update(parameters.get('code_verifier')!).digest('base64url')).toBe(authorization!.searchParams.get('code_challenge'))
      expect(parameters.has('client_secret')).toBe(false)
      entered(); await pending
      result.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token_type: 'Bearer', access_token: 'SYNTHETIC_HTTP_ACCESS', refresh_token: 'SYNTHETIC_HTTP_REFRESH', expires_in: 3600 }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const run = fixture({ fetch, tokenEndpoint: `http://127.0.0.1:${address.port}/token`, open: async url => {
      authorization = new URL(url); const callback = new URL(authorization.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'SYNTHETIC_HTTP_CODE' }).toString()
      response = fetch(callback).then(value => { callbackSettled = true; return value })
    } })
    try {
      const authorizing = run.auth.accessToken(true)
      await started
      expect(callbackSettled).toBe(false)
      expect((await run.auth.status()).authorized).toBe(false)
      release()
      expect(await authorizing).toBe('SYNTHETIC_HTTP_ACCESS')
      const browser = await response, page = await browser.text()
      expect(browser.status).toBe(200); expect(page).toContain('Google 账户授权已完成'); expect(page).not.toContain('SYNTHETIC_')
      const restarted = new DesktopGoogleDriveAuthorization({ ...run.options, read: run.read })
      expect((await restarted.status()).authorized).toBe(true)
      expect(await restarted.accessToken(false)).toBe('SYNTHETIC_HTTP_ACCESS')
      expect(JSON.stringify(run.read())).not.toContain('SYNTHETIC_HTTP_REFRESH')
    } finally { release(); run.auth.cancel(); await new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections() }
  })
  it('shows failed exchange in the browser and reports a fixed client error without provider details', async () => {
    let response!: Promise<Response>
    const server = http.createServer((_request, result) => result.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client', error_description: 'SYNTHETIC_PRIVATE_PROVIDER_DETAILS' })))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const run = fixture({ fetch, tokenEndpoint: `http://127.0.0.1:${address.port}/token`, open: async url => {
      const authorization = new URL(url), callback = new URL(authorization.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'SYNTHETIC_HTTP_CODE' }).toString()
      response = fetch(callback)
    } })
    try {
      await expect(run.auth.accessToken(true)).rejects.toThrow('GOOGLE_CLIENT_REJECTED')
      const browser = await response, page = await browser.text()
      expect(browser.status).toBe(502); expect(page).toContain('Google 连接未完成'); expect(page).not.toContain('SYNTHETIC_')
      expect((await run.auth.status()).authorized).toBe(false)
      expect(run.read().encrypted).toBeUndefined()
    } finally { run.auth.cancel(); await new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections() }
  })
  it('uses Windows device encryption without invoking a Linux-only getter and rejects Linux plaintext fallback', () => {
    const windows = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => { throw new Error('Linux-only API') } }
    expect(deviceProtectedStorageAvailable(windows, 'win32')).toBe(true)
    expect(deviceProtectedStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }, 'linux')).toBe(false)
    expect(deviceProtectedStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'unknown' }, 'linux')).toBe(false)
  })
  it('validates callback state and exchanges the exact verifier without exposing tokens in status or stored plaintext', async () => {
    let authorization: URL | undefined
    const exchange = vi.fn(async (_url: any, init: any) => {
      const body = new URLSearchParams(init.body)
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorization!.searchParams.get('code_challenge'))
      expect(body.get('client_id')).toBe(clientId)
      expect(body.has('client_secret')).toBe(false)
      return tokenResponse()
    })
    const run = fixture({ fetch: exchange, open: async url => {
      authorization = new URL(url)
      expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorization.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
      const callback = new URL(authorization.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ state: '错'.repeat(43), code: 'SYNTHETIC_CODE' }).toString()
      expect((await fetch(callback)).status).toBe(400)
      callback.searchParams.set('state', authorization.searchParams.get('state')!)
      expect((await fetch(callback)).status).toBe(200)
    } })
    expect(await run.auth.accessToken(true)).toBe('SYNTHETIC_ACCESS')
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(await run.auth.status()).toMatchObject({ authorized: true, persistence: 'os-backed' })
    expect(JSON.stringify(await run.auth.status())).not.toContain('SYNTHETIC_ACCESS')
    expect(JSON.stringify(run.read())).not.toContain('SYNTHETIC_REFRESH')
    expect(run.read().encrypted).toBeTruthy()
    expect(await run.auth.accessToken(false)).toBe('SYNTHETIC_ACCESS')
  })
  it('never stores plaintext when protected credential storage is unavailable', async () => {
    const run = fixture({ storage: { ...storage, isEncryptionAvailable: () => false }, open: async url => {
      const request = new URL(url), callback = new URL(request.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ state: request.searchParams.get('state')!, code: 'SYNTHETIC_CODE' }).toString()
      await fetch(callback)
    } })
    await run.auth.accessToken(true)
    expect(run.read()).toEqual({ version: 1, clientId })
    expect(await run.auth.status()).toMatchObject({ authorized: true, persistence: 'session-only' })
  })
  it('does not resurrect authorization when a token response arrives after the overall timeout', async () => {
    let release!: (response: Response) => void, entered!: () => void
    const exchanging = new Promise<void>(resolve => { entered = resolve })
    const response = new Promise<Response>(resolve => { release = resolve })
    const run = fixture({ timeoutMs: 100, fetch: vi.fn(async () => { entered(); return response }), open: async url => {
      const request = new URL(url), callback = new URL(request.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ state: request.searchParams.get('state')!, code: 'SYNTHETIC_CODE' }).toString()
      await fetch(callback)
    } })
    const result = run.auth.accessToken(true).catch(error => error.message)
    await exchanging
    expect(await result).toBe('GOOGLE_AUTH_TIMEOUT')
    release(tokenResponse()); await new Promise(resolve => setImmediate(resolve))
    expect((await run.auth.status()).authorized).toBe(false)
    expect(run.read()).toEqual({ version: 1, clientId })
  })
  it('cancels pending authorization and rejects a late response after changing the client', async () => {
    let release!: (response: Response) => void, entered!: () => void
    const exchanging = new Promise<void>(resolve => { entered = resolve })
    const response = new Promise<Response>(resolve => { release = resolve })
    const run = fixture({ fetch: vi.fn(async () => { entered(); return response }), open: async url => {
      const request = new URL(url), callback = new URL(request.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ state: request.searchParams.get('state')!, code: 'SYNTHETIC_CODE' }).toString()
      await fetch(callback)
    } })
    const result = run.auth.accessToken(true).catch(error => error.message)
    await exchanging
    await run.auth.configure('456-new-client.apps.googleusercontent.com')
    expect(await result).toBe('GOOGLE_AUTH_CANCELLED')
    release(tokenResponse()); await new Promise(resolve => setImmediate(resolve))
    expect((await run.auth.status()).authorized).toBe(false)
    expect(run.read().clientId).toBe('456-new-client.apps.googleusercontent.com')
  })
  it('refreshes privately, invalidates stale access, and clears local authorization even if revocation is offline', async () => {
    const tokens = { accessToken: 'OLD_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: 0 }
    const document = { version: 1, clientId, encrypted: storage.encryptString(JSON.stringify(tokens)).toString('base64') }
    const run = fixture({ read: () => document })
    await run.auth.accessToken(false)
    expect((run.options.fetch as any).mock.calls[0][1].body.get('grant_type')).toBe('refresh_token')
    await run.auth.invalidate()
    await run.auth.accessToken(false)
    expect(run.options.fetch).toHaveBeenCalledTimes(2)
    run.options.fetch = vi.fn(async () => { throw new Error('synthetic offline') })
    await expect(run.auth.disconnect()).rejects.toThrow('GOOGLE_REVOCATION_UNCONFIRMED')
    expect((await run.auth.status()).authorized).toBe(false)
    expect(run.read().encrypted).toBeUndefined()
  })
})
