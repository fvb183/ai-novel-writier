import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncBundle, SyncJson, SyncResolution } from '../../../src/shared/project-sync'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { DraftRepository } from '../../repositories/draft-repository'
import { NarrativeThreadRepository as Threads } from '../../repositories/narrative-thread-repository'
import { setAuthoritativeFinalizedDraft } from '../finalized-draft-head'
import { canonicalSyncJson, ProjectSyncEngine, syncDigest, validateSyncBundle } from '../project-sync-engine'
import { getProjectSyncEngine, wrapProjectDatabase } from '../project-sync-service'
import { projectSyncProjection as projection } from '../project-sync-projection'
import { GoogleDriveSyncService } from '../google-drive-sync-service'
import { GoogleDriveStateStore } from '../google-drive-state'
import type { GoogleDriveClient } from '../google-drive-client'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
const handles: Database.Database[] = []
afterEach(() => handles.splice(0).forEach(db => db.close()))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function replica(projectId = randomUUID()) {
  const raw = new Database(':memory:'); handles.push(raw); raw.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(raw); migrateSchema(new SqliteSchemaAdapter(raw), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  raw.prepare("INSERT INTO project_core(id,project_name) VALUES('main','伏笔同步真实SQLite')").run()
  const db = wrapProjectDatabase(raw, projectId), engine = getProjectSyncEngine(db, projectId)
  return { raw, db, engine, projectId }
}
type Replica = ReturnType<typeof replica>
function finalDraft(target: Replica, chapter: number, content: string): number {
  return target.db.transaction(() => {
    const draftId = DraftRepository.create({ chapterNumber: chapter, source: 'write', content, wordCount: content.length }, target.db)
    target.db.prepare("UPDATE drafts SET status='finalized' WHERE id=?").run(draftId)
    target.db.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,target_file_name,publication_status)
      VALUES(?,?,?,?,?,1,?,?,'synced-readonly')`).run(randomUUID(), draftId, chapter, `第${chapter}章`, hash(content), content, `synthetic-${chapter}.txt`)
    setAuthoritativeFinalizedDraft(target.db, chapter, draftId)
    return draftId
  })()
}
const planInput = (title = '铜钥匙') => ({ title, type: '伏笔', targetStartChapter: 1, targetEndChapter: 5, authorIntent: '第五章揭示钥匙用途，之前只推进线索。' })
function plan(target: Replica, title?: string) { return Threads.createPlan(planInput(title), target.db).id }
function confirm(target: Replica, planId: number, draftId: number, type: 'planted' | 'progressing' | 'resolved', evidence: string) {
  return Threads.confirmEvent({ planId, draftId, type, evidence, reason: `作者确认${type}证据。` }, target.db)
}
function seeded() {
  const a = replica(), body = '林岚拾到铜钥匙。她辨出钥匙刻印。铜钥匙打开北塔密室。'
  const draftId = finalDraft(a, 1, body), planId = plan(a)
  confirm(a, planId, draftId, 'planted', '林岚拾到铜钥匙')
  a.engine.enable()
  const b = replica(a.projectId); b.engine.join(a.engine.exportBundle())
  return { a, b, body, draftId, planId, remotePlanId: Threads.list(b.db)[0].id, remoteDraftId: Threads.list(b.db)[0].events[0].draftId }
}
const deliver = (from: Replica, to: Replica) => to.engine.apply(to.engine.receive(from.engine.exportBundle()).token)
const record = (target: Replica) => projection.capture(target.raw).find(record => record.kind === 'narrative-plan')!
function alteredNarrativeBundle(target: Replica, value: SyncJson): SyncBundle {
  const original = target.engine.exportBundle(), current = record(target)
  const prior = [...original.batches].filter(batch => batch.replicaId === original.senderReplicaId).sort((a, b) => b.sequence - a.sequence)[0]
  const observations = original.batches.flatMap(batch => batch.changes.map((change, index) => ({ batch, change, index })))
  const parents = new Set(observations.flatMap(({ change }) => change.parents))
  const head = observations.find(({ batch, change, index }) => change.kind === current.kind && change.id === current.id && !parents.has(`${batch.hash}:${index}`))!
  const next = { protocol: 1 as const, projectId: target.projectId, replicaId: original.senderReplicaId, sequence: prior.sequence + 1, previousHash: prior.hash, batchId: randomUUID(),
    changes: [{ kind: current.kind, id: current.id, parents: [`${head.batch.hash}:${head.index}`], value, deleted: false }] }
  const { hash: _hash, ...header } = original
  const envelope = { ...header, batches: [...original.batches, { ...next, hash: syncDigest(next) }] }
  return { ...envelope, hash: syncDigest(envelope) }
}
function choose(preview: ReturnType<ProjectSyncEngine['preview']>, pick: (value: SyncJson | null, deleted: boolean) => boolean): SyncResolution[] {
  return preview.conflicts.map(conflict => ({ kind: conflict.kind, id: conflict.id, expectedHeads: conflict.variants.map(variant => variant.revision),
    selectedRevision: conflict.variants.find(variant => pick(variant.value, variant.deleted))!.revision }))
}

describe('editable narrative synchronization across real SQLite replicas', () => {
  it('joins an active confirmed plan with mapped draft receipts and makes it available to the chapter-writing query', () => {
    const a = replica(), draftId = finalDraft(a, 1, '林岚拾到铜钥匙，北塔密室仍未打开。'), planId = plan(a)
    confirm(a, planId, draftId, 'planted', '林岚拾到铜钥匙'); a.engine.enable()
    const before = a.raw.prepare('SELECT * FROM narrative_thread_confirmations').all()
    const b = replica(a.projectId)
    for (const table of ['drafts', 'narrative_thread_plans', 'narrative_thread_confirmations']) b.raw.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,80)').run(table)
    const bundle = a.engine.exportBundle()
    expect(bundle.requiredFeatures).toEqual(['narrative-sync-v1'])
    expect(b.engine.join(bundle).applied).toBe(true)
    const active = Threads.listRelevantActive({ chapterNumber: 2, title: '调查北塔', keyEvents: '调查铜钥匙', characters: ['林岚'] }, b.db)
    expect(active).toHaveLength(1); expect(active[0]).toMatchObject({ title: '铜钥匙', status: 'planted', events: [expect.objectContaining({ evidence: '林岚拾到铜钥匙', chapterNumber: 1 })] })
    expect(active[0].id).not.toBe(planId); expect(active[0].events[0].draftId).not.toBe(draftId)
    expect(projection.capture(b.raw)).toEqual(projection.capture(a.raw))
    expect(a.raw.prepare('SELECT * FROM narrative_thread_confirmations').all()).toEqual(before)
    Threads.updatePlan(active[0].id, { ...planInput(), authorIntent: '手机改为第四章揭示。' }, b.db)
    expect(deliver(b, a).applied).toBe(true)
    expect(Threads.list(a.db)[0].authorIntent).toBe('手机改为第四章揭示。')
  })
  it('does not conflate independently created plan, event, or draft integer ids', () => {
    const a = replica(); a.engine.enable(); const b = replica(a.projectId); b.engine.join(a.engine.exportBundle())
    const leftDraft = finalDraft(a, 1, '甲拾到红钥匙。'), rightDraft = finalDraft(b, 2, '乙收到蓝信封。')
    const leftPlan = plan(a, '红钥匙'), rightPlan = plan(b, '蓝信封')
    const leftEvent = confirm(a, leftPlan, leftDraft, 'planted', '甲拾到红钥匙'), rightEvent = confirm(b, rightPlan, rightDraft, 'planted', '乙收到蓝信封')
    expect([leftDraft, leftPlan, leftEvent.id]).toEqual([1, 1, 1]); expect([rightDraft, rightPlan, rightEvent.id]).toEqual([1, 1, 1])
    expect(deliver(a, b).applied).toBe(true); expect(deliver(b, a).applied).toBe(true)
    for (const target of [a, b]) {
      const views = Threads.list(target.db)
      expect(views).toHaveLength(2)
      expect(views.find(plan => plan.title === '红钥匙')?.events[0]).toMatchObject({ chapterNumber: 1, evidence: '甲拾到红钥匙' })
      expect(views.find(plan => plan.title === '蓝信封')?.events[0]).toMatchObject({ chapterNumber: 2, evidence: '乙收到蓝信封' })
      for (const view of views) {
        const event = view.events[0], body = target.raw.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').pluck().get(event.draftId) as string
        expect(body).toContain(event.evidence)
      }
    }
    expect(projection.capture(a.raw)).toEqual(projection.capture(b.raw))
  })
  it('makes a concurrent plan edit versus a new confirmation an explicit aggregate conflict', () => {
    const { a, b, planId, remotePlanId, remoteDraftId } = seeded()
    Threads.updatePlan(planId, { ...planInput(), title: '桌面修改的钥匙计划' }, a.db)
    confirm(b, remotePlanId, remoteDraftId, 'progressing', '她辨出钥匙刻印')
    const preview = a.engine.receive(b.engine.exportBundle())
    expect(preview.conflicts.map(conflict => conflict.kind)).toEqual(['narrative-plan'])
    expect(preview.conflicts[0].variants.map(variant => (variant.value as { title: string }).title)).toContain('桌面修改的钥匙计划')
    expect(a.engine.apply(preview.token, choose(preview, value => (value as { events: unknown[] }).events.length === 2)).applied).toBe(true)
    expect(deliver(a, b).applied).toBe(true)
    expect(Threads.list(a.db)[0]).toMatchObject({ title: '铜钥匙', status: 'progressing' })
    expect(Threads.list(b.db)[0].events).toHaveLength(2)
    expect(a.engine.exportBundle().batches.flatMap(batch => batch.changes).some(change => (change.value as { title?: string })?.title === '桌面修改的钥匙计划')).toBe(true)
  })
  it('preserves both concurrent confirmations until the author selects one version', () => {
    const { a, b, planId, draftId, remotePlanId, remoteDraftId } = seeded()
    confirm(a, planId, draftId, 'progressing', '她辨出钥匙刻印')
    confirm(b, remotePlanId, remoteDraftId, 'resolved', '铜钥匙打开北塔密室')
    const preview = a.engine.receive(b.engine.exportBundle())
    expect(preview.conflicts).toHaveLength(1)
    expect(preview.conflicts[0].variants.map(variant => (variant.value as { events: { type: string }[] }).events.at(-1)!.type).sort()).toEqual(['progressing', 'resolved'])
    expect(a.engine.apply(preview.token).applied).toBe(false)
    a.engine.apply(preview.token, choose(preview, value => (value as { events: { type: string }[] }).events.at(-1)!.type === 'resolved'))
    deliver(a, b)
    expect(Threads.list(a.db)[0].status).toBe('resolved'); expect(Threads.list(b.db)[0].status).toBe('resolved')
  })
  it.each([false, true])('keeps delete versus new confirmation explicit and applies the chosen outcome: delete=%s', deleted => {
    const { a, b, planId, remotePlanId, remoteDraftId } = seeded()
    Threads.deletePlan(planId, a.db); confirm(b, remotePlanId, remoteDraftId, 'progressing', '她辨出钥匙刻印')
    const preview = a.engine.receive(b.engine.exportBundle())
    expect(preview.conflicts.map(conflict => conflict.kind)).toEqual(['narrative-plan'])
    a.engine.apply(preview.token, choose(preview, (_value, isDeleted) => isDeleted === deleted)); deliver(a, b)
    for (const target of [a, b]) {
      expect(Threads.list(target.db)).toHaveLength(deleted ? 0 : 1)
      expect(target.raw.prepare('SELECT COUNT(*) FROM narrative_thread_confirmations').pluck().get()).toBe(deleted ? 0 : 2)
      expect(target.engine.exportBundle().batches.flatMap(batch => batch.changes).some(change => change.kind === 'narrative-plan' && !change.deleted && (change.value as { events: unknown[] }).events.length === 2)).toBe(true)
    }
  })
  it('retains same-chapter event order when peer integer ids sort in the opposite order', () => {
    const a = replica(), draftId = finalDraft(a, 1, '林岚拾到铜钥匙。她辨出钥匙刻印。'), planId = plan(a)
    confirm(a, planId, draftId, 'planted', '林岚拾到铜钥匙'); confirm(a, planId, draftId, 'progressing', '她辨出钥匙刻印'); a.engine.enable()
    const value = record(a).value as { events: { id: string }[] }, b = replica(a.projectId)
    b.raw.prepare("INSERT INTO project_sync_entity_map VALUES('narrative-event',?,?)").run(value.events[0].id, '100')
    b.raw.prepare("INSERT INTO project_sync_entity_map VALUES('narrative-event',?,?)").run(value.events[1].id, '90')
    b.engine.join(a.engine.exportBundle())
    expect(b.raw.prepare('SELECT event_type FROM narrative_thread_confirmations ORDER BY id').pluck().all()).toEqual(['progressing', 'planted'])
    expect(Threads.list(b.db)[0]).toMatchObject({ status: 'progressing', events: [expect.objectContaining({ type: 'planted' }), expect.objectContaining({ type: 'progressing' })] })
    expect(projection.capture(b.raw)).toEqual(projection.capture(a.raw))
  })
  it('rejects forged source identities or evidence before changing actual plans', () => {
    const { a, b } = seeded(), baseline = projection.capture(b.raw)
    for (const field of ['evidence', 'draftId', 'finalizationId', 'contentHash']) {
      const forged = structuredClone(projection.capture(a.raw))
      const plan = forged.find(record => record.kind === 'narrative-plan')!.value as { events: Record<string, string>[] }
      plan.events[0][field] = field === 'draftId' ? randomUUID() : field === 'contentHash' ? 'b'.repeat(64) : '不属于该定稿的伪证据'
      expect(() => projection.apply(b.raw, forged)).toThrow('PROJECT_SYNC_NARRATIVE_INVALID')
      expect(projection.capture(b.raw)).toEqual(baseline)
    }
  })
  it('rejects reuse of a confirmed-event UUID with changed content in local or fully rehashed remote history', () => {
    const { a, b } = seeded(), before = projection.capture(a.raw)
    expect(() => a.db.prepare("UPDATE narrative_thread_confirmations SET reason='改写既有确认' WHERE id=1").run()).toThrow('PROJECT_SYNC_NARRATIVE_EVENT_IMMUTABLE')
    expect(projection.capture(a.raw)).toEqual(before)
    const original = a.engine.exportBundle(), prior = [...original.batches].filter(batch => batch.replicaId === original.senderReplicaId).sort((x, y) => y.sequence - x.sequence)[0]
    const record = before.find(record => record.kind === 'narrative-plan')!, changed = structuredClone(record.value) as { events: { reason: string }[] }
    changed.events[0].reason = '改写已经确认的事件理由'
    const source = original.batches.flatMap(batch => batch.changes.map((change, index) => ({ batch, change, index }))).find(({ change }) => change.kind === record.kind && change.id === record.id)!
    const batchBody = { protocol: 1 as const, projectId: a.projectId, replicaId: original.senderReplicaId, sequence: prior.sequence + 1, previousHash: prior.hash, batchId: randomUUID(),
      changes: [{ kind: record.kind, id: record.id, parents: [`${source.batch.hash}:${source.index}`], value: changed, deleted: false }] }
    const { hash: _hash, ...header } = original
    const envelope = { ...header, batches: [...original.batches, { ...batchBody, hash: syncDigest(batchBody) }] }
    const previousBatches = b.raw.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()
    expect(() => b.engine.receive({ ...envelope, hash: syncDigest(envelope) })).toThrow('PROJECT_SYNC_NARRATIVE_EVENT_IMMUTABLE')
    expect(b.raw.prepare('SELECT COUNT(*) FROM project_sync_batches').pluck().get()).toBe(previousBatches)
    expect(projection.capture(b.raw)).toEqual(before)
  })
  it('rejects a rehashed successor that reverses confirmed event order without changing event payloads', () => {
    const { a, b, planId, draftId } = seeded()
    confirm(a, planId, draftId, 'progressing', '她辨出钥匙刻印'); deliver(a, b)
    const before = projection.capture(b.raw), value = structuredClone(record(a).value) as { events: SyncJson[] }
    value.events.reverse()
    expect(() => b.engine.receive(alteredNarrativeBundle(a, value))).toThrow('PROJECT_SYNC_NARRATIVE_EVENT_IMMUTABLE')
    expect(projection.capture(b.raw)).toEqual(before)
    expect(Threads.list(b.db)[0].status).toBe('progressing')
  })
  it('allows later confirmation of an earlier chapter and a fresh UUID after its deleted source is replaced', () => {
    const { a, b, planId, draftId } = seeded()
    const later = finalDraft(a, 3, '林岚确认刻印的来源仍未解释。')
    confirm(a, planId, later, 'progressing', '刻印的来源仍未解释')
    deliver(a, b)
    confirm(a, planId, draftId, 'progressing', '她辨出钥匙刻印')
    deliver(a, b)
    expect(Threads.list(b.db)[0].events.map(event => event.chapterNumber)).toEqual([1, 1, 3])
    const oldIds = ((record(a).value as { events: { id: string }[] }).events).map(event => event.id)
    const replacement = finalDraft(a, 1, '林岚重新确认铜钥匙仍在手中。')
    a.db.prepare('DELETE FROM drafts WHERE id=?').run(draftId)
    confirm(a, planId, replacement, 'planted', '铜钥匙仍在手中')
    expect(deliver(a, b).applied).toBe(true)
    expect(Threads.list(b.db)[0].events.map(event => event.chapterNumber)).toEqual([1, 3])
    const current = (record(b).value as { events: { id: string; evidence: string }[] }).events
    const fresh = current.find(event => event.evidence === '铜钥匙仍在手中')
    expect(fresh).toBeDefined(); expect(oldIds).not.toContain(fresh!.id)
    expect(projection.capture(a.raw)).toEqual(projection.capture(b.raw))
  })
  it('upgrades existing live plans in an additive batch, keeps old history read-only, and gates new bundles', () => {
    const a = replica(), draftId = finalDraft(a, 1, '林岚拾到铜钥匙。'), planId = plan(a)
    confirm(a, planId, draftId, 'planted', '林岚拾到铜钥匙')
    const value = { plans: a.raw.prepare('SELECT id,title,type,target_start_chapter,target_end_chapter,author_intent FROM narrative_thread_plans').all(),
      events: a.raw.prepare('SELECT id,plan_id,draft_id,event_type,evidence,reason FROM narrative_thread_confirmations').all() }
    const payload = canonicalSyncJson(value)
    a.raw.prepare('INSERT INTO project_sync_history VALUES(?,?,?)').run(`history:narrative\0${hash(payload)}`, payload, hash(payload))
    const legacy = new ProjectSyncEngine(a.raw, a.projectId, { ...projection, legacyExtensionKinds: ['draft-selection'],
      capture: db => projection.capture(db).filter(record => record.kind !== 'narrative-plan') })
    legacy.enable(); const oldPackage = legacy.exportBundle()
    expect(oldPackage.requiredFeatures).toBeUndefined()
    const b = replica(a.projectId); b.engine.join(oldPackage)
    expect(Threads.list(b.db)).toEqual([])
    expect(b.raw.prepare("SELECT payload_json FROM project_sync_history WHERE origin_key LIKE 'history:narrative%'").pluck().get()).toBe(payload)
    const before = a.raw.prepare('SELECT * FROM narrative_thread_plans').all(), upgraded = a.engine.exportBundle()
    expect(upgraded.requiredFeatures).toEqual(['narrative-sync-v1'])
    expect(upgraded.batches.filter(batch => oldPackage.batches.some(old => old.batchId === batch.batchId))).toEqual(oldPackage.batches)
    expect(a.raw.prepare('SELECT * FROM narrative_thread_plans').all()).toEqual(before)
    expect(deliver(a, b).applied).toBe(true); expect(Threads.list(b.db)[0].status).toBe('planted')
    const { hash: _hash, requiredFeatures: _features, ...withoutFeature } = upgraded
    const pendingBefore = b.engine.status().pendingBatches
    expect(() => b.engine.receive({ ...withoutFeature, hash: syncDigest(withoutFeature) })).toThrow('SYNC_READER_FEATURE_REQUIRED')
    expect(b.engine.status().pendingBatches).toBe(pendingBefore)
    expect(() => validateSyncBundle({ ...upgraded, requiredFeatures: ['future-feature'] })).toThrow('SYNC_READER_FEATURE_UNSUPPORTED')
    // Frozen pre-feature envelope contract: older readers reject an unknown requiredFeatures key.
    const oldReader = (bundle: SyncBundle) => {
      const expected = ['format', 'version', 'projectId', 'senderReplicaId', 'batches', 'hash', ...('minimumReaderSchemaVersion' in bundle ? ['minimumReaderSchemaVersion'] : [])]
      if (Object.keys(bundle).sort().join(',') !== expected.sort().join(',')) throw new Error('SYNC_INVALID_DOCUMENT')
      return validateSyncBundle(bundle)
    }
    expect(oldReader(oldPackage)).toEqual(oldPackage); expect(() => oldReader(upgraded)).toThrow('SYNC_INVALID_DOCUMENT')
  })
  it('preserves the feature gate while combining Drive objects and joins an active cloud plan', async () => {
    const { a } = seeded(), bundle = a.engine.exportBundle(), encoded = new TextEncoder().encode(JSON.stringify(bundle))
    const service = new GoogleDriveSyncService(new GoogleDriveStateStore({ read: () => null, write: () => {} }))
    const client = { accountId: async () => 'account', checkFolder: async () => ({ appProperties: { ainwProject: a.projectId } }),
      discover: async () => ({ cursor: 'cloud-cursor', files: [{ id: 'object', appProperties: { ainwDigest: hash(new TextDecoder().decode(encoded)) } }] }), download: async () => encoded } as unknown as GoogleDriveClient
    const downloaded = await service.downloadProject(client, 'cloud-folder', () => {})
    expect(downloaded.bundle.requiredFeatures).toEqual(['narrative-sync-v1'])
    const c = replica(a.projectId); c.engine.join(downloaded.bundle)
    expect(Threads.listRelevantActive({ chapterNumber: 2, title: '铜钥匙', keyEvents: '', characters: ['林岚'] }, c.db)[0]).toMatchObject({ title: '铜钥匙', status: 'planted' })
  })
})
