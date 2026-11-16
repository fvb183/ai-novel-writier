import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { DraftRepository } from '../../repositories/draft-repository'
import { getProjectSyncEngine, wrapProjectDatabase } from '../project-sync-service'

const handles: Database.Database[] = []
afterEach(() => handles.splice(0).forEach(db => db.close()))
function replica(projectId = randomUUID()) {
  const raw = new Database(':memory:'); handles.push(raw)
  raw.pragma('foreign_keys=ON'); initializeLegacyBaselineSchema(raw)
  migrateSchema(new SqliteSchemaAdapter(raw), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  raw.prepare("INSERT INTO project_core(id,project_name) VALUES('main','事务测试')").run()
  const db = wrapProjectDatabase(raw, projectId), engine = getProjectSyncEngine(db, projectId)
  return { raw, db, engine, projectId }
}
it('captures real repository nested transactions and single SQL writes without explicit sync calls', () => {
  const a = replica(); a.engine.enable()
  const b = replica(a.projectId); b.engine.join(a.engine.exportBundle())
  const before = a.engine.status().localBatches
  const id = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '电脑草稿', wordCount: 4 }, a.db)
  expect(a.engine.status().localBatches).toBe(before + 1)
  a.db.prepare("UPDATE project_core SET genre=? WHERE id='main'").run('科幻')
  const preview = b.engine.receive(a.engine.exportBundle())
  expect(b.engine.apply(preview.token).applied).toBe(true)
  expect(b.db.prepare("SELECT genre FROM project_core WHERE id='main'").pluck().get()).toBe('科幻')
  expect(b.db.prepare('SELECT body FROM contents JOIN drafts ON contents.id=drafts.content_id').pluck().get()).toBe('电脑草稿')
  const localId = Number(b.db.prepare('SELECT id FROM drafts').pluck().get())
  b.db.transaction(() => {
    b.db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)').run('手机改稿', localId)
    b.db.prepare('UPDATE drafts SET word_count=4 WHERE id=?').run(localId)
  })()
  const reverse = a.engine.receive(b.engine.exportBundle()); a.engine.apply(reverse.token)
  expect(a.db.prepare('SELECT body FROM contents WHERE id=(SELECT content_id FROM drafts WHERE id=?)').pluck().get(id)).toBe('手机改稿')
})
it('rolls back nested business writes and outbox when the outer repository transaction fails', () => {
  const a = replica(); a.engine.enable(); const before = a.engine.exportBundle()
  expect(() => a.db.transaction(() => {
    DraftRepository.create({ chapterNumber: 1, source: 'write', content: '中断稿', wordCount: 3 }, a.db)
    a.db.prepare("UPDATE project_core SET genre='未提交' WHERE id='main'").run()
    throw new Error('interrupted')
  }).immediate()).toThrow('interrupted')
  expect(a.raw.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
  expect(a.engine.exportBundle()).toEqual(before)
})
it('rejects writes after bypassed authority changes instead of emitting incomplete history', () => {
  const a = replica(); a.engine.enable()
  a.raw.prepare("UPDATE project_core SET genre='外部改动' WHERE id='main'").run()
  expect(() => a.db.prepare("UPDATE project_core SET project_name='新名称' WHERE id='main'").run()).toThrow('SYNC_LOCAL_STATE_DIVERGED')
  expect(a.raw.prepare('SELECT project_name FROM project_core').pluck().get()).toBe('事务测试')
})
it('avoids projection/history scans for reads and generated runtime state', () => {
  const a = replica(); a.engine.enable()
  const scan = vi.spyOn(a.engine as unknown as { baseline(): unknown }, 'baseline')
  const before = a.engine.status().localBatches
  a.db.transaction(() => {
    for (let index = 0; index < 100; index++) {
      a.db.prepare('SELECT project_name FROM project_core').get()
      a.db.prepare("UPDATE project_core SET plot_tree_snapshot=? WHERE id='main'").run(JSON.stringify({ generated: index }))
      a.db.prepare("UPDATE generation_runs SET status='completed' WHERE run_id=?").run(`local-job-${index}`)
    }
  })()
  expect(scan).not.toHaveBeenCalled()
  expect(a.engine.status().localBatches).toBe(before)
  a.db.transaction(() => {
    a.db.prepare("UPDATE project_core SET genre='奇幻' WHERE id='main'").run()
    a.db.prepare("UPDATE project_core SET project_name='一次作者保存' WHERE id='main'").run()
  })()
  expect(scan).toHaveBeenCalledTimes(1)
  expect(a.engine.status().localBatches).toBe(before + 1)
})
it('recovers lazy capture after a caught nested savepoint failure', () => {
  const a = replica(); a.engine.enable()
  const before = a.engine.status().localBatches
  a.db.transaction(() => {
    try {
      a.db.transaction(() => {
        a.db.prepare("UPDATE project_core SET genre='回滚内容' WHERE id='main'").run()
        throw new Error('savepoint cancelled')
      })()
    } catch { /* The outer author save is still valid. */ }
    a.db.prepare("UPDATE project_core SET project_name='保留外层保存' WHERE id='main'").run()
  })()
  expect(a.raw.prepare('SELECT genre FROM project_core').pluck().get()).not.toBe('回滚内容')
  expect(a.raw.prepare('SELECT project_name FROM project_core').pluck().get()).toBe('保留外层保存')
  expect(a.engine.status().localBatches).toBe(before + 1)
  expect(a.engine.preview().conflicts).toHaveLength(0)
})
