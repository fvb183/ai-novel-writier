import { ipcMain } from 'electron'
import { getCurrentProjectPath, getProjectDb } from '../database'
import { projectAccess } from '../services/project-access'
import { StoryBranchRepository, type StoryCommitOptions } from '../repositories/story-branch-repository'
import { forkStoryFromChapter } from '../services/story-chapter-planning'
import type { StoryForkChapterInput } from '../../src/shared/story-branch-ipc'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import type { StoryContextRequest, StoryOperation, StoryResponse } from '../../src/shared/story-branches'

function fail(code: string): never { throw new Error(code) }
function request(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('STORY_INPUT_INVALID')
  return raw as Record<string, unknown>
}
function database(input: Record<string, unknown>) {
  try { projectAccess.assertCurrentProjectContext(input.projectSession as ProjectSessionContext | undefined, getCurrentProjectPath()) }
  catch { fail('STORY_SESSION_STALE') }
  return getProjectDb() ?? fail('STORY_SESSION_STALE')
}
function response<T>(operation: () => T): StoryResponse<T> {
  try { return { success: true, data: operation() } }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    return { success: false, error: /^STORY_[A-Z0-9_]+$/.test(message) ? message : 'STORY_OPERATION_FAILED' }
  }
}
export function registerStoryBranchController(): void {
  ipcMain.handle('story:fork-chapter', (_event, raw: unknown) => response(() => {
    const input = request(raw), db = database(input)
    const { projectSession: _session, ...fork } = input
    return forkStoryFromChapter(db, fork as unknown as StoryForkChapterInput)
  }))
  ipcMain.handle('story:read', (_event, raw: unknown) => response(() => {
    const input = request(raw); return StoryBranchRepository.read(database(input))
  }))
  ipcMain.handle('story:context', (_event, raw: unknown) => response(() => {
    const input = request(raw), db = database(input)
    const { projectSession: _session, ...context } = input
    return StoryBranchRepository.context(db, context as unknown as StoryContextRequest)
  }))
  ipcMain.handle('story:commit', (_event, raw: unknown) => response(() => {
    const input = request(raw)
    if (input.confirmedSharedEdit !== undefined && typeof input.confirmedSharedEdit !== 'boolean') fail('STORY_INPUT_INVALID')
    const options: StoryCommitOptions = { confirmedSharedEdit: input.confirmedSharedEdit as boolean | undefined,
      expectedContext: input.expectedContext as StoryCommitOptions['expectedContext'] }
    return StoryBranchRepository.commit(database(input), input.expectedRevision as string, input.operations as StoryOperation[], options)
  }))
}
