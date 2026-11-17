import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../../index.css'
import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'
import { useEditorStore } from '../../../stores/editor-store'
import { actionToast } from '../ActionToast'
import { toast } from '../Toast'
import ArchitectureGenerateDialog from '../../stage/architecture/ArchitectureGenerateDialog'
import WriteChapterPopover from '../../stage/write/WriteChapterPopover'
import { installWorkflowCompletionScope } from '../../run/workflow-completion-scope'
import { globalEventBus } from '../../../shared/event-bus'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
const originalProject = useProjectStore.getState()
const originalWorkflow = useWorkflowStore.getState(), originalEditor = useEditorStore.getState()
const session = { projectId: 'notice-project', projectPath: 'C:/synthetic/notice-project', leaseId: 'notice-lease' }
const project = { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '合成小说', novelConfig: {
  genre: '奇幻', subGenre: '', targetAudience: '成人', totalChapters: 10, wordsPerChapter: 2000,
  plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '合成故事', worldSetting: '',
  goldenFinger: '', protagonistProfile: '', globalGuidance: '',
}, characterStates: '', createdAt: '', updatedAt: '' } as ProjectData
const live = () => [...document.querySelectorAll<HTMLElement>('.pi-toast:not([data-exiting])')]
const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
let root: Root, container: HTMLDivElement

beforeEach(async () => {
  await page.viewport(393, 852)
  await vi.waitFor(() => expect([window.innerWidth, window.innerHeight]).toEqual([393, 852]))
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project })
  setActiveProjectSessionContext(session)
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke: async (channel: string) => {
    if (channel === 'db:consistency-exemption-list') return []
    if (channel === 'skills:list-user') return []
    if (channel === 'fs:check-exists') return false
    return { outlineTargetUnits: 300 }
  }, on: () => () => {} } })
  container = document.createElement('div'); container.className = 'paper-ink'; container.dataset.theme = 'light'
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  vi.useRealTimers()
  await act(async () => root.unmount()); container.remove()
  await act(async () => actionToast.clearWorkflowComplete())
  for (const close of document.querySelectorAll<HTMLButtonElement>('.pi-toast:not([data-exiting]) button[aria-label="关闭通知"]')) await act(async () => close.click())
  await wait(200)
  document.getElementById('ai-novel-ink-overlay')?.remove()
  useProjectStore.setState(originalProject, true); useWorkflowStore.setState(originalWorkflow, true); useEditorStore.setState(originalEditor, true)
  setActiveProjectSessionContext(null); Reflect.deleteProperty(window, 'aiNovelAPI')
})

it('does not keep a generation notice alive after touch compatibility mouse events', async () => {
  await act(async () => toast.success('第 1 章草稿已生成', 180))
  const card = live()[0]
  await act(async () => {
    card.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch', pointerId: 1 }))
    card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 1 }))
    card.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 1 }))
  })
  await wait(420)
  expect(live()).toHaveLength(0)
})

it('keeps only the latest completed-work notice outside guidance and opens the correct result', async () => {
  const oldOpen = vi.fn(), latestOpen = vi.fn()
  await act(async () => {
    actionToast.workflowComplete('「AI 生成小说配置」已完成', oldOpen)
    actionToast.workflowComplete('「第 1 章 · 写稿」已完成', oldOpen)
    actionToast.workflowComplete('「第 2 章 · 写稿」已完成', latestOpen)
  })
  expect(live()).toHaveLength(1)
  expect(live()[0].textContent).toContain('第 2 章 · 写稿')
  await act(async () => live()[0].querySelectorAll<HTMLButtonElement>('button')[1].click())
  expect(latestOpen).toHaveBeenCalledOnce()
  expect(oldOpen).not.toHaveBeenCalled()
})

it('clears completed-work notices when opening phone settings guidance and stays quiet while editing', async () => {
  const openOld = vi.fn(), openLatest = vi.fn()
  await act(async () => {
    actionToast.workflowComplete('「AI 生成小说配置」已完成', openOld)
    actionToast.workflowComplete('「第 1 章 · 写稿」已完成', openOld)
    actionToast.workflowComplete('「第 2 章 · 写稿」已完成', openLatest)
    root.render(<ArchitectureGenerateDialog isOpen archStatus={{}} synopsisSource={{ synopsis: '', totalChapters: 10, writingLanguage: 'zh-CN' }} onClose={() => {}} onConfirm={async () => {}} />)
  })
  await wait(200)
  await act(async () => (await page.getByRole('button', { name: /作者指导/ }).element() as HTMLButtonElement).click())
  await wait(200)
  expect(live()).toHaveLength(0)
  expect(document.querySelectorAll('.arch-guidance textarea')).toHaveLength(4)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  await page.screenshot({ path: '../../../../.runtime/generation-notices-shots/393-settings-guidance.png' })
  const guidance = document.querySelector<HTMLTextAreaElement>('.arch-guidance textarea')!
  await act(async () => userEvent.fill(guidance, '保留的设定指导'))
  await act(async () => useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, coreOutline: '刚修改的设定' } } }))
  await act(async () => actionToast.workflowComplete('「第 3 章 · 写稿」已完成', openLatest))
  expect(live()).toHaveLength(0)
  expect(guidance.value).toBe('保留的设定指导')
  expect(openLatest).not.toHaveBeenCalled(); expect(openOld).not.toHaveBeenCalled()
  expect(document.querySelector('.arch-guidance textarea')).not.toBeNull()
  await act(async () => {
    actionToast.show({ type: 'error', message: '保存失败，需要处理', duration: 0 })
    actionToast.show({ type: 'warning', message: '有一份未保存的恢复稿', duration: 0, actions: [{ label: '查看恢复稿' }] })
    actionToast.show({ type: 'info', message: '发现新版本', duration: 0, actions: [{ label: '查看更新' }] })
    actionToast.workflowComplete('「第 4 章 · 写稿」已完成', openLatest)
  })
  expect(live().map(card => card.querySelector('.pi-toast-title')?.textContent)).toEqual(['保存失败，需要处理', '有一份未保存的恢复稿', '发现新版本'])
  expect(guidance.value).toBe('保留的设定指导')
})

it.each([852, 480])('clears old notices on opening 本次写作选项 at 393 x %i and protects edited guidance from new completion notices', async height => {
  await page.viewport(393, height)
  await vi.waitFor(() => expect(window.innerHeight).toBe(height))
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  container.style.cssText = 'padding: 20px;'
  await act(async () => {
    actionToast.workflowComplete('「AI 生成小说配置」已完成', () => {})
    actionToast.workflowComplete('「第 2 章 · 写稿」已完成', () => {})
  })
  await act(async () => root.render(<WriteChapterPopover chapterNumber={3} label="写第 3 章" blueprint={{ title: '合成章节', role: '', purpose: '合成目标', keyEvents: '', characters: '', userGuidance: '保留的作者指导' }} />))
  await act(async () => (await page.getByRole('button', { name: '本次写作选项' }).element() as HTMLButtonElement).click())
  await wait(200)
  const guide = page.getByLabelText(/作者微操指导/)
  await expect.element(guide).toHaveValue('保留的作者指导')
  await page.screenshot({ path: `../../../../.runtime/generation-notices-shots/393-${height}-chapter-guidance.png` })
  expect(live()).toHaveLength(0)
  await act(async () => guide.fill('我刚输入的本次指导'))
  await act(async () => actionToast.workflowComplete('「第 3 章 · 写稿」已完成', () => {}))
  expect(live()).toHaveLength(0)
  await expect.element(guide).toHaveValue('我刚输入的本次指导')
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  await act(async () => (await page.getByRole('button', { name: '本次写作选项' }).element() as HTMLButtonElement).click())
  await act(async () => actionToast.workflowComplete('「第 4 章 · 写稿」已完成', () => {}))
  expect(live()).toHaveLength(1)
  expect(live()[0].textContent).toContain('第 4 章 · 写稿')
  await act(async () => (await page.getByRole('button', { name: '本次写作选项' }).element() as HTMLButtonElement).click())
  expect(live()).toHaveLength(0)
  await expect.element(page.getByLabelText(/作者微操指导/)).toHaveValue('我刚输入的本次指导')
})

it.each(['form-first', 'other-first'] as const)('keeps completion silence until every open guidance scope is released (%s), including StrictMode cleanup', async order => {
  let releaseOther = () => {}
  const renderForm = (isOpen: boolean) => root.render(<StrictMode><ArchitectureGenerateDialog isOpen={isOpen} archStatus={{}} synopsisSource={{ synopsis: '', totalChapters: 10, writingLanguage: 'zh-CN' }} onClose={() => {}} onConfirm={async () => {}} /></StrictMode>)
  await act(async () => {
    releaseOther = actionToast.silenceWorkflowComplete()
    renderForm(true)
  })
  await act(async () => {
    if (order === 'form-first') renderForm(false)
    else { releaseOther(); releaseOther() }
    actionToast.workflowComplete('仍有一个指导窗口打开', () => {})
  })
  expect(live()).toHaveLength(0)
  await act(async () => {
    if (order === 'form-first') { releaseOther(); releaseOther() }
    else renderForm(false)
  })
  await act(async () => actionToast.workflowComplete('所有指导窗口已关闭', () => {}))
  expect(live()).toHaveLength(1)
  expect(live()[0].textContent).toContain('所有指导窗口已关闭')
})

it('keeps real workflow results in history while their completed events cannot cover open chapter guidance', async () => {
  useWorkflowStore.setState({ activeRuns: [], history: [] })
  container.style.cssText = 'padding: 20px;'
  await act(async () => root.render(<WriteChapterPopover chapterNumber={3} label="写第 3 章" blueprint={{ title: '合成章节', role: '', purpose: '合成目标', keyEvents: '', characters: '', userGuidance: '保留的作者指导' }} />))
  await act(async () => (await page.getByRole('button', { name: '本次写作选项' }).element() as HTMLButtonElement).click())
  const completed: string[] = []
  const unsubscribe = globalEventBus.on('WORKFLOW_COMPLETE', ({ runId }) => {
    completed.push(runId)
    const run = useWorkflowStore.getState().activeRuns.find(item => item.id === runId)!
    actionToast.workflowComplete(`「${run.title}」已完成`, () => {})
  })
  try {
    for (const [index, title] of ['AI 生成小说配置', '第 1 章 · 写稿', '第 2 章 · 写稿'].entries()) {
      await act(async () => { await useWorkflowStore.getState().startWorkflow({
        runId: `notice-real-run-${index}`, type: index === 0 ? 'config_generation' : 'chapter_creation', title,
        projectPath: session.projectPath, projectSession: session,
        steps: [{ name: '合成生成步骤', description: '', executor: async () => `已保存的合成输出 ${index}` }],
      }) })
      expect(live()).toHaveLength(0)
    }
    expect(completed).toHaveLength(3)
    expect(useWorkflowStore.getState().history.map(run => run.title)).toEqual(['第 2 章 · 写稿', '第 1 章 · 写稿', 'AI 生成小说配置'])
    expect(useWorkflowStore.getState().history.every(run => run.status === 'completed' && run.steps[0].result?.startsWith('已保存的合成输出'))).toBe(true)
    await expect.element(page.getByLabelText(/作者微操指导/)).toHaveValue('保留的作者指导')
  } finally { unsubscribe() }
})

it.each(['different-project', 'reopened-session'] as const)('clears obsolete completion notice after %s and preserves history, unfinished work and critical notices', async change => {
  const history = [{ id: 'saved-run', status: 'completed', projectPath: session.projectPath, title: '已保存正文' }] as WorkflowRun[]
  const active = [{ id: 'waiting-run', status: 'waiting', projectPath: session.projectPath, title: '待确认设定' }] as WorkflowRun[]
  useWorkflowStore.setState({ history, activeRuns: active })
  const tabs = [{ id: 'author-draft', type: 'chapter', projectKey: session.projectPath, content: '作者未保存的正文', dirty: true }] as unknown as ReturnType<typeof useEditorStore.getState>['tabs']
  useEditorStore.setState({ tabs })
  const unsubscribe = installWorkflowCompletionScope()
  try {
    await act(async () => {
      actionToast.show({ type: 'error', message: '保存失败，需要处理', duration: 0, actions: [{ label: '重试' }] })
      actionToast.show({ type: 'warning', message: '有一份未保存的恢复稿', duration: 0, actions: [{ label: '查看恢复稿' }] })
      actionToast.workflowComplete('「第 1 章 · 写稿」已完成', () => {})
    })
    await act(async () => useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, coreOutline: '刚改的设定' } } }))
    expect(live()).toHaveLength(3)
    await act(async () => useProjectStore.setState({ currentProject: change === 'different-project'
      ? { ...project, id: 'another', path: 'C:/synthetic/another', sessionLease: 'another-lease' }
      : { ...project, sessionLease: 'reopened-lease' } }))
    expect(live().map(card => card.querySelector('.pi-toast-title')?.textContent)).toEqual(['保存失败，需要处理', '有一份未保存的恢复稿'])
    expect(useWorkflowStore.getState().history).toBe(history)
    expect(useWorkflowStore.getState().activeRuns).toBe(active)
    expect(useEditorStore.getState().tabs).toBe(tabs)
  } finally { unsubscribe() }
})
