import type { StoryChapterSource, StoryContext, StoryNode } from './story-branches'
import type { WritingLanguage } from './writing-language'

export type StoryWritingPrefixNode = Pick<StoryNode, 'id' | 'kind' | 'title' | 'chapterNumber' | 'event' | 'body' | 'revisionId'> & {
  mainline?: StoryNode['mainline']
  chapterSource?: StoryChapterSource
  /** Source-chapter key events are plans, including when some prose is available. */
  eventStatus?: 'chapter-plan'
  manuscriptStatus?: 'available' | 'unwritten'
}
export type StoryWritingContext = Omit<StoryContext, 'prefix'> & { prefix: StoryWritingPrefixNode[] }

/** Model-visible interpretation only. Canonical context/hash inputs stay untouched. */
export function projectStoryWritingContext(context: StoryContext): StoryWritingContext {
  return { ...context, prefix: context.prefix.map(node => ({
    id: node.id, kind: node.kind, title: node.title, chapterNumber: node.chapterNumber,
    event: node.event, body: node.body, revisionId: node.revisionId,
    ...(node.mainline ? { mainline: { ...node.mainline }, manuscriptStatus: node.body.trim() ? 'available' as const : 'unwritten' as const } : {}),
    ...(node.chapterSource ? {
      chapterSource: { ...node.chapterSource }, eventStatus: 'chapter-plan' as const,
      manuscriptStatus: node.body.trim() ? 'available' as const : 'unwritten' as const,
    } : {}),
  })), note: context.noteCurrent ? context.note : null }
}

/** Shared wording keeps the initial main prompt and subsequent read-tool data consistent. */
export function storyWritingContinuityInstruction(language: WritingLanguage): string {
  return language === 'en-US'
    ? 'For prefix nodes with chapterSource, eventStatus="chapter-plan" means event was copied from the source chapter blueprint and remains a plan, never proof that it happened. manuscriptStatus="available" means body contains actual prose: take established details from that prose, with body taking priority over any conflicting planned event. manuscriptStatus="unwritten" means no prose has implemented this prerequisite chapter: its planned events are unrealized prerequisites, not earlier facts. Never infer current character condition, possessions, location, relationships or completed actions from an unwritten source plan. Ordinary manually authored prefix events keep their existing interpretation; these status tags apply only to source-chapter plans. The target blueprint and any selected continuation remain writing constraints, not established earlier events.'
    : '前情节点带 chapterSource 时，eventStatus="chapter-plan" 表示 event 来自源章节蓝图，属于计划，不能据此断言事件已经发生。manuscriptStatus="available" 表示已有实际正文，应从正文提取已经写出的事实；正文与计划冲突时，以实际正文为准。manuscriptStatus="unwritten" 表示该前置章节还没有正文，计划尚未落实，只是未实现的前置计划，不能当作既成前情；不得据此推断人物的当前状态、持有物品、位置、关系或已经完成的行动。普通手工编写的前情事件沿用原有含义，这些状态标记仅用于源章节蓝图计划。当前目标蓝图及指定后文仍是写作约束，不能当作已经发生的前情。'
}
