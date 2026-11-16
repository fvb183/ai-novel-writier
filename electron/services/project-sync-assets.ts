import path from 'node:path'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { parseProjectAuthorAsset, projectAssetBlobs, projectAssetPathKey, validateProjectAssetSet,
  type ProjectAssetEnvelope, type ProjectAuthorAsset } from '../../src/shared/project-sync-assets'
import type { SyncBatch, SyncChange, SyncRecord } from '../../src/shared/project-sync'
import { canonicalSyncJson, syncDigest } from './project-sync-engine'
import { ProjectAssetBlobStore } from './project-asset-blob-store'
import { assertProjectAuthorFileBytes, isAuthorCheckpointPath } from './project-asset-author-projection'

type Db = Database.Database
type Row = { asset_id: string; payload_json: string }
const fail = (code: string): never => { throw new Error(`PROJECT_SYNC_ASSET_${code}`) }
const encode = (asset: ProjectAuthorAsset) => canonicalSyncJson(parseProjectAuthorAsset(asset))
export function hasProjectAssetSchema(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_author_assets'").get()
}
export function projectAssetLogicalKey(asset: ProjectAuthorAsset): string {
  return asset.category === 'files' ? `files:${projectAssetPathKey(asset.logicalName)}`
    : asset.category === 'avatar' ? `avatar:${asset.characterId}`
      : asset.category === 'knowledge' ? `knowledge:${asset.documentId}` : `unassigned-avatar:${asset.originId}`
}
/** Same logical creation on two offline replicas shares an identity and forms a normal conflict.
 * Identity is persisted on first registration; explicit future rename can retain it. */
export function projectAssetIdentity(projectId: string, asset: ProjectAuthorAsset): string {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(projectId)) fail('INVALID')
  const bytes = createHash('sha256').update(`ai-novel-project-asset-v1\0${projectId.toLowerCase()}\0${projectAssetLogicalKey(asset)}`).digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const id = bytes.toString('hex').slice(0, 32)
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
}
export function captureProjectAssets(db: Db): SyncRecord[] {
  if (!hasProjectAssetSchema(db)) return []
  return (db.prepare('SELECT * FROM project_author_assets ORDER BY asset_id').all() as Row[])
    .map(row => ({ kind: 'project-asset', id: row.asset_id, value: JSON.parse(row.payload_json) }))
}
export function parseProjectAssetRecords(records: readonly SyncRecord[]): ProjectAssetEnvelope[] {
  const result = records.filter(record => record.kind === 'project-asset')
    .map(record => {
      const value = parseProjectAuthorAsset(record.value)
      if (canonicalSyncJson(value) !== canonicalSyncJson(record.value)) fail('INVALID')
      return { id: record.id, value }
    })
  validateProjectAssetSet(result)
  return result
}
export function validateProjectAssetChanges(changes: readonly SyncChange[]): void {
  for (const change of changes.filter(change => change.kind === 'project-asset')) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[45][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(change.id)) fail('INVALID')
    if (!change.deleted) parseProjectAssetRecords([{ kind: 'project-asset', id: change.id, value: change.value }])
  }
}
export function validateProjectAssetHistory(batches: readonly SyncBatch[]): void {
  const lengths = new Map<string, number>()
  const identities = new Map<string, string>()
  for (const batch of batches) for (const change of batch.changes) if (change.kind === 'project-asset' && !change.deleted) {
    const asset = parseProjectAuthorAsset(change.value), identity = projectAssetLogicalKey(asset)
    if (identities.has(change.id) && identities.get(change.id) !== identity) fail('INVALID')
    identities.set(change.id, identity)
    for (const blob of projectAssetBlobs(asset)) {
      const prior = lengths.get(blob.sha256)
      if (prior !== undefined && prior !== blob.byteSize) fail('INVALID')
      lengths.set(blob.sha256, blob.byteSize)
    }
  }
}
export function pendingProjectAssets(db: Db): Array<{ id: string; selected: ProjectAuthorAsset | null; materialized: ProjectAuthorAsset | null }> {
  if (!hasProjectAssetSchema(db)) return []
  const rows = db.prepare(`SELECT l.asset_id,a.payload_json,l.materialized_json
    FROM project_asset_local_state l LEFT JOIN project_author_assets a ON a.asset_id=l.asset_id
    UNION ALL SELECT a.asset_id,a.payload_json,NULL FROM project_author_assets a
    WHERE NOT EXISTS(SELECT 1 FROM project_asset_local_state l WHERE l.asset_id=a.asset_id)`).all() as Array<{
      asset_id: string; payload_json: string | null; materialized_json: string | null
    }>
  return rows.filter(row => row.payload_json !== row.materialized_json).map(row => ({ id: row.asset_id,
    selected: row.payload_json === null ? null : parseProjectAuthorAsset(JSON.parse(row.payload_json)),
    materialized: row.materialized_json === null ? null : parseProjectAuthorAsset(JSON.parse(row.materialized_json)) }))
}
export function assertProjectAssetsReady(db: Db): void {
  if (pendingProjectAssets(db).length) fail('NOT_READY')
}
export function selectedKnowledgeAssetHash(db: Db): string | null {
  if (!hasProjectAssetSchema(db)) return null
  const records = captureProjectAssets(db).filter(record => parseProjectAuthorAsset(record.value).category === 'knowledge')
    .map(record => ({ id: record.id, value: record.value })).sort((a, b) => a.id.localeCompare(b.id))
  // An empty catalog has not yet adopted the legacy on-disk knowledge source.
  return records.length || db.prepare("SELECT 1 FROM project_asset_local_state WHERE asset_id='$knowledge-selection'").get()
    ? syncDigest(records) : null
}
export function assertProjectAssetSelection(db: Db, id: string, value: ProjectAuthorAsset | null): void {
  const row = db.prepare('SELECT payload_json FROM project_author_assets WHERE asset_id=?').pluck().get(id)
  if ((row ?? null) !== (value === null ? null : encode(value))) fail('SELECTION_CHANGED')
}
/** The selected record and materialization intent are updated in the caller's SQLite transaction.
 * Files are installed later; a crash leaves the previous projection available but explicitly stale. */
export function applySelectedProjectAssets(db: Db, records: readonly SyncRecord[], store?: ProjectAssetBlobStore): void {
  const desired = parseProjectAssetRecords(records)
  if (!hasProjectAssetSchema(db)) { if (desired.length) fail('SCHEMA_REQUIRED'); return }
  const existing = db.prepare('SELECT * FROM project_author_assets').all() as Row[]
  const wanted = new Set(desired.map(record => record.id))
  const cas = desired.some(record => projectAssetBlobs(record.value).length)
    ? store ?? new ProjectAssetBlobStore(path.dirname(db.name)) : null
  for (const record of desired) for (const blob of projectAssetBlobs(record.value)) if (!cas!.has(blob)) fail('MISSING_BYTES')
  for (const record of desired) if (record.value.category === 'files') for (const file of record.value.files) {
    if (isAuthorCheckpointPath(file.path)) assertProjectAuthorFileBytes(file.path, cas!.read(file.blob))
  }
  for (const row of existing) {
    db.prepare('INSERT OR IGNORE INTO project_asset_local_state(asset_id,materialized_json) VALUES(?,?)').run(row.asset_id, row.payload_json)
    if (!wanted.has(row.asset_id)) db.prepare('DELETE FROM project_author_assets WHERE asset_id=?').run(row.asset_id)
  }
  for (const record of desired) {
    if (record.value.category === 'knowledge') db.prepare("INSERT OR IGNORE INTO project_asset_local_state VALUES('$knowledge-selection',NULL)").run()
    db.prepare('INSERT OR IGNORE INTO project_asset_local_state(asset_id,materialized_json) VALUES(?,NULL)').run(record.id)
    db.prepare(`INSERT INTO project_author_assets VALUES(?,?) ON CONFLICT(asset_id) DO UPDATE SET payload_json=excluded.payload_json`)
      .run(record.id, encode(record.value))
  }
}
/** Registration/observation of already saved local files. It runs through captureMutation.
 * Pending remote materialization is recovered first, never mistaken for a local deletion. */
export function recordCapturedProjectAssets(db: Db, records: readonly ProjectAssetEnvelope[]): void {
  assertProjectAssetsReady(db); validateProjectAssetSet(records)
  db.transaction(() => {
    const wanted = new Set(records.map(record => record.id))
    for (const row of db.prepare('SELECT * FROM project_author_assets').all() as Row[]) if (!wanted.has(row.asset_id)) {
      db.prepare('DELETE FROM project_author_assets WHERE asset_id=?').run(row.asset_id)
      if (parseProjectAuthorAsset(JSON.parse(row.payload_json)).category !== 'knowledge') {
        db.prepare('UPDATE project_asset_local_state SET materialized_json=NULL WHERE asset_id=?').run(row.asset_id)
      }
    }
    for (const record of records) {
      if (record.value.category === 'knowledge') db.prepare("INSERT OR IGNORE INTO project_asset_local_state VALUES('$knowledge-selection',NULL)").run()
      const payload = encode(record.value)
      db.prepare('INSERT INTO project_author_assets VALUES(?,?) ON CONFLICT(asset_id) DO UPDATE SET payload_json=excluded.payload_json').run(record.id, payload)
      if (record.value.category === 'knowledge') {
        // The physical source is already edited, but the projection pointer still
        // needs to adopt this selected identity. Keep that crash window pending.
        db.prepare('INSERT OR IGNORE INTO project_asset_local_state VALUES(?,NULL)').run(record.id)
      } else db.prepare(`INSERT INTO project_asset_local_state VALUES(?,?) ON CONFLICT(asset_id) DO UPDATE SET materialized_json=excluded.materialized_json`).run(record.id, payload)
    }
  })()
}
export function markProjectAssetMaterialized(db: Db, id: string, expected: ProjectAuthorAsset | null): void {
  assertProjectAssetSelection(db, id, expected)
  const encoded = expected === null ? null : encode(expected)
  db.prepare(`INSERT INTO project_asset_local_state VALUES(?,?) ON CONFLICT(asset_id) DO UPDATE SET materialized_json=excluded.materialized_json`).run(id, encoded)
}
