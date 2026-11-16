import { describe, expect, it, vi } from 'vitest'
import { DesktopNetworkTransport, networkProxyRule, type NetworkProxy, type NetworkSession } from '../network-transport'

const httpProxy: NetworkProxy = { enabled: true, type: 'http', host: '127.0.0.1', port: 17890 }
const socksProxy: NetworkProxy = { enabled: true, type: 'socks5', host: '::1', port: 17891 }
function fixture() {
  const sessions: Array<NetworkSession & { rule?: unknown }> = []
  let failNext = false
  const createSession = vi.fn(() => {
    const current = {
      setProxy: vi.fn(async (rule: unknown) => { if (failNext) { failNext = false; throw new Error('SYNTHETIC_SECRET') }; current.rule = rule }),
      fetch: vi.fn<typeof fetch>(async () => new Response('synthetic')),
      closeAllConnections: vi.fn(async () => {}), rule: undefined as unknown,
    }
    sessions.push(current)
    return current
  })
  return { transport: new DesktopNetworkTransport({ createSession, initialProxy: () => undefined }), sessions, createSession, fail: () => { failNext = true } }
}

describe('desktop network transport', () => {
  it('inherits the system route until an explicit HTTP, SOCKS5 or direct setting is committed', async () => {
    const run = fixture()
    await (await run.transport.fetch('https://example.test')).text()
    expect(run.sessions[0].rule).toEqual({ mode: 'system' })
    await run.transport.configure(httpProxy)
    await (await run.transport.fetch('https://example.test')).text()
    expect(run.sessions[1].rule).toEqual({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:17890', proxyBypassRules: '<-loopback>' })
    await run.transport.configure(socksProxy)
    expect(run.sessions[2].rule).toMatchObject({ proxyRules: 'socks5://[::1]:17891' })
    await run.transport.configure({ ...httpProxy, enabled: false })
    await (await run.transport.fetch('https://example.test')).text()
    expect(run.sessions[3].rule).toEqual({ mode: 'direct' })
    await run.transport.configure(undefined)
    await (await run.transport.fetch('https://example.test')).text()
    expect(run.sessions[4].rule).toEqual({ mode: 'system' })
    expect(run.sessions[0].closeAllConnections).toHaveBeenCalledOnce()
  })

  it('keeps an in-flight SSE body on its original session across proxy commits', async () => {
    const run = fixture()
    await run.transport.configure(httpProxy)
    let stream!: ReadableStreamDefaultController<Uint8Array>
    vi.mocked(run.sessions[0].fetch).mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(value) { stream = value } })))
    const response = await run.transport.fetch('https://example.test/stream')
    const reader = response.body!.getReader()
    await run.transport.configure(socksProxy)
    expect(run.sessions[0].closeAllConnections).not.toHaveBeenCalled()
    await (await run.transport.fetch('https://example.test/next')).text()
    expect(run.sessions[1].fetch).toHaveBeenCalledOnce()
    const payload = new TextEncoder().encode('data: 铜钥匙\n\n')
    stream.enqueue(payload.subarray(0, 8)); stream.enqueue(payload.subarray(8)); stream.close()
    const decoder = new TextDecoder(); let text = ''
    for (;;) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }) }
    text += decoder.decode()
    expect(text).toBe('data: 铜钥匙\n\n')
    expect(run.sessions[0].closeAllConnections).toHaveBeenCalledOnce()
  })

  it('publishes configuration only after apply and durable commit both succeed', async () => {
    const run = fixture()
    await run.transport.configure(httpProxy)
    run.fail()
    const commit = vi.fn()
    await expect(run.transport.configure(socksProxy, commit)).rejects.toThrow('NETWORK_PROXY_APPLY_FAILED')
    expect(commit).not.toHaveBeenCalled()
    await (await run.transport.fetch('https://example.test')).text()
    expect(run.sessions[0].fetch).toHaveBeenCalledOnce()
    await expect(run.transport.configure(socksProxy, () => { throw new Error('disk fixture failure') })).rejects.toThrow('disk fixture failure')
    await (await run.transport.fetch('https://example.test')).text()
    expect(run.sessions[0].fetch).toHaveBeenCalledTimes(2)
    expect(run.sessions[2].closeAllConnections).toHaveBeenCalledOnce()
  })

  it('serializes configuration preparation and snapshots requests in invocation order', async () => {
    let resolve!: () => void
    const firstApply = new Promise<void>(done => { resolve = done })
    const sessions: NetworkSession[] = []
    const transport = new DesktopNetworkTransport({ initialProxy: () => undefined, createSession: () => {
      const current = { setProxy: vi.fn(async () => { if (sessions.length === 1) await firstApply }),
        fetch: vi.fn<typeof fetch>(async () => new Response('ordered')), closeAllConnections: vi.fn(async () => {}) }
      sessions.push(current); return current
    } })
    const commitA = vi.fn(), commitB = vi.fn()
    const applyA = transport.configure(httpProxy, commitA)
    const fetchA = transport.fetch('https://example.test/a')
    const applyB = transport.configure(socksProxy, commitB)
    await vi.waitFor(() => expect(sessions).toHaveLength(1))
    expect(commitA).not.toHaveBeenCalled(); expect(commitB).not.toHaveBeenCalled()
    resolve(); await applyA
    await (await fetchA).text(); await applyB
    expect(sessions[0].fetch).toHaveBeenCalledOnce()
    await (await transport.fetch('https://example.test/b')).text()
    expect(sessions[1].fetch).toHaveBeenCalledOnce()
  })

  it('captures the selected proxy before a queued caller can mutate its input object', async () => {
    const run = fixture(), selected = { ...httpProxy } as NonNullable<NetworkProxy>
    const operation = run.transport.configure(selected)
    selected.port = 19000
    await operation
    expect(run.sessions[0].rule).toMatchObject({ proxyRules: 'http://127.0.0.1:17890' })
  })

  it('propagates abort before dispatch and through a streaming response, then retires the session', async () => {
    const run = fixture(), before = new AbortController()
    before.abort()
    await expect(run.transport.fetch('https://example.test', { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(run.createSession).not.toHaveBeenCalled()
    await run.transport.configure(httpProxy)
    const cancelled = vi.fn()
    vi.mocked(run.sessions[0].fetch).mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled })))
    const during = new AbortController()
    const response = await run.transport.fetch('https://example.test/stream', { signal: during.signal })
    const reading = response.body!.getReader().read()
    await run.transport.configure(socksProxy)
    during.abort()
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toHaveBeenCalledOnce()
    expect(run.sessions[0].closeAllConnections).toHaveBeenCalledOnce()
  })

  it('defaults to credential-free requests with redirects rejected and preserves response metadata', async () => {
    const run = fixture()
    await run.transport.configure(httpProxy)
    const original = new Response('body', { status: 202, headers: { 'x-test': 'synthetic' } })
    Object.defineProperty(original, 'url', { value: 'https://example.test/original' })
    vi.mocked(run.sessions[0].fetch).mockResolvedValueOnce(original)
    const signal = new AbortController().signal
    const response = await run.transport.fetch('https://example.test', { method: 'POST', body: 'SYNTHETIC', signal })
    expect(run.sessions[0].fetch).toHaveBeenCalledWith('https://example.test', expect.objectContaining({ method: 'POST', body: 'SYNTHETIC', signal, credentials: 'omit', redirect: 'error' }))
    expect(response.url).toBe(original.url); expect(response.status).toBe(202)
    expect(response.headers.get('x-test')).toBe('synthetic')
    expect(await response.text()).toBe('body')
  })

  it('rejects malformed proxy selections without applying or committing them', async () => {
    const run = fixture(), commit = vi.fn()
    for (const selection of [{ ...httpProxy, host: 'host/path' }, { ...httpProxy, host: 'user:password@host' }, { ...httpProxy, port: 0 }, { ...httpProxy, port: 65536 }]) {
      expect(() => run.transport.configure(selection, commit)).toThrow('NETWORK_PROXY_CONFIG_INVALID')
    }
    expect(run.createSession).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
    expect(networkProxyRule(undefined).rule).toEqual({ mode: 'system' })
    await expect(run.transport.fetch('file:///synthetic')).rejects.toThrow('NETWORK_URL_INVALID')
  })
})
