import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeRequest, nativeRequestWithOptions } from '../bridge'
import { createGoogleDriveAuthorization, GOOGLE_INTERACTIVE_AUTH_TIMEOUT_MS, GOOGLE_SILENT_AUTH_TIMEOUT_MS } from '../shims/google-drive-authorization'

type Call = { id: string; op: string; args: any[] }
let calls: Call[]
const reply = (id: string, value: unknown) => (globalThis as any).__androidResolve(id, { ok: true, value })
beforeEach(() => {
  calls = []
  vi.stubGlobal('AndroidBridge', { sync() { return '{"ok":true,"value":null}' }, request(id: string, payload: string) {
    const call = { id, ...JSON.parse(payload) }; calls.push(call)
    if (call.op === 'google.status') queueMicrotask(() => reply(id, { available: true }))
    if (call.op === 'google.cancel') queueMicrotask(() => reply(id, {}))
  } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('bounded Android authorization bridge', () => {
  it('times out only opted-in native calls, ignores their late result and keeps file pickers open', async () => {
    vi.useFakeTimers(); const cancelled = vi.fn()
    const failure = expect(nativeRequestWithOptions('google.authorize', [], { timeoutMs: 20, timeoutCode: 'GOOGLE_AUTH_TIMEOUT', onCancel: cancelled })).rejects.toThrow('GOOGLE_AUTH_TIMEOUT')
    const old = calls[0].id; const picker = nativeRequest('dialog.open'); const pickerId = calls[1].id
    await vi.advanceTimersByTimeAsync(30); await failure
    expect(cancelled).toHaveBeenCalledWith(old, 'timeout'); reply(old, 'late')
    await vi.advanceTimersByTimeAsync(300_000); reply(pickerId, 'selected')
    expect(await picker).toBe('selected'); expect(old).not.toBe(pickerId)
  })

  it('shares a silent grant lookup between status and sync', async () => {
    const auth = createGoogleDriveAuthorization(), status = auth.status(), token = auth.accessToken(false)
    await Promise.resolve(); await Promise.resolve()
    const grants = calls.filter(call => call.op === 'google.authorize')
    expect(grants).toHaveLength(1); reply(grants[0].id, { accessToken: 'SYNTHETIC_ONLY' })
    expect(await token).toBe('SYNTHETIC_ONLY'); expect((await status).authorized).toBe(true)
  })

  it('cancels the exact native request on owner abort and discards an old late token', async () => {
    const auth = createGoogleDriveAuthorization(), owner = new AbortController()
    const first = expect(auth.accessToken(false, owner.signal)).rejects.toThrow('DRIVE_AUTO_SYNC_CANCELLED')
    const oldId = calls[0].id
    owner.abort(new Error('DRIVE_AUTO_SYNC_CANCELLED')); await first
    expect(calls.find(call => call.op === 'google.cancel')?.args).toEqual([{ requestId: oldId }])
    const next = auth.accessToken(false), nextId = calls.filter(call => call.op === 'google.authorize').at(-1)!.id
    reply(oldId, { accessToken: 'STALE_SYNTHETIC_ONLY' }); reply(nextId, { accessToken: 'NEW_SYNTHETIC_ONLY' })
    expect(await next).toBe('NEW_SYNTHETIC_ONLY'); expect(nextId).not.toBe(oldId)
  })

  it('keeps a shared native grant alive for another subscriber after one sync is cancelled', async () => {
    const auth = createGoogleDriveAuthorization(), first = new AbortController()
    const cancelled = expect(auth.accessToken(false, first.signal)).rejects.toThrow('DRIVE_AUTO_SYNC_CANCELLED')
    const second = auth.accessToken(false)
    first.abort(new Error('DRIVE_AUTO_SYNC_CANCELLED')); await cancelled
    expect(calls.filter(call => call.op === 'google.cancel')).toHaveLength(0)
    const grants = calls.filter(call => call.op === 'google.authorize')
    expect(grants).toHaveLength(1); reply(grants[0].id, { accessToken: 'SHARED_SYNTHETIC_ONLY' })
    expect(await second).toBe('SHARED_SYNTHETIC_ONLY')
  })

  it('keeps silent checks short while allowing time for an interactive permission screen', async () => {
    vi.useFakeTimers(); const auth = createGoogleDriveAuthorization()
    const silent = expect(auth.accessToken(false)).rejects.toThrow('GOOGLE_AUTH_TIMEOUT')
    await vi.advanceTimersByTimeAsync(GOOGLE_SILENT_AUTH_TIMEOUT_MS + 1); await silent
    const interactive = auth.accessToken(true)
    await vi.advanceTimersByTimeAsync(GOOGLE_SILENT_AUTH_TIMEOUT_MS + 1)
    const id = calls.filter(call => call.op === 'google.authorize').at(-1)!.id
    expect(GOOGLE_INTERACTIVE_AUTH_TIMEOUT_MS).toBeGreaterThan(GOOGLE_SILENT_AUTH_TIMEOUT_MS * 2)
    reply(id, { accessToken: 'SYNTHETIC_ONLY' }); expect(await interactive).toBe('SYNTHETIC_ONLY')
  })

  it('preserves network failures from silent status instead of pretending the grant is missing', async () => {
    const auth = createGoogleDriveAuthorization(), failure = expect(auth.status()).rejects.toThrow('GOOGLE_NETWORK_ERROR')
    await Promise.resolve(); await Promise.resolve()
    const id = calls.find(call => call.op === 'google.authorize')!.id
    ;(globalThis as any).__androidResolve(id, { ok: false, error: 'GOOGLE_NETWORK_ERROR' }); await failure
  })

  it('cancels status immediately before a native status callback is delivered', async () => {
    const auth = createGoogleDriveAuthorization(), owner = new AbortController()
    const failure = expect(auth.status(owner.signal)).rejects.toThrow('DRIVE_AUTO_SYNC_CANCELLED')
    owner.abort(new Error('DRIVE_AUTO_SYNC_CANCELLED')); await failure
    expect(calls.some(call => call.op === 'google.authorize')).toBe(false)
  })

  it('cancels the native silent grant started by a status check', async () => {
    const auth = createGoogleDriveAuthorization(), owner = new AbortController()
    const failure = expect(auth.status(owner.signal)).rejects.toThrow('DRIVE_AUTO_SYNC_CANCELLED')
    await Promise.resolve(); await Promise.resolve()
    const id = calls.find(call => call.op === 'google.authorize')!.id
    owner.abort(new Error('DRIVE_AUTO_SYNC_CANCELLED')); await failure
    expect(calls.find(call => call.op === 'google.cancel')?.args).toEqual([{ requestId: id }])
  })
})
