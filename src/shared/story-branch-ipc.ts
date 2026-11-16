import type { ProjectSessionContext } from './ipc-channels'
import type { StoryContext, StoryContextRequest, StoryOperation, StoryResponse, StorySnapshot } from './story-branches'

export interface StoryCommitOptions {
  confirmedSharedEdit?: boolean
  expectedContext?: { request: StoryContextRequest; contextHash: string }
}
export interface StoryForkChapterInput {
  expectedRevision: string
  afterChapter: number
  title: string
  placement: 'branch' | 'insert'
}
export interface StoryForkChapterResult { snapshot: StorySnapshot; nodeId: string; routeId: string }
export interface StoryBranchChannels {
  'story:read': { args: [{ projectSession?: ProjectSessionContext }]; return: StoryResponse<StorySnapshot> }
  'story:context': { args: [StoryContextRequest & { projectSession?: ProjectSessionContext }]; return: StoryResponse<StoryContext> }
  'story:commit': { args: [{ projectSession?: ProjectSessionContext; expectedRevision: string; operations: StoryOperation[] } & StoryCommitOptions]; return: StoryResponse<StorySnapshot> }
  'story:fork-chapter': { args: [StoryForkChapterInput & { projectSession?: ProjectSessionContext }]; return: StoryResponse<StoryForkChapterResult> }
}
