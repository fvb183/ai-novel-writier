import { createHash } from 'node:crypto'
import type { StoryData } from '../repositories/story-branch-repository'
import { MAINLINE_STORY_ROUTE_ID, isMainlineStoryNodeId, mainlineStoryChapterNumber, mainlineStoryEdgeId, mainlineStoryNodeId,
  type StoryEdge, type StoryNode, type StoryProjectionAliases, type StoryRoute } from '../../src/shared/story-branches'

// These are already validated stored records. Keep the original R1 hash order.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item)
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const nodeInput = ({ revisionId: _revision, ...input }: StoryNode) => input

function pristineSources(data: StoryData): Record<string, string> {
  const result: Record<string, string> = {}
  for (const node of data.nodes) {
    const source = node.chapterSource, blueprint = node.chapterBlueprint
    if (!source || !blueprint || node.kind !== 'content' || node.chapterNumber !== source.chapterNumber
      || node.event !== blueprint.keyEvents || digest(node.body) !== source.manuscriptHash
      || digest(canonical(blueprint)) !== source.blueprintHash) continue
    const history = data.revisions.filter(revision => revision.nodeId === node.id)
    const roots = history.filter(revision => revision.parentRevisionId === null)
    if (roots.length !== 1) continue
    const original = canonical(roots[0].node)
    // A renamed node or a source restored after independent edits remains a branch.
    // Imported chapter titles can come from the manuscript, not its empty blueprint.
    if (canonical(nodeInput(node)) !== original || history.some(revision => canonical(revision.node) !== original)) continue
    result[node.id] = mainlineStoryNodeId(source.chapterNumber)
  }
  return result
}

/** Folding two old identities must not invent a cycle that the old UUID DAG lacked. */
function cycleTargets(data: StoryData, mainline: readonly StoryNode[], aliases: Record<string, string>): Set<string> {
  const resolve = (id: string) => aliases[id] ?? id
  const vertices = new Set([...data.nodes.map(node => resolve(node.id)), ...mainline.map(node => node.id),
    ...data.edges.flatMap(edge => [resolve(edge.from), resolve(edge.to)]),
    ...data.routes.flatMap(route => route.nodeIds.map(resolve))])
  const degree = new Map([...vertices].map(id => [id, 0])), next = new Map<string, string[]>(), pairs = new Set<string>()
  const add = (from: string, to: string) => {
    const pair = JSON.stringify([from, to]); if (pairs.has(pair)) return
    pairs.add(pair); degree.set(to, degree.get(to)! + 1); next.set(from, [...(next.get(from) ?? []), to])
  }
  const canonicalIds = [...vertices].filter(isMainlineStoryNodeId).sort((a, b) => mainlineStoryChapterNumber(a)! - mainlineStoryChapterNumber(b)!)
  canonicalIds.slice(1).forEach((id, index) => add(canonicalIds[index], id))
  data.edges.forEach(edge => add(resolve(edge.from), resolve(edge.to)))
  const queue = [...degree].filter(([, count]) => count === 0).map(([id]) => id)
  for (let index = 0; index < queue.length; index++) for (const id of next.get(queue[index]) ?? []) {
    const remaining = degree.get(id)! - 1; degree.set(id, remaining); if (!remaining) queue.push(id)
  }
  return new Set([...degree].filter(([, count]) => count > 0).map(([id]) => id))
}

/** View-only normalization. The caller persists and synchronizes the original records. */
export function legacyStoryNodeAliases(data: StoryData, mainline: readonly StoryNode[] = []): Record<string, string> {
  const nodes = pristineSources(data)
  while (Object.keys(nodes).length) {
    const blocked = cycleTargets(data, mainline, nodes)
    const rejected = Object.keys(nodes).filter(id => blocked.has(nodes[id]))
    if (!rejected.length) break
    rejected.forEach(id => { delete nodes[id] })
  }
  return nodes
}

/** Existing folded chapters cannot be unfolded merely to bypass a new back-edge. */
export function assertLegacyStoryProjectionAcyclic(data: StoryData, mainline: readonly StoryNode[], before: Record<string, string>): void {
  const eligible = pristineSources(data)
  const retained = Object.fromEntries(Object.entries(before).filter(([id]) => eligible[id]))
  if (cycleTargets(data, mainline, retained).size) throw new Error('STORY_CYCLE')
}

export function projectLegacyStorySources(data: StoryData, mainline: readonly StoryNode[]): StoryData {
  const nodes = legacyStoryNodeAliases(data, mainline)
  if (!Object.keys(nodes).length) return data
  const aliases: StoryProjectionAliases = { nodes, routes: {}, edges: {},
    affectedRoutes: Object.fromEntries(Object.keys(nodes).map(id => [id,
      data.routes.filter(route => route.nodeIds.includes(id)).map(route => route.title).sort()])) }
  const resolve = (id: string) => nodes[id] ?? id
  const canonicalIds = mainline.map(node => node.id)
  const contiguous = (path: string[]) => {
    const start = canonicalIds.indexOf(path[0])
    return start >= 0 && path.every((id, index) => canonicalIds[start + index] === id)
  }
  const explicitCanonicalPairs = new Set(data.routes.flatMap(route => {
    const path = route.nodeIds.map(resolve)
    return path.every((id): boolean => isMainlineStoryNodeId(id)) && !contiguous(path) && !/^主线快照 · 第 \d+ 章$/.test(route.title)
      ? path.slice(1).map((id, index) => JSON.stringify([path[index], id])) : []
  }))
  const canonicalPairs = new Map(mainline.slice(1).map((node, index) => [JSON.stringify([mainline[index].id, node.id]), mainlineStoryEdgeId(mainline[index].id, node.id)]))
  const edges: StoryEdge[] = [], edgeKeys = new Map<string, string>()
  for (const edge of [...data.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const projected = { ...edge, from: resolve(edge.from), to: resolve(edge.to) }
    const pair = JSON.stringify([projected.from, projected.to])
    const sourceChain = Boolean(nodes[edge.from] && nodes[edge.to] && !edge.label && !edge.condition)
    if (sourceChain && !explicitCanonicalPairs.has(pair) || canonicalPairs.has(pair) && !edge.label && !edge.condition) {
      const canonicalId = canonicalPairs.get(pair)
      if (canonicalId) aliases.edges[edge.id] = canonicalId
      continue
    }
    const key = canonical([projected.from, projected.to, projected.label, projected.condition]), previous = edgeKeys.get(key)
    if (previous) { aliases.edges[edge.id] = previous; continue }
    edgeKeys.set(key, edge.id); edges.push(projected)
  }
  const routes: StoryRoute[] = [], routeKeys = new Map<string, string>()
  for (const route of [...data.routes].sort((a, b) => a.id.localeCompare(b.id))) {
    let path = route.nodeIds.map(resolve).filter((id, index, all) => index === 0 || id !== all[index - 1])
    // Old automatic mainline snapshots are now the actual canonical chapters.
    if (route.nodeIds.some(id => nodes[id]) && path.every((id): boolean => isMainlineStoryNodeId(id))
      && (contiguous(path) || /^主线快照 · 第 \d+ 章$/.test(route.title))) {
      aliases.routes[route.id] = MAINLINE_STORY_ROUTE_ID; continue
    }
    // R1 copied the complete source prefix; it now refers to the live anchor.
    if (!path.every((id): boolean => isMainlineStoryNodeId(id))) {
      let prefix = 0
      while (prefix < route.nodeIds.length && nodes[route.nodeIds[prefix]]) prefix++
      if (prefix > 1) path = path.slice(prefix - 1)
    }
    const key = canonical([route.title, path]), previous = routeKeys.get(key)
    if (previous) { aliases.routes[route.id] = previous; continue }
    routeKeys.set(key, route.id); routes.push({ ...route, nodeIds: path })
  }
  return { ...data, nodes: data.nodes.filter(node => !nodes[node.id]), edges, routes,
    notes: data.notes.map(note => ({ ...note, nodeId: resolve(note.nodeId), routeId: note.routeId ? aliases.routes[note.routeId] ?? note.routeId : null })), aliases }
}
