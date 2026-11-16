/** Synthetic legacy source built through the Android SQLite adapter, never author files. */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { initializeLegacyBaselineSchema } from '../electron/migrations/baseline-schema'
import { sqliteSchemaFingerprint, SqliteSchemaAdapter } from '../electron/migrations/sqlite-schema-adapter'
import { getDesktopMigrationRegistry } from '../electron/migrations/desktop-registry'
import { probeSchema } from '../electron/migrations/runner'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

export function createLegacyProject(root: string) {
  const storage = path.join(root, '.vela')
  fs.mkdirSync(storage, { recursive: true })
  const database = new Database(path.join(storage, 'vela.db'))
  const chapters = [
    { chapterNumber: 1, title: '原始第一章', content: '第一章旧定稿：钥匙在左口袋。\r\n正文不改。' },
    { chapterNumber: 2, title: '原始第二章', content: '第二章旧定稿：船已靠岸。🧭\n历史保留。' },
  ]
  try {
    database.pragma('foreign_keys = ON')
    database.transaction(() => {
      initializeLegacyBaselineSchema(database)
      database.prepare("INSERT INTO project_core(id,project_name) VALUES('main',?)").run('安卓旧格式测试')
      for (const chapter of chapters) {
        const content = database.prepare('INSERT INTO contents(body) VALUES(?)').run(chapter.content)
        database.prepare("INSERT INTO drafts(chapter_number,version,status,source,content_id,word_count) VALUES(?,1,'finalized','write',?,?)")
          .run(chapter.chapterNumber, content.lastInsertRowid, chapter.content.length)
      }
    })()
    if (database.pragma('user_version', { simple: true }) !== 0) throw new Error('LEGACY_FIXTURE_NOT_VERSION_ZERO')
    // A desktop-created legacy source has no Android locale table. The Android
    // target will acquire it when opened, so this also exercises cross-platform copies.
    database.exec('DROP TABLE IF EXISTS android_metadata')
  } finally { database.close() }
  for (const chapter of chapters) fs.writeFileSync(path.join(root, `第${chapter.chapterNumber}章 ${chapter.title}.txt`), chapter.content)
  return { root, chapters }
}

export function verifyPlatformMetadataContract() {
  const database = new Database(':memory:')
  try {
    database.pragma('foreign_keys = ON')
    initializeLegacyBaselineSchema(database)
    database.exec('DROP TABLE IF EXISTS android_metadata')
    const desktopFingerprint = sqliteSchemaFingerprint(database)
    const registry = getDesktopMigrationRegistry()
    probeSchema(new SqliteSchemaAdapter(database), registry)
    database.exec("CREATE TABLE android_metadata (locale TEXT); INSERT INTO android_metadata VALUES('zh_CN_#Hans')")
    if (sqliteSchemaFingerprint(database) !== desktopFingerprint) throw new Error('ANDROID_METADATA_FINGERPRINT_DRIFT')
    probeSchema(new SqliteSchemaAdapter(database), registry)
    const reject = (sql: string, undo: string) => {
      database.exec(sql)
      let rejected = false
      try { probeSchema(new SqliteSchemaAdapter(database), registry) } catch { rejected = true }
      if (!rejected) throw new Error('UNKNOWN_SCHEMA_WAS_ADMITTED')
      database.exec(undo)
    }
    reject('CREATE TABLE unknown_business_data(secret TEXT)', 'DROP TABLE unknown_business_data')
    reject('ALTER TABLE android_metadata ADD COLUMN author_text TEXT', "DROP TABLE android_metadata; CREATE TABLE android_metadata (locale TEXT); INSERT INTO android_metadata VALUES('en_US')")
    reject('CREATE INDEX extra_locale ON android_metadata(locale)', 'DROP INDEX extra_locale')
    reject("INSERT INTO android_metadata VALUES('fr_FR')", "DELETE FROM android_metadata WHERE locale='fr_FR'")
    reject("UPDATE android_metadata SET locale='author prose with spaces'", "UPDATE android_metadata SET locale='en_US'")
    reject('CREATE TRIGGER hidden_locale AFTER UPDATE ON android_metadata BEGIN SELECT 1; END', 'DROP TRIGGER hidden_locale')
    if (sqliteSchemaFingerprint(database) !== desktopFingerprint) throw new Error('METADATA_REJECTION_CHANGED_BUSINESS_SCHEMA')
    return { desktopFingerprint, androidFingerprint: desktopFingerprint, stockMetadataAccepted: true, unknownSchemaRejections: 6, physicalTablesRetained: true }
  } finally { database.close() }
}
