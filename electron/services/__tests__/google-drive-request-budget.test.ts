import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleDriveClient } from '../google-drive-client'
import { createDriveRequestBudget, nativeReadTimeoutMs } from '../google-drive-request-budget'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Drive request lifetime', () => {
  it('includes stalled native credential lookup in the deadline and never dispatches late requests', async () => {
    vi.useFakeTimers()
    let complete!: (token: string) => void, tokenSignal: AbortSignal | undefined
    const fetcher = vi.fn()
    const client = new GoogleDriveClient(signal => { tokenSignal = signal; return new Promise(resolve => { complete = resolve }) }, { fetch: fetcher, requestTimeoutMs: 50 })
    const failure = expect(client.allocateId()).rejects.toThrow('DRIVE_REQUEST_TIMEOUT')
    await vi.advanceTimersByTimeAsync(51); await failure
    expect(tokenSignal?.aborted).toBe(true)
    complete('SYNTHETIC_LATE_TOKEN'); await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('propagates cancellation into token lookup before a network request exists', async () => {
    const owner = new AbortController(), fetcher = vi.fn(); let tokenSignal: AbortSignal | undefined
    const client = new GoogleDriveClient(signal => { tokenSignal = signal; return new Promise(() => {}) }, { signal: owner.signal, fetch: fetcher })
    const failure = expect(client.accountId()).rejects.toThrow('DRIVE_AUTO_SYNC_TIMEOUT')
    owner.abort(new Error('DRIVE_AUTO_SYNC_TIMEOUT')); await failure
    expect(tokenSignal?.aborted).toBe(true); expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps the deadline through a stalled response body and cancels its reader', async () => {
    vi.useFakeTimers(); const cancel = vi.fn(); let requestSignal: AbortSignal | undefined
    const client = new GoogleDriveClient(async () => 'SYNTHETIC_TOKEN', { requestTimeoutMs: 50,
      fetch: async (_url, init) => { requestSignal = init?.signal ?? undefined; return new Response(new ReadableStream({ cancel })) } })
    const failure = expect(client.accountId()).rejects.toThrow('DRIVE_REQUEST_TIMEOUT')
    await vi.advanceTimersByTimeAsync(51); await failure
    expect(requestSignal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce()
  })

  it('works on WebViews without AbortSignal static any or timeout', async () => {
    const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any'), timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
    try {
      Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined })
      Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined })
      const client = new GoogleDriveClient(async () => 'SYNTHETIC_TOKEN', { fetch: async () => new Response('{"user":{"permissionId":"synthetic_account"}}') })
      expect(await client.accountId()).toBe('synthetic_account')
    } finally {
      if (any) Object.defineProperty(AbortSignal, 'any', any); else Reflect.deleteProperty(AbortSignal, 'any')
      if (timeout) Object.defineProperty(AbortSignal, 'timeout', timeout); else Reflect.deleteProperty(AbortSignal, 'timeout')
    }
  })

  it('provides the native socket only the remaining request budget', async () => {
    vi.useFakeTimers(); const budget = createDriveRequestBudget(undefined, 100)
    await vi.advanceTimersByTimeAsync(40); budget.refreshNativeTimeout()
    expect(nativeReadTimeoutMs(budget.signal)).toBe(60)
    budget.finish(); expect(nativeReadTimeoutMs(budget.signal)).toBeUndefined()
  })

  it('never replays an uncertain project-creation POST after a timeout', async () => {
    vi.useFakeTimers(); const writes: AbortSignal[] = []
    const client = new GoogleDriveClient(async () => 'SYNTHETIC_TOKEN', { requestTimeoutMs: 20, fetch: async (_url, init) => {
      if (init?.method === 'POST') { writes.push(init.signal!); return new Promise(() => {}) }
      return new Response('{}', { status: 404 })
    } })
    const failure = expect(client.createProject('12345678-1234-1234-1234-123456789abc', 'Synthetic', 'reserved_id')).rejects.toThrow('DRIVE_UPLOAD_UNCONFIRMED')
    await vi.advanceTimersByTimeAsync(21); await failure
    expect(writes).toHaveLength(1); expect(writes[0].aborted).toBe(true)
  })
})
