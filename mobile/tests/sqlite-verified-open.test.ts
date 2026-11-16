import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNativeMock } from '../../test/mobile-native-mock.mjs'
import Database from '../shims/sqlite'
import * as androidCrypto from '../shims/crypto'

const EMPTY_SHA256 = createHash('sha256').digest('hex')
const target = '/android/files/book.db'
let root: string
let mock: ReturnType<typeof createNativeMock> | undefined
let bridge: ReturnType<typeof vi.fn>

function fixture(configureSqliteOpen?: (database: DatabaseSync) => void) {
  mock = createNativeMock(root, { virtualPaths: true, configureSqliteOpen })
  bridge = vi.fn(mock.sync)
  vi.stubGlobal('AndroidBridge', { sync: bridge })
  const host = mock.hostPath(target)
  const database = new DatabaseSync(host)
  try { database.exec("CREATE TABLE author_text(body TEXT); INSERT INTO author_text VALUES('原始正文')") }
  finally { database.close() }
  return host
}

function identity(host: string) {
  const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  return { database: hash(host), wal: fs.existsSync(host + '-wal') ? hash(host + '-wal') : EMPTY_SHA256 }
}

function bytes(host: string) {
  return Object.fromEntries(['', '-wal', '-shm', '-journal'].filter(suffix => fs.existsSync(host + suffix))
    .map(suffix => [suffix, fs.readFileSync(host + suffix).toString('hex')]))
}

beforeEach(() => {
  const base = path.join(process.cwd(), '.runtime', 'v140-native-open-fixtures')
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'case-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  mock?.close(); mock = undefined
  vi.unstubAllGlobals()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Android verified SQLite admission', () => {
  it('uses one native operation and accepts Android locale/journal setup after byte verification', () => {
    const configure = vi.fn((database: DatabaseSync) => {
      expect(mock!.sqliteState().verifiedDescriptors).toBe(0)
      database.exec('PRAGMA journal_mode = WAL')
    })
    const host = fixture(configure), expected = identity(host), before = bytes(host)
    const database = Database.openVerified(target, { fileMustExist: true }, expected)
    try {
      expect(bridge).toHaveBeenCalledTimes(1)
      expect(JSON.parse(bridge.mock.calls[0][0])).toEqual({ op: 'sqlite.openVerified', args: [target, { fileMustExist: true }, expected] })
      expect(database).toMatchObject({ name: target, open: true, memory: false, readonly: false, inTransaction: false })
      expect(configure).toHaveBeenCalledOnce()
      expect(database.prepare('SELECT body FROM author_text').pluck().get()).toBe('原始正文')
      expect(database.prepare('SELECT locale FROM android_metadata').pluck().get()).toBe('en_US')
      expect(database.pragma('foreign_keys', { simple: true })).toBe(0)
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(bytes(host)).not.toEqual(before)
      expect(mock!.sqliteState()).toEqual({ openAttempts: 1, openHandles: 1, closedHandles: 0, verifiedDescriptors: 0 })
    } finally { database.close() }
    expect(mock!.sqliteState().openHandles).toBe(0)
  })

  it.each(['database', 'wal'] as const)('rejects changed %s bytes before opening SQLite or altering any source file', kind => {
    const configure = vi.fn(), host = fixture(configure), expected = identity(host)
    if (kind === 'database') {
      const writer = new DatabaseSync(host)
      try { writer.exec("INSERT INTO author_text VALUES('校验之后的新正文')") } finally { writer.close() }
    } else fs.writeFileSync(host + '-wal', 'changed WAL bytes')
    const before = bytes(host)
    expect(() => Database.openVerified(target, { fileMustExist: true }, expected)).toThrowError(expect.objectContaining({ code: 'SOURCE_CHANGED_SINCE_PROBE' }))
    expect(configure).not.toHaveBeenCalled()
    expect(bytes(host)).toEqual(before)
    expect(mock!.sqliteState()).toEqual({ openAttempts: 0, openHandles: 0, closedHandles: 0, verifiedDescriptors: 0 })
  })

  it('accepts a valid uncheckpointed WAL before Android reconfigures locale and journal mode', () => {
    const host = fixture(database => database.exec('PRAGMA journal_mode = DELETE'))
    const source = path.join(path.dirname(host), 'wal-source.db'), writer = new DatabaseSync(source)
    try {
      writer.exec("PRAGMA journal_mode = WAL; BEGIN; CREATE TABLE author_text(body TEXT); INSERT INTO author_text VALUES('仍在 WAL 中的正文'); COMMIT")
      expect(fs.statSync(source + '-wal').size).toBeGreaterThan(0)
      fs.copyFileSync(source, host)
      fs.copyFileSync(source + '-wal', host + '-wal')
    } finally { writer.close() }
    const expected = identity(host)
    expect(expected.wal).not.toBe(EMPTY_SHA256)
    const database = Database.openVerified(target, { fileMustExist: true }, expected)
    try {
      expect(database.prepare('SELECT body FROM author_text').pluck().get()).toBe('仍在 WAL 中的正文')
      expect(database.prepare('SELECT locale FROM android_metadata').pluck().get()).toBe('en_US')
      expect(database.pragma('journal_mode', { simple: true })).toBe('delete')
      expect(identity(host)).not.toEqual(expected)
    } finally { database.close() }
    expect(mock!.sqliteState()).toEqual({ openAttempts: 1, openHandles: 0, closedHandles: 1, verifiedDescriptors: 0 })
  })

  it.each(['absent', 'empty'])('treats an %s WAL as the SHA256 of empty bytes', state => {
    const host = fixture()
    if (state === 'empty') fs.writeFileSync(host + '-wal', '')
    const expected = identity(host)
    expect(expected.wal).toBe(EMPTY_SHA256)
    const database = Database.openVerified(target, { fileMustExist: true }, expected)
    database.close()
    expect(mock!.sqliteState()).toEqual({ openAttempts: 1, openHandles: 0, closedHandles: 1, verifiedDescriptors: 0 })
  })

  it.each([
    { database: 'a'.repeat(63), wal: EMPTY_SHA256 },
    { database: 'G'.repeat(64), wal: EMPTY_SHA256 },
    { database: 'a'.repeat(64), wal: 'A'.repeat(64) },
    { database: 'a'.repeat(64), wal: EMPTY_SHA256, extra: true },
  ])('refuses malformed byte identities before acquiring a handle', expected => {
    fixture()
    expect(() => Database.openVerified(target, { fileMustExist: true }, expected)).toThrowError(expect.objectContaining({ code: 'SQLITE_VERIFIED_OPEN_INVALID' }))
    expect(mock!.sqliteState().openAttempts).toBe(0)
  })

  it('does not create a missing source database', () => {
    const host = fixture(), expected = identity(host)
    fs.unlinkSync(host)
    expect(() => Database.openVerified(target, { fileMustExist: true }, expected)).toThrowError(expect.objectContaining({ code: 'ENOENT' }))
    expect(fs.existsSync(host)).toBe(false)
    expect(mock!.sqliteState().openAttempts).toBe(0)
  })

  it.each(['/android/outside/book.db', '/android/files/../files/book.db', ':memory:', ''])('rejects an unsafe verified source path %s', value => {
    const host = fixture(), expected = identity(host)
    expect(() => Database.openVerified(value, { fileMustExist: true }, expected)).toThrow()
    expect(mock!.sqliteState()).toEqual({ openAttempts: 0, openHandles: 0, closedHandles: 0, verifiedDescriptors: 0 })
  })

  it('rejects a linked ancestor without following it into a database', () => {
    const host = fixture(), expected = identity(host)
    fs.symlinkSync(path.dirname(host), path.join(path.dirname(host), 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => Database.openVerified('/android/files/linked/book.db', { fileMustExist: true }, expected)).toThrowError(expect.objectContaining({ code: 'EACCES' }))
    expect(mock!.sqliteState().openAttempts).toBe(0)
  })

  it.each(['', '-wal', '-shm', '-journal'])('rejects multiply linked source file %s before SQLite opens it', suffix => {
    const host = fixture(), expected = identity(host)
    const source = suffix ? path.join(path.dirname(host), 'sidecar-source') : host
    if (suffix) fs.writeFileSync(source, '')
    fs.linkSync(source, suffix ? host + suffix : host + '.second-name')
    const before = bytes(host)
    expect(() => Database.openVerified(target, { fileMustExist: true }, expected)).toThrowError(expect.objectContaining({ code: 'EACCES' }))
    expect(bytes(host)).toEqual(before)
    expect(mock!.sqliteState()).toEqual({ openAttempts: 0, openHandles: 0, closedHandles: 0, verifiedDescriptors: 0 })
  })

  it('refuses a directory presented as a SQLite sidecar', () => {
    const host = fixture(), expected = identity(host)
    fs.mkdirSync(host + '-shm')
    expect(() => Database.openVerified(target, { fileMustExist: true }, expected)).toThrowError(expect.objectContaining({ code: 'EACCES' }))
    expect(mock!.sqliteState().openAttempts).toBe(0)
    expect(mock!.sqliteState().verifiedDescriptors).toBe(0)
  })

  it('rejects a same-content path replacement during hashing using the retained file identity', () => {
    const host = fixture(), expected = identity(host), originalRead = fs.readSync
    vi.spyOn(fs, 'readSync').mockImplementationOnce(((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args)
      fs.renameSync(host, host + '.original')
      fs.copyFileSync(host + '.original', host)
      return count
    }) as typeof fs.readSync)
    expect(() => Database.openVerified(target, { fileMustExist: true }, expected)).toThrowError(expect.objectContaining({ code: 'SOURCE_CHANGED_SINCE_PROBE' }))
    expect(identity(host)).toEqual(expected)
    expect(mock!.sqliteState()).toEqual({ openAttempts: 0, openHandles: 0, closedHandles: 0, verifiedDescriptors: 0 })
  })

  it('closes an unpublished SQLite handle after configuration fails and permits a later clean open', () => {
    let fail = true
    const host = fixture(() => { if (fail) throw new Error('synthetic Android configuration failure') })
    expect(() => Database.openVerified(target, { fileMustExist: true }, identity(host))).toThrow('synthetic Android configuration failure')
    expect(mock!.sqliteState()).toEqual({ openAttempts: 1, openHandles: 0, closedHandles: 1, verifiedDescriptors: 0 })
    fail = false
    const database = Database.openVerified(target, { fileMustExist: true }, identity(host))
    database.close()
    expect(mock!.sqliteState()).toEqual({ openAttempts: 2, openHandles: 0, closedHandles: 2, verifiedDescriptors: 0 })
  })

  it('keeps ordinary memory opens on the existing sqlite.open operation', () => {
    fixture()
    const database = new Database(':memory:')
    expect(JSON.parse(bridge.mock.calls[0][0]).op).toBe('sqlite.open')
    expect(database.memory).toBe(true)
    database.close()
  })
})

it('small hashes cross the native bridge once and streaming copies retain independent exact digests',()=>{
  fixture()
  const sample=Buffer.from('原文🙂小数据')
  const small=androidCrypto.createHash('sha256').update(sample).digest('hex')
  expect(small).toBe(createHash('sha256').update(sample).digest('hex'))
  expect(bridge.mock.calls.map(([payload])=>JSON.parse(payload).op).filter(op=>op.startsWith('crypto.hash'))).toEqual(['crypto.hash'])
  const large=Buffer.alloc(600*1024,65), digest=androidCrypto.createHash('sha256').update(large)
  const copied=digest.copy();digest.update('left');copied.update('right')
  expect(digest.digest('hex')).toBe(createHash('sha256').update(large).update('left').digest('hex'))
  expect(copied.digest('hex')).toBe(createHash('sha256').update(large).update('right').digest('hex'))
  expect(()=>digest.update('late')).toThrow('Digest already called')
})
