import type { GlobalConfig } from '../../src/shared/ipc-channels'
import { normalizeProxyConfig, proxyServerUrl } from '../../src/shared/proxy-config'

export type NetworkProxy = GlobalConfig['proxy']
interface ProxyRule { mode: 'system' | 'direct' | 'fixed_servers'; proxyRules?: string; proxyBypassRules?: string }
export interface NetworkSession {
  setProxy(config: ProxyRule): Promise<void>
  fetch: typeof fetch
  closeAllConnections(): Promise<void>
}
export interface NetworkTransport {
  fetch: typeof fetch
  configure(proxy: NetworkProxy, commit?: () => void): Promise<void>
}
interface Generation { key: string; session: NetworkSession; active: number; retired: boolean; closed: boolean }

export function networkProxyRule(input: NetworkProxy): { key: string; rule: ProxyRule } {
  let proxy: NetworkProxy
  try { proxy = normalizeProxyConfig(input) } catch { throw new Error('NETWORK_PROXY_CONFIG_INVALID') }
  // Match the system browser until the author explicitly saves an application route.
  if (proxy === undefined) return { key: 'system', rule: { mode: 'system' } }
  if (proxy && proxy.enabled === false) return { key: 'direct', rule: { mode: 'direct' } }
  const proxyRules = proxyServerUrl(proxy)!
  return { key: proxyRules, rule: { mode: 'fixed_servers', proxyRules, proxyBypassRules: '<-loopback>' } }
}

/** One session per committed configuration. Existing response streams keep their original route. */
export class DesktopNetworkTransport implements NetworkTransport {
  private queue: Promise<void> = Promise.resolve()
  private current?: Generation
  constructor(private readonly options: { createSession(): NetworkSession; initialProxy(): NetworkProxy; ready?(): Promise<unknown> }) {}

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(action)
    this.queue = operation.then(() => {}, () => {})
    return operation
  }
  private closeRetired(generation: Generation): void {
    if (!generation.retired || generation.active || generation.closed) return
    generation.closed = true
    void generation.session.closeAllConnections().catch(() => {})
  }
  private async create(selected: ReturnType<typeof networkProxyRule>): Promise<Generation> {
    await this.options.ready?.()
    const session = this.options.createSession()
    try { await session.setProxy(selected.rule) }
    catch {
      await session.closeAllConnections().catch(() => {})
      throw new Error('NETWORK_PROXY_APPLY_FAILED')
    }
    return { key: selected.key, session, active: 0, retired: false, closed: false }
  }
  configure(proxy: NetworkProxy, commit?: () => void): Promise<void> {
    const selected = networkProxyRule(proxy)
    return this.serialized(async () => {
      if (this.current?.key === selected.key) { commit?.(); return }
      const candidate = await this.create(selected)
      try { commit?.() } catch (error) {
        candidate.retired = true; this.closeRetired(candidate)
        throw error
      }
      const previous = this.current
      this.current = candidate
      if (previous) { previous.retired = true; this.closeRetired(previous) }
    })
  }
  private acquire(): Promise<Generation> {
    return this.serialized(async () => {
      this.current ??= await this.create(networkProxyRule(this.options.initialProxy()))
      this.current.active++
      return this.current
    })
  }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('NETWORK_URL_INVALID')
    const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    const generation = await this.acquire()
    let released = false
    let abort: (() => void) | undefined
    const release = () => {
      if (released) return
      released = true
      if (abort) signal?.removeEventListener('abort', abort)
      generation.active--
      this.closeRetired(generation)
    }
    try {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      const response = await generation.session.fetch(input, {
        ...init, credentials: 'omit', redirect: init.redirect ?? 'error',
      })
      if (!response.body) { release(); return response }
      const reader = response.body.getReader()
      let controller: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value },
        async pull() {
          try {
            const part = await reader.read()
            if (released) return
            if (part.done) { release(); controller.close() }
            else controller.enqueue(part.value)
          } catch (error) { if (!released) { release(); controller.error(error) } }
        },
        async cancel(reason) { release(); await reader.cancel(reason) },
      })
      abort = () => {
        if (released) return
        controller.error(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        void reader.cancel(signal?.reason).catch(() => {})
        release()
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      for (const property of ['url', 'redirected', 'type'] as const) Object.defineProperty(wrapped, property, { value: response[property] })
      return wrapped
    } catch (error) {
      release()
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new TypeError('NETWORK_REQUEST_FAILED')
    }
  }
}
