import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProjectSyncEngine } from '../project-sync-engine'
import { ProjectAssetBlobStore } from '../project-asset-blob-store'
import { PROJECT_ASSET_SQL } from '../project-asset-schema'
import { applySelectedProjectAssets, assertProjectAssetsReady, captureProjectAssets, markProjectAssetMaterialized,
  parseProjectAssetRecords, pendingProjectAssets, projectAssetIdentity, recordCapturedProjectAssets,
  validateProjectAssetChanges, validateProjectAssetHistory } from '../project-sync-assets'
import type { ProjectAuthorAsset } from '../../../src/shared/project-sync-assets'

const roots: string[] = [], databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function replica(projectId: string) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ainw-asset-catalog-'))); roots.push(root)
  const db = new Database(path.join(root, 'project.db')); databases.push(db)
  db.exec(`CREATE TABLE project_sync_meta(id INTEGER PRIMARY KEY,project_id TEXT,replica_id TEXT);
    CREATE TABLE project_sync_batches(batch_id TEXT PRIMARY KEY,replica_id TEXT,sequence INTEGER,hash TEXT UNIQUE,payload_json TEXT,accepted INTEGER,UNIQUE(replica_id,sequence));
    CREATE TABLE project_sync_acknowledgements(peer_replica_id TEXT,batch_id TEXT,PRIMARY KEY(peer_replica_id,batch_id));` + PROJECT_ASSET_SQL)
  const store = new ProjectAssetBlobStore(root)
  const engine = new ProjectSyncEngine(db, projectId, { capture: captureProjectAssets, validate: parseProjectAssetRecords,
    validateChanges: validateProjectAssetChanges, validateHistory: validateProjectAssetHistory,
    apply: (database, records) => applySelectedProjectAssets(database, records, store) })
  return { db, root, store, engine }
}
function value(store: ProjectAssetBlobStore, content = 'original', name = 'prompts/draft.zh-CN.json'): Extract<ProjectAuthorAsset, { category: 'files' }> {
  return { version: 1, category: 'files', group: 'prompt', logicalName: name,
    files: [{ path: name, blob: store.put(Buffer.from(content), 'application/json') }] }
}

describe('selected author manifests and real SQLite causal records', () => {
  it('uses a project-scoped persistent logical identity, independent from content or device paths', () => {
    const project = randomUUID(), a = replica(project), b = replica(project), left = value(a.store), right = value(b.store, 'different')
    expect(projectAssetIdentity(project, left)).toBe(projectAssetIdentity(project, right))
    expect(projectAssetIdentity(randomUUID(), left)).not.toBe(projectAssetIdentity(project, left))
    expect(projectAssetIdentity(project, value(a.store, 'original', 'prompts/review.zh-CN.json'))).not.toBe(projectAssetIdentity(project, left))
  })
  it('joins selected manifests only when all immutable bytes exist and records restartable pending materialization', () => {
    const project = randomUUID(), a = replica(project), b = replica(project), asset = value(a.store), id = projectAssetIdentity(project, asset)
    recordCapturedProjectAssets(a.db, [{ id, value: asset }]); a.engine.enable()
    expect(() => b.engine.join(a.engine.exportBundle())).toThrow('PROJECT_SYNC_ASSET_MISSING_BYTES')
    expect(b.db.prepare('SELECT COUNT(*) FROM project_sync_meta').pluck().get()).toBe(0)
    expect(captureProjectAssets(b.db)).toEqual([])
    b.store.put(Buffer.from('original'), 'application/json')
    expect(b.engine.join(a.engine.exportBundle()).applied).toBe(true)
    expect(pendingProjectAssets(b.db)).toEqual([{ id, selected: asset, materialized: null }])
    expect(() => recordCapturedProjectAssets(b.db, [])).toThrow('PROJECT_SYNC_ASSET_NOT_READY')
    markProjectAssetMaterialized(b.db, id, asset); assertProjectAssetsReady(b.db)
    expect(captureProjectAssets(b.db)).toEqual(captureProjectAssets(a.db))
  })
  it('keeps DB selection, inbox acceptance and pending intent atomic when a later write fails', () => {
    const project = randomUUID(), a = replica(project), asset = value(a.store), id = projectAssetIdentity(project, asset)
    expect(() => a.db.transaction(() => {
      applySelectedProjectAssets(a.db, [{ kind: 'project-asset', id, value: asset }], a.store)
      throw new Error('INJECTED_DB_FAILURE')
    })()).toThrow('INJECTED_DB_FAILURE')
    expect(captureProjectAssets(a.db)).toEqual([])
    expect(pendingProjectAssets(a.db)).toEqual([])
    expect(a.store.read(asset.files[0]!.blob).toString()).toBe('original')
  })
  it('turns offline edits to the same file into an explicit conflict and accepts the chosen whole version', () => {
    const project = randomUUID(), a = replica(project), b = replica(project), original = value(a.store), id = projectAssetIdentity(project, original)
    recordCapturedProjectAssets(a.db, [{ id, value: original }]); a.engine.enable()
    b.store.put(Buffer.from('original'), 'application/json'); b.engine.join(a.engine.exportBundle()); markProjectAssetMaterialized(b.db, id, original)
    const left = value(a.store, 'left'), right = value(b.store, 'right')
    a.engine.captureMutation(() => recordCapturedProjectAssets(a.db, [{ id, value: left }]))
    b.engine.captureMutation(() => recordCapturedProjectAssets(b.db, [{ id, value: right }]))
    const preview = b.engine.receive(a.engine.exportBundle())
    expect(preview.conflicts).toHaveLength(1); expect(preview.conflicts[0]?.kind).toBe('project-asset')
    const conflict = preview.conflicts[0]!, winner = conflict.variants.find(variant => (variant.value as typeof left).files[0]?.blob.sha256 === left.files[0]?.blob.sha256)!
    b.store.put(Buffer.from('left'), 'application/json')
    expect(b.engine.apply(preview.token, [{ kind: 'project-asset', id, expectedHeads: conflict.variants.map(variant => variant.revision), selectedRevision: winner.revision }]).applied).toBe(true)
    expect(pendingProjectAssets(b.db)).toEqual([{ id, selected: left, materialized: right }])
    expect(b.store.read(right.files[0]!.blob).toString()).toBe('right')
    markProjectAssetMaterialized(b.db, id, left)
    expect(b.engine.preview().conflicts).toEqual([])
  })
  it('retains prior materialized manifest for a remote deletion and refuses stale completion', () => {
    const project = randomUUID(), a = replica(project), asset = value(a.store), id = projectAssetIdentity(project, asset)
    recordCapturedProjectAssets(a.db, [{ id, value: asset }])
    applySelectedProjectAssets(a.db, [], a.store)
    expect(pendingProjectAssets(a.db)).toEqual([{ id, selected: null, materialized: asset }])
    expect(() => markProjectAssetMaterialized(a.db, id, asset)).toThrow('PROJECT_SYNC_ASSET_SELECTION_CHANGED')
    markProjectAssetMaterialized(a.db, id, null)
    expect(pendingProjectAssets(a.db)).toEqual([])
    expect(a.store.read(asset.files[0]!.blob).toString()).toBe('original')
  })
  it('rejects reusing an asset identity for another logical file and rolls back the causal mutation', () => {
    const project = randomUUID(), a = replica(project), original = value(a.store), id = projectAssetIdentity(project, original)
    recordCapturedProjectAssets(a.db, [{ id, value: original }]); a.engine.enable()
    expect(() => a.engine.captureMutation(() => recordCapturedProjectAssets(a.db,
      [{ id, value: value(a.store, 'different owner', 'prompts/other.zh-CN.json') }]))).toThrow('PROJECT_SYNC_ASSET_INVALID')
    expect(captureProjectAssets(a.db)[0]?.value).toEqual(original)
    expect(a.engine.status().localBatches).toBe(1)
  })
  it('refuses checkpoint execution handles before selecting any remote manifest', () => {
    const project = randomUUID(), a = replica(project), asset: ProjectAuthorAsset = { version: 1, category: 'files', group: 'author-content',
      logicalName: 'partial_arch.json', files: [{ path: 'partial_arch.json', blob: a.store.put(Buffer.from(JSON.stringify({
        synopsis_result: '候选正文', synopsis_generation_handle: { epoch: 'remote-run-authority' },
      })), 'application/json') }] }
    const id = projectAssetIdentity(project, asset)
    expect(() => applySelectedProjectAssets(a.db, [{ kind: 'project-asset', id, value: asset }], a.store)).toThrow('PROJECT_SYNC_ASSET_RUNTIME_AUTHORITY')
    expect(captureProjectAssets(a.db)).toEqual([]); expect(pendingProjectAssets(a.db)).toEqual([])
  })
})
