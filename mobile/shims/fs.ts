/** Node fs compatibility backed by Android's app-private native filesystem. */
import { Buffer } from 'buffer'
import { Readable } from 'stream'

type EncodingOptions = string | { encoding?: string | null; flag?: string; mode?: number }
type NativeStat = Record<string, any>

export function nativeCall<T = any>(op: string, ...args: unknown[]): T {
  const bridge = (globalThis as any).AndroidBridge
  if (!bridge?.sync) throw Object.assign(new Error('Android storage bridge is not available'), { code: 'ENOSYS' })
  const response = JSON.parse(bridge.sync(JSON.stringify({ op, args })))
  if (!response.ok) {
    throw Object.assign(new Error(response.error || `Native operation failed: ${op}`), {
      code: response.code || 'EIO', syscall: op, ...(response.details || {}),
    })
  }
  return response.value as T
}
function pathname(value: any): any {
  if (typeof value === 'number') return value
  if (value instanceof URL) return decodeURIComponent(value.pathname)
  if (Buffer.isBuffer(value)) return value.toString()
  return String(value)
}
function encoding(options?: EncodingOptions): any {
  return typeof options === 'string' ? options : options?.encoding
}
function decode(value: string, options?: EncodingOptions): any {
  const bytes = Buffer.from(value || '', 'base64')
  const codec = encoding(options)
  return codec && codec !== 'buffer' ? bytes.toString(codec) : bytes
}
function encode(value: any, options?: EncodingOptions): string {
  return (typeof value === 'string' ? Buffer.from(value, encoding(options) || 'utf8') : Buffer.from(value)).toString('base64')
}
export class Stats {
  [key: string]: any
  private _native: NativeStat
  constructor(value: NativeStat, bigint = false) {
    this._native = value
    for (const name of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks']) {
      this[name] = bigint ? BigInt(value[name] ?? 0) : Number(value[name] ?? 0)
    }
    for (const name of ['atime', 'mtime', 'ctime', 'birthtime']) {
      const ms = Number(value[`${name}Ms`] ?? value.mtimeMs ?? 0)
      this[`${name}Ms`] = bigint ? BigInt(Math.trunc(ms)) : ms
      this[name] = new Date(ms)
      if (bigint) this[`${name}Ns`] = BigInt(Math.trunc(ms)) * 1_000_000n
    }
  }
  isFile() { return Boolean(this._native.isFile) }
  isDirectory() { return Boolean(this._native.isDirectory) }
  isSymbolicLink() { return Boolean(this._native.isSymbolicLink) }
  isBlockDevice() { return false }
  isCharacterDevice() { return false }
  isFIFO() { return false }
  isSocket() { return false }
}
export class Dirent {
  name: string
  parentPath: string
  path: string
  private _native: NativeStat
  constructor(value: NativeStat, parent: string) {
    this.name = value.name; this.parentPath = parent; this.path = parent; this._native = value
  }
  isFile() { return Boolean(this._native.isFile) }
  isDirectory() { return Boolean(this._native.isDirectory) }
  isSymbolicLink() { return Boolean(this._native.isSymbolicLink) }
  isBlockDevice() { return false }
  isCharacterDevice() { return false }
  isFIFO() { return false }
  isSocket() { return false }
}
export function readFileSync(path: any, options?: EncodingOptions): any {
  return decode(nativeCall('fs.readFile', pathname(path)), options)
}
export function writeFileSync(path: any, data: any, options?: EncodingOptions): void {
  const opts = typeof options === 'object' ? options : {}
  nativeCall('fs.writeFile', pathname(path), encode(data, options), { flag: 'w', ...opts })
}
export function appendFileSync(path: any, data: any, options?: EncodingOptions): void {
  writeFileSync(path, data, { ...(typeof options === 'object' ? options : { encoding: options }), flag: 'a' })
}
export function statSync(path: any, options: any = {}): any {
  try { return new Stats(nativeCall('fs.stat', pathname(path), {}), options.bigint) }
  catch (error) { if (options.throwIfNoEntry === false && (error as any).code === 'ENOENT') return undefined; throw error }
}
export function lstatSync(path: any, options: any = {}): any {
  try { return new Stats(nativeCall('fs.stat', pathname(path), { lstat: true }), options.bigint) }
  catch (error) { if (options.throwIfNoEntry === false && (error as any).code === 'ENOENT') return undefined; throw error }
}
export const fstatSync = statSync
export function existsSync(path: any): boolean {
  try { return nativeCall('fs.exists', pathname(path)) } catch { return false }
}
export function realpathSync(path: any, options?: EncodingOptions): any {
  const value = nativeCall<string>('fs.realpath', pathname(path))
  return encoding(options) === 'buffer' ? Buffer.from(value) : value
}
realpathSync.native = realpathSync
/** Validates ancestors natively without granting read/list access outside the sandbox. */
export function validateDirectoryChain(path: string, options: { allowMissing?: boolean } = {}): void {
  nativeCall('fs.validateDirectoryChain', pathname(path), options)
}
export function readdirSync(path: any, options: any = {}): any[] {
  const directory = pathname(path)
  const entries = nativeCall<any[]>('fs.readdir', directory)
  const codec = encoding(options)
  return entries.map(entry => options.withFileTypes ? new Dirent(entry, directory) : codec === 'buffer' ? Buffer.from(entry.name) : entry.name)
}
export function mkdirSync(path: any, options: any = {}): string | undefined {
  return nativeCall('fs.mkdir', pathname(path), typeof options === 'number' ? { mode: options } : options)
}
export function mkdtempSync(prefix: any, options?: EncodingOptions): any {
  for (let attempt = 0; attempt < 16; attempt++) {
    const suffix = Buffer.from(nativeCall<string>('crypto.random', 8), 'base64').toString('hex').slice(0, 6)
    const target = pathname(prefix) + suffix
    try { mkdirSync(target); return encoding(options) === 'buffer' ? Buffer.from(target) : target }
    catch (error) { if ((error as any).code !== 'EEXIST') throw error }
  }
  throw Object.assign(new Error('Unable to create a unique temporary directory'), { code: 'EEXIST' })
}
export function renameSync(oldPath: any, newPath: any): void { nativeCall('fs.rename', pathname(oldPath), pathname(newPath)) }
export function rmSync(path: any, options: any = {}): void { nativeCall('fs.remove', pathname(path), options) }
export function unlinkSync(path: any): void { nativeCall('fs.remove', pathname(path), { recursive: false, force: false, fileOnly: true }) }
export function rmdirSync(path: any, options: any = {}): void { nativeCall('fs.remove', pathname(path), { ...options, directoryOnly: true }) }
export function openSync(path: any, flags: string | number = 'r', mode?: number): number { return nativeCall('fs.open', pathname(path), flags, mode) }
export function closeSync(fd: number): void { nativeCall('fs.close', fd) }
export function fsyncSync(fd: number): void { nativeCall('fs.fsync', fd) }
export function chmodSync(path: any, mode: number): void { nativeCall('fs.chmod', pathname(path), mode) }
export function linkSync(source: any, target: any): void { nativeCall('fs.link', pathname(source), pathname(target)) }
/** Complete-file publication within the exclusively owned Android sandbox. */
export function installExclusiveSync(source: any, target: any): void { nativeCall('fs.installExclusive', pathname(source), pathname(target)) }
export function writeSync(fd: number, buffer: Uint8Array, offset = 0, length = buffer.length - offset, position: number | null = null): number {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) throw new RangeError('Invalid buffer range')
  return nativeCall('fs.write', fd, Buffer.from(buffer.subarray(offset, offset + length)).toString('base64'), position)
}
export function readSync(fd: number, buffer: Uint8Array, offset = 0, length = buffer.length - offset, position: number | null = null): number {
  const bytes = Buffer.from(nativeCall<string>('fs.read', fd, offset, length, position), 'base64')
  buffer.set(bytes, offset)
  return bytes.length
}
export function copyFileSync(source: any, target: any, flags = 0): void {
  nativeCall('fs.copyFile', pathname(source), pathname(target), flags)
}
export function createReadStream(path: any, options: { start?: number; end?: number; highWaterMark?: number; fd?: number; autoClose?: boolean } = {}): Readable {
  return Readable.from((async function* () {
    const fd = options.fd ?? openSync(path, 'r')
    let position = options.start ?? 0
    try {
      while (position <= (options.end ?? Number.MAX_SAFE_INTEGER)) {
        const buffer = Buffer.alloc(Math.min(options.highWaterMark ?? 65536, (options.end ?? Number.MAX_SAFE_INTEGER) - position + 1))
        const count = readSync(fd, buffer, 0, buffer.length, position)
        if (!count) return
        position += count
        yield buffer.subarray(0, count)
      }
    } finally { if (options.autoClose !== false) closeSync(fd) }
  })(), { objectMode: false })
}
export function accessSync(path: any): void { statSync(path) }
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024 }
export class FileHandle {
  fd: number
  constructor(fd: number) { this.fd = fd }
  async stat(options: any = {}) { return fstatSync(this.fd, options) }
  async readFile(options?: EncodingOptions) { return readFileSync(this.fd, options) }
  async writeFile(data: any, options?: EncodingOptions) { writeFileSync(this.fd, data, options) }
  async write(buffer: Uint8Array, offset = 0, length = buffer.length - offset, position: number | null = null) {
    return { bytesWritten: writeSync(this.fd, buffer, offset, length, position), buffer }
  }
  async read(buffer: any, offset = 0, length?: number, position: number | null = null) {
    if (!(buffer instanceof Uint8Array)) {
      const opts = buffer || {}; buffer = opts.buffer || Buffer.alloc(16384)
      offset = opts.offset || 0; length = opts.length; position = opts.position ?? null
    }
    const bytesRead = readSync(this.fd, buffer, offset, length ?? buffer.length - offset, position)
    return { bytesRead, buffer }
  }
  async sync() { fsyncSync(this.fd) }
  async close() { if (this.fd >= 0) { closeSync(this.fd); this.fd = -1 } }
}
export const promises = {
  readFile: async (path: any, options?: EncodingOptions) => readFileSync(path, options),
  writeFile: async (path: any, data: any, options?: EncodingOptions) => writeFileSync(path, data, options),
  appendFile: async (path: any, data: any, options?: EncodingOptions) => appendFileSync(path, data, options),
  stat: async (path: any, options?: any) => statSync(path, options),
  lstat: async (path: any, options?: any) => lstatSync(path, options),
  readdir: async (path: any, options?: any) => readdirSync(path, options),
  realpath: async (path: any, options?: EncodingOptions) => realpathSync(path, options),
  mkdir: async (path: any, options?: any) => mkdirSync(path, options),
  mkdtemp: async (prefix: any, options?: EncodingOptions) => mkdtempSync(prefix, options),
  rename: async (source: any, target: any) => renameSync(source, target),
  rm: async (path: any, options?: any) => rmSync(path, options),
  unlink: async (path: any) => unlinkSync(path),
  rmdir: async (path: any, options?: any) => rmdirSync(path, options),
  open: async (path: any, flags?: any, mode?: any) => new FileHandle(openSync(path, flags, mode)),
  access: async (path: any) => accessSync(path),
  copyFile: async (source: any, target: any, flags?: number) => copyFileSync(source, target, flags),
  chmod: async (path: any, mode: number) => chmodSync(path, mode),
  link: async (source: any, target: any) => linkSync(source, target),
}
function callbackify(fn: (...args: any[]) => any) {
  return (...args: any[]) => {
    const callback = args.pop()
    queueMicrotask(() => { try { callback(null, fn(...args)) } catch (error) { callback(error) } })
  }
}
export const readFile = callbackify(readFileSync)
export const writeFile = callbackify(writeFileSync)
export const stat = callbackify(statSync)
export const lstat = callbackify(lstatSync)
export const readdir = callbackify(readdirSync)
export const mkdir = callbackify(mkdirSync)
export const rename = callbackify(renameSync)
export const unlink = callbackify(unlinkSync)
export const rm = callbackify(rmSync)
export const realpath = callbackify(realpathSync)
export const open = callbackify(openSync)
export const close = callbackify(closeSync)
export function read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: (error: unknown, count?: number, buffer?: Uint8Array) => void) {
  queueMicrotask(() => { try { callback(null, readSync(fd, buffer, offset, length, position), buffer) } catch (error) { callback(error) } })
}
export default { nativeCall, validateDirectoryChain, readFileSync, writeFileSync, appendFileSync, statSync, lstatSync, fstatSync, existsSync, realpathSync, readdirSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, rmdirSync, openSync, closeSync, fsyncSync, chmodSync, linkSync, installExclusiveSync, readSync, writeSync, createReadStream, copyFileSync, accessSync, constants, promises, Stats, Dirent, readFile, writeFile, stat, lstat, readdir, mkdir, rename, unlink, rm, realpath, open, close, read }
