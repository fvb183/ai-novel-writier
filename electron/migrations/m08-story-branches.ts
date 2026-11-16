import { STORY_BRANCH_SQL } from '../services/story-branch-schema'
import type { MigrationImplementation, SchemaReader, SchemaWriter } from './registry'

export function createM08Migration(verify: (db: SchemaReader) => boolean): MigrationImplementation {
  return Object.freeze({ id: 'M08', from: 8, to: 9, owner: 'STORY',
    migrate: (db: SchemaWriter) => db.executeMigrationSql(STORY_BRANCH_SQL), verify })
}
