import { parseProjectAuthorAsset, type ProjectAuthorAsset } from '../../src/shared/project-sync-assets'
import type { SyncJson } from '../../src/shared/project-sync'

/** Tables whose saved values determine the portable author projection. Runtime
 * jobs, diagnostics, review reports, summaries and vector indexes stay local. */
export const PROJECT_SYNC_AUTHOR_TABLES: ReadonlySet<string> = new Set([
  'project_core', 'blueprints', 'contents', 'drafts', 'finalization_outbox', 'chapter_finalization_heads',
  'characters', 'character_identity_approvals', 'character_identity_origins', 'character_aliases',
  'character_identity_proposals', 'character_relationships', 'character_identity_meta',
  'character_roster_meta', 'character_roster_operations',
  'story_nodes', 'story_edges', 'story_routes', 'story_notes', 'story_node_revisions',
  'narrative_thread_plans', 'narrative_thread_confirmations', 'project_author_assets',
])

/** Skills/prompts are local configuration. Keep old causal manifests frozen,
 * rather than converting an upgrade or missing local file into an author delete. */
export function isContinuousProjectAsset(asset: ProjectAuthorAsset): boolean {
  return asset.category !== 'files' || asset.group === 'skill-bindings' || asset.group === 'author-content'
    && ['partial_arch', 'partial_arch.json'].includes(asset.logicalName)
}

/** Full project archives retain their complete asset allowlist. Normal saved
 * content sync never walks prompt/Skill directories or generated creation logs. */
export const CONTINUOUS_RAW_PROJECT_ASSETS = ['partial_arch', 'partial_arch.json', 'writing-skills.json'] as const

/** Compact sync retains current author values and unresolved alternatives,
 * without carrying old machine observations or device-local configuration. */
export function isCompactAuthorRecord(kind: string, _id: string, value: SyncJson): boolean {
  if (kind.startsWith('history:')) return false
  return kind !== 'project-asset' || isContinuousProjectAsset(parseProjectAuthorAsset(value))
}
