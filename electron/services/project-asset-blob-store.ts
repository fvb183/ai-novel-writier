import { installProjectFileExclusive } from './project-file-install'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { MAX_PROJECT_ASSET_BYTES, parseProjectAssetBlob, type ProjectAssetBlob } from '../../src/shared/project-sync-assets'
import { validatePlatformDirectoryChain } from './migration-file-system'

const CHUNK = 256 * 1024
const activeReceives = new Set<string>()
const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino
const normalized = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
function fail(code: string): never { throw new Error(`PROJECT_SYNC_ASSET_${code}`) }
function directory(file: string): fs.BigIntStats {
  // Android validates ancestors through its native sandbox; the desktop fallback
  // checks every ancestor as well as the actual canonical spelling.
  if (!validatePlatformDirectoryChain(file)) {
    for (let cursor = path.resolve(file);; cursor = path.dirname(cursor)) {
      const info = fs.lstatSync(cursor, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH')
      if (cursor === path.dirname(cursor)) break
    }
  }
  const info = fs.lstatSync(file, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || normalized(fs.realpathSync.native(file)) !== normalized(file)) fail('UNSAFE_PATH')
  return info
}
function regular(file: string): fs.BigIntStats {
  directory(path.dirname(file))
  const info = fs.lstatSync(file, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || normalized(fs.realpathSync.native(file)) !== normalized(file)) fail('UNSAFE_PATH')
  return info
}
function unchanged(file: string, before: fs.BigIntStats): void {
  const after = regular(file)
  if (!same(after, before) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail('SOURCE_CHANGED')
}

/** Recover only a fully verified install whose every extra hard link is an
 * abandoned, owned staging name inside this project. External links still fail. */
export function recoverProjectAssetInstallLinks(storageRoot: string, file: string, blob: ProjectAssetBlob,
  staging: 'blobs' | 'materialize-staging'): void {
  parseProjectAssetBlob(blob)
  const root = path.resolve(storageRoot), relative = path.relative(root, path.resolve(file))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('UNSAFE_PATH')
  const rootIdentity = directory(root), parentIdentity = directory(path.dirname(file))
  const info = fs.lstatSync(file, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.size !== BigInt(blob.byteSize)
    || normalized(fs.realpathSync.native(file)) !== normalized(file)) fail('UNSAFE_PATH')
  if (info.nlink === 1n) return
  if (info.nlink < 2n || info.nlink > 1025n) fail('UNSAFE_PATH')
  const ownRoot = path.join(root, 'sync-assets', staging), ownIdentity = directory(ownRoot)
  const name = staging === 'blobs' ? /^\.incoming-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
    : /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
  const owned: string[] = []
  for (const entry of fs.readdirSync(ownRoot)) if (name.test(entry)) {
    const candidate = path.join(ownRoot, entry), stat = fs.lstatSync(candidate, { bigint: true })
    if (stat.isFile() && !stat.isSymbolicLink() && same(stat, info)) {
      if (activeReceives.has(normalized(candidate))) fail('BUSY')
      owned.push(candidate)
    }
  }
  if (BigInt(owned.length + 1) !== info.nlink) fail('UNSAFE_PATH')
  const input = fs.openSync(file, 'r'), digest = createHash('sha256'), buffer = Buffer.alloc(CHUNK)
  try {
    if (!same(fs.fstatSync(input, { bigint: true }), info)) fail('UNSAFE_PATH')
    for (let offset = 0; offset < blob.byteSize;) {
      const count = fs.readSync(input, buffer, 0, Math.min(CHUNK, blob.byteSize - offset), offset)
      if (!count) fail('HASH_MISMATCH')
      digest.update(buffer.subarray(0, count)); offset += count
    }
    const after = fs.lstatSync(file, { bigint: true })
    if (!same(after, info) || after.nlink !== info.nlink || after.size !== info.size
      || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs || digest.digest('hex') !== blob.sha256) fail('HASH_MISMATCH')
    for (const candidate of owned) {
      if (!same(directory(root), rootIdentity) || !same(directory(path.dirname(file)), parentIdentity)
        || !same(directory(ownRoot), ownIdentity)) fail('UNSAFE_PATH')
      const current = fs.lstatSync(candidate, { bigint: true }), target = fs.lstatSync(file, { bigint: true })
      if (!current.isFile() || current.isSymbolicLink() || !same(current, info) || !same(target, info)) fail('UNSAFE_PATH')
      fs.unlinkSync(candidate)
    }
  } finally { fs.closeSync(input) }
  if (regular(file).nlink !== 1n) fail('UNSAFE_PATH')
}

export interface ProjectAssetBlobWriter {
  write(bytes: Uint8Array): void
  complete(beforeInstall?: () => void): void
  abort(): void
}
export interface ProjectAssetBlobSource {
  byteSize: number
  sha256: string
  md5: string
  read(offset: number, length: number): Uint8Array
}

/** Immutable, project-owned CAS. Failed receives can only remove their own temporary file. */
export class ProjectAssetBlobStore {
  readonly root: string
  private readonly storageRoot: string
  private readonly storageIdentity: fs.BigIntStats
  private readonly rootIdentity: fs.BigIntStats
  constructor(storageRoot: string) {
    this.storageRoot = path.resolve(storageRoot)
    this.storageIdentity = directory(this.storageRoot)
    const container = path.join(this.storageRoot, 'sync-assets')
    this.makeDirectory(container)
    this.root = path.join(container, 'blobs')
    this.makeDirectory(this.root)
    this.rootIdentity = directory(this.root)
  }
  private makeDirectory(file: string): void {
    directory(path.dirname(file))
    try { fs.mkdirSync(file, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    directory(file)
  }
  private assertRoot(): void {
    if (!same(directory(this.storageRoot), this.storageIdentity) || !same(directory(this.root), this.rootIdentity)) fail('UNSAFE_PATH')
  }
  private target(blob: ProjectAssetBlob): string {
    parseProjectAssetBlob(blob); this.assertRoot()
    return path.join(this.root, blob.sha256)
  }
  private open(blob: ProjectAssetBlob): { fd: number; file: string; info: fs.BigIntStats } {
    const file = this.target(blob)
    if (fs.lstatSync(file, { bigint: true }).nlink !== 1n) recoverProjectAssetInstallLinks(this.storageRoot, file, blob, 'blobs')
    const info = regular(file)
    if (info.size !== BigInt(blob.byteSize)) fail('HASH_MISMATCH')
    const fd = fs.openSync(file, 'r')
    try {
      const opened = fs.fstatSync(fd, { bigint: true })
      if (!same(opened, info) || opened.nlink !== 1n || !opened.isFile()) fail('UNSAFE_PATH')
      return { fd, file, info }
    } catch (error) { fs.closeSync(fd); throw error }
  }
  source(blob: ProjectAssetBlob): ProjectAssetBlobSource {
    const { fd, file, info } = this.open(blob), digest = createHash('sha256'), md5 = createHash('md5')
    try {
      const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(blob.byteSize, 1)))
      let position = 0
      while (position < blob.byteSize) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, blob.byteSize - position), position)
        if (!count) fail('HASH_MISMATCH')
        digest.update(buffer.subarray(0, count)); md5.update(buffer.subarray(0, count)); position += count
      }
      unchanged(file, info); this.assertRoot()
      if (digest.digest('hex') !== blob.sha256) fail('HASH_MISMATCH')
    } finally { fs.closeSync(fd) }
    return { byteSize: blob.byteSize, sha256: blob.sha256, md5: md5.digest('hex'), read: (offset, length) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || length > 4 * 1024 * 1024 || offset + length > blob.byteSize) fail('INVALID')
      this.assertRoot(); unchanged(file, info)
      const input = fs.openSync(file, 'r'), bytes = Buffer.alloc(length)
      try {
        if (!same(fs.fstatSync(input, { bigint: true }), info)) fail('SOURCE_CHANGED')
        let done = 0
        while (done < length) {
          const count = fs.readSync(input, bytes, done, length - done, offset + done)
          if (!count) fail('SOURCE_CHANGED')
          done += count
        }
        unchanged(file, info); this.assertRoot(); return bytes
      } finally { fs.closeSync(input) }
    } }
  }
  has(blob: ProjectAssetBlob): boolean {
    try { this.source(blob); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  /** Presence only, for recovering missing dormant historical objects. This is
   * never proof of content: source/read/has still hash bytes before actual use. */
  contains(blob: ProjectAssetBlob): boolean {
    try { const { fd } = this.open(blob); fs.closeSync(fd); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  /** Caller holds the project asset mutation gate, has materialized all adopted
   * heads, and supplies accepted plus unresolved/pending references. Never walks
   * author files, backups, staging names or paths outside this exact CAS root. */
  pruneUnreferenced(references: readonly ProjectAssetBlob[], revalidate: () => void = () => {}): { deleted: number; reclaimedBytes: number } {
    const retained = new Set(references.map(blob => parseProjectAssetBlob(blob).sha256))
    this.assertRoot(); revalidate()
    const prefix = `${normalized(this.root)}${path.sep}`
    if ([...activeReceives].some(file => file.startsWith(prefix))) return { deleted: 0, reclaimedBytes: 0 }
    let deleted = 0, reclaimedBytes = 0
    for (const name of fs.readdirSync(this.root)) {
      if (!/^[a-f0-9]{64}$/.test(name) || retained.has(name)) continue
      this.assertRoot(); revalidate()
      const file = path.join(this.root, name)
      let before: fs.BigIntStats
      try { before = regular(file) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      revalidate(); this.assertRoot()
      const current = regular(file)
      if (!same(before, current) || current.size !== before.size || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) continue
      fs.unlinkSync(file); deleted++; reclaimedBytes += Number(before.size)
    }
    return { deleted, reclaimedBytes }
  }
  read(blob: ProjectAssetBlob, maximum = 64 * 1024 * 1024): Buffer {
    if (blob.byteSize > maximum) fail('TOO_LARGE')
    const source = this.source(blob), result = Buffer.alloc(source.byteSize)
    for (let offset = 0; offset < result.length; offset += CHUNK) result.set(source.read(offset, Math.min(CHUNK, result.length - offset)), offset)
    return result
  }
  createWriter(blob: ProjectAssetBlob): ProjectAssetBlobWriter {
    const target = this.target(blob), temporary = path.join(this.root, `.incoming-${randomUUID()}`)
    const fd = fs.openSync(temporary, 'wx', 0o600), identity = fs.fstatSync(fd, { bigint: true })
    activeReceives.add(normalized(temporary))
    const digest = createHash('sha256'); let count = 0, closed = false
    const close = () => { if (!closed) { fs.closeSync(fd); closed = true } }
    const clean = (strict = false) => {
      try {
        this.assertRoot()
        const info = fs.lstatSync(temporary, { bigint: true })
        if (info.isFile() && !info.isSymbolicLink() && same(info, identity)) fs.unlinkSync(temporary)
      } catch (error) {
        if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (error instanceof Error && !(error as NodeJS.ErrnoException).code) throw error
          fail('WRITE_FAILED')
        }
      }
    }
    const abort = () => { close(); clean(); activeReceives.delete(normalized(temporary)) }
    return { abort, write: bytes => {
      if (closed || !(bytes instanceof Uint8Array) || bytes.byteLength > 4 * 1024 * 1024
        || count + bytes.byteLength > blob.byteSize || count + bytes.byteLength > MAX_PROJECT_ASSET_BYTES) fail('TOO_LARGE')
      this.assertRoot()
      let done = 0
      while (done < bytes.length) {
        const written = fs.writeSync(fd, bytes, done, bytes.length - done, count + done)
        if (!written) fail('WRITE_FAILED')
        done += written
      }
      digest.update(bytes); count += bytes.byteLength
    }, complete: beforeInstall => {
      let installed = false
      try {
        if (closed || count !== blob.byteSize || digest.digest('hex') !== blob.sha256) fail('HASH_MISMATCH')
        fs.fsyncSync(fd); close(); this.assertRoot()
        if (!same(regular(temporary), identity)) fail('UNSAFE_PATH')
        beforeInstall?.(); this.assertRoot()
        try { installProjectFileExclusive(temporary, target) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          this.source(blob) // Existing identity must contain exactly the same verified bytes.
        }
        installed = true
      } finally {
        close()
        try { clean(installed) } finally { activeReceives.delete(normalized(temporary)) }
      }
      this.source(blob)
    } }
  }
  put(bytes: Uint8Array, mime = 'application/octet-stream'): ProjectAssetBlob {
    const blob = parseProjectAssetBlob({ sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.byteLength, mime })
    if (this.has(blob)) return blob
    const writer = this.createWriter(blob)
    try {
      for (let offset = 0; offset < bytes.length; offset += CHUNK) writer.write(bytes.subarray(offset, offset + CHUNK))
      writer.complete(); return blob
    } catch (error) { writer.abort(); throw error }
  }
  importFile(file: string, mime: string): ProjectAssetBlob {
    const info = regular(file)
    if (info.size > BigInt(MAX_PROJECT_ASSET_BYTES)) fail('TOO_LARGE')
    // Freeze bytes before opening the destination. This bounded streaming pass
    // records the source identity; it never imports a machine-local path.
    const digest = createHash('sha256'), input = fs.openSync(file, 'r'), size = Number(info.size), buffer = Buffer.alloc(CHUNK)
    try {
      if (!same(fs.fstatSync(input, { bigint: true }), info)) fail('SOURCE_CHANGED')
      for (let offset = 0; offset < size;) {
        const count = fs.readSync(input, buffer, 0, Math.min(CHUNK, size - offset), offset)
        if (!count) fail('SOURCE_CHANGED')
        digest.update(buffer.subarray(0, count)); offset += count
      }
      unchanged(file, info)
      const blob = parseProjectAssetBlob({ sha256: digest.digest('hex'), byteSize: size, mime })
      if (this.has(blob)) return blob
      const writer = this.createWriter(blob)
      try {
        for (let offset = 0; offset < size;) {
          const count = fs.readSync(input, buffer, 0, Math.min(CHUNK, size - offset), offset)
          if (!count) fail('SOURCE_CHANGED')
          writer.write(buffer.subarray(0, count)); offset += count
        }
        writer.complete(() => unchanged(file, info)); return blob
      } catch (error) { writer.abort(); throw error }
    } finally { fs.closeSync(input) }
  }
}
