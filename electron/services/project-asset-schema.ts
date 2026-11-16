/** M10 adds selected author manifests and a local, restartable materialization journal. */
export const PROJECT_ASSET_SQL = `
CREATE TABLE project_author_assets (
  asset_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);
CREATE TABLE project_asset_local_state (
  asset_id TEXT PRIMARY KEY,
  materialized_json TEXT
);
`
