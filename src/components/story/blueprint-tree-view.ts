import type { ChapterBlueprint } from '../../services/workflows/directory-workflow'
import { MAINLINE_STORY_ROUTE_ID, isMainlineStoryEdgeId, mainlineStoryNodeId, mainlineStoryEdgeId, type StorySnapshot, type StoryNode } from '../../shared/story-branches'

/** Local canonical-blueprint drafts are visual overlays, never story mutations. */
export function blueprintTreeView(snapshot: StorySnapshot, blueprints: ChapterBlueprint[]): StorySnapshot {
  const byChapter = new Map(blueprints.map(blueprint => [blueprint.chapterNumber, blueprint]))
  const referenced = new Set([
    ...snapshot.edges.filter(edge => !isMainlineStoryEdgeId(edge.id)).flatMap(edge => [edge.from, edge.to]),
    ...snapshot.routes.filter(route => route.id !== MAINLINE_STORY_ROUTE_ID).flatMap(route => route.nodeIds),
  ])
  const nodes = new Map<string, StoryNode>()
  for (const node of snapshot.nodes) {
    if (!node.mainline || byChapter.has(node.mainline.chapterNumber)) { nodes.set(node.id, node); continue }
    // A slightly older story read must not revive a just-deleted blueprint.
    const { chapterBlueprint: _blueprint, ...chapter } = node
    const hasManuscript = Boolean(node.body.trim() || node.mainline.hasManuscript || node.mainline.manuscriptStatus === 'finalized')
    const unavailable = ['missing', 'unavailable'].includes(node.mainline.manuscriptStatus)
    if (!hasManuscript && !unavailable && !referenced.has(node.id)) continue
    nodes.set(node.id, { ...chapter, event: '', mainline: { ...node.mainline, hasBlueprint: false,
      ...(!hasManuscript && !unavailable ? { manuscriptStatus: 'missing' as const } : {}),
    } })
  }
  for (const blueprint of blueprints) {
    const id = mainlineStoryNodeId(blueprint.chapterNumber), before = nodes.get(id)
    const { chapterNumber, notesUpdatedAt: _updated, ...chapterBlueprint } = blueprint
    nodes.set(id, { ...before, id, kind: 'content', title: blueprint.title || `第 ${chapterNumber} 章`, chapterNumber,
      event: blueprint.keyEvents, body: before?.body ?? '', revisionId: before?.revisionId ?? `preview:${id}`, chapterBlueprint,
      mainline: { ...before?.mainline, chapterNumber, manuscriptStatus: before?.mainline?.manuscriptStatus ?? 'unwritten', hasBlueprint: true },
    } satisfies StoryNode)
  }
  const mainline = [...nodes.values()].filter(node => node.mainline).sort((a, b) => a.mainline!.chapterNumber - b.mainline!.chapterNumber)
  const route = snapshot.routes.find(item => item.id === MAINLINE_STORY_ROUTE_ID)
  return { ...snapshot, nodes: [...nodes.values()], edges: [
    ...snapshot.edges.filter(edge => !isMainlineStoryEdgeId(edge.id)),
    ...mainline.slice(1).map((node, index) => ({ id: mainlineStoryEdgeId(mainline[index].id, node.id), from: mainline[index].id, to: node.id, label: '', condition: '' })),
  ], routes: [...snapshot.routes.filter(item => item.id !== MAINLINE_STORY_ROUTE_ID), ...(mainline.length ? [{ id: MAINLINE_STORY_ROUTE_ID, title: route?.title ?? '主线', nodeIds: mainline.map(node => node.id) }] : [])] }
}
