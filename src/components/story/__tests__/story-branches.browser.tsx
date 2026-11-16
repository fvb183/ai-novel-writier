import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import StoryBranches from '../StoryBranches'
import AgentInputBox, { prefillAgentInput } from '../../panels/agent/AgentInputBox'
import { getStoryWorkspace, resetStoryWorkspacesForTests, storyPreview, storyWorkspaceKey } from '../story-workspace'
import type { StoryContextRequest, StoryNodeInput, StorySnapshot } from '../../../shared/story-branches'
import type { ModelProfile, ProjectData } from '../../../shared/ipc-channels'
import { saveProjectTransitionDrafts, hasProjectTransitionDrafts } from '../../../services/project-transition'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useAgentStore } from '../../../stores/agent-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useLLMStore } from '../../../stores/llm-store'
import { globalEventBus } from '../../../shared/event-bus'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const session = { projectId: id(100), leaseId: 'story-lease', projectPath: 'C:/synthetic/story' }
const project = { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '分支小说', novelConfig: { writingLanguage: 'zh-CN' } } as ProjectData
const saved = { project: useProjectStore.getState(), agent: useAgentStore.getState(), stage: useStageStore.getState(), llm: useLLMStore.getState() }
let database: StorySnapshot
let root: Root
let host: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let failCommit: boolean
let revision: number
const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.hasAttribute('aria-label') ? item.getAttribute('aria-label') === name : item.textContent?.trim() === name)!
const click = async (name: string) => { expect(button(name), name).toBeTruthy(); await act(async () => button(name).click()) }
const label = (name: string) => [...host.querySelectorAll<HTMLLabelElement>('label')].find(item => item.firstChild?.textContent === name)!
async function fill(name: string, value: string) {
  const element = label(name)?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea') ?? host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`input[aria-label="${name}"],textarea[aria-label="${name}"]`)
  expect(element, name).toBeTruthy()
  await act(async () => {
    const proto = element!.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
    element!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function choose(name: string, value: string) {
  const element = label(name)?.querySelector('select')
  expect(element, name).toBeTruthy()
  await act(async () => { element!.value = value; element!.dispatchEvent(new Event('change', { bubbles: true })) })
}
const idle = () => expect.poll(() => host.querySelector('section')?.getAttribute('aria-busy')).toBe('false')
const treeNode = (nodeId: string) => host.querySelector<HTMLElement>(`[data-story-node="${nodeId}"]`)
const treeViewport = () => host.querySelector<HTMLElement>('[aria-label="可拖动的剧情树"]')!
async function mount(withInput = false) {
  await act(async () => root.render(<><StoryBranches />{withInput && <AgentInputBox />}</>))
  await idle()
}
function fixture(): StorySnapshot {
  const nodes: StoryNodeInput[] = [
    { id: id(1), title: '出发', kind: 'branch', chapterNumber: 1, event: '选择方向', body: '共同开场' },
    { id: id(2), title: '森林路线', kind: 'content', chapterNumber: 2, event: '取得绿钥匙', body: '只在森林发生的事件' },
    { id: id(3), title: '海港路线', kind: 'content', chapterNumber: 2, event: '失去旧地图', body: '只在海港发生的事件' },
    { id: id(4), title: '重逢', kind: 'merge', chapterNumber: 3, event: '到达山顶', body: '共用的汇合正文' },
  ]
  return {
    revision: 'a'.repeat(64), nodes: nodes.map((node, index) => ({ ...node, revisionId: id(index + 20) })),
    edges: [[1, 2], [1, 3], [2, 4], [3, 4]].map(([from, to], index) => ({ id: id(index + 10), from: id(from), to: id(to), label: '继续', condition: '' })),
    routes: [{ id: id(30), title: '森林', nodeIds: [id(1), id(2), id(4)] }, { id: id(31), title: '海港', nodeIds: [id(1), id(3), id(4)] }],
    notes: [], revisions: nodes.map((node, index) => ({ id: id(index + 20), nodeId: node.id, parentRevisionId: null, node })),
  }
}

beforeEach(async () => {
  await page.viewport(1024, 768)
  resetStoryWorkspacesForTests()
  database = fixture(); failCommit = false; revision = 0
  invoke = vi.fn(async (channel: string, request: Record<string, unknown>) => {
    if (channel === 'story:read') return { success: true, data: structuredClone(database) }
    if (channel === 'story:commit') {
      if (failCommit) return { success: false, error: 'STORY_REVISION_STALE' }
      expect(request.projectSession).toEqual(useProjectStore.getState().currentProject?.sessionLease === 'new-lease' ? { ...session, leaseId: 'new-lease' } : session)
      expect(request.expectedRevision).toBe(database.revision)
      database = storyPreview(getStoryWorkspace(storyWorkspaceKey(session))!)!
      database.revision = String(++revision).padStart(64, '0')
      return { success: true, data: structuredClone(database) }
    }
    if (channel === 'story:context') {
      const selection = request as unknown as StoryContextRequest
      const shared = selection.mode === 'shared'
      const route = database.routes.find(item => item.id === selection.routeId)
      const prefix = shared ? [database.nodes[0]] : route!.nodeIds.slice(0, route!.nodeIds.indexOf(selection.nodeId)).map(nodeId => database.nodes.find(item => item.id === nodeId)!)
      const note = database.notes.find(item => item.routeId === selection.routeId && item.nodeId === selection.nodeId) ?? null
      return { success: true, data: { request: selection, sourceHash: 'b'.repeat(64), contextHash: 'c'.repeat(64), target: database.nodes.find(item => item.id === selection.nodeId), prefix,
        entrances: database.routes.map(item => ({ routeId: item.id, title: item.title, nodeIds: item.nodeIds })), note, noteCurrent: Boolean(note?.confirmed), readyForGeneration: shared ? Boolean(note?.confirmed) : selection.nodeId !== id(4) } }
    }
    return { success: true }
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => undefined } })
  useProjectStore.setState({ currentProject: project })
  useAgentStore.setState({ conversations: [], activeConversationId: null, generating: false, toolsInitialized: true })
  useStageStore.setState({ sheet: null })
  useLLMStore.setState({ models: [], defaultModelId: null, stageModelIds: {} })
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div'); host.className = 'paper-ink stage-shell'; host.style.cssText = 'width:100%;max-width:980px;min-width:0;padding:12px;box-sizing:border-box'
  document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); resetStoryWorkspacesForTests()
  useProjectStore.setState(saved.project, true); useAgentStore.setState(saved.agent, true); useStageStore.setState(saved.stage, true); useLLMStore.setState(saved.llm, true)
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('story branch authoring', () => {
  const prepareChapter = () => {
    const blueprint = { title: '森林独立章节', role: '转折', purpose: '带着绿钥匙找到山路', keyEvents: '主角查看锁孔，决定绕开守卫', characters: ['主角'], suspenseHook: '山顶灯光熄灭', userGuidance: '不借用海港事实', notes: '钥匙保持在主角手中' }
    database.nodes[1].chapterBlueprint = structuredClone(blueprint)
    database.revisions[1].node.chapterBlueprint = structuredClone(blueprint)
    useLLMStore.setState({ models: [{ id: 'synthetic-story-model', name: '本地验证模型', modelName: 'fixture', purposes: ['generation'] } as ModelProfile], defaultModelId: 'synthetic-story-model' })
  }

  it('preselects the drafting stage model and honors an explicit model choice for a branch', async () => {
    prepareChapter()
    const originalModel = useLLMStore.getState().models[0]
    useLLMStore.setState({ models: [originalModel, { ...originalModel, id: 'stage-story-model', name: 'Stage writing model' }], stageModelIds: { drafting: 'stage-story-model' } })
    const send = vi.fn(async (_content: string) => {})
    useAgentStore.setState({ sendMessage: send })
    await mount(); await choose('当前节点', id(2)); await choose('当前路线', id(30))
    expect((label('本次生成模型').querySelector('select') as HTMLSelectElement).value).toBe('stage-story-model')
    await choose('本次生成模型', 'synthetic-story-model')
    await click('按蓝图生成章节'); await idle()
    expect(send).toHaveBeenCalledOnce()
    expect(useAgentStore.getState().getActiveConversation()?.modelId).toBe('synthetic-story-model')
  })

  it('does not preselect an arbitrary endpoint when no drafting or default model is assigned', async () => {
    prepareChapter()
    useLLMStore.setState({ defaultModelId: null, stageModelIds: {} })
    await mount(); await choose('当前节点', id(2)); await choose('当前路线', id(30))
    expect((label('本次生成模型').querySelector('select') as HTMLSelectElement).value).toBe('')
    expect(button('按蓝图生成章节').disabled).toBe(true)
  })

  it('edits a route chapter blueprint independently and retains it across node switches', async () => {
    prepareChapter(); await mount(); await choose('当前节点', id(2))
    await fill('本章目标', '独立蓝图中未保存的新目标')
    await fill('出场人物', '主角、向导、')
    await choose('当前节点', id(3)); await choose('当前节点', id(2))
    expect((label('本章目标').querySelector('textarea') as HTMLTextAreaElement).value).toBe('独立蓝图中未保存的新目标')
    await click('保存分支内容'); await idle()
    expect(database.nodes.find(node => node.id === id(2))?.chapterBlueprint?.purpose).toBe('独立蓝图中未保存的新目标')
    const node = database.nodes.find(node => node.id === id(2))!
    expect(node.chapterBlueprint?.characters).toEqual(['主角', '向导'])
    expect(node.body).toBe('只在森林发生的事件')
    expect(database.nodes.find(node => node.id === id(3))?.body).toBe('只在海港发生的事件')
  })

  it('dispatches blueprint generation through the scoped main agent with an explicitly selected later scene', async () => {
    prepareChapter()
    const send = vi.fn(async (_content: string) => {})
    useAgentStore.setState({ sendMessage: send })
    await mount(); await choose('当前节点', id(2)); await choose('当前路线', id(30))
    expect((label('接入后文（可选）').querySelector('select') as HTMLSelectElement).value).toBe(id(4))
    await click('按蓝图生成章节'); await idle()
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0]).toContain('同时考虑父级前文和指定 continuation 后文')
    expect(useAgentStore.getState().getActiveConversation()).toMatchObject({ modelId: 'synthetic-story-model', storyContext: { nodeId: id(2), routeId: id(30), mode: 'route', bridgeToNodeId: id(4) } })
    expect(calls('story:context').at(-1)![1].bridgeToNodeId).toBe(id(4))
    expect(calls('story:commit')).toHaveLength(0)
    expect(useStageStore.getState().sheet).toEqual({ kind: 'assistant' })
  })

  it('omits all later context when the author chooses not to reconnect yet', async () => {
    prepareChapter()
    const send = vi.fn(async (_content: string) => {})
    useAgentStore.setState({ sendMessage: send })
    await mount(); await choose('当前节点', id(2)); await choose('当前路线', id(30)); await choose('接入后文（可选）', '')
    await click('按蓝图生成章节'); await idle()
    expect(send.mock.calls[0][0]).toContain('只衔接所选路线的父级前情，不采用任何后文')
    expect(useAgentStore.getState().getActiveConversation()?.storyContext).toEqual({ nodeId: id(2), routeId: id(30), mode: 'route' })
    expect(calls('story:context').at(-1)![1]).not.toHaveProperty('bridgeToNodeId')
  })

  it('runs a read-only continuity review with the same parent and later-scene selection', async () => {
    prepareChapter()
    const send = vi.fn(async (_content: string) => {})
    useAgentStore.setState({ sendMessage: send })
    await mount(); await choose('当前节点', id(2)); await choose('当前路线', id(30))
    await click('审查衔接一致性'); await idle()
    expect(send.mock.calls[0][0]).toContain('本次只读审稿，不调用任何修改提案')
    expect(send.mock.calls[0][0]).toContain('和指定后文')
    expect(calls('story:commit')).toHaveLength(0)
    expect(database.nodes.find(node => node.id === id(2))?.body).toBe('只在森林发生的事件')
  })

  it('manually connects an existing scene and reviews it as the selected later constraint', async () => {
    prepareChapter()
    const send = vi.fn(async (_content: string) => {})
    useAgentStore.setState({ sendMessage: send })
    await mount(); await choose('当前节点', id(2)); await choose('当前路线', id(30))
    await click('从「森林路线」连接现有节点'); await click('海港路线')
    expect(getStoryWorkspace(storyWorkspaceKey(session))!.bridgeToNodeId).toBe(id(3))
    await click('保存分支内容'); await idle(); await click('章节蓝图')
    expect(database.edges.some(edge => edge.from === id(2) && edge.to === id(3))).toBe(true)
    expect((label('接入后文（可选）').querySelector('select') as HTMLSelectElement).value).toBe(id(3))
    await click('审查衔接一致性'); await idle()
    expect(send).toHaveBeenCalledOnce()
    expect(useAgentStore.getState().getActiveConversation()?.storyContext).toEqual({ nodeId: id(2), routeId: id(30), mode: 'route', bridgeToNodeId: id(3) })
    expect(calls('story:context').at(-1)![1].bridgeToNodeId).toBe(id(3))
    expect(calls('story:commit')).toHaveLength(1)
    expect(database.nodes.find(node => node.id === id(2))?.body).toBe('只在森林发生的事件')
    expect(database.nodes.find(node => node.id === id(3))?.body).toBe('只在海港发生的事件')
  })

  it('requires saving independent blueprints and confirming shared blueprint changes before generation', async () => {
    prepareChapter()
    database.nodes[3].chapterBlueprint = structuredClone(database.nodes[1].chapterBlueprint!)
    await mount(); await choose('当前节点', id(4)); await choose('当前路线', id(30))
    await fill('本章目标', '更新两条路线共同的汇合蓝图')
    expect(host.textContent).toContain('共用内容将影响：森林、海港')
    expect(button('保存分支内容').disabled).toBe(true)
    expect(button('按蓝图生成章节').disabled).toBe(true)
    await act(async () => host.querySelector<HTMLInputElement>('.story-shared-warning input')!.click())
    await click('保存分支内容'); await idle()
    expect(calls('story:commit')[0][1].confirmedSharedEdit).toBe(true)
    expect(database.nodes.find(node => node.id === id(4))?.chapterBlueprint?.purpose).toBe('更新两条路线共同的汇合蓝图')
  })

  it('retains the explicit no-continuation choice across node, route and tab navigation', async () => {
    prepareChapter(); await mount(); await choose('当前节点', id(2)); await choose('当前路线', id(30))
    await choose('接入后文（可选）', '')
    await click('森林路线'); await choose('当前路线', id(30))
    expect((label('接入后文（可选）').querySelector('select') as HTMLSelectElement).value).toBe('')
    await choose('当前节点', id(3)); await choose('当前节点', id(2))
    expect((label('接入后文（可选）').querySelector('select') as HTMLSelectElement).value).toBe('')
    await act(async () => root.render(<div>其他标签</div>)); await mount()
    expect((label('接入后文（可选）').querySelector('select') as HTMLSelectElement).value).toBe('')
  })

  it('refreshes approved assistant edits, including blueprint people, without replacing a pending draft', async () => {
    prepareChapter(); await mount(); await choose('当前节点', id(2))
    database.nodes[1].chapterBlueprint!.characters = ['新向导']
    database.nodes[1].body = '助手批准的新稿'
    database.revision = 'd'.repeat(64)
    await act(async () => globalEventBus.emit('STORY_CHANGED', { projectSession: session })); await idle()
    expect((label('出场人物').querySelector('input') as HTMLInputElement).value).toBe('新向导')
    await click('正文与事件'); expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('助手批准的新稿')
    await fill('节点正文', '作者尚未保存的手写稿')
    database.nodes[1].body = '助手后续批准的另一稿'; database.revision = 'e'.repeat(64)
    await act(async () => globalEventBus.emit('STORY_CHANGED', { projectSession: session })); await idle()
    expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('作者尚未保存的手写稿')
    expect(host.textContent).toContain('我已核对当前版本与保留输入')
    expect(host.querySelector('details[open] pre')?.textContent).toContain('助手后续批准的另一稿')
    expect(button('保存分支内容').disabled).toBe(true)
  })
  it('keeps manuscript input across node/route selection and tab unmount, then saves through project transition', async () => {
    await mount(); await choose('当前节点', id(2)); await fill('节点正文', '森林中未保存的新稿')
    await choose('当前节点', id(3)); await choose('当前路线', id(31)); await choose('当前节点', id(2))
    expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('森林中未保存的新稿')
    await act(async () => root.render(<div>其他标签</div>))
    expect(hasProjectTransitionDrafts(session.projectPath)).toBe(true)
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    expect(calls('story:commit')).toHaveLength(0)
    await act(async () => saveProjectTransitionDrafts(session.projectPath))
    expect(calls('story:commit')).toHaveLength(1)
    expect(database.nodes.find(node => node.id === id(2))?.body).toBe('森林中未保存的新稿')
    expect(hasProjectTransitionDrafts(session.projectPath)).toBe(false)
    await mount(); await choose('当前节点', id(2))
    expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('森林中未保存的新稿')
  })

  it('requires explicit confirmation before saving a manuscript shared by two routes', async () => {
    await mount(); await choose('当前节点', id(4)); await fill('节点正文', '修改所有路线的共用正文')
    expect(host.textContent).toContain('共用内容将影响：森林、海港')
    expect(button('保存分支内容').disabled).toBe(true)
    await act(async () => host.querySelector<HTMLInputElement>('.story-shared-warning input')!.click())
    await click('保存分支内容'); await idle()
    expect(calls('story:commit')[0][1].confirmedSharedEdit).toBe(true)
    expect(database.routes).toHaveLength(2)
  })

  it('retains a stale draft, compares the current remote manuscript and requires review before rebasing', async () => {
    await mount(); await choose('当前节点', id(2)); await fill('节点正文', '本地改稿')
    failCommit = true; await click('保存分支内容'); await idle()
    expect(host.textContent).toContain('你的输入已保留')
    database.nodes.find(node => node.id === id(2))!.body = '另一个副本的改稿'; database.revision = 'd'.repeat(64)
    await click('重新读取并保留输入'); await idle()
    expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('本地改稿')
    expect([...host.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent?.includes('当前保存版本'))?.textContent).toContain('另一个副本的改稿')
    expect(button('保存分支内容').disabled).toBe(true)
    const review = [...host.querySelectorAll('label')].find(item => item.textContent?.includes('我已核对当前版本与保留输入'))!
    await act(async () => review.querySelector<HTMLInputElement>('input')!.click())
    failCommit = false; await click('保存分支内容'); await idle()
    expect(calls('story:commit')[1][1].expectedRevision).toBe('d'.repeat(64))
    expect(database.nodes.find(node => node.id === id(2))?.body).toBe('本地改稿')
  })

  it('creates a node, a conditioned link and an ordered route in one transaction request', async () => {
    await mount(); await click('新增内容节点'); await click('正文与事件'); await fill('节点标题', '远行')
    const newNode = getStoryWorkspace(storyWorkspaceKey(session))!.selectedNodeId
    await click('连接'); await click('新增连接'); await fill('走向名称', '返回起点'); await fill('自然语言条件', '作者选择重新调查')
    await click('路线'); await click('新增路线'); await fill('路线名称', '调查路线'); await choose('追加路线节点', id(1)); await click('追加到路线')
    await click('保存分支内容'); await idle()
    const operations = calls('story:commit')[0][1].operations
    expect(operations.map((operation: { type: string }) => operation.type)).toEqual(['put-node', 'put-edge', 'put-route'])
    expect(operations[1].edge).toMatchObject({ from: newNode, to: id(1), condition: '作者选择重新调查' })
    expect(operations[2].route.nodeIds).toEqual([newNode, id(1)])
  })

  it('deletes a shared node only after confirmation and stages its dependent routes and links together', async () => {
    await mount(); await choose('当前节点', id(4)); await click('删除当前节点')
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('2 条路线')
    expect(calls('story:commit')).toHaveLength(0)
    await click('继续编辑')
    expect(getStoryWorkspace(storyWorkspaceKey(session))!.pending).toHaveLength(0)
    await click('删除当前节点'); await click('确认')
    expect(database.nodes).toHaveLength(4)
    await click('保存分支内容'); await idle()
    const operations = calls('story:commit')[0][1].operations as { type: string; id: string }[]
    expect(operations.filter(operation => operation.type === 'delete-route')).toHaveLength(2)
    expect(operations.filter(operation => operation.type === 'delete-edge')).toHaveLength(2)
    expect(operations.at(-1)).toEqual({ type: 'delete-node', id: id(4) })
    expect(database.nodes).toHaveLength(3)
    expect(database.revisions).toHaveLength(4)
  })

  it('restores a selected historical manuscript as a new current edit and preserves the history record', async () => {
    database.revisions[1].node.body = '森林的历史正文'
    await mount(); await choose('当前节点', id(2)); await click('历史'); await choose('节点历史版本', id(21))
    expect(host.textContent).toContain('森林的历史正文')
    await click('恢复为新的当前版本')
    expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('森林的历史正文')
    await click('保存分支内容'); await idle()
    expect(calls('story:commit')[0][1].operations).toEqual([{ type: 'restore-node', id: id(2), revisionId: id(21) }])
    expect(database.revisions.find(item => item.id === id(21))?.node.body).toBe('森林的历史正文')
  })

  it('preserves unconfirmed continuity input when switching routes and saves it during project transition', async () => {
    await mount(); await choose('当前节点', id(4)); await choose('当前路线', id(30)); await click('前情'); await click('读取当前前情'); await idle()
    expect(host.textContent).toContain('只在森林发生的事件'); expect(host.textContent).not.toContain('只在海港发生的事件')
    await fill('前情摘要', '森林前情未确认草稿'); await fill('人物动态状态', '持有绿钥匙')
    const noteId = (getStoryWorkspace(storyWorkspaceKey(session))!.pending[0] as { note: { id: string } }).note.id
    await click('正文与事件'); await click('前情')
    expect((label('前情摘要').querySelector('textarea') as HTMLTextAreaElement).value).toBe('森林前情未确认草稿')
    await choose('当前路线', id(31))
    await click('读取当前前情'); await idle()
    await fill('前情摘要', '海港的另一份前情')
    await choose('当前路线', id(30)); await click('读取当前前情'); await idle()
    expect((label('前情摘要').querySelector('textarea') as HTMLTextAreaElement).value).toBe('森林前情未确认草稿')
    expect((label('人物动态状态').querySelector('textarea') as HTMLTextAreaElement).value).toBe('持有绿钥匙')
    await fill('入口差异说明', '森林仍有绿钥匙')
    expect(hasProjectTransitionDrafts(session.projectPath)).toBe(true)
    await act(async () => saveProjectTransitionDrafts(session.projectPath))
    expect(database.notes).toHaveLength(2)
    expect(database.notes.find(note => note.routeId === id(30))).toMatchObject({ id: noteId, routeId: id(30), summary: '森林前情未确认草稿', characterStates: '持有绿钥匙', entryDifferences: '森林仍有绿钥匙', confirmed: false })
  })

  it('confirms common continuity explicitly and prepares assistant input without a model request', async () => {
    await mount(true); await act(async () => { prefillAgentInput(session, '已有作者问题') })
    await choose('当前节点', id(4)); await click('前情'); await choose('写作上下文', 'shared'); await click('读取当前前情'); await idle()
    expect(host.textContent).toContain('共同前情尚未确认')
    expect(host.textContent).not.toContain('只在森林发生的事件'); expect(host.textContent).not.toContain('只在海港发生的事件')
    await fill('共同事实摘要', '两条路线都抵达山顶'); await fill('入口差异说明', '绿钥匙和旧地图仍分别属于各自路线')
    const confirmation = [...host.querySelectorAll('label')].find(item => item.textContent?.includes('我已核对这些事实'))!
    await act(async () => confirmation.querySelector<HTMLInputElement>('input')!.click())
    await click('确认这份前情'); await click('保存分支内容'); await idle()
    expect(database.notes[0].confirmed).toBe(true)
    await click('让助手帮助写作'); await idle()
    expect(useAgentStore.getState().getActiveConversation()?.storyContext).toEqual({ nodeId: id(4), routeId: null, mode: 'shared' })
    expect(useStageStore.getState().sheet).toEqual({ kind: 'assistant' })
    const input = host.querySelector<HTMLTextAreaElement>('.agent-input-textarea') ?? [...host.querySelectorAll('textarea')].at(-1)!
    expect(input.value).toContain('已有作者问题'); expect(input.value).toContain('read_story_context')
    expect(invoke.mock.calls.some(call => String(call[0]).includes('generation:begin') || String(call[0]).includes('generation:execute'))).toBe(false)
    expect(prefillAgentInput({ ...session, leaseId: 'stale' }, '不应追加')).toBe(false)
    expect(input.value).not.toContain('不应追加')
  })

  it('does not start a route-specific assistant for a target shared by divergent routes', async () => {
    await mount(); await choose('当前节点', id(4)); await choose('当前路线', id(30)); await click('前情'); await click('读取当前前情'); await idle()
    expect(host.textContent).toContain('此正文由前情不同的路线共用')
    await click('让助手帮助写作'); await idle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('请选择共用写作')
    expect(useStageStore.getState().sheet).toBeNull()
    expect(useAgentStore.getState().getActiveConversation()).toBeNull()
    expect(calls('story:commit')).toHaveLength(0)
  })

  it('keeps input read-only after a new project lease until current data is explicitly reviewed', async () => {
    await mount(); await choose('当前节点', id(2)); await fill('节点正文', '旧会话保留的输入')
    await act(async () => useProjectStore.setState({ currentProject: { ...project, sessionLease: 'new-lease' } }))
    expect(button('保存分支内容').disabled).toBe(true)
    expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('旧会话保留的输入')
    await click('重新读取并保留输入'); await idle()
    const review = [...host.querySelectorAll('label')].find(item => item.textContent?.includes('我已核对当前版本'))!
    await act(async () => review.querySelector<HTMLInputElement>('input')!.click())
    await click('保存分支内容'); await idle()
    expect(calls('story:commit')[0][1].projectSession.leaseId).toBe('new-lease')
  })

  it('keeps the graph inside its own scroller in a 393px viewport and supports English labels', async () => {
    await page.viewport(393, 851)
    useLocaleStore.setState({ locale: 'en-US' })
    await mount()
    expect(host.textContent).toContain('Add branch')
    const map = host.querySelector<HTMLDivElement>('.story-map')!
    expect(map.scrollWidth).toBeGreaterThan(map.clientWidth)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1)
    expect(host.querySelectorAll('[data-story-node]')).toHaveLength(4)
  })

  it('selects manuscripts from the tree and highlights exactly the selected route', async () => {
    await mount()
    await click('森林路线')
    expect(treeNode(id(2))?.getAttribute('data-selected')).toBe('true')
    expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('只在森林发生的事件')
    await fill('节点正文', '从树中编辑的森林新稿')
    await choose('当前路线', id(30))
    expect(treeNode(id(1))?.getAttribute('data-on-route')).toBe('true')
    expect(treeNode(id(2))?.getAttribute('data-on-route')).toBe('true')
    expect(treeNode(id(3))?.getAttribute('data-on-route')).toBe('false')
    expect(treeNode(id(4))?.getAttribute('data-on-route')).toBe('true')
    await click('海港路线')
    expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('只在海港发生的事件')
    await click('森林路线')
    expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('从树中编辑的森林新稿')
    expect(database.nodes.find(node => node.id === id(2))?.body).toBe('只在森林发生的事件')
  })

  it('zooms the visible cards and locates the selected node inside the canvas', async () => {
    await mount()
    const width = treeNode(id(2))!.getBoundingClientRect().width
    await click('放大')
    await expect.poll(() => treeNode(id(2))!.getBoundingClientRect().width).toBeGreaterThan(width)
    await click('重逢')
    await click('定位当前节点')
    await expect.poll(() => {
      const card = treeNode(id(4))!.getBoundingClientRect(), viewport = treeViewport().getBoundingClientRect()
      const centerX = card.left + card.width / 2, centerY = card.top + card.height / 2
      return centerX >= viewport.left && centerX <= viewport.right && centerY >= viewport.top && centerY <= viewport.bottom
    }).toBe(true)
    await click('适应画布')
    expect(treeNode(id(1))).toBeTruthy()
    expect(treeNode(id(4))).toBeTruthy()
    expect(calls('story:commit')).toHaveLength(0)
    expect(getStoryWorkspace(storyWorkspaceKey(session))!.pending).toHaveLength(0)
  })

  it('opens a connection from the tree and edits its author-defined condition', async () => {
    await mount()
    await click('连接「出发」到「森林路线」：继续')
    expect(getStoryWorkspace(storyWorkspaceKey(session))!.selectedEdgeId).toBe(id(10))
    await fill('走向名称', '沿林间小路前进')
    await fill('自然语言条件', '作者选择追踪绿钥匙的来源')
    await click('保存分支内容'); await idle()
    expect(database.edges.find(edge => edge.id === id(10))).toMatchObject({
      from: id(1), to: id(2), label: '沿林间小路前进', condition: '作者选择追踪绿钥匙的来源',
    })
    expect(database.routes.find(route => route.id === id(30))?.nodeIds).toEqual([id(1), id(2), id(4)])
  })

  it('collapses only hidden descendants and keeps a merge reachable from another entrance visible', async () => {
    await mount()
    await click('折叠「森林路线」的后续')
    expect(treeNode(id(2))?.getAttribute('data-collapsed')).toBe('true')
    expect(treeNode(id(4))).toBeTruthy()
    expect(treeNode(id(3))).toBeTruthy()
    await click('折叠「出发」的后续')
    expect(treeNode(id(1))).toBeTruthy()
    expect(treeNode(id(2))).toBeNull()
    expect(treeNode(id(3))).toBeNull()
    expect(treeNode(id(4))).toBeNull()
    await click('展开「出发」的后续')
    expect(treeNode(id(2))).toBeTruthy()
    expect(treeNode(id(3))).toBeTruthy()
    expect(treeNode(id(4))).toBeTruthy()
    expect(database.nodes).toHaveLength(4)
    expect(getStoryWorkspace(storyWorkspaceKey(session))!.pending).toHaveLength(0)
  })

  it('continues a route from its endpoint with a connected empty scene and keeps the other route intact', async () => {
    await mount(); await choose('当前路线', id(30)); await click('重逢')
    await click('在「重逢」后继续')
    const workspace = getStoryWorkspace(storyWorkspaceKey(session))!, preview = storyPreview(workspace)!
    const added = preview.nodes.find(node => node.id === workspace.selectedNodeId)!
    expect(added).toMatchObject({ title: '后续剧情', kind: 'content', body: '', event: '' })
    expect(preview.edges.some(edge => edge.from === id(4) && edge.to === added.id)).toBe(true)
    expect(preview.routes.find(route => route.id === id(30))?.nodeIds).toEqual([id(1), id(2), id(4), added.id])
    expect(preview.routes.find(route => route.id === id(31))?.nodeIds).toEqual([id(1), id(3), id(4)])
    expect(database.nodes).toHaveLength(4)
    await click('正文与事件'); await fill('节点正文', '续写节点的新正文')
    await click('保存分支内容'); await idle()
    expect(database.nodes.find(node => node.id === added.id)?.body).toBe('续写节点的新正文')
    expect(database.nodes.find(node => node.id === id(4))?.body).toBe('共用的汇合正文')
  })

  it('forks from a chosen earlier path while preserving the original future and manuscripts', async () => {
    await mount(); await choose('当前路线', id(30)); await click('森林路线')
    await click('从「森林路线」分叉')
    const preview = storyPreview(getStoryWorkspace(storyWorkspaceKey(session))!)!
    const first = preview.nodes.find(node => node.title === '走向 A')!, second = preview.nodes.find(node => node.title === '走向 B')!
    expect(first.body).toBe(''); expect(second.body).toBe('')
    expect(preview.routes).toHaveLength(4)
    expect(preview.routes.find(route => route.title === '走向 A')?.nodeIds).toEqual([id(1), id(2), first.id])
    expect(preview.routes.find(route => route.title === '走向 B')?.nodeIds).toEqual([id(1), id(2), second.id])
    expect(preview.routes.find(route => route.id === id(30))?.nodeIds).toEqual([id(1), id(2), id(4)])
    expect(preview.nodes.find(node => node.id === id(2))?.body).toBe('只在森林发生的事件')
    expect(preview.nodes.find(node => node.id === id(3))?.body).toBe('只在海港发生的事件')
    await click('保存分支内容'); await idle()
    expect(database.nodes).toHaveLength(6)
    expect(database.revisions).toHaveLength(4)
  })

  it('merges two chosen entrances into empty shared content and extends their ending routes', async () => {
    database.routes[0].nodeIds = [id(1), id(2)]
    database.routes[1].nodeIds = [id(1), id(3)]
    await mount(); await click('森林路线'); await click('从「森林路线」汇合')
    expect(button('建立汇合').disabled).toBe(true)
    const composer = host.querySelector('[aria-label="建立汇合"]')!
    const harbour = [...composer.querySelectorAll('label')].find(item => item.textContent?.trim() === '海港路线')!
    await act(async () => harbour.querySelector<HTMLInputElement>('input')!.click())
    await fill('汇合标题', '山门汇合'); await click('建立汇合')
    const preview = storyPreview(getStoryWorkspace(storyWorkspaceKey(session))!)!
    const merge = preview.nodes.find(node => node.title === '山门汇合')!
    expect(merge).toMatchObject({ kind: 'merge', body: '', event: '' })
    expect(preview.edges.filter(edge => edge.to === merge.id).map(edge => edge.from)).toEqual([id(2), id(3)])
    expect(preview.routes.find(route => route.id === id(30))?.nodeIds).toEqual([id(1), id(2), merge.id])
    expect(preview.routes.find(route => route.id === id(31))?.nodeIds).toEqual([id(1), id(3), merge.id])
    expect(preview.notes).toHaveLength(0)
    await click('保存分支内容'); await idle()
    expect(database.nodes.find(node => node.id === id(2))?.body).toBe('只在森林发生的事件')
    expect(database.nodes.find(node => node.id === id(3))?.body).toBe('只在海港发生的事件')
  })

  it('blocks self, duplicate and cyclic connections before staging and permits a valid graph connection', async () => {
    await mount(); await click('森林路线'); await click('从「森林路线」连接现有节点')
    expect(button('出发').disabled).toBe(true)
    expect(button('森林路线').disabled).toBe(true)
    expect(button('重逢').disabled).toBe(true)
    expect(button('海港路线').disabled).toBe(false)
    expect(getStoryWorkspace(storyWorkspaceKey(session))!.pending).toHaveLength(0)
    await click('海港路线')
    const workspace = getStoryWorkspace(storyWorkspaceKey(session))!, preview = storyPreview(workspace)!
    expect(workspace.pending).toHaveLength(1)
    expect(preview.edges.find(edge => edge.id === workspace.selectedEdgeId)).toMatchObject({ from: id(2), to: id(3) })
    expect(host.querySelector('.story-tree-connection-prompt')).toBeNull()
    await click('保存分支内容'); await idle()
    expect(database.edges).toHaveLength(5)
    expect(database.routes.map(route => route.nodeIds)).toEqual([[id(1), id(2), id(4)], [id(1), id(3), id(4)]])
  })

  it('finds a collapsed scene by its title and reveals it without changing story content', async () => {
    await mount(); await click('折叠「出发」的后续')
    expect(treeNode(id(2))).toBeNull()
    await fill('搜索剧情节点', '森林')
    await click('定位「森林路线」')
    expect(treeNode(id(2))?.getAttribute('data-selected')).toBe('true')
    expect((label('节点正文').querySelector('textarea') as HTMLTextAreaElement).value).toBe('只在森林发生的事件')
    expect(getStoryWorkspace(storyWorkspaceKey(session))!.pending).toHaveLength(0)
    expect(calls('story:commit')).toHaveLength(0)
  })

  it('requires confirmation to remove continuity excluded by a shorter route and preserves other notes and prose', async () => {
    const note = { nodeId: id(4), summary: '作者保留的前情', characterStates: '已到达山顶', entryDifferences: '分别保留入口状态', sourceHash: 'b'.repeat(64), confirmed: true }
    database.notes = [{ ...note, id: id(40), routeId: id(30) }, { ...note, id: id(41), routeId: id(31) }, { ...note, id: id(42), routeId: null }]
    await mount(); await choose('当前路线', id(30)); await click('路线')
    await click('将路线缩短到第 2 个节点')
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('1 份前情记录')
    expect(getStoryWorkspace(storyWorkspaceKey(session))!.pending).toHaveLength(0)
    await click('继续编辑')
    expect(storyPreview(getStoryWorkspace(storyWorkspaceKey(session))!)!.routes.find(route => route.id === id(30))?.nodeIds).toEqual([id(1), id(2), id(4)])
    expect(database.notes).toHaveLength(3)
    await click('将路线缩短到第 2 个节点'); await click('确认')
    await click('保存分支内容'); await idle()
    expect(database.routes.find(route => route.id === id(30))?.nodeIds).toEqual([id(1), id(2)])
    expect(database.routes.find(route => route.id === id(31))?.nodeIds).toEqual([id(1), id(3), id(4)])
    expect(database.notes.map(item => item.id)).toEqual([id(41), id(42)])
    expect(database.nodes.find(node => node.id === id(4))?.body).toBe('共用的汇合正文')
    const operations = calls('story:commit')[0][1].operations as Array<{ type: string; id?: string }>
    expect(operations).toEqual(expect.arrayContaining([{ type: 'delete-note', id: id(40) }]))
  })

  it('protects links used by routes until the author first shortens the affected path', async () => {
    await mount(); await click('连接「出发」到「森林路线」：继续')
    expect(label('连接起点').querySelector('select')!.disabled).toBe(true)
    expect(label('连接目标').querySelector('select')!.disabled).toBe(true)
    expect(button('删除当前连接').disabled).toBe(true)
    expect(getStoryWorkspace(storyWorkspaceKey(session))!.pending).toHaveLength(0)
    await choose('当前路线', id(30)); await click('路线'); await click('将路线缩短到第 1 个节点')
    await click('连接「出发」到「森林路线」：继续')
    expect(button('删除当前连接').disabled).toBe(false)
    await click('删除当前连接'); await click('确认')
    await click('保存分支内容'); await idle()
    expect(database.edges.some(edge => edge.id === id(10))).toBe(false)
    expect(database.routes.find(route => route.id === id(30))?.nodeIds).toEqual([id(1)])
    expect(database.routes.find(route => route.id === id(31))?.nodeIds).toEqual([id(1), id(3), id(4)])
  })

  it('offers only linked next scenes when appending to an edited route', async () => {
    await mount(); await choose('当前路线', id(30)); await click('路线')
    await click('将路线缩短到第 1 个节点')
    const options = [...label('追加路线节点').querySelectorAll('option')].filter(option => option.value).map(option => option.value)
    expect(options).toEqual([id(2), id(3)])
    expect(options).not.toContain(id(4))
    await choose('追加路线节点', id(3)); await click('追加到路线')
    await click('保存分支内容'); await idle()
    expect(database.routes.find(route => route.id === id(30))?.nodeIds).toEqual([id(1), id(3)])
    expect(database.nodes).toHaveLength(4)
  })
})
