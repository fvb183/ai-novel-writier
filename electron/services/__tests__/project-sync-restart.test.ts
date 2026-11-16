import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { PROJECT_SYNC_SQL } from '../project-sync-schema'
import { ProjectSyncEngine, type SyncProjection } from '../project-sync-engine'

it('retains staged batches and rolls back partial projection across closing and reopening the database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-sync-restart-'))
  const projectId = randomUUID(), file = path.join(root, 'receiver.db')
  const source = new Database(':memory:')
  let receiver: Database.Database | undefined
  const initialize = (db: Database.Database) => {
    db.pragma('foreign_keys=ON')
    db.exec("CREATE TABLE drafts(id INTEGER PRIMARY KEY,chapter_number INTEGER,status TEXT,version INTEGER); CREATE TABLE author_value(id TEXT PRIMARY KEY,body TEXT); INSERT INTO author_value VALUES('title','初稿')")
    db.exec(PROJECT_SYNC_SQL)
  }
  let interrupted = false
  const projection: SyncProjection = {
    capture: db => (db.prepare('SELECT id,body FROM author_value ORDER BY id').all() as { id: string; body: string }[]).map(row => ({ kind: 'core', id: row.id, value: row.body })),
    validate: () => {},
    apply(db, records) {
      db.prepare('DELETE FROM author_value').run()
      for (const record of records) db.prepare('INSERT INTO author_value VALUES(?,?)').run(record.id, record.value)
      if (interrupted) throw new Error('projection interrupted before acceptance')
    },
  }
  try {
    initialize(source)
    const left = new ProjectSyncEngine(source, projectId, projection); left.enable()
    receiver = new Database(file); initialize(receiver)
    let right = new ProjectSyncEngine(receiver, projectId, projection); right.join(left.exportBundle())
    const replicaId = right.status().replicaId
    left.captureMutation(() => source.prepare("UPDATE author_value SET body='待接收的新正文'").run())
    const preview = right.receive(left.exportBundle())
    interrupted = true
    expect(() => right.apply(preview.token)).toThrow('projection interrupted')
    receiver.close(); receiver = new Database(file)
    right = new ProjectSyncEngine(receiver, projectId, projection)
    expect(right.status()).toMatchObject({ replicaId, pendingBatches: 1 })
    expect(receiver.prepare('SELECT body FROM author_value').pluck().get()).toBe('初稿')
    interrupted = false
    expect(right.apply(right.preview().token)).toMatchObject({ applied: true, appliedBatches: 1 })
    receiver.close(); receiver = new Database(file)
    right = new ProjectSyncEngine(receiver, projectId, projection)
    expect(right.status()).toMatchObject({ replicaId, pendingBatches: 0 })
    expect(receiver.prepare('SELECT body FROM author_value').pluck().get()).toBe('待接收的新正文')
    expect(right.receive(left.exportBundle()).pendingBatches).toBe(0)
  } finally {
    source.close(); if (receiver?.open) receiver.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
