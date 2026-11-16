/** Old canonical projects created with the real Android SQLite adapter. */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createCanonicalProjectManifest } from '../src/shared/project-format'
import { initializeLegacyBaselineSchema } from '../electron/migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../electron/migrations/desktop-registry'
import { migrateSchema } from '../electron/migrations/runner'
import { SqliteSchemaAdapter } from '../electron/migrations/sqlite-schema-adapter'
import { ProjectSyncEngine } from '../electron/services/project-sync-engine'
import { projectSyncProjection } from '../electron/services/project-sync-projection'
import { initProjectDatabase, closeProjectDatabase, getProjectDb } from '../electron/database'
import { getProjectSyncEngine } from '../electron/services/project-sync-service'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
export function createOldCanonicalProject(projectPath: string, projectId: string, schemaVersion: number, synchronized = false) {
  const root = path.join(projectPath, '.ai-novel'); fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId, createdAt: '2026-11-11T12:00:00.000Z' })))
  fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true }); fs.writeFileSync(path.join(root, 'knowledge', '原文.txt'), '知识原文\r\n海港终年有雨。🧭')
  const db = new Database(path.join(root, 'project.db'))
  try {
    db.pragma('foreign_keys = ON')
    db.transaction(() => {
    initializeLegacyBaselineSchema(db)
    db.prepare("INSERT INTO project_core(id,project_name,genre,characters_arch) VALUES('main',?,?,?)").run('旧作品迁移', '悬疑', '# 作者原始设定\r\n不能改写')
    const body = '第一章原稿\r\n钥匙仍在左口袋。🙂'
    const content = db.prepare('INSERT INTO contents(body) VALUES(?)').run(body)
    db.prepare("INSERT INTO drafts(chapter_number,version,status,source,content_id,word_count) VALUES(1,1,'draft','write',?,?)").run(content.lastInsertRowid, body.length)
    migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), schemaVersion)
    db.prepare('INSERT INTO blueprints(chapter_number,title,notes) VALUES(1,?,?)').run('原始蓝图', '作者蓝图备注')
    if (synchronized) new ProjectSyncEngine(db, projectId, projectSyncProjection).enable()
    })()
  } finally { db.close() }
  return inspectOldCanonicalProject(projectPath)
}
export function inspectOldCanonicalProject(projectPath: string) {
  const root = path.join(projectPath, '.ai-novel'), db = new Database(path.join(root, 'project.db'), { fileMustExist: true })
  try {
    const domain = { core: db.prepare('SELECT project_name,genre,characters_arch FROM project_core').all(),
      contents: db.prepare('SELECT id,body FROM contents ORDER BY id').all(),
      drafts: db.prepare('SELECT id,chapter_number,version,status,source,content_id,word_count FROM drafts ORDER BY id').all(),
      blueprints: db.prepare('SELECT chapter_number,title,notes FROM blueprints ORDER BY chapter_number').all(),
      manifest: fs.readFileSync(path.join(root, 'project.json'), 'utf8'), knowledge: fs.readFileSync(path.join(root, 'knowledge', '原文.txt'), 'utf8') }
    const hasSyncSchema = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_sync_meta'").get()
    const meta = hasSyncSchema ? db.prepare('SELECT * FROM project_sync_meta').get() : undefined
    return { version: Number(db.pragma('user_version', { simple: true })), domainHash: createHash('sha256').update(JSON.stringify(domain)).digest('hex'), domain,
      meta: meta ?? null, batches: hasSyncSchema ? Number(db.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()) : 0,
      compactTables: Number(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'project_sync_compact_%'").pluck().get()) }
  } finally { db.close() }
}
export function openOldCanonicalProject(projectPath: string, adoptSync = false) {
  try {
    initProjectDatabase(projectPath)
    const db = getProjectDb()!
    const sync = adoptSync ? getProjectSyncEngine(db, JSON.parse(fs.readFileSync(path.join(projectPath, '.ai-novel', 'project.json'), 'utf8')).projectId).status() : undefined
    return { version: Number(db.pragma('user_version', { simple: true })), sync,
      body: db.prepare('SELECT body FROM contents ORDER BY id').pluck().get(), foreignKeys: db.pragma('foreign_keys', { simple: true }) }
  } finally { closeProjectDatabase() }
}
