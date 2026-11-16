/** Author data installed by M08. UUIDs and payloads are portable across replicas. */
export const STORY_TABLES = ['story_nodes', 'story_edges', 'story_routes', 'story_notes', 'story_node_revisions'] as const
export const STORY_BRANCH_SQL = STORY_TABLES.map(table => `CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL, payload_json TEXT NOT NULL);`).join('\n')
