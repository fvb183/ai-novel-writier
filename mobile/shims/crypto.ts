/** Synchronous Node crypto API backed by Android JCA, with binary-safe transport. */
import { Buffer } from 'buffer'
import { nativeCall } from './fs'
function bytes(value: any, encoding?: any): Buffer {
  return typeof value === 'string' ? Buffer.from(value, encoding || 'utf8') : Buffer.from(value)
}
function output(value: string, encoding?: any): any {
  const data = Buffer.from(value, 'base64')
  return encoding ? data.toString(encoding) : data
}
class Digest {
  private chunks: Buffer[] = []
  private done = false
  private nativeDigest?: string
  private pendingBytes = 0
  constructor(private algorithm: string, private key?: Buffer, inheritedDigest?: string) {
    this.nativeDigest = inheritedDigest
  }
  update(data: any, encoding?: any) {
    if (this.done) throw new Error('Digest already called')
    const chunk = bytes(data, encoding)
    if (!this.key && !this.nativeDigest && this.pendingBytes + chunk.length > 256 * 1024) {
      this.nativeDigest = nativeCall<string>('crypto.hash.create', this.algorithm)
      for (const pending of this.chunks) nativeCall('crypto.hash.update', this.nativeDigest, pending.toString('base64'))
      this.chunks = []; this.pendingBytes = 0
    }
    if (this.nativeDigest) {
      for (let offset = 0; offset < chunk.length; offset += 256 * 1024) nativeCall('crypto.hash.update', this.nativeDigest, chunk.subarray(offset, offset + 256 * 1024).toString('base64'))
    } else { this.chunks.push(chunk); this.pendingBytes += chunk.length }
    return this
  }
  digest(encoding?: any): any {
    if (this.done) throw new Error('Digest already called')
    this.done = true
    if (this.nativeDigest) return output(nativeCall('crypto.hash.digest', this.nativeDigest), encoding)
    const payload = Buffer.concat(this.chunks).toString('base64'); this.chunks = []
    return output(this.key ? nativeCall('crypto.hmac', this.algorithm, this.key.toString('base64'), payload) : nativeCall('crypto.hash', this.algorithm, payload), encoding)
  }
  copy() { if (this.done) throw new Error('Digest already called'); const digest = new Digest(this.algorithm, this.key, this.nativeDigest ? nativeCall('crypto.hash.copy', this.nativeDigest) : undefined); digest.chunks = [...this.chunks]; digest.pendingBytes = this.pendingBytes; return digest }
}
export function createHash(algorithm: string) { return new Digest(algorithm) }
export function createHmac(algorithm: string, key: any) { return new Digest(algorithm, bytes(key)) }
export function randomBytes(size: number, callback?: (error: any, buffer?: Buffer) => void): any {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid random byte size')
  if (callback) { queueMicrotask(() => { try { callback(null, randomBytes(size)) } catch (error) { callback(error) } }); return }
  return Buffer.from(nativeCall<string>('crypto.random', size), 'base64')
}
export function randomFillSync(buffer: Uint8Array, offset = 0, size = buffer.byteLength - offset) { buffer.set(randomBytes(size), offset); return buffer }
export function randomUUID(): string {
  const data = randomBytes(16) as Buffer
  data[6] = (data[6] & 0x0f) | 0x40; data[8] = (data[8] & 0x3f) | 0x80
  const hex = data.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
class Cipher {
  private chunks: Buffer[] = []
  private aad: Buffer = Buffer.alloc(0)
  private tag: Buffer = Buffer.alloc(0)
  private done = false
  constructor(private algorithm: string, private key: Buffer, private iv: Buffer, private decrypt: boolean) {}
  setAAD(data: any) { if (this.done) throw new Error('Cipher already finalized'); this.aad = bytes(data); return this }
  setAuthTag(data: any) { this.tag = bytes(data); return this }
  getAuthTag() { if (!this.done || this.decrypt) throw new Error('Authentication tag unavailable'); return Buffer.from(this.tag) }
  setAutoPadding() { return this }
  update(data: any, inputEncoding?: any, outputEncoding?: any): any {
    if (this.done) throw new Error('Cipher already finalized')
    this.chunks.push(bytes(data, inputEncoding))
    return outputEncoding ? '' : Buffer.alloc(0)
  }
  final(outputEncoding?: any): any {
    if (this.done) throw new Error('Cipher already finalized')
    this.done = true
    const args = [this.algorithm, this.key.toString('base64'), this.iv.toString('base64'), Buffer.concat(this.chunks).toString('base64')]
    this.chunks = []
    if (this.decrypt) return output(nativeCall('crypto.decipher', ...args, this.tag.toString('base64'), this.aad.toString('base64')), outputEncoding)
    const result = nativeCall<{ data: string; tag: string }>('crypto.cipher', ...args, this.aad.toString('base64'))
    this.tag = Buffer.from(result.tag, 'base64')
    return output(result.data, outputEncoding)
  }
}
export function createCipheriv(algorithm: string, key: any, iv: any) { return new Cipher(algorithm, bytes(key), bytes(iv), false) }
export function createDecipheriv(algorithm: string, key: any, iv: any) { return new Cipher(algorithm, bytes(key), bytes(iv), true) }
export function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) throw new RangeError('Input buffers must have the same byte length')
  let different = 0; for (let i = 0; i < left.byteLength; i++) different |= left[i] ^ right[i]
  return different === 0
}
export default { createHash, createHmac, randomBytes, randomUUID, randomFillSync, createCipheriv, createDecipheriv, timingSafeEqual }
