import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncApplyResult, SyncBundle } from '../../../src/shared/project-sync'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'

const mocks = vi.hoisted(() => ({ readBytes: vi.fn() }))
vi.mock('../../security/windows-safe-file-system', () => ({ windowsSafeFileSystem: { readBytes: mocks.readBytes } }))
import { joinSyncProject, MAX_SYNC_PACKAGE_BYTES, readSyncPackage, writeSyncPackage } from '../project-sync-transfer'
import { createProjectDatabase } from '../../database'
import { disposeProjectSyncEngine, getProjectSyncEngine, wrapProjectDatabase } from '../project-sync-service'
import { syncDigest } from '../project-sync-engine'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

const roots: string[] = []
const fixture = () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-transfer-')))
  roots.push(root); return root
}
const bundle = (): SyncBundle => {
  const projectId = randomUUID(), replicaId = randomUUID(), body = { protocol: 1 as const, projectId, replicaId,
    sequence: 1, previousHash: null, batchId: randomUUID(), changes: [{ kind: 'synthetic', id: 'record', parents: [], deleted: false, value: 'saved' }] }
  const document = { format: 'ai-novel-sync' as const, version: 1 as const, projectId, senderReplicaId: replicaId, batches: [{ ...body, hash: syncDigest(body) }] }
  return { ...document, hash: syncDigest(document) }
}
const applied: SyncApplyResult = { applied: true, appliedBatches: 1, preview: { token: 'done', pendingBatches: 0, missingBatchHashes: [], conflicts: [], changedRecords: 0, canApply: true } }
afterEach(() => { mocks.readBytes.mockReset(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('Bounded local sync transfer', () => {
  it('replays the actual engine into a new replica and exchanges captured transactions after reopening', async () => {
    const root = fixture(), source = path.join(root, 'Source'), target = path.join(root, 'Joined'), projectId = randomUUID()
    fs.mkdirSync(path.join(source, '.ai-novel'), { recursive: true })
    fs.writeFileSync(path.join(source, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId, createdAt: new Date().toISOString() })))
    createProjectDatabase(source)
    const sourceDb = new Database(path.join(source, '.ai-novel', 'project.db'))
    let joinedDb: import('better-sqlite3').Database | undefined
    try {
      sourceDb.prepare("INSERT INTO project_core(id,project_name) VALUES('main','合成同步项目')").run()
      const engine = getProjectSyncEngine(sourceDb, projectId), wrapped = wrapProjectDatabase(sourceDb, projectId)
      const sourceReplica = engine.enable().replicaId
      wrapped.transaction(() => {
        wrapped.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run('完整事务正文')
        wrapped.prepare("UPDATE project_core SET total_chapters=? WHERE id='main'").run(12)
      }).immediate()
      expect(engine.status().localBatches).toBe(2)
      const receipt = await joinSyncProject({ bundle: engine.exportBundle(), targetProjectPath: target, assertTargetAuthorized() {},
        join: (db, id, received) => getProjectSyncEngine(db, id).join(received) })
      expect(receipt.applied.applied).toBe(true)
      joinedDb = new Database(path.join(target, '.ai-novel', 'project.db'))
      const replica = getProjectSyncEngine(joinedDb, projectId)
      expect(replica.status().replicaId).not.toBe(sourceReplica)
      expect(joinedDb.prepare("SELECT synopsis,total_chapters FROM project_core WHERE id='main'").get()).toEqual({ synopsis: '完整事务正文', total_chapters: 12 })
      wrapProjectDatabase(joinedDb, projectId).prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run('新副本修改')
      const incoming = replica.exportBundle(), preview = engine.receive(incoming)
      expect(preview.canApply).toBe(true)
      expect(engine.apply(preview.token).applied).toBe(true)
      expect(sourceDb.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get()).toBe('新副本修改')
      expect(engine.receive(incoming).pendingBatches).toBe(0)
      expect(engine.apply(engine.preview().token).appliedBatches).toBe(0)
    } finally { if (joinedDb) { disposeProjectSyncEngine(joinedDb); joinedDb.close() }; disposeProjectSyncEngine(sourceDb); sourceDb.close() }
  })
  it('publishes one complete package and never overwrites an existing file', () => {
    const root = fixture(), target = path.join(root, 'book.ainovelsync'), value = bundle()
    writeSyncPackage(target, value, () => {})
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(value)
    expect(fs.statSync(target).nlink).toBe(1)
    expect(() => writeSyncPackage(target, bundle(), () => {})).toThrow('SYNC_TARGET_EXISTS')
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(value)
    expect(fs.readdirSync(root)).toEqual(['book.ainovelsync'])
  })
  it('rechecks the lease before publication and removes only its own temporary file', () => {
    const root = fixture(), target = path.join(root, 'book.ainovelsync')
    expect(() => writeSyncPackage(target, bundle(), () => { throw new Error('SYNC_SESSION_STALE') })).toThrow('SYNC_SESSION_STALE')
    expect(fs.readdirSync(root)).toEqual([])
    expect(() => writeSyncPackage(target, bundle(), () => { fs.writeFileSync(target, 'unrelated') })).toThrow('SYNC_TARGET_EXISTS')
    expect(fs.readFileSync(target, 'utf8')).toBe('unrelated')
  })
  it('uses the secure capability reader with a 64 MiB ceiling and rejects invalid UTF-8/JSON', async () => {
    const capability = { rootPath: fixture(), relativePath: 'book.ainovelsync', rootIdentity: { volumeSerialNumber: '1', fileIndex: '2' } }
    const value = bundle()
    mocks.readBytes.mockResolvedValueOnce(Buffer.from(JSON.stringify(value)))
    expect(await readSyncPackage(capability)).toEqual(value)
    expect(mocks.readBytes).toHaveBeenCalledWith(capability, MAX_SYNC_PACKAGE_BYTES)
    mocks.readBytes.mockResolvedValueOnce(Buffer.from([0xff]))
    await expect(readSyncPackage(capability)).rejects.toThrow('SYNC_PACKAGE_INVALID')
    mocks.readBytes.mockResolvedValueOnce(Buffer.from('[]'))
    await expect(readSyncPackage(capability)).rejects.toThrow('SYNC_PACKAGE_INVALID')
    mocks.readBytes.mockResolvedValueOnce(Buffer.alloc(MAX_SYNC_PACKAGE_BYTES + 1))
    await expect(readSyncPackage(capability)).rejects.toThrow('SYNC_PACKAGE_TOO_LARGE')
  })
  it('joins in an isolated fresh database and only publishes a complete canonical directory', async () => {
    const root = fixture(), target = path.join(root, 'Joined'), value = bundle()
    let checked = 0
    const receipt = await joinSyncProject({ bundle: value, targetProjectPath: target, assertTargetAuthorized: () => { checked++ },
      join(db, projectId, received) {
        expect(fs.existsSync(target)).toBe(false)
        expect(projectId).toBe(value.projectId); expect(received).toBe(value)
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
        return applied
      } })
    expect(checked).toBe(4)
    expect(receipt.projectId).toBe(value.projectId)
    expect(JSON.parse(fs.readFileSync(path.join(target, '.ai-novel', 'project.json'), 'utf8')).projectId).toBe(value.projectId)
    expect(fs.existsSync(path.join(target, '.ai-novel', 'project.db'))).toBe(true)
    expect(fs.readdirSync(root)).toEqual(['Joined'])
  })
  it('rejects existing join targets and removes the unpublished replica when replay fails', async () => {
    const root = fixture(), target = path.join(root, 'Joined')
    const join = vi.fn(() => { throw new Error('SYNC_JOIN_INCOMPLETE') })
    await expect(joinSyncProject({ bundle: bundle(), targetProjectPath: target, join, assertTargetAuthorized: () => {} })).rejects.toThrow('SYNC_JOIN_INCOMPLETE')
    expect(fs.readdirSync(root)).toEqual([])
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'original')
    await expect(joinSyncProject({ bundle: bundle(), targetProjectPath: target, join, assertTargetAuthorized: () => {} })).rejects.toThrow('SYNC_TARGET_EXISTS')
    expect(join).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('original')
  })
  it('fails closed when target authorization changes after replay, before publication', async () => {
    const root = fixture(), target = path.join(root, 'Joined')
    let replayed = false
    await expect(joinSyncProject({ bundle: bundle(), targetProjectPath: target, join: () => { replayed = true; return applied },
      assertTargetAuthorized() { if (replayed) throw new Error('SYNC_GRANT_INVALID') },
    })).rejects.toThrow('SYNC_GRANT_INVALID')
    expect(fs.readdirSync(root)).toEqual([])
  })
})
