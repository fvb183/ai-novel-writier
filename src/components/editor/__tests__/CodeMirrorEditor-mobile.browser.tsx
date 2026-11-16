import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import CodeMirrorEditor from '../CodeMirrorEditor'
import '../../../mobile/mobile.css'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
beforeEach(() => {
  document.documentElement.dataset.platform = 'android'
  host = document.createElement('div')
  host.style.height = '400px'
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete document.documentElement.dataset.platform
})
const view = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!

describe('Android editor compatibility', () => {
  it('opens imported CRLF manuscripts and receives external refreshes without reporting author edits', async () => {
    const changed = vi.fn()
    await act(async () => root.render(<CodeMirrorEditor content={'导入第一行\r\n第二行'} editable={false} onChange={changed} />))
    expect(view().state.doc.toString()).toBe('导入第一行\n第二行')
    expect(changed).not.toHaveBeenCalled()
    await act(async () => root.render(<CodeMirrorEditor content={'外部更新\r\n另一行'} editable onChange={changed} />))
    expect(view().state.doc.toString()).toBe('外部更新\n另一行')
    expect(changed).not.toHaveBeenCalled()
    await act(async () => view().dispatch({ changes: { from: view().state.doc.length, insert: '新输入' } }))
    expect(changed).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenLastCalledWith('外部更新\n另一行新输入')
  })
  it('keeps native selection and EditorState when parent callbacks change', async () => {
    await act(async () => root.render(<CodeMirrorEditor content="中文原稿" onChange={() => {}} />))
    const editor = view()
    await act(async () => editor.dispatch({ selection: { anchor: 1, head: 3 } }))
    const previous = editor.state
    const changed = vi.fn()
    await act(async () => root.render(<CodeMirrorEditor content="中文原稿" onChange={changed} />))
    expect(view()).toBe(editor)
    expect(editor.state).toBe(previous)
    expect(host.querySelector('.cm-selectionLayer')).toBeNull()
    await act(async () => editor.dispatch({ changes: { from: 4, insert: '。' } }))
    expect(changed).toHaveBeenLastCalledWith('中文原稿。')
  })

  it('preserves newly composed text over an external refresh received during composition', async () => {
    const changed = vi.fn()
    await act(async () => root.render(<CodeMirrorEditor content="原稿" onChange={changed} />))
    const editor = view()
    await act(async () => {
      editor.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      editor.dispatch({ changes: { from: 2, insert: '你好' } })
    })
    await act(async () => root.render(<CodeMirrorEditor content="远端旧稿" onChange={changed} />))
    expect(editor.state.doc.toString()).toBe('原稿你好')
    await act(async () => {
      editor.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    expect(editor.state.doc.toString()).toBe('原稿你好')
    expect(changed).toHaveBeenLastCalledWith('原稿你好')
  })

  it('offers touch undo, redo and save using the current document', async () => {
    const save = vi.fn()
    await act(async () => root.render(<CodeMirrorEditor content="原稿" onSave={save} />))
    await act(async () => view().dispatch({ changes: { from: 2, insert: '新句' } }))
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')!.click())
    expect(view().state.doc.toString()).toBe('原稿')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="重做"]')!.click())
    expect(view().state.doc.toString()).toBe('原稿新句')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="保存文稿"]')!.click())
    expect(save).toHaveBeenLastCalledWith('原稿新句')
  })
})
