import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { globalEventBus } from '../../../../shared/event-bus'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { disposeProjectService, initProjectService } from '../../../../services/project-service'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'
import { editorSaveHandler, useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import StageBlueprint from '../StageBlueprint'
import { getStoryWorkspace, resetStoryWorkspacesForTests, storyWorkspaceKey } from '../../../story/story-workspace'
import { MAINLINE_STORY_ROUTE_ID, mainlineStoryNodeId, mainlineStoryEdgeId, type StorySnapshot } from '../../../../shared/story-branches'
import '../../../../mobile/mobile.css'

const PROJECT_PATH = 'C:\\novels\\stage-blueprint'
const SESSION = { projectId: 'stage-blueprint', leaseId: 'stage-blueprint-lease', projectPath: PROJECT_PATH }
const originalEditor = useEditorStore.getState()
const originalProject = useProjectStore.getState()
const originalStage = useStageStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let stored: ChapterBlueprint[]
let manuscripts: Map<number, { title: string; body: string; finalized?: boolean }>
let nextChapter: number
let projectCore: { premise: string } | null
let invoke: ReturnType<typeof vi.fn>

function blueprint(chapterNumber: number, title: string): ChapterBlueprint {
  return {
    chapterNumber, title, role: '发展', purpose: '推进灯塔线索', keyEvents: '钟声提前一刻', characters: ['林岚', '守塔人'],
    suspenseHook: '', userGuidance: chapterNumber === 2 ? '节奏放慢。' : '', notes: '', notesUpdatedAt: '',
  }
}

function project(): ProjectData {
  return {
    id: 'stage-blueprint', sessionLease: 'stage-blueprint-lease', name: '灯塔', path: PROJECT_PATH,
    novelConfig: {
      genre: '悬疑', subGenre: '', targetAudience: '成人', totalChapters: 12, wordsPerChapter: 3000, plotStructure: 'three_act',
      narrativePOV: 'third_limited', coreOutline: '灯塔', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '', createdAt: '', updatedAt: '',
  }
}

function chapterSnapshot(): StorySnapshot {
  const numbers = [...new Set([...stored.map(bp => bp.chapterNumber), ...manuscripts.keys()])].sort((a, b) => a - b)
  const nodes: StorySnapshot['nodes'] = numbers.map(chapterNumber => {
    const bp = stored.find(item => item.chapterNumber === chapterNumber), manuscript = manuscripts.get(chapterNumber)
    return { id: mainlineStoryNodeId(chapterNumber), kind: 'content', title: bp?.title || manuscript?.title || `第 ${chapterNumber} 章`, chapterNumber,
      event: bp?.keyEvents ?? '', body: manuscript?.body ?? '', revisionId: `revision:${chapterNumber}`,
      ...(bp ? { chapterBlueprint: { title: bp.title, role: bp.role, purpose: bp.purpose, keyEvents: bp.keyEvents, characters: [...bp.characters], suspenseHook: bp.suspenseHook, userGuidance: bp.userGuidance, notes: bp.notes } } : {}),
      mainline: { chapterNumber, manuscriptStatus: manuscript?.finalized ? 'finalized' : manuscript?.body.trim() ? 'draft' : 'unwritten', hasBlueprint: Boolean(bp), hasManuscript: Boolean(manuscript?.body.trim()) },
    }
  })
  return { revision: 'revision', nodes, edges: nodes.slice(1).map((node, i) => ({ id: mainlineStoryEdgeId(nodes[i].id, node.id), from: nodes[i].id, to: node.id, label: '', condition: '' })), routes: nodes.length ? [{ id: MAINLINE_STORY_ROUTE_ID, title: '主线', nodeIds: nodes.map(n => n.id) }] : [], notes: [], revisions: [] }
}

function installIpc() {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'story:read') return { success: true, data: chapterSnapshot() }
    if (channel === 'db:blueprint-get-all') return structuredClone(stored)
    if (channel === 'db:draft-authority-sequence') return {
      status: 'continuous', lastChapterNumber: nextChapter - 1, nextChapterNumber: nextChapter, duplicateChapterNumbers: [], authorityFingerprint: 'a'.repeat(64),
    }
    if (channel === 'generation:find-blueprint-recovery') return null
    if (channel === 'db:consistency-exemption-list') return []
    if (channel === 'db:blueprint-clear-all') {
      stored = []
      return { success: true }
    }
    if (channel === 'db:blueprint-delete') {
      stored = stored.filter(item => item.chapterNumber !== args[0])
      return { success: true }
    }
    if (channel === 'db:blueprint-upsert' || channel === 'db:blueprint-upsert-many') {
      const values = (channel === 'db:blueprint-upsert' ? [args[0]] : args[0]) as ChapterBlueprint[]
      const byChapter = new Map(stored.map(item => [item.chapterNumber, item]))
      for (const value of values) byChapter.set(value.chapterNumber, structuredClone(value))
      stored = [...byChapter.values()].sort((a, b) => a.chapterNumber - b.chapterNumber)
      return { success: true }
    }
    if (channel === 'fs:list-dir') return []
    if (channel === 'config:get') return { blueprintTargetUnits: 800 }
    if (channel === 'config:set') return { success: true }
    if (channel === 'generation:list-directory-progress') return { progress: [], diagnostics: [] }
    if (channel === 'db:blueprint-character-sync-list-pending') return []
    if (channel === 'db:project-core-get') return projectCore
    if (channel === 'db:character-get-all') return [{ id: 1 }]
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0) },
  })
}

const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)

async function renderPage(initialChapterNumber?: number) {
  await act(async () => root?.render(<div className="paper-ink"><StageBlueprint projectKey={PROJECT_PATH} initialChapterNumber={initialChapterNumber} /></div>))
  await expect.element(page.getByRole('complementary', { name: '章节规划' })).toBeVisible()
}

async function renderConstrainedPage(width: number, height: number) {
  await page.viewport(width, height)
  await act(async () => root?.render(<div className="paper-ink stage-shell" style={{ width, height }}>
    <section className="stage-panel"><div className="stage-body"><main className="stage-content">
      <StageBlueprint projectKey={PROJECT_PATH} />
    </main></div></section>
  </div>))
  await expect.element(page.getByRole('complementary', { name: '章节规划' })).toBeVisible()
  await vi.waitFor(() => {
    const split = container!.querySelector<HTMLElement>('.chapter-tree-split')!
    expect(split.dataset.stacked).toBe(String(split.getBoundingClientRect().width <= 899))
  })
}

function expectInsideStage(element: Element) {
  const frame = container!.querySelector('.stage-content')!.getBoundingClientRect()
  const bounds = element.getBoundingClientRect()
  expect(bounds.width).toBeGreaterThan(0)
  expect(bounds.left).toBeGreaterThanOrEqual(frame.left - 1)
  expect(bounds.right).toBeLessThanOrEqual(frame.right + 1)
  expect(bounds.top).toBeGreaterThanOrEqual(frame.top - 1)
  expect(bounds.bottom).toBeLessThanOrEqual(frame.bottom + 1)
}

/** 后台生成提交一段蓝图、定稿、删除或清空之后，蓝图页都会收到这条刷新。 */
async function refreshBlueprints() {
  const before = calls('db:blueprint-get-all').length
  await act(async () => globalEventBus.emit('REFRESH_RESOURCE', { resources: ['blueprints'], projectPath: PROJECT_PATH,
    projectSession: SESSION }))
  await vi.waitFor(() => expect(calls('db:blueprint-get-all').length).toBeGreaterThan(before))
  await vi.waitFor(() => expect(calls('db:draft-authority-sequence').length).toBe(calls('db:blueprint-get-all').length))
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  // 视口变化的 resize 事件可能晚于渲染才到，浮层收到 resize 会关闭：先等它派发完。
  await vi.waitFor(() => expect([window.innerWidth, window.innerHeight]).toEqual([1280, 900]))
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  resetStoryWorkspacesForTests()
  stored = [blueprint(1, '旧港'), blueprint(2, '北堤'), blueprint(3, '灯室')]
  manuscripts = new Map()
  nextChapter = 2
  projectCore = null
  useLocaleStore.setState({ locale: 'zh-CN' })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project() })
  useStageStore.setState({ writeRequest: null, work: null })
  setActiveProjectSessionContext(SESSION)
  installIpc()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  resetStoryWorkspacesForTests()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(originalEditor)
  useProjectStore.setState(originalProject)
  useStageStore.setState(originalStage)
})

describe('蓝图阶段', () => {
  for (const [width, height] of [[393, 851], [360, 800]]) it(`${width}px 手机在被外壳裁切的工作区可从树进入全宽详情，返回保留输入并可保存`, async () => {
    await renderConstrainedPage(width, height)
    const split = container!.querySelector<HTMLElement>('.chapter-tree-split')!
    const workspace = container!.querySelector<HTMLElement>('.chapter-tree-workspace')!
    expect(split.dataset.mobilePane).toBe('tree')
    expect(container!.querySelector<HTMLDivElement>('.chapter-tree-split-editor')!.hidden).toBe(true)
    await act(async () => page.getByRole('button', { name: '北堤', exact: true }).click())
    await vi.waitFor(() => expect(split.dataset.mobilePane).toBe('details'))
    const title = page.getByRole('textbox', { name: '章节标题' }).element() as HTMLInputElement
    expectInsideStage(title)
    expect(container!.querySelector('.stage-bp-head')!.getClientRects()).toHaveLength(0)
    expect(title.getBoundingClientRect().top).toBeLessThan(height / 2)
    expect(container!.querySelector('.chapter-tree-source-actions')!.getBoundingClientRect().top).toBeGreaterThan(container!.querySelector('.stage-bp-card')!.getBoundingClientRect().bottom)
    const card = container!.querySelector('.stage-bp-card')!.getBoundingClientRect()
    expect(card.width).toBeGreaterThan(width - 70)
    expect(container!.querySelector<HTMLDivElement>('.chapter-tree-split-map')!.hidden).toBe(true)
    const purpose = page.getByRole('textbox', { name: /主角小目标/ })
    const purposeElement = purpose.element()
    const draft = `手机 ${width} 的未保存目标`
    await act(async () => purpose.fill(draft))
    await act(async () => page.getByRole('button', { name: '返回剧情树', exact: true }).click())
    expect(split.dataset.mobilePane).toBe('tree')
    expect(container!.querySelector('.stage-bp-head')!.getClientRects().length).toBeGreaterThan(0)
    expect(container!.querySelector('[data-story-node="chapter:2"] .story-tree-card-select')?.getAttribute('aria-pressed')).toBe('true')
    expect(calls('db:blueprint-upsert')).toHaveLength(0)
    expect(calls('db:blueprint-upsert-many')).toHaveLength(0)
    await act(async () => page.getByRole('button', { name: '章节详情', exact: true }).click())
    expect(purpose.element()).toBe(purposeElement)
    await expect.element(purpose).toHaveValue(draft)
    const notes = page.getByRole('textbox', { name: /章节要点/ }).element()
    notes.scrollIntoView({ block: 'center' })
    expect(getComputedStyle(workspace).overflowY).toBe('auto')
    expect(workspace.scrollTop).toBeGreaterThan(0)
    expectInsideStage(notes)
    await act(async () => page.getByRole('button', { name: '保存此章', exact: true }).click())
    await vi.waitFor(() => expect(stored.find(bp => bp.chapterNumber === 2)?.purpose).toBe(draft))
  })

  it('详情草稿随横屏和桌面尺寸变化保留，桌面恢复左右分栏和原宽度偏好', async () => {
    localStorage.setItem('ai-novel:chapter-tree:column-width', '444')
    await renderConstrainedPage(393, 851)
    await act(async () => page.getByRole('button', { name: '北堤', exact: true }).click())
    const input = page.getByRole('textbox', { name: '章节标题' }).element() as HTMLInputElement
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('横竖屏保留的标题'))
    for (const [width, height] of [[844, 390], [1440, 1000], [360, 800]]) {
      await page.viewport(width, height)
      container!.querySelector<HTMLElement>('.stage-shell')!.style.width = `${width}px`
      container!.querySelector<HTMLElement>('.stage-shell')!.style.height = `${height}px`
      const split = container!.querySelector<HTMLElement>('.chapter-tree-split')!
      await vi.waitFor(() => expect(split.dataset.stacked).toBe(String(split.getBoundingClientRect().width <= 899)))
      expect(page.getByRole('textbox', { name: '章节标题' }).element()).toBe(input)
      expect(input.value).toBe('横竖屏保留的标题')
      if (width === 844) {
        expect(split.dataset.mobilePane).toBe('details')
        expectInsideStage(input)
      }
      if (width === 1440) {
        await expect.element(page.getByRole('separator', { name: '调整章节树与蓝图宽度' })).toBeVisible()
        expect(container!.querySelector<HTMLDivElement>('.chapter-tree-split-map')!.hidden).toBe(false)
        expect(container!.querySelector<HTMLDivElement>('.chapter-tree-split-editor')!.hidden).toBe(false)
        expect(split.style.getPropertyValue('--chapter-tree-map-width')).toBe('444px')
      }
    }
    expect(localStorage.getItem('ai-novel:chapter-tree:column-width')).toBe('444')
    localStorage.removeItem('ai-novel:chapter-tree:column-width')
  })

  it('树上删除新建未保存章不调用数据库删除，随后保存和重开也不会复活', async () => {
    const original = structuredClone(stored)
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '新建章节', exact: true }).click())
    await expect.element(page.getByRole('region', { name: '第 4 章蓝图', exact: true })).toBeVisible()
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('未保存的第四章'))
    await act(async () => page.getByRole('button', { name: '删除「未保存的第四章」的蓝图', exact: true }).click())
    await act(async () => page.getByRole('dialog', { name: '删除第 4 章蓝图？' }).getByRole('button', { name: '删除此章', exact: true }).click())
    await vi.waitFor(() => expect(container?.querySelector('[data-story-node="chapter:4"]')).toBeNull())
    expect(calls('db:blueprint-delete')).toHaveLength(0)
    expect(stored).toEqual(original)
    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    await act(async () => { await save!() })
    expect(stored).toEqual(original)
    expect(calls('db:blueprint-upsert-many').flatMap(call => call[1] as ChapterBlueprint[]).some(bp => bp.chapterNumber === 4)).toBe(false)
    await refreshBlueprints()
    expect(container?.querySelector('[data-story-node="chapter:4"]')).toBeNull()
    await act(async () => root?.render(null))
    resetStoryWorkspacesForTests()
    await renderPage()
    expect(container?.querySelector('[data-story-node="chapter:4"]')).toBeNull()
    expect(calls('db:blueprint-delete')).toHaveLength(0)
  })

  it('树上删除已保存但未生成正文的章，重读和重开均不残留节点', async () => {
    const original = structuredClone(stored)
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '新建章节', exact: true }).click())
    await expect.element(page.getByRole('region', { name: '第 4 章蓝图', exact: true })).toBeVisible()
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('已保存的待写章'))
    await act(async () => page.getByRole('button', { name: '保存此章', exact: true }).click())
    await vi.waitFor(() => expect(stored.find(bp => bp.chapterNumber === 4)?.title).toBe('已保存的待写章'))
    await act(async () => page.getByRole('button', { name: '删除「已保存的待写章」的蓝图', exact: true }).click())
    await act(async () => page.getByRole('dialog', { name: '删除第 4 章蓝图？' }).getByRole('button', { name: '删除此章', exact: true }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([4]))
    await vi.waitFor(() => expect(container?.querySelector('[data-story-node="chapter:4"]')).toBeNull())
    expect(stored).toEqual(original)
    await refreshBlueprints()
    expect(container?.querySelector('[data-story-node="chapter:4"]')).toBeNull()
    expect(getStoryWorkspace(storyWorkspaceKey(SESSION))?.snapshot?.nodes.some(node => node.id === 'chapter:4')).toBe(false)
    await act(async () => root?.render(null))
    resetStoryWorkspacesForTests()
    await renderPage()
    expect(container?.querySelector('[data-story-node="chapter:4"]')).toBeNull()
    expect(stored).toEqual(original)
    expect(calls('story:commit')).toHaveLength(0)
  })

  it('已有正文的主线章只删蓝图，保留同一章节节点与正文，刷新后仍不生成替代蓝图', async () => {
    const manuscript = { title: '北堤原正文', body: '夹具原定稿正文，删除蓝图不能改变。', finalized: true }
    manuscripts.set(2, manuscript)
    await renderPage(2)
    await act(async () => page.getByRole('button', { name: '删除「北堤」的蓝图', exact: true }).click())
    await act(async () => page.getByRole('dialog', { name: '删除第 2 章蓝图？' }).getByRole('button', { name: '删除此章', exact: true }).click())
    await vi.waitFor(() => expect(stored.some(bp => bp.chapterNumber === 2)).toBe(false))
    await vi.waitFor(() => expect(container?.querySelectorAll('[data-story-node="chapter:2"]')).toHaveLength(1))
    const selectChapter = async () => act(async () => container?.querySelector<HTMLButtonElement>('[data-story-node="chapter:2"] .story-tree-card-select')?.click())
    await selectChapter()
    await expect.element(page.getByRole('region', { name: '正文尚无蓝图' })).toBeVisible()
    expect(page.getByRole('textbox', { name: '章节标题' }).query()).toBeNull()
    expect(container?.querySelector('[data-story-node="chapter:2"] .story-tree-delete')).toBeNull()
    expect(manuscripts.get(2)).toEqual(manuscript)
    await refreshBlueprints()
    await vi.waitFor(() => expect(getStoryWorkspace(storyWorkspaceKey(SESSION))?.snapshot?.nodes.find(node => node.id === 'chapter:2')).toMatchObject({
      id: 'chapter:2', body: manuscript.body, mainline: { hasBlueprint: false, hasManuscript: true, manuscriptStatus: 'finalized' },
    }))
    await act(async () => root?.render(null))
    resetStoryWorkspacesForTests()
    await renderPage(2)
    await expect.element(page.getByRole('region', { name: '正文尚无蓝图' })).toBeVisible()
    expect(container?.querySelectorAll('[data-story-node="chapter:2"]')).toHaveLength(1)
    expect(manuscripts.get(2)).toEqual(manuscript)
    expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([2])
    expect(calls('db:blueprint-upsert')).toHaveLength(0)
    expect(calls('story:commit')).toHaveLength(0)
  })

  it('从菜单新建主线章节后直接选中树上的新蓝图，原有章节保持原内容', async () => {
    const before = structuredClone(stored)
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '新建章节', exact: true }).click())
    await expect.element(page.getByRole('region', { name: '第 4 章蓝图', exact: true })).toBeVisible()
    expect(container?.querySelector('[data-selected-story-node]')?.getAttribute('data-selected-story-node')).toBe('chapter:4')
    expect(stored).toEqual(before)
    expect(calls('db:blueprint-upsert')).toHaveLength(0)
  })
  it('导入正文第一二章没有蓝图时也进同树，查看不会替它创建或保存第三章蓝图', async () => {
    stored = [blueprint(3, '灯室'), blueprint(4, '主线四'), blueprint(5, '主线五')]
    const plain = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    const graph = chapterSnapshot()
    graph.nodes.unshift(...[1, 2].map(number => ({ id: mainlineStoryNodeId(number), kind: 'content' as const, title: `导入第 ${number} 章`, chapterNumber: number, event: '', body: '夹具已定稿正文', revisionId: `import:${number}`, mainline: { chapterNumber: number, manuscriptStatus: 'finalized' as const, hasBlueprint: false } })))
    graph.routes[0].nodeIds = graph.nodes.map(node => node.id)
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'story:read') return { success: true, data: graph }
      if (channel === 'story:fork-chapter') {
        const id = '87654321-1234-4234-8234-123456789abc'
        const { chapterNumber: _chapter, notesUpdatedAt: _updated, ...chapterBlueprint } = blueprint(3, '导入章的独立分支')
        return { success: true, data: { nodeId: id, routeId: 'import-branch-route', snapshot: { ...graph,
          nodes: [...graph.nodes, { id, kind: 'content', title: chapterBlueprint.title, chapterNumber: 3, body: '', event: '', revisionId: 'new-branch', chapterBlueprint }],
          routes: [...graph.routes, { id: 'import-branch-route', title: '独立路线', nodeIds: ['chapter:1', 'chapter:2', id] }],
          edges: [...graph.edges, { id: 'import-branch-edge', from: 'chapter:2', to: id, label: '', condition: '' }],
        } } }
      }
      return plain(channel, ...args)
    })
    await renderPage(1)
    await expect.element(page.getByRole('region', { name: '正文尚无蓝图' })).toBeVisible()
    expect(page.getByRole('textbox', { name: '章节标题' }).query()).toBeNull()
    await expect.element(page.getByRole('button', { name: '打开本章正文', exact: true })).toBeVisible()
    await act(async () => page.getByRole('button', { name: '导入第 2 章', exact: true }).click())
    await expect.element(page.getByRole('region', { name: '正文尚无蓝图' })).toBeVisible()
    expect(calls('db:blueprint-upsert')).toEqual([])
    expect(calls('db:blueprint-upsert-many')).toEqual([])
    expect(calls('story:commit')).toEqual([])
    await act(async () => page.getByRole('button', { name: '从本章分支', exact: true }).click())
    await vi.waitFor(() => expect(calls('story:fork-chapter')).toHaveLength(1))
    expect(calls('story:fork-chapter')[0][1]).toMatchObject({ afterChapter: 2, placement: 'branch' })
    await expect.element(page.getByRole('textbox', { name: '章节标题' })).toHaveValue('导入章的独立分支')
    expect(calls('db:blueprint-upsert')).toEqual([])
    expect(stored.map(item => item.chapterNumber)).toEqual([3, 4, 5])
    await act(async () => page.getByRole('button', { name: '灯室', exact: true }).click())
    await expect.element(page.getByRole('textbox', { name: '章节标题' })).toHaveValue('灯室')
  })

  it('相同章号的分支采用原蓝图字段，保存仅写独立节点，不写主线蓝图表', async () => {
    const plain = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    const graph = chapterSnapshot()
    const branchId = '12345678-1234-4234-8234-123456789abc'
    const { chapterNumber: _chapter, notesUpdatedAt: _updated, ...branchPlan } = blueprint(3, '独立第三章')
    graph.nodes.push({ id: branchId, kind: 'content', title: branchPlan.title, chapterNumber: 3, event: branchPlan.keyEvents, body: '', revisionId: 'branch-first', chapterBlueprint: branchPlan })
    graph.routes.push({ id: 'branch-route', title: '独立路线', nodeIds: ['chapter:1', 'chapter:2', branchId] })
    graph.edges.push({ id: 'branch-edge', from: 'chapter:2', to: branchId, label: '分支', condition: '' })
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'story:read') return { success: true, data: graph }
      if (channel === 'story:commit') {
        const input = args[0] as { operations: { type: string; node: { id: string } }[] }
        const last = input.operations.filter(op => op.type === 'put-node').at(-1)!.node
        return { success: true, data: { ...graph, revision: 'saved', nodes: graph.nodes.map(item => item.id === last.id ? { ...item, ...last } : item) } }
      }
      return plain(channel, ...args)
    })
    await renderPage()
    await act(async () => page.getByRole('button', { name: '独立第三章', exact: true }).click())
    await expect.element(page.getByRole('textbox', { name: '章节标题' })).toHaveValue('独立第三章')
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('另一种第三章'))
    await act(async () => page.getByLabelText('主角小目标').fill('只沿分支追查'))
    await act(async () => page.getByRole('button', { name: '保存此章', exact: true }).click())
    await vi.waitFor(() => expect(calls('story:commit')).toHaveLength(1))
    const request = calls('story:commit')[0][1] as { operations: { type: string; node: { id: string; chapterBlueprint: { title: string; purpose: string } } }[] }
    expect(request.operations.every(op => op.type === 'put-node' && op.node.id === branchId)).toBe(true)
    expect(request.operations.at(-1)?.node.chapterBlueprint).toMatchObject({ title: '另一种第三章', purpose: '只沿分支追查' })
    expect(calls('db:blueprint-upsert')).toEqual([])
    expect(stored.find(item => item.chapterNumber === 3)?.title).toBe('灯室')
    await act(async () => page.getByRole('button', { name: '灯室', exact: true }).click())
    await expect.element(page.getByRole('textbox', { name: '章节标题' })).toHaveValue('灯室')
  })

  it('打开蓝图页只向主进程要一次章节蓝图恢复稿，不逐个读取生成运行（#536）', async () => {
    await renderPage()
    await vi.waitFor(() => expect(calls('generation:find-blueprint-recovery')).toHaveLength(1))
    expect([...calls('generation:list'), ...calls('generation:read-context')]).toEqual([])
  })
  it('主按钮是写下一章的拆分按钮，点箭头只出现小弹层', async () => {
    await renderPage()
    await expect.element(page.getByRole('button', { name: '写第 2 章' })).toBeVisible()
    expect(page.getByRole('button', { name: '写第 2 章' }).element().className).toContain('pi-btn--primary')
    expect(page.getByRole('button', { name: 'AI 生成蓝图' }).element().className).toContain('pi-btn--secondary')
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })

  it('英文界面以章节树显示原始蓝图节点', async () => {
    stored = [blueprint(1, '旧港')]
    await renderPage()
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    expect(document.querySelectorAll('.story-tree-card[data-mainline="true"]')).toHaveLength(1)
    expect(document.querySelector('.story-tree-title')?.textContent).toContain('1 nodes')
  })

  it('清空全部蓝图在危险分组里，确认前不清空，确认后列表为空并出现空状态', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    const dangerGroup = page.getByRole('group', { name: '危险' })
    await act(async () => dangerGroup.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
    const confirm = page.getByRole('dialog', { name: '清空全部蓝图？' })
    await expect.element(confirm).toHaveTextContent('将删除全部 3 章蓝图')
    expect(calls('db:blueprint-clear-all')).toHaveLength(0)

    await act(async () => confirm.getByRole('button', { name: '取消' }).click())
    expect(calls('db:blueprint-clear-all')).toHaveLength(0)
    await expect.element(page.getByRole('button', { name: '旧港', exact: true })).toBeVisible()

    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
    await act(async () => page.getByRole('dialog', { name: '清空全部蓝图？' }).getByRole('button', { name: '清空全部' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-clear-all')).toHaveLength(1))
    await expect.element(page.getByRole('heading', { name: '从一个起点，长出你的故事' })).toBeVisible()
    await expect.element(page.getByRole('complementary', { name: '章节规划' })).toBeVisible()
  })

  it('删除此章在单章的危险分组里，确认后只删这一章', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '灯室', exact: true }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    const confirm = page.getByRole('dialog', { name: '删除第 3 章蓝图？' })
    await expect.element(confirm).toBeVisible()
    expect(calls('db:blueprint-delete')).toHaveLength(0)
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([3]))
    await expect.element(page.getByRole('button', { name: '灯室', exact: true })).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: '北堤', exact: true })).toBeVisible()
  })

  it('改字段后由外壳的保存（⌘S 同一入口）存全部，页面里不另显示未保存', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '北堤', exact: true }).click())
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('北堤夜雨'))
    await act(async () => page.getByLabelText(/作者微操指导/).fill('节奏放慢，只写声音。'))
    expect(container?.textContent).not.toContain('未保存')

    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    expect(save).not.toBeNull()
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[]).find(item => item.chapterNumber === 2)).toMatchObject({ title: '北堤夜雨', userGuidance: '节奏放慢，只写声音。' })
  })

  it('保存此章只写当前一章', async () => {
    await renderPage()
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-upsert').map(call => call[1])).toMatchObject([{ chapterNumber: 1, title: '旧港潮汐' }]))
  })

  it('保存此章、删除此章、清空蓝图之后项目树不重读目录：蓝图只在数据库里', async () => {
    initProjectService()
    try {
      await renderPage()
      await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-upsert')).toHaveLength(1))
      await act(async () => page.getByRole('button', { name: '灯室', exact: true }).click())
      await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
      await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
      await act(async () => page.getByRole('dialog', { name: '删除第 3 章蓝图？' }).getByRole('button', { name: '删除此章' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-delete')).toHaveLength(1))
      await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
      await act(async () => page.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
      await act(async () => page.getByRole('dialog', { name: '清空全部蓝图？' }).getByRole('button', { name: '清空全部' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-clear-all')).toHaveLength(1))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
      expect(calls('fs:list-dir')).toEqual([])
    } finally {
      disposeProjectService()
    }
  })

  it('保存此章与保存全部成功后通知流程脊、Ctrl P 重读蓝图；保存失败不通知', async () => {
    const refreshes: string[][] = []
    const off = globalEventBus.on('REFRESH_RESOURCE', ({ resources }) => { refreshes.push([...resources]) })
    try {
      await renderPage()
      await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await vi.waitFor(() => expect(refreshes).toEqual([['blueprints']]))

      const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
      await act(async () => { await save!() })
      expect(refreshes).toEqual([['blueprints'], ['blueprints']])

      const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:blueprint-upsert'
        ? { success: false, error: '磁盘已满' } : base(channel, ...args))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
      expect(refreshes).toHaveLength(2)
    } finally {
      off()
    }
  })

  it('保存此章与开始生成进行中时按钮带 aria-busy，结束后撤掉', async () => {
    await renderPage()
    const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    const gates = new Map<string, () => void>()
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:blueprint-upsert' || channel === 'config:set') await new Promise<void>(resolve => gates.set(channel, resolve))
      return base(channel, ...args)
    })
    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    const saving = page.getByRole('button', { name: '保存中…' })
    await expect.element(saving).toHaveAttribute('aria-busy', 'true')
    await act(async () => gates.get('db:blueprint-upsert')!())
    await expect.element(page.getByRole('button', { name: '保存此章' })).not.toHaveAttribute('aria-busy')

    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await act(async () => dialog.getByLabelText('蓝图结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    await vi.waitFor(() => expect(gates.has('config:set')).toBe(true))
    await expect.element(dialog.getByRole('button', { name: '启动中…' })).toHaveAttribute('aria-busy', 'true')
    await act(async () => gates.get('config:set')!())
    await expect.element(dialog.getByRole('button', { name: '开始生成' })).not.toHaveAttribute('aria-busy')
  })

  it('英文界面里作品只有一章时生成范围写 All 1 chapter', async () => {
    useProjectStore.setState({ currentProject: { ...project(), novelConfig: { ...project().novelConfig, totalChapters: 1 } } })
    stored = [blueprint(1, '旧港')]
    await renderPage()
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    await act(async () => page.getByRole('button', { name: 'Generate blueprints' }).click())
    const full = await vi.waitFor(() => [...document.querySelectorAll('[role="dialog"] .stage-bp-option')].find(option => option.textContent?.startsWith('All'))!)
    expect(full.textContent).toBe('All 1 chapter')
  })

  it('出场人物可以逐个添加与移除', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '移除 守塔人' }).click())
    await act(async () => page.getByLabelText('出场人物').fill('沈砺'))
    await act(async () => page.getByLabelText('出场人物').element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[])[0].characters).toEqual(['林岚', '沈砺'])
  })

  it('出场人物重名：一次输入两遍只加一个；已有重名时移除一个只少一个', async () => {
    stored = [{ ...blueprint(1, '旧港'), characters: ['林岚', '守塔人', '守塔人'] }, blueprint(2, '北堤')]
    await renderPage()
    await act(async () => page.getByRole('button', { name: '移除 守塔人' }).first().click())
    await act(async () => page.getByLabelText('出场人物').fill('沈砺、沈砺'))
    await act(async () => page.getByLabelText('出场人物').element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[])[0].characters).toEqual(['林岚', '守塔人', '沈砺'])
  })

  it('输入法组字时按回车是选词，不把拼音当人物加进来', async () => {
    await renderPage()
    const input = page.getByLabelText('出场人物')
    await act(async () => input.fill('shen'))
    await act(async () => input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    expect((input.element() as HTMLInputElement).value).toBe('shen')
    expect([...container!.querySelectorAll('button[aria-label^="移除 "]')].map(button => button.getAttribute('aria-label'))).toEqual(['移除 林岚', '移除 守塔人'])
  })

  it('生成蓝图选覆盖时先危险确认，取消后不启动，生成对话框回来且不当作错误', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await expect.element(dialog).toBeVisible()
    await act(async () => dialog.getByRole('button', { name: '覆盖' }).click())
    await expect.element(dialog.getByText('已有蓝图会被覆盖，开始前再确认一次')).toBeVisible()
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    const confirm = page.getByRole('dialog', { name: '覆盖已有蓝图？' })
    await expect.element(confirm).toHaveTextContent('已有的 3 章蓝图会被新蓝图替换')
    expect(calls('db:project-core-get')).toHaveLength(0)
    await act(async () => confirm.getByRole('button', { name: '取消' }).click())
    await expect.element(dialog.getByRole('button', { name: '开始生成' })).toBeVisible()
    expect(dialog.getByRole('alert').query()).toBeNull()
    expect(calls('db:project-core-get')).toHaveLength(0)
  })

  it('指定范围只补没有蓝图的章，不出现覆盖选项与覆盖提示', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByRole('button', { name: '覆盖' }).click())
    await expect.element(dialog.getByText('已有蓝图会被覆盖，开始前再确认一次')).toBeVisible()
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await expect.element(dialog.getByText('已有蓝图会被覆盖，开始前再确认一次')).not.toBeInTheDocument()
    expect(dialog.getByRole('button', { name: '覆盖' }).query()).toBeNull()
  })

  it('指定范围后取消架构警告：对话框回来，作者填的起止章还在，不当作错误', async () => {
    projectCore = { premise: '灯塔'.repeat(40) }
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await act(async () => dialog.getByLabelText('蓝图结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    const warning = page.getByRole('dialog', { name: '架构还不完整' })
    await expect.element(warning).toBeVisible()
    await act(async () => warning.getByRole('button', { name: '取消' }).click())
    await expect.element(dialog.getByLabelText('蓝图起始章')).toHaveValue(5)
    await expect.element(dialog.getByLabelText('蓝图结束章')).toHaveValue(7)
    expect(dialog.getByRole('alert').query()).toBeNull()
  })

  it('指定范围后启动失败：对话框回来写明原因，作者填的起止章还在', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await act(async () => dialog.getByLabelText('蓝图结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    await expect.element(dialog.getByRole('alert')).toHaveTextContent('「故事前提」尚未生成')
    await expect.element(dialog.getByLabelText('蓝图起始章')).toHaveValue(5)
    await expect.element(dialog.getByLabelText('蓝图结束章')).toHaveValue(7)
  })

  it('批量创作对话框从权威下一章开始，按章数显示主按钮', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '批量创作' }).click())
    const dialog = page.getByRole('dialog', { name: '批量创作' })
    await expect.element(dialog.getByText('第 2 章', { exact: true })).toBeVisible()
    await act(async () => dialog.getByLabelText(/写几章/).fill('4'))
    await expect.element(dialog.getByRole('button', { name: '开始写 4 章' })).toBeVisible()
    await act(async () => dialog.getByRole('radio', { name: /自动定稿/ }).click())
    await expect.element(dialog.getByRole('button', { name: '继续确认自动定稿' })).toBeVisible()
  })

  it('「写几章」清空后重新输入：删掉 1 再输 3 得 3，不是 13；空着离开回到 1', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '批量创作' }).click())
    const count = page.getByRole('dialog', { name: '批量创作' }).getByLabelText(/写几章/)
    const input = count.element() as HTMLInputElement
    await act(async () => input.focus())
    await userEvent.keyboard('{End}{Backspace}')
    await userEvent.keyboard('3')
    expect(input.value).toBe('3')
    await userEvent.keyboard('{Backspace}')
    await act(async () => input.blur())
    expect(input.value).toBe('1')
  })

  it('更多蓝图操作里新建章节：新章接在权威下一章已有蓝图之后并被选中', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '新建章节' }).click())
    await expect.element(page.getByRole('button', { name: '第 4 章', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.element(page.getByRole('region', { name: '第 4 章蓝图' })).toBeVisible()
  })

  it('写作请求落到这一页：可写的那一章自动弹出写作弹层，写不了的章丢掉请求', async () => {
    useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 2 } })
    await renderPage()
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect(useStageStore.getState().writeRequest).toBeNull()

    await act(async () => root?.render(null))
    useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 3 } })
    await renderPage()
    await vi.waitFor(() => expect(useStageStore.getState().writeRequest).toBeNull())
    expect(page.getByRole('dialog', { name: '本次写作选项' }).query()).toBeNull()
  })

  it('蓝图重新加载时页面与打开的弹层都留着，作者刚写的指导不丢', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await act(async () => popover.getByLabelText(/作者微操指导/).fill('作者刚写的指导'))
    await refreshBlueprints()
    await expect.element(popover.getByLabelText(/作者微操指导/)).toHaveValue('作者刚写的指导')
  })

  it('删除确认期间蓝图重新加载：确认框仍是作者选的那一章，删的也是它，选中不跳回', async () => {
    await renderPage(2)
    await act(async () => page.getByRole('button', { name: '灯室', exact: true }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    await expect.element(page.getByRole('dialog', { name: '删除第 3 章蓝图？' })).toBeVisible()
    await refreshBlueprints()
    // 确认框是模态的，页面其余部分对辅助技术隐藏，直接读选中的那一行。
    expect(container?.querySelector('.story-tree-card[data-selected="true"]')?.getAttribute('data-story-node')).toBe('chapter:3')
    const confirm = page.getByRole('dialog', { name: /^删除第 \d+ 章蓝图？$/ })
    await expect.element(confirm).toHaveAccessibleName('删除第 3 章蓝图？')
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([3]))
  })

  it('删除确认期间这一章已被别处删掉：确认后不会改删别的章', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '灯室', exact: true }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    stored = stored.filter(item => item.chapterNumber !== 3)
    await refreshBlueprints()
    const confirm = page.getByRole('dialog', { name: '删除第 3 章蓝图？' })
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await expect.element(confirm).not.toBeInTheDocument()
    expect(calls('db:blueprint-delete')).toEqual([])
  })

  it('下一章变了，写作弹层按新的一章重建，上一章没用掉的指导不带过去', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await act(async () => page.getByRole('dialog', { name: '本次写作选项' }).getByLabelText(/作者微操指导/).fill('只给第 2 章的指导'))
    nextChapter = 3
    await refreshBlueprints()
    await expect.element(page.getByRole('button', { name: '写第 3 章' })).toBeVisible()
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' }).getByLabelText(/作者微操指导/)).toHaveValue('')
  })
})
