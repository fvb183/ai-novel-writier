import { beforeEach, describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { safeStorage } from '../shims/electron'

let calls: Array<{ op: string; args: unknown[] }>
let handle: (op: string, args: unknown[]) => unknown
beforeEach(() => {
  calls = []
  Object.assign(globalThis, { AndroidBridge: { sync(payload: string) {
    const request = JSON.parse(payload)
    calls.push(request)
    try { return JSON.stringify({ ok: true, value: handle(request.op, request.args) }) }
    catch { return JSON.stringify({ ok: false, code: 'ANDROID_SECURE_STORAGE_DECRYPT_FAILED', error: 'ANDROID_SECURE_STORAGE_DECRYPT_FAILED' }) }
  }, request() {} } })
})

describe('device secure-storage bridge', () => {
  it('moves ciphertext as opaque bytes and round-trips Unicode without plain-text persistence', () => {
    const secret = 'SYNTHETIC_RESUME_URL/中文/🙂', ciphertext = Buffer.from([0, 255, 128, 13, 10, 1, 254])
    handle = (op, args) => {
      if (op === 'secureStorage.available') return true
      if (op === 'secureStorage.encrypt') { expect(args).toEqual([secret]); return ciphertext.toString('base64') }
      if (op === 'secureStorage.decrypt') { expect(args).toEqual([ciphertext.toString('base64')]); return secret }
      throw new Error('unexpected native request')
    }
    expect(safeStorage.isEncryptionAvailable()).toBe(true)
    expect(safeStorage.getSelectedStorageBackend()).toBe('android_keystore')
    const encrypted = safeStorage.encryptString(secret)
    expect(Buffer.from(encrypted)).toEqual(ciphertext)
    expect(safeStorage.decryptString(encrypted)).toBe(secret)
    expect(calls.map(call => call.op)).toEqual(['secureStorage.available', 'secureStorage.available', 'secureStorage.encrypt', 'secureStorage.decrypt'])
    expect(calls.some(call => call.op.startsWith('fs.'))).toBe(false)
  })

  it('reports unavailable storage without a plain-text fallback', () => {
    handle = () => { throw new Error('Keystore unavailable') }
    expect(safeStorage.isEncryptionAvailable()).toBe(false)
    expect(safeStorage.getSelectedStorageBackend()).toBe('unknown')
    expect(() => safeStorage.encryptString('SYNTHETIC_ONLY')).toThrow('ANDROID_SECURE_STORAGE_DECRYPT_FAILED')
    expect(calls.some(call => call.op.startsWith('fs.'))).toBe(false)
  })

  it('propagates decrypt failure instead of treating damaged data as a usable URL', () => {
    handle = () => { throw new Error('authentication failed') }
    expect(() => safeStorage.decryptString(Buffer.from('damaged synthetic envelope'))).toThrow('ANDROID_SECURE_STORAGE_DECRYPT_FAILED')
    expect(calls).toHaveLength(1)
    expect(calls[0].op).toBe('secureStorage.decrypt')
  })
})
