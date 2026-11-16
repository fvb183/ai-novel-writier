import type { MigrationImplementation, SchemaReader } from './registry'

/** Format gate for live chapter references. No existing author payload is rewritten. */
export function createM09Migration(verify: (db: SchemaReader) => boolean): MigrationImplementation {
  return Object.freeze({ id: 'M09', from: 9, to: 10, owner: 'STORY', migrate: () => {}, verify })
}
