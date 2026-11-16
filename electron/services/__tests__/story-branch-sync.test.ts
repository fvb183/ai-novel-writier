import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { StoryBranchRepository as Stories } from '../../repositories/story-branch-repository'
import { getProjectSyncEngine, wrapProjectDatabase } from '../project-sync-service'
import { syncDigest } from '../project-sync-engine'
import type { SyncBatch, SyncJson } from '../../../src/shared/project-sync'
import type { StoryNodeInput, StoryOperation } from '../../../src/shared/story-branches'

const handles: Database.Database[] = []
afterEach(() => handles.splice(0).forEach(db => db.close()))
function replica(projectId = randomUUID()) {
  const raw = new Database(':memory:'); handles.push(raw); raw.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(raw)
  migrateSchema(new SqliteSchemaAdapter(raw), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  raw.prepare("INSERT INTO project_core(id,project_name) VALUES('main','分支交换')").run()
  const db = wrapProjectDatabase(raw, projectId), engine = getProjectSyncEngine(db, projectId)
  return { db, engine, projectId }
}
function node(title: string, body = title): StoryNodeInput {
  return { id: randomUUID(), kind: 'content', title, chapterNumber: 1, event: title, body }
}
function commit(a: ReturnType<typeof replica>, operations: StoryOperation[]) {
  return Stories.commit(a.db, Stories.read(a.db).revision, operations)
}
function pair() {
  const a = replica(), root = { ...node('分叉'), kind: 'branch' as const }, left = node('左路', '只在左路发生'), right = node('右路', '只在右路发生'), merge = { ...node('汇合'), kind: 'merge' as const }
  const routeA = { id: randomUUID(), title: '左路线', nodeIds: [root.id, left.id, merge.id] }
  const routeB = { id: randomUUID(), title: '右路线', nodeIds: [root.id, right.id, merge.id] }
  const operations: StoryOperation[] = [root, left, right, merge].map(value => ({ type: 'put-node', node: value }))
  operations.push(...[[root, left], [root, right], [left, merge], [right, merge]].map(([from, to]) => ({ type: 'put-edge' as const, edge: { id: randomUUID(), from: from!.id, to: to!.id, label: '走向', condition: '作者选择' } })))
  operations.push({ type: 'put-route', route: routeA }, { type: 'put-route', route: routeB })
  commit(a, operations); a.engine.enable()
  const b = replica(a.projectId); b.engine.join(a.engine.exportBundle())
  return { a, b, root, left, right, merge, routeA, routeB }
}
it('merges edits to different branch nodes, retains immutable prose versions, and keeps route continuity isolated', () => {
  const { a, b, left, right, merge, routeA, routeB } = pair()
  commit(a, [{ type: 'put-node', node: { ...left, body: '电脑左路新正文' } }])
  commit(b, [{ type: 'put-node', node: { ...right, body: '手机右路新正文' } }])
  const preview = a.engine.receive(b.engine.exportBundle())
  expect(preview.conflicts).toEqual([]); expect(a.engine.apply(preview.token).applied).toBe(true)
  b.engine.apply(b.engine.receive(a.engine.exportBundle()).token)
  expect(Stories.read(a.db)).toEqual(Stories.read(b.db))
  const contextA = Stories.context(a.db, { nodeId: merge.id, routeId: routeA.id, mode: 'route' })
  const contextB = Stories.context(b.db, { nodeId: merge.id, routeId: routeB.id, mode: 'route' })
  expect(JSON.stringify(contextA.prefix)).toContain('电脑左路新正文'); expect(JSON.stringify(contextA.prefix)).not.toContain('手机右路新正文')
  expect(JSON.stringify(contextB.prefix)).toContain('手机右路新正文'); expect(JSON.stringify(contextB.prefix)).not.toContain('电脑左路新正文')
  expect(Stories.read(a.db).revisions).toHaveLength(6)
})
it('preserves both competing node bodies and resolves the explicit node conflict without losing either history', () => {
  const { a, b, left } = pair()
  commit(a, [{ type: 'put-node', node: { ...left, body: '电脑候选' } }])
  commit(b, [{ type: 'put-node', node: { ...left, body: '手机候选' } }])
  const preview = a.engine.receive(b.engine.exportBundle())
  expect(preview.conflicts).toHaveLength(1)
  expect(a.engine.apply(preview.token).applied).toBe(false)
  const conflict = preview.conflicts[0]!, selected = conflict.variants.find(variant => JSON.stringify(variant.value).includes('手机候选'))!
  a.engine.apply(preview.token, [{ kind: conflict.kind, id: conflict.id, expectedHeads: conflict.variants.map(variant => variant.revision), selectedRevision: selected.revision }])
  const saved = Stories.read(a.db)
  expect(saved.nodes.find(value => value.id === left.id)?.body).toBe('手机候选')
  expect(saved.revisions.map(value => value.node.body)).toEqual(expect.arrayContaining(['电脑候选', '手机候选']))
  b.engine.apply(b.engine.receive(a.engine.exportBundle()).token)
  expect(Stories.read(b.db)).toEqual(saved)
})
it('treats independently created continuity notes at the same route/node anchor as an explicit conflict', () => {
  const { a, b, merge } = pair()
  const firstId = randomUUID(), secondId = randomUUID()
  for (const [replica, id, summary] of [[a, firstId, '电脑共同事实'], [b, secondId, '手机共同事实']] as const) {
    const context = Stories.context(replica.db, { nodeId: merge.id, routeId: null, mode: 'shared' })
    commit(replica, [{ type: 'put-note', note: { id, nodeId: merge.id, routeId: null, summary, characterStates: '', entryDifferences: '左右入口不同' }, expectedSourceHash: context.sourceHash, confirm: true }])
  }
  const preview = a.engine.receive(b.engine.exportBundle())
  expect(preview.conflicts).toHaveLength(1)
  const conflict = preview.conflicts[0]!
  expect(conflict.kind).toBe('story_notes'); expect(conflict.id).toBe(`shared:${merge.id}`)
  const selected = conflict.variants.find(variant => JSON.stringify(variant.value).includes('手机共同事实'))!
  a.engine.apply(preview.token, [{ kind: conflict.kind, id: conflict.id, expectedHeads: conflict.variants.map(variant => variant.revision), selectedRevision: selected.revision }])
  b.engine.apply(b.engine.receive(a.engine.exportBundle()).token)
  expect(Stories.read(a.db).notes).toHaveLength(1)
  expect(Stories.read(a.db).notes[0]?.id).toBe(secondId)
  expect(Stories.read(a.db)).toEqual(Stories.read(b.db))
  expect(a.engine.exportBundle().batches.flatMap(batch => batch.changes).some(change => JSON.stringify(change.value).includes(firstId))).toBe(true)
})
it('rejects a cycle created by cross-replica edges atomically and preserves the accepted local graph', () => {
  const a = replica(), one = node('一'), two = node('二'), three = node('三')
  commit(a, [one, two, three].map(value => ({ type: 'put-node', node: value })))
  a.engine.enable(); const b = replica(a.projectId); b.engine.join(a.engine.exportBundle())
  commit(a, [{ type: 'put-edge', edge: { id: randomUUID(), from: one.id, to: two.id, label: '', condition: '' } }, { type: 'put-edge', edge: { id: randomUUID(), from: two.id, to: three.id, label: '', condition: '' } }])
  commit(b, [{ type: 'put-edge', edge: { id: randomUUID(), from: three.id, to: one.id, label: '', condition: '' } }])
  const before = Stories.read(a.db)
  expect(() => a.engine.receive(b.engine.exportBundle())).toThrow('PROJECT_SYNC_STORY_INVALID')
  expect(Stories.read(a.db)).toEqual(before)
  expect(a.engine.status().pendingBatches).toBe(0)
})
it('rejects rewritten immutable history in a fully rehashed package both on initial join and on an existing replica', () => {
  const { a, b, left } = pair(), original = a.engine.exportBundle()
  const first = original.batches[0]!, before = Stories.read(b.db)
  const nodeIndex = first.changes.findIndex(change => change.kind === 'story_nodes' && change.id === left.id)
  const node = first.changes[nodeIndex]!.value as Record<string, SyncJson>
  const versionIndex = first.changes.findIndex(change => change.kind === 'story_node_revisions' && change.id === node.revisionId)
  const version = first.changes[versionIndex]!.value as Record<string, SyncJson>
  const payload = { protocol: 1 as const, projectId: a.projectId, replicaId: original.senderReplicaId, sequence: 2, previousHash: first.hash, batchId: randomUUID(), changes: [
    { kind: 'story_nodes', id: left.id, value: { ...node, body: '伪造的过去' }, deleted: false, parents: [`${first.hash}:${nodeIndex}`] },
    { kind: 'story_node_revisions', id: String(node.revisionId), value: { ...version, node: { ...version.node as Record<string, SyncJson>, body: '伪造的过去' } }, deleted: false, parents: [`${first.hash}:${versionIndex}`] },
  ] }
  const extra: SyncBatch = { ...payload, hash: syncDigest(payload) }
  const body = { format: original.format, version: original.version, projectId: original.projectId, senderReplicaId: original.senderReplicaId, batches: [...original.batches, extra] }
  const forged = { ...body, hash: syncDigest(body) }
  expect(() => b.engine.receive(forged)).toThrow('SYNC_IMMUTABLE_RECORD_CHANGED')
  expect(Stories.read(b.db)).toEqual(before)
  const fresh = replica(a.projectId)
  expect(() => fresh.engine.join(forged)).toThrow('SYNC_IMMUTABLE_RECORD_CHANGED')
  expect(fresh.engine.status().enabled).toBe(false)
  expect(Stories.read(fresh.db).nodes).toEqual([])
})
it('rolls back local SQL that changes an existing immutable version together with its current node', () => {
  const { a, left } = pair(), before = Stories.read(a.db), current = before.nodes.find(node => node.id === left.id)!
  const revision = before.revisions.find(value => value.id === current.revisionId)!
  expect(() => a.db.transaction(() => {
    a.db.prepare('UPDATE story_node_revisions SET payload_json=? WHERE id=?').run(JSON.stringify({ ...revision, node: { ...revision.node, body: '改写历史' } }), revision.id)
    a.db.prepare('UPDATE story_nodes SET payload_json=? WHERE id=?').run(JSON.stringify({ ...current, body: '改写历史' }), current.id)
  })()).toThrow('SYNC_IMMUTABLE_RECORD_CHANGED')
  expect(Stories.read(a.db)).toEqual(before)
})
