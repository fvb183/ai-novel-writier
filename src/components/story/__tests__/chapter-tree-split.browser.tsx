import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ChapterTreeSplit, { CHAPTER_TREE_WIDTH_PREFERENCE } from '../ChapterTreeSplit'
import StoryTreeCanvas from '../StoryTreeCanvas'
import type { StorySnapshot } from '../../../shared/story-branches'
import { useLocaleStore } from '../../../stores/locale-store'
import '../chapter-tree-workspace.css'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
let originalPreference: string | null
let originalLocale: ReturnType<typeof useLocaleStore.getState>['locale']
const separator = () => host.querySelector<HTMLDivElement>('[role="separator"]')!
const left = () => host.querySelector<HTMLDivElement>('.chapter-tree-split-map')!
const right = () => host.querySelector<HTMLDivElement>('.chapter-tree-split-editor')!
const width = () => Math.round(left().getBoundingClientRect().width)
const nextLayout = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
async function settleLayout() {
  // CSS container queries apply before ResizeObserver updates the React state.
  // Flush that measurement inside act before checking both layout and focusability.
  await act(async () => { await nextLayout() })
}
async function resizeHost(value: number) {
  await act(async () => { host.style.width = `${value}px`; await nextLayout() })
}
async function renderSplit() {
  await act(async () => root.render(<ChapterTreeSplit><div style={{ height: 500 }}>章节树</div><textarea aria-label="原蓝图字段" defaultValue="保留原有字段" /></ChapterTreeSplit>))
  await settleLayout()
  await vi.waitFor(() => {
    expect(width()).toBeGreaterThanOrEqual(300)
    expect(separator().getAttribute('aria-valuemax')).toBe('736')
    expect(separator().tabIndex).toBe(0)
  })
}
async function pointer(type: string, clientX: number) {
  await act(async () => separator().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, clientX })))
}
beforeEach(async () => {
  originalPreference = localStorage.getItem(CHAPTER_TREE_WIDTH_PREFERENCE)
  localStorage.removeItem(CHAPTER_TREE_WIDTH_PREFERENCE)
  originalLocale = useLocaleStore.getState().locale
  useLocaleStore.setState({ locale: 'zh-CN' })
  await page.viewport(1440, 1_000)
  host = document.createElement('div')
  host.className = 'paper-ink chapter-tree-workspace'
  host.style.cssText = 'width:1100px;max-width:100%;container-type:inline-size'
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  if (originalPreference === null) localStorage.removeItem(CHAPTER_TREE_WIDTH_PREFERENCE)
  else localStorage.setItem(CHAPTER_TREE_WIDTH_PREFERENCE, originalPreference)
  useLocaleStore.setState({ locale: originalLocale })
})

describe('chapter tree column splitter', () => {
  it('dragging changes both actual columns, preserves field contents and remembers width on remount', async () => {
    await renderSplit()
    const previousRight = right().getBoundingClientRect().width
    await pointer('pointerdown', 420)
    await pointer('pointermove', 600)
    await pointer('pointerup', 600)
    await vi.waitFor(() => expect(width()).toBe(600))
    expect(right().getBoundingClientRect().width).toBeCloseTo(previousRight - 180, 0)
    expect(host.querySelector('textarea')?.value).toBe('保留原有字段')
    expect(localStorage.getItem(CHAPTER_TREE_WIDTH_PREFERENCE)).toBe('600')
    await act(async () => root.render(null))
    await renderSplit()
    expect(width()).toBe(600)
  })

  it('supports keyboard adjustment, limits, and double click reset', async () => {
    await renderSplit()
    await act(async () => separator().focus())
    await act(async () => userEvent.keyboard('{ArrowRight}'))
    expect(width()).toBe(436)
    await act(async () => userEvent.keyboard('{Home}'))
    expect(width()).toBe(300)
    await act(async () => userEvent.keyboard('{End}'))
    expect(width()).toBe(736)
    expect(right().getBoundingClientRect().width).toBeGreaterThanOrEqual(340)
    await act(async () => separator().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(width()).toBe(420)
    expect(localStorage.getItem(CHAPTER_TREE_WIDTH_PREFERENCE)).toBeNull()
    expect(separator().getAttribute('aria-valuenow')).toBe('420')
  })

  it('temporarily clamps in a narrower container, stacks on mobile, and restores the desktop preference', async () => {
    localStorage.setItem(CHAPTER_TREE_WIDTH_PREFERENCE, '650')
    await renderSplit()
    expect(width()).toBe(650)
    await resizeHost(900)
    await vi.waitFor(() => {
      expect(width()).toBe(536)
      expect(separator().getAttribute('aria-valuemax')).toBe('536')
    })
    expect(localStorage.getItem(CHAPTER_TREE_WIDTH_PREFERENCE)).toBe('650')
    await resizeHost(393)
    await vi.waitFor(() => {
      expect(host.querySelector('.chapter-tree-split')?.getAttribute('data-stacked')).toBe('true')
      expect(getComputedStyle(separator()).display).toBe('none')
      expect(separator().tabIndex).toBe(-1)
      expect(right().getBoundingClientRect().top).toBeGreaterThan(left().getBoundingClientRect().bottom)
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth)
    })
    await resizeHost(1_100)
    await vi.waitFor(() => {
      expect(width()).toBe(650)
      expect(host.querySelector('.chapter-tree-split')?.getAttribute('data-stacked')).toBe('false')
      expect(separator().tabIndex).toBe(0)
    })
  })

  it('only exposes a delete action on selected deletable chapter cards', async () => {
    const onDelete = vi.fn()
    const snapshot: StorySnapshot = { revision: 'test', nodes: [
      { id: 'chapter:1', kind: 'content', chapterNumber: 1, title: '已有正文', event: '', body: '正文', revisionId: 'r1', mainline: { chapterNumber: 1, manuscriptStatus: 'finalized', hasBlueprint: false } },
      { id: 'chapter:2', kind: 'content', chapterNumber: 2, title: '待写章节', event: '', body: '', revisionId: 'r2', mainline: { chapterNumber: 2, manuscriptStatus: 'unwritten', hasBlueprint: true } },
    ], routes: [], edges: [], notes: [], revisions: [] }
    const render = (id: string) => act(async () => root.render(<StoryTreeCanvas snapshot={snapshot} selectedNodeId={id} selectedEdgeId="" selectedRouteId="" disabled={false} onSelectNode={() => {}} onSelectEdge={() => {}} onAddChild={() => {}} onFork={() => {}} onMerge={() => {}} onConnect={() => {}} onCreateRoot={() => {}} onDeleteNode={onDelete} canDeleteNode={nodeId => nodeId === 'chapter:2'} />))
    await render('chapter:1')
    await settleLayout()
    expect(host.querySelector('.story-tree-delete')).toBeNull()
    expect(host.querySelector('[data-story-node="chapter:1"] .story-tree-card-kicker')?.textContent).toContain('主线章节')
    await render('chapter:2')
    await act(async () => page.getByRole('button', { name: '删除「待写章节」的蓝图', exact: true }).click())
    expect(onDelete).toHaveBeenCalledExactlyOnceWith('chapter:2')
    expect(host.querySelectorAll('.story-tree-delete')).toHaveLength(1)
  })
})
