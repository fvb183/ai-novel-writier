import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ safeStorage: {}, shell: {} }))
import { DesktopGoogleDriveAuthorization, type GoogleAuthorizationOptions } from '../google-drive-authorization'

const clientId = '123-private-client-config.apps.googleusercontent.com'
const secret = 'SYNTHETIC_DESKTOP_CLIENT_SECRET'
const protectedStorage = { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${Buffer.from(value).toString('base64')}`),
  decryptString: (value: Buffer) => Buffer.from(value.toString().replace(/^protected:/, ''), 'base64').toString() }
function fixture(protectedStore = true) {
  let document: unknown = { version: 1, clientId }
  const fetchToken = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ access_token: 'SYNTHETIC_ACCESS', refresh_token: 'SYNTHETIC_REFRESH', token_type: 'Bearer', expires_in: 3600 })))
  const options: GoogleAuthorizationOptions = { read: () => document, write: value => { document = structuredClone(value) },
    storage: { ...protectedStorage, isEncryptionAvailable: () => protectedStore }, fetch: fetchToken, open: async raw => {
      const url = new URL(raw), callback = new URL(url.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'SYNTHETIC_CODE' }).toString()
      const response = await fetch(callback); await response.text()
    } }
  return { auth: new DesktopGoogleDriveAuthorization(options), options, fetchToken, document: () => document }
}

describe('desktop OAuth client secret remains local and protected', () => {
  it('uses a configured secret for authorization and refreshed tokens after a protected restart, but not revocation', async () => {
    const run = fixture()
    await run.auth.configure(clientId, secret)
    expect(await run.auth.status()).toMatchObject({ clientSecretConfigured: true, authorized: false, persistence: 'os-backed' })
    expect(JSON.stringify(run.document())).not.toContain(secret)
    expect(JSON.stringify(await run.auth.status())).not.toContain(secret)
    expect(await run.auth.accessToken(true)).toBe('SYNTHETIC_ACCESS')
    const first = new URLSearchParams(run.fetchToken.mock.calls[0][1]?.body as URLSearchParams)
    expect(first.get('client_secret')).toBe(secret)
    const restarted = new DesktopGoogleDriveAuthorization(run.options)
    expect(await restarted.status()).toMatchObject({ authorized: true, clientSecretConfigured: true })
    await restarted.invalidate(); expect(await restarted.accessToken(false)).toBe('SYNTHETIC_ACCESS')
    const refresh = new URLSearchParams(run.fetchToken.mock.calls[1][1]?.body as URLSearchParams)
    expect(refresh.get('grant_type')).toBe('refresh_token'); expect(refresh.get('client_secret')).toBe(secret)
    await restarted.disconnect()
    const revoke = new URLSearchParams(run.fetchToken.mock.calls[2][1]?.body as URLSearchParams)
    expect(revoke.get('token')).toBe('SYNTHETIC_REFRESH'); expect(revoke.has('client_secret')).toBe(false)
    expect(await restarted.status()).toMatchObject({ authorized: false, clientSecretConfigured: true })
    expect((run.document() as Record<string, unknown>).encrypted).toBeUndefined()
    expect((run.document() as Record<string, unknown>).encryptedClientSecret).toBeTruthy()
  })

  it('retains the secret only in memory if device encryption is unavailable', async () => {
    const run = fixture(false)
    await run.auth.configure(clientId, secret)
    expect(run.document()).toEqual({ version: 1, clientId })
    expect(await run.auth.status()).toMatchObject({ clientSecretConfigured: true, persistence: 'session-only' })
    expect(await run.auth.accessToken(true)).toBe('SYNTHETIC_ACCESS')
    expect(run.document()).toEqual({ version: 1, clientId })
    expect(await new DesktopGoogleDriveAuthorization(run.options).status()).toMatchObject({ clientSecretConfigured: false, authorized: false })
  })

  it('preserves a same-client secret when omitted, clears it explicitly, and never carries it to another client', async () => {
    const run = fixture()
    await run.auth.configure(clientId, secret); await run.auth.configure(clientId)
    expect((await run.auth.status()).clientSecretConfigured).toBe(true)
    await run.auth.configure(clientId, '')
    expect((await run.auth.status()).clientSecretConfigured).toBe(false)
    expect(run.document()).toEqual({ version: 1, clientId })
    await run.auth.configure(clientId, secret)
    await run.auth.configure('456-other-client.apps.googleusercontent.com')
    expect((await run.auth.status()).clientSecretConfigured).toBe(false)
    expect(JSON.stringify(run.document())).not.toContain('encryptedClientSecret')
  })

  it.each([' secret ', 'line\nbreak', 'x'.repeat(4097)])('rejects invalid secret without changing the current configuration', async invalid => {
    const run = fixture()
    await expect(run.auth.configure(clientId, invalid)).rejects.toThrow('GOOGLE_CLIENT_SECRET_INVALID')
    expect(run.document()).toEqual({ version: 1, clientId })
    expect((await run.auth.status()).clientSecretConfigured).toBe(false)
  })

  it('does not persist plaintext when a nominally available device encryption backend fails', async () => {
    const run = fixture()
    run.options.storage.encryptString = () => { throw new Error('device storage unavailable') }
    await run.auth.configure(clientId, secret)
    expect(run.document()).toEqual({ version: 1, clientId })
    expect(await run.auth.status()).toMatchObject({ clientSecretConfigured: true, persistence: 'session-only' })
  })
})
