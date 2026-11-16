import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ safeStorage: {}, shell: {} }))
import { DesktopGoogleDriveAuthorization } from '../google-drive-authorization'

const clientId = '123-synthetic.apps.googleusercontent.com'
const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
  encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() }
const response = () => new Response('{"token_type":"Bearer","access_token":"NEW_SYNTHETIC_ONLY","expires_in":3600}')
function fixture(fetcher: typeof fetch, expired = true, open: (url: string) => Promise<unknown> = async () => {}) {
  const write = vi.fn(), auth = new DesktopGoogleDriveAuthorization({ storage, fetch: fetcher, write, open,
    read: () => ({ version: 1, clientId, ...(expired ? { encrypted: Buffer.from(JSON.stringify({ accessToken: 'EXPIRED_SYNTHETIC_ONLY', refreshToken: 'REFRESH_SYNTHETIC_ONLY', expiresAt: 1 })).toString('base64') } : {}) }) })
  return { auth, write }
}
afterEach(() => vi.useRealTimers())

describe('desktop token transport cancellation', () => {
  it('aborts the last refresh subscriber transport and never saves a late response', async () => {
    let release!: (value: Response) => void, requestSignal: AbortSignal | undefined
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => { requestSignal = init?.signal ?? undefined; return new Promise(resolve => { release = resolve }) })
    const { auth, write } = fixture(fetcher), owner = new AbortController(), cancel = vi.fn()
    const failure = expect(auth.accessToken(false, owner.signal)).rejects.toThrow('DRIVE_AUTO_SYNC_CANCELLED')
    owner.abort(new Error('DRIVE_AUTO_SYNC_CANCELLED')); await failure
    expect(requestSignal?.aborted).toBe(true)
    release(new Response(new ReadableStream({ cancel })))
    await Promise.resolve(); await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled()
  })

  it('keeps a shared refresh alive when another subscriber still needs it', async () => {
    let release!: (value: Response) => void, requestSignal: AbortSignal | undefined
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => { requestSignal = init?.signal ?? undefined; return new Promise(resolve => { release = resolve }) })
    const { auth, write } = fixture(fetcher), firstOwner = new AbortController(), secondOwner = new AbortController()
    const cancelled = expect(auth.accessToken(false, firstOwner.signal)).rejects.toThrow('DRIVE_AUTO_SYNC_CANCELLED')
    const second = auth.accessToken(false, secondOwner.signal)
    firstOwner.abort(new Error('DRIVE_AUTO_SYNC_CANCELLED')); await cancelled
    expect(requestSignal?.aborted).toBe(false); expect(fetcher).toHaveBeenCalledOnce()
    release(response()); expect(await second).toBe('NEW_SYNTHETIC_ONLY'); expect(write).toHaveBeenCalledOnce()
  })

  it('bounds token response bytes after headers, not only the initial connection', async () => {
    vi.useFakeTimers(); const cancel = vi.fn()
    const { auth, write } = fixture(async () => new Response(new ReadableStream({ cancel })))
    const failure = expect(auth.accessToken(false)).rejects.toThrow('GOOGLE_AUTH_TIMEOUT')
    await vi.advanceTimersByTimeAsync(30_001); await failure
    expect(cancel).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled()
  })

  it('allows a cancelled refresh to be retried without joining its old pending promise', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Promise(() => {})).mockImplementationOnce(async () => response())
    const { auth } = fixture(fetcher), owner = new AbortController()
    const failure = expect(auth.accessToken(false, owner.signal)).rejects.toThrow('DRIVE_AUTO_SYNC_CANCELLED')
    owner.abort(new Error('DRIVE_AUTO_SYNC_CANCELLED')); await failure
    expect(await auth.accessToken(false)).toBe('NEW_SYNTHETIC_ONLY'); expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('closes an interactive callback server on outer cancellation', async () => {
    let opened!: () => void
    const started = new Promise<void>(resolve => { opened = resolve })
    const fetcher = vi.fn<typeof fetch>(), { auth, write } = fixture(fetcher, false, async () => { opened() })
    const owner = new AbortController(), failure = expect(auth.accessToken(true, owner.signal)).rejects.toThrow('DRIVE_AUTO_SYNC_CANCELLED')
    await started; owner.abort(new Error('DRIVE_AUTO_SYNC_CANCELLED')); await failure
    expect(fetcher).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  })

  it('aborts an interactive token exchange that already received its browser callback', async () => {
    let entered!: () => void, requestSignal: AbortSignal | undefined, callback: Promise<unknown> | undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => { requestSignal = init?.signal ?? undefined; entered(); return new Promise(() => {}) })
    const { auth, write } = fixture(fetcher, false, async raw => {
      const authorization = new URL(raw), target = new URL(authorization.searchParams.get('redirect_uri')!)
      target.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'SYNTHETIC_CODE_ONLY' }).toString()
      callback = fetch(target).then(response => response.body?.cancel()).catch(() => {})
    })
    const owner = new AbortController(), failure = expect(auth.accessToken(true, owner.signal)).rejects.toThrow('DRIVE_AUTO_SYNC_CANCELLED')
    await started; owner.abort(new Error('DRIVE_AUTO_SYNC_CANCELLED')); await failure
    expect(requestSignal?.aborted).toBe(true); expect(write).not.toHaveBeenCalled(); await callback
  })
})
