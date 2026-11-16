import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAndroidAutosave } from '../use-android-autosave'
import { registerEditorExitSaveHandler, useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import type { ProjectData } from '../../shared/ipc-channels'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const projectPath = '/private/novel'
let host: HTMLDivElement
let root: Root
let unregister: (() => void) | undefined
function Harness() { useAndroidAutosave(); return null }
beforeEach(async () => {
  document.documentElement.dataset.platform = 'android'
  useProjectStore.setState({ currentProject: { id: 'mobile', path: projectPath, sessionLease: 'lease' } as ProjectData, loading: false })
  useEditorStore.setState({
    tabs: [{ id: 'draft', type: 'chapter', name: '正文', projectKey: projectPath, content: '未保存', contentRevision: 1, dirty: true }],
    draftLedgers: {},
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Harness />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  unregister?.()
  host.remove()
  delete document.documentElement.dataset.platform
  useProjectStore.setState({ currentProject: null })
})

describe('Android background save', () => {
  it('coalesces background signals and only settles the saved revision', async () => {
    let release!: () => void
    const saving = new Promise<void>(done => { release = done })
    const save = vi.fn(async () => {
      await saving
      useEditorStore.getState().settleTabSave('draft', { content: '未保存', contentRevision: 1 })
    })
    unregister = registerEditorExitSaveHandler({ tabId: 'draft', type: 'chapter', projectKey: projectPath, save })
    await act(async () => {
      window.dispatchEvent(new Event('android-background'))
      window.dispatchEvent(new Event('pagehide'))
      useEditorStore.getState().updateTabContent('draft', '保存期间又输入')
      release()
    })
    expect(save).toHaveBeenCalledOnce()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ dirty: true, content: '保存期间又输入' })
  })

  it('retains dirty text after failure and does not save another project', async () => {
    const save = vi.fn(async () => { throw new Error('disk-full') })
    unregister = registerEditorExitSaveHandler({ tabId: 'draft', type: 'chapter', projectKey: projectPath, save })
    await act(async () => window.dispatchEvent(new Event('android-background')))
    expect(save).toHaveBeenCalledOnce()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '未保存', dirty: true })
    useProjectStore.setState({ currentProject: { id: 'other', path: '/private/other', sessionLease: 'other-lease' } as ProjectData })
    await act(async () => window.dispatchEvent(new Event('android-background')))
    expect(save).toHaveBeenCalledOnce()
  })
})
