/** Android's app-private native bridge. No remote document is allowed to own it. */
export type NativeResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string; code?: string }
type Host = typeof globalThis & {
  AndroidBridge: { sync(payload: string): string; request(id: string, payload: string): void }
  __androidResolve?: (id: string, result: NativeResult) => void
  __androidEvent?: (id: string, event: string, data: any) => void
}
const host = globalThis as Host
const pending = new Map<string, {resolve: (value: any) => void; reject: (error: Error) => void}>()
const streams = new Map<string, (event: string, data: any) => void>()
let sequence = 0
// A reloaded WebView must not accept an old Activity's callback as its new work.
const runtimeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
export const nativeId = () => `native-${runtimeId}-${++sequence}`
export function nativeSync<T = any>(op: string, ...args: unknown[]): T {
  const result = JSON.parse(host.AndroidBridge.sync(JSON.stringify({ op, args }))) as NativeResult<T>
  if (!result.ok) throw Object.assign(new Error(result.error), {code: result.code})
  return result.value
}
export function nativeRequest<T = any>(op: string, ...args: unknown[]): Promise<T> {
  return nativeRequestWithOptions<T>(op, args)
}
export interface NativeRequestOptions {
  timeoutMs?: number
  timeoutCode?: string
  signal?: AbortSignal
  onCancel?: (id: string, reason: 'timeout' | 'abort') => void
}
/** Only operations with a known budget opt in. File pickers may wait for the user. */
export function nativeRequestWithOptions<T = any>(op: string, args: unknown[], options: NativeRequestOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nativeId()
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); pending.delete(id) }
    const complete = { resolve(value: T) { cleanup(); resolve(value) }, reject(error: Error) { cleanup(); reject(error) } }
    const cancel = (reason: 'timeout' | 'abort') => {
      if (!pending.has(id)) return
      const error = reason === 'timeout' ? new Error(options.timeoutCode ?? 'NATIVE_REQUEST_TIMEOUT')
        : options.signal?.reason ?? new Error('NATIVE_REQUEST_CANCELLED')
      complete.reject(error)
      try { options.onCancel?.(id, reason) } catch { /* The original operation already ended. */ }
    }
    const abort = () => cancel('abort')
    if (options.signal?.aborted) { reject(options.signal.reason ?? new Error('NATIVE_REQUEST_CANCELLED')); return }
    pending.set(id, complete)
    if (options.timeoutMs !== undefined) timer = setTimeout(() => cancel('timeout'), options.timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    try { host.AndroidBridge.request(id, JSON.stringify({op,args})) }
    catch (error) { cleanup(); reject(error) }
  })
}
host.__androidResolve = (id, result) => {
  const callback = pending.get(id)
  if (!callback) return
  pending.delete(id)
  result.ok ? callback.resolve(result.value) : callback.reject(Object.assign(new Error(result.error),{code:result.code}))
}
host.__androidEvent = (id, event, data) => streams.get(id)?.(event, data)
export function nativeStream(id: string, op: string, args: unknown[], listener: (event: string,data: any) => void): () => void {
  streams.set(id, listener)
  try { host.AndroidBridge.request(id, JSON.stringify({op,args})) }
  catch (error) { streams.delete(id); throw error }
  return () => streams.delete(id)
}
