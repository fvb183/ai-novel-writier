import { PROJECT_SYNC_AUTHOR_TABLES } from './project-sync-scope'

/** Tables containing execution state or reproducible indexes rather than
 * portable author decisions. Unknown/new tables remain conservative. */
const LOCAL_TABLES = new Set([
  'generation_roots', 'generation_runs', 'generation_attempts', 'generation_artifacts',
  'reviews', 'revisions', 'review_cycles', 'review_findings', 'review_cycle_merges',
  'post_process_runs', 'post_process_steps', 'llm_calls', 'summary_snapshots',
  'continuity_projection_meta', 'consistency_exemptions', 'recovery_candidates',
  'chapter_deletion_operations', 'finalized_draft_import_operations', 'import_global_fact_operations',
  'import_runs', 'import_run_chapters', 'import_run_sources', 'import_run_source_chapters',
  'import_legacy_identity_bridge', 'import_source_aliases', 'import_source_chapter_map',
  'import_run_receipts', 'import_run_knowledge_receipts', 'import_reference_documents', 'import_effect_ledger',
  'project_asset_local_state', 'blueprint_character_sync_operations',
])

export function isPortableProjectMutation(sql: string): boolean {
  const code = sql.replace(/'(?:''|[^'])*'/g, "''").replace(/--[^\r\n]*|\/\*[\s\S]*?\*\//g, ' ')
  // DDL/triggers may affect author tables indirectly; never skip them.
  if (/\b(?:CREATE|ALTER|DROP)\b/i.test(code)) return true
  const targets = [...code.matchAll(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+((?:["`\[]?[a-z_][\w]*["`\]]?\s*\.\s*)?["`\[]?[a-z_][\w]*["`\]]?)/gi)]
  if (!targets.length) return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(code)
  return targets.some(match => {
    const table = match[1]!.split('.').at(-1)!.replace(/["`\[\]\s]/g, '').toLowerCase()
    if (table === 'set' && /\bDO\s*$/i.test(code.slice(0, match.index))) return false
    if (!PROJECT_SYNC_AUTHOR_TABLES.has(table) && LOCAL_TABLES.has(table)) return false
    if (table === 'project_core' && /^UPDATE\b/i.test(match[0])) {
      const rest = code.slice(match.index! + match[0].length)
      const assignments = /^\s+SET\s+([\s\S]*?)(?:\bWHERE\b|;|$)/i.exec(rest)?.[1]
      const names = assignments?.split(',').map(item => /^\s*["`\[]?(\w+)["`\]]?\s*=/.exec(item)?.[1]?.toLowerCase())
      if (names?.length && names.every(name => name === 'character_states' || name === 'plot_tree_snapshot')) return false
    }
    return true
  })
}

