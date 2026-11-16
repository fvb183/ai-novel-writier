import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ConfirmCard from '../ConfirmCard'
import { useProjectStore } from '../../../../stores/project-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useAgentStore } from '../../../../stores/agent-store'
import type { StorySnapshot, StoryContext } from '../../../../shared/story-branches'
import type { ToolCallInfo } from '../../../../services/agent/agent-engine'

const invoke = vi.fn(), resolve = vi.fn()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const nodeId = '11111111-1111-4111-8111-111111111111', routeId = '22222222-2222-4222-8222-222222222222'
const session = { projectId: 'A', projectPath: 'C:/story/A', leaseId: 'lease' }
const request = { nodeId, routeId, mode: 'route' as const }
const node = { id: nodeId, kind: 'content' as const, title: '共用开场', chapterNumber: 1, event: '进入门厅', body: '当前保存的正文', revisionId: nodeId }
const snapshot: StorySnapshot = { revision: 'a'.repeat(64), nodes: [node], edges: [], notes: [], revisions: [], routes: [{ id: routeId, title: '左路线', nodeIds: [nodeId] }, { id: nodeId, title: '右路线', nodeIds: [nodeId] }] }
const context: StoryContext = { request, sourceHash: 'b'.repeat(64), contextHash: 'c'.repeat(64), target: node, prefix: [], entrances: [], note: null, noteCurrent: false, readyForGeneration: true }
let root: Root, container: HTMLDivElement
const call = (): ToolCallInfo => ({ id: 'story-proposal', toolName: 'propose_story_changes', source: 'builtin', status: 'waiting_confirm', projectSession: session, storyContext: request,
  arguments: { operations: [{ type: 'put-node', node: { id: nodeId, kind: 'content', title: '共用开场', chapterNumber: 1, event: '进入门厅', body: '等待作者批准的候选正文' } }] } })
beforeEach(() => {
  invoke.mockReset(); resolve.mockReset()
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ currentProject: { id: 'A', name: 'A', path: session.projectPath, sessionLease: session.leaseId, novelConfig: { writingLanguage: 'zh-CN' } } as never })
  useAgentStore.setState({ resolveToolConfirmation: resolve })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() } })
  invoke.mockImplementation(async channel => channel === 'story:read' ? { success: true, data: snapshot } : { success: true, data: context })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useProjectStore.setState({ currentProject: null }) })

it('shows before and candidate prose and both affected routes before approving the existing durable gate', async () => {
  await act(async () => root.render(<ConfirmCard toolCall={call()} />))
  await expect.element(page.getByRole('region', { name: '剧情分支变更预览' })).toBeVisible()
  await expect.element(page.getByText(/这会修改共享节点，影响路线：.*(左路线.*右路线|右路线.*左路线)/)).toBeVisible()
  expect(container.textContent).toContain('当前保存的正文'); expect(container.textContent).toContain('等待作者批准的候选正文')
  expect(invoke.mock.calls.every(args => ['story:read', 'story:context'].includes(args[0]))).toBe(true)
  await page.getByRole('button', { name: '批准执行', exact: true }).click()
  expect(resolve).toHaveBeenCalledWith('story-proposal', true)
})

it('blocks an unscoped prose candidate and explains how to choose the target route', async () => {
  const proposal = call(); delete proposal.storyContext
  await act(async () => root.render(<ConfirmCard toolCall={proposal} />))
  await expect.element(page.getByRole('alert')).toHaveTextContent('请从剧情分支页选中路线和节点')
  await expect.element(page.getByRole('button', { name: '批准执行', exact: true })).toBeDisabled()
  expect(resolve).not.toHaveBeenCalled()
})

it('disables the candidate after a lease change and allows refusal without any write channel', async () => {
  await act(async () => root.render(<ConfirmCard toolCall={call()} />))
  await expect.element(page.getByRole('region', { name: '剧情分支变更预览' })).toBeVisible()
  await act(async () => useProjectStore.setState(state => ({ currentProject: { ...state.currentProject!, sessionLease: 'new-lease' } })))
  await expect.element(page.getByText('项目会话已变化，此候选不能提交。')).toBeVisible()
  await expect.element(page.getByRole('button', { name: '批准执行', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '拒绝', exact: true }).click()
  expect(resolve).toHaveBeenCalledWith('story-proposal', false)
  expect(invoke.mock.calls.every(args => ['story:read', 'story:context'].includes(args[0]))).toBe(true)
})
