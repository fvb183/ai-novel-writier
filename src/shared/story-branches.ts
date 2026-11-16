/** Author-owned story structure. Node identities are independent of chapter draft versions. */
export type StoryNodeKind = 'content' | 'branch' | 'merge'
/** Planning owned by this story node, independent of the main-line chapter table. */
export interface StoryChapterBlueprint {
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  suspenseHook: string
  userGuidance: string
  notes: string
}
/** Exact source facts frozen when a main-line chapter enters a story route. */
export interface StoryChapterSource {
  chapterNumber: number
  blueprintHash: string
  manuscriptHash: string
}
export interface StoryNodeInput {
  id: string
  kind: StoryNodeKind
  title: string
  chapterNumber: number | null
  event: string
  body: string
  chapterBlueprint?: StoryChapterBlueprint
  chapterSource?: StoryChapterSource
}
export interface StoryNode extends StoryNodeInput {
  revisionId: string
  /** Read-only live projection of canonical chapter facts; never stored in story_nodes. */
  mainline?: {
    chapterNumber: number
    manuscriptStatus: 'finalized' | 'draft' | 'unwritten' | 'missing' | 'unavailable'
    hasBlueprint: boolean
    /** Positive/negative manuscript evidence from current and historical draft rows. */
    hasManuscript?: boolean
  }
}
export interface StoryNodeRevision {
  id: string
  nodeId: string
  parentRevisionId: string | null
  node: StoryNodeInput
}
export interface StoryEdge { id: string; from: string; to: string; label: string; condition: string }
export interface StoryRoute { id: string; title: string; nodeIds: string[] }
export interface StoryNoteInput {
  id: string
  /** null means author-confirmed common continuity for a shared node. */
  routeId: string | null
  nodeId: string
  summary: string
  characterStates: string
  entryDifferences: string
}
export interface StoryNote extends StoryNoteInput { sourceHash: string; confirmed: boolean }
export interface StorySnapshot {
  revision: string
  nodes: StoryNode[]
  edges: StoryEdge[]
  routes: StoryRoute[]
  notes: StoryNote[]
  revisions: StoryNodeRevision[]
  /** Read-only compatibility aliases. Stored UUID records and history remain unchanged. */
  aliases?: StoryProjectionAliases
}
export interface StoryProjectionAliases {
  nodes: Record<string, string>
  routes: Record<string, string>
  edges: Record<string, string>
  /** Original stored routes affected by editing a folded source UUID; duplicate titles preserve route count. */
  affectedRoutes?: Record<string, string[]>
}
export const resolveStoryNodeAlias = (snapshot: Pick<StorySnapshot, 'aliases'>, id: string): string => snapshot.aliases?.nodes[id] ?? id
export const resolveStoryRouteAlias = (snapshot: Pick<StorySnapshot, 'aliases'>, id: string): string => snapshot.aliases?.routes[id] ?? id
export const resolveStoryEdgeAlias = (snapshot: Pick<StorySnapshot, 'aliases'>, id: string): string => snapshot.aliases?.edges[id] ?? id
export type StoryOperation =
  | { type: 'put-node'; node: StoryNodeInput }
  | { type: 'delete-node'; id: string }
  | { type: 'restore-node'; id: string; revisionId: string }
  | { type: 'put-edge'; edge: StoryEdge }
  | { type: 'delete-edge'; id: string }
  | { type: 'put-route'; route: StoryRoute }
  | { type: 'delete-route'; id: string }
  | { type: 'put-note'; note: StoryNoteInput; expectedSourceHash: string; confirm: boolean }
  | { type: 'delete-note'; id: string }
export interface StoryContextRequest {
  nodeId: string
  routeId: string | null
  mode: 'route' | 'shared'
  /** Optional explicit later node to satisfy as a future bridge, never past fact. */
  bridgeToNodeId?: string
}
export interface StoryContext {
  request: StoryContextRequest
  /** Relevant graph and prose before the target; excludes the target body and note itself. */
  sourceHash: string
  /** Includes confirmed continuity and target content for generation/commit guards. */
  contextHash: string
  target: StoryNode
  prefix: StoryNode[]
  entrances: { routeId: string; title: string; nodeIds: string[] }[]
  note: StoryNote | null
  noteCurrent: boolean
  readyForGeneration: boolean
  /** Only the explicitly selected directly linked future node, not its descendants. */
  continuation?: { node: StoryNode; edge: StoryEdge }
}
export type StoryResponse<T> = { success: true; data: T } | { success: false; error: string }

export const MAINLINE_STORY_ROUTE_ID = 'mainline'
export function mainlineStoryNodeId(chapterNumber: number): string {
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1 || chapterNumber > 100_000) throw new Error('STORY_INPUT_INVALID')
  return `chapter:${chapterNumber}`
}
export const isMainlineStoryNodeId = (value: unknown): value is string => typeof value === 'string' && /^chapter:(?:[1-9][0-9]{0,4}|100000)$/.test(value)
export const mainlineStoryChapterNumber = (value: string): number | null => isMainlineStoryNodeId(value) ? Number(value.slice(8)) : null
export const isMainlineStoryNode = (value: string | { id: string }): boolean => isMainlineStoryNodeId(typeof value === 'string' ? value : value.id)
export const isMainlineStoryRouteId = (value: unknown): boolean => value === MAINLINE_STORY_ROUTE_ID
export const isMainlineStoryRoute = (value: string | { id: string }): boolean => isMainlineStoryRouteId(typeof value === 'string' ? value : value.id)
export const mainlineStoryEdgeId = (from: string, to: string): string => `mainline:${from}>${to}`
export const isMainlineStoryEdgeId = (value: unknown): boolean => typeof value === 'string' && /^mainline:chapter:(?:[1-9][0-9]{0,4}|100000)>chapter:(?:[1-9][0-9]{0,4}|100000)$/.test(value)
export const isMainlineStoryEdge = (value: string | { id: string }): boolean => isMainlineStoryEdgeId(typeof value === 'string' ? value : value.id)
