import { CURRENT_DRAFT_STATUS_SQL, WORKING_DRAFT_STATUSES, CURRENT_DRAFT_STATUSES } from '../../src/shared/draft-status'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DraftRepository } from '../repositories/draft-repository'
import { ContentRepository } from '../repositories/content-repository'
import { getAuthoritativeFinalizedDraftId } from './finalized-draft-head'
import { MAINLINE_STORY_ROUTE_ID, isMainlineStoryNodeId, mainlineStoryChapterNumber, mainlineStoryEdgeId, mainlineStoryNodeId,
  type StoryChapterBlueprint, type StoryEdge, type StoryNode, type StoryRoute } from '../../src/shared/story-branches'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const exists = (db: Database.Database, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
function blueprint(row: Record<string, unknown> | undefined): StoryChapterBlueprint | undefined {
  if (!row) return undefined
  const text = (key: string) => { const value = row[key]; if (value !== null && typeof value !== 'string') throw new Error('STORY_CHAPTER_SOURCE_INVALID'); return value ?? '' }
  const characters = JSON.parse(String(row.characters ?? '[]')) as unknown
  if (!Array.isArray(characters) || characters.some(value => typeof value !== 'string')) throw new Error('STORY_CHAPTER_SOURCE_INVALID')
  return { title: String(text('title')), role: String(text('role')), purpose: String(text('purpose')), keyEvents: String(text('key_events')),
    characters: characters as string[], suspenseHook: String(text('suspense_hook')), userGuidance: String(text('user_guidance')), notes: String(text('notes')) }
}
export function missingMainlineStoryNode(id: string, status: 'missing' | 'unavailable' = 'missing', hasBlueprint = false): StoryNode {
  const chapterNumber = mainlineStoryChapterNumber(id)!
  return { id, kind: 'content', title: `第 ${chapterNumber} 章（来源${status === 'missing' ? '缺失' : '不可用'}）`, chapterNumber,
    body: '', event: '', revisionId: `mainline:${status}:${chapterNumber}`, mainline: { chapterNumber, manuscriptStatus: status, hasBlueprint } }
}
/** This reads authoritative tables every time; it never copies or updates author facts. */
export function readMainlineStoryNodes(db: Database.Database): StoryNode[] {
  const hasBlueprints = exists(db, 'blueprints'), hasDrafts = exists(db, 'drafts')
  if (!hasBlueprints && !hasDrafts) return []
  const queries = [hasBlueprints ? 'SELECT chapter_number FROM blueprints' : '',
    hasDrafts ? `SELECT chapter_number FROM drafts WHERE status IN (${CURRENT_DRAFT_STATUS_SQL})` : ''].filter(Boolean)
  const numbers = db.prepare(`${queries.join(' UNION ')} ORDER BY chapter_number`).pluck().all() as number[]
  return numbers.filter(number => Number.isSafeInteger(number) && number >= 1 && number <= 100_000).map(chapterNumber => {
    const id = mainlineStoryNodeId(chapterNumber)
    const row = hasBlueprints ? db.prepare('SELECT title,role,purpose,key_events,characters,suspense_hook,user_guidance,notes FROM blueprints WHERE chapter_number=?').get(chapterNumber) as Record<string, unknown> | undefined : undefined
    const manuscripts = hasDrafts ? db.prepare('SELECT c.body FROM drafts d LEFT JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=?').all(chapterNumber) as { body: string | null }[] : []
    if (!row && manuscripts.length && manuscripts.every(manuscript => typeof manuscript.body === 'string' && !manuscript.body.trim())) return null
    const hasManuscript = manuscripts.some(manuscript => typeof manuscript.body === 'string' && manuscript.body.trim())
    try {
      const planning = blueprint(row), drafts = hasDrafts ? DraftRepository.listByChapter(chapterNumber, db) : []
      const finalId = hasDrafts ? getAuthoritativeFinalizedDraftId(db, chapterNumber) : null
      const selected = finalId === null ? [...drafts].filter(draft => (WORKING_DRAFT_STATUSES as readonly string[]).includes(draft.status) && !draft.dependenciesStale)
        .sort((left, right) => right.version - left.version || right.id - left.id)[0]
        : drafts.find(draft => draft.id === finalId && draft.authoritativeFinalized && !draft.dependenciesStale)
      if (finalId !== null && !selected || !selected && drafts.some(draft => (CURRENT_DRAFT_STATUSES as readonly string[]).includes(draft.status))) throw new Error('STORY_CHAPTER_SOURCE_INVALID')
      const body = selected ? ContentRepository.getBody(selected.contentId, db) : ''
      if (body === null || selected?.status === 'finalized' && !body.trim()) throw new Error('STORY_CHAPTER_SOURCE_INVALID')
      if (selected?.status === 'finalized') {
        const receipt = db.prepare('SELECT chapter_number,content_hash,content_snapshot FROM finalization_outbox WHERE draft_id=?').get(selected.id) as
          { chapter_number: number; content_hash: string; content_snapshot: string } | undefined
        if (receipt && (receipt.chapter_number !== chapterNumber || receipt.content_snapshot !== body
          || receipt.content_hash !== createHash('sha256').update(body).digest('hex'))) throw new Error('STORY_CHAPTER_SOURCE_INVALID')
      }
      const mainline: NonNullable<StoryNode['mainline']> = { chapterNumber, manuscriptStatus: selected?.status === 'finalized' ? 'finalized' : body.trim() ? 'draft' : 'unwritten', hasBlueprint: Boolean(planning), hasManuscript }
      return { id, kind: 'content' as const, title: planning?.title.trim() || selected?.chapterTitle || `第 ${chapterNumber} 章`, chapterNumber,
        event: '', body, ...(planning ? { chapterBlueprint: planning } : {}), mainline,
        revisionId: `mainline:${digest({ chapterNumber, planning: planning ?? null, selected: selected ? { status: selected.status, source: selected.source, finalizationId: selected.finalizationId ?? null } : null, body })}` }
    } catch { return missingMainlineStoryNode(id, 'unavailable', Boolean(row)) }
  }).filter((node): node is StoryNode => node !== null)
}
export function mainlineStoryEdges(nodes: readonly StoryNode[]): StoryEdge[] {
  return nodes.slice(1).map((node, index) => ({ id: mainlineStoryEdgeId(nodes[index].id, node.id), from: nodes[index].id, to: node.id, label: '', condition: '' }))
}
export function mainlineStoryRoute(nodes: readonly StoryNode[]): StoryRoute | null {
  return nodes.length ? { id: MAINLINE_STORY_ROUTE_ID, title: '主线', nodeIds: nodes.map(node => node.id) } : null
}
/** Store live anchors rather than a copy of every earlier/later chapter identity. */
export function compactMainlineStoryPath(nodeIds: readonly string[], mainline: readonly StoryNode[] = []): string[] {
  for (let offset = 1; offset < nodeIds.length; offset++) {
    const prior = mainlineStoryChapterNumber(nodeIds[offset - 1]), next = mainlineStoryChapterNumber(nodeIds[offset])
    if (prior !== null && next !== null && prior >= next) throw new Error('STORY_ROUTE_DISCONNECTED')
  }
  if (nodeIds.every((id): boolean => isMainlineStoryNodeId(id))) return [...nodeIds]
  const canonical = mainline.map(node => node.id)
  let result = [...nodeIds], prefix = 0
  while (prefix < result.length && isMainlineStoryNodeId(result[prefix])) prefix++
  if (prefix > 1) {
    const anchor = mainlineStoryChapterNumber(result[prefix - 1])!
    const expected = canonical.filter(id => mainlineStoryChapterNumber(id)! <= anchor)
    if (JSON.stringify(result.slice(0, prefix)) === JSON.stringify(expected)) result = result.slice(prefix - 1)
  }
  let tail = result.length - 1
  while (tail >= 0 && isMainlineStoryNodeId(result[tail])) tail--
  if (tail >= 0 && tail < result.length - 2) {
    const anchor = mainlineStoryChapterNumber(result[tail + 1])!
    const expected = canonical.filter(id => mainlineStoryChapterNumber(id)! >= anchor)
    if (JSON.stringify(result.slice(tail + 1)) === JSON.stringify(expected)) result = result.slice(0, tail + 2)
  }
  return result
}
/** Only the leading main-line anchor and an explicit return gain live prefix/tail. */
export function resolveMainlineStoryPath(nodeIds: readonly string[], nodes: readonly StoryNode[]): string[] {
  const canonical = nodes.map(node => node.id), path = [...nodeIds]
  if (!path.length) return path
  if (path.every((id): boolean => isMainlineStoryNodeId(id))) return path
  // One canonical endpoint denotes a live anchor. Longer explicit runs retain skips.
  const first = isMainlineStoryNodeId(path[1]) ? null : mainlineStoryChapterNumber(path[0])
  const prefix = first === null ? [] : canonical.filter(id => mainlineStoryChapterNumber(id)! <= first)
  if (first !== null && !prefix.includes(path[0])) prefix.push(path[0])
  let result = first === null ? [...path] : [...prefix, ...path.slice(1)]
  if (path.length > 1 && isMainlineStoryNodeId(path.at(-1)) && !isMainlineStoryNodeId(path.at(-2))) {
    const last = mainlineStoryChapterNumber(path.at(-1)!)!
    result = [...result, ...canonical.filter(id => mainlineStoryChapterNumber(id)! > last)]
  }
  return result
}
