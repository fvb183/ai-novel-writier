import { PROJECT_ASSET_SQL } from '../services/project-asset-schema'
import type { MigrationImplementation, SchemaReader, SchemaWriter } from './registry'
export function createM10Migration(verify: (db: SchemaReader) => boolean): MigrationImplementation {
  return Object.freeze({ id: 'M10', from: 10, to: 11, owner: 'SYNC',
    migrate: (db: SchemaWriter) => db.executeMigrationSql(PROJECT_ASSET_SQL), verify })
}
