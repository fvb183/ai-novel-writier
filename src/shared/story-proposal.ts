import type { StoryContext, StoryContextRequest, StoryOperation, StorySnapshot } from './story-branches'
import { MAINLINE_STORY_ROUTE_ID, isMainlineStoryEdgeId, isMainlineStoryNodeId } from './story-branches'

function fail(code: string): never { throw new Error(code) }
const plain = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) ? value as Record<string, unknown> : fail('STORY_PROPOSAL_INVALID')
const same = (left: StoryContextRequest | undefined, right: StoryContextRequest | undefined) => left === right || Boolean(left && right
  && left.nodeId === right.nodeId && left.routeId === right.routeId && left.mode === right.mode && left.bridgeToNodeId === right.bridgeToNodeId)
const kinds = ['put-node', 'delete-node', 'restore-node', 'put-edge', 'delete-edge', 'put-route', 'delete-route', 'put-note', 'delete-note']
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? 'undefined'

export interface StoryProposal {
  operations: StoryOperation[]
  request?: StoryContextRequest
  affectsSharedContent: boolean
  writesProse: boolean
  affectedRoutes: string[]
}

/** Pure review projection. Main repeats validation and supplies every revision/hash itself. */
export function prepareStoryProposal(args: Record<string, unknown>, snapshot: StorySnapshot,
  scopeRequest?: StoryContextRequest, context?: StoryContext): StoryProposal {
  if (Object.keys(args).some(key => !['operations', 'context'].includes(key))
    || !Array.isArray(args.operations) || !args.operations.length || args.operations.length > 100
    || JSON.stringify(args.operations).length > 2 * 1024 * 1024) fail('STORY_PROPOSAL_INVALID')
  const request = args.context === undefined ? scopeRequest : plain(args.context) as unknown as StoryContextRequest
  if (scopeRequest && !same(request, scopeRequest)) fail('STORY_CONTEXT_SCOPE_MISMATCH')
  const affected = new Set<string>()
  let bodyChanged = false, shared = false
  const operations = args.operations.map(value => {
    const operation = plain(value)
    if (typeof operation.type !== 'string' || !kinds.includes(operation.type)) fail('STORY_PROPOSAL_INVALID')
    const op = structuredClone(operation) as unknown as StoryOperation
    if (op.type === 'put-node' || op.type === 'restore-node' || op.type === 'delete-node') {
      const nodeId = op.type === 'put-node' ? plain(op.node).id : op.id
      if (typeof nodeId !== 'string') fail('STORY_PROPOSAL_INVALID')
      if (isMainlineStoryNodeId(nodeId)) fail('STORY_MAINLINE_READ_ONLY')
      const previous = snapshot.nodes.find(node => node.id === nodeId)
      if (op.type === 'put-node' && previous) {
        // Model tools describe changed prose, not provenance replacement. Missing
        // optional author metadata must not erase the imported chapter binding.
        if (!Object.hasOwn(op.node, 'chapterBlueprint') && previous.chapterBlueprint) op.node.chapterBlueprint = structuredClone(previous.chapterBlueprint)
        if (!Object.hasOwn(op.node, 'chapterSource') && previous.chapterSource) op.node.chapterSource = structuredClone(previous.chapterSource)
      }
      const candidate = op.type === 'put-node' ? op.node : op.type === 'restore-node'
        ? snapshot.revisions.find(row => row.id === op.revisionId)?.node : undefined
      if (candidate && canonical(candidate.chapterSource) !== canonical(previous?.chapterSource)) fail('STORY_CHAPTER_SOURCE_READ_ONLY')
      const routes = snapshot.routes.filter(route => route.nodeIds.includes(nodeId))
      routes.forEach(route => affected.add(route.title))
      if (routes.length > 1) shared = true
      const changesBody = op.type === 'restore-node'
        || op.type === 'put-node' && (typeof op.node.body !== 'string' || op.node.body !== (previous?.body ?? '')
          || previous !== undefined && op.node.event !== previous.event)
      if (changesBody) {
        bodyChanged = true
        // New prose needs an existing, author-selected path. Empty structural nodes are allowed.
        if (!previous || !scopeRequest || !context?.readyForGeneration || !same(context.request, request)
          || context.target.id !== nodeId) fail('STORY_ROUTE_CONTEXT_REQUIRED')
        const prefixes = new Set(routes.map(route => JSON.stringify(route.nodeIds.slice(0, route.nodeIds.indexOf(nodeId)))))
        if (prefixes.size > 1 && context.request.mode !== 'shared') fail('STORY_SHARED_CONTEXT_REQUIRED')
        if (candidate && canonical(candidate.chapterBlueprint) !== canonical(previous?.chapterBlueprint)) fail('STORY_BLUEPRINT_SEPARATE_PROPOSAL')
        if (op.type === 'put-node' && previous && op.node.body !== previous.body && (previous.chapterBlueprint || previous.chapterSource)
          && (op.node.title !== previous.title || op.node.kind !== previous.kind || op.node.chapterNumber !== previous.chapterNumber || op.node.event !== previous.event)) fail('STORY_CHAPTER_PROSE_ONLY')
      }
    }
    if ((op.type === 'put-route' ? op.route?.id : op.type === 'delete-route' ? op.id : undefined) === MAINLINE_STORY_ROUTE_ID
      || isMainlineStoryEdgeId(op.type === 'put-edge' ? op.edge?.id : op.type === 'delete-edge' ? op.id : undefined)) fail('STORY_MAINLINE_READ_ONLY')
    if (op.type === 'put-note') {
      if (!request || !context || !same(context.request, request)
        || op.note?.nodeId !== request.nodeId || op.note?.routeId !== request.routeId
        || operation.confirm === true) fail('STORY_AUTHOR_CONFIRMATION_REQUIRED')
      // Generated notes are candidates. Only the separate author UI can establish them as facts.
      return { type: 'put-note', note: structuredClone(op.note), expectedSourceHash: context.sourceHash, confirm: false } as StoryOperation
    }
    return op
  })
  if (bodyChanged && operations.length !== 1) fail('STORY_PROSE_REQUIRES_SEPARATE_PROPOSAL')
  return { operations, ...(request ? { request: structuredClone(request) } : {}), affectsSharedContent: shared, writesProse: bodyChanged, affectedRoutes: [...affected].sort() }
}
