import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import CodeMirrorEditor from '../../editor/CodeMirrorEditor'
import { useDraftActions } from '../../editor/use-draft-actions'
import type { useChapterBlueprints } from '../../editor/use-chapter-blueprints'
import ChapterTreeWorkspace from '../ChapterTreeWorkspace'
import { getStoryWorkspace, loadStoryWorkspace, readStoryContext, resetStoryWorkspacesForTests, saveStoryWorkspace, storyWorkspaceKey } from '../story-workspace'
import { MAINLINE_STORY_ROUTE_ID, mainlineStoryNodeId, type StoryOperation, type StorySnapshot } from '../../../shared/story-branches'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { formatResourceUri } from '../../../shared/project-paths'
import { globalEventBus } from '../../../shared/event-bus'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../../stores/editor-store'
import { PROJECT_MANUALLY_SAVED } from '../../../services/project-save-events'
import { useProjectStore } from '../../../stores/project-store'
import { useDraftStore } from '../../../stores/draft-store'
import { openDraftTab } from '../../../stores/open-draft-tab'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { toast } from '../../ui/Toast'
import { BLUEPRINT, ORIGINAL, SESSION, chapterProject, createChapterBackend } from '../../stage/chapter/__tests__/chapter-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const branchId = '00000000-0000-4000-8000-000000000241'
const routeId = '00000000-0000-4000-8000-000000000242'
const key = storyWorkspaceKey(SESSION)
const saved = { editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(), stage: useStageStore.getState(), workflow: useWorkflowStore.getState() }
let host: HTMLDivElement
let root: Root
let backend: ReturnType<typeof createChapterBackend>
let draft: ReturnType<typeof backend.addDraft>
let database: StorySnapshot
let invoke: ReturnType<typeof vi.fn>
let failCommit: boolean
let contextWait: Promise<void> | undefined
let releaseContext: (() => void) | undefined
let saveWait: Promise<void> | undefined
let releaseSave: (() => void) | undefined
let authorSaveSignal: ReturnType<typeof vi.fn<(event: Event) => void>>

const workspace = () => getStoryWorkspace(key)!
const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)
const revision = () => `revision:${draft.content}:${database.nodes.find(node => node.id === branchId)!.chapterBlueprint!.purpose}`
const plan = { blueprints: [BLUEPRINT], selected: BLUEPRINT, projectDataReady: true, saving: false, saveChapter: vi.fn(async () => true) } as unknown as ReturnType<typeof useChapterBlueprints>

function MainlineEditor() {
  const tab = useEditorStore(state => state.tabs.find(item => item.draftId === draft.id))!
  const actions = useDraftActions({ tabId: tab.id, filePath: tab.filePath!, content: tab.content ?? '', projectKey: SESSION.projectPath })
  return <CodeMirrorEditor content={tab.content ?? ''} filePath={tab.filePath} onChange={actions.onBodyChange} onSave={actions.save} mode="prose" />
}
const tree = () => <ChapterTreeWorkspace projectKey={SESSION.projectPath} plan={plan} rows={new Map()} onDeleteMainline={() => {}} />
async function render(view: 'tree' | 'editor') { await act(async () => root.render(view === 'tree' ? tree() : <MainlineEditor />)) }
async function idle() { await expect.poll(() => workspace()?.busy).toBe(false) }
async function selectBranch() {
  await act(async () => page.getByRole('button', { name: '独立分支章', exact: true }).click())
  await expect.element(page.getByRole('textbox', { name: '章节标题', exact: true })).toHaveValue('独立分支章')
}
async function editBranch(value: string) {
  const input = host.querySelector<HTMLTextAreaElement>('.stage-bp-card textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(workspace().pending).toHaveLength(1)
}
async function click(name: string) { await act(async () => page.getByRole('button', { name, exact: true }).click()) }
async function saveMainline(value: string) {
  await render('editor')
  const tab = useEditorStore.getState().tabs.find(item => item.draftId === draft.id)!
  await act(async () => useEditorStore.getState().updateTabContent(tab.id, value))
  await act(async () => host.querySelector('.cm-content')!.dispatchEvent(new KeyboardEvent('keydown', {
    key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true,
  })))
  await expect.poll(() => calls('db:draft-update-content').length).toBe(1)
}

beforeEach(async () => {
  authorSaveSignal = vi.fn<(event: Event) => void>()
  window.addEventListener(PROJECT_MANUALLY_SAVED, authorSaveSignal)
  await page.viewport(1280, 900)
  resetStoryWorkspacesForTests()
  failCommit = false; contextWait = undefined; releaseContext = undefined; saveWait = undefined; releaseSave = undefined
  backend = createChapterBackend()
  draft = backend.addDraft({ status: 'draft', content: ORIGINAL })
  database = {
    revision: '', nodes: [
      { id: mainlineStoryNodeId(3), revisionId: 'main-revision', kind: 'content', chapterNumber: 3, title: BLUEPRINT.title, event: BLUEPRINT.keyEvents, body: ORIGINAL,
        mainline: { chapterNumber: 3, hasBlueprint: true, hasManuscript: true, manuscriptStatus: 'draft' } },
      { id: branchId, revisionId: 'branch-revision', kind: 'content', chapterNumber: 4, title: '独立分支章', event: '', body: '',
        chapterBlueprint: { title: '独立分支章', role: '发展', purpose: '原分支目标', keyEvents: '独立调查', characters: [], suspenseHook: '', userGuidance: '', notes: '' } },
    ], edges: [{ id: '00000000-0000-4000-8000-000000000243', from: mainlineStoryNodeId(3), to: branchId, label: '分支', condition: '' }],
    routes: [{ id: MAINLINE_STORY_ROUTE_ID, title: '主线', nodeIds: [mainlineStoryNodeId(3)] }, { id: routeId, title: '调查分支', nodeIds: [mainlineStoryNodeId(3), branchId] }], notes: [], revisions: [],
  }
  database.revision = revision()
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'story:read') return { success: true, data: structuredClone(database) }
    if (channel === 'story:context') {
      await contextWait
      return { success: true, data: { request: args[0], target: database.nodes[1], prefix: [database.nodes[0]], entrances: [], note: null, noteCurrent: false, readyForGeneration: true, sourceHash: 'a'.repeat(64), contextHash: 'b'.repeat(64) } }
    }
    if (channel === 'story:commit') {
      const request = args[0] as { expectedRevision: string; operations: StoryOperation[]; projectSession: typeof SESSION }
      expect(request.projectSession).toEqual({ ...SESSION, leaseId: useProjectStore.getState().currentProject!.sessionLease })
      if (failCommit || request.expectedRevision !== database.revision) return { success: false, error: 'STORY_REVISION_CONFLICT' }
      for (const operation of request.operations) {
        if (operation.type !== 'put-node') throw new Error('unexpected test operation')
        database.nodes = database.nodes.map(node => node.id === operation.node.id ? { ...operation.node, revisionId: 'new-branch-revision' } : node)
      }
      database.revision = revision()
      return { success: true, data: structuredClone(database) }
    }
    const result = await backend.invoke(channel, ...args)
    if (channel === 'db:draft-update-content' && (result as { success?: boolean }).success) {
      database.nodes[0].body = draft.content
      database.revision = revision()
      await saveWait
    }
    return result
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => undefined } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [] }, chapterRequest: null, writeRequest: null, sheet: null })
  useWorkflowStore.setState({ activeRuns: [], history: [] })
  await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION)
  const storedDraft = Object.values(useDraftStore.getState().draftsByChapter).flat().find(item => item.id === draft.id)!
  await openDraftTab(storedDraft, BLUEPRINT.title, SESSION)
  host = document.createElement('div'); host.className = 'paper-ink stage-shell'; host.style.cssText = 'width:1100px;min-height:850px'
  document.body.append(host); root = createRoot(host)
  await render('tree'); await idle()
})

afterEach(async () => {
  window.removeEventListener(PROJECT_MANUALLY_SAVED, authorSaveSignal)
  releaseContext?.()
  releaseSave?.()
  await act(async () => root.unmount())
  host.remove(); resetStoryWorkspacesForTests()
  setActiveProjectSessionContext(null)
  useEditorStore.setState(saved.editor, true); useProjectStore.setState(saved.project, true); useDraftStore.setState(saved.drafts, true)
  useStageStore.setState(saved.stage, true); useWorkflowStore.setState(saved.workflow, true)
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('mainline draft save refreshes cached chapter-tree sources', () => {
  it('saves through CodeMirror and the real draft hook, then saves an independent blueprint against the refreshed revision', async () => {
    const before = workspace().snapshot!.revision
    await saveMainline('主线实际保存的新正文')
    await expect.poll(() => workspace().snapshot?.revision).toBe(database.revision)
    expect(authorSaveSignal).toHaveBeenCalledOnce()
    expect((authorSaveSignal.mock.calls[0][0] as CustomEvent).detail.projectPath).toBe(SESSION.projectPath)
    expect(workspace().snapshot!.revision).not.toBe(before)
    expect(calls('story:read')).toHaveLength(2)
    await render('tree'); await selectBranch(); await editBranch('沿独立分支调查新线索')
    await click('保存分支内容'); await idle()
    expect(calls('story:commit')).toHaveLength(1)
    expect((calls('story:commit')[0][1] as { expectedRevision: string }).expectedRevision).toContain('主线实际保存的新正文')
    expect(workspace()).toMatchObject({ error: '', pending: [] })
    expect(database.nodes[0].body).toBe('主线实际保存的新正文')
    expect(database.nodes[1].chapterBlueprint!.purpose).toBe('沿独立分支调查新线索')
    expect(authorSaveSignal).toHaveBeenCalledTimes(2)
  })

  it('persists an internal exit/foreground save without announcing another manual cloud request', async () => {
    await render('editor')
    const tab = useEditorStore.getState().tabs.find(item => item.draftId === draft.id)!
    await act(async () => useEditorStore.getState().updateTabContent(tab.id, '内部保存的正文'))
    await act(async () => saveDirtyEditorChangesForExit(SESSION.projectPath, 'project'))
    expect(draft.content).toBe('内部保存的正文')
    expect(authorSaveSignal).not.toHaveBeenCalled()
  })

  it('retains pending branch input across mainline save and requires explicit review before applying it', async () => {
    await selectBranch(); await editBranch('分支尚未保存的作者输入')
    const pending = structuredClone(workspace().pending)
    await saveMainline('主线保存同时改变了前文')
    await expect.poll(() => workspace().reviewRequired).toBe(true)
    expect(workspace().pending).toEqual(pending)
    expect(calls('story:commit')).toHaveLength(0)
    await render('tree'); await selectBranch()
    await expect.element(page.getByRole('button', { name: '保存分支内容', exact: true })).toBeDisabled()
    await expect(saveStoryWorkspace(key)).rejects.toThrow('STORY_REVIEW_REQUIRED')
    await click('已核对保留的输入'); await click('保存分支内容'); await idle()
    expect(calls('story:commit')).toHaveLength(1)
    expect(database.nodes[1].chapterBlueprint!.purpose).toBe('分支尚未保存的作者输入')
  })

  it('queues the source refresh while continuity is busy and refreshes once that read settles', async () => {
    await selectBranch()
    contextWait = new Promise(resolve => { releaseContext = resolve })
    let reading: ReturnType<typeof readStoryContext>
    await act(async () => { reading = readStoryContext(key, { nodeId: branchId, routeId, mode: 'route' }) })
    expect(workspace().busy).toBe(true)
    await saveMainline('忙碌期间保存的主线')
    await expect.poll(() => draft.content).toBe('忙碌期间保存的主线')
    expect(calls('story:read')).toHaveLength(1)
    await act(async () => { releaseContext!(); await reading! })
    await expect.poll(() => workspace().snapshot?.revision).toBe(database.revision)
    expect(calls('story:read')).toHaveLength(2)
    expect(calls('story:commit')).toHaveLength(0)
  })

  it('refreshes after an explicit failed branch write without automatically replaying that write', async () => {
    await selectBranch(); await editBranch('失败后仍保留的独立蓝图')
    failCommit = true
    await click('保存分支内容'); await idle()
    expect(workspace().error).toBe('STORY_REVISION_CONFLICT')
    await saveMainline('失败之后的正常主线保存')
    await expect.poll(() => workspace().reviewRequired).toBe(true)
    expect(calls('story:commit')).toHaveLength(1)
    expect(workspace().pending).toHaveLength(1)
    failCommit = false
    await render('tree'); await selectBranch(); await click('已核对保留的输入'); await click('保存分支内容'); await idle()
    expect(calls('story:commit')).toHaveLength(2)
    expect(database.nodes[1].chapterBlueprint!.purpose).toBe('失败后仍保留的独立蓝图')
  })

  it('isolates retained input from automatic new-lease refresh, then permits explicit reload and review', async () => {
    await selectBranch(); await editBranch('旧会话的未存输入')
    const before = workspace().snapshot
    const reopened = { ...SESSION, leaseId: 'reopened-lease' }
    await act(async () => {
      useProjectStore.setState({ currentProject: { ...chapterProject(), sessionLease: reopened.leaseId } })
      setActiveProjectSessionContext(reopened)
    })
    await act(async () => {
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['drafts'], projectPath: SESSION.projectPath, projectSession: reopened })
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['drafts'], projectPath: SESSION.projectPath, projectSession: SESSION })
      await loadStoryWorkspace(key, reopened)
    })
    expect(calls('story:read')).toHaveLength(1)
    expect(workspace().snapshot).toBe(before)
    expect(workspace().session).toEqual(SESSION)
    expect(workspace().pending).toHaveLength(1)
    await expect(saveStoryWorkspace(key)).rejects.toThrow('STORY_SESSION_STALE')
    expect(calls('story:commit')).toHaveLength(0)
    await act(async () => loadStoryWorkspace(key, reopened, true))
    expect(workspace().session).toEqual(reopened)
    expect(workspace().reviewRequired).toBe(true)
    expect(workspace().pending).toHaveLength(1)
    await expect(saveStoryWorkspace(key)).rejects.toThrow('STORY_REVIEW_REQUIRED')
    await click('已核对保留的输入'); await click('保存分支内容'); await idle()
    expect(calls('story:commit')).toHaveLength(1)
    expect(database.nodes[1].chapterBlueprint!.purpose).toBe('旧会话的未存输入')
  })

  it('does not refresh or clear input when the actual mainline CAS save fails', async () => {
    const before = workspace().snapshot
    draft.content = '另一个写入者已更新的正文'
    const notify = vi.spyOn(toast, 'error')
    try {
      await saveMainline('本地应保留的正文输入')
      await expect.poll(() => notify.mock.calls.length).toBe(1)
      expect(calls('story:read')).toHaveLength(1)
      expect(workspace().snapshot).toBe(before)
      expect(useEditorStore.getState().tabs.find(tab => tab.filePath === formatResourceUri({ kind: 'draft', id: draft.id }))).toMatchObject({ content: '本地应保留的正文输入', savedContent: ORIGINAL, dirty: true })
      expect(draft.content).toBe('另一个写入者已更新的正文')
      expect(authorSaveSignal).not.toHaveBeenCalled()
    } finally { notify.mockRestore() }
  })

  it('ignores a successful draft-save acknowledgement that arrives after the project lease changed', async () => {
    await selectBranch(); await editBranch('旧会话尚未保存的分支输入')
    const before = workspace().snapshot
    saveWait = new Promise(resolve => { releaseSave = resolve })
    await saveMainline('会话变化前已写入的正文')
    await expect.poll(() => draft.content).toBe('会话变化前已写入的正文')
    await act(async () => {
      useProjectStore.setState({ currentProject: { ...chapterProject(), sessionLease: 'new-save-lease' } })
      setActiveProjectSessionContext({ ...SESSION, leaseId: 'new-save-lease' })
      releaseSave!()
    })
    expect(workspace().snapshot).toBe(before)
    expect(workspace().session).toEqual(SESSION)
    expect(workspace().pending).toHaveLength(1)
    expect(calls('story:read')).toHaveLength(1)
    expect(calls('story:commit')).toHaveLength(0)
    expect(authorSaveSignal).not.toHaveBeenCalled()
  })
})
