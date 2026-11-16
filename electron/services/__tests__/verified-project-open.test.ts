import { beforeEach, describe, expect, it, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'

const mocks = vi.hoisted(() => ({ identity: vi.fn(), verify: vi.fn(), registry: {} }))
vi.mock('../sqlite-project-migration', () => ({ readSqliteContentIdentity: mocks.identity }))
vi.mock('../../migrations/desktop-registry', () => ({ CURRENT_DESKTOP_SCHEMA_VERSION: 11, getDesktopMigrationRegistry: () => mocks.registry }))
vi.mock('../../migrations/runner', () => ({ verifySchema: mocks.verify }))
vi.mock('../../migrations/sqlite-schema-adapter', () => ({ SqliteSchemaAdapter: class { constructor(readonly database: unknown) {} } }))
import { SchemaMigrationError } from '../../migrations/registry'
import { openVerifiedProjectHandle } from '../verified-project-open'

const expected = { database: 'a'.repeat(64), wal: 'b'.repeat(64) }
function handle() {
  return { pragma: vi.fn(), prepare: vi.fn(), exec: vi.fn(), close: vi.fn() }
}
beforeEach(() => vi.clearAllMocks())

describe('verified project writable handle admission', () => {
  it('keeps the desktop byte check before every SQL statement', () => {
    const db = handle(), construct = vi.fn()
    const Factory = function () { construct(); return db } as unknown as typeof BetterSqlite3
    mocks.identity.mockReturnValue(expected)
    expect(openVerifiedProjectHandle(Factory, 'project.db', expected)).toBe(db)
    expect(construct).toHaveBeenCalledOnce()
    expect(mocks.identity).toHaveBeenCalledWith('project.db')
    expect(db.pragma).not.toHaveBeenCalled()
    expect(db.exec).not.toHaveBeenCalled()
    expect(db.prepare).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it.each(['database', 'wal'] as const)('closes a changed desktop %s handle without SQL', field => {
    const db = handle()
    const Factory = function () { return db } as unknown as typeof BetterSqlite3
    mocks.identity.mockReturnValue({ ...expected, [field]: 'c'.repeat(64) })
    expect(() => openVerifiedProjectHandle(Factory, 'project.db', expected)).toThrow('SOURCE_CHANGED_SINCE_PROBE')
    expect(db.close).toHaveBeenCalledOnce()
    expect(db.pragma).not.toHaveBeenCalled()
    expect(db.prepare).not.toHaveBeenCalled()
    expect(db.exec).not.toHaveBeenCalled()
  })

  it('accepts native platform setup only after atomic input validation and live schema verification', () => {
    const db = handle(), construct = vi.fn()
    const nativeOpen = vi.fn(() => db)
    const Factory = Object.assign(function () { construct(); return db }, { openVerified: nativeOpen }) as unknown as typeof BetterSqlite3
    // A native platform may checkpoint WAL or normalize locale during open.
    mocks.identity.mockReturnValue({ database: 'd'.repeat(64), wal: 'e'.repeat(64) })
    expect(openVerifiedProjectHandle(Factory, 'project.db', expected)).toBe(db)
    expect(nativeOpen).toHaveBeenCalledWith('project.db', { fileMustExist: true }, expected)
    expect(construct).not.toHaveBeenCalled()
    expect(mocks.identity).not.toHaveBeenCalled()
    expect(db.pragma).toHaveBeenCalledWith('foreign_keys = ON')
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ database: db }), mocks.registry, 11)
    expect(db.pragma.mock.invocationCallOrder[0]!).toBeLessThan(mocks.verify.mock.invocationCallOrder[0]!)
  })

  it('rejects an unrecognized schema on the actual native handle and closes it before publication', () => {
    const db = handle()
    const Factory = Object.assign(function () { return db }, { openVerified: () => db }) as unknown as typeof BetterSqlite3
    mocks.verify.mockImplementationOnce(() => { throw new SchemaMigrationError('SCHEMA_VERSION_MISMATCH') })
    expect(() => openVerifiedProjectHandle(Factory, 'project.db', expected)).toThrow('SCHEMA_VERSION_MISMATCH')
    expect(db.close).toHaveBeenCalledOnce()
    expect(db.exec).not.toHaveBeenCalled()
  })

  it('preserves the native source-change reason without falling back to an unchecked constructor', () => {
    const construct = vi.fn()
    const Factory = Object.assign(function () { construct() }, { openVerified: () => { throw Object.assign(new Error('SOURCE_CHANGED_SINCE_PROBE'), { code: 'SOURCE_CHANGED_SINCE_PROBE' }) } }) as unknown as typeof BetterSqlite3
    expect(() => openVerifiedProjectHandle(Factory, 'project.db', expected)).toThrow(SchemaMigrationError)
    expect(construct).not.toHaveBeenCalled()
    expect(mocks.identity).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })
})
