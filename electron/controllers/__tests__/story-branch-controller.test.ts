import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getCurrentProjectPath, getProjectDb } from '../../database'
import { projectAccess } from '../../services/project-access'
import { STORY_BRANCH_SQL } from '../../services/story-branch-schema'
import { StoryBranchRepository } from '../../repositories/story-branch-repository'
import { registerStoryBranchController } from '../story-branch-controller'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler)) } }))
vi.mock('../../database', () => ({ getCurrentProjectPath: vi.fn(), getProjectDb: vi.fn() }))
vi.mock('../../services/project-access', () => ({ projectAccess: { assertCurrentProjectContext: vi.fn() } }))
let db: Database.Database
const session = { projectId: randomUUID(), projectPath: 'story-project', leaseId: randomUUID() }
beforeEach(() => {
  db = new Database(':memory:'); db.exec(STORY_BRANCH_SQL)
  vi.mocked(getCurrentProjectPath).mockReturnValue('story-project')
  vi.mocked(getProjectDb).mockReturnValue(db)
  vi.mocked(projectAccess.assertCurrentProjectContext).mockImplementation(context => {
    if (!context || context.projectId !== session.projectId || context.leaseId !== session.leaseId || context.projectPath !== session.projectPath) throw new Error('stale lease')
    return { ...session, rootPath: session.projectPath, kind: 'manifest' }
  })
  handlers.clear(); registerStoryBranchController()
})
afterEach(() => { db.close(); vi.clearAllMocks() })
const invoke = (name: string, input: unknown) => handlers.get(name)!({}, input) as Record<string, unknown>

it('rejects missing, stale and cross-project leases for every story channel before touching author data', () => {
  const before = StoryBranchRepository.read(db)
  for (const channel of ['story:read', 'story:commit', 'story:context', 'story:fork-chapter']) {
    for (const projectSession of [undefined, { ...session, leaseId: randomUUID() }, { ...session, projectId: randomUUID() }]) {
      expect(invoke(channel, { projectSession })).toEqual({ success: false, error: 'STORY_SESSION_STALE' })
    }
  }
  expect(StoryBranchRepository.read(db)).toEqual(before)
})
it('reads and commits only through the current database and preserves author data on a stale revision', () => {
  const initial = invoke('story:read', { projectSession: session })
  expect(initial.success).toBe(true)
  const node = { id: randomUUID(), kind: 'content', title: '开场', chapterNumber: 1, event: '开场事件', body: '开场正文' }
  const result = invoke('story:commit', { projectSession: session, expectedRevision: (initial.data as { revision: string }).revision,
    operations: [{ type: 'put-node', node }] })
  expect(result.success).toBe(true)
  expect(StoryBranchRepository.read(db).nodes[0]?.body).toBe('开场正文')
  expect(invoke('story:commit', { projectSession: session, expectedRevision: (initial.data as { revision: string }).revision,
    operations: [{ type: 'put-node', node: { ...node, body: '过期正文' } }] })).toEqual({ success: false, error: 'STORY_REVISION_STALE' })
  expect(StoryBranchRepository.read(db).nodes[0]?.body).toBe('开场正文')
  expect(projectAccess.assertCurrentProjectContext).toHaveBeenCalledWith(session, 'story-project')
})
it('accepts the typed flat context request and rejects an invalid shared-edit confirmation flag', () => {
  const node = { id: randomUUID(), kind: 'content' as const, title: '开场', chapterNumber: 1, event: '', body: '正文' }, route = { id: randomUUID(), title: '主路线', nodeIds: [node.id] }
  StoryBranchRepository.commit(db, StoryBranchRepository.read(db).revision, [{ type: 'put-node', node }, { type: 'put-route', route }])
  const result = invoke('story:context', { projectSession: session, nodeId: node.id, routeId: route.id, mode: 'route' })
  expect(result.success).toBe(true)
  expect(result.data).toMatchObject({ target: { id: node.id }, prefix: [], readyForGeneration: true })
  expect(invoke('story:commit', { projectSession: session, confirmedSharedEdit: 'yes' })).toEqual({ success: false, error: 'STORY_INPUT_INVALID' })
})
it('returns a bounded public failure instead of leaking database messages or paths', () => {
  const spy = vi.spyOn(StoryBranchRepository, 'read').mockImplementation(() => { throw new Error('private-db-path/sql/internal') })
  expect(invoke('story:read', { projectSession: session })).toEqual({ success: false, error: 'STORY_OPERATION_FAILED' })
  spy.mockRestore()
  expect(invoke('story:read', null)).toEqual({ success: false, error: 'STORY_INPUT_INVALID' })
})
