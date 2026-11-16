import { describe, expect, it } from 'vitest'
import { validateStoryData } from '../../../../electron/repositories/story-branch-repository'
import type { StoryNode, StoryNodeInput, StoryNodeRevision, StorySnapshot } from '../../../shared/story-branches'
import { planConnect, planContinue, planContinueRoute, planFork, planMerge, planReconnectRoute, planRouteFromPath, type StoryTreePlan } from '../story-tree-commands'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
function fixture(): StorySnapshot {
  const inputs: StoryNodeInput[] = ['出发', '森林', '海港', '山顶', '后日谈'].map((title, index) => ({
    id: id(index + 1), kind: index === 0 ? 'branch' : index === 3 ? 'merge' : 'content', title,
    chapterNumber: index + 1, event: `事件${index}`, body: `正文${index}`,
  }))
  const revisions: StoryNodeRevision[] = inputs.map((node, index) => ({ id: id(20 + index), nodeId: node.id, parentRevisionId: null, node }))
  const nodes: StoryNode[] = inputs.map((node, index) => ({ ...node, revisionId: revisions[index].id }))
  return {
    revision: 'a'.repeat(64), nodes, revisions,
    edges: [[1, 2], [1, 3], [2, 4], [3, 4], [4, 5]].map(([from, to], index) => ({ id: id(40 + index), from: id(from), to: id(to), label: '', condition: '' })),
    routes: [
      { id: id(60), title: '森林路线', nodeIds: [id(1), id(2)] },
      { id: id(61), title: '海港路线', nodeIds: [id(1), id(3)] },
      { id: id(62), title: '原有完整路线', nodeIds: [id(1), id(2), id(4), id(5)] },
      { id: id(63), title: '另一完整路线', nodeIds: [id(1), id(3), id(4), id(5)] },
    ],
    notes: [{ id: id(80), routeId: id(60), nodeId: id(2), summary: '保留已有前情', characterStates: '持有钥匙', entryDifferences: '', sourceHash: 'b'.repeat(64), confirmed: true }],
  }
}

/** Apply payloads with newly assigned history to validate against the real domain contract. */
function domainResult(snapshot: StorySnapshot, plan: StoryTreePlan) {
  expect(plan.error).toBeUndefined()
  const data = structuredClone(snapshot)
  for (const operation of plan.operations) {
    if (operation.type === 'put-node') {
      const revisionId = crypto.randomUUID()
      data.revisions.push({ id: revisionId, nodeId: operation.node.id, parentRevisionId: data.nodes.find(node => node.id === operation.node.id)?.revisionId ?? null, node: operation.node })
      data.nodes = [...data.nodes.filter(node => node.id !== operation.node.id), { ...operation.node, revisionId }]
    } else if (operation.type === 'put-edge') data.edges = [...data.edges.filter(edge => edge.id !== operation.edge.id), operation.edge]
    else if (operation.type === 'put-route') data.routes = [...data.routes.filter(route => route.id !== operation.route.id), operation.route]
    else throw new Error(`Tree creation should not change or delete existing facts: ${operation.type}`)
  }
  const { revision: _revision, ...authorData } = data
  validateStoryData(authorData)
  return data
}

function freeze<T>(object: T): T {
  if (object && typeof object === 'object') {
    Object.freeze(object)
    for (const value of Object.values(object)) freeze(value)
  }
  return object
}

describe('visual story tree operation plans', () => {
  it('keeps a continued interior chapter immediately usable for generation on a new route', () => {
    const snapshot = fixture(), plan = planContinueRoute(snapshot, id(2), id(62), '新的去处')
    const result = domainResult(snapshot, plan)
    expect(result.routes.find(route => route.id === id(62))).toEqual(snapshot.routes[2])
    expect(result.routes.find(route => route.id === plan.selectedRouteId)?.nodeIds).toEqual([id(1), id(2), plan.selectedNodeId])
    expect(result.nodes.find(node => node.id === plan.selectedNodeId)?.chapterBlueprint?.title).toBe('新的去处')
  })
  it('manually reconnects an endpoint as one route decision and retains prose and history', () => {
    const snapshot = freeze(fixture()), before = JSON.stringify(snapshot)
    const plan = planReconnectRoute(snapshot, id(2), id(3), id(60), '接回')
    const result = domainResult(snapshot, plan)
    expect(result.routes.find(route => route.id === id(60))?.nodeIds).toEqual([id(1), id(2), id(3)])
    expect(result.edges.some(edge => edge.from === id(2) && edge.to === id(3))).toBe(true)
    expect(result.nodes).toEqual(snapshot.nodes); expect(result.revisions).toEqual(snapshot.revisions)
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('reconnecting an interior scene creates an alternate route and preserves the existing later chapters', () => {
    const snapshot = fixture(), plan = planReconnectRoute(snapshot, id(2), id(3), id(62), '接回')
    const result = domainResult(snapshot, plan)
    expect(result.routes.find(route => route.id === id(62))).toEqual(snapshot.routes[2])
    expect(result.routes.find(route => route.id === plan.selectedRouteId)?.nodeIds).toEqual([id(1), id(2), id(3)])
    expect(result.routes).toHaveLength(snapshot.routes.length + 1)
    expect(planReconnectRoute(snapshot, id(5), id(1), id(62), '接回')).toEqual({ operations: [], error: 'STORY_CYCLE' })
  })
  it('continues only the selected endpoint route and preserves every earlier manuscript and note', () => {
    const snapshot = freeze(fixture()), before = JSON.stringify(snapshot)
    const plan = planContinue(snapshot, id(2), id(60), '林中小屋')
    const result = domainResult(snapshot, plan)
    expect(result.routes.find(route => route.id === id(60))?.nodeIds).toEqual([id(1), id(2), plan.selectedNodeId])
    expect(result.routes.find(route => route.id === id(62))).toEqual(snapshot.routes[2])
    expect(result.notes).toEqual(snapshot.notes)
    expect(result.nodes.find(node => node.id === plan.selectedNodeId)).toMatchObject({ kind: 'content', body: '', event: '', chapterNumber: null })
    expect(plan.selectedRouteId).toBe(id(60))
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('adds an alternate child from an interior route node without silently replacing its existing future', () => {
    const snapshot = fixture(), plan = planContinue(snapshot, id(2), id(62), '新的去处')
    const result = domainResult(snapshot, plan)
    expect(result.routes).toEqual(snapshot.routes)
    expect(plan.operations.map(operation => operation.type)).toEqual(['put-node', 'put-edge'])
    expect(plan.selectedRouteId).toBe('')
    expect(result.edges.some(edge => edge.from === id(2) && edge.to === id(4))).toBe(true)
  })

  it('forks at an interior node using the author-selected past while retaining all old routes and history', () => {
    const snapshot = freeze(fixture()), before = JSON.stringify(snapshot)
    const plan = planFork(snapshot, id(4), id(62), ['留下', '远行'])
    const result = domainResult(snapshot, plan), newRoutes = result.routes.filter(route => !snapshot.routes.some(prior => prior.id === route.id))
    expect(newRoutes).toHaveLength(2)
    expect(newRoutes.map(route => route.nodeIds.slice(0, -1))).toEqual([[id(1), id(2), id(4)], [id(1), id(2), id(4)]])
    expect(newRoutes[0].nodeIds.at(-1)).not.toBe(newRoutes[1].nodeIds.at(-1))
    expect(result.routes.slice(0, snapshot.routes.length)).toEqual(snapshot.routes)
    expect(result.nodes.slice(0, snapshot.nodes.length)).toEqual(snapshot.nodes)
    expect(result.revisions.slice(0, snapshot.revisions.length)).toEqual(snapshot.revisions)
    expect(result.notes).toEqual(snapshot.notes)
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('requires the author to choose a route when a merge has different earlier events', () => {
    const snapshot = fixture()
    expect(planFork(snapshot, id(4), null, ['甲', '乙'])).toEqual({ operations: [], error: 'STORY_ROUTE_REQUIRED' })
    snapshot.routes = []
    expect(planFork(snapshot, id(4), null, ['甲', '乙'])).toEqual({ operations: [], error: 'STORY_ROUTE_REQUIRED' })
  })

  it('derives an unambiguous graph prefix when no routes exist yet', () => {
    const snapshot = fixture(); snapshot.routes = []; snapshot.notes = []
    const result = domainResult(snapshot, planFork(snapshot, id(2), null, ['甲', '乙']))
    expect(result.routes.map(route => route.nodeIds.slice(0, -1))).toEqual([[id(1), id(2)], [id(1), id(2)]])
  })

  it('merges all endpoint routes with empty content and keeps middle routes and continuity intact', () => {
    const snapshot = freeze(fixture()), before = JSON.stringify(snapshot)
    const plan = planMerge(snapshot, [id(2), id(3)], '渡口会面')
    const result = domainResult(snapshot, plan)
    expect(result.routes.find(route => route.id === id(60))?.nodeIds).toEqual([id(1), id(2), plan.selectedNodeId])
    expect(result.routes.find(route => route.id === id(61))?.nodeIds).toEqual([id(1), id(3), plan.selectedNodeId])
    expect(result.routes.find(route => route.id === id(62))).toEqual(snapshot.routes[2])
    expect(result.routes.find(route => route.id === id(63))).toEqual(snapshot.routes[3])
    expect(result.nodes.find(node => node.id === plan.selectedNodeId)).toMatchObject({ kind: 'merge', event: '', body: '' })
    expect(result.notes).toEqual(snapshot.notes)
    expect(plan.operations.some(operation => operation.type === 'put-note')).toBe(false)
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('can connect un-routed graph entrances without inventing or truncating writing routes', () => {
    const snapshot = fixture(); snapshot.routes = []; snapshot.notes = []
    const plan = planMerge(snapshot, [id(2), id(3)], '新汇合')
    const result = domainResult(snapshot, plan)
    expect(result.routes).toEqual([])
    expect(plan.selectedRouteId).toBe('')
    expect(result.edges.filter(edge => edge.to === plan.selectedNodeId)).toHaveLength(2)
  })

  it('rejects self-links, duplicate links and distant backwards cycles before staging anything', () => {
    const snapshot = fixture()
    expect(planConnect(snapshot, id(1), id(1), '')).toEqual({ operations: [], error: 'STORY_CYCLE' })
    expect(planConnect(snapshot, id(1), id(2), '')).toEqual({ operations: [], error: 'STORY_EDGE_EXISTS' })
    expect(planConnect(snapshot, id(5), id(1), '')).toEqual({ operations: [], error: 'STORY_CYCLE' })
    expect(planConnect(snapshot, id(5), id(99), '')).toEqual({ operations: [], error: 'STORY_NODE_NOT_FOUND' })
    const plan = planConnect(snapshot, id(2), id(3), '改去海港')
    const result = domainResult(snapshot, plan)
    expect(result.edges.find(edge => edge.id === plan.selectedEdgeId)).toMatchObject({ from: id(2), to: id(3), label: '改去海港' })
    expect(result.routes).toEqual(snapshot.routes)
  })

  it('makes routes from explicit connected paths and refuses disconnected or repeated selections', () => {
    const snapshot = fixture()
    expect(planRouteFromPath(snapshot, [id(1), id(4)], '跳过事件')).toEqual({ operations: [], error: 'STORY_ROUTE_DISCONNECTED' })
    expect(planRouteFromPath(snapshot, [id(1), id(2), id(1)], '重入')).toEqual({ operations: [], error: 'STORY_ROUTE_INVALID' })
    expect(planRouteFromPath(snapshot, [], '空路线')).toEqual({ operations: [], error: 'STORY_ROUTE_INVALID' })
    const plan = planRouteFromPath(snapshot, [id(1), id(3), id(4), id(5)], '海港完整路线')
    const result = domainResult(snapshot, plan)
    expect(result.routes.find(route => route.id === plan.selectedRouteId)?.nodeIds).toEqual([id(1), id(3), id(4), id(5)])
  })

  it('refuses mismatched selected routes, invalid titles and duplicate merge entrances without partial plans', () => {
    const snapshot = fixture()
    expect(planContinue(snapshot, id(2), id(61), '后续').error).toBe('STORY_ROUTE_NODE_MISMATCH')
    expect(planFork(snapshot, id(2), id(61), ['甲', '乙']).error).toBe('STORY_ROUTE_NODE_MISMATCH')
    expect(planContinue(snapshot, id(2), null, '   ').operations).toEqual([])
    expect(planFork(snapshot, id(2), id(60), ['有效', '\0无效']).operations).toEqual([])
    expect(planMerge(snapshot, [id(2), id(2)], '汇合').operations).toEqual([])
    expect(planMerge(snapshot, [id(2)], '汇合').operations).toEqual([])
    expect(planMerge(snapshot, [id(2), id(99)], '汇合').error).toBe('STORY_NODE_NOT_FOUND')
  })

  it('respects node, edge, route and immutable history capacity before creating any records', () => {
    const snapshot = fixture()
    const fullNodes = { ...snapshot, nodes: Array.from({ length: 999 }, (_, index) => ({ ...snapshot.nodes[0], id: id(index + 1) })) }
    expect(planFork(fullNodes, id(1), null, ['甲', '乙']).error).toBe('STORY_SIZE_LIMIT')
    const fullRoutes = { ...snapshot, routes: Array.from({ length: 256 }, (_, index) => ({ id: id(index + 100), title: `路线${index}`, nodeIds: [id(1)] })) }
    expect(planRouteFromPath(fullRoutes, [id(1)], '新路线').error).toBe('STORY_SIZE_LIMIT')
    const fullEdges = { ...snapshot, edges: Array.from({ length: 4000 }, () => snapshot.edges[0]) }
    expect(planConnect(fullEdges, id(2), id(3), '').error).toBe('STORY_SIZE_LIMIT')
    const fullHistory = { ...snapshot, revisions: Array.from({ length: 20_000 }, () => snapshot.revisions[0]) }
    expect(planContinue(fullHistory, id(2), id(60), '后续').error).toBe('STORY_SIZE_LIMIT')
  })
})
