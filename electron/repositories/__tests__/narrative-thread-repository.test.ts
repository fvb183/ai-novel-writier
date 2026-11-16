import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { DraftRepository } from '../draft-repository'
import { NarrativeThreadRepository } from '../narrative-thread-repository'
import { setAuthoritativeFinalizedDraft } from '../../services/finalized-draft-head'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-thread-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('NarrativeThreadRepository', () => {
  it('keeps editable author plans as independent project facts', () => {
    expect(NarrativeThreadRepository.list()).toEqual([])

    const created = NarrativeThreadRepository.createPlan({
      title: '失踪的航海日志',
      type: '伏笔',
      targetStartChapter: 2,
      targetEndChapter: 8,
      authorIntent: '在第八章揭示日志由谁伪造。',
    })
    NarrativeThreadRepository.updatePlan(created.id, {
      title: '被篡改的航海日志',
      type: '长期承诺',
      targetStartChapter: 3,
      targetEndChapter: 9,
      authorIntent: '第九章揭示伪造者及动机。',
    })
    closeProjectDatabase()
    initProjectDatabase(projectRoot)

    expect(NarrativeThreadRepository.list()).toEqual([expect.objectContaining({
      id: created.id,
      title: '被篡改的航海日志',
      type: '长期承诺',
      targetStartChapter: 3,
      targetEndChapter: 9,
      authorIntent: '第九章揭示伪造者及动机。',
      status: 'planned',
      dormantChapters: 0,
      overdue: false,
      events: [],
    })])
  })

  it('derives ordered event state only from user confirmations bound to finalized drafts', () => {
    const plan = NarrativeThreadRepository.createPlan({
      title: '旧码头的钥匙',
      type: '伏笔',
      targetStartChapter: 1,
      targetEndChapter: 3,
      authorIntent: '第三章打开仓库。',
    })
    const contentId = Number(getProjectDb()!.prepare("INSERT INTO contents (body) VALUES ('草稿')").run().lastInsertRowid)
    const draftId = Number(getProjectDb()!.prepare(`
      INSERT INTO drafts (chapter_number, version, status, source, content_id, word_count)
      VALUES (1, 1, 'draft', 'write', ?, 2)
    `).run(contentId).lastInsertRowid)

    expect(() => NarrativeThreadRepository.confirmEvent({
      planId: plan.id,
      draftId,
      type: 'planted',
      evidence: '草稿中的钥匙。',
      reason: '尚未定稿。',
    })).toThrow('NARRATIVE_THREAD_EVENT_SOURCE_NOT_FINALIZED')

    const finalized = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-finalized-source',
      chapters: [
        { chapterNumber: 1, title: '旧码头', content: '林岚捡到钥匙。', wordCount: countDraftUnits('林岚捡到钥匙。') },
        { chapterNumber: 3, title: '仓库门', content: '钥匙打开仓库。', wordCount: countDraftUnits('钥匙打开仓库。') },
      ],
    })
    NarrativeThreadRepository.confirmEvent({
      planId: plan.id,
      draftId: finalized.drafts[0]!.draftId,
      type: 'planted',
      evidence: '林岚捡到钥匙。',
      reason: '埋设钥匙来源。',
    })
    NarrativeThreadRepository.confirmEvent({
      planId: plan.id,
      draftId: finalized.drafts[1]!.draftId,
      type: 'resolved',
      evidence: '钥匙打开仓库。',
      reason: '兑现第一章伏笔。',
    })

    const [view] = NarrativeThreadRepository.list()
    expect(view).toEqual(expect.objectContaining({
      id: plan.id,
      title: '旧码头的钥匙',
      status: 'resolved',
      dormantChapters: 0,
      overdue: false,
    }))
    expect(view?.events.map(event => [event.chapterNumber, event.type, event.chapterTitle])).toEqual([
      [1, 'planted', '旧码头'],
      [3, 'resolved', '仓库门'],
    ])
    expect(NarrativeThreadRepository.getPlan(plan.id)?.authorIntent).toBe('第三章打开仓库。')

    DraftRepository.clearAll()
    expect(NarrativeThreadRepository.list()[0]).toEqual(expect.objectContaining({
      id: plan.id,
      title: '旧码头的钥匙',
      status: 'planned',
      events: [],
    }))
  })

  it('computes inactivity and overdue state at query time', () => {
    const plan = NarrativeThreadRepository.createPlan({
      title: '迟到的回信',
      type: '长期承诺',
      targetStartChapter: 2,
      targetEndChapter: 4,
      authorIntent: '第四章前收到回信。',
    })

    const content = '第七章定稿。'
    FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-current-chapter-query',
      chapters: [{ chapterNumber: 7, title: '第七章', content, wordCount: countDraftUnits(content) }],
    })

    expect(NarrativeThreadRepository.list()[0]).toEqual(expect.objectContaining({
      id: plan.id,
      status: 'planned',
      dormantChapters: 5,
      overdue: true,
    }))
  })

  it('uses the selected lower-version final for thread status and active context without deleting losing confirmations', () => {
    const db = getProjectDb()!
    const plan = NarrativeThreadRepository.createPlan({
      title: '仓库的钥匙', type: '伏笔', targetStartChapter: 1, targetEndChapter: 3,
      authorIntent: '第三章打开仓库。',
    })
    const firstContent = '林岚捡到钥匙，仓库仍未打开。'
    const first = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-selected-first',
      chapters: [{ chapterNumber: 1, title: '找到钥匙', content: firstContent, wordCount: countDraftUnits(firstContent) }],
    }).drafts[0]!.draftId
    const planted = NarrativeThreadRepository.confirmEvent({
      planId: plan.id, draftId: first, type: 'planted', evidence: '林岚捡到钥匙', reason: '钥匙尚待使用。',
    })
    const secondContent = '林岚用钥匙打开仓库。'
    const second = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-selected-second',
      chapters: [{ chapterNumber: 1, title: '打开仓库', content: secondContent, wordCount: countDraftUnits(secondContent) }],
    }).drafts[0]!.draftId
    const resolved = NarrativeThreadRepository.confirmEvent({
      planId: plan.id, draftId: second, type: 'resolved', evidence: '钥匙打开仓库', reason: '伏笔已兑现。',
    })
    const context = { chapterNumber: 2, title: '仓库', keyEvents: '', characters: [] }
    expect(NarrativeThreadRepository.list()[0]?.status).toBe('resolved')
    expect(NarrativeThreadRepository.listRelevantActive(context)).toEqual([])

    setAuthoritativeFinalizedDraft(db, 1, first)
    expect(NarrativeThreadRepository.list()[0]).toEqual(expect.objectContaining({
      status: 'planted', events: [planted],
    }))
    expect(NarrativeThreadRepository.listRelevantActive(context).map(thread => thread.id)).toEqual([plan.id])
    expect(() => NarrativeThreadRepository.confirmEvent({
      planId: plan.id, draftId: second, type: 'resolved', evidence: '钥匙打开仓库', reason: '历史版本不能继续确认。',
    })).toThrow('只能绑定已定稿章节的当前版本')
    expect(db.prepare('SELECT id FROM narrative_thread_confirmations ORDER BY id').pluck().all())
      .toEqual([planted.id, resolved.id])

    setAuthoritativeFinalizedDraft(db, 1, second)
    expect(NarrativeThreadRepository.list()[0]).toEqual(expect.objectContaining({
      status: 'resolved', events: [resolved],
    }))
  })

  it('does not count a historical finalized chapter when its explicit head is no longer finalized', () => {
    const db = getProjectDb()!
    const plan = NarrativeThreadRepository.createPlan({
      title: '回信', type: '伏笔', targetStartChapter: 1, targetEndChapter: 3,
      authorIntent: '第三章收到回信。',
    })
    const content = '第九章的历史定稿。'
    FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-historical-finalized-chapter',
      chapters: [{ chapterNumber: 9, title: '历史', content, wordCount: countDraftUnits(content) }],
    })
    const contentId = db.prepare("INSERT INTO contents(body) VALUES ('尚未定稿')").run().lastInsertRowid
    const invalidHead = db.prepare(`INSERT INTO drafts(chapter_number, version, status, source, content_id, word_count)
      VALUES (9, 2, 'draft', 'write', ?, 4)`).run(contentId).lastInsertRowid
    db.prepare('UPDATE chapter_finalization_heads SET draft_id=? WHERE chapter_number=9').run(invalidHead)

    expect(NarrativeThreadRepository.list()[0]).toEqual(expect.objectContaining({
      id: plan.id, status: 'planned', dormantChapters: 0, overdue: false, events: [],
    }))
  })

  it('keeps single-final confirmation reads and writes compatible with legacy fixtures without a head table', () => {
    const db = getProjectDb()!
    const plan = NarrativeThreadRepository.createPlan({
      title: '旧信', type: '伏笔', targetStartChapter: 1, targetEndChapter: 2,
      authorIntent: '第二章解释旧信。',
    })
    const content = '林岚发现旧信。'
    const draftId = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-legacy-headless',
      chapters: [{ chapterNumber: 1, title: '旧信', content, wordCount: countDraftUnits(content) }],
    }).drafts[0]!.draftId
    db.exec('DROP TABLE chapter_finalization_heads')
    const event = NarrativeThreadRepository.confirmEvent({
      planId: plan.id, draftId, type: 'planted', evidence: '林岚发现旧信', reason: '旧信来源待揭示。',
    })
    expect(NarrativeThreadRepository.list()[0]).toEqual(expect.objectContaining({
      status: 'planted', dormantChapters: 0, overdue: false, events: [event],
    }))
  })

  it('requires author rationale and evidence that exists in the finalized content', () => {
    expect(() => NarrativeThreadRepository.createPlan({
      title: '无理由计划', type: '伏笔', targetStartChapter: 1, targetEndChapter: 2, authorIntent: '',
    })).toThrow('NARRATIVE_THREAD_PLAN_INVALID')

    const plan = NarrativeThreadRepository.createPlan({
      title: '墙上的刻痕', type: '伏笔', targetStartChapter: 1, targetEndChapter: 2,
      authorIntent: '第二章解释刻痕来源。',
    })
    const content = '林岚在门框上发现三道平行刻痕。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-evidence-boundary',
      chapters: [{ chapterNumber: 1, title: '三道刻痕', content, wordCount: countDraftUnits(content) }],
    })
    const draftId = receipt.drafts[0]!.draftId

    expect(() => NarrativeThreadRepository.confirmEvent({
      planId: plan.id, draftId, type: 'planted', evidence: '正文里不存在的银色钥匙。', reason: '埋设。',
    })).toThrow('NARRATIVE_THREAD_EVIDENCE_NOT_IN_SOURCE')
    expect(() => NarrativeThreadRepository.confirmEvent({
      planId: plan.id, draftId, type: 'planted', evidence: '三道平行刻痕', reason: '',
    })).toThrow('NARRATIVE_THREAD_EVENT_INVALID')
  })

  it('returns only active threads relevant to the current chapter plan', () => {
    const inRange = NarrativeThreadRepository.createPlan({
      title: '门框上的刻痕', type: '伏笔', targetStartChapter: 2, targetEndChapter: 4,
      authorIntent: '第四章揭示刻痕来自旧组织。',
    })
    const characterRelevant = NarrativeThreadRepository.createPlan({
      title: '林岚隐瞒的旧伤', type: '人物承诺', targetStartChapter: 8, targetEndChapter: 12,
      authorIntent: '林岚面对故人时承认旧伤。',
    })
    const unrelated = NarrativeThreadRepository.createPlan({
      title: '北港的失踪货船', type: '世界线', targetStartChapter: 8, targetEndChapter: 12,
      authorIntent: '海关在第十二章公布调查结论。',
    })
    const resolved = NarrativeThreadRepository.createPlan({
      title: '已经打开的暗门', type: '伏笔', targetStartChapter: 1, targetEndChapter: 4,
      authorIntent: '第三章打开暗门。',
    })
    const abandoned = NarrativeThreadRepository.createPlan({
      title: '废弃的支线', type: '支线', targetStartChapter: 1, targetEndChapter: 4,
      authorIntent: '作者决定放弃。',
    })
    const content = '林岚推开暗门。废弃的支线不再继续。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-relevant-active-source',
      chapters: [{ chapterNumber: 2, title: '暗门', content, wordCount: countDraftUnits(content) }],
    })
    NarrativeThreadRepository.confirmEvent({
      planId: resolved.id, draftId: receipt.drafts[0]!.draftId, type: 'resolved',
      evidence: '林岚推开暗门', reason: '伏笔已兑现。',
    })
    NarrativeThreadRepository.confirmEvent({
      planId: abandoned.id, draftId: receipt.drafts[0]!.draftId, type: 'abandoned',
      evidence: '废弃的支线不再继续', reason: '作者明确放弃。',
    })

    expect(NarrativeThreadRepository.listRelevantActive({
      chapterNumber: 3,
      title: '刻痕再现',
      keyEvents: '林岚发现新的刻痕。',
      characters: ['林岚'],
    }).map(thread => thread.id)).toEqual([inRange.id, characterRelevant.id])
    expect(NarrativeThreadRepository.listRelevantActive({
      chapterNumber: 3,
      title: '刻痕再现',
      keyEvents: '林岚发现新的刻痕。',
      characters: ['林岚'],
    }).map(thread => thread.id)).not.toContain(unrelated.id)
  })

  it('reconstructs active foreshadowing before the writing chapter without leaking a future resolution', () => {
    const plan = NarrativeThreadRepository.createPlan({
      title: '北塔铜钥匙', type: '伏笔', targetStartChapter: 1, targetEndChapter: 5,
      authorIntent: '第五章解释钥匙用途，之前保留疑问。',
    })
    const chapters = [
      { chapterNumber: 1, title: '拾钥匙', content: '林岚从石缝里拾到铜钥匙。' },
      { chapterNumber: 3, title: '刻印', content: '铜钥匙的刻印与北塔守卫徽记相同。' },
      { chapterNumber: 5, title: '开塔门', content: '铜钥匙打开北塔密室，揭示守卫身份。' },
    ]
    const imported = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-chapter-time-boundary',
      chapters: chapters.map(chapter => ({ ...chapter, wordCount: countDraftUnits(chapter.content) })),
    })
    const events = (['planted', 'progressing', 'resolved'] as const).map((type, index) => NarrativeThreadRepository.confirmEvent({
      planId: plan.id, draftId: imported.drafts[index]!.draftId, type,
      evidence: chapters[index].content, reason: `已确认的第${chapters[index].chapterNumber}章事件`,
    }))
    const query = (chapterNumber: number) => NarrativeThreadRepository.listRelevantActive({
      chapterNumber, title: '铜钥匙', keyEvents: '', characters: ['林岚'],
    })
    expect(query(1)[0]).toMatchObject({ status: 'planned', events: [], dormantChapters: 0, overdue: false })
    expect(query(3)[0]).toMatchObject({ status: 'planted', events: [events[0]], dormantChapters: 0, overdue: false })
    expect(query(5)[0]).toMatchObject({ status: 'progressing', events: events.slice(0, 2), dormantChapters: 0, overdue: false })
    expect(query(6)).toEqual([])
    expect(NarrativeThreadRepository.list()[0]).toMatchObject({ status: 'resolved', events })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM narrative_thread_confirmations').pluck().get()).toBe(3)
  })

  it('does not choose a future-only thread because its later evidence mentions the current cast', () => {
    const plan = NarrativeThreadRepository.createPlan({
      title: '迟来的海图', type: '伏笔', targetStartChapter: 8, targetEndChapter: 10,
      authorIntent: '第十章解释海图。',
    })
    const content = '林岚在第八章才得到海图。'
    const draft = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-future-only-relevance',
      chapters: [{ chapterNumber: 8, title: '海图', content, wordCount: countDraftUnits(content) }],
    }).drafts[0]!
    NarrativeThreadRepository.confirmEvent({ planId: plan.id, draftId: draft.draftId, type: 'planted', evidence: content, reason: '林岚发现海图。' })
    expect(NarrativeThreadRepository.listRelevantActive({ chapterNumber: 2, title: '出发', keyEvents: '', characters: ['林岚'] })).toEqual([])
    expect(NarrativeThreadRepository.list()[0]?.events).toHaveLength(1)
  })
})
