import { MAINLINE_STORY_ROUTE_ID, type StoryNodeInput, type StoryOperation, type StoryRoute, type StorySnapshot } from '../../shared/story-branches'

/** A tree gesture is staged as one batch; only the normal save flow persists it. */
export interface StoryTreePlan {
  operations: StoryOperation[]
  selectedNodeId?: string
  selectedRouteId?: string
  selectedEdgeId?: string
  error?: string
}

const limits = { nodes: 1000, edges: 4000, routes: 256, revisions: 20_000, routeLength: 1000 }
const rejected = (error: string): StoryTreePlan => ({ operations: [], error })
const validTitle = (title: string) => Boolean(title.trim()) && title.length <= 200 && !title.includes('\0')
const exists = (snapshot: StorySnapshot, nodeId: string) => snapshot.nodes.some(node => node.id === nodeId)
const emptyNode = (title: string, kind: StoryNodeInput['kind'] = 'content'): StoryNodeInput => ({
  id: crypto.randomUUID(), kind, title, chapterNumber: null, event: '', body: '',
  chapterBlueprint: { title, role: '发展', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '', notes: '' },
})
function capacity(snapshot: StorySnapshot, nodes: number, edges: number, routes: number): boolean {
  return snapshot.nodes.length + nodes <= limits.nodes && snapshot.edges.length + edges <= limits.edges
    && snapshot.routes.length + routes <= limits.routes && snapshot.revisions.length + nodes <= limits.revisions
}
function chosenRoute(snapshot: StorySnapshot, nodeId: string, routeId: string | null): StoryRoute | undefined {
  return routeId ? snapshot.routes.find(route => route.id === routeId && route.nodeIds.includes(nodeId)) : undefined
}

/**
 * A selected route is the author's choice of earlier events. Without one, only
 * a genuinely unambiguous prefix can become a new writing route.
 */
function routePrefix(snapshot: StorySnapshot, nodeId: string, routeId: string | null): string[] | null {
  if (routeId) {
    const route = chosenRoute(snapshot, nodeId, routeId)
    return route ? route.nodeIds.slice(0, route.nodeIds.indexOf(nodeId) + 1) : null
  }
  const prefixes = new Map<string, string[]>()
  for (const route of snapshot.routes) {
    const index = route.nodeIds.indexOf(nodeId)
    if (index < 0) continue
    const prefix = route.nodeIds.slice(0, index + 1)
    prefixes.set(JSON.stringify(prefix), prefix)
  }
  if (prefixes.size === 1) return [...prefixes.values()][0]
  if (prefixes.size > 1) return null

  // A DAG with several incoming edges has several possible pasts. Do not pick
  // one according to node IDs or rendering order merely to make a route.
  const parents = new Map<string, Set<string>>()
  for (const edge of snapshot.edges) {
    const incoming = parents.get(edge.to) ?? new Set<string>()
    incoming.add(edge.from); parents.set(edge.to, incoming)
  }
  const prefix = [nodeId], visited = new Set(prefix)
  let current = nodeId
  while (parents.get(current)?.size) {
    const incoming = parents.get(current)!
    if (incoming.size !== 1) return null
    const previous = [...incoming][0]
    if (!exists(snapshot, previous) || visited.has(previous)) return null
    visited.add(previous); prefix.unshift(previous); current = previous
  }
  return prefix
}

/** Continue a chosen route only at its endpoint; interior insertion is never implicit. */
export function planContinue(snapshot: StorySnapshot, nodeId: string, routeId: string | null, title: string): StoryTreePlan {
  if (!exists(snapshot, nodeId)) return rejected('STORY_NODE_NOT_FOUND')
  if (!validTitle(title)) return rejected('STORY_INPUT_INVALID')
  const route = chosenRoute(snapshot, nodeId, routeId)
  if (routeId && !route) return rejected('STORY_ROUTE_NODE_MISMATCH')
  if (!capacity(snapshot, 1, 1, 0)) return rejected('STORY_SIZE_LIMIT')
  if (route?.nodeIds.at(-1) === nodeId && route.nodeIds.length >= limits.routeLength) return rejected('STORY_SIZE_LIMIT')
  const node = emptyNode(title), edge = { id: crypto.randomUUID(), from: nodeId, to: node.id, label: '', condition: '' }
  const operations: StoryOperation[] = [{ type: 'put-node', node }, { type: 'put-edge', edge }]
  if (route?.nodeIds.at(-1) === nodeId) operations.push({ type: 'put-route', route: { ...route, nodeIds: [...route.nodeIds, node.id] } })
  return { operations, selectedNodeId: node.id, selectedEdgeId: edge.id, selectedRouteId: route?.nodeIds.at(-1) === nodeId ? route.id : '' }
}

/** Continuing from the middle opens an alternate path without losing the existing future. */
export function planContinueRoute(snapshot: StorySnapshot, nodeId: string, routeId: string | null, title: string): StoryTreePlan {
  const result = planContinue(snapshot, nodeId, routeId, title)
  if (result.error || result.selectedRouteId) return result
  const prefix = routePrefix(snapshot, nodeId, routeId)
  if (!prefix) return rejected('STORY_ROUTE_REQUIRED')
  if (!capacity(snapshot, 1, 1, 1) || prefix.length >= limits.routeLength) return rejected('STORY_SIZE_LIMIT')
  const route: StoryRoute = { id: crypto.randomUUID(), title, nodeIds: [...prefix, result.selectedNodeId!] }
  return { ...result, operations: [...result.operations, { type: 'put-route', route }], selectedRouteId: route.id }
}

/** Forking adds routes from the chosen past and never truncates the existing future. */
export function planFork(snapshot: StorySnapshot, nodeId: string, routeId: string | null, titles: readonly [string, string]): StoryTreePlan {
  if (!exists(snapshot, nodeId)) return rejected('STORY_NODE_NOT_FOUND')
  if (!titles.every(validTitle)) return rejected('STORY_INPUT_INVALID')
  if (routeId && !chosenRoute(snapshot, nodeId, routeId)) return rejected('STORY_ROUTE_NODE_MISMATCH')
  const prefix = routePrefix(snapshot, nodeId, routeId)
  if (!prefix) return rejected('STORY_ROUTE_REQUIRED')
  if (!capacity(snapshot, 2, 2, 2) || prefix.length >= limits.routeLength) return rejected('STORY_SIZE_LIMIT')
  const nodes = titles.map(title => emptyNode(title))
  const edges = nodes.map(node => ({ id: crypto.randomUUID(), from: nodeId, to: node.id, label: node.title, condition: '' }))
  const routes = nodes.map(node => ({ id: crypto.randomUUID(), title: node.title, nodeIds: [...prefix, node.id] }))
  return {
    operations: [
      ...nodes.map(node => ({ type: 'put-node' as const, node })),
      ...edges.map(edge => ({ type: 'put-edge' as const, edge })),
      ...routes.map(route => ({ type: 'put-route' as const, route })),
    ],
    selectedNodeId: nodes[0].id, selectedRouteId: routes[0].id, selectedEdgeId: edges[0].id,
  }
}

/**
 * A merge has new empty content: earlier route facts are not copied or confirmed.
 * All existing routes ending at an entrance continue into it. Routes passing an
 * entrance in their middle retain their complete, author-designed path.
 */
export function planMerge(snapshot: StorySnapshot, sourceIds: readonly string[], title: string): StoryTreePlan {
  if (sourceIds.length < 2 || new Set(sourceIds).size !== sourceIds.length) return rejected('STORY_INPUT_INVALID')
  if (sourceIds.some(nodeId => !exists(snapshot, nodeId))) return rejected('STORY_NODE_NOT_FOUND')
  if (!validTitle(title)) return rejected('STORY_INPUT_INVALID')
  const sources = new Set(sourceIds)
  const routes = snapshot.routes.filter(route => sources.has(route.nodeIds.at(-1) ?? ''))
  if (!capacity(snapshot, 1, sourceIds.length, 0) || routes.some(route => route.nodeIds.length >= limits.routeLength)) return rejected('STORY_SIZE_LIMIT')
  const node = emptyNode(title, 'merge')
  const edges = sourceIds.map(from => ({ id: crypto.randomUUID(), from, to: node.id, label: '', condition: '' }))
  return {
    operations: [
      { type: 'put-node', node },
      ...edges.map(edge => ({ type: 'put-edge' as const, edge })),
      ...routes.map(route => ({ type: 'put-route' as const, route: { ...route, nodeIds: [...route.nodeIds, node.id] } })),
    ],
    selectedNodeId: node.id, selectedEdgeId: edges[0].id,
    selectedRouteId: routes[0]?.id ?? '',
  }
}

/** Reject invalid links before staging; the repository remains the final authority. */
export function planConnect(snapshot: StorySnapshot, from: string, to: string, label: string): StoryTreePlan {
  if (!exists(snapshot, from) || !exists(snapshot, to)) return rejected('STORY_NODE_NOT_FOUND')
  if (from === to) return rejected('STORY_CYCLE')
  if (snapshot.edges.some(edge => edge.from === from && edge.to === to)) return rejected('STORY_EDGE_EXISTS')
  if (label.length > 200 || label.includes('\0')) return rejected('STORY_INPUT_INVALID')
  const successors = new Map<string, string[]>()
  for (const edge of snapshot.edges) successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to])
  const visited = new Set<string>(), queue = [to]
  for (let offset = 0; offset < queue.length; offset++) {
    const id = queue[offset]
    if (id === from) return rejected('STORY_CYCLE')
    if (visited.has(id)) continue
    visited.add(id); queue.push(...(successors.get(id) ?? []))
  }
  if (!capacity(snapshot, 0, 1, 0)) return rejected('STORY_SIZE_LIMIT')
  const edge = { id: crypto.randomUUID(), from, to, label, condition: '' }
  return { operations: [{ type: 'put-edge', edge }], selectedEdgeId: edge.id }
}

/** A manual reconnection is also a path decision so prose navigation follows the link. */
export function planReconnectRoute(snapshot: StorySnapshot, from: string, to: string, routeId: string | null, label: string): StoryTreePlan {
  const link = planConnect(snapshot, from, to, label)
  if (link.error) return link
  const route = chosenRoute(snapshot, from, routeId)
  if (!route || route.id === MAINLINE_STORY_ROUTE_ID) return link
  const prefix = route.nodeIds.slice(0, route.nodeIds.indexOf(from) + 1)
  if (prefix.includes(to)) return rejected('STORY_CYCLE')
  const endpoint = route.nodeIds.at(-1) === from
  if (!capacity(snapshot, 0, 1, endpoint ? 0 : 1) || prefix.length >= limits.routeLength) return rejected('STORY_SIZE_LIMIT')
  const nextRoute: StoryRoute = { id: endpoint ? route.id : crypto.randomUUID(), title: endpoint ? route.title : `${route.title} · ${label}`.slice(0, 200), nodeIds: [...prefix, to] }
  return { ...link, operations: [...link.operations, { type: 'put-route', route: nextRoute }], selectedRouteId: nextRoute.id, selectedNodeId: from }
}

/** Build an explicitly selected path rather than guessing a route through forks. */
export function planRouteFromPath(snapshot: StorySnapshot, nodeIds: readonly string[], title: string): StoryTreePlan {
  if (!validTitle(title)) return rejected('STORY_INPUT_INVALID')
  if (!nodeIds.length || new Set(nodeIds).size !== nodeIds.length || nodeIds.length > limits.routeLength) return rejected('STORY_ROUTE_INVALID')
  if (nodeIds.some(nodeId => !exists(snapshot, nodeId))) return rejected('STORY_NODE_NOT_FOUND')
  const pairs = new Set(snapshot.edges.map(edge => `${edge.from}:${edge.to}`))
  if (nodeIds.some((nodeId, offset) => offset > 0 && !pairs.has(`${nodeIds[offset - 1]}:${nodeId}`))) return rejected('STORY_ROUTE_DISCONNECTED')
  if (!capacity(snapshot, 0, 0, 1)) return rejected('STORY_SIZE_LIMIT')
  const route = { id: crypto.randomUUID(), title, nodeIds: [...nodeIds] }
  return { operations: [{ type: 'put-route', route }], selectedRouteId: route.id, selectedNodeId: nodeIds.at(-1) }
}
