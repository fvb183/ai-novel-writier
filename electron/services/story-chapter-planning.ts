import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { StoryBranchRepository } from '../repositories/story-branch-repository'
import type { StoryForkChapterInput, StoryForkChapterResult } from '../../src/shared/story-branch-ipc'
import { isMainlineStoryNodeId, mainlineStoryNodeId, type StoryNodeInput, type StoryOperation } from '../../src/shared/story-branches'

const fail = (code: string): never => { throw new Error(`STORY_${code}`) }
/** Only a branch and its live chapter anchors are stored. Canonical chapters stay canonical. */
export function forkStoryFromChapter(db: Database.Database, input: StoryForkChapterInput): StoryForkChapterResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 4 || !['expectedRevision', 'afterChapter', 'title', 'placement'].every(key => Object.hasOwn(input, key))
    || typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)
    || !Number.isSafeInteger(input.afterChapter) || input.afterChapter < 1 || input.afterChapter >= 100_000
    || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || input.title.includes('\0')
    || !['branch', 'insert'].includes(input.placement)) fail('INPUT_INVALID')
  return db.transaction(() => {
    const before = StoryBranchRepository.read(db)
    if (before.revision !== input.expectedRevision) fail('REVISION_STALE')
    const mainline = before.nodes.filter(node => isMainlineStoryNodeId(node.id) && node.mainline?.manuscriptStatus !== 'missing')
      .sort((left, right) => left.chapterNumber! - right.chapterNumber!)
    const parent = mainline.find(node => node.id === mainlineStoryNodeId(input.afterChapter))
    if (!parent || parent.mainline?.manuscriptStatus === 'unavailable') fail('CHAPTER_NOT_FOUND')
    const next = mainline[mainline.findIndex(node => node.id === parent!.id) + 1]
    if (input.placement === 'insert' && !next) fail('CHAPTER_NEXT_REQUIRED')
    if (input.placement === 'insert' && next?.mainline?.manuscriptStatus === 'unavailable') fail('CHAPTER_SOURCE_INVALID')
    const node: StoryNodeInput = { id: randomUUID(), kind: 'content', title: input.title, chapterNumber: input.afterChapter + 1,
      body: '', event: '', chapterBlueprint: { title: input.title, role: '发展', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '', notes: '' } }
    const path = [parent!.id, node.id]
    const operations: StoryOperation[] = [{ type: 'put-node', node },
      { type: 'put-edge', edge: { id: randomUUID(), from: parent!.id, to: node.id, label: input.title, condition: '' } }]
    if (input.placement === 'insert') {
      path.push(next.id)
      operations.push({ type: 'put-edge', edge: { id: randomUUID(), from: node.id, to: next.id, label: '', condition: '' } })
    }
    const routeId = randomUUID()
    operations.push({ type: 'put-route', route: { id: routeId, title: input.title, nodeIds: path } })
    return { snapshot: StoryBranchRepository.commit(db, before.revision, operations), nodeId: node.id, routeId }
  }).immediate()
}
