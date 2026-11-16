import { EditorView } from '@codemirror/view'

// Run before constructing any editor. Some Android WebView/IME combinations
// retain stale EditContext selection bounds after the keyboard resizes.
// CodeMirror's DOM composition path also preserves native selection handles.
if (typeof navigator !== 'undefined' && (
  /Android\b/.test(navigator.userAgent)
  || (typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android')
)) {
  ;(EditorView as typeof EditorView & { EDIT_CONTEXT?: boolean }).EDIT_CONTEXT = false
}
