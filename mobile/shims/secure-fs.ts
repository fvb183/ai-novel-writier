/** Android implementation of the desktop capability-based filesystem contract. */
import * as fs from 'node:fs'
import path from 'node:path'
import { Buffer } from 'buffer'

export interface SecureRootIdentity {
  readonly volumeSerialNumber: string
  readonly fileIndex: string
}
export interface SecureFileCapability {
  rootPath: string
  relativePath: string
  rootIdentity: SecureRootIdentity
}
export interface SecureDirectoryEntry { name: string; isDirectory: boolean }
export interface AtomicWriteConstraints { mustAlreadyExist?: boolean }
export interface SecureFileSystem {
  readBytes(capability: SecureFileCapability, maxBytes?: number): Promise<Buffer>
  readText(capability: SecureFileCapability, maxBytes?: number): Promise<string>
  writeTextAtomically(capability: SecureFileCapability, content: string,
    beforeReplace?: () => void | Promise<void>, constraints?: AtomicWriteConstraints): Promise<void>
  mkdir(capability: SecureFileCapability): Promise<void>
  exists(capability: SecureFileCapability): Promise<boolean>
  listDirectory(capability: SecureFileCapability): Promise<SecureDirectoryEntry[]>
}
export type WindowsSafeFileSystem = SecureFileSystem
type Operation = 'read' | 'write' | 'mkdir' | 'exists' | 'list'
interface HelperRequest extends SecureFileCapability {
  operation: Operation
  contentBase64?: string
  mustAlreadyExist?: boolean
  maxBytes?: number
}
interface HelperResponse {
  ok: boolean
  code?: string
  phase?: string
  contentBase64?: string
  exists?: boolean
  entries?: unknown
}
export interface WindowsSafeFileSystemOptions {
  invoke?: (request: HelperRequest) => Promise<HelperResponse>
  helperPath?: string
  timeoutMs?: number
  platform?: NodeJS.Platform
  isPackaged?: boolean
  resourcesPath?: string
  cwd?: string
}
export type AtomicWriteFailureCommitState = 'not_committed' | 'unknown'
const MAX_TEXT_BYTES = 64 * 1024 * 1024
const MAX_PATH_CHARACTERS = 32_000
const MAX_SEGMENTS = 256
const MAX_DIRECTORY_ENTRIES = 16_384
const MAX_UINT32 = 4294967295n
const MAX_UINT64 = 18446744073709551615n
const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
function fail(code: string): never { throw new Error(code) }

export function atomicWriteFailureCommitState(error: unknown): AtomicWriteFailureCommitState | undefined {
  if (!error || typeof error !== 'object' || !('commitState' in error)) return undefined
  const state = (error as { commitState?: unknown }).commitState
  return state === 'not_committed' || state === 'unknown' ? state : undefined
}

function mapError(error: unknown): Error {
  if (error instanceof Error && /^SECURE_FS_[A-Z0-9_]+$/.test(error.message)) return error
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' && /^SECURE_FS_[A-Z0-9_]+$/.test(code)) return new Error(code)
  if (code === 'ENOENT') return new Error('SECURE_FS_NOT_FOUND')
  if (code === 'ELOOP') return new Error('SECURE_FS_INVALID_PATH')
  if (code === 'EACCES' || code === 'EPERM') return new Error('SECURE_FS_ACCESS_DENIED')
  return new Error('SECURE_FS_HELPER_FAILED')
}

function validateIdentity(identity: unknown): SecureRootIdentity {
  if (!identity || typeof identity !== 'object') fail('SECURE_FS_INVALID_PATH')
  const { volumeSerialNumber, fileIndex } = identity as SecureRootIdentity
  const decimal = /^(?:0|[1-9]\d*)$/
  if (typeof volumeSerialNumber !== 'string' || !decimal.test(volumeSerialNumber)
    || typeof fileIndex !== 'string' || !decimal.test(fileIndex)
    || BigInt(volumeSerialNumber) > MAX_UINT32 || BigInt(fileIndex) > MAX_UINT64) {
    fail('SECURE_FS_INVALID_PATH')
  }
  return Object.freeze({ volumeSerialNumber, fileIndex })
}

function assertSafeSegment(value: string): void {
  if (!value || value === '.' || value === '..' || /[\0:/\\]/.test(value)
    || value.endsWith('.') || value.endsWith(' ') || reservedNames.test(value)) {
    fail('SECURE_FS_INVALID_PATH')
  }
}

export function normalizeSecureRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_PATH_CHARACTERS || value.includes('\0')
    || /^[\\/]/.test(value) || /^[a-z]:/i.test(value) || path.isAbsolute(value)) {
    fail('SECURE_FS_INVALID_PATH')
  }
  const segments = value.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.')
  if (segments.length > MAX_SEGMENTS) fail('SECURE_FS_INVALID_PATH')
  for (const segment of segments) assertSafeSegment(segment)
  // Other project services append Windows separators to this capability field.
  return segments.join('\\')
}

export function captureSecureRootIdentity(rootPath: string): SecureRootIdentity {
  try {
    const canonical = fs.realpathSync.native(rootPath)
    const stat = fs.statSync(canonical, { bigint: true })
    if (!stat.isDirectory() || stat.dev < 0n || stat.ino < 0n
      || stat.dev > MAX_UINT32 || stat.ino > MAX_UINT64) fail('SECURE_FS_INVALID_PATH')
    return Object.freeze({ volumeSerialNumber: String(stat.dev), fileIndex: String(stat.ino) })
  } catch (error) { throw mapError(error) }
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('SECURE_FS_INVALID_PATH')
  }
}

export function createSecureFileCapability(rootPath: string, requestedPath: string): SecureFileCapability {
  if (typeof rootPath !== 'string' || typeof requestedPath !== 'string' || !rootPath
    || rootPath.includes('\0') || requestedPath.includes('\0')
    || rootPath.length > MAX_PATH_CHARACTERS || requestedPath.length > MAX_PATH_CHARACTERS) {
    fail('SECURE_FS_INVALID_PATH')
  }
  const root = path.resolve(rootPath)
  const target = path.resolve(requestedPath)
  assertContained(root, target)
  return Object.freeze({ rootPath: root,
    relativePath: normalizeSecureRelativePath(path.relative(root, target)),
    rootIdentity: captureSecureRootIdentity(root) })
}

function validateCapability(capability: SecureFileCapability): SecureFileCapability {
  if (!capability || typeof capability.rootPath !== 'string' || !capability.rootPath
    || capability.rootPath.length > MAX_PATH_CHARACTERS || capability.rootPath.includes('\0')
    || !path.isAbsolute(capability.rootPath)) fail('SECURE_FS_INVALID_PATH')
  return { rootPath: path.resolve(capability.rootPath),
    relativePath: normalizeSecureRelativePath(capability.relativePath),
    rootIdentity: validateIdentity(capability.rootIdentity) }
}

function sameIdentity(a: SecureRootIdentity, b: SecureRootIdentity): boolean {
  return a.fileIndex === b.fileIndex && a.volumeSerialNumber === b.volumeSerialNumber
}

/** Revalidate every path component. The native bridge additionally limits all I/O
 * to Android's private files/cache roots and repeats validation at atomic commit. */
function checkedPath(capability: SecureFileCapability, allowMissing = false): string {
  const safe = validateCapability(capability)
  if (fs.lstatSync(safe.rootPath).isSymbolicLink()
    || fs.realpathSync.native(safe.rootPath) !== safe.rootPath
    || !sameIdentity(captureSecureRootIdentity(safe.rootPath), safe.rootIdentity)) {
    fail('SECURE_FS_INVALID_PATH')
  }
  let target = safe.rootPath
  const segments = safe.relativePath ? safe.relativePath.split('\\') : []
  let missing = false
  for (let i = 0; i < segments.length; i++) {
    target = path.join(target, segments[i])
    assertContained(safe.rootPath, target)
    if (missing) continue
    let stat: ReturnType<typeof fs.lstatSync>
    try { stat = fs.lstatSync(target) } catch (error) {
      if (allowMissing && (error as { code?: string })?.code === 'ENOENT') { missing = true; continue }
      throw error
    }
    if (stat.isSymbolicLink() || (i < segments.length - 1 && !stat.isDirectory())
      || fs.realpathSync.native(target) !== target) fail('SECURE_FS_INVALID_PATH')
  }
  return target
}

function nativeCall<T>(operation: string, ...args: unknown[]): T {
  // fs is replaced by mobile/shims/fs.ts at build time. Never silently fall back
  // to a weaker filesystem if the native capability implementation is missing.
  const call = (fs as unknown as { nativeCall?: (op: string, ...args: unknown[]) => T }).nativeCall
  if (typeof call !== 'function') fail('SECURE_FS_HELPER_UNAVAILABLE')
  return call(operation, ...args)
}

function directoryEntries(value: unknown): SecureDirectoryEntry[] {
  if (!Array.isArray(value) || value.length > MAX_DIRECTORY_ENTRIES) fail('SECURE_FS_HELPER_INVALID_RESPONSE')
  return value.map(entry => {
    if (!entry || typeof entry.name !== 'string' || typeof entry.isDirectory !== 'boolean') {
      fail('SECURE_FS_HELPER_INVALID_RESPONSE')
    }
    assertSafeSegment(entry.name)
    return { name: entry.name, isDirectory: entry.isDirectory }
  })
}

export function createSecureFileSystem(options: WindowsSafeFileSystemOptions = {}): SecureFileSystem {
  const invoke = options.invoke
  const request = async (operation: Operation, capability: SecureFileCapability,
    extra: Partial<HelperRequest> = {}): Promise<HelperResponse> => {
    if (!invoke) fail('SECURE_FS_HELPER_UNAVAILABLE')
    const result = await invoke({ ...validateCapability(capability), operation, ...extra })
    if (!result.ok) fail(result.code && /^SECURE_FS_[A-Z0-9_]+$/.test(result.code)
      ? result.code : 'SECURE_FS_HELPER_FAILED')
    return result
  }
  const readBytes = async (capability: SecureFileCapability, maxBytes = MAX_TEXT_BYTES): Promise<Buffer> => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('SECURE_FS_INVALID_OPERATION')
    const limit = Math.min(MAX_TEXT_BYTES, maxBytes)
    try {
      const safe = validateCapability(capability)
      let encoded: unknown
      if (invoke) encoded = (await request('read', safe, { maxBytes: limit })).contentBase64
      else encoded = nativeCall<string>('fs.secureRead', { ...safe, maxBytes: limit })
      if (typeof encoded !== 'string') fail('SECURE_FS_HELPER_INVALID_RESPONSE')
      if (encoded.length > Math.ceil(limit / 3) * 4) fail('SECURE_FS_FILE_TOO_LARGE')
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length > limit) fail('SECURE_FS_FILE_TOO_LARGE')
      return bytes
    } catch (error) { throw mapError(error) }
  }
  return {
    readBytes,
    async readText(capability, maxBytes) {
      const bytes = await readBytes(capability, maxBytes)
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { return fail('SECURE_FS_INVALID_TEXT') }
    },
    async writeTextAtomically(capability, content, beforeReplace, constraints) {
      let token: string | undefined
      let commitSent = false
      let validatingLease = false
      try {
        if (typeof content !== 'string') fail('SECURE_FS_INVALID_TEXT')
        const bytes = Buffer.from(content, 'utf8')
        if (bytes.length > MAX_TEXT_BYTES) fail('SECURE_FS_FILE_TOO_LARGE')
        const safe = validateCapability(capability)
        const payload = { ...safe, contentBase64: bytes.toString('base64'),
          mustAlreadyExist: constraints?.mustAlreadyExist === true }
        if (invoke) {
          await request('write', safe, payload)
          validatingLease = true
          await beforeReplace?.()
          return
        }
        const prepared = nativeCall<{ token: string }>('fs.securePrepare', payload)
        if (!prepared || typeof prepared.token !== 'string' || !prepared.token) {
          fail('SECURE_FS_HELPER_INVALID_RESPONSE')
        }
        token = prepared.token
        validatingLease = true
        await beforeReplace?.()
        validatingLease = false
        commitSent = true
        nativeCall('fs.secureCommit', token)
        token = undefined
      } catch (error) {
        // A failed lease callback is intentionally propagated so callers can
        // distinguish a superseded project from an I/O failure.
        const mapped = validatingLease && error instanceof Error ? error : mapError(error)
        throw Object.assign(mapped, { commitState: atomicWriteFailureCommitState(error)
          ?? (commitSent ? 'unknown' : 'not_committed') })
      } finally {
        if (token) { try { nativeCall('fs.secureCancel', token) } catch { /* already removed or process closed */ } }
      }
    },
    async mkdir(capability) {
      try {
        if (invoke) { await request('mkdir', capability); return }
        const target = checkedPath(capability, true)
        fs.mkdirSync(target, { recursive: true })
        checkedPath(capability)
      } catch (error) { throw mapError(error) }
    },
    async exists(capability) {
      try {
        if (invoke) {
          const result = (await request('exists', capability)).exists
          if (typeof result !== 'boolean') fail('SECURE_FS_HELPER_INVALID_RESPONSE')
          return result
        }
        return fs.existsSync(checkedPath(capability, true))
      } catch (error) { throw mapError(error) }
    },
    async listDirectory(capability) {
      try {
        if (invoke) return directoryEntries((await request('list', capability)).entries)
        const target = checkedPath(capability)
        const entries = fs.readdirSync(target, { withFileTypes: true })
        return directoryEntries(entries.map(entry => {
          if (entry.isSymbolicLink()) fail('SECURE_FS_INVALID_PATH')
          return { name: entry.name, isDirectory: entry.isDirectory() }
        }))
      } catch (error) { throw mapError(error) }
    },
  }
}
export const createWindowsSafeFileSystem = createSecureFileSystem
export const windowsSafeFileSystem = createSecureFileSystem()
