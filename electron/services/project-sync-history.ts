import { createHash } from 'node:crypto'
import type { SyncJson, SyncRecord } from '../../src/shared/project-sync'
import policy from './portable-project-field-policy.json'

function fail(): never { throw new Error('PROJECT_SYNC_HISTORY_INVALID') }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail()
}
function keys(row: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(row).sort().join('\u0000') !== [...expected].sort().join('\u0000')) fail()
}
function scalarRows(table: string, values: unknown): void {
  if (!Array.isArray(values)) fail()
  const columns = Object.keys((policy.tables as Record<string, Record<string, string>>)[table]!).filter(key => !['created_at', 'updated_at', 'content_id'].includes(key))
  for (const value of values) {
    const row = object(value); keys(row, columns)
    if (Object.values(row).some(v => v !== null && typeof v !== 'string' && typeof v !== 'number' || typeof v === 'number' && !Number.isFinite(v))) fail()
  }
}

/** Only data-only historical evidence is admissible; no runtime bindings, lease or provider fields. */
export function validateSyncHistoryRecord(record: SyncRecord): void {
  if (!/^[a-z0-9:-]{1,128}$/i.test(record.id)) fail()
  if (record.kind === 'history:plot') { if (typeof record.value !== 'string') fail(); return }
  const row = object(record.value)
  if (record.kind === 'history:reviews' || record.kind === 'history:revisions') {
    keys(row, ['original', 'references', 'content'])
    if (typeof row.content !== 'string') fail()
    scalarRows(record.kind.slice(8), [row.original])
    const refs = object(row.references)
    keys(refs, record.kind === 'history:reviews' ? ['baseDraftId'] : ['baseDraftId', 'mergedToDraftId', 'reviewSourceId'])
    if (Object.values(refs).some(v => v !== null && (typeof v !== 'string' || !/^[a-z0-9:-]{1,128}$/i.test(v)))) fail()
  } else if (record.kind === 'history:narrative') {
    keys(row, ['plans', 'events'])
    scalarRows('narrative_thread_plans', row.plans); scalarRows('narrative_thread_confirmations', row.events)
  } else if (record.kind === 'history:generation') {
    keys(row, ['createdAtMs', 'observedStatus', 'readOnly'])
    if (row.readOnly !== true || !Number.isSafeInteger(row.createdAtMs) || Number(row.createdAtMs) < 0
      || !['running', 'paused', 'completed', 'failed', 'cancelled', 'unknown'].includes(String(row.observedStatus))) fail()
  } else fail()
}

export function validateStoredSyncHistory(row: { origin_key: string; payload_json: string; content_hash: string }): SyncRecord {
  if (createHash('sha256').update(row.payload_json).digest('hex') !== row.content_hash) fail()
  const [kind, id, ...extra] = row.origin_key.split('\u0000')
  if (!kind || !id || extra.length) fail()
  let value: SyncJson
  try { value = JSON.parse(row.payload_json) as SyncJson } catch { return fail() }
  const record = { kind, id, value }
  validateSyncHistoryRecord(record)
  return record
}
