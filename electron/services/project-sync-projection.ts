import { WORKING_DRAFT_STATUSES, isReceiptedDraftStatus } from '../../src/shared/draft-status'
import { invalidateContinuityProjectionFrom } from '../repositories/summary-repository'
import { validateStoredSyncHistory, validateSyncHistoryRecord } from './project-sync-history'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncChange, SyncJson, SyncRecord } from '../../src/shared/project-sync'
import policy from './portable-project-field-policy.json'
import { CharacterRosterRepository } from '../repositories/character-roster-repository'
import { getAuthoritativeFinalizedDraftId, setAuthoritativeFinalizedDraft } from './finalized-draft-head'
import { verifyM02CharacterIdentity } from '../migrations/m02-character-identity'
import { STORY_TABLES } from './story-branch-schema'
import { StoryBranchRepository, validateStoryData, validateStoryRecord } from '../repositories/story-branch-repository'
import { DraftRepository } from '../repositories/draft-repository'
import { applyNarrativePlans, captureNarrativePlans, validateNarrativeHistory, validateNarrativePlan } from './project-sync-narrative'
import { applySelectedProjectAssets, captureProjectAssets, parseProjectAssetRecords, validateProjectAssetChanges, validateProjectAssetHistory } from './project-sync-assets'
import { validateProjectAssetSet } from '../../src/shared/project-sync-assets'
import { isCompactAuthorRecord } from './project-sync-scope'

type Db = Database.Database
type Row = Record<string, SyncJson>
function fail(code: string): never { throw new Error(`PROJECT_SYNC_${code}`) }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const sorted = (value: SyncJson): SyncJson => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key]!)])) : value
const encode = (value: SyncJson) => JSON.stringify(sorted(value))
const object = (value: SyncJson): Row => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('RECORD_INVALID')
const storyRecordId = (table: string, value: SyncJson): string => {
  const row = object(value)
  return table === 'story_notes' ? `${row.routeId ?? 'shared'}:${row.nodeId}` : String(row.id)
}
const text = (value: SyncJson | undefined): string => typeof value === 'string' && value.length > 0 ? value : fail('RECORD_INVALID')
const integer = (value: SyncJson | undefined): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fail('RECORD_INVALID')
const tables = policy.tables as Record<string, Record<string, string>>
const fields = (table: string) => Object.keys(tables[table]!).filter(key => !['created_at', 'updated_at', 'avatar'].includes(key))
const coreFields = fields('project_core').filter(key => !['id', 'characters_arch', 'character_states', 'plot_tree_snapshot'].includes(key))
const characterTables = ['characters', 'character_identity_approvals', 'character_identity_origins', 'character_aliases',
  'character_identity_proposals', 'character_relationships', 'character_identity_meta', 'character_roster_meta', 'character_roster_operations']
const characterDeleteOrder = ['character_relationships', 'character_identity_proposals', 'character_aliases', 'character_identity_origins',
  'character_identity_approvals', 'character_roster_operations']
function select(db: Db, table: string, columns = fields(table)): Row[] {
  return (db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}`).all() as Row[])
    .sort((a, b) => encode(a).localeCompare(encode(b)))
}
function scalarRow(row: Row, allowed: string[]): void {
  if (Object.keys(row).length !== allowed.length || allowed.some(key => !Object.hasOwn(row, key))
    || Object.values(row).some(value => value !== null && typeof value !== 'string' && typeof value !== 'number'
      || typeof value === 'number' && !Number.isFinite(value))) fail('RECORD_INVALID')
}
function stableId(db: Db, kind: string, localKey: string): string {
  const existing = db.prepare('SELECT entity_id FROM project_sync_entity_map WHERE kind=? AND local_key=?').pluck().get(kind, localKey)
  if (existing) return String(existing)
  const id = randomUUID()
  db.prepare('INSERT INTO project_sync_entity_map(kind,entity_id,local_key) VALUES(?,?,?)').run(kind, id, localKey)
  return id
}
function localId(db: Db, kind: string, id: string): number | null {
  const value = db.prepare('SELECT local_key FROM project_sync_entity_map WHERE kind=? AND entity_id=?').pluck().get(kind, id)
  return value === undefined ? null : integer(Number(value))
}
function remember(db: Db, kind: string, id: string, value: SyncJson): void {
  const key = `${kind}\u0000${id}`, payload = encode(value), digest = hash(payload)
  const prior = db.prepare('SELECT content_hash FROM project_sync_history WHERE origin_key=?').pluck().get(key)
  if (prior && prior !== digest) fail('HISTORY_IMMUTABLE')
  db.prepare('INSERT OR IGNORE INTO project_sync_history VALUES(?,?,?)').run(key, payload, digest)
}
function captureInner(db: Db, compact = false): SyncRecord[] {
  const records: SyncRecord[] = []
  for (const table of STORY_TABLES) {
    for (const row of db.prepare(`SELECT id,payload_json FROM ${quote(table)} ORDER BY id`).all() as { id: string; payload_json: string }[]) {
      let value: SyncJson
      try { value = JSON.parse(row.payload_json) as SyncJson } catch { fail('STORY_INVALID') }
      if (object(value).id !== row.id) fail('STORY_INVALID')
      records.push({ kind: table, id: storyRecordId(table, value), value })
    }
  }
  const core = db.prepare(`SELECT ${coreFields.map(quote).join(',')} FROM project_core WHERE id='main'`).get() as Row | undefined
  if (core) for (const name of coreFields) records.push({ kind: 'project-core', id: name, value: core[name]! })
  for (const row of select(db, 'blueprints')) records.push({ kind: 'blueprint', id: String(row.chapter_number), value: row })
  records.push({ kind: 'characters', id: 'roster', value: { ...Object.fromEntries(characterTables.map(table => [table, select(db, table)])), projection: String(db.prepare("SELECT characters_arch FROM project_core WHERE id='main'").pluck().get() ?? '') } })
  const drafts = db.prepare('SELECT d.*,c.body FROM drafts d JOIN contents c ON c.id=d.content_id ORDER BY d.id').all() as Row[]
  for (const row of drafts) stableId(db, 'draft', String(row.id))
  for (const row of drafts) {
    const dependencies = JSON.parse(String(row.source_dependencies)) as Row[]
    if (!Array.isArray(dependencies)) fail('DEPENDENCY_INVALID')
    const mapped = dependencies.map(dependency => {
      const id = stableId(db, 'draft', String(integer(dependency.draftId)))
      return { ...dependency, draftId: String(id) }
    })
    const receipt = db.prepare('SELECT finalization_id,chapter_title,content_hash,content_revision,content_snapshot FROM finalization_outbox WHERE draft_id=?').get(row.id) as Row | undefined
    records.push({ kind: 'draft', id: stableId(db, 'draft', String(row.id)), value: {
      chapterNumber: row.chapter_number!, status: row.status!, source: row.source!, content: row.body!, wordCount: row.word_count!,
      dependencies: mapped, finalization: receipt ?? null,
    } })
  }
  for (const row of drafts.filter(row => row.status === 'finalized')) {
    const current = getAuthoritativeFinalizedDraftId(db, Number(row.chapter_number))
    if (current === row.id) records.push({ kind: `finalization:${row.chapter_number}`, id: 'head', value: { draftId: stableId(db, 'draft', String(row.id)) } })
  }
  if (Number(db.pragma('user_version', { simple: true })) >= 10) for (const chapter of new Set(drafts.map(row => Number(row.chapter_number)))) {
    const selected = DraftRepository.listByChapter(chapter, db).filter(draft => (WORKING_DRAFT_STATUSES as readonly string[]).includes(draft.status) && !draft.dependenciesStale)
      .sort((left, right) => right.version - left.version || right.id - left.id)[0]
    if (selected) records.push({ kind: 'draft-selection', id: String(chapter), value: { draftId: stableId(db, 'draft', String(selected.id)) } })
  }
  records.push(...captureNarrativePlans(db))
  records.push(...captureProjectAssets(db).filter(record => !compact || isCompactAuthorRecord(record.kind, record.id, record.value)))
  // Legacy immutable evidence remains admissible, but new review/generation/
  // display snapshots stay local and no longer grow the author sync graph.
  if (!compact) {
    for (const row of db.prepare('SELECT * FROM project_sync_history ORDER BY origin_key').all() as { origin_key: string; payload_json: string; content_hash: string }[]) {
      records.push(validateStoredSyncHistory(row))
    }
  }
  return records.sort((a, b) => `${a.kind}\u0000${a.id}`.localeCompare(`${b.kind}\u0000${b.id}`))
}

export function capture(database: Db): SyncRecord[] {
  return database.inTransaction ? captureInner(database) : database.transaction(() => captureInner(database))()
}
export function captureCompact(database: Db): SyncRecord[] {
  return database.inTransaction ? captureInner(database, true) : database.transaction(() => captureInner(database, true))()
}

/** Retire old sync-only evidence and detach device-local static manifests.
 * Removing a manifest must never delete the author's local prompt/Skill file. */
export function prepareCompactAuthorProjection(database: Db): void {
  database.transaction(() => {
    database.prepare('DELETE FROM project_sync_history').run()
    for (const record of captureProjectAssets(database)) if (!isCompactAuthorRecord(record.kind, record.id, record.value)) {
      database.prepare('DELETE FROM project_asset_local_state WHERE asset_id=?').run(record.id)
      database.prepare('DELETE FROM project_author_assets WHERE asset_id=?').run(record.id)
    }
    for (const row of database.prepare('SELECT asset_id,materialized_json FROM project_asset_local_state WHERE materialized_json IS NOT NULL').all() as { asset_id: string; materialized_json: string }[]) {
      if (!isCompactAuthorRecord('project-asset', row.asset_id, JSON.parse(row.materialized_json) as SyncJson)) {
        database.prepare('DELETE FROM project_asset_local_state WHERE asset_id=?').run(row.asset_id)
      }
    }
  })()
}

export function applyCompact(database: Db, records: SyncRecord[]): void {
  database.transaction(() => { prepareCompactAuthorProjection(database); applyInner(database, records) })()
}
export function validate(records: SyncRecord[], complete = true): void {
  const keys = new Set<string>(), drafts = new Map<string, Row>(), heads = new Map<number, string>(), selections = new Map<number, string>()
  for (const record of records) {
    if (!record || typeof record.kind !== 'string' || !record.kind || typeof record.id !== 'string' || !record.id
      || record.kind.includes('\u0000') || record.id.includes('\u0000')) fail('RECORD_INVALID')
    const key = `${record.kind}\u0000${record.id}`
    if (keys.has(key)) fail('DUPLICATE_RECORD')
    keys.add(key)
    if ((STORY_TABLES as readonly string[]).includes(record.kind)) {
      try { validateStoryRecord(record.kind as typeof STORY_TABLES[number], record.value) } catch { fail('STORY_INVALID') }
      if (storyRecordId(record.kind, record.value) !== record.id) fail('STORY_INVALID')
    } else if (record.kind === 'project-core') {
      if (!coreFields.includes(record.id)) fail('RECORD_INVALID')
      const numeric = ['total_chapters', 'words_per_chapter', 'narrative_thread_dormant_threshold'].includes(record.id)
      const required = ['project_name', 'writing_language', 'creative_strategy', 'narrative_thread_dormant_threshold'].includes(record.id)
      if (record.value === null ? required : numeric ? !Number.isSafeInteger(record.value) : typeof record.value !== 'string') fail('RECORD_INVALID')
    } else if (record.kind === 'blueprint') {
      const row = object(record.value); scalarRow(row, fields('blueprints'))
      if (String(integer(row.chapter_number)) !== record.id || typeof row.title !== 'string'
        || Object.entries(row).some(([key, value]) => key !== 'chapter_number' && value !== null && typeof value !== 'string')) fail('RECORD_INVALID')
    } else if (record.kind === 'characters') {
      const roster = object(record.value)
      if (record.id !== 'roster' || Object.keys(roster).length !== characterTables.length + 1 || typeof roster.projection !== 'string') fail('RECORD_INVALID')
      for (const table of characterTables) {
        const rows = roster[table]
        if (!Array.isArray(rows)) fail('RECORD_INVALID')
        for (const row of rows) scalarRow(object(row), fields(table))
      }
    } else if (record.kind === 'draft') {
      const row = object(record.value)
      if (Object.keys(row).sort().join(',') !== 'chapterNumber,content,dependencies,finalization,source,status,wordCount'
        || typeof row.content !== 'string' || !['write', 'rewrite'].includes(String(row.source))
        || !['draft', 'revised', 'reviewed', 'finalized', 'superseded', 'archived'].includes(String(row.status))
        || !Number.isSafeInteger(row.wordCount) || Number(row.wordCount) < 0 || !Array.isArray(row.dependencies)) fail('RECORD_INVALID')
      integer(row.chapterNumber)
      const seen = new Set<string>()
      for (const raw of row.dependencies) {
        const dependency = object(raw), id = text(dependency.draftId)
        if (seen.has(id) || !/^[a-f0-9]{64}$/.test(String(dependency.contentHash))
          || Object.keys(dependency).some(name => !['draftId', 'contentHash', 'kind', 'chapterNumber', 'finalizationId'].includes(name))
          || dependency.kind !== undefined && !['candidate', 'finalized', 'legacy-finalized'].includes(String(dependency.kind))) fail('DEPENDENCY_INVALID')
        seen.add(id)
        if (dependency.kind === 'finalized' || dependency.kind === 'legacy-finalized') integer(dependency.chapterNumber)
        if (dependency.kind === 'finalized') text(dependency.finalizationId)
      }
      if (row.finalization !== null) {
        const receipt = object(row.finalization)
        scalarRow(receipt, ['finalization_id', 'chapter_title', 'content_hash', 'content_revision', 'content_snapshot'])
        text(receipt.finalization_id); integer(receipt.content_revision)
        if (!isReceiptedDraftStatus(String(row.status)) || receipt.content_snapshot !== row.content || receipt.content_hash !== hash(row.content)) fail('FINALIZATION_INVALID')
      }
      drafts.set(record.id, row)
    } else if (record.kind === 'narrative-plan') {
      validateNarrativePlan(record)
    } else if (record.kind === 'project-asset') {
      parseProjectAssetRecords([record])
    } else if (record.kind === 'draft-selection') {
      const row = object(record.value)
      if (!/^[1-9][0-9]*$/.test(record.id) || Number(record.id) > 100_000 || Object.keys(row).join(',') !== 'draftId') fail('DRAFT_SELECTION_INVALID')
      selections.set(Number(record.id), text(row.draftId))
    } else if (/^finalization:[1-9][0-9]*$/.test(record.kind)) {
      const row = object(record.value)
      if (record.id !== 'head' || Object.keys(row).join(',') !== 'draftId') fail('FINALIZATION_INVALID')
      heads.set(Number(record.kind.slice(13)), text(row.draftId))
    } else if (record.kind.startsWith('history:')) validateSyncHistoryRecord(record)
    else fail('KIND_UNSUPPORTED')
  }
  if (!complete) return
  try {
    validateStoryData({
      nodes: records.filter(record => record.kind === 'story_nodes').map(record => record.value),
      edges: records.filter(record => record.kind === 'story_edges').map(record => record.value),
      routes: records.filter(record => record.kind === 'story_routes').map(record => record.value),
      notes: records.filter(record => record.kind === 'story_notes').map(record => record.value),
      revisions: records.filter(record => record.kind === 'story_node_revisions').map(record => record.value),
    })
  } catch { fail('STORY_INVALID') }
  if (!keys.has('characters\u0000roster') || coreFields.some(field => !keys.has(`project-core\u0000${field}`))) fail('GENESIS_INCOMPLETE')
  for (const [id, row] of drafts) {
    if (row.status === 'superseded' && (!heads.has(Number(row.chapterNumber)) || heads.get(Number(row.chapterNumber)) === id)) fail('FINALIZATION_INVALID')
    if (row.status === 'finalized' && !heads.has(Number(row.chapterNumber))) fail('FINALIZATION_INVALID')
  }
  for (const [chapter, id] of heads) if (drafts.get(id)?.chapterNumber !== chapter || drafts.get(id)?.status !== 'finalized') fail('FINALIZATION_INVALID')
  for (const [chapter, id] of selections) if (drafts.get(id)?.chapterNumber !== chapter || !(WORKING_DRAFT_STATUSES as readonly string[]).includes(String(drafts.get(id)?.status))) fail('DRAFT_SELECTION_INVALID')
  const narrativeDrafts = new Map([...drafts].map(([id, row]) => [id, { status: String(row.status), content: String(row.content),
    finalization: row.finalization === null ? null : object(row.finalization!) }]))
  const eventIds = new Set<string>()
  for (const record of records.filter(record => record.kind === 'narrative-plan')) validateNarrativePlan(record, narrativeDrafts, eventIds)
  const roster = object(records.find(record => record.kind === 'characters')!.value)
  validateProjectAssetSet(parseProjectAssetRecords(records), new Set((roster.characters as Row[]).map(row => String(row.character_id))))
}

export function validateChanges(changes: SyncChange[]): void {
  validateProjectAssetChanges(changes)
  for (const change of changes) {
    if (!change || typeof change.kind !== 'string' || typeof change.id !== 'string' || !change.id || change.id.includes('\u0000')) fail('RECORD_INVALID')
    if (change.deleted) {
      if (change.kind === 'project-asset') continue
      if (change.kind === 'story_notes' && /^(?:shared|mainline|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(?:chapter:(?:[1-9][0-9]{0,4}|100000)|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(change.id)) continue
      if (['story_nodes', 'story_edges', 'story_routes'].includes(change.kind)
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(change.id)) continue
      if (change.kind === 'draft') continue
      if (change.kind === 'narrative-plan' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(change.id)) continue
      if (change.kind === 'draft-selection' && /^[1-9][0-9]*$/.test(change.id) && Number(change.id) <= 100_000) continue
      if (change.kind === 'blueprint' && /^[1-9][0-9]*$/.test(change.id)) continue
      if (/^finalization:[1-9][0-9]*$/.test(change.kind) && change.id === 'head') continue
      fail('DELETE_UNSUPPORTED')
    }
    validate([{ kind: change.kind, id: change.id, value: change.value }], false)
  }
}

/** A legacy package has no authority to select among several unfinished drafts.
 * An explicit finalization head still wins, so older finalized books remain joinable. */
export function validateLegacyImport(records: SyncRecord[]): void {
  const selections = new Set(records.filter(record => record.kind === 'draft-selection').map(record => record.id))
  const heads = new Set(records.filter(record => /^finalization:[1-9][0-9]*$/.test(record.kind)).map(record => record.kind.slice(13)))
  const candidates = new Map<string, number>()
  for (const record of records.filter(record => record.kind === 'draft')) {
    const row = object(record.value), chapter = String(row.chapterNumber)
    if ((WORKING_DRAFT_STATUSES as readonly string[]).includes(String(row.status))) candidates.set(chapter, (candidates.get(chapter) ?? 0) + 1)
  }
  for (const [chapter, count] of candidates) if (count > 1 && !heads.has(chapter) && !selections.has(chapter)) fail('DRAFT_SELECTION_REQUIRED')
}

function insert(db: Db, table: string, row: Row, conflict?: string): void {
  const names = Object.keys(row)
  db.prepare(`INSERT INTO ${quote(table)}(${names.map(quote).join(',')}) VALUES(${names.map(() => '?').join(',')})`
    + (conflict ? ` ON CONFLICT(${quote(conflict)}) DO UPDATE SET ${names.filter(name => name !== conflict).map(name => `${quote(name)}=excluded.${quote(name)}`).join(',')}` : ''))
    .run(...names.map(name => row[name]))
}
function applyInner(db: Db, records: SyncRecord[]): void {
  validate(records)
  validateCandidate(db, records)
  for (const table of STORY_TABLES) {
    const desiredStory = records.filter(record => record.kind === table)
    for (const row of db.prepare(`SELECT id,payload_json FROM ${quote(table)}`).all() as { id: string; payload_json: string }[]) {
      const desired = desiredStory.find(record => object(record.value).id === row.id)
      if (table === 'story_node_revisions') {
        if (!desired || encode(JSON.parse(row.payload_json) as SyncJson) !== encode(desired.value)) fail('HISTORY_IMMUTABLE')
      } else if (!desired) db.prepare(`DELETE FROM ${quote(table)} WHERE id=?`).run(row.id)
    }
    for (const record of desiredStory) {
      db.prepare(`INSERT INTO ${quote(table)}(id,payload_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`).run(String(object(record.value).id), encode(record.value))
    }
  }
  const oldHeads = new Map((db.prepare("SELECT DISTINCT chapter_number FROM drafts WHERE status='finalized'").all() as { chapter_number: number }[])
    .map(row => [row.chapter_number, getAuthoritativeFinalizedDraftId(db, row.chapter_number)]))
  db.prepare("INSERT OR IGNORE INTO project_core(id) VALUES('main')").run()
  for (const record of records.filter(record => record.kind === 'project-core')) db.prepare(`UPDATE project_core SET ${quote(record.id)}=? WHERE id='main'`).run(record.value)
  const blueprints = records.filter(record => record.kind === 'blueprint')
  for (const row of select(db, 'blueprints')) if (!blueprints.some(record => record.id === String(row.chapter_number))) db.prepare('DELETE FROM blueprints WHERE chapter_number=?').run(row.chapter_number)
  for (const record of blueprints) insert(db, 'blueprints', object(record.value), 'chapter_number')
  const roster = object(records.find(record => record.kind === 'characters')!.value)
  for (const table of characterDeleteOrder) db.prepare(`DELETE FROM ${quote(table)}`).run()
  const characters = roster.characters as Row[]
  for (const row of characters) insert(db, 'characters', row, 'character_id')
  for (const row of select(db, 'characters')) if (!characters.some(character => character.character_id === row.character_id)) db.prepare('DELETE FROM characters WHERE character_id=?').run(row.character_id)
  for (const table of characterTables.filter(table => !['characters', 'character_identity_meta', 'character_roster_meta'].includes(table))) {
    for (const row of roster[table] as Row[]) insert(db, table, row)
  }
  for (const table of ['character_identity_meta', 'character_roster_meta']) for (const row of roster[table] as Row[]) insert(db, table, row, 'id')
  if (!verifyM02CharacterIdentity(db)) fail('CHARACTER_IDENTITY_INVALID')
  // Reconstruct the same display-only markdown without changing source receipts/revisions.
  db.prepare("UPDATE project_core SET characters_arch=? WHERE id='main'").run(roster.projection)
  const rosterSnapshot = CharacterRosterRepository.read(db)
  if (!['ready', 'empty', 'legacy_cards_preserved', 'legacy_markdown_pending'].includes(rosterSnapshot.status)) fail('CHARACTER_ROSTER_INVALID')
  const desired = records.filter(record => record.kind === 'draft')
  for (const record of desired) {
    const mappedId = localId(db, 'draft', record.id)
    if (mappedId !== null && db.prepare('SELECT 1 FROM drafts WHERE id=?').get(mappedId)) continue
    const row = object(record.value)
    const version = Number(db.prepare('SELECT COALESCE(MAX(version),0)+1 FROM drafts WHERE chapter_number=?').pluck().get(row.chapterNumber))
    const content = db.prepare('INSERT INTO contents(body) VALUES(?)').run(row.content)
    const created = db.prepare('INSERT INTO drafts(id,chapter_number,version,source,content_id,word_count) VALUES(?,?,?,?,?,?)').run(mappedId, row.chapterNumber, version, row.source, Number(content.lastInsertRowid), row.wordCount)
    if (mappedId === null) db.prepare("INSERT INTO project_sync_entity_map VALUES('draft',?,?)").run(record.id, String(created.lastInsertRowid))
  }
  for (const record of desired) for (const dependency of object(record.value).dependencies as Row[]) {
    const id = text(dependency.draftId)
    if (localId(db, 'draft', id) !== null) continue
    // A deleted source remains an identity plus its original prose hash, never a fabricated draft.
    const next = Number(db.prepare("SELECT MAX(value)+1 FROM (SELECT COALESCE(MAX(id),0) value FROM drafts UNION ALL SELECT COALESCE(MAX(CAST(local_key AS INTEGER)),0) FROM project_sync_entity_map WHERE kind='draft' UNION ALL SELECT COALESCE(MAX(seq),0) FROM sqlite_sequence WHERE name='drafts')").pluck().get())
    db.prepare("INSERT INTO project_sync_entity_map VALUES('draft',?,?)").run(id, String(next))
    if (!db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='drafts'").run(next).changes) db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('drafts',?)").run(next)
  }
  for (const record of desired) {
    const row = object(record.value), id = localId(db, 'draft', record.id)!
    const existing = db.prepare('SELECT d.*,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(id) as Row | undefined
    if (!existing) fail('DELETED_ENTITY_REUSED')
    if (existing.chapter_number !== row.chapterNumber
      || isReceiptedDraftStatus(String(existing.status)) && (
        !isReceiptedDraftStatus(String(row.status)) || existing.body !== row.content
        || existing.status === 'superseded' && row.status !== 'superseded'
      )) fail('IMMUTABLE_DRAFT')
    const priorReceipt = db.prepare('SELECT finalization_id,chapter_title,content_hash,content_revision,content_snapshot FROM finalization_outbox WHERE draft_id=?').get(id) as Row | undefined
    if (priorReceipt && (row.finalization === null || encode(priorReceipt) !== encode(object(row.finalization)))) fail('IMMUTABLE_FINALIZATION')
    const dependencies = (row.dependencies as Row[]).map(dependency => ({ ...dependency, draftId: localId(db, 'draft', text(dependency.draftId)) ?? fail('DEPENDENCY_MISSING') }))
    db.prepare('UPDATE contents SET body=? WHERE id=?').run(row.content, existing.content_id)
    db.prepare('UPDATE drafts SET status=?,source=?,word_count=?,source_dependencies=? WHERE id=?').run(row.status, row.source, row.wordCount, JSON.stringify(dependencies), id)
    if (row.finalization !== null) {
      const receipt = object(row.finalization)
      const prior = db.prepare('SELECT finalization_id,chapter_title,content_hash,content_revision,content_snapshot FROM finalization_outbox WHERE draft_id=?').get(id) as Row | undefined
      if (prior && encode(prior) !== encode(receipt)) fail('IMMUTABLE_FINALIZATION')
      if (!prior) insert(db, 'finalization_outbox', { ...receipt, draft_id: id, chapter_number: row.chapterNumber!, target_file_name: `synced-${hash(String(receipt.finalization_id))}.txt`, publication_status: 'synced-readonly' })
    }
  }
  const ids = new Set(desired.map(record => localId(db, 'draft', record.id)))
  for (const row of db.prepare('SELECT id FROM drafts').all() as { id: number }[]) if (!ids.has(row.id)) db.prepare('DELETE FROM drafts WHERE id=?').run(row.id)
  db.prepare('DELETE FROM chapter_finalization_heads').run()
  for (const record of records.filter(record => record.kind.startsWith('finalization:'))) {
    setAuthoritativeFinalizedDraft(db, Number(record.kind.slice(13)), localId(db, 'draft', text(object(record.value).draftId))!)
  }
  if (Number(db.pragma('user_version', { simple: true })) >= 10) {
    const selections = new Map(records.filter(record => record.kind === 'draft-selection').map(record => [Number(record.id), text(object(record.value).draftId)]))
    for (const chapter of new Set(desired.map(record => Number(object(record.value).chapterNumber)))) {
      const candidates = DraftRepository.listByChapter(chapter, db).filter(draft => (WORKING_DRAFT_STATUSES as readonly string[]).includes(draft.status) && !draft.dependenciesStale)
        .sort((left, right) => right.version - left.version || right.id - left.id)
      const selectedId = selections.get(chapter)
      if (!selectedId) {
        if (candidates.length > 1 && getAuthoritativeFinalizedDraftId(db, chapter) === null) fail('DRAFT_SELECTION_REQUIRED')
        continue
      }
      const selected = candidates.find(draft => draft.id === localId(db, 'draft', selectedId)), latest = candidates[0]
      if (!selected || !latest) fail('DRAFT_SELECTION_INVALID')
      if (selected.id !== latest.id) {
        // The temporary version cannot collide with a positive author version.
        // Only two unfinalized display versions move; prose and final receipts stay intact.
        const temporary = Math.min(0, ...DraftRepository.listByChapter(chapter, db).map(draft => draft.version)) - 1
        db.prepare('UPDATE drafts SET version=? WHERE id=?').run(temporary, selected.id)
        db.prepare('UPDATE drafts SET version=? WHERE id=?').run(selected.version, latest.id)
        db.prepare('UPDATE drafts SET version=? WHERE id=?').run(latest.version, selected.id)
      }
    }
  }
  applyNarrativePlans(db, records, id => localId(db, 'draft', id))
  applySelectedProjectAssets(db, records)
  const headChapters = new Set([...oldHeads.keys(), ...records.filter(record => record.kind.startsWith('finalization:')).map(record => Number(record.kind.slice(13)))])
  const changedChapters = [...headChapters].filter(chapter => getAuthoritativeFinalizedDraftId(db, chapter) !== (oldHeads.get(chapter) ?? null))
  if (changedChapters.length) invalidateContinuityProjectionFrom(db, Math.min(...changedChapters))
  for (const record of records.filter(record => record.kind.startsWith('history:'))) remember(db, record.kind, record.id, record.value)
  if ((db.pragma('foreign_key_check') as unknown[]).length) fail('FOREIGN_KEY_INVALID')
}

export function apply(database: Db, records: SyncRecord[]): void {
  database.transaction(() => applyInner(database, records))()
}
export function validateCandidate(database: Db, records: SyncRecord[]): void {
  const data = {
    nodes: records.filter(record => record.kind === 'story_nodes').map(record => record.value),
    edges: records.filter(record => record.kind === 'story_edges').map(record => record.value),
    routes: records.filter(record => record.kind === 'story_routes').map(record => record.value),
    notes: records.filter(record => record.kind === 'story_notes').map(record => record.value),
    revisions: records.filter(record => record.kind === 'story_node_revisions').map(record => record.value),
  }
  try { validateStoryData(data); StoryBranchRepository.assertProjectionMutation(database, data) } catch { fail('STORY_INVALID') }
}
export const projectSyncProjection = Object.freeze({ immutableKinds: ['story_node_revisions'] as const,
  legacyExtensionKinds: ['draft-selection', 'narrative-plan', 'project-asset'] as const, capture, validate, validateChanges,
  validateHistory: (batches: Parameters<typeof validateNarrativeHistory>[0]) => { validateNarrativeHistory(batches); validateProjectAssetHistory(batches) },
  validateLegacyImport, validateCandidate, apply })
export const compactProjectSyncProjection = Object.freeze({ ...projectSyncProjection, capture: captureCompact, apply: applyCompact })
