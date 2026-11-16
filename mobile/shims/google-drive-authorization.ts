import { nativeRequestWithOptions } from '../bridge'
import { waitForAbortable } from '../../electron/services/google-drive-request-budget'
import type { GoogleDriveAuthorization, GoogleDriveAuthStatus } from '../../src/shared/google-drive-sync'

export const GOOGLE_SILENT_AUTH_TIMEOUT_MS = 32_000
export const GOOGLE_INTERACTIVE_AUTH_TIMEOUT_MS = 185_000

function cancelRequest(requestId?: string) {
  void nativeRequestWithOptions('google.cancel', requestId ? [{ requestId }] : [], { timeoutMs: 5_000 }).catch(() => {})
}

export function createGoogleDriveAuthorization(): GoogleDriveAuthorization {
  type Operation = { promise: Promise<string>; controller: AbortController; interactive: boolean; subscribers: Set<symbol> }
  let pending: Operation | undefined
  const subscribe = async (operation: Operation, signal?: AbortSignal): Promise<string> => {
    const subscriber = Symbol(); operation.subscribers.add(subscriber)
    try { return await waitForAbortable(operation.promise, signal) }
    finally {
      operation.subscribers.delete(subscriber)
      if (!operation.subscribers.size && signal?.aborted) operation.controller.abort(signal.reason ?? new Error('GOOGLE_AUTH_CANCELLED'))
    }
  }
  const accessToken = async (interactive: boolean, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) return waitForAbortable(Promise.resolve(''), signal)
    if (pending?.controller.signal.aborted) pending = undefined
    if (pending) {
      const current = pending
      try { return await subscribe(current, signal) }
      catch (error) {
        if (!interactive || current.interactive || signal?.aborted || !(error instanceof Error) || error.message !== 'GOOGLE_AUTH_REQUIRED') throw error
        return accessToken(true, signal)
      }
    }
    const controller = new AbortController()
    const operation: Operation = { controller, interactive, promise: undefined as unknown as Promise<string>, subscribers: new Set() }
    operation.promise = nativeRequestWithOptions<{ accessToken: string }>('google.authorize', [{ interactive }], {
      signal: controller.signal,
      timeoutMs: interactive ? GOOGLE_INTERACTIVE_AUTH_TIMEOUT_MS : GOOGLE_SILENT_AUTH_TIMEOUT_MS,
      timeoutCode: 'GOOGLE_AUTH_TIMEOUT',
      onCancel: requestId => cancelRequest(requestId),
    }).then(result => {
      if (!result?.accessToken) throw new Error('GOOGLE_AUTH_REQUIRED')
      return result.accessToken
    }).finally(() => {
      if (pending === operation) pending = undefined
    })
    pending = operation
    return subscribe(operation, signal)
  }
  return {
    async status(signal?: AbortSignal): Promise<GoogleDriveAuthStatus> {
      const status = await nativeRequestWithOptions<{ available: boolean; authorized?: boolean }>('google.status', [], { signal, timeoutMs: 10_000, timeoutCode: 'GOOGLE_AUTH_TIMEOUT' })
      let authorized = Boolean(status.authorized)
      if (status.available && !authorized) {
        // Share the silent check with concurrent sync requests, without opening UI.
        try { authorized = Boolean(await accessToken(false, signal)) }
        catch (error) { if (!(error instanceof Error) || error.message !== 'GOOGLE_AUTH_REQUIRED') throw error }
      }
      return { platform: 'android', available: status.available, configured: status.available, authorized, persistence: 'google-play-services' }
    },
    async configure() { throw new Error('GOOGLE_ANDROID_CONSOLE_REQUIRED') },
    accessToken,
    async disconnect() { await nativeRequestWithOptions('google.disconnect', [], { timeoutMs: 65_000, timeoutCode: 'GOOGLE_AUTH_TIMEOUT', onCancel: id => cancelRequest(id) }) },
    async invalidate() { await nativeRequestWithOptions('google.invalidate', [], { timeoutMs: 35_000, timeoutCode: 'GOOGLE_AUTH_TIMEOUT', onCancel: id => cancelRequest(id) }) },
    cancel() { if (pending) pending.controller.abort(new Error('GOOGLE_AUTH_CANCELLED')); else cancelRequest() },
  }
}
