import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'
import { page } from 'vitest/browser'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { ProjectData } from '../../../../shared/ipc-channels'
import type { NarrativeThreadView } from '../../../../shared/narrative-thread'
import type { PlotTreeSnapshot } from '../../../../shared/plot-tree'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import StagePlot from '../StagePlot'
import { ensureStoryWorkspace, getStoryWorkspace, resetStoryWorkspacesForTests, updateStoryWorkspace } from '../../../story/story-workspace'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'
import { useEditorStore } from '../../../../stores/editor-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { openPageTab } from '../../../../stores/navigation/page-tabs'
import type { GraphGenerationRecovery } from '../../../../shared/graph-generation'
import type { StorySnapshot } from '../../../../shared/story-branches'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/night-train', leaseId: '本次打开' }
const REVISION = 'a'.repeat(64)

function snapshotStore<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useLocaleStore, useLLMStore, useEditorStore, useStageStore].map(store => snapshotStore(store as StoreApi<unknown>))

const tree: PlotTreeSnapshot = {
  version: 1, generatedAt: '2026-10-12T11:40:00.000Z', writingLanguage: 'zh-CN', sourceRevision: REVISION,
  tracks: [
    { id: 'main', title: '末班车之谜', role: 'main', startChapter: 1, endChapter: 3, summary: '', events: [
      { status: 'occurred', chapterNumber: 1, summary: '林舟收到一封没有署名的灰色信', sources: [{ type: 'finalized-chapter', draftId: 7, chapterNumber: 1 }] },
      { status: 'planned', chapterNumber: 3, summary: '雨夜登上本该停运的末班车', sources: [{ type: 'blueprint', chapterNumber: 3 }] },
    ] },
    { id: 'side', title: '母亲的过去', role: 'subplot', parentTrackId: 'main', startChapter: 2, endChapter: 3, summary: '', events: [
      { status: 'occurred', chapterNumber: 2, summary: '母亲出走前拍下的最后一张照片', sources: [{ type: 'finalized-chapter', draftId: 8, chapterNumber: 2 }] },
    ] },
  ],
}

let plotSnapshot: PlotTreeSnapshot | null
let threads: NarrativeThreadView[]
let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

function thread(): NarrativeThreadView {
  return { id: 5, title: '灰色的信是谁寄的', type: '主线', targetStartChapter: 1, targetEndChapter: 9, authorIntent: '寄信人是母亲',
    status: 'planned', dormantChapters: 0, overdue: false, events: [], createdAt: '', updatedAt: '' }
}

const blueprints: ChapterBlueprint[] = [1, 2, 3].map(chapterNumber => ({ chapterNumber, title: ['灰色的信', '母亲的旧照片', '雨夜车站'][chapterNumber - 1], role: '发展', purpose: '寻找列车', keyEvents: '发现线索', characters: [], suspenseHook: '', userGuidance: '', notes: '', notesUpdatedAt: '' }))
const chapterTree = (): StorySnapshot => ({ revision: REVISION, nodes: blueprints.map(bp => ({ id: `chapter:${bp.chapterNumber}`, kind: 'content', title: bp.title, chapterNumber: bp.chapterNumber, event: bp.keyEvents, body: '', revisionId: `revision:${bp.chapterNumber}`, chapterBlueprint: { ...bp }, mainline: { chapterNumber: bp.chapterNumber, manuscriptStatus: 'unwritten', hasBlueprint: true } })), edges: [{ id: 'mainline:chapter:1>chapter:2', from: 'chapter:1', to: 'chapter:2', label: '', condition: '' }, { id: 'mainline:chapter:2>chapter:3', from: 'chapter:2', to: 'chapter:3', label: '', condition: '' }], routes: [{ id: 'mainline', title: '主线', nodeIds: ['chapter:1','chapter:2','chapter:3'] }], notes: [], revisions: [] })

beforeEach(async () => {
  await page.viewport(1280, 900)
  resetStoryWorkspacesForTests()
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  plotSnapshot = tree
  threads = [thread()]
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'story:read') return { success: true, data: chapterTree() }
    if (channel === 'db:draft-authority-sequence') return { status: 'continuous', lastChapterNumber: 0, nextChapterNumber: 1, duplicateChapterNumbers: [], authorityFingerprint: REVISION }
    if (channel === 'db:blueprint-character-sync-list-pending') return []
    if (channel === 'generation:list') return []
    if (channel === 'db:plot-tree-read') return {
      writingLanguage: 'zh-CN', synopsis: { content: '' },
      blueprints: [1, 2, 3].map(chapterNumber => ({ chapterNumber, title: ['灰色的信', '母亲的旧照片', '雨夜车站'][chapterNumber - 1], purpose: '', keyEvents: '' })),
      finalizedChapters: [{ draftId: 7, chapterNumber: 1, title: '灰色的信', summary: '' }, { draftId: 8, chapterNumber: 2, title: '母亲的旧照片', summary: '' }],
      narrativeThreads: [], sourceRevision: REVISION, snapshot: plotSnapshot,
    }
    if (channel === 'db:plot-tree-clear') { plotSnapshot = null; return { success: true } }
    if (channel === 'db:narrative-thread-list') return threads
    if (channel === 'db:draft-list-all') return [{ id: 7, chapterNumber: 1, version: 1, status: 'finalized' }, { id: 8, chapterNumber: 2, version: 1, status: 'finalized' }]
    if (channel === 'db:blueprint-get-all') return blueprints
    if (channel === 'db:blueprint-upsert') return { success: true }
    if (channel === 'db:narrative-thread-plan-delete') { threads = threads.filter(item => item.id !== args[0]); return { success: true } }
    if (channel === 'db:narrative-thread-event-confirm') {
      const input = args[0] as { planId: number; draftId: number; type: 'planted'; evidence: string; reason: string }
      if (input.evidence === '定稿里没有这句') {
        // 可写的 db 通道由主进程包装层把异常折成 { success: false, error: String(error) }。
        return { success: false, error: 'Error: NARRATIVE_THREAD_EVIDENCE_NOT_IN_SOURCE' }
      }
      threads = threads.map(item => item.id === input.planId
        ? { ...item, status: 'planted', events: [...item.events, { id: 1, planId: input.planId, draftId: input.draftId, type: input.type, evidence: input.evidence, reason: input.reason, chapterNumber: 1, chapterTitle: '灰色的信', createdAt: '' }] }
        : item)
      return { success: true }
    }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车', novelConfig: { totalChapters: 24 } } as unknown as ProjectData })
  useLLMStore.setState({ loaded: true, models: [{ id: 'm1', name: '夹具模型', modelName: 'fixture', purposes: ['generation'] }] as never, defaultModelId: 'm1' })
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 800px; display: flex'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  resetStoryWorkspacesForTests()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string'
    ? candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name
    : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = await vi.waitFor(() => {
    const found = button(name)
    expect(found, String(name)).toBeTruthy()
    return found!
  })
  await act(async () => target.click())
}
const called = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel)

async function render(initialView: 'plot-tree' | 'plans' | 'branches') {
  await act(async () => root!.render(<StagePlot projectKey={session.projectPath} initialView={initialView} />))
}

describe('剧情与伏笔', () => {
  it('剧情梳理只读展示定稿事实和蓝图计划，编辑入口返回同一蓝图章节', async () => {
    const key = ensureStoryWorkspace(session)
    updateStoryWorkspace(key, { snapshot: chapterTree(), selectedNodeId: 'chapter:2', selectedRouteId: 'mainline' })
    await render('plot-tree')
    await vi.waitFor(() => expect(document.querySelector('table[aria-label="剧情梳理"]')).toBeTruthy())
    expect(document.querySelector('.chapter-tree-workspace')).toBeNull()
    expect(document.querySelector('.story-tree')).toBeNull()
    expect(document.querySelectorAll('.stage-plot-event[data-state="occurred"]')).toHaveLength(2)
    expect(document.querySelectorAll('.stage-plot-event[data-state="planned"]')).toHaveLength(1)
    expect(document.body.textContent).toContain('章节与分支统一在章节蓝图中编辑')
    await click('前往章节蓝图')
    const active = useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)
    expect(active).toMatchObject({ type: 'chapter-card', projectKey: session.projectPath })
    expect(getStoryWorkspace(key)!.selectedNodeId).toBe('chapter:2')
    expect(getStoryWorkspace(key)!.selectedRouteId).toBe('mainline')
    expect(called('db:blueprint-upsert')).toHaveLength(0)
    expect(called('db:plot-tree-clear')).toHaveLength(0)
  })

  it('内容区窄于1040px边距收窄，整理记录仍可查阅原有生成历史', async () => {
    host!.style.width = '960px'
    await render('plot-tree')
    await vi.waitFor(() => expect(document.querySelector('.stage-plot-grid')).toBeTruthy())
    const page = () => getComputedStyle(document.querySelector('.stage-plot')!)
    expect([page().paddingLeft, page().paddingRight]).toEqual(['24px', '24px'])
    await act(async () => { host!.style.width = '1200px' })
    expect([page().paddingLeft, page().paddingRight]).toEqual(['48px', '48px'])
    await click('整理记录')
    const head = document.querySelector('.stage-plot-records-head')!.getBoundingClientRect()
    const hide = button('收起整理记录')!.getBoundingClientRect()
    expect(Math.abs(hide.right - head.right)).toBeLessThanOrEqual(1)
  })

  it('旧快照为空时提供整理入口，不复制章节蓝图编辑器', async () => {
    plotSnapshot = null
    await render('plot-tree')
    await vi.waitFor(() => expect(document.body.textContent).toContain('还没有剧情梳理'))
    expect(button('整理剧情')?.disabled).toBe(false)
    expect(document.querySelector('.chapter-tree-workspace')).toBeNull()
    expect(button('清除梳理快照…')).toBeUndefined()
    expect(called('db:plot-tree-clear')).toHaveLength(0)
  })

  it('旧分支链接进入唯一蓝图编辑器，保留独立节点和路线', async () => {
    const key = ensureStoryWorkspace(session)
    const branch = { ...chapterTree().nodes[1], id: 'independent-branch', mainline: undefined }
    updateStoryWorkspace(key, { snapshot: { ...chapterTree(), nodes: [...chapterTree().nodes, branch] }, selectedNodeId: branch.id, selectedRouteId: 'branch-route' })
    await render('branches')
    await vi.waitFor(() => expect(useEditorStore.getState().tabs.some(tab => tab.type === 'chapter-card')).toBe(true))
    expect(getStoryWorkspace(key)!.selectedNodeId).toBe(branch.id)
    expect(getStoryWorkspace(key)!.selectedRouteId).toBe('branch-route')
    expect(document.querySelector('.story-tree')).toBeNull()
    expect(document.querySelector('.chapter-tree-workspace')).toBeNull()
    expect(called('db:blueprint-upsert')).toHaveLength(0)
  })

  it('侧栏剧情资料默认进入伏笔，保留剧情梳理作为独立只读用途', async () => {
    openPageTab('plot')
    const active = useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)!
    expect(active).toMatchObject({ type: 'narrative-thread', name: '剧情与伏笔', narrativeThreadView: 'plans' })
    await render(active.narrativeThreadView!)
    await vi.waitFor(() => expect(document.querySelector('.stage-threads')).toBeTruthy())
    expect(called('db:plot-tree-read')).toHaveLength(0)
    expect(called('story:read')).toHaveLength(0)
  })

  it('清除梳理先确认，只清快照不删除蓝图、正文、分支或伏笔', async () => {
    await render('plot-tree')
    await vi.waitFor(() => expect(document.querySelector('.stage-plot-grid')).toBeTruthy())
    await click('剧情梳理的更多操作'); await click('清除梳理快照…')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('章节蓝图、正文、分支和伏笔计划都保留')
    expect(called('db:plot-tree-clear')).toHaveLength(0)
    await click('取消'); expect(called('db:plot-tree-clear')).toHaveLength(0)
    await click('剧情梳理的更多操作'); await click('清除梳理快照…'); await click('清除快照')
    await vi.waitFor(() => expect(document.body.textContent).toContain('还没有剧情梳理'))
    expect(called('db:plot-tree-clear')).toHaveLength(1)
    expect(threads).toHaveLength(1)
    expect(called('db:blueprint-upsert')).toHaveLength(0)
    expect(invoke.mock.calls.some(([channel]) => /story:commit|draft-delete|narrative-thread-plan-delete/.test(channel))).toBe(false)
  })

  it('英文界面里线索沉寂一章写 Quiet for 1 chapter', async () => {
    threads = [{ ...thread(), dormantChapters: 1 }]
    const current = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...current, novelConfig: { ...current.novelConfig, narrativeThreadDormantChapterThreshold: 1 } } })
    useLocaleStore.setState({ locale: 'en-US' })
    await render('plans')
    await vi.waitFor(() => expect(document.querySelector('.stage-thread-sub[data-tone="warn"]')?.textContent).toBe('Quiet for 1 chapter'))
  })

  it('删除线索计划先危险确认：取消不删，确认才删', async () => {
    await render('plans')
    await vi.waitFor(() => expect(document.body.textContent).toContain('灰色的信是谁寄的'))
    await click('「灰色的信是谁寄的」的更多操作')
    await click('删除线索…')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('删除这条线索？')
    expect(dialog.textContent).toContain('会删除线索「灰色的信是谁寄的」')
    expect(called('db:narrative-thread-plan-delete')).toHaveLength(0)

    await click('取消')
    expect(called('db:narrative-thread-plan-delete')).toHaveLength(0)

    await click('「灰色的信是谁寄的」的更多操作')
    await click('删除线索…')
    await click('删除线索')
    await vi.waitFor(() => expect(called('db:narrative-thread-plan-delete').map(([, id]) => id)).toEqual([5]))
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('灰色的信是谁寄的'))
  })

  it('新建线索：填齐名称、类型与打算才能保存，保存后对话框关闭', async () => {
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:narrative-thread-plan-create'
      ? { success: true, id: 6 }
      : plain(channel, ...args))
    await render('plans')
    await vi.waitFor(() => expect(document.body.textContent).toContain('灰色的信是谁寄的'))
    await click('新建线索')
    const dialog = () => document.querySelector('[role="dialog"]')
    expect(dialog()?.textContent).toContain('新建线索')
    const save = () => [...dialog()!.querySelectorAll('button')].find(node => node.textContent === '保存线索')!
    expect(save().disabled).toBe(true)
    const fill = async (label: string, value: string) => {
      const field = [...dialog()!.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))!.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
      await act(async () => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await fill('名称', '末班车为何停运')
    await fill('类型', '主线')
    await fill('你的打算', '停运公告是伪造的')
    expect(save().disabled).toBe(false)
    await act(async () => save().click())
    await vi.waitFor(() => expect(called('db:narrative-thread-plan-create')).toHaveLength(1))
    expect(called('db:narrative-thread-plan-create')[0][1]).toMatchObject({ title: '末班车为何停运', type: '主线', authorIntent: '停运公告是伪造的' })
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  it('让 AI 识别定稿事件时沿用作者选的模型，不退回默认模型', async () => {
    useLLMStore.setState({ models: [
      { id: 'm1', name: '夹具模型', modelName: 'fixture', purposes: ['generation'] },
      { id: 'm2', name: '长文模型', modelName: 'fixture-long', purposes: ['generation'] },
    ] as never })
    await render('plans')
    await vi.waitFor(() => expect(document.body.textContent).toContain('灰色的信是谁寄的'))
    const modelSelect = () => document.querySelector<HTMLSelectElement>('select[aria-label="本次识别用的模型"]')!
    await act(async () => {
      modelSelect().value = 'm2'
      modelSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('「灰色的信是谁寄的」的更多操作')
    await click('记录定稿里的变化')
    await click('让 AI 识别')
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'graph-generation:begin')).toBe(true))
    const generationCalls = invoke.mock.calls.filter(([channel]) => channel === 'graph-generation:begin')
    expect(JSON.stringify(generationCalls)).toContain('"m2"')
    expect(modelSelect().value).toBe('m2')
  })

  describe('「规划」环节的模型', () => {
    const TWO_MODELS = [
      { id: 'm1', name: '夹具模型', modelName: 'fixture', purposes: ['generation'] },
      { id: 'm2', name: '长文模型', modelName: 'fixture-long', purposes: ['generation'] },
    ]
    const select = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
    const begunWith = () => invoke.mock.calls
      .filter(([channel]) => channel === 'graph-generation:begin')
      .map(([, request]) => (request as { modelId: string }).modelId)

    async function preselected(view: 'plot-tree' | 'plans', label: string) {
      await render(view)
      return vi.waitFor(() => {
        const found = select(label)
        expect(found?.value).toBeTruthy()
        return found!.value
      })
    }

    it('另有指定时，只读剧情梳理预选它并按它整理', async () => {
      useLLMStore.setState({ models: TWO_MODELS as never, stageModelIds: { planning: 'm2' } })
      expect(await preselected('plot-tree', '本次整理用的模型')).toBe('m2')
      await click('重新整理剧情')
      await vi.waitFor(() => expect(begunWith()).toEqual(['m2']))
    })

    it('另有指定时，让 AI 识别定稿事件预选它并按它识别', async () => {
      useLLMStore.setState({ models: TWO_MODELS as never, stageModelIds: { planning: 'm2' } })
      expect(await preselected('plans', '本次识别用的模型')).toBe('m2')
      await click('「灰色的信是谁寄的」的更多操作')
      await click('记录定稿里的变化')
      await click('让 AI 识别')
      await vi.waitFor(() => expect(begunWith()).toEqual(['m2']))
    })

    it.each([
      ['用默认模型', 'm1', 'm1'],
      ['默认模型不可用时用第一个生成模型', null, 'm1'],
      ['默认模型是第二个时用它', 'm2', 'm2'],
    ])('没有另外指定时，剧情树与伏笔识别照旧%s', async (_label, defaultModelId, expected) => {
      useLLMStore.setState({ models: TWO_MODELS as never, defaultModelId })
      expect(await preselected('plot-tree', '本次整理用的模型')).toBe(expected)
      await act(async () => root!.unmount())
      root = createRoot(host!)
      expect(await preselected('plans', '本次识别用的模型')).toBe(expected)
    })
  })

  it('作品重新打开后，上一次打开时迟到的线索列表不会显示出来', async () => {
    let releaseOld: () => void = () => {}
    const plain = invoke.getMockImplementation()!
    let listCalls = 0
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:narrative-thread-list') {
        listCalls++
        if (listCalls === 1) {
          const stale = threads
          await new Promise<void>(resolve => { releaseOld = resolve })
          return stale
        }
        return []
      }
      return plain(channel, ...args)
    })
    await render('plans')
    await vi.waitFor(() => expect(listCalls).toBe(1))
    const reopened = { ...session, leaseId: '再次打开' }
    await act(async () => {
      useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: reopened.leaseId, name: '雨夜列车', novelConfig: { totalChapters: 24 } } as unknown as ProjectData })
      setActiveProjectSessionContext(reopened)
    })
    await vi.waitFor(() => expect(listCalls).toBe(2))
    await act(async () => { releaseOld(); await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(document.body.textContent).not.toContain('灰色的信是谁寄的')
  })

  it('确认定稿事件后线索路线推进：埋设一站变成已发生', async () => {
    await render('plans')
    await vi.waitFor(() => expect(document.body.textContent).toContain('灰色的信是谁寄的'))
    const route = () => [...document.querySelectorAll('[aria-label="线索路线"] li')].map(node => node.getAttribute('data-state'))
    expect(route()).toEqual(['todo', 'none', 'todo'])

    await click('「灰色的信是谁寄的」的更多操作')
    await click('记录定稿里的变化')
    const setValue = async (label: string, value: string) => {
      const input = [...document.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))!.querySelector('input')!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await setValue('定稿里的原文', '信封上没有邮戳')
    await setValue('理由', '寄信人就在附近')
    await click('记入线索')
    await vi.waitFor(() => expect(route()).toEqual(['done', 'none', 'todo']))
    expect(called('db:narrative-thread-event-confirm')[0][1]).toMatchObject({ planId: 5, draftId: 7, type: 'planted', evidence: '信封上没有邮戳' })
  })

  it('AI伏笔候选通过主进程回执确认后才进入计划，重开保留而不重复生成', async () => {
    const plain = invoke.getMockImplementation()!
    const candidate = { title: '灯下的第二封信', type: '人物', targetStartChapter: 3, targetEndChapter: 8, authorIntent: '同样的笔迹暗示寄信人是母亲' }
    let recovery: GraphGenerationRecovery
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'graph-generation:begin') {
        const request = args[0] as { input: { kind: 'plan'; chapterNumber: number }; modelId: string }
        recovery = { view: { handle: { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'synthetic-root', runId: 'synthetic-run' }, status: 'paused', artifacts: [], nonReplayable: false, budget: {} },
          modelId: request.modelId, context: { projectId: session.projectId, originEpoch: session.leaseId, key: 'synthetic-key', createdAt: '', kind: 'plan', input: request.input, writingLanguage: 'zh-CN', blueprint: blueprints[0], totalChapters: 24 },
          sourceStatus: 'current', attemptCount: 0, effects: [] } as unknown as GraphGenerationRecovery
        return structuredClone(recovery)
      }
      if (channel === 'graph-generation:execute') {
        recovery.attemptCount = 1; recovery.view.status = 'completed'
        recovery.artifact = { artifactId: 'synthetic-artifact', revision: 1, textHash: REVISION }
        recovery.result = { kind: 'plan', candidates: [candidate] }
        return { run: structuredClone(recovery.view) }
      }
      if (channel === 'graph-generation:read') return structuredClone(recovery)
      if (channel === 'graph-generation:confirm') {
        const request = args[0] as { index: number }
        expect(request.index).toBe(0)
        const plan = { ...candidate, id: 6, createdAt: '', updatedAt: '' }
        const effect = { success: true as const, index: 0, kind: 'plan' as const, plan }
        recovery.effects.push(effect)
        threads.push({ ...plan, status: 'planned', dormantChapters: 0, overdue: false, events: [] })
        return structuredClone(effect)
      }
      return plain(channel, ...args)
    })
    await render('plans')
    await vi.waitFor(() => expect(document.querySelector('select[aria-label="蓝图章节"]')?.children.length).toBe(3))
    await click('根据蓝图建议伏笔')
    await vi.waitFor(() => expect(document.querySelector('[aria-label="伏笔建议"]')?.textContent).toContain(candidate.title))
    expect(threads.map(thread => thread.title)).not.toContain(candidate.title)
    expect(called('graph-generation:confirm')).toHaveLength(0)
    await click('加入计划')
    await vi.waitFor(() => expect(document.querySelector('.stage-thread-list')?.textContent).toContain(candidate.title))
    expect(called('graph-generation:confirm')).toHaveLength(1)
    expect(called('db:narrative-thread-plan-create')).toHaveLength(0)
    await act(async () => root!.render(<p>another page</p>)); await render('plans')
    await vi.waitFor(() => expect(document.querySelectorAll('.stage-thread')).toHaveLength(2))
    expect(called('graph-generation:begin')).toHaveLength(1)
  })

  it('393px伏笔与梳理界面不横向溢出，章节时间轴只在自身容器滚动', async () => {
    await page.viewport(393, 900)
    host!.style.width = '393px'
    await render('plans')
    await vi.waitFor(() => expect(document.querySelector('.stage-thread-route')).toBeTruthy())
    const frame = document.querySelector<HTMLElement>('.stage-plot-frame')!
    await vi.waitFor(() => expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth + 1))
    expect(button('前往章节蓝图')!.getBoundingClientRect().height).toBeGreaterThanOrEqual(40)
    const side = document.querySelector<HTMLElement>('.stage-threads-side')!, plans = document.querySelector<HTMLElement>('.stage-threads-plans')!
    expect(side.getBoundingClientRect().top).toBeGreaterThan(plans.getBoundingClientRect().bottom)
    await page.screenshot({ path: '../../../../../.runtime/workflow-ui/phone-threads.png', element: host! })
    await click('剧情梳理')
    await vi.waitFor(() => expect(document.querySelector('.stage-plot-grid')).toBeTruthy())
    expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth + 1)
    const timeline = document.querySelector<HTMLElement>('.stage-plot-grid-wrap')!
    expect(timeline.scrollWidth).toBeGreaterThan(timeline.clientWidth)
    await page.screenshot({ path: '../../../../../.runtime/workflow-ui/phone-overview.png', element: host! })
    expect(document.querySelector('.story-tree')).toBeNull()
  })

  it.each([
    ['zh-CN', '「灰色的信是谁寄的」的更多操作', '记录定稿里的变化', '定稿里的原文', '理由', '记入线索', '请粘贴所选定稿章节中实际出现的短原文。'],
    ['en-US', 'More actions for “灰色的信是谁寄的”', 'Record a change from a final', 'Quote from the final', 'Why', 'Record', 'Paste a short excerpt that appears in the selected finalized chapter.'],
  ] as const)('%s：主进程拒绝不在定稿正文里的短证据时，在表单里按界面语言说明', async (locale, more, open, quoteLabel, reasonLabel, record, hint) => {
    useLocaleStore.setState({ locale })
    await render('plans')
    await vi.waitFor(() => expect(document.body.textContent).toContain('灰色的信是谁寄的'))
    await click(more)
    await click(open)
    const setValue = async (label: string, value: string) => {
      const input = [...document.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))!.querySelector('input')!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await setValue(quoteLabel, '定稿里没有这句')
    await setValue(reasonLabel, '寄信人就在附近')
    await click(record)
    await vi.waitFor(() => expect(document.querySelector('.stage-plot-error[role="alert"]')?.textContent).toBe(hint))
    expect(document.body.textContent).not.toContain('NARRATIVE_THREAD_EVIDENCE_NOT_IN_SOURCE')
    const quote = [...document.querySelectorAll('label')].find(node => node.textContent?.startsWith(quoteLabel))!.querySelector('input')!
    expect(quote.value).toBe('定稿里没有这句')
  })
})
