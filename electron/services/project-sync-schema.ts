/** Installed only by M07, never lazily on an existing project. */
export const PROJECT_SYNC_SQL = `
CREATE TABLE project_sync_meta (
  id INTEGER PRIMARY KEY CHECK(id=1),
  project_id TEXT NOT NULL,
  replica_id TEXT NOT NULL
);
CREATE TABLE project_sync_batches (
  batch_id TEXT PRIMARY KEY,
  replica_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  hash TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  accepted INTEGER NOT NULL CHECK(accepted IN (0,1)),
  UNIQUE(replica_id,sequence)
);
CREATE TABLE project_sync_acknowledgements (
  peer_replica_id TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES project_sync_batches(batch_id),
  PRIMARY KEY(peer_replica_id,batch_id)
);
CREATE TABLE project_sync_entity_map (
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_key TEXT NOT NULL,
  PRIMARY KEY(kind,entity_id),
  UNIQUE(kind,local_key)
);
CREATE TABLE project_sync_history (
  origin_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE chapter_finalization_heads (
  chapter_number INTEGER PRIMARY KEY CHECK(chapter_number>0),
  draft_id INTEGER NOT NULL UNIQUE REFERENCES drafts(id) ON DELETE CASCADE
);
INSERT INTO chapter_finalization_heads(chapter_number,draft_id)
SELECT d.chapter_number,d.id FROM drafts d WHERE d.status='finalized' AND NOT EXISTS (
  SELECT 1 FROM drafts newer WHERE newer.chapter_number=d.chapter_number AND newer.status='finalized'
  AND (newer.version>d.version OR (newer.version=d.version AND newer.id>d.id))
);
`
