import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import StageShell from '../StageShell'
import { useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useAgentStore } from '../../../stores/agent-store'
import { useLLMStore } from '../../../stores/llm-store'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import '../../../mobile/mobile.css'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const session = { projectId: 'mobile-test', projectPath: 'C:/synthetic/mobile', leaseId: 'lease' }
let root: Root
let host: HTMLDivElement
beforeEach(async () => {
  await page.viewport(390, 780)
  document.documentElement.dataset.platform = 'android'
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: {
    invoke: vi.fn(async (channel: string) => channel === 'config:get' ? {} : channel.endsWith('get-all') || channel.endsWith('-list') ? [] : false),
    on: () => () => undefined,
  } })
  setActiveProjectSessionContext(session)
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '移动测试', novelConfig: {} } as ProjectData })
  useLayoutStore.setState({ settingsOpen: false, sidebarView: 'project' })
  useLLMStore.setState({ models: [], loaded: true })
  useAgentStore.setState({ conversations: [], activeConversationId: null, toolsInitialized: true, generating: false })
  useStageStore.setState({ sheet: null, focus: false, palette: null, work: null })
  useEditorStore.setState({ tabs: [{ id: 'draft', name: '原稿', type: 'arch-file', filePath: 'C:/synthetic/mobile/notes.md', projectKey: session.projectPath, content: '未保存的正文', savedContent: '原始正文', dirty: true }], activeTabId: 'draft', draftLedgers: {} })
  host = document.createElement('div')
  host.style.cssText = 'width:100%;height:760px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<StageShell theme="light" />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete document.documentElement.dataset.platform
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useProjectStore.setState({ currentProject: null })
  await page.viewport(1280, 900)
})

describe('mobile stage assistant', () => {
  it('opens the assistant above the same unsaved editor and closes it using Android back', async () => {
    const editor = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
    expect(editor.state.doc.toString()).toBe('未保存的正文')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="AI 写作助手"]')!.click())
    expect(host.querySelector('.stage-agent-sheet')).toBeTruthy()
    const sheet = host.querySelector<HTMLElement>('.stage-agent-slot')!.getBoundingClientRect()
    expect(sheet.width).toBeLessThanOrEqual(390)
    expect(sheet.width).toBeGreaterThan(350)
    expect(EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)).toBe(editor)
    const back = new Event('android-back', { cancelable: true })
    await act(async () => window.dispatchEvent(back))
    expect(back.defaultPrevented).toBe(true)
    expect(host.querySelector('.stage-agent-sheet')).toBeNull()
    expect(editor.state.doc.toString()).toBe('未保存的正文')
    expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
  })

  it('keeps the writing surface mounted when navigation opens and the viewport resizes', async () => {
    const editor = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="作品导航"]')!.click())
    expect(getComputedStyle(host.querySelector('.stage-spine')!).display).not.toBe('none')
    await page.viewport(780, 390)
    expect(EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)).toBe(editor)
    await act(async () => window.dispatchEvent(new Event('android-back', { cancelable: true })))
    expect(getComputedStyle(host.querySelector('.stage-spine')!).display).toBe('none')
    expect(editor.state.doc.toString()).toBe('未保存的正文')
  })

  it('overlays the assistant on a tablet without narrowing the writing page', async () => {
    await act(async () => page.viewport(1024, 768))
    const content = host.querySelector<HTMLElement>('.stage-content')!
    const editor = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
    const originalWidth = content.getBoundingClientRect().width
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="AI 写作助手"]')!.click())
    const sheet = host.querySelector<HTMLElement>('.stage-agent-slot')!
    expect(getComputedStyle(sheet).position).toBe('absolute')
    expect(sheet.getBoundingClientRect().width).toBe(460)
    expect(content.getBoundingClientRect().width).toBe(originalWidth)
    expect(EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)).toBe(editor)
    expect(editor.state.doc.toString()).toBe('未保存的正文')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="收起助手"]')!.click())
    expect(content.getBoundingClientRect().width).toBe(originalWidth)
  })
})
