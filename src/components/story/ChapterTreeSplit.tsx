import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { ArrowLeft, GripVertical } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import './chapter-tree-split.css'

export const CHAPTER_TREE_WIDTH_PREFERENCE = 'ai-novel:chapter-tree:column-width'
const DEFAULT_WIDTH = 420
const MIN_TREE_WIDTH = 300
const MIN_EDITOR_WIDTH = 340
const SEPARATOR_WIDTH = 24
const STACKED_WIDTH = 800
const NAVIGATION_WIDTH = 899

function savedWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(CHAPTER_TREE_WIDTH_PREFERENCE))
    return Number.isFinite(value) && value >= MIN_TREE_WIDTH && value <= 16_384 ? value : DEFAULT_WIDTH
  } catch { return DEFAULT_WIDTH }
}
function persistWidth(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(CHAPTER_TREE_WIDTH_PREFERENCE)
    else window.localStorage.setItem(CHAPTER_TREE_WIDTH_PREFERENCE, String(Math.round(value)))
  } catch { /* A blocked preference store must not interrupt chapter editing. */ }
}

export type ChapterTreePane = 'tree' | 'details'
/** Column width and the narrow-screen view are presentation preferences only.
 * Both panes stay mounted so returning to the tree never discards editor input. */
export default function ChapterTreeSplit({ children, mobileNavigation }: {
  children: [ReactNode, ReactNode]
  mobileNavigation?: { pane: ChapterTreePane; onChange(pane: ChapterTreePane): void; detailsAvailable: boolean; title?: string }
}) {
  const text = useLocaleStore(state => state.text)
  const root = useRef<HTMLDivElement>(null)
  const mapPane = useRef<HTMLDivElement>(null)
  const editorPane = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x: number; width: number } | null>(null)
  const [preference, setPreference] = useState(savedWidth)
  const [containerWidth, setContainerWidth] = useState(0)
  const [resizing, setResizing] = useState(false)
  const leftId = `chapter-tree-map-${useId()}`
  const rightId = `chapter-tree-editor-${useId()}`
  const maximum = Math.max(MIN_TREE_WIDTH, (containerWidth || 1_200) - MIN_EDITOR_WIDTH - SEPARATOR_WIDTH)
  const clamp = (value: number) => Math.round(Math.min(maximum, Math.max(MIN_TREE_WIDTH, value)))
  const width = clamp(preference)
  const currentWidth = useRef(width)
  currentWidth.current = width
  const stacked = containerWidth > 0 && containerWidth <= (mobileNavigation ? NAVIGATION_WIDTH : STACKED_WIDTH)
  const singlePane = stacked && mobileNavigation !== undefined
  const mobilePane = mobileNavigation?.pane
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => setContainerWidth(element.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!singlePane) return
    const pane = mobilePane === 'details' ? editorPane.current : mapPane.current
    if (!pane || pane.contains(document.activeElement)) return
    const target = mobilePane === 'tree'
      ? pane.querySelector<HTMLElement>('.story-tree-card-select[aria-pressed="true"]') ?? pane : pane
    const workspace = root.current?.closest<HTMLElement>('.chapter-tree-workspace')
    if (workspace) workspace.scrollTop = 0
    target.focus({ preventScroll: true })
  }, [singlePane, mobilePane])
  const change = (value: number, persist = true) => {
    const next = clamp(value)
    currentWidth.current = next
    setPreference(next)
    if (persist) persistWidth(next)
  }
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    setResizing(false)
    persistWidth(currentWidth.current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div ref={root} className="chapter-tree-columns chapter-tree-split" data-stacked={stacked} data-resizing={resizing} data-mobile-pane={singlePane ? mobileNavigation.pane : undefined}
    style={{ '--chapter-tree-map-width': `${width}px` } as CSSProperties}>
    {singlePane && <nav className="chapter-tree-mobile-nav" aria-label={text('章节视图', 'Chapter views')}>
      {mobileNavigation.pane === 'details'
        ? <><Button variant="secondary" size="sm" data-chapter-tree-back aria-controls={leftId} onClick={() => mobileNavigation.onChange('tree')}><ArrowLeft size={15} aria-hidden />{text('返回剧情树', 'Back to story tree')}</Button><span title={mobileNavigation.title}>{mobileNavigation.title || text('章节详情', 'Chapter details')}</span></>
        : <><span>{text('剧情树', 'Story tree')}</span><Button variant="secondary" size="sm" aria-controls={rightId} disabled={!mobileNavigation.detailsAvailable} onClick={() => mobileNavigation.onChange('details')}>{text('章节详情', 'Chapter details')}</Button></>}
    </nav>}
    <div ref={mapPane} id={leftId} className="chapter-tree-split-map" hidden={singlePane && mobileNavigation.pane !== 'tree'} tabIndex={singlePane ? -1 : undefined}>{children[0]}</div>
    <div className="chapter-tree-separator" role="separator" aria-orientation="vertical" tabIndex={stacked ? -1 : 0}
      aria-label={text('调整章节树与蓝图宽度', 'Resize chapter tree and blueprint')}
      aria-controls={`${leftId} ${rightId}`} aria-valuemin={MIN_TREE_WIDTH} aria-valuemax={Math.round(maximum)} aria-valuenow={width}
      aria-valuetext={text(`章节树宽 ${width} 像素`, `Chapter tree width ${width} pixels`)}
      title={text('拖动调整宽度；方向键微调；双击恢复默认', 'Drag to resize; arrow keys to adjust; double-click to reset')}
      onPointerDown={event => {
        if (stacked || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus()
        drag.current = { id: event.pointerId, x: event.clientX, width }
        setResizing(true)
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* Synthetic/accessibility pointers need no capture. */ }
      }} onPointerMove={event => {
        if (drag.current?.id === event.pointerId && !stacked) change(drag.current.width + event.clientX - drag.current.x, false)
      }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onDoubleClick={() => { setPreference(DEFAULT_WIDTH); persistWidth(null) }}
      onKeyDown={event => {
        if (stacked || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const step = event.shiftKey ? 48 : 16
        change(event.key === 'Home' ? MIN_TREE_WIDTH : event.key === 'End' ? maximum : width + (event.key === 'ArrowLeft' ? -step : step))
      }}><span aria-hidden="true"><GripVertical size={14} /></span></div>
    <div ref={editorPane} id={rightId} className="chapter-tree-split-editor" hidden={singlePane && mobileNavigation.pane !== 'details'} tabIndex={singlePane ? -1 : undefined}>{children[1]}</div>
  </div>
}
