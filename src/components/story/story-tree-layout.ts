import type { StoryEdge, StoryNode, StorySnapshot } from '../../shared/story-branches'

export const STORY_TREE_CARD_WIDTH = 244
export const STORY_TREE_CARD_HEIGHT = 180
const HORIZONTAL_GAP = 60
const VERTICAL_GAP = 112
const PADDING = 64
export const STORY_TREE_EDGE_LABEL_WIDTH = 140
const BYPASS_CLEARANCE = 112
const BYPASS_LANE_GAP = 172

export interface StoryTreePosition {
  node: StoryNode
  x: number
  y: number
  width: number
  height: number
  depth: number
}
export interface StoryTreeConnection {
  edge: StoryEdge
  path: string
  labelX: number
  labelY: number
  /** Visible bypass geometry, independent of persisted story data. */
  waypoints?: { x: number; y: number }[]
  bypassLane?: { side: 'left' | 'right'; index: number; x: number }
}
export interface StoryTreeLayout {
  nodes: StoryTreePosition[]
  edges: StoryTreeConnection[]
  width: number
  height: number
  hiddenCount: number
  roots: string[]
}

/** Collapse hides only descendants whose every entrance passes a collapsed node. */
export function visibleStoryNodeIds(snapshot: StorySnapshot, collapsedIds: Iterable<string> = []): Set<string> {
  const collapsed = new Set(collapsedIds)
  const ids = new Set(snapshot.nodes.map(node => node.id))
  const incoming = new Set(snapshot.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)).map(edge => edge.to))
  const outgoing = new Map<string, string[]>()
  for (const edge of snapshot.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    const children = outgoing.get(edge.from) ?? []
    children.push(edge.to)
    outgoing.set(edge.from, children)
  }
  const roots = snapshot.nodes.filter(node => !incoming.has(node.id)).map(node => node.id)
  const reachable = new Set<string>()
  const allPaths = [...roots]
  for (let index = 0; index < allPaths.length; index++) {
    const id = allPaths[index]
    if (reachable.has(id)) continue
    reachable.add(id)
    allPaths.push(...(outgoing.get(id) ?? []))
  }
  const queue = [...roots]
  const visible = new Set<string>()
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]
    if (visible.has(id)) continue
    visible.add(id)
    if (!collapsed.has(id)) queue.push(...(outgoing.get(id) ?? []))
  }
  // Invalid pending imports should remain inspectable instead of disappearing.
  for (const node of snapshot.nodes) if (!reachable.has(node.id)) visible.add(node.id)
  return visible
}

/** A stable layered DAG layout. It never stores coordinates or changes author data. */
export function layoutStoryTree(snapshot: StorySnapshot, collapsedIds: Iterable<string> = []): StoryTreeLayout {
  const collapsed = new Set(collapsedIds)
  const visible = visibleStoryNodeIds(snapshot, collapsed)
  // Preview replaces edited records at the end of their arrays. Identity order
  // makes typing text leave every card in place.
  const nodes = snapshot.nodes.filter(node => visible.has(node.id)).sort((a, b) => a.id.localeCompare(b.id))
  const edges = snapshot.edges.filter(edge => visible.has(edge.from) && visible.has(edge.to) && !collapsed.has(edge.from)).sort((a, b) => a.id.localeCompare(b.id))
  const order = new Map(nodes.map((node, index) => [node.id, index]))
  const indegree = new Map(nodes.map(node => [node.id, 0]))
  const incoming = new Map(nodes.map(node => [node.id, [] as string[]]))
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]))
  for (const edge of edges) {
    indegree.set(edge.to, indegree.get(edge.to)! + 1)
    incoming.get(edge.to)!.push(edge.from)
    outgoing.get(edge.from)!.push(edge.to)
  }
  const roots = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id)
  const queue = [...roots]
  const depth = new Map(nodes.map(node => [node.id, 0]))
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]
    for (const child of outgoing.get(id) ?? []) {
      depth.set(child, Math.max(depth.get(child)!, depth.get(id)! + 1))
      indegree.set(child, indegree.get(child)! - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }
  const layers: string[][] = []
  for (const node of nodes) (layers[depth.get(node.id)!] ??= []).push(node.id)
  // Parent/child barycentres keep branches grouped and reduce crossing at merges.
  const ranks = new Map<string, number>()
  const refreshRanks = () => layers.forEach(layer => layer?.forEach((id, index) => ranks.set(id, index)))
  const sortLayer = (layer: string[], neighbours: Map<string, string[]>) => {
    const average = (id: string) => {
      const related = neighbours.get(id) ?? []
      return related.length ? related.reduce((sum, other) => sum + (ranks.get(other) ?? 0), 0) / related.length : ranks.get(id) ?? 0
    }
    layer.sort((a, b) => average(a) - average(b) || order.get(a)! - order.get(b)!)
    refreshRanks()
  }
  refreshRanks()
  for (let pass = 0; pass < 3; pass++) {
    for (let level = 1; level < layers.length; level++) if (layers[level]) sortLayer(layers[level], incoming)
    for (let level = layers.length - 2; level >= 0; level--) if (layers[level]) sortLayer(layers[level], outgoing)
  }
  const widest = Math.max(1, ...layers.map(layer => layer?.length ?? 0))
  const contentWidth = widest * STORY_TREE_CARD_WIDTH + Math.max(0, widest - 1) * HORIZONTAL_GAP
  const bypasses = new Map<string, { side: 'left' | 'right'; index: number }>()
  type Span = { start: number; end: number }
  const lanes: Record<'left' | 'right', Span[][]> = { left: [], right: [] }
  const freeLane = (side: 'left' | 'right', span: Span) => {
    const index = lanes[side].findIndex(used => used.every(other => other.end <= span.start || other.start >= span.end))
    return index === -1 ? lanes[side].length : index
  }
  // A long edge must not take a straight path through intermediate chapter
  // cards. Overlapping spans use distinct outer lanes; disjoint spans reuse one.
  for (const edge of edges) {
    const span = { start: depth.get(edge.from)!, end: depth.get(edge.to)! }
    if (span.end - span.start <= 1) continue
    const right = freeLane('right', span), left = freeLane('left', span)
    const rightExists = right < lanes.right.length, leftExists = left < lanes.left.length
    const side = right < left || right === left && (rightExists || !leftExists) ? 'right' : 'left'
    const index = side === 'right' ? right : left
    const lane = (lanes[side][index] ??= [])
    lane.push(span)
    bypasses.set(edge.id, { side, index })
  }
  const reserve = (count: number) => count ? BYPASS_CLEARANCE + (count - 1) * BYPASS_LANE_GAP + STORY_TREE_EDGE_LABEL_WIDTH / 2 : 0
  const leftReserve = reserve(lanes.left.length), rightReserve = reserve(lanes.right.length)
  const contentLeft = PADDING + leftReserve, contentRight = contentLeft + contentWidth
  const positions = new Map<string, StoryTreePosition>()
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  for (let level = 0; level < layers.length; level++) {
    const layer = layers[level] ?? []
    const layerWidth = layer.length * STORY_TREE_CARD_WIDTH + Math.max(0, layer.length - 1) * HORIZONTAL_GAP
    layer.forEach((id, index) => positions.set(id, {
      node: nodeById.get(id)!,
      x: contentLeft + (contentWidth - layerWidth) / 2 + index * (STORY_TREE_CARD_WIDTH + HORIZONTAL_GAP),
      y: PADDING + level * (STORY_TREE_CARD_HEIGHT + VERTICAL_GAP),
      width: STORY_TREE_CARD_WIDTH, height: STORY_TREE_CARD_HEIGHT, depth: level,
    }))
  }
  const connections = edges.flatMap<StoryTreeConnection>(edge => {
    const from = positions.get(edge.from), to = positions.get(edge.to)
    if (!from || !to) return []
    const x1 = from.x + from.width / 2, y1 = from.y + from.height
    const x2 = to.x + to.width / 2, y2 = to.y
    const middle = (y1 + y2) / 2
    const bypass = bypasses.get(edge.id)
    if (bypass) {
      const laneX = bypass.side === 'right' ? contentRight + BYPASS_CLEARANCE + bypass.index * BYPASS_LANE_GAP
        : contentLeft - BYPASS_CLEARANCE - bypass.index * BYPASS_LANE_GAP
      const exitY = y1 + 28, entryY = y2 - 28, radius = 12
      const out = Math.sign(laneX - x1), back = Math.sign(x2 - laneX)
      const path = `M${x1},${y1} L${x1},${exitY - radius} Q${x1},${exitY} ${x1 + out * radius},${exitY}`
        + ` L${laneX - out * radius},${exitY} Q${laneX},${exitY} ${laneX},${exitY + radius}`
        + ` L${laneX},${entryY - radius} Q${laneX},${entryY} ${laneX + back * radius},${entryY}`
        + ` L${x2 - back * radius},${entryY} Q${x2},${entryY} ${x2},${entryY + radius} L${x2},${y2}`
      return [{ edge, path, labelX: laneX, labelY: (exitY + entryY) / 2,
        waypoints: [{ x: x1, y: y1 }, { x: x1, y: exitY }, { x: laneX, y: exitY }, { x: laneX, y: entryY }, { x: x2, y: entryY }, { x: x2, y: y2 }],
        bypassLane: { ...bypass, x: laneX },
      }]
    }
    return [{ edge, path: `M${x1},${y1} C${x1},${middle} ${x2},${middle} ${x2},${y2}`, labelX: (x1 + x2) / 2, labelY: middle }]
  })
  return {
    nodes: [...positions.values()], edges: connections,
    width: Math.max(372, contentWidth + PADDING * 2 + leftReserve + rightReserve),
    height: Math.max(360, layers.length * STORY_TREE_CARD_HEIGHT + Math.max(0, layers.length - 1) * VERTICAL_GAP + PADDING * 2),
    hiddenCount: snapshot.nodes.length - visible.size, roots,
  }
}
