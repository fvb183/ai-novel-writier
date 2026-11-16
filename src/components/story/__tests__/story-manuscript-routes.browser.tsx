import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { StorySnapshot } from '../../../shared/story-branches'
import { useProjectStore } from '../../../stores/project-store'
import { useEditorStore, type EditorTab } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useDraftStore } from '../../../stores/draft-store'
import StageSpine from '../../stage/StageSpine'
import StoryManuscript from '../StoryManuscript'
import StoryRouteManager from '../StoryRouteManager'
import { openStoryBlueprint, openStoryManuscript } from '../story-manuscript-navigation'
import { useStoryChapterDeletion } from '../use-story-chapter-deletion'
import { affectedStoryRoutes, ensureStoryWorkspace, getStoryWorkspace, reconcileStorySelection, resetStoryWorkspacesForTests, saveStoryWorkspace, stageStoryOperations, storyPreview, updateStoryWorkspace, useStoryWorkspaces } from '../story-workspace'
import { planDeleteStoryChapter } from '../story-chapter-deletion'

vi.mock('../StoryChapterActions', () => ({ default: () => null }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SESSION = { projectId: id(10), leaseId: 'route-manuscript', projectPath: 'C:/synthetic/route-manuscript' }
const project = { id: SESSION.projectId, sessionLease: SESSION.leaseId, path: SESSION.projectPath, name: 'Synthetic' } as ProjectData
const saved = { editor: useEditorStore.getState(), project: useProjectStore.getState(), locale: useLocaleStore.getState(), drafts: useDraftStore.getState() }
const branchId = id(2), routeId = id(20)
const snapshot = (): StorySnapshot => ({ revision: 'a'.repeat(64), nodes: [
  { id: 'chapter:1', revisionId: 'mainline:one', kind: 'content', title: '导入的第一章', chapterNumber: 1, event: '', body: '主线正文不应被支线编辑改动', mainline: { chapterNumber: 1, manuscriptStatus: 'finalized', hasBlueprint: false } },
  { id: branchId, revisionId: id(12), kind: 'content', title: '同号分支章', chapterNumber: 1, event: '', body: '支线原稿' },
], edges: [{ id: id(30), from: 'chapter:1', to: branchId, label: '', condition: '' }], routes: [
  { id: 'mainline', title: '主线', nodeIds: ['chapter:1'] },
  { id: routeId, title: '雾林路线', nodeIds: ['chapter:1', branchId] },
], notes: [], revisions: [] })
let root: Root, host: HTMLDivElement, key: string, invoke: ReturnType<typeof vi.fn>
const tab: EditorTab = { id: 'branch-prose', type: 'chapter', name: '同号分支章', projectKey: SESSION.projectPath, projectSessionLease: SESSION.leaseId, storyNodeId: branchId, storyRouteId: routeId }
const chapters = [{ number: 1, title: '导入的第一章', phase: 'final' as const, hasFinal: true, running: false, draft: null }]
beforeEach(() => {
  resetStoryWorkspacesForTests()
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project })
  useLocaleStore.setState({ locale: 'zh-CN' }); setActiveProjectSessionContext(SESSION)
  key = ensureStoryWorkspace(SESSION)
  updateStoryWorkspace(key, { snapshot: snapshot(), selectedRouteId: routeId, selectedNodeId: branchId })
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'story:commit') return { success: true, data: { ...storyPreview(getStoryWorkspace(key)!)!, revision: 'b'.repeat(64) } }
    if (channel === 'story:read') return { success: true, data: snapshot() }
    throw new Error(`Unexpected route manuscript IPC: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  host = document.createElement('div'); host.className = 'paper-ink'; document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); resetStoryWorkspacesForTests(); setActiveProjectSessionContext(null)
  useEditorStore.setState(saved.editor, true); useProjectStore.setState(saved.project, true); useLocaleStore.setState(saved.locale, true); useDraftStore.setState(saved.drafts, true)
})
const editBody = async (body: string) => {
  const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="分支正文内容"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, body); editor.dispatchEvent(new Event('input', { bubbles: true })) })
}
function DeletionHarness() {
  const workspace = useStoryWorkspaces(state => state.entries[key])
  const deletion = useStoryChapterDeletion({ workspaceKey: key, snapshot: storyPreview(workspace), onDeleteMainline: vi.fn() })
  return <><button onClick={() => deletion.requestDeleteBlueprint(branchId)}>删除分支蓝图</button><button onClick={() => deletion.requestDeleteNode(branchId)}>树内删除章节</button>{deletion.dialog}</>
}
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === label)
  expect(button, label).toBeTruthy()
  await act(async () => button!.click())
}
const addBlueprint = (body: string) => {
  const before = getStoryWorkspace(key)!.snapshot!, branch = before.nodes.find(node => node.id === branchId)!
  branch.body = body
  branch.chapterBlueprint = { title: branch.title, role: '发展', purpose: '', keyEvents: '旧计划', characters: [], suspenseHook: '', userGuidance: '', notes: '' }
}

describe('manuscript routes retain independent scene identity', () => {
  it('groups canonical chapters and branches by route and opens same-number branches with their UUID', async () => {
    const onChapter = vi.fn()
    await act(async () => root.render(<StageSpine chapters={chapters} stages={[]} location={{ kind: 'stage', stage: 'manuscript', chapter: 1 }} onStage={vi.fn()} onChapter={onChapter} onResource={vi.fn()} onSettings={vi.fn()} />))
    expect(host.querySelectorAll('.stage-manuscript-route')).toHaveLength(2)
    const button = host.querySelector<HTMLButtonElement>(`button[data-story-node="${branchId}"]`)!
    await act(async () => button.click())
    const active = useEditorStore.getState().tabs.find(item => item.id === useEditorStore.getState().activeTabId)
    expect(active).toMatchObject({ storyNodeId: branchId, storyRouteId: routeId, type: 'chapter' })
    expect(active?.chapterNumber).toBeUndefined(); expect(onChapter).not.toHaveBeenCalled()
    const mainline = host.querySelector<HTMLButtonElement>(`button[data-story-node="chapter:1"][data-story-route="${routeId}"]`)!
    await act(async () => mainline.click())
    expect(onChapter).toHaveBeenCalledWith(1)
    expect(getStoryWorkspace(key)!.selectedRouteId).toBe(routeId)
  })
  it('retains branch text through tab unmount and saves only a story operation', async () => {
    await act(async () => root.render(<StoryManuscript tab={tab} />))
    await editBody('独立支线的新正文')
    await act(async () => root.render(<p>another tab</p>))
    await act(async () => root.render(<StoryManuscript tab={tab} />))
    expect(host.querySelector('textarea')?.value).toBe('独立支线的新正文')
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '保存正文')!.click())
    const commits = invoke.mock.calls.filter(call => call[0] === 'story:commit')
    expect(commits).toHaveLength(1)
    expect(getStoryWorkspace(key)!.snapshot?.nodes.find(node => node.id === 'chapter:1')?.body).toBe('主线正文不应被支线编辑改动')
    expect(getStoryWorkspace(key)!.pending).toHaveLength(0)
    expect(invoke.mock.calls.some(call => String(call[0]).startsWith('db:'))).toBe(false)
  })
  it('keeps obsolete project leases read-only and cannot write the new session', async () => {
    await act(async () => root.render(<StoryManuscript tab={{ ...tab, projectSessionLease: 'old-lease' }} />))
    expect(host.querySelector('textarea')?.readOnly).toBe(true)
    expect([...host.querySelectorAll('button')].find(button => button.textContent === '保存正文')?.disabled).toBe(true)
    expect(getStoryWorkspace(key)!.pending).toHaveLength(0)
    expect(invoke).not.toHaveBeenCalled()
  })
  it('returning to a branch blueprint clears an obsolete numeric chapter selection', async () => {
    useEditorStore.setState({ tabs: [{ id: 'existing-blueprint', type: 'chapter-card', name: '蓝图', projectKey: SESSION.projectPath, chapterNumber: 3, chapterSelectRequest: 7 }], activeTabId: 'existing-blueprint' })
    await act(async () => openStoryBlueprint(SESSION, branchId, routeId))
    const blueprint = useEditorStore.getState().tabs.find(item => item.type === 'chapter-card')!
    expect(blueprint.chapterNumber).toBeUndefined()
    expect(blueprint.chapterSelectRequest).toBeUndefined()
    expect(getStoryWorkspace(key)!.selectedNodeId).toBe(branchId)
    expect(getStoryWorkspace(key)!.selectedRouteId).toBe(routeId)
  })
  it('renames a branch route and restores node history without touching canonical chapters', async () => {
    const before = getStoryWorkspace(key)!.snapshot!
    const { revisionId: _revisionId, ...input } = before.nodes.find(node => node.id === branchId)!
    before.revisions = [{ id: id(40), nodeId: branchId, parentRevisionId: null, node: { ...input, body: '历史分支正文' } }]
    await act(async () => root.render(<StoryRouteManager session={SESSION} node={before.nodes.find(node => node.id === branchId)!} workspaceKey={key} />))
    const name = host.querySelector<HTMLInputElement>('input[aria-label="路线名称"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '重命名后的路线'); name.dispatchEvent(new Event('input', { bubbles: true })) })
    const selector = host.querySelector<HTMLSelectElement>('select[aria-label="章节历史版本"]')!
    await act(async () => { selector.value = id(40); selector.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '恢复此版本为待保存稿')!.click())
    const preview = storyPreview(getStoryWorkspace(key)!)!
    expect(preview.routes.find(route => route.id === routeId)?.title).toBe('重命名后的路线')
    expect(preview.nodes.find(node => node.id === branchId)?.body).toBe('历史分支正文')
    expect(preview.nodes.find(node => node.id === 'chapter:1')).toEqual(snapshot().nodes[0])
    expect(getStoryWorkspace(key)!.pending.map(operation => operation.type)).toEqual(['put-route', 'restore-node'])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('deletes a written branch blueprint through confirmation and persists prose and links', async () => {
    addBlueprint('保留支线原稿')
    const before = structuredClone(getStoryWorkspace(key)!.snapshot!)
    await act(async () => root.render(<DeletionHarness />))
    await click('删除分支蓝图')
    expect(host.textContent).toContain('只删除「同号分支章」的蓝图字段')
    expect(invoke).not.toHaveBeenCalled()
    await click('删除并保存')
    const saved = getStoryWorkspace(key)!.snapshot!
    const node = saved.nodes.find(node => node.id === branchId)!
    expect(Object.hasOwn(node, 'chapterBlueprint')).toBe(false)
    expect(node.body).toBe('保留支线原稿')
    expect(saved.edges).toEqual(before.edges); expect(saved.routes).toEqual(before.routes)
    expect(getStoryWorkspace(key)!.pending).toHaveLength(0)
    expect(invoke.mock.calls.filter(call => call[0] === 'story:commit')).toHaveLength(1)
    await act(async () => root.render(<StoryManuscript tab={tab} />))
    expect(host.querySelector('textarea')?.value).toBe('保留支线原稿')
  })

  it('deletes an unwritten branch chapter and its redundant route instead of clearing fields', async () => {
    addBlueprint('')
    await act(async () => root.render(<DeletionHarness />))
    await click('删除分支蓝图'); await click('删除并保存')
    const saved = getStoryWorkspace(key)!.snapshot!
    expect(saved.nodes.map(node => node.id)).toEqual(['chapter:1'])
    expect(saved.routes.map(route => route.id)).toEqual(['mainline'])
    expect(saved.edges).toHaveLength(0)
    expect(getStoryWorkspace(key)!.pending).toHaveLength(0)
  })

  it('retains failed chapter deletion as recoverable pending changes', async () => {
    addBlueprint('')
    invoke.mockImplementation(async () => ({ success: false, error: 'STORY_REVISION_CONFLICT' }))
    await act(async () => root.render(<DeletionHarness />))
    await click('树内删除章节'); await click('删除并保存')
    const workspace = getStoryWorkspace(key)!
    expect(workspace.snapshot?.nodes.some(node => node.id === branchId)).toBe(true)
    expect(workspace.pending).toContainEqual({ type: 'delete-node', id: branchId })
    expect(workspace.error).toBe('STORY_REVISION_CONFLICT')
    expect(workspace.busy).toBe(false)
  })

  it('requires a fresh confirmation if chapter input changes while deletion is open', async () => {
    addBlueprint('')
    await act(async () => root.render(<DeletionHarness />))
    await click('树内删除章节')
    const { revisionId: _revision, ...input } = getStoryWorkspace(key)!.snapshot!.nodes.find(node => node.id === branchId)!
    await act(async () => stageStoryOperations(key, [{ type: 'put-node', node: { ...input, body: '刚输入的新稿' } }]))
    await click('删除并保存')
    expect(invoke).not.toHaveBeenCalled()
    expect(storyPreview(getStoryWorkspace(key)!)!.nodes.find(node => node.id === branchId)?.body).toBe('刚输入的新稿')
    expect(getStoryWorkspace(key)!.error).toContain('重新核对')
  })

  it('reconciles cached legacy selection and continuation to the one canonical chapter', async () => {
    const before = snapshot()
    before.aliases = { nodes: { [id(90)]: 'chapter:1' }, routes: { [id(91)]: 'mainline' }, edges: { [id(92)]: 'canonical-edge' } }
    const workspace = { ...getStoryWorkspace(key)!, selectedNodeId: id(90), selectedRouteId: id(91), selectedEdgeId: id(92), bridgeToNodeId: id(90),
      continuationSelections: { [`route:${id(91)}:${id(90)}`]: branchId, [`route:${id(91)}:chapter:1`]: id(90) } }
    const selection = reconcileStorySelection(workspace, before)
    expect(selection).toMatchObject({ selectedNodeId: 'chapter:1', selectedRouteId: 'mainline', selectedEdgeId: 'canonical-edge', bridgeToNodeId: 'chapter:1' })
    expect(selection.continuationSelections).toEqual({ 'route:mainline:chapter:1': 'chapter:1' })
    updateStoryWorkspace(key, { snapshot: before })
    useDraftStore.setState({ dataProjectSession: SESSION, loading: false, draftsByChapter: { 1: [] } })
    await act(async () => openStoryManuscript(SESSION, id(90), id(91)))
    const active = useEditorStore.getState().tabs.find(item => item.id === useEditorStore.getState().activeTabId)
    expect(active).toMatchObject({ type: 'chapter', chapterNumber: 1 })
    expect(active?.storyNodeId).toBeUndefined()
  })

  it('does not alias an author-edited source away while its save is pending', () => {
    const before = snapshot(); before.aliases = { nodes: { [id(90)]: 'chapter:1' }, routes: { [id(91)]: 'mainline' }, edges: {} }
    const source = { id: id(90), kind: 'content' as const, title: '作者改写', chapterNumber: 1, body: '独立新稿', event: '' }
    const workspace = { ...getStoryWorkspace(key)!, selectedNodeId: id(90), selectedRouteId: id(91), pending: [{ type: 'put-node' as const, node: source }] }
    expect(reconcileStorySelection(workspace, before)).toMatchObject({ selectedNodeId: id(90), selectedRouteId: id(91) })
  })

  it('retains an independently edited legacy source route when opening prose and returning to its blueprint', async () => {
    const before = snapshot(); before.aliases = { nodes: { [id(90)]: 'chapter:1' }, routes: { [id(91)]: 'mainline' }, edges: {} }
    const input = { id: id(90), kind: 'content' as const, title: '作者改写旧快照', chapterNumber: 1, body: '未存的新支线正文', event: '' }
    updateStoryWorkspace(key, { snapshot: before })
    stageStoryOperations(key, [{ type: 'put-node', node: input }])
    await act(async () => openStoryManuscript(SESSION, input.id, id(91)))
    const active = useEditorStore.getState().tabs.find(item => item.id === useEditorStore.getState().activeTabId)!
    expect(active).toMatchObject({ storyNodeId: input.id, storyRouteId: id(91) })
    await act(async () => root.render(<StoryManuscript tab={active} />))
    expect(host.querySelector('textarea')?.value).toBe(input.body)
    expect(getStoryWorkspace(key)!.selectedRouteId).toBe(id(91))
    await act(async () => openStoryBlueprint(SESSION, input.id, id(91)))
    expect(getStoryWorkspace(key)!.selectedNodeId).toBe(input.id)
    expect(getStoryWorkspace(key)!.selectedRouteId).toBe(id(91))
    expect(getStoryWorkspace(key)!.pending).toEqual([{ type: 'put-node', node: input }])
  })

  it('does not replay acknowledged deletions when new input arrives during a successful save', async () => {
    addBlueprint('')
    stageStoryOperations(key, planDeleteStoryChapter(getStoryWorkspace(key)!.snapshot!, branchId).operations)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let commits = 0
    invoke.mockImplementation(async (channel: string) => {
      if (channel !== 'story:commit') throw new Error(`unexpected ${channel}`)
      const committed = structuredClone(storyPreview(getStoryWorkspace(key)!)!)
      if (++commits === 1) await gate
      return { success: true, data: { ...committed, revision: String(commits).repeat(64) } }
    })
    const saving = saveStoryWorkspace(key).catch(error => error.message)
    expect(getStoryWorkspace(key)!.busy).toBe(true)
    const late = { id: id(70), title: '同时新写的后章', kind: 'content' as const, chapterNumber: 7, body: '晚到输入必须保留', event: '' }
    stageStoryOperations(key, [{ type: 'put-node', node: late }])
    release()
    expect(await saving).toBe('STORY_INPUT_CHANGED')
    expect(getStoryWorkspace(key)!.snapshot?.nodes.some(node => node.id === branchId)).toBe(false)
    expect(getStoryWorkspace(key)!.pending).toEqual([{ type: 'put-node', node: late }])
    await saveStoryWorkspace(key)
    expect(getStoryWorkspace(key)!.pending).toHaveLength(0)
    expect(getStoryWorkspace(key)!.snapshot?.nodes.find(node => node.id === late.id)?.body).toBe(late.body)
    expect(invoke.mock.calls[1][1]).toMatchObject({ operations: [{ type: 'put-node', node: late }] })
  })

  it('offers exact shared-route confirmation for a pending edit to a folded legacy source', async () => {
    const before = snapshot(); before.aliases = { nodes: { [id(90)]: 'chapter:1' }, routes: { [id(91)]: 'mainline' }, edges: {},
      affectedRoutes: { [id(90)]: ['旧主线快照路线', '旧森林支线路线'] } }
    const input = { id: id(90), kind: 'content' as const, title: '旧来源独立改写', chapterNumber: 1, body: '作者独立新稿', event: '' }
    updateStoryWorkspace(key, { snapshot: before }); stageStoryOperations(key, [{ type: 'put-node', node: input }])
    expect(affectedStoryRoutes(getStoryWorkspace(key)!)).toEqual(['旧主线快照路线', '旧森林支线路线'])
    await expect(saveStoryWorkspace(key)).rejects.toThrow('STORY_SHARED_EDIT_CONFIRMATION_REQUIRED')
    expect(invoke).not.toHaveBeenCalled()
    await act(async () => root.render(<StoryManuscript tab={{ ...tab, storyNodeId: input.id, storyRouteId: id(91) }} />))
    expect(host.textContent).toContain('旧主线快照路线、旧森林支线路线')
    const checkbox = host.querySelector<HTMLInputElement>('.story-shared-warning input')!
    await act(async () => checkbox.click())
    expect(getStoryWorkspace(key)!.sharedEditConfirmed).toBe(true)
    await click('保存正文')
    expect(invoke.mock.calls.filter(call => call[0] === 'story:commit')[0][1]).toMatchObject({ confirmedSharedEdit: true, operations: [{ type: 'put-node', node: input }] })
  })
})
