import { isReceiptedDraftStatus } from '../../src/shared/draft-status'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncBatch, SyncJson, SyncRecord } from '../../src/shared/project-sync'
import { compareNarrativeEvents, narrativeEventOrder } from '../repositories/narrative-thread-order'

type Db = Database.Database
type JsonObject = { [key: string]: SyncJson }
interface PlanRow { id: number; title: string; type: string; target_start_chapter: number; target_end_chapter: number; author_intent: string; created_at: string; updated_at: string }
interface EventRow { id: number; plan_id: number; draft_id: number; event_type: string; evidence: string; reason: string; created_at: string }
interface DraftProof { status: string; content: string; finalization: JsonObject | null }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
function fail(): never { throw new Error('PROJECT_SYNC_NARRATIVE_INVALID') }
const object = (value: SyncJson): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value : fail()
const exact = (row: JsonObject, keys: string[]) => { if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0')) fail() }
const text = (value: SyncJson | undefined, maximum: number): string => typeof value === 'string' && value.trim() && value.length <= maximum && !value.includes('\0') ? value : fail()
const integer = (value: SyncJson | undefined): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fail()
const id = (value: SyncJson | undefined): string => typeof value === 'string' && UUID.test(value) ? value : fail()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function stable(db: Db, kind: string, key: number): string {
  const found = db.prepare('SELECT entity_id FROM project_sync_entity_map WHERE kind=? AND local_key=?').pluck().get(kind, String(key))
  if (found) return String(found)
  const value = randomUUID(); db.prepare('INSERT INTO project_sync_entity_map(kind,entity_id,local_key) VALUES(?,?,?)').run(kind, value, String(key)); return value
}
function local(db: Db, kind: string, key: string): number | null {
  const found = db.prepare('SELECT local_key FROM project_sync_entity_map WHERE kind=? AND entity_id=?').pluck().get(kind, key)
  return found === undefined ? null : integer(Number(found))
}
export function captureNarrativePlans(db: Db): SyncRecord[] {
  const plans = db.prepare('SELECT * FROM narrative_thread_plans ORDER BY id').all() as PlanRow[]
  const events = db.prepare('SELECT * FROM narrative_thread_confirmations ORDER BY id').all() as EventRow[]
  const order = narrativeEventOrder(db)
  const positions = db.prepare("SELECT local_key FROM project_sync_entity_map WHERE kind='narrative-event-order'").pluck().all() as string[]
  return plans.map(plan => {
    const planId = stable(db, 'narrative-plan', plan.id)
    const own = events.filter(event => event.plan_id === plan.id).sort((a, b) => compareNarrativeEvents(a, b, order))
    // A deleted confirmation still reserves its local derived order key until
    // a projection rebuild. New confirmations must not reuse that key.
    let maximum = Math.max(0, ...positions.filter(value => value.startsWith(`${planId}:`)).map(value => Number(value.slice(value.lastIndexOf(':') + 1))),
      ...own.map(event => order.get(event.id) ?? 0))
    const confirmations = own.map(event => {
      const eventId = stable(db, 'narrative-event', event.id)
      if (!order.has(event.id)) {
        order.set(event.id, ++maximum)
        db.prepare("INSERT INTO project_sync_entity_map(kind,entity_id,local_key) VALUES('narrative-event-order',?,?)")
          .run(eventId, `${planId}:${String(maximum).padStart(10, '0')}`)
      }
      const receipt = db.prepare('SELECT finalization_id,content_hash FROM finalization_outbox WHERE draft_id=?').get(event.draft_id) as { finalization_id: string; content_hash: string } | undefined
      if (!receipt) fail()
      return { id: eventId, draftId: stable(db, 'draft', event.draft_id), type: event.event_type, evidence: event.evidence, reason: event.reason,
        createdAt: event.created_at, finalizationId: receipt.finalization_id, contentHash: receipt.content_hash }
    })
    return { kind: 'narrative-plan', id: planId, value: { title: plan.title, type: plan.type, targetStartChapter: plan.target_start_chapter,
      targetEndChapter: plan.target_end_chapter, authorIntent: plan.author_intent, createdAt: plan.created_at, updatedAt: plan.updated_at, events: confirmations } }
  })
}

export function validateNarrativePlan(record: SyncRecord, drafts?: Map<string, DraftProof>, eventIds = new Set<string>()): void {
  id(record.id)
  const plan = object(record.value)
  exact(plan, ['title', 'type', 'targetStartChapter', 'targetEndChapter', 'authorIntent', 'createdAt', 'updatedAt', 'events'])
  text(plan.title, 120); text(plan.type, 60); text(plan.authorIntent, 1000); text(plan.createdAt, 100); text(plan.updatedAt, 100)
  const events = plan.events
  if (integer(plan.targetEndChapter) < integer(plan.targetStartChapter) || !Array.isArray(events) || events.length > 20_000) fail()
  const confirmations = new Set<string>()
  for (const input of events) {
    const event = object(input); exact(event, ['id', 'draftId', 'type', 'evidence', 'reason', 'createdAt', 'finalizationId', 'contentHash'])
    const eventId = id(event.id), draftId = id(event.draftId)
    if (eventIds.has(eventId)) fail(); eventIds.add(eventId)
    if (!['planted', 'progressing', 'resolved', 'abandoned'].includes(String(event.type)) || !/^[a-f0-9]{64}$/.test(String(event.contentHash))) fail()
    const evidence = text(event.evidence, 240); text(event.reason, 500); text(event.createdAt, 100); text(event.finalizationId, 512)
    const identity = JSON.stringify([draftId, event.type, evidence])
    if (confirmations.has(identity)) fail(); confirmations.add(identity)
    if (!drafts) continue
    const source = drafts.get(draftId), receipt = source?.finalization
    if (!source || !isReceiptedDraftStatus(source.status) || !receipt || receipt.finalization_id !== event.finalizationId
      || receipt.content_hash !== event.contentHash || receipt.content_snapshot !== source.content || hash(source.content) !== event.contentHash
      || !source.content.replace(/\s+/gu, '').includes(evidence.replace(/\s+/gu, ''))) fail()
  }
}

/** A plan may change, but the same confirmed-event UUID cannot be rewritten in another version. */
export function validateNarrativeHistory(batches: readonly SyncBatch[]): void {
  const known = new Map<string, string>()
  const next = new Map<string, Set<string>>(), degree = new Map<string, number>()
  for (const batch of batches) for (const change of batch.changes) {
    if (change.kind !== 'narrative-plan' || change.deleted) continue
    validateNarrativePlan({ kind: change.kind, id: change.id, value: change.value })
    const plan = object(change.value)
    let previous: string | undefined
    for (const input of plan.events as SyncJson[]) {
      const event = object(input), key = id(event.id)
      const payload = JSON.stringify([change.id, event.id, event.draftId, event.type, event.evidence, event.reason, event.createdAt, event.finalizationId, event.contentHash])
      if (known.has(key) && known.get(key) !== payload) throw new Error('PROJECT_SYNC_NARRATIVE_EVENT_IMMUTABLE')
      known.set(key, payload)
      if (!degree.has(key)) degree.set(key, 0)
      if (previous) {
        const after = next.get(previous) ?? new Set<string>()
        if (!after.has(key)) { after.add(key); degree.set(key, degree.get(key)! + 1) }
        next.set(previous, after)
      }
      previous = key
    }
  }
  // Combining confirmation orders may add new events, but cannot reverse an
  // already confirmed relative order and silently roll a chapter's state back.
  const queue = [...degree].filter(([, count]) => count === 0).map(([key]) => key)
  for (let offset = 0; offset < queue.length; offset++) for (const key of next.get(queue[offset]) ?? []) {
    const remaining = degree.get(key)! - 1; degree.set(key, remaining); if (!remaining) queue.push(key)
  }
  if (queue.length !== degree.size) throw new Error('PROJECT_SYNC_NARRATIVE_EVENT_IMMUTABLE')
}

/** Called only after drafts, immutable finalization receipts and selected heads are restored. */
export function applyNarrativePlans(db: Db, records: SyncRecord[], resolveDraft: (stableId: string) => number | null): void {
  const desired = records.filter(record => record.kind === 'narrative-plan')
  // Reserve every existing identity before deleting rows; local integer ids must never stand in for a peer UUID.
  for (const row of db.prepare('SELECT id FROM narrative_thread_plans').all() as { id: number }[]) stable(db, 'narrative-plan', row.id)
  for (const row of db.prepare('SELECT id FROM narrative_thread_confirmations').all() as { id: number }[]) stable(db, 'narrative-event', row.id)
  db.prepare('DELETE FROM narrative_thread_confirmations').run()
  for (const row of db.prepare('SELECT id FROM narrative_thread_plans').all() as { id: number }[]) {
    if (!desired.some(record => local(db, 'narrative-plan', record.id) === row.id)) db.prepare('DELETE FROM narrative_thread_plans WHERE id=?').run(row.id)
  }
  db.prepare("DELETE FROM project_sync_entity_map WHERE kind='narrative-event-order'").run()
  for (const record of desired) {
    const value = object(record.value)
    let planId = local(db, 'narrative-plan', record.id)
    const inserted = db.prepare(`INSERT INTO narrative_thread_plans(id,title,type,target_start_chapter,target_end_chapter,author_intent,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,type=excluded.type,target_start_chapter=excluded.target_start_chapter,
      target_end_chapter=excluded.target_end_chapter,author_intent=excluded.author_intent,created_at=excluded.created_at,updated_at=excluded.updated_at`)
      .run(planId, value.title, value.type, value.targetStartChapter, value.targetEndChapter, value.authorIntent, value.createdAt, value.updatedAt)
    if (planId === null) { planId = Number(inserted.lastInsertRowid); db.prepare("INSERT INTO project_sync_entity_map VALUES('narrative-plan',?,?)").run(record.id, String(planId)) }
    for (const [position, input] of (value.events as SyncJson[]).entries()) {
      const event = object(input), stableEventId = id(event.id), draftId = resolveDraft(id(event.draftId))
      if (draftId === null) fail()
      const eventId = local(db, 'narrative-event', stableEventId)
      const created = db.prepare('INSERT INTO narrative_thread_confirmations(id,plan_id,draft_id,event_type,evidence,reason,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(eventId, planId, draftId, event.type, event.evidence, event.reason, event.createdAt)
      if (eventId === null) db.prepare("INSERT INTO project_sync_entity_map VALUES('narrative-event',?,?)").run(stableEventId, String(created.lastInsertRowid))
      db.prepare("INSERT INTO project_sync_entity_map VALUES('narrative-event-order',?,?)").run(stableEventId, `${record.id}:${String(position + 1).padStart(10, '0')}`)
    }
  }
}
