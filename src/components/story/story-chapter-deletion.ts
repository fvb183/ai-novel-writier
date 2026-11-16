import { isMainlineStoryNodeId, type StoryNode, type StoryOperation, type StorySnapshot } from '../../shared/story-branches'
import type { StoryTreePlan } from './story-tree-commands'

export function storyChapterHasManuscript(snapshot: StorySnapshot, node: StoryNode): boolean {
  return Boolean(node.body.trim() || node.mainline?.hasManuscript
    || snapshot.revisions.some(revision => revision.nodeId === node.id && revision.node.body.trim()))
}

/** Delete a chapter from paths while preserving their surviving chapters and history. */
export function planDeleteStoryChapter(snapshot: StorySnapshot, nodeId: string): StoryTreePlan {
  const target = snapshot.nodes.find(node => node.id === nodeId)
  if (!target) return { operations: [], error: 'STORY_NODE_NOT_FOUND' }
  if (isMainlineStoryNodeId(nodeId)) return { operations: [], error: 'STORY_MAINLINE_READ_ONLY' }
  const operations: StoryOperation[] = []
  const removedRoutes = new Set<string>()
  const mainlinePath = snapshot.routes.find(route => route.id === 'mainline')?.nodeIds ?? []
  const survivingEdges = snapshot.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId)
  const pairs = new Set(survivingEdges.map(edge => `${edge.from}|${edge.to}`))
  for (const route of snapshot.routes.filter(route => route.nodeIds.includes(nodeId))) {
    const nodeIds = route.nodeIds.filter(id => id !== nodeId)
    const mainlineOffset = mainlinePath.indexOf(nodeIds[0])
    const repeatsMainline = mainlineOffset >= 0 && nodeIds.every((id, index) => id === mainlinePath[mainlineOffset + index])
    if (!nodeIds.length || repeatsMainline) {
      removedRoutes.add(route.id)
      operations.push({ type: 'delete-route', id: route.id })
      continue
    }
    for (let offset = 1; offset < nodeIds.length; offset++) {
      const from = nodeIds[offset - 1], to = nodeIds[offset], pair = `${from}|${to}`
      if (pairs.has(pair)) continue
      const priorOffset = route.nodeIds.indexOf(from)
      if (route.nodeIds[priorOffset + 1] === to && isMainlineStoryNodeId(from) && isMainlineStoryNodeId(to)) continue
      // Only replace a path which formerly passed through the deleted chapter.
      const before = snapshot.edges.find(edge => edge.from === from && edge.to === nodeId)
      const after = snapshot.edges.find(edge => edge.from === nodeId && edge.to === to)
      if (!before || !after) return { operations: [], error: 'STORY_ROUTE_DISCONNECTED' }
      const conditions = [before.condition.trim(), after.condition.trim()].filter(Boolean)
      const condition = conditions.map(condition => `(${condition})`).join(' 且 ')
      if (condition.length > 4000) return { operations: [], error: 'STORY_SIZE_LIMIT' }
      operations.push({ type: 'put-edge', edge: { id: crypto.randomUUID(), from, to,
        label: [before.label, after.label].filter(Boolean).join(' / ').slice(0, 200),
        condition,
      } })
      pairs.add(pair)
    }
    operations.push({ type: 'put-route', route: { ...route, nodeIds } })
  }
  operations.unshift(...snapshot.notes.filter(note => note.nodeId === nodeId || note.routeId !== null && removedRoutes.has(note.routeId))
    .map(note => ({ type: 'delete-note' as const, id: note.id })))
  operations.push(...snapshot.edges.filter(edge => edge.from === nodeId || edge.to === nodeId).map(edge => ({ type: 'delete-edge' as const, id: edge.id })),
    { type: 'delete-node', id: nodeId })
  const nextRoute = snapshot.routes.find(route => !removedRoutes.has(route.id))
  const surviving = nextRoute?.nodeIds.filter(id => id !== nodeId) ?? snapshot.nodes.filter(node => node.id !== nodeId).map(node => node.id)
  return { operations, selectedNodeId: surviving.at(-1) ?? '', selectedRouteId: nextRoute?.id ?? '', selectedEdgeId: '' }
}

/** Prose and its identity survive deleting a generated chapter's blueprint. */
export function planDeleteStoryBlueprint(snapshot: StorySnapshot, nodeId: string): StoryTreePlan {
  const node = snapshot.nodes.find(item => item.id === nodeId)
  if (!node) return { operations: [], error: 'STORY_NODE_NOT_FOUND' }
  if (isMainlineStoryNodeId(nodeId)) return { operations: [], error: 'STORY_MAINLINE_READ_ONLY' }
  if (!storyChapterHasManuscript(snapshot, node)) return planDeleteStoryChapter(snapshot, nodeId)
  const { revisionId: _revision, mainline: _mainline, chapterBlueprint, ...input } = node
  if (!chapterBlueprint) return { operations: [] }
  return { operations: [{ type: 'put-node', node: { ...input, event: input.event === chapterBlueprint.keyEvents ? '' : input.event } }], selectedNodeId: nodeId }
}
