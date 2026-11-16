/** Shared with Android fetch: a request deadline includes credential lookup and
 * response bytes. No dependency on newer AbortSignal static methods. */
const nativeTimeouts = new WeakMap<AbortSignal, number>()

export function nativeReadTimeoutMs(signal?: AbortSignal | null): number | undefined {
  return signal ? nativeTimeouts.get(signal) : undefined
}

export function driveAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error && /^(?:DRIVE|GOOGLE|SYNC)_[A-Z0-9_]+$/.test(reason.message)
    ? reason : new Error('DRIVE_CANCELLED')
}

export function waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(driveAbortError(signal)) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) { void promise.catch(() => {}); reject(driveAbortError(signal)); return }
    signal.addEventListener('abort', abort, { once: true })
    // Retain handlers after cancellation so a late native failure is consumed.
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

export function createDriveRequestBudget(externalSignal?: AbortSignal, timeoutMs = 60_000) {
  const controller = new AbortController(), deadline = Date.now() + timeoutMs
  const abort = () => controller.abort(externalSignal ? driveAbortError(externalSignal) : new Error('DRIVE_CANCELLED'))
  const timer = setTimeout(() => controller.abort(new Error('DRIVE_REQUEST_TIMEOUT')), timeoutMs)
  if (externalSignal?.aborted) abort()
  else externalSignal?.addEventListener('abort', abort, { once: true })
  const remainingMs = () => Math.max(1, deadline - Date.now())
  nativeTimeouts.set(controller.signal, remainingMs())
  return {
    signal: controller.signal,
    remainingMs,
    refreshNativeTimeout() { nativeTimeouts.set(controller.signal, remainingMs()) },
    race<T>(promise: Promise<T>): Promise<T> { return waitForAbortable(promise, controller.signal) },
    cancel() { controller.abort(new Error('DRIVE_CANCELLED')) },
    finish() { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); nativeTimeouts.delete(controller.signal) },
  }
}

export function waitForDriveResponse(promise: Promise<Response>, budget: ReturnType<typeof createDriveRequestBudget>): Promise<Response> {
  return budget.race(promise.then(response => {
    if (budget.signal.aborted) { void response.body?.cancel().catch(() => {}); throw driveAbortError(budget.signal) }
    return response
  }))
}

export function withDriveResponseBudget(response: Response, budget: ReturnType<typeof createDriveRequestBudget>): Response {
  if (!response.body) { budget.finish(); return response }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await budget.race(reader.read())
        if (part.done) { budget.finish(); controller.close() }
        else controller.enqueue(part.value)
      } catch (error) {
        budget.finish(); void reader.cancel(error).catch(() => {})
        controller.error(error)
      }
    },
    cancel(reason) {
      budget.cancel(); budget.finish()
      void reader.cancel(reason).catch(() => {})
    },
  })
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  Object.defineProperty(wrapped, 'url', { value: response.url })
  Object.defineProperty(wrapped, 'type', { value: response.type })
  return wrapped
}
