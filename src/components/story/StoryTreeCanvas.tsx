import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import { ChevronDown, ChevronRight, CornerDownRight, GitFork, GitMerge, Link2, LocateFixed, Maximize, Minus, Plus, Search, Trash2, Workflow, X } from 'lucide-react'
import type { StorySnapshot } from '../../shared/story-branches'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { layoutStoryTree } from './story-tree-layout'
import './story-tree-canvas.css'

export interface StoryTreeCanvasProps {
  snapshot: StorySnapshot
  selectedNodeId: string
  selectedEdgeId: string
  selectedRouteId: string
  disabled: boolean
  onSelectNode(id: string): void
  onSelectEdge(id: string): void
  onAddChild(id: string): void
  onContinueMainline?(id: string): void
  onFork(id: string): void
  onMerge(id: string): void
  onConnect(from: string, to: string): void
  onCreateRoot(): void
  onInsertAfter?(id: string): void
  onDeleteNode?(id: string): void
  canDeleteNode?(id: string): boolean
}
const clampScale = (value: number) => Math.max(0.35, Math.min(1.6, value))

/** Tree navigation stays local; all authoring is delegated to the workspace. */
export default function StoryTreeCanvas(props: StoryTreeCanvasProps) {
  const { snapshot, selectedNodeId, selectedEdgeId, selectedRouteId, disabled,
    onSelectNode, onSelectEdge, onAddChild, onContinueMainline, onFork, onMerge, onConnect, onCreateRoot, onInsertAfter, onDeleteNode, canDeleteNode } = props
  const text = useLocaleStore(state => state.text)
  const marker = `story-arrow-${useId().replaceAll(':', '')}`
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [scale, setScale] = useState(1)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [query, setQuery] = useState('')
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const layout = useMemo(() => layoutStoryTree(snapshot, collapsed), [snapshot, collapsed])
  const positions = useMemo(() => new Map(layout.nodes.map(item => [item.node.id, item])), [layout])
  const route = snapshot.routes.find(item => item.id === selectedRouteId)
  const routeNodes = new Set(route?.nodeIds ?? [])
  const routeConnections = new Set((route?.nodeIds ?? []).slice(1).map((id, index) => `${route!.nodeIds[index]}|${id}`))
  const nodeNames = new Map(snapshot.nodes.map(node => [node.id, node.title]))
  const matches = query.trim() ? snapshot.nodes.filter(node => node.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 8) : []
  const sourceTitle = connectFrom ? nodeNames.get(connectFrom) : undefined
  const blockedConnections = useMemo(() => {
    const blocked = new Set<string>()
    if (!connectFrom) return blocked
    const incoming = new Map<string, string[]>()
    for (const edge of snapshot.edges) {
      const parents = incoming.get(edge.to) ?? []
      parents.push(edge.from)
      incoming.set(edge.to, parents)
    }
    const queue = [connectFrom]
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]
      if (blocked.has(current)) continue
      blocked.add(current)
      queue.push(...(incoming.get(current) ?? []))
    }
    for (const edge of snapshot.edges) if (edge.from === connectFrom) blocked.add(edge.to)
    return blocked
  }, [connectFrom, snapshot.edges])
  const canConnectTo = (id: string) => Boolean(connectFrom && !blockedConnections.has(id))
  const locate = (id = selectedNodeId) => {
    const view = viewport.current, point = positions.get(id)
    if (!view || !point) return
    const offset = Math.max(0, (view.clientWidth - layout.width * scale) / 2)
    view.scrollTo({ left: offset + (point.x + point.width / 2) * scale - view.clientWidth / 2,
      top: (point.y + point.height / 2) * scale - view.clientHeight / 2 })
  }
  const zoom = (next: number) => {
    const view = viewport.current
    const value = clampScale(next)
    if (!view || value === scale) return
    const previousOffset = Math.max(0, (view.clientWidth - layout.width * scale) / 2)
    const centerX = (view.scrollLeft + view.clientWidth / 2 - previousOffset) / scale
    const centerY = (view.scrollTop + view.clientHeight / 2) / scale
    setScale(value)
    requestAnimationFrame(() => {
      const offset = Math.max(0, (view.clientWidth - layout.width * value) / 2)
      view.scrollTo({ left: centerX * value + offset - view.clientWidth / 2, top: centerY * value - view.clientHeight / 2 })
    })
  }
  const fit = () => {
    const view = viewport.current
    if (!view) return
    setScale(clampScale(Math.min((view.clientWidth - 32) / layout.width, (view.clientHeight - 32) / layout.height, 1)))
    requestAnimationFrame(() => view.scrollTo({ left: 0, top: 0 }))
  }
  const reveal = (id: string) => {
    if (!positions.has(id)) setCollapsed(new Set())
    previousSelection.current = ''
    onSelectNode(id)
    setQuery('')
    if (positions.has(id)) requestAnimationFrame(() => locate(id))
  }
  useEffect(() => {
    const view = viewport.current
    if (!view) return
    const observer = new ResizeObserver(() => setSize({ width: view.clientWidth, height: view.clientHeight }))
    observer.observe(view)
    setSize({ width: view.clientWidth, height: view.clientHeight })
    return () => observer.disconnect()
  }, [])
  const previousSelection = useRef('')
  const initialized = useRef(false)
  useEffect(() => {
    const view = viewport.current
    if (!view || !size.width || !layout.nodes.length) return
    if (!initialized.current) {
      initialized.current = true
      previousSelection.current = selectedNodeId
      view.scrollLeft = Math.max(0, (layout.width * scale - view.clientWidth) / 2)
      if (positions.has(selectedNodeId)) locate(selectedNodeId)
      return
    }
    if (previousSelection.current !== selectedNodeId && positions.has(selectedNodeId)) {
      previousSelection.current = selectedNodeId
      const point = positions.get(selectedNodeId)!
      const offset = Math.max(0, (view.clientWidth - layout.width * scale) / 2)
      const left = point.x * scale + offset, top = point.y * scale
      if (left < view.scrollLeft || left + point.width * scale > view.scrollLeft + view.clientWidth
        || top < view.scrollTop || top + point.height * scale > view.scrollTop + view.clientHeight) locate(selectedNodeId)
    }
  }, [selectedNodeId, positions, size.width, scale])
  useEffect(() => {
    const view = viewport.current
    if (!view) return
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      zoom(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12))
    }
    view.addEventListener('wheel', wheel, { passive: false })
    return () => view.removeEventListener('wheel', wheel)
  }, [scale, layout.width])
  useEffect(() => {
    if (disabled || (connectFrom && !snapshot.nodes.some(node => node.id === connectFrom))) setConnectFrom(null)
  }, [disabled, connectFrom, snapshot.nodes])
  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || (event.target as Element).closest('button,input,select,a,.story-tree-line-hit')) return
    const view = viewport.current!
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop }
    view.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const selectedIsHidden = Boolean(selectedNodeId && !positions.has(selectedNodeId))
  return <section className="story-tree" aria-label={text('剧情树画布', 'Story tree canvas')}>
    <header className="story-tree-head">
      <div className="story-tree-title"><Workflow size={17} aria-hidden="true" /><strong>{text('剧情树', 'Story tree')}</strong><span>{text(`${snapshot.nodes.length} 个节点 · ${snapshot.routes.length} 条路线`, `${snapshot.nodes.length} nodes · ${snapshot.routes.length} routes`)}</span></div>
      <div className="story-tree-search">
        <Search size={15} aria-hidden="true" />
        <input aria-label={text('搜索剧情节点', 'Search story nodes')} placeholder={text('搜索节点，按回车定位', 'Find a node, Enter to locate')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && matches[0]) { event.preventDefault(); reveal(matches[0].id) }
          if (event.key === 'Escape') setQuery('')
        }} />
        {query && <button type="button" aria-label={text('清空节点搜索', 'Clear node search')} onClick={() => setQuery('')}><X size={14} aria-hidden="true" /></button>}
        {query.trim() && <ul className="story-tree-search-results" aria-label={text('节点搜索结果', 'Node search results')}>
          {matches.map(node => <li key={node.id}><button type="button" aria-label={text(`定位「${node.title}」`, `Locate “${node.title}”`)} onClick={() => reveal(node.id)}>{node.title}<CornerDownRight size={13} aria-hidden="true" /></button></li>)}
          {!matches.length && <li className="story-tree-no-results">{text('没有匹配的节点', 'No matching nodes')}</li>}
        </ul>}
      </div>
    </header>
    <div className="story-tree-tools">
      <div className="story-tree-key"><span data-kind="content">{text('主线章节', 'Mainline chapter')}</span><span data-kind="branch">{text('分支章节', 'Branch chapter')}</span></div>
      <div className="story-tree-navigation">
        <Button variant="icon" size="sm" aria-label={text('缩小', 'Zoom out')} disabled={scale <= 0.35} onClick={() => zoom(scale / 1.15)}><Minus size={15} aria-hidden="true" /></Button>
        <output aria-label={text('画布缩放比例', 'Canvas zoom')}>{Math.round(scale * 100)}%</output>
        <Button variant="icon" size="sm" aria-label={text('放大', 'Zoom in')} disabled={scale >= 1.6} onClick={() => zoom(scale * 1.15)}><Plus size={15} aria-hidden="true" /></Button>
        <Button variant="icon" size="sm" aria-label={text('适应画布', 'Fit tree')} onClick={fit}><Maximize size={15} aria-hidden="true" /></Button>
        <Button variant="icon" size="sm" aria-label={text('定位当前节点', 'Locate current node')} disabled={!selectedNodeId} onClick={() => {
          if (selectedIsHidden) { setCollapsed(new Set()); previousSelection.current = '' }
          else locate()
        }}><LocateFixed size={15} aria-hidden="true" /></Button>
      </div>
    </div>
    {connectFrom && <div className="story-tree-connection-prompt" role="status"><Link2 size={15} aria-hidden="true" /><span>{text(`从「${sourceTitle}」连到… 请点击一个可用节点`, `Connect from “${sourceTitle}”… Select an available node`)}</span><Button variant="text" size="sm" onClick={() => setConnectFrom(null)}>{text('取消连接', 'Cancel link')}</Button></div>}
    <div ref={viewport} className={`story-tree-viewport story-map${dragging ? ' is-panning' : ''}${connectFrom ? ' is-connecting' : ''}`} tabIndex={0} aria-label={text('可拖动的剧情树', 'Pannable story tree')}
      onPointerDown={beginDrag} onPointerMove={event => {
        if (drag.current?.pointerId !== event.pointerId) return
        const view = viewport.current!
        view.scrollLeft = drag.current.left - event.clientX + drag.current.x
        view.scrollTop = drag.current.top - event.clientY + drag.current.y
      }} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = null; setDragging(false) }} onKeyDown={event => {
        if (event.key === 'Escape') setConnectFrom(null)
      }}>
      {!snapshot.nodes.length ? <div className="story-tree-empty"><Workflow size={36} strokeWidth={1.2} aria-hidden="true" /><h3>{text('从一个起点，长出你的故事', 'Let your story grow from one beginning')}</h3><p>{text('在节点上继续、分叉或汇合，直接搭出故事的走向。', 'Continue, branch and merge directly from each node.')}</p><Button variant="primary" disabled={disabled} onClick={onCreateRoot}><Plus size={15} aria-hidden="true" />{text('添加起点', 'Add beginning')}</Button></div>
        : <div className="story-tree-space" style={{ width: Math.max(size.width, layout.width * scale), height: Math.max(size.height, layout.height * scale) }}>
          <div className="story-tree-scene" style={{ width: layout.width, height: layout.height, left: Math.max(0, (size.width - layout.width * scale) / 2), transform: `scale(${scale})` }}>
            <svg className="story-tree-lines" width={layout.width} height={layout.height} aria-hidden="true">
              <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="context-stroke" /></marker></defs>
              {layout.edges.map(({ edge, path }) => <g key={edge.id} className={`${routeConnections.has(`${edge.from}|${edge.to}`) ? 'is-on-route ' : ''}${edge.id === selectedEdgeId ? 'is-selected' : ''}`}>
                <path className="story-tree-line-hit" d={path} onClick={() => onSelectEdge(edge.id)} />
                <path className="story-tree-line" d={path} markerEnd={`url(#${marker})`} />
              </g>)}
            </svg>
            {layout.edges.map(({ edge, labelX, labelY }) => <button key={edge.id} type="button" className="story-tree-edge" data-story-edge={edge.id} data-on-route={routeConnections.has(`${edge.from}|${edge.to}`)} data-selected={edge.id === selectedEdgeId} style={{ left: labelX, top: labelY }}
              aria-label={text(`连接「${nodeNames.get(edge.from)}」到「${nodeNames.get(edge.to)}」：${edge.label}`, `Link “${nodeNames.get(edge.from)}” to “${nodeNames.get(edge.to)}”: ${edge.label}`)} aria-pressed={edge.id === selectedEdgeId} title={[edge.label, edge.condition].filter(Boolean).join('\n')} onClick={() => onSelectEdge(edge.id)}>
              <span>{edge.label || text('继续', 'Continue')}</span>{edge.condition && <small>{edge.condition}</small>}
            </button>)}
            {layout.nodes.map(({ node, x, y, width, height }) => {
              const selected = node.id === selectedNodeId
              const children = snapshot.edges.filter(edge => edge.from === node.id)
              const nodeRoutes = snapshot.routes.filter(item => item.nodeIds.includes(node.id)).sort((a, b) => a.id.localeCompare(b.id))
              const available = Boolean(connectFrom && canConnectTo(node.id))
              return <article key={node.id} className="story-tree-card" data-story-node={node.id} data-mainline={Boolean(node.mainline)} data-manuscript-status={node.mainline?.manuscriptStatus} data-kind={node.kind} data-selected={selected} data-on-route={routeNodes.has(node.id)} data-collapsed={collapsed.has(node.id)} data-connect-target={available} data-connect-blocked={Boolean(connectFrom && !available)} style={{ left: x, top: y, width, height }}>
                {children.length > 0 && <button type="button" className="story-tree-collapse" aria-label={collapsed.has(node.id) ? text(`展开「${node.title}」的后续`, `Expand the story after “${node.title}”`) : text(`折叠「${node.title}」的后续`, `Collapse the story after “${node.title}”`)} aria-expanded={!collapsed.has(node.id)} onClick={() => setCollapsed(previous => {
                  const next = new Set(previous)
                  if (next.has(node.id)) next.delete(node.id); else next.add(node.id)
                  return next
                })}>{collapsed.has(node.id) ? <ChevronRight size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}</button>}
                <button type="button" className="story-tree-card-select" aria-label={node.title} aria-pressed={selected} disabled={Boolean(connectFrom && !available)} onClick={() => {
                  if (connectFrom && available && !disabled) { onConnect(connectFrom, node.id); setConnectFrom(null) }
                  else onSelectNode(node.id)
                }}>
                  <span className="story-tree-card-kicker"><span>{node.kind === 'branch' ? <GitFork size={12} aria-hidden="true" /> : node.kind === 'merge' ? <GitMerge size={12} aria-hidden="true" /> : <span className="story-tree-content-dot" />}{node.mainline ? text('主线章节', 'Mainline chapter') : text('分支章节', 'Branch chapter')}</span>{node.chapterNumber !== null && <span>{text(`第 ${node.chapterNumber} 章`, `Ch. ${node.chapterNumber}`)}</span>}</span>
                  <strong>{node.title || text('未命名节点', 'Untitled node')}</strong>
                  <span className="story-tree-card-event">{node.event || (node.mainline && !node.mainline.hasBlueprint ? ['missing', 'unavailable'].includes(node.mainline.manuscriptStatus) ? text('章节来源待核对', 'Review this chapter source') : (node.mainline.hasManuscript ?? Boolean(node.body.trim())) ? text('已有正文，尚无章节蓝图', 'Manuscript without a chapter blueprint') : text('尚无正文或章节蓝图', 'No manuscript or chapter blueprint yet') : text('点击编写章节蓝图', 'Select to plan this chapter'))}</span>
                  <span className="story-tree-card-routes">{nodeRoutes.length ? <>{nodeRoutes.slice(0, 2).map(item => <span key={item.id} data-current={item.id === selectedRouteId}>{item.title}</span>)}{nodeRoutes.length > 2 && <span>+{nodeRoutes.length - 2}</span>}</> : <span className="story-tree-unrouted">{text('尚未加入路线', 'Not in a route yet')}</span>}</span>
                </button>
                {selected ? <div className="story-tree-card-actions">
                  {(!node.mainline || onContinueMainline) && <button type="button" disabled={disabled || Boolean(node.mainline && ['missing', 'unavailable'].includes(node.mainline.manuscriptStatus))} aria-label={text(`在「${node.title}」后继续`, `Continue after “${node.title}”`)} onClick={() => node.mainline ? onContinueMainline?.(node.id) : onAddChild(node.id)}><Plus size={12} aria-hidden="true" />{text('继续', 'Next')}</button>}
                  <button type="button" disabled={disabled} aria-label={text(`从「${node.title}」分叉`, `Branch from “${node.title}”`)} onClick={() => onFork(node.id)}><GitFork size={12} aria-hidden="true" />{text('分叉', 'Branch')}</button>
                  {node.mainline && onInsertAfter ? <button type="button" disabled={disabled} aria-label={text(`在「${node.title}」之后插章`, `Insert after “${node.title}”`)} onClick={() => onInsertAfter(node.id)}><Plus size={12} aria-hidden="true" />{text('插章', 'Insert')}</button> : <><button type="button" disabled={disabled} aria-label={text(`从「${node.title}」汇合`, `Merge from “${node.title}”`)} onClick={() => onMerge(node.id)}><GitMerge size={12} aria-hidden="true" />{text('汇合', 'Merge')}</button><button type="button" disabled={disabled} aria-label={text(`从「${node.title}」连接现有节点`, `Link from “${node.title}” to an existing node`)} aria-pressed={connectFrom === node.id} onClick={() => setConnectFrom(connectFrom === node.id ? null : node.id)}><Link2 size={12} aria-hidden="true" />{text('连接', 'Link')}</button></>}
                  {onDeleteNode && (!canDeleteNode || canDeleteNode(node.id)) && <button type="button" className="story-tree-delete" disabled={disabled} aria-label={node.mainline ? text(`删除「${node.title}」的蓝图`, `Delete the blueprint for “${node.title}”`) : text(`删除章节「${node.title}」`, `Delete chapter “${node.title}”`)} title={node.mainline ? text('删除蓝图，保留已有正文', 'Delete blueprint; keep manuscript') : text('删除这个分支章节', 'Delete this branch chapter')} onClick={() => onDeleteNode(node.id)}><Trash2 size={12} aria-hidden="true" />{text('删除', 'Delete')}</button>}
                </div> : <div className="story-tree-card-foot">{collapsed.has(node.id) ? text(`已收起 ${children.length} 个后续连接`, `${children.length} following links collapsed`) : node.body ? text(`${node.body.length.toLocaleString()} 字正文`, `${node.body.length.toLocaleString()} characters`) : text('选择节点以编辑', 'Select to edit')}</div>}
              </article>
            })}
          </div>
        </div>}
    </div>
    <footer className="story-tree-foot"><span>{route ? text(`高亮路线：${route.title}`, `Highlighted route: ${route.title}`) : text('全图 · 点击节点编辑，点击连线调整走向', 'Whole tree · Select a node to write or a link to edit its direction')}</span>{collapsed.size > 0 ? <button type="button" onClick={() => setCollapsed(new Set())}>{text(`展开全部${layout.hiddenCount ? `（${layout.hiddenCount} 个节点已收起）` : ''}`, `Expand all${layout.hiddenCount ? ` (${layout.hiddenCount} nodes hidden)` : ''}`)}</button> : <span className="story-tree-pan-hint">{text('拖动空白处移动 · Ctrl + 滚轮缩放', 'Drag the background to pan · Ctrl + wheel to zoom')}</span>}</footer>
  </section>
}
