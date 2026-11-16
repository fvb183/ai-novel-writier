import type { MigrationImplementation, SchemaReader, SchemaWriter } from './registry'
export const COMPACT_SYNC_SQL = `
CREATE TABLE project_sync_compact_meta (
 id INTEGER PRIMARY KEY CHECK(id=1),
 clock_json TEXT NOT NULL,
 pending_clock_json TEXT NOT NULL
);
CREATE TABLE project_sync_compact_records (
 kind TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 accepted INTEGER NOT NULL CHECK(accepted IN (0,1)),
 heads_json TEXT NOT NULL,
 PRIMARY KEY(kind,entity_id,accepted)
);
`
export function createM12Migration(verify: (db: SchemaReader) => boolean): MigrationImplementation {
  return Object.freeze({ id: 'M12', from: 11, to: 12, owner: 'SYNC', migrate: (db: SchemaWriter) => db.executeMigrationSql(COMPACT_SYNC_SQL), verify })
}
