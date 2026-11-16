import { PROJECT_SYNC_SQL } from '../services/project-sync-schema'
import type { MigrationImplementation, SchemaReader, SchemaWriter } from './registry'

export function createM07Migration(verify: (db: SchemaReader) => boolean): MigrationImplementation {
  return Object.freeze({ id: 'M07', from: 7, to: 8, owner: 'SYNC',
    migrate: (db: SchemaWriter) => db.executeMigrationSql(PROJECT_SYNC_SQL), verify })
}
