import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { ProjectData } from '../../../../shared/ipc-channels'
import type { StoryForkChapterResult } from '../../../../shared/story-branch-ipc'
import { mainlineStoryNodeId, type StorySnapshot } from '../../../../shared/story-branches'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import StoryChapterEntry from '../../../story/StoryChapterEntry'
import { ensureStoryWorkspace, getStoryWorkspace, resetStoryWorkspacesForTests, stageStoryOperations, storyWorkspaceKey, updateStoryWorkspace } from '../../../story/story-workspace'
import StageBlueprint from '../StageBlueprint'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const PROJECT_PATH = 'C:/synthetic/chapter-branches'
const SESSION = { projectId: id(100), leaseId: 'chapter-story-lease', projectPath: PROJECT_PATH }
const project = { id: SESSION.projectId, sessionLease: SESSION.leaseId, name: '分支蓝图', path: PROJECT_PATH,
  novelConfig: { writingLanguage: 'zh-CN', totalChapters: 12, wordsPerChapter: 3000 } } as ProjectData
const saved = { editor: useEditorStore.getState(), project: useProjectStore.getState(), stage: useStageStore.getState(), locale: useLocaleStore.getState() }
const emptyStory = (): StorySnapshot => ({ revision: 'a'.repeat(64), nodes: [], edges: [], routes: [], notes: [], revisions: [] })
let root: Root
let host: HTMLDivElement
let stored: ChapterBlueprint[]
let invoke: ReturnType<typeof vi.fn>
let failSave: boolean
let forkError: string
let result: StoryForkChapterResult
let sourceStory: StorySnapshot
let authoritativeNext: number | null
const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.getAttribute('aria-label') === name || (!element.hasAttribute('aria-label') && element.textContent?.trim() === name))!
const click = async (name: string) => { expect(button(name), name).toBeTruthy(); await act(async () => button(name).click()) }
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
async function confirmInsert(placement: 'insert' | 'branch' = 'insert') {
  await expect.poll(() => Boolean(dialog())).toBe(true)
  await act(async () => {
    dialog().querySelectorAll<HTMLInputElement>('input[type=radio]')[placement === 'insert' ? 0 : 1].click()
    ;[...dialog().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '创建插章')!.click()
  })
}
async function fill(name: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
  expect(element, name).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function blueprint(chapterNumber: number): ChapterBlueprint {
  return { chapterNumber, title: `主线第 ${chapterNumber} 章`, role: '发展', purpose: '调查旧港', keyEvents: '钟声提前', characters: ['林岚'], suspenseHook: '', userGuidance: '', notes: '', notesUpdatedAt: '' }
}
function liveMainline(chapterNumber: number, planned?: ChapterBlueprint, status: 'finalized' | 'unwritten' | 'missing' | 'unavailable' = 'unwritten'): StorySnapshot['nodes'][number] {
  const { chapterNumber: _number, notesUpdatedAt: _updated, ...chapterBlueprint } = planned ?? blueprint(chapterNumber)
  return { id: mainlineStoryNodeId(chapterNumber), kind: 'content', title: planned?.title ?? `导入第 ${chapterNumber} 章`, chapterNumber,
    event: planned?.keyEvents ?? '', body: status === 'finalized' ? `不可改写的第 ${chapterNumber} 章定稿` : '', revisionId: `live:${chapterNumber}`,
    ...(planned ? { chapterBlueprint } : {}),
    mainline: { chapterNumber, manuscriptStatus: status, hasBlueprint: Boolean(planned), hasManuscript: status === 'finalized' } }
}
async function renderImported(chapterNumber: number) {
  await act(async () => root.render(<StageBlueprint projectKey={PROJECT_PATH} initialChapterNumber={chapterNumber} />))
  await expect.poll(() => host.querySelector('.chapter-tree-inspector')?.getAttribute('data-selected-story-node')).toBe(mainlineStoryNodeId(chapterNumber))
}
async function renderStage(chapterNumber = 3) {
  await act(async () => root.render(<StageBlueprint projectKey={PROJECT_PATH} initialChapterNumber={chapterNumber} />))
  await expect.poll(() => host.querySelector('.stage-bp-card')?.getAttribute('aria-label')).toBe(`第 ${chapterNumber} 章蓝图`)
  await expect.poll(() => Boolean(button('从本章分支'))).toBe(true)
}
async function renderEntry(onSaveSource: () => Promise<boolean>, chapterNumber = 3, disabled = false) {
  await act(async () => root.render(<StoryChapterEntry chapterNumber={chapterNumber} projectKey={PROJECT_PATH} onSaveSource={onSaveSource} disabled={disabled} />))
}
async function renderBranchForConnection({ tail = false, full = false, otherSelected = false } = {}) {
  stored.push(blueprint(4))
  const { chapterNumber: _number, notesUpdatedAt: _updated, ...fourthBlueprint } = stored[3]
  result.snapshot.nodes.push({ id: 'chapter:4', kind: 'content', title: fourthBlueprint.title, chapterNumber: 4,
    body: '', event: fourthBlueprint.keyEvents, revisionId: 'live:4', chapterBlueprint: fourthBlueprint,
    mainline: { chapterNumber: 4, manuscriptStatus: 'unwritten', hasBlueprint: true, hasManuscript: false } })
  if (tail) {
    result.snapshot.nodes.push({ id: id(3), kind: 'content', title: '已经连接的后文', chapterNumber: null, body: '后文正文', event: '', revisionId: id(13) })
    result.snapshot.edges.push({ id: id(22), from: result.nodeId, to: id(3), label: '原接回', condition: '' })
    result.snapshot.routes[0].nodeIds.push(id(3))
  }
  if (full) for (let index = 1; index < 256; index++) result.snapshot.routes.push({ ...result.snapshot.routes[0], id: id(300 + index), title: `其他路线${index}` })
  const key = ensureStoryWorkspace(SESSION)
  updateStoryWorkspace(key, { snapshot: result.snapshot, selectedNodeId: otherSelected ? 'chapter:1' : result.nodeId,
    selectedRouteId: otherSelected ? 'mainline' : result.routeId, bridgeToNodeId: tail ? id(3) : '',
    continuationSelections: tail ? { [`route:${result.routeId}:${result.nodeId}`]: id(3) } : {} })
  await act(async () => root.render(<StageBlueprint projectKey={PROJECT_PATH} />))
  await expect.poll(() => host.querySelector('.chapter-tree-inspector')?.getAttribute('data-selected-story-node')).toBe(otherSelected ? 'chapter:1' : result.nodeId)
  return key
}
const noBranchTab = () => expect(useEditorStore.getState().tabs.some(tab => tab.type === 'narrative-thread')).toBe(false)

beforeEach(async () => {
  await page.viewport(1280, 900)
  resetStoryWorkspacesForTests()
  failSave = false; forkError = ''; authoritativeNext = 2; stored = [blueprint(1), blueprint(2), blueprint(3)]
  sourceStory = { ...emptyStory(), nodes: stored.map(item => {
    const { chapterNumber, notesUpdatedAt: _updated, ...chapterBlueprint } = item
    return { id: mainlineStoryNodeId(chapterNumber), kind: 'content', title: item.title, chapterNumber, event: item.keyEvents, body: '',
      revisionId: `live:${chapterNumber}`, chapterBlueprint, mainline: { chapterNumber, manuscriptStatus: 'unwritten', hasBlueprint: true, hasManuscript: false } }
  }) }
  const parent = { id: id(1), kind: 'content' as const, title: '主线第三章快照', chapterNumber: 3, event: '抵达旧港', body: '主线冻结正文', revisionId: id(11) }
  const child = { id: id(2), kind: 'content' as const, title: '新的分支蓝图', chapterNumber: null, event: '', body: '', revisionId: id(12) }
  result = { nodeId: child.id, routeId: id(30), snapshot: { ...emptyStory(), revision: 'b'.repeat(64), nodes: [parent, child],
    edges: [{ id: id(20), from: parent.id, to: child.id, label: '新走向', condition: '' }],
    routes: [{ id: id(30), title: '新分支', nodeIds: [parent.id, child.id] }] } }
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-get-all') return structuredClone(stored)
    if (channel === 'db:draft-authority-sequence') return { status: authoritativeNext === null ? 'invalid' : 'continuous', lastChapterNumber: (authoritativeNext ?? 2) - 1, nextChapterNumber: authoritativeNext ?? undefined, duplicateChapterNumbers: [], authorityFingerprint: 'c'.repeat(64) }
    if (channel === 'db:blueprint-upsert') {
      if (failSave) return { success: false, error: '合成保存失败' }
      const source = args[0] as ChapterBlueprint
      stored = [...stored.filter(item => item.chapterNumber !== source.chapterNumber), structuredClone(source)].sort((a, b) => a.chapterNumber - b.chapterNumber)
      return { success: true }
    }
    if (channel === 'story:read') return { success: true, data: structuredClone(sourceStory) }
    if (channel === 'story:fork-chapter') return forkError ? { success: false, error: forkError } : { success: true, data: structuredClone(result) }
    if (['generation:list', 'db:consistency-exemption-list', 'fs:list-dir', 'db:blueprint-character-sync-list-pending'].includes(channel)) return []
    if (channel === 'config:get') return { blueprintTargetUnits: 800 }
    if (channel === 'generation:list-directory-progress') return { progress: [], diagnostics: [] }
    if (channel === 'db:project-core-get') return null
    if (channel === 'db:character-get-all') return []
    throw new Error(`Unexpected chapter entry IPC: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {}, setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: () => 0 } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project })
  useStageStore.setState({ work: null, writeRequest: null })
  setActiveProjectSessionContext(SESSION)
  host = document.createElement('div'); host.className = 'paper-ink stage-shell'; document.body.append(host); root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); resetStoryWorkspacesForTests(); Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(saved.editor, true); useProjectStore.setState(saved.project, true); useStageStore.setState(saved.stage, true); useLocaleStore.setState(saved.locale, true)
})

describe('chapter blueprint entry into story branches', () => {
  it('continues an imported finalized tail into a saved mainline blueprint without manufacturing parent plans or branch records', async () => {
    stored = []; authoritativeNext = 3
    sourceStory.nodes = [liveMainline(1, undefined, 'finalized'), liveMainline(2, undefined, 'finalized')]
    const originals = structuredClone(sourceStory)
    await page.viewport(393, 852); await renderImported(2)
    expect(button('在「导入第 2 章」后继续').disabled).toBe(false)
    const bounds = button('在「导入第 2 章」后继续').getBoundingClientRect()
    expect(bounds.width).toBeGreaterThan(20)
    await click('在「导入第 2 章」后继续')
    await expect.poll(() => host.querySelector('.stage-bp-card')?.getAttribute('aria-label')).toBe('第 3 章蓝图')
    await fill('章节标题', '沿主线继续第三章'); await click('保存此章')
    await expect.poll(() => stored.length).toBe(1)
    expect(stored[0]).toMatchObject({ chapterNumber: 3, title: '沿主线继续第三章' })
    await act(async () => root.render(null))
    await renderStage(3)
    expect(host.querySelector<HTMLInputElement>('input[aria-label="章节标题"]')!.value).toBe('沿主线继续第三章')
    expect(sourceStory).toEqual(originals)
    expect(calls('story:fork-chapter')).toHaveLength(0); expect(calls('story:commit')).toHaveLength(0)
    expect(getStoryWorkspace(storyWorkspaceKey(SESSION))!.pending).toHaveLength(0)
    expect(host.querySelector('[data-story-node="chapter:3"]')).toBeTruthy()
    expect(stored.some(item => item.chapterNumber < 3)).toBe(false)
    expect(invoke.mock.calls.some(call => String(call[0]).startsWith('db:draft-') && call[0] !== 'db:draft-authority-sequence')).toBe(false)
  })

  it('continues to existing manuscript-only next chapter by navigation with no source writes', async () => {
    stored = []; authoritativeNext = 3
    sourceStory.nodes = [liveMainline(1, undefined, 'finalized'), liveMainline(2, undefined, 'finalized')]
    const originals = structuredClone(sourceStory)
    await renderImported(1); await click('继续下一章')
    await expect.poll(() => getStoryWorkspace(storyWorkspaceKey(SESSION))?.selectedNodeId).toBe('chapter:2')
    expect(stored).toEqual([]); expect(sourceStory).toEqual(originals)
    expect(calls('db:blueprint-upsert')).toHaveLength(0); expect(calls('story:fork-chapter')).toHaveLength(0)
    expect(host.querySelector('[data-story-node="chapter:3"]')).toBeNull()
  })

  it('opens an existing locally edited next blueprint without appending another chapter or losing its input', async () => {
    stored = [blueprint(5), blueprint(6)]; authoritativeNext = 6
    sourceStory.nodes = stored.map(item => liveMainline(item.chapterNumber, item))
    await renderStage(6); await fill('章节标题', '第六章未保存输入')
    await click('主线第 5 章'); await click('继续下一章')
    await expect.poll(() => getStoryWorkspace(storyWorkspaceKey(SESSION))?.selectedNodeId).toBe('chapter:6')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="章节标题"]')!.value).toBe('第六章未保存输入')
    expect(host.querySelector('[data-story-node="chapter:7"]')).toBeNull()
    expect(calls('db:blueprint-upsert')).toHaveLength(0)
    expect(stored[1].title).toBe('主线第 6 章')
  })

  it('appends after the visible mainline tail rather than the earlier writing gate, deduplicating rapid clicks', async () => {
    stored = [blueprint(10)]; authoritativeNext = 3
    sourceStory.nodes = [liveMainline(10, stored[0])]
    await renderStage(10); await fill('章节标题', '第十章保留的规划')
    const continueButton = button('继续下一章')
    await act(async () => { continueButton.click(); continueButton.click() })
    await expect.poll(() => getStoryWorkspace(storyWorkspaceKey(SESSION))?.selectedNodeId).toBe('chapter:11')
    expect(host.querySelector('[data-story-node="chapter:3"]')).toBeNull()
    expect(host.querySelectorAll('[data-story-node="chapter:11"]')).toHaveLength(1)
    await click('第十章保留的规划')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="章节标题"]')!.value).toBe('第十章保留的规划')
    expect(calls('db:blueprint-upsert')).toHaveLength(0)
  })

  it('rejects a stale visible continue action after the current project lease changes', async () => {
    await renderStage(3)
    const continueButton = button('继续下一章')
    await act(async () => { useProjectStore.setState({ currentProject: { ...project, sessionLease: 'replacement-lease' } }); continueButton.click() })
    expect(host.querySelector('[data-story-node="chapter:4"]')).toBeNull()
    expect(calls('db:blueprint-upsert')).toHaveLength(0); expect(calls('story:fork-chapter')).toHaveLength(0)
  })

  it('keeps invalid finalized authority guarded instead of creating a new chapter', async () => {
    authoritativeNext = null
    await renderStage(3); await click('继续下一章')
    expect(host.querySelector('[data-story-node="chapter:4"]')).toBeNull()
    expect(calls('db:blueprint-upsert')).toHaveLength(0)
  })

  it.each(['missing', 'unavailable'] as const)('preserves an existing %s next position instead of replacing it with a new blueprint', async status => {
    stored = []; authoritativeNext = 2
    sourceStory.nodes = [liveMainline(1, undefined, 'finalized'), liveMainline(2, undefined, status)]
    await renderImported(1); await click('继续下一章')
    await expect.poll(() => getStoryWorkspace(storyWorkspaceKey(SESSION))?.selectedNodeId).toBe('chapter:2')
    expect(button('继续下一章').disabled).toBe(true)
    expect(stored).toEqual([]); expect(calls('db:blueprint-upsert')).toHaveLength(0)
  })

  it('keeps independent branch continuation as a branch operation rather than creating a mainline blueprint', async () => {
    const key = await renderBranchForConnection()
    const originalBlueprints = structuredClone(stored)
    await click('在「新的分支蓝图」后继续')
    const workspace = getStoryWorkspace(key)!
    expect(workspace.selectedNodeId).not.toMatch(/^chapter:/)
    expect(workspace.pending.some(operation => operation.type === 'put-node')).toBe(true)
    expect(stored).toEqual(originalBlueprints); expect(calls('db:blueprint-upsert')).toHaveLength(0)
  })

  it('branches from the actually selected chapter after saving its latest blueprint, then selects the child and route', async () => {
    await renderStage(3)
    await fill('章节标题', '第三章尚未保存的新蓝图')
    await click('从本章分支')
    await expect.poll(() => calls('story:fork-chapter').length).toBe(1)
    expect(calls('db:blueprint-upsert')[0][1]).toMatchObject({ chapterNumber: 3, title: '第三章尚未保存的新蓝图' })
    expect(calls('story:fork-chapter')[0][1]).toMatchObject({ afterChapter: 3, placement: 'branch', expectedRevision: 'a'.repeat(64), projectSession: SESSION })
    const channels = invoke.mock.calls.map(call => call[0])
    expect(channels.indexOf('db:blueprint-upsert')).toBeLessThan(channels.lastIndexOf('story:read'))
    expect(channels.lastIndexOf('story:read')).toBeLessThan(channels.indexOf('story:fork-chapter'))
    const workspace = getStoryWorkspace(storyWorkspaceKey(SESSION))!
    expect(workspace.selectedNodeId).toBe(result.nodeId); expect(workspace.selectedRouteId).toBe(result.routeId)
    expect(workspace.snapshot).toEqual(result.snapshot)
    expect(host.querySelector('.chapter-tree-inspector')?.getAttribute('data-selected-story-node')).toBe(result.nodeId)
    expect(useEditorStore.getState().tabs.some(tab => tab.type === 'narrative-thread')).toBe(false)
    expect(stored.map(item => item.chapterNumber)).toEqual([1, 2, 3])
    expect(invoke.mock.calls.some(call => String(call[0]).startsWith('db:draft-') && call[0] !== 'db:draft-authority-sequence')).toBe(false)
  })

  it('passes the selected source chapter and insert placement for an interlude', async () => {
    await renderStage(2); await click('在两章间插入')
    expect(dialog().querySelectorAll<HTMLInputElement>('input[type=radio]')[0].checked).toBe(true)
    expect(calls('story:fork-chapter')).toHaveLength(0)
    expect(calls('db:blueprint-upsert')).toHaveLength(0)
    await confirmInsert()
    await expect.poll(() => calls('story:fork-chapter').length).toBe(1)
    expect(calls('story:fork-chapter')[0][1]).toMatchObject({ afterChapter: 2, placement: 'insert', title: '第 2 章后的插章' })
    expect(stored).toHaveLength(3)
  })

  it('does not fork or navigate when the edited source blueprint cannot be saved', async () => {
    await renderStage(3); await fill('章节标题', '保存失败仍保留的蓝图'); failSave = true
    const initialReads = calls('story:read').length
    await click('从本章分支')
    await expect.poll(() => Boolean(host.querySelector('.chapter-tree-message[role="alert"]'))).toBe(true)
    expect(calls('story:fork-chapter')).toHaveLength(0); expect(calls('story:read')).toHaveLength(initialReads)
    expect(host.querySelector<HTMLInputElement>('input[aria-label="章节标题"]')!.value).toBe('保存失败仍保留的蓝图')
    expect(stored[2].title).toBe('主线第 3 章'); noBranchTab()
  })

  it('honours a false save result before reading or creating a branch', async () => {
    const saveSource = vi.fn(async () => false)
    await renderEntry(saveSource); await click('从本章分支')
    expect(saveSource).toHaveBeenCalledOnce()
    expect(calls('story:read')).toHaveLength(0); expect(calls('story:fork-chapter')).toHaveLength(0)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('尚未完整保存'); noBranchTab()
  })

  it('retains unsaved tree input and blocks source saving and forking until it is resolved', async () => {
    const key = ensureStoryWorkspace(SESSION)
    updateStoryWorkspace(key, { snapshot: result.snapshot })
    stageStoryOperations(key, [{ type: 'put-node', node: { ...result.snapshot.nodes[1], body: '树中未保存的新稿' } }])
    const saveSource = vi.fn(async () => true)
    await renderEntry(saveSource); await click('从本章分支')
    expect(saveSource).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('章节树还有未保存修改')
    expect(getStoryWorkspace(key)!.pending).toHaveLength(1)
    expect(calls('story:fork-chapter')).toHaveLength(0); noBranchTab()
  })

  it('does not create an old chapter branch after the author changes selection while saving', async () => {
    let finish!: (value: boolean) => void
    const saveSource = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    await renderEntry(saveSource, 3); await click('从本章分支')
    await renderEntry(saveSource, 2)
    await act(async () => finish(true))
    expect(calls('story:read')).toHaveLength(0); expect(calls('story:fork-chapter')).toHaveLength(0); noBranchTab()
  })

  it('keeps the current workspace and page when chapter forking is rejected', async () => {
    forkError = 'STORY_REVISION_STALE'
    await renderEntry(async () => true); await click('从本章分支')
    expect(calls('story:fork-chapter')).toHaveLength(1)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('剧情树已变化')
    expect(getStoryWorkspace(storyWorkspaceKey(SESSION))!.snapshot).toBeNull(); noBranchTab()
  })

  it('does not save or fork while the source entry is disabled', async () => {
    const saveSource = vi.fn(async () => true)
    await renderEntry(saveSource, 3, true)
    expect(button('从本章分支').disabled).toBe(true); expect(button('在两章间插入').disabled).toBe(true)
    await click('从本章分支')
    expect(saveSource).not.toHaveBeenCalled(); expect(calls('story:fork-chapter')).toHaveLength(0)
  })

  it('opens chapter-view branches in the existing blueprint editor without a second plot editor', async () => {
    useEditorStore.getState().openFile({ id: 'chapter-card-editor', type: 'chapter-card', name: '蓝图', projectKey: PROJECT_PATH, chapterNumber: 3, chapterSelectRequest: 1 })
    await renderEntry(async () => true); await click('从本章分支')
    const editor = useEditorStore.getState(), active = editor.tabs.find(tab => tab.id === editor.activeTabId)!
    expect(editor.tabs.filter(tab => tab.type === 'chapter-card')).toHaveLength(1)
    expect(active).toMatchObject({ type: 'chapter-card', projectKey: PROJECT_PATH })
    expect(active.chapterNumber).toBeUndefined()
    expect(active.chapterSelectRequest).toBeUndefined()
    expect(editor.tabs.some(tab => tab.type === 'narrative-thread')).toBe(false)
    const workspace = getStoryWorkspace(storyWorkspaceKey(SESSION))!
    expect(workspace.selectedNodeId).toBe(result.nodeId)
    expect(workspace.selectedRouteId).toBe(result.routeId)
  })

  it('defaults inserted chapter generation to the immediately following chapter, not the route ending', async () => {
    const route = result.snapshot.routes[0]
    route.nodeIds.push('chapter:4', 'chapter:5')
    result.snapshot.edges.push({ id: id(21), from: result.nodeId, to: 'chapter:4', label: '', condition: '' })
    sourceStory.nodes.push({ ...sourceStory.nodes[2], id: 'chapter:4', chapterNumber: 4, title: '第四章', revisionId: 'live:4', mainline: { chapterNumber: 4, manuscriptStatus: 'draft', hasBlueprint: true }, body: '第四章已保存正文' })
    await renderEntry(async () => true); await click('在两章间插入')
    await confirmInsert()
    const workspace = getStoryWorkspace(storyWorkspaceKey(SESSION))!
    expect(workspace.bridgeToNodeId, 'stored bridge after connecting').toBe('chapter:4')
    expect(workspace.continuationSelections[`route:${result.routeId}:${result.nodeId}`]).toBe('chapter:4')
    expect(workspace.selectedNodeId).toBe(result.nodeId)
  })

  it('creates an independent route without a future chapter when the author chooses not to reconnect', async () => {
    await renderStage(2); await click('在两章间插入'); await confirmInsert('branch')
    await expect.poll(() => calls('story:fork-chapter').length).toBe(1)
    expect(calls('story:fork-chapter')[0][1]).toMatchObject({ afterChapter: 2, placement: 'branch' })
    const workspace = getStoryWorkspace(storyWorkspaceKey(SESSION))!
    expect(workspace.bridgeToNodeId).toBe('')
    expect(workspace.snapshot!.routes.find(route => route.id === workspace.selectedRouteId)!.nodeIds).toEqual([id(1), result.nodeId])
    expect(workspace.snapshot!.routes.find(route => route.id === workspace.selectedRouteId)!.nodeIds).not.toContain('chapter:3')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="衔接后文"]')!.value).toBe('')
    expect(host.textContent).toContain('仅参考前文')
  })

  it('cancels insertion before any source save, extra read or chapter creation and preserves the edited blueprint', async () => {
    await renderStage(2); await fill('章节标题', '取消时保留的父章输入')
    const before = calls('story:read').length
    await click('在两章间插入')
    await act(async () => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '取消')!.click())
    expect(calls('db:blueprint-upsert')).toHaveLength(0); expect(calls('story:fork-chapter')).toHaveLength(0)
    expect(calls('story:read')).toHaveLength(before)
    expect(host.querySelector<HTMLInputElement>('[aria-label="章节标题"]')!.value).toBe('取消时保留的父章输入')
    expect(dialog()).toBeNull()
  })

  it.each(['last', 'unavailable'] as const)('disables reconnect for a %s next chapter and creates an independent route', async mode => {
    if (mode === 'unavailable') sourceStory.nodes[2].mainline!.manuscriptStatus = 'unavailable'
    await renderStage(mode === 'last' ? 3 : 2); await click('在两章间插入')
    const radios = dialog().querySelectorAll<HTMLInputElement>('input[type=radio]')
    expect(radios[0].disabled).toBe(true); expect(radios[0].checked).toBe(false); expect(radios[1].checked).toBe(true)
    await confirmInsert('branch'); await expect.poll(() => calls('story:fork-chapter').length).toBe(1)
    expect(calls('story:fork-chapter')[0][1]).toMatchObject({ placement: 'branch' })
  })

  it('dismisses an open choice when its project lease changes without saving or forking', async () => {
    await renderStage(2); await click('在两章间插入')
    expect(dialog()).toBeTruthy()
    await act(async () => useProjectStore.setState({ currentProject: { ...project, sessionLease: 'replacement-lease' } }))
    expect(dialog()).toBeNull()
    expect(calls('db:blueprint-upsert')).toHaveLength(0); expect(calls('story:fork-chapter')).toHaveLength(0)
  })

  it.each(['identity', 'body', 'blueprint', 'unavailable'] as const)('refuses a %s drift in the displayed next source while saving the parent, retaining its input', async drift => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const handler = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => { if (channel === 'db:blueprint-upsert') await pending; return handler(channel, ...args) })
    await renderStage(2); await fill('章节标题', '保存期间仍保留的父章输入'); await click('在两章间插入'); await confirmInsert()
    expect(calls('story:fork-chapter')).toHaveLength(0)
    const next = sourceStory.nodes[2]
    if (drift === 'identity') sourceStory.nodes = [...sourceStory.nodes.slice(0, 2), { ...next, id: 'chapter:4', chapterNumber: 4, mainline: { ...next.mainline!, chapterNumber: 4 } }]
    if (drift === 'body') next.body = '后文在源章保存期间已改写'
    if (drift === 'blueprint') next.chapterBlueprint!.purpose = '后文的新蓝图目标'
    if (drift === 'unavailable') next.mainline!.manuscriptStatus = 'unavailable'
    await act(async () => finish())
    await expect.poll(() => host.textContent).toContain('接回目标已变化，请重新选择插章走向')
    expect(calls('story:fork-chapter')).toHaveLength(0)
    expect(host.querySelector<HTMLInputElement>('[aria-label="章节标题"]')!.value).toBe('保存期间仍保留的父章输入')
    expect(stored[1].title).toBe('保存期间仍保留的父章输入')
  })

  it('allows the source chapter save to change the whole-story revision when its displayed next source is unchanged', async () => {
    const handler = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      const response = await handler(channel, ...args)
      if (channel === 'db:blueprint-upsert') sourceStory.revision = 'd'.repeat(64)
      return response
    })
    await renderStage(2); await fill('章节标题', '作者主动保存的父章蓝图'); await click('在两章间插入'); await confirmInsert()
    await expect.poll(() => calls('story:fork-chapter').length).toBe(1)
    expect(calls('story:fork-chapter')[0][1]).toMatchObject({ placement: 'insert', expectedRevision: 'd'.repeat(64) })
  })

  it('uses the same explicit choice for the compatibility entry and cancels without saving or forking', async () => {
    const saveSource = vi.fn(async () => true)
    await renderEntry(saveSource, 2); await click('在两章间插入')
    await expect.poll(() => Boolean(dialog())).toBe(true)
    await act(async () => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '取消')!.click())
    expect(saveSource).not.toHaveBeenCalled(); expect(calls('story:fork-chapter')).toHaveLength(0)
    await click('在两章间插入'); await confirmInsert('branch')
    await expect.poll(() => calls('story:fork-chapter').length).toBe(1)
    expect(calls('story:fork-chapter')[0][1]).toMatchObject({ placement: 'branch', afterChapter: 2 })
  })

  it('rejects a displayed next-source change after the compatibility entry saves its parent', async () => {
    let finish!: (value: boolean) => void
    const saveSource = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    await renderEntry(saveSource, 2); await click('在两章间插入'); await confirmInsert()
    sourceStory.nodes[2].body = '兼容入口的后文已更新'
    await act(async () => finish(true))
    await expect.poll(() => host.textContent).toContain('接回目标已变化')
    expect(calls('story:fork-chapter')).toHaveLength(0)
  })

  it('selects the actual connection source and its route after success, preserving pending input and remembering the selected later chapter', async () => {
    const key = await renderBranchForConnection()
    await act(async () => stageStoryOperations(key, [{ type: 'put-node', node: { ...result.snapshot.nodes[1], body: '仍然保留的独立输入' } }]))
    await click('从「新的分支蓝图」连接现有节点')
    await act(async () => { const selector = host.querySelector<HTMLSelectElement>('[aria-label="当前章节路线"]')!; selector.value = 'mainline'; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(getStoryWorkspace(key)!.selectedNodeId).toBe('chapter:1')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-story-node="chapter:4"] .story-tree-card-select')!.click())
    const workspace = getStoryWorkspace(key)!
    expect(workspace.selectedNodeId).toBe(result.nodeId); expect(workspace.selectedRouteId).toBe(result.routeId)
    expect(workspace.bridgeToNodeId).toBe('chapter:4')
    expect(workspace.continuationSelections[`route:${result.routeId}:${result.nodeId}`]).toBe('chapter:4')
    expect(workspace.pending).toContainEqual(expect.objectContaining({ type: 'put-route', route: expect.objectContaining({ id: result.routeId, nodeIds: [id(1), result.nodeId, 'chapter:4'] }) }))
    expect(workspace.pending).toContainEqual(expect.objectContaining({ type: 'put-node', node: expect.objectContaining({ body: '仍然保留的独立输入' }) }))
    expect(host.querySelector<HTMLSelectElement>('[aria-label="衔接后文"]')!.value, 'visible later chapter selection').toBe('chapter:4')
  })

  it('blocks a cycle target without changing the remembered later chapter or pending input', async () => {
    const key = await renderBranchForConnection({ tail: true })
    const before = structuredClone(getStoryWorkspace(key)!)
    await click('从「新的分支蓝图」连接现有节点')
    const target = host.querySelector<HTMLButtonElement>(`[data-story-node="${id(1)}"] .story-tree-card-select`)!
    expect(target.disabled).toBe(true)
    await act(async () => target.click())
    const after = getStoryWorkspace(key)!
    expect(after.bridgeToNodeId).toBe(before.bridgeToNodeId); expect(after.continuationSelections).toEqual(before.continuationSelections)
    expect(after.pending).toEqual(before.pending); expect(after.selectedNodeId).toBe(before.selectedNodeId)
  })

  it('retains the original context and remembered continuation when the route-capacity planner rejects an otherwise connectable target', async () => {
    const key = await renderBranchForConnection({ tail: true, full: true })
    const before = structuredClone(getStoryWorkspace(key)!)
    await click('从「新的分支蓝图」连接现有节点')
    const target = host.querySelector<HTMLButtonElement>('[data-story-node="chapter:4"] .story-tree-card-select')!
    expect(target.disabled).toBe(false)
    await act(async () => target.click())
    const after = getStoryWorkspace(key)!
    expect(after.error).toBe('STORY_SIZE_LIMIT')
    expect(after.bridgeToNodeId).toBe(before.bridgeToNodeId); expect(after.continuationSelections).toEqual(before.continuationSelections)
    expect(after.pending).toEqual(before.pending); expect(after.selectedNodeId).toBe(before.selectedNodeId); expect(after.selectedRouteId).toBe(before.selectedRouteId)
  })

  it('keeps both insertion choices and confirmation inside a 393px phone dialog', async () => {
    await page.viewport(393, 852); await renderStage(2); await click('在两章间插入')
    await expect.poll(() => Boolean(dialog())).toBe(true)
    const bounds = dialog().getBoundingClientRect()
    expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(393)
    expect(dialog().scrollWidth).toBeLessThanOrEqual(dialog().clientWidth + 1)
    await page.screenshot({ path: '../../../../../.runtime/insert-chapter-choice-phone.png', element: dialog() })
    expect(calls('story:fork-chapter')).toHaveLength(0)
  })
})
