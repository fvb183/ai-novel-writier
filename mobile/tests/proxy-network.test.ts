import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNativeFetch, NATIVE_HTTP_IDLE_TIMEOUT_MS } from '../network'
import { createDriveRequestBudget } from '../../electron/services/google-drive-request-budget'

const config = vi.hoisted(() => ({ proxy: undefined as unknown }))
vi.mock('../../electron/utils/config-utils', () => ({ readJsonFile: () => ({ proxy: config.proxy }), GLOBAL_CONFIG_PATH: 'fixture/config.json', DEFAULT_GLOBAL_CONFIG: {} }))
let request: ReturnType<typeof vi.fn>, browserFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  config.proxy = undefined
  browserFetch = vi.fn(async () => new Response('packaged asset'))
  vi.stubGlobal('location', new URL('https://appassets.androidplatform.net/'))
  vi.stubGlobal('fetch', browserFetch)
  request = vi.fn((id: string, _payload: string) => queueMicrotask(() => {
    const emit = (globalThis as typeof globalThis & { __androidEvent: (id: string, name: string, data: unknown) => void }).__androidEvent
    emit(id, 'headers', { status: 200, headers: {}, url: 'https://synthetic.example.test/' })
    emit(id, 'end', null)
  }))
  vi.stubGlobal('AndroidBridge', { request, sync: vi.fn(() => JSON.stringify({ ok: true, value: null })) })
  installNativeFetch()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Android normalized proxy handoff', () => {
  it.each([
    [{ enabled: true, type: 'http', host: '127.0.0.1', port: 17891 }, 'http://127.0.0.1:17891'],
    [{ enabled: true, type: 'HTTP:', host: '127.0.0.1', port: '17891' }, 'http://127.0.0.1:17891'],
    [{ enabled: true, type: 'http', host: 'socks5://localhost:1080', port: 17891 }, 'socks5://localhost:1080'],
    [{ enabled: true, type: 'socks5', host: '::1', port: 17891 }, 'socks5://[::1]:17891'],
  ])('passes a canonical native proxy URL for %j', async (proxy, expected) => {
    config.proxy = proxy
    await (await fetch('https://synthetic.example.test/')).text()
    const payload = JSON.parse(request.mock.calls[0][1])
    expect(payload.op).toBe('http.request'); expect(payload.args[1].proxy).toBe(expected)
  })

  it.each([undefined, { enabled: false, type: 'http', host: '', port: 0 }])('keeps system/direct selection on the phone network without an explicit native proxy', async proxy => {
    config.proxy = proxy
    await (await fetch('https://synthetic.example.test/')).text()
    expect(JSON.parse(request.mock.calls[0][1]).args[1].proxy).toBeUndefined()
  })

  it('refuses an enabled missing host before any external native request', async () => {
    config.proxy = { enabled: true, type: 'http', host: '', port: 17891 }
    await expect(fetch('https://synthetic.example.test/')).rejects.toThrow('NETWORK_PROXY_ADDRESS_REQUIRED')
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps packaged UI resources available while a saved external proxy is incomplete', async () => {
    config.proxy = { enabled: true, type: 'http', host: '', port: 17891 }
    expect(await (await fetch('https://appassets.androidplatform.net/assets/local.js')).text()).toBe('packaged asset')
    expect(browserFetch).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled()
  })

  it('passes the remaining Drive request budget to the native socket', async () => {
    const budget = createDriveRequestBudget(undefined, 5000)
    await (await fetch('https://synthetic.example.test/', { signal: budget.signal })).text()
    expect(JSON.parse(request.mock.calls[0][1]).args[1].timeoutMs).toBeLessThanOrEqual(5000)
    budget.finish()
  })

  it('cancels a socket that never reports headers instead of leaving fetch pending', async () => {
    vi.useFakeTimers(); request.mockImplementation(() => {})
    const failure = expect(fetch('https://synthetic.example.test/')).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(NATIVE_HTTP_IDLE_TIMEOUT_MS + 1); await failure
    expect((globalThis as any).AndroidBridge.sync).toHaveBeenCalledWith(expect.stringContaining('http.cancel'))
  })

  it('rejects an incomplete native reply that ends before response headers', async () => {
    request.mockImplementation((id: string) => queueMicrotask(() => (globalThis as any).__androidEvent(id, 'end', null)))
    await expect(fetch('https://synthetic.example.test/')).rejects.toThrow('Native response ended before headers')
  })

  it('bounds a stalled body after headers and lets active long model streams continue', async () => {
    vi.useFakeTimers(); request.mockImplementation(() => {})
    const pending = fetch('https://synthetic.example.test/')
    await Promise.resolve(); await Promise.resolve()
    const id = request.mock.calls[0][0], emit = (globalThis as any).__androidEvent
    emit(id, 'headers', { status: 200, headers: {} })
    const response = await pending, body = response.text(), failure = expect(body).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' })
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(NATIVE_HTTP_IDLE_TIMEOUT_MS - 1)
      emit(id, 'data', Buffer.from('active').toString('base64'))
    }
    expect((globalThis as any).AndroidBridge.sync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(NATIVE_HTTP_IDLE_TIMEOUT_MS + 1); await failure
    expect((globalThis as any).AndroidBridge.sync).toHaveBeenCalledWith(expect.stringContaining('http.cancel'))
  })
})
