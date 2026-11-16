import type Database from 'better-sqlite3'

/** Stable confirmation order is derived replica metadata, not a local integer-id assumption. */
export function narrativeEventOrder(db: Database.Database): Map<number, number> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_sync_entity_map'").get()) return new Map()
  const rows = db.prepare(`SELECT event.local_key AS localId, position.local_key AS position FROM project_sync_entity_map event
    JOIN project_sync_entity_map position ON position.entity_id=event.entity_id AND position.kind='narrative-event-order'
    WHERE event.kind='narrative-event'`).all() as { localId: string; position: string }[]
  return new Map(rows.flatMap(row => {
    const rank = Number(row.position.slice(row.position.lastIndexOf(':') + 1)), id = Number(row.localId)
    return Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(rank) && rank > 0 ? [[id, rank] as const] : []
  }))
}
export function compareNarrativeEvents(left: { id: number }, right: { id: number }, order: Map<number, number>): number {
  const a = order.get(left.id), b = order.get(right.id)
  if (a !== undefined && b === undefined) return -1
  if (a === undefined && b !== undefined) return 1
  return (a ?? left.id) - (b ?? right.id) || left.id - right.id
}
