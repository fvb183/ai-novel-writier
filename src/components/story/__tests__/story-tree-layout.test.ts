import { describe, expect, it } from 'vitest'
import type { StorySnapshot } from '../../../shared/story-branches'
import { layoutStoryTree, STORY_TREE_EDGE_LABEL_WIDTH, visibleStoryNodeIds } from '../story-tree-layout'

function story(): StorySnapshot {
  const nodes = ['start', 'left', 'right', 'merge', 'ending', 'side'].map(id => ({
    id, kind: id === 'start' ? 'branch' as const : id === 'merge' ? 'merge' as const : 'content' as const,
    title: id, chapterNumber: null, event: '', body: '', revisionId: `version-${id}`,
  }))
  const links = [['start', 'left'], ['start', 'right'], ['left', 'merge'], ['right', 'merge'], ['merge', 'ending'], ['left', 'side']]
  return { revision: 'current', nodes, edges: links.map(([from, to], index) => ({ id: `edge-${index}`, from, to, label: '', condition: '' })), routes: [], notes: [], revisions: [] }
}
function chain(ids: string[]): StorySnapshot {
  const base = story()
  return { ...base, nodes: ids.map(id => ({ ...base.nodes[0], id, title: id, kind: 'content' })),
    edges: ids.slice(1).map((to, index) => ({ id: `chain-${index}`, from: ids[index], to, label: '继续', condition: '' })) }
}

describe('story tree layout', () => {
  it('keeps the common merge and its later prose visible through an expanded entrance', () => {
    const snapshot = story()
    const visible = visibleStoryNodeIds(snapshot, ['left'])
    expect(visible.has('side')).toBe(false)
    expect(visible.has('merge')).toBe(true)
    expect(visible.has('ending')).toBe(true)
    const layout = layoutStoryTree(snapshot, ['left'])
    expect(layout.edges.some(item => item.edge.from === 'left')).toBe(false)
    expect(layout.edges.some(item => item.edge.from === 'right' && item.edge.to === 'merge')).toBe(true)
  })

  it('hides all later nodes when the common beginning is collapsed and restores them without mutation', () => {
    const snapshot = story(), before = structuredClone(snapshot)
    expect([...visibleStoryNodeIds(snapshot, ['start'])]).toEqual(['start'])
    expect(layoutStoryTree(snapshot, ['start']).hiddenCount).toBe(5)
    expect(visibleStoryNodeIds(snapshot).size).toBe(6)
    expect(snapshot).toEqual(before)
  })

  it('preserves disconnected roots when another tree is collapsed', () => {
    const snapshot = story()
    snapshot.nodes.push({ ...snapshot.nodes[0], id: 'independent', title: 'Independent' })
    expect(visibleStoryNodeIds(snapshot, ['start'])).toEqual(new Set(['start', 'independent']))
  })

  it('keeps every edge moving down and separates cards in every level', () => {
    const layout = layoutStoryTree(story())
    const positions = new Map(layout.nodes.map(item => [item.node.id, item]))
    for (const { edge } of layout.edges) expect(positions.get(edge.from)!.y + positions.get(edge.from)!.height).toBeLessThan(positions.get(edge.to)!.y)
    for (const node of layout.nodes) for (const other of layout.nodes) {
      if (node.node.id === other.node.id || node.y !== other.y) continue
      expect(node.x + node.width <= other.x || other.x + other.width <= node.x).toBe(true)
    }
  })

  it('does not move nodes when preview replaces or reorders text records', () => {
    const snapshot = story()
    const before = layoutStoryTree(snapshot).nodes.map(({ node, ...position }) => ({ id: node.id, ...position }))
    snapshot.nodes.reverse()
    snapshot.edges.reverse()
    snapshot.nodes[0] = { ...snapshot.nodes[0], body: 'A long new manuscript', title: 'Edited title', revisionId: 'new-version' }
    const after = layoutStoryTree(snapshot).nodes.map(({ node, ...position }) => ({ id: node.id, ...position }))
    expect(after).toEqual(before)
  })

  it('keeps temporarily invalid cyclic components inspectable beside a valid tree', () => {
    const snapshot = story()
    snapshot.nodes.push(...['bad-a', 'bad-b'].map(id => ({ ...snapshot.nodes[0], id })))
    snapshot.edges.push({ id: 'bad-1', from: 'bad-a', to: 'bad-b', label: '', condition: '' }, { id: 'bad-2', from: 'bad-b', to: 'bad-a', label: '', condition: '' })
    expect(visibleStoryNodeIds(snapshot, ['start'])).toEqual(new Set(['start', 'bad-a', 'bad-b']))
    expect(layoutStoryTree(snapshot, ['start']).nodes).toHaveLength(3)
  })

  it('returns usable dimensions for an empty or deeply nested tree', () => {
    const snapshot = story()
    expect(layoutStoryTree({ ...snapshot, nodes: [], edges: [] })).toMatchObject({ nodes: [], edges: [], hiddenCount: 0 })
    snapshot.edges = snapshot.nodes.slice(1).map((node, index) => ({ id: `chain-${index}`, from: snapshot.nodes[index].id, to: node.id, label: '', condition: '' }))
    const layout = layoutStoryTree(snapshot)
    expect(layout.nodes.at(-1)!.y).toBeLessThan(layout.height)
    expect(layout.edges).toHaveLength(5)
  })

  it('routes an original A→C bypass outside the inserted B card with an unobscured label', () => {
    const snapshot = chain(['A', 'B', 'C'])
    snapshot.edges.push({ id: 'original-bypass', from: 'A', to: 'C', label: '原路线：跳过插章', condition: '保持原走向' })
    const layout = layoutStoryTree(snapshot), middle = layout.nodes.find(item => item.node.id === 'B')!
    const bypass = layout.edges.find(item => item.edge.id === 'original-bypass')!
    expect(bypass.bypassLane).toBeDefined()
    expect(bypass.bypassLane!.x < middle.x || bypass.bypassLane!.x > middle.x + middle.width).toBe(true)
    expect(bypass.labelX - STORY_TREE_EDGE_LABEL_WIDTH / 2 >= middle.x + middle.width
      || bypass.labelX + STORY_TREE_EDGE_LABEL_WIDTH / 2 <= middle.x).toBe(true)
    expect(bypass.labelX - STORY_TREE_EDGE_LABEL_WIDTH / 2).toBeGreaterThanOrEqual(0)
    expect(bypass.labelX + STORY_TREE_EDGE_LABEL_WIDTH / 2).toBeLessThanOrEqual(layout.width)
    for (let index = 1; index < bypass.waypoints!.length; index++) {
      const from = bypass.waypoints![index - 1], to = bypass.waypoints![index]
      const crossesVertically = from.x === to.x && from.x > middle.x && from.x < middle.x + middle.width
        && Math.max(from.y, to.y) > middle.y && Math.min(from.y, to.y) < middle.y + middle.height
      const crossesHorizontally = from.y === to.y && from.y > middle.y && from.y < middle.y + middle.height
        && Math.max(from.x, to.x) > middle.x && Math.min(from.x, to.x) < middle.x + middle.width
      expect(crossesVertically || crossesHorizontally).toBe(false)
    }
    expect(bypass.path).toContain(' Q')
    expect(layout.edges.filter(item => item.edge.id.startsWith('chain-')).every(item => !item.bypassLane)).toBe(true)
  })

  it('separates overlapping bypasses on stable outer lanes and keeps all labels in the canvas', () => {
    const snapshot = chain(['A', 'B', 'C', 'D', 'E'])
    snapshot.edges.push(...[['A', 'C'], ['A', 'D'], ['B', 'D'], ['B', 'E']].map(([from, to], index) => ({ id: `bypass-${index}`, from, to, label: '保留走向', condition: '' })))
    const layout = layoutStoryTree(snapshot), bypasses = layout.edges.filter(item => item.bypassLane)
    expect(new Set(bypasses.map(item => item.bypassLane!.x)).size).toBe(4)
    expect(new Set(bypasses.map(item => item.bypassLane!.side))).toEqual(new Set(['left', 'right']))
    for (const edge of bypasses) {
      expect(edge.labelX - STORY_TREE_EDGE_LABEL_WIDTH / 2).toBeGreaterThanOrEqual(0)
      expect(edge.labelX + STORY_TREE_EDGE_LABEL_WIDTH / 2).toBeLessThanOrEqual(layout.width)
      for (const point of edge.waypoints!) {
        expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(layout.width)
        expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(layout.height)
      }
    }
    snapshot.nodes.reverse(); snapshot.edges.reverse()
    expect(layoutStoryTree(snapshot).edges).toEqual(layout.edges)
  })

  it('reuses outer lanes after an earlier bypass ends instead of growing the tree width', () => {
    const snapshot = chain(['A', 'B', 'C', 'D', 'E'])
    snapshot.edges.push({ id: 'bypass-1', from: 'A', to: 'C', label: '', condition: '' }, { id: 'bypass-2', from: 'C', to: 'E', label: '', condition: '' })
    const layout = layoutStoryTree(snapshot), bypasses = layout.edges.filter(item => item.bypassLane)
    expect(bypasses[0].bypassLane).toEqual(bypasses[1].bypassLane)
    expect(layout.width).toBeLessThan(700)
  })
})
