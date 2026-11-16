import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { StoryContext, StoryContextRequest, StoryEdge, StoryNode, StoryNodeInput, StoryNodeRevision,
  StoryNote, StoryNoteInput, StoryOperation, StoryRoute, StorySnapshot } from '../../src/shared/story-branches'
import type { StoryCommitOptions } from '../../src/shared/story-branch-ipc'
import { STORY_TABLES } from '../services/story-branch-schema'
import { MAINLINE_STORY_ROUTE_ID, isMainlineStoryNodeId, isMainlineStoryEdgeId, mainlineStoryChapterNumber } from '../../src/shared/story-branches'
import { compactMainlineStoryPath, mainlineStoryEdges, mainlineStoryRoute, missingMainlineStoryNode, readMainlineStoryNodes, resolveMainlineStoryPath } from '../services/story-mainline-projection'
import { assertLegacyStoryProjectionAcyclic, legacyStoryNodeAliases, projectLegacyStorySources } from '../services/story-legacy-source-projection'
import type { StoryProjectionAliases } from '../../src/shared/story-branches'

export type { StoryCommitOptions } from '../../src/shared/story-branch-ipc'
export { STORY_TABLES } from '../services/story-branch-schema'

type Db = Database.Database
export interface StoryData { nodes: StoryNode[]; edges: StoryEdge[]; routes: StoryRoute[]; notes: StoryNote[]; revisions: StoryNodeRevision[]; aliases?: StoryProjectionAliases }
export type StoryTable = typeof STORY_TABLES[number]
const keysByTable = { story_nodes: 'nodes', story_edges: 'edges', story_routes: 'routes', story_notes: 'notes', story_node_revisions: 'revisions' } as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const NODE_KEYS = ['id', 'kind', 'title', 'chapterNumber', 'event', 'body']
const OPTIONAL_NODE_KEYS = ['chapterBlueprint', 'chapterSource']
const MAX_JSON = 64 * 1024 * 1024
function fail(code: string): never { throw new Error(`STORY_${code}`) }
function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INPUT_INVALID')
}
function exactNode(value: unknown, extra: readonly string[] = []): asserts value is Record<string, unknown> {
  const optional = plain(value) ? OPTIONAL_NODE_KEYS.filter(key => Object.hasOwn(value, key)) : []
  exact(value, [...NODE_KEYS, ...optional, ...extra])
}
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) fail('ID_INVALID') }
function nodeId(value: unknown): asserts value is string { if (!isMainlineStoryNodeId(value)) id(value) }
function routeId(value: unknown): asserts value is string { if (value !== MAINLINE_STORY_ROUTE_ID) id(value) }
function text(value: unknown, limit: number, required = false): asserts value is string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0') || required && !value.trim()) fail('INPUT_INVALID')
}
function hash(value: unknown): string { return createHash('sha256').update(storyCanonicalJson(value)).digest('hex') }
/** Same serialization on each device; database row order and object insertion order are not authority. */
export function storyCanonicalJson(value: unknown): string {
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 24) fail('INPUT_INVALID')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1))
    if (!plain(item)) return fail('INPUT_INVALID')
    const keys = Object.keys(item).sort()
    if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail('INPUT_INVALID')
    return Object.fromEntries(keys.map(key => [key, visit(item[key], depth + 1)]))
  }
  const result = JSON.stringify(visit(value, 0))
  if (new TextEncoder().encode(result).length > MAX_JSON) fail('SIZE_LIMIT')
  return result
}
function nodeInput(value: unknown): asserts value is StoryNodeInput {
  exactNode(value); id(value.id)
  if (!['content', 'branch', 'merge'].includes(String(value.kind))) fail('INPUT_INVALID')
  text(value.title, 200, true); text(value.event, 20_000); text(value.body, 2_000_000)
  if (value.chapterNumber !== null && (!Number.isSafeInteger(value.chapterNumber) || Number(value.chapterNumber) < 1 || Number(value.chapterNumber) > 100_000)) fail('INPUT_INVALID')
  if (Object.hasOwn(value, 'chapterBlueprint')) {
    const blueprint = value.chapterBlueprint
    exact(blueprint, ['title', 'role', 'purpose', 'keyEvents', 'characters', 'suspenseHook', 'userGuidance', 'notes'])
    text(blueprint.title, 200)
    for (const field of ['role', 'purpose', 'keyEvents', 'suspenseHook', 'userGuidance', 'notes']) text(blueprint[field], 100_000)
    if (!Array.isArray(blueprint.characters) || blueprint.characters.length > 1000) fail('INPUT_INVALID')
    for (const character of blueprint.characters) text(character, 200, true)
  }
  if (Object.hasOwn(value, 'chapterSource')) {
    const source = value.chapterSource
    exact(source, ['chapterNumber', 'blueprintHash', 'manuscriptHash'])
    if (!Number.isSafeInteger(source.chapterNumber) || Number(source.chapterNumber) < 1 || Number(source.chapterNumber) > 100_000) fail('INPUT_INVALID')
    if (typeof source.blueprintHash !== 'string' || !HASH.test(source.blueprintHash)
      || typeof source.manuscriptHash !== 'string' || !HASH.test(source.manuscriptHash)) fail('INPUT_INVALID')
  }
}
function nodeAuthoringChanged(prior: StoryNodeInput, next: StoryNodeInput): boolean {
  return prior.body !== next.body || prior.event !== next.event
    || storyCanonicalJson(prior.chapterBlueprint ?? null) !== storyCanonicalJson(next.chapterBlueprint ?? null)
    || storyCanonicalJson(prior.chapterSource ?? null) !== storyCanonicalJson(next.chapterSource ?? null)
}
function noteInput(value: unknown): asserts value is StoryNoteInput {
  exact(value, ['id', 'routeId', 'nodeId', 'summary', 'characterStates', 'entryDifferences'])
  id(value.id); nodeId(value.nodeId); if (value.routeId !== null) routeId(value.routeId)
  text(value.summary, 100_000); text(value.characterStates, 100_000); text(value.entryDifferences, 100_000)
}
/** Validates one stored or incoming record before references are complete. */
export function validateStoryRecord(table: StoryTable, value: unknown): void {
  // Validate depth/prototypes even for fields whose later shape check will reject them.
  storyCanonicalJson(value)
  if (table === 'story_nodes') {
    exactNode(value, ['revisionId']); id(value.revisionId)
    const { revisionId: _revisionId, ...input } = value; nodeInput(input)
  } else if (table === 'story_edges') {
    exact(value, ['id', 'from', 'to', 'label', 'condition']); id(value.id); nodeId(value.from); nodeId(value.to)
    text(value.label, 200); text(value.condition, 4000); if (value.from === value.to) fail('CYCLE')
  } else if (table === 'story_routes') {
    exact(value, ['id', 'title', 'nodeIds']); id(value.id); text(value.title, 200, true)
    if (!Array.isArray(value.nodeIds) || !value.nodeIds.length || value.nodeIds.length > 1000) fail('ROUTE_INVALID')
    value.nodeIds.forEach(nodeId); if (new Set(value.nodeIds).size !== value.nodeIds.length) fail('ROUTE_INVALID')
  } else if (table === 'story_notes') {
    exact(value, ['id', 'routeId', 'nodeId', 'summary', 'characterStates', 'entryDifferences', 'sourceHash', 'confirmed'])
    const { sourceHash, confirmed, ...input } = value; noteInput(input)
    if (typeof sourceHash !== 'string' || !HASH.test(sourceHash) || typeof confirmed !== 'boolean') fail('INPUT_INVALID')
  } else if (table === 'story_node_revisions') {
    exact(value, ['id', 'nodeId', 'parentRevisionId', 'node']); id(value.id); id(value.nodeId)
    if (value.parentRevisionId !== null) id(value.parentRevisionId)
    nodeInput(value.node); if (value.node.id !== value.nodeId || value.parentRevisionId === value.id) fail('REVISION_INVALID')
  } else fail('INPUT_INVALID')
}
function index<T extends { id: string }>(items: T[]): Map<string, T> {
  const result = new Map(items.map(item => [item.id, item]))
  if (result.size !== items.length) fail('DUPLICATE_ID')
  return result
}
export function validateStoryData(input: unknown): asserts input is StoryData {
  exact(input, ['nodes', 'edges', 'routes', 'notes', 'revisions'])
  const data = input as unknown as StoryData
  const caps = { nodes: 1000, edges: 4000, routes: 256, notes: 4000, revisions: 20_000 }
  for (const table of STORY_TABLES) {
    const key = keysByTable[table], items = data[key]
    if (!Array.isArray(items) || items.length > caps[key]) fail('SIZE_LIMIT')
    for (const item of items) validateStoryRecord(table, item)
  }
  storyCanonicalJson(data)
  const nodes = index(data.nodes), edges = index(data.edges), routes = index(data.routes), revisions = index(data.revisions)
  index(data.notes)
  const references = [...data.edges.flatMap(edge => [edge.from, edge.to]), ...data.routes.flatMap(route => route.nodeIds), ...data.notes.map(note => note.nodeId)]
  const virtual = [...new Set(references.filter(isMainlineStoryNodeId))].sort((left, right) => mainlineStoryChapterNumber(left)! - mainlineStoryChapterNumber(right)!)
  const pairs = new Set<string>(), successors = new Map<string, string[]>(), indegrees = new Map([...data.nodes.map(node => node.id), ...virtual].map(id => [id, 0]))
  const addEdge = (from: string, to: string) => {
    pairs.add(`${from}:${to}`); successors.set(from, [...(successors.get(from) ?? []), to]); indegrees.set(to, indegrees.get(to)! + 1)
  }
  for (let offset = 1; offset < virtual.length; offset++) addEdge(virtual[offset - 1], virtual[offset])
  for (const edge of edges.values()) {
    if (!indegrees.has(edge.from) || !indegrees.has(edge.to)) fail('REFERENCE_INVALID')
    addEdge(edge.from, edge.to)
  }
  const queue = [...indegrees].filter(([, count]) => !count).map(([nodeId]) => nodeId)
  let visited = 0
  for (let offset = 0; offset < queue.length; offset++) {
    visited++
    for (const next of successors.get(queue[offset]!) ?? []) {
      const remaining = indegrees.get(next)! - 1; indegrees.set(next, remaining)
      if (!remaining) queue.push(next)
    }
  }
  if (visited !== indegrees.size) fail('CYCLE')
  const aliases = legacyStoryNodeAliases(data)
  const resolve = (nodeId: string) => aliases[nodeId] ?? nodeId
  const projectedPairs = new Set(data.edges.map(edge => JSON.stringify([resolve(edge.from), resolve(edge.to)])))
  for (const route of routes.values()) {
    if (route.nodeIds.some(nodeId => !nodes.has(nodeId) && !isMainlineStoryNodeId(nodeId))) fail('REFERENCE_INVALID')
    if (route.nodeIds.some((nodeId, offset) => offset > 0 && !pairs.has(`${route.nodeIds[offset - 1]}:${nodeId}`)
      && !projectedPairs.has(JSON.stringify([resolve(route.nodeIds[offset - 1]), resolve(nodeId)]))
      && !(isMainlineStoryNodeId(resolve(route.nodeIds[offset - 1])) && isMainlineStoryNodeId(resolve(nodeId))
        && mainlineStoryChapterNumber(resolve(route.nodeIds[offset - 1]))! < mainlineStoryChapterNumber(resolve(nodeId))!))) fail('ROUTE_DISCONNECTED')
  }
  const anchors = new Set<string>()
  for (const note of data.notes) {
    const node = nodes.get(note.nodeId), route = note.routeId === null ? null : routes.get(note.routeId)
    if (!node && !isMainlineStoryNodeId(note.nodeId)
      || note.routeId !== null && note.routeId !== MAINLINE_STORY_ROUTE_ID && (!route || !route.nodeIds.includes(note.nodeId))
      || note.routeId === MAINLINE_STORY_ROUTE_ID && !isMainlineStoryNodeId(note.nodeId)
      || note.routeId === null && node && !['merge', 'content'].includes(node.kind)) fail('REFERENCE_INVALID')
    const anchor = `${note.routeId ?? 'shared'}:${note.nodeId}`
    if (anchors.has(anchor)) fail('DUPLICATE_NOTE'); anchors.add(anchor)
  }
  for (const node of nodes.values()) {
    const revision = revisions.get(node.revisionId)
    const { revisionId: _revisionId, ...input } = node
    if (!revision || revision.nodeId !== node.id || storyCanonicalJson(revision.node) !== storyCanonicalJson(input)) fail('REVISION_INVALID')
  }
  const complete = new Set<string>()
  for (const revision of revisions.values()) {
    const chain = new Set<string>(); let current: StoryNodeRevision | undefined = revision
    while (current && !complete.has(current.id)) {
      if (chain.has(current.id)) fail('REVISION_INVALID'); chain.add(current.id)
      if (current.parentRevisionId === null) break
      const parent = revisions.get(current.parentRevisionId)
      if (!parent || parent.nodeId !== current.nodeId) fail('REVISION_INVALID')
      current = parent
    }
    for (const revisionId of chain) complete.add(revisionId)
  }
}
function sorted<T extends { id: string }>(items: T[]): T[] { return [...items].sort((a, b) => a.id.localeCompare(b.id)) }
function snapshot(data: StoryData): StorySnapshot {
  const body = { nodes: sorted(data.nodes), edges: sorted(data.edges), routes: sorted(data.routes), notes: sorted(data.notes), ...(data.aliases ? { aliases: data.aliases } : {}) }
  return { ...body, revisions: sorted(data.revisions), revision: hash({ ...body, nodes: body.nodes.map(node => node.mainline ? { id: node.id, revisionId: node.revisionId, mainline: node.mainline } : node) }) }
}
function projectStoryData(db: Db, data: StoryData): StoryData {
  const mainline = readMainlineStoryNodes(db)
  data = projectLegacyStorySources(data, mainline)
  const present = new Set(mainline.map(node => node.id))
  const refs = [...data.edges.flatMap(edge => [edge.from, edge.to]), ...data.routes.flatMap(route => route.nodeIds), ...data.notes.map(note => note.nodeId)]
  const missing = [...new Set(refs.filter(isMainlineStoryNodeId))].filter(id => !present.has(id)).map(id => missingMainlineStoryNode(id))
  const route = mainlineStoryRoute(mainline)
  const pairs = new Set(data.edges.map(edge => JSON.stringify([edge.from, edge.to])))
  return { ...data, nodes: [...data.nodes, ...mainline, ...missing], edges: [...data.edges, ...mainlineStoryEdges(mainline).filter(edge => !pairs.has(JSON.stringify([edge.from, edge.to])))],
    routes: [...data.routes.map(route => ({ ...route, nodeIds: resolveMainlineStoryPath(route.nodeIds, mainline) })), ...(route ? [route] : [])] }
}
function projectedSnapshot(db: Db, data: StoryData): StorySnapshot { return snapshot(projectStoryData(db, data)) }
function readData(db: Db): StoryData {
  const data = Object.fromEntries(STORY_TABLES.map(table => [keysByTable[table], db.prepare(`SELECT id,payload_json FROM ${table} ORDER BY id`).all().map(raw => {
    const row = raw as { id: string; payload_json: string }
    if (row.payload_json.length > MAX_JSON) fail('SIZE_LIMIT')
    let value: unknown; try { value = JSON.parse(row.payload_json) } catch { return fail('INPUT_INVALID') }
    validateStoryRecord(table, value)
    if ((value as { id: string }).id !== row.id) fail('ID_INVALID')
    return value
  })])) as unknown as StoryData
  validateStoryData(data)
  return data
}
function context(data: StoryData, request: StoryContextRequest): StoryContext {
  exact(request, ['nodeId', 'routeId', 'mode', ...(plain(request) && Object.hasOwn(request, 'bridgeToNodeId') ? ['bridgeToNodeId'] : [])]); nodeId(request.nodeId)
  request = { ...request, nodeId: data.aliases?.nodes[request.nodeId] ?? request.nodeId,
    routeId: request.routeId ? data.aliases?.routes[request.routeId] ?? request.routeId : null,
    ...(request.bridgeToNodeId ? { bridgeToNodeId: data.aliases?.nodes[request.bridgeToNodeId] ?? request.bridgeToNodeId } : {}) }
  if (!['route', 'shared'].includes(String(request.mode))) fail('INPUT_INVALID')
  const nodes = index(data.nodes), target = nodes.get(request.nodeId)
  if (!target) fail('NODE_NOT_FOUND')
  let continuation: StoryContext['continuation']
  if (Object.hasOwn(request, 'bridgeToNodeId')) {
    nodeId(request.bridgeToNodeId)
    const node = nodes.get(request.bridgeToNodeId)
    const edge = sorted(data.edges).find(edge => edge.from === target.id && edge.to === request.bridgeToNodeId)
    if (!node || node.id === target.id || !edge) fail('CONTINUATION_INVALID')
    continuation = { node, edge }
  }
  const allEntrances = sorted(data.routes).flatMap(route => {
    const offset = route.nodeIds.indexOf(target.id)
    return offset >= 0 ? [{ routeId: route.id, title: route.title, nodeIds: route.nodeIds.slice(0, offset + 1) }] : []
  })
  const hasDifferentEntrances = new Set(allEntrances.map(entrance => JSON.stringify(entrance.nodeIds.slice(0, -1)))).size > 1
  let entrances: StoryContext['entrances'], prefix: StoryNode[]
  if (request.mode === 'route') {
    routeId(request.routeId)
    const route = data.routes.find(item => item.id === request.routeId), offset = route?.nodeIds.indexOf(target.id) ?? -1
    if (!route || offset < 0) fail('ROUTE_INVALID')
    entrances = [{ routeId: route.id, title: route.title, nodeIds: route.nodeIds.slice(0, offset + 1) }]
    prefix = route.nodeIds.slice(0, offset).map(nodeId => nodes.get(nodeId)!)
  } else {
    if (request.routeId !== null || !['merge', 'content'].includes(target.kind) || !hasDifferentEntrances) fail('SHARED_CONTEXT_INVALID')
    entrances = allEntrances
    const first = entrances[0]!.nodeIds.slice(0, -1)
    let sharedLength = 0
    while (sharedLength < first.length && entrances.every(entrance => entrance.nodeIds[sharedLength] === first[sharedLength])) sharedLength++
    prefix = first.slice(0, sharedLength).map(nodeId => nodes.get(nodeId)!)
  }
  const relevant = entrances.map(entrance => ({ ...entrance,
    prefix: entrance.nodeIds.slice(0, -1).map(nodeId => nodes.get(nodeId)!),
    edges: entrance.nodeIds.slice(1).map((nodeId, offset) => sorted(data.edges.filter(edge => edge.from === entrance.nodeIds[offset] && edge.to === nodeId))),
  }))
  const sources = [target, ...prefix, ...(continuation ? [continuation.node] : []),
    ...relevant.flatMap(entrance => entrance.prefix)]
  if (sources.some(node => node.mainline && ['missing', 'unavailable'].includes(node.mainline.manuscriptStatus))) fail('CHAPTER_NOT_FOUND')
  if (relevant.some(entrance => entrance.edges.some(edges => edges.length === 0))) fail('ROUTE_DISCONNECTED')
  const sourceHash = hash({ mode: request.mode, target: { id: target.id, kind: target.kind }, entrances: relevant })
  const note = data.notes.find(item => item.nodeId === target.id && item.routeId === request.routeId) ?? null
  const noteCurrent = Boolean(note?.confirmed && note.sourceHash === sourceHash)
  const readyForGeneration = request.mode === 'route' ? !hasDifferentEntrances : Boolean(noteCurrent && note!.summary.trim() && note!.entryDifferences.trim())
  const contextHash = hash({ sourceHash, target, note: noteCurrent ? note : null, readyForGeneration, ...(continuation ? { continuation } : {}) })
  return { request, sourceHash, contextHash, target, prefix, entrances, note, noteCurrent, readyForGeneration, ...(continuation ? { continuation } : {}) }
}
function persist(db: Db, before: StoryData, after: StoryData): void {
  for (const table of STORY_TABLES) {
    const key = keysByTable[table], old = index<{ id: string }>(before[key]), current = index<{ id: string }>(after[key])
    for (const prior of old.values()) if (!current.has(prior.id)) {
      if (table === 'story_node_revisions') fail('REVISION_IMMUTABLE')
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(prior.id)
    }
    for (const item of current.values()) {
      const value = storyCanonicalJson(item), prior = old.get(item.id)
      if (prior && storyCanonicalJson(prior) === value) continue
      if (table === 'story_node_revisions' && prior) fail('REVISION_IMMUTABLE')
      db.prepare(`INSERT INTO ${table}(id,payload_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`).run(item.id, value)
    }
  }
}
export class StoryBranchRepository {
  /** Sync uses the same admitted view as local commits before any raw row changes. */
  static assertProjectionMutation(db: Db, after: StoryData): void {
    const before = readData(db), mainline = readMainlineStoryNodes(db)
    const aliases = legacyStoryNodeAliases(before, mainline)
    assertLegacyStoryProjectionAcyclic(after, mainline, aliases)
  }
  static read(db: Db): StorySnapshot {
    const read = () => projectedSnapshot(db, readData(db))
    return db.inTransaction ? read() : db.transaction(read)()
  }
  static context(db: Db, request: StoryContextRequest): StoryContext {
    const read = () => context(projectStoryData(db, readData(db)), request)
    return db.inTransaction ? read() : db.transaction(read)()
  }
  static commit(db: Db, expectedRevision: string, operations: StoryOperation[], options: StoryCommitOptions = {}): StorySnapshot {
    if (typeof expectedRevision !== 'string' || !HASH.test(expectedRevision) || !Array.isArray(operations) || !operations.length || operations.length > 2000) fail('INPUT_INVALID')
    storyCanonicalJson(operations)
    return db.transaction(() => {
      const before = readData(db)
      if (projectedSnapshot(db, before).revision !== expectedRevision) fail('REVISION_STALE')
      if (options.expectedContext) {
        const current = context(projectStoryData(db, before), options.expectedContext.request)
        if (!current.readyForGeneration) fail('CONTEXT_UNCONFIRMED')
        if (current.contextHash !== options.expectedContext.contextHash) fail('CONTEXT_STALE')
      }
      const data: StoryData = JSON.parse(JSON.stringify(before)) as StoryData
      const put = <T extends { id: string }>(items: T[], value: T) => {
        const offset = items.findIndex(item => item.id === value.id)
        if (offset < 0) items.push(value); else items[offset] = value
      }
      const remove = <T extends { id: string }>(items: T[], value: string) => { id(value); const offset = items.findIndex(item => item.id === value); if (offset < 0) fail('RECORD_NOT_FOUND'); items.splice(offset, 1) }
      const editNode = (input: StoryNodeInput, restoredParent: string | null = null) => {
        if (isMainlineStoryNodeId(input?.id)) fail('MAINLINE_READ_ONLY')
        nodeInput(input)
        const prior = data.nodes.find(item => item.id === input.id)
        if (prior) {
          const { revisionId: _revisionId, ...priorInput } = prior
          if (storyCanonicalJson(priorInput) === storyCanonicalJson(input)) return
          if (options.expectedContext && options.expectedContext.request.nodeId !== input.id
            && nodeAuthoringChanged(prior, input)) fail('CONTEXT_SCOPE_MISMATCH')
          if (nodeAuthoringChanged(prior, input) && data.routes.filter(route => route.nodeIds.includes(input.id)).length > 1 && options.confirmedSharedEdit !== true) fail('SHARED_EDIT_CONFIRMATION_REQUIRED')
        }
        const revisionId = randomUUID()
        data.revisions.push({ id: revisionId, nodeId: input.id, parentRevisionId: prior?.revisionId ?? restoredParent, node: input })
        put(data.nodes, { ...input, revisionId })
      }
      for (const operation of operations) {
        if (!plain(operation) || typeof operation.type !== 'string') fail('INPUT_INVALID')
        if (operation.type === 'put-node') { exact(operation, ['type', 'node']); editNode(operation.node) }
        else if (operation.type === 'delete-node') { exact(operation, ['type', 'id']); if (isMainlineStoryNodeId(operation.id)) fail('MAINLINE_READ_ONLY'); remove(data.nodes, operation.id) }
        else if (operation.type === 'restore-node') {
          if (isMainlineStoryNodeId(operation.id)) fail('MAINLINE_READ_ONLY')
          exact(operation, ['type', 'id', 'revisionId']); id(operation.id); id(operation.revisionId)
          const revision = data.revisions.find(item => item.id === operation.revisionId && item.nodeId === operation.id)
          if (!revision) fail('REVISION_INVALID'); editNode(revision.node, revision.id)
        } else if (operation.type === 'put-edge') { exact(operation, ['type', 'edge']); if (isMainlineStoryEdgeId(operation.edge?.id)) fail('MAINLINE_READ_ONLY'); validateStoryRecord('story_edges', operation.edge); put(data.edges, operation.edge) }
        else if (operation.type === 'delete-edge') { exact(operation, ['type', 'id']); if (isMainlineStoryEdgeId(operation.id)) fail('MAINLINE_READ_ONLY'); remove(data.edges, operation.id) }
        else if (operation.type === 'put-route') { exact(operation, ['type', 'route']); if (operation.route?.id === MAINLINE_STORY_ROUTE_ID) fail('MAINLINE_READ_ONLY'); validateStoryRecord('story_routes', operation.route); put(data.routes, { ...operation.route, nodeIds: compactMainlineStoryPath(operation.route.nodeIds, readMainlineStoryNodes(db)) }) }
        else if (operation.type === 'delete-route') { exact(operation, ['type', 'id']); if (operation.id === MAINLINE_STORY_ROUTE_ID) fail('MAINLINE_READ_ONLY'); remove(data.routes, operation.id) }
        else if (operation.type === 'put-note') {
          exact(operation, ['type', 'note', 'expectedSourceHash', 'confirm']); noteInput(operation.note)
          if (typeof operation.confirm !== 'boolean') fail('INPUT_INVALID')
          if (options.expectedContext && (options.expectedContext.request.nodeId !== operation.note.nodeId
            || options.expectedContext.request.routeId !== operation.note.routeId)) fail('CONTEXT_SCOPE_MISMATCH')
          const prior = data.notes.find(item => item.id === operation.note.id)
          if (prior && (prior.nodeId !== operation.note.nodeId || prior.routeId !== operation.note.routeId)) fail('REFERENCE_INVALID')
          validateStoryData(data)
          const current = context(projectStoryData(db, data), { nodeId: operation.note.nodeId, routeId: operation.note.routeId, mode: operation.note.routeId === null ? 'shared' : 'route' })
          if (current.sourceHash !== operation.expectedSourceHash) fail('CONTEXT_STALE')
          put(data.notes, { ...operation.note, sourceHash: current.sourceHash, confirmed: operation.confirm })
        } else if (operation.type === 'delete-note') { exact(operation, ['type', 'id']); remove(data.notes, operation.id) }
        else fail('INPUT_INVALID')
      }
      validateStoryData(data)
      const mainline = readMainlineStoryNodes(db)
      assertLegacyStoryProjectionAcyclic(data, mainline, legacyStoryNodeAliases(before, mainline))
      // A temporary route deletion in the same batch must not bypass the shared-edit warning.
      if (options.confirmedSharedEdit !== true) for (const node of data.nodes) {
        const prior = before.nodes.find(item => item.id === node.id)
        if (prior && nodeAuthoringChanged(prior, node)
          && (before.routes.filter(route => route.nodeIds.includes(node.id)).length > 1
            || data.routes.filter(route => route.nodeIds.includes(node.id)).length > 1)) fail('SHARED_EDIT_CONFIRMATION_REQUIRED')
      }
      persist(db, before, data)
      return projectedSnapshot(db, data)
    }).immediate()
  }
}
