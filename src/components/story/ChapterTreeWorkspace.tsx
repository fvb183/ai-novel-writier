import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, GitBranch, ListPlus, Plus } from 'lucide-react'
import type { ChapterBlueprint } from '../../services/workflows/directory-workflow'
import type { ChapterRow } from '../../stores/navigation/stage-progress'
import { MAINLINE_STORY_ROUTE_ID, isMainlineStoryEdgeId, isMainlineStoryNodeId, mainlineStoryNodeId, type StoryChapterBlueprint } from '../../shared/story-branches'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../shared/project-session-context'
import { ipc } from '../../services/ipc-client'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import type { useChapterBlueprints } from '../editor/use-chapter-blueprints'
import type { EditableChapterBlueprintField } from '../editor/chapter-card-draft-ledger'
import BlueprintCard from '../stage/blueprint/BlueprintCard'
import { Button } from '../ui/Button'
import { DangerConfirm } from '../ui/DangerConfirm'
import StoryTreeCanvas from './StoryTreeCanvas'
import ChapterTreeSplit, { type ChapterTreePane } from './ChapterTreeSplit'
import StoryChapterActions from './StoryChapterActions'
import StoryRouteManager from './StoryRouteManager'
import { storyMessage } from './StoryBranches'
import { blueprintTreeView } from './blueprint-tree-view'
import { openStoryManuscript } from './story-manuscript-navigation'
import { useProjectStory } from './use-project-story'
import { useStoryChapterDeletion } from './use-story-chapter-deletion'
import { planReconnectRoute, planContinueRoute, planFork, planMerge, type StoryTreePlan } from './story-tree-commands'
import { affectedStoryRoutes, discardStoryWorkspace, getStoryWorkspace, loadStoryWorkspace, nodeInput, saveStoryWorkspace, stageStoryOperations, updateStoryWorkspace } from './story-workspace'
import './chapter-tree-workspace.css'
import InsertChapterDialog, { insertChapterFingerprint, nextInsertChapter } from './InsertChapterDialog'

type Plan = ReturnType<typeof useChapterBlueprints>
const blankBlueprint = (title: string): StoryChapterBlueprint => ({ title, role: '发展', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '', notes: '' })

/** One canonical chapter tree for planning, plotting and independent branches. */
export default function ChapterTreeWorkspace({ projectKey, plan, rows, onDeleteMainline, initialChapterNumber, selectRequest }: {
  projectKey: string; plan: Plan; rows: Map<number, ChapterRow>; onDeleteMainline(chapterNumber: number): void
  initialChapterNumber?: number; selectRequest?: number
}) {
  const text = useLocaleStore(state => state.text)
  const { session, key, workspace, snapshot: storedSnapshot } = useProjectStory()
  const snapshot = useMemo(() => storedSnapshot ? blueprintTreeView(storedSnapshot, plan.blueprints) : null, [storedSnapshot, plan.blueprints])
  const deletion = useStoryChapterDeletion({ workspaceKey: key, snapshot, onDeleteMainline })
  const [forking, setForking] = useState(false)
  const [mobilePane, setMobilePane] = useState<ChapterTreePane>(initialChapterNumber === undefined ? 'tree' : 'details')
  const [mergeSources, setMergeSources] = useState<string[]>([])
  const [danger, setDanger] = useState<'discard' | null>(null)
  const [insertRequest, setInsertRequest] = useState<{ nodeId: string; sessionKey: string; nextFingerprint: string; nextTitle?: string; canReconnect: boolean } | null>(null)
  const latest = useRef({ session, projectKey, selected: workspace?.selectedNodeId })
  latest.current = { session, projectKey, selected: workspace?.selectedNodeId }
  const initialRequest = useRef('')
  const previousBlueprints = useRef(new Set(plan.blueprints.map(blueprint => blueprint.chapterNumber)))
  useEffect(() => {
    const selected = plan.selected?.chapterNumber
    const added = selected !== undefined && !previousBlueprints.current.has(selected)
    previousBlueprints.current = new Set(plan.blueprints.map(blueprint => blueprint.chapterNumber))
    if (added && key && workspace && plan.blueprints.some(blueprint => blueprint.chapterNumber === selected)) {
      setMobilePane('details')
      updateStoryWorkspace(key, { selectedNodeId: mainlineStoryNodeId(selected), selectedRouteId: MAINLINE_STORY_ROUTE_ID, context: null })
    }
  }, [key, plan.blueprints, plan.selected?.chapterNumber])
  const previousPlanSelection = useRef(plan.selected?.chapterNumber)
  useEffect(() => {
    const before = previousPlanSelection.current
    previousPlanSelection.current = plan.selected?.chapterNumber
    if (before !== undefined && plan.selected && before !== plan.selected.chapterNumber && key) {
      setMobilePane('details')
      updateStoryWorkspace(key, { selectedNodeId: mainlineStoryNodeId(plan.selected.chapterNumber), selectedRouteId: MAINLINE_STORY_ROUTE_ID, context: null })
    }
  }, [key, plan.selected?.chapterNumber])
  useEffect(() => {
    if (!workspace || !snapshot || !key) return
    const request = initialChapterNumber ? `${key}:${initialChapterNumber}:${selectRequest ?? 0}` : ''
    if (request && request !== initialRequest.current && snapshot.nodes.some(node => node.id === mainlineStoryNodeId(initialChapterNumber!))) {
      initialRequest.current = request
      setMobilePane('details')
      updateStoryWorkspace(key, { selectedNodeId: mainlineStoryNodeId(initialChapterNumber!), selectedRouteId: MAINLINE_STORY_ROUTE_ID, context: null })
    } else if (!snapshot.nodes.some(node => node.id === workspace.selectedNodeId)) {
      const first = plan.selected ? mainlineStoryNodeId(plan.selected.chapterNumber) : snapshot.nodes[0]?.id ?? ''
      if (first !== workspace.selectedNodeId) updateStoryWorkspace(key, { selectedNodeId: first, selectedRouteId: MAINLINE_STORY_ROUTE_ID, context: null })
    }
  }, [key, snapshot, initialChapterNumber, selectRequest])
  if (!session || session.projectPath !== projectKey || !workspace) return <p>{text('请先打开作品。', 'Open a project first.')}</p>
  if (!snapshot) return <p role="status">{workspace.error ? storyMessage(workspace.error, text) : text('正在读取章节树…', 'Loading chapter tree…')}</p>
  const node = snapshot.nodes.find(item => item.id === workspace.selectedNodeId)
  const route = snapshot.routes.find(item => item.id === workspace.selectedRouteId)
  const edge = snapshot.edges.find(item => item.id === workspace.selectedEdgeId)
  const stale = !sameProjectSessionContext(session, workspace.session)
  const disabled = stale || workspace.busy || forking || !plan.projectDataReady
  const sharing = affectedStoryRoutes(workspace)
  const pending = workspace.pending.length > 0
  const selectNode = (id: string, routeId = workspace.selectedRouteId) => {
    setMobilePane('details')
    const selectedRoute = snapshot.routes.find(item => item.id === routeId)
    const containing = selectedRoute?.nodeIds.includes(id) ? selectedRoute : snapshot.routes.find(item => item.nodeIds.includes(id))
    const selected = snapshot.nodes.find(item => item.id === id)
    const selectedRouteId = containing?.id ?? ''
    const fallback = selected?.id === workspace.selectedNodeId && selectedRouteId === workspace.selectedRouteId ? workspace.bridgeToNodeId : ''
    updateStoryWorkspace(key, { selectedNodeId: id, selectedEdgeId: '', selectedRouteId, context: null,
      bridgeToNodeId: workspace.continuationSelections[`${workspace.mode}:${selectedRouteId}:${id}`] ?? fallback })
  }
  const apply = (result: StoryTreePlan) => {
    if (disabled) return
    if (result.error) { updateStoryWorkspace(key, { error: result.error }); return }
    if (result.selectedNodeId || result.selectedEdgeId) setMobilePane('details')
    stageStoryOperations(key, result.operations)
    updateStoryWorkspace(key, { ...(result.selectedNodeId ? { selectedNodeId: result.selectedNodeId } : {}),
      ...(result.selectedRouteId !== undefined ? { selectedRouteId: result.selectedRouteId } : {}),
      ...(result.selectedEdgeId !== undefined ? { selectedEdgeId: result.selectedEdgeId } : {}), bridgeToNodeId: '', context: null })
  }
  const continueMainline = (id: string) => {
    const source = snapshot.nodes.find(item => item.id === id)
    if (disabled || plan.saving || !source?.mainline
      || ['missing', 'unavailable'].includes(source.mainline.manuscriptStatus)
      || !sameProjectSessionContext(session, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
    const following = snapshot.nodes.filter(item => item.mainline && item.mainline.chapterNumber > source.mainline!.chapterNumber)
      .sort((left, right) => left.mainline!.chapterNumber - right.mainline!.chapterNumber)[0]
    if (following) { selectNode(following.id, MAINLINE_STORY_ROUTE_ID); return }
    const chapterNumber = plan.ensureChapterBlueprint(source.mainline.chapterNumber + 1)
    if (chapterNumber !== null) {
      setMobilePane('details')
      updateStoryWorkspace(key, { selectedNodeId: mainlineStoryNodeId(chapterNumber), selectedRouteId: MAINLINE_STORY_ROUTE_ID, selectedEdgeId: '', bridgeToNodeId: '', context: null })
    }
  }
  const forkMainline = async (id: string, placement: 'branch' | 'insert', expectedNext?: string) => {
    const source = snapshot.nodes.find(item => item.id === id)
    if (!source?.mainline || disabled || !sameProjectSessionContext(session, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
    const captured = session
    const current = () => sameProjectSessionContext(latest.current.session, captured) && latest.current.projectKey === projectKey
      && sameProjectSessionContext(captured, projectSessionContextFromProject(useProjectStore.getState().currentProject))
    setForking(true)
    try {
      if (getStoryWorkspace(key)?.pending.length || getStoryWorkspace(key)?.busy) throw new Error('请先保存树上的修改。')
      // Imported manuscript-only chapters deliberately never call a blueprint save.
      if (plan.blueprints.some(item => item.chapterNumber === source.mainline!.chapterNumber) && !await plan.saveChapter(source.mainline.chapterNumber, true)) throw new Error('请先完整保存这章蓝图。')
      if (!current()) return
      const read = await ipc.invokeWithProjectSession(captured, 'story:read', {})
      if (!read.success) throw new Error(read.error)
      if (!current()) return
      if (placement === 'insert' && expectedNext !== insertChapterFingerprint(nextInsertChapter(read.data, source.mainline.chapterNumber))) throw new Error(text('接回目标已变化，请重新选择插章走向。', 'The reconnect target changed. Choose the inserted chapter direction again.'))
      if (getStoryWorkspace(key)?.pending.length || getStoryWorkspace(key)?.busy) throw new Error('保存期间有新输入，已保留。请先保存树上的修改。')
      const result = await ipc.invokeWithProjectSession(captured, 'story:fork-chapter', { expectedRevision: read.data.revision,
        afterChapter: source.mainline.chapterNumber, placement, title: text(placement === 'insert' ? `第 ${source.chapterNumber} 章后的插章` : `第 ${source.chapterNumber} 章后的分支`, placement === 'insert' ? `Interlude after chapter ${source.chapterNumber}` : `Branch after chapter ${source.chapterNumber}`) })
      if (!result.success) throw new Error(result.error)
      if (!current()) return
      if (getStoryWorkspace(key)?.pending.length) { await loadStoryWorkspace(key, captured, true); return }
      const branchRoute = result.data.snapshot.routes.find(item => item.id === result.data.routeId)
      const index = branchRoute?.nodeIds.indexOf(result.data.nodeId) ?? -1
      const bridge = placement === 'insert' ? branchRoute?.nodeIds[index + 1] ?? '' : ''
      setMobilePane('details')
      updateStoryWorkspace(key, { snapshot: result.data.snapshot, selectedNodeId: result.data.nodeId, selectedRouteId: result.data.routeId,
        selectedEdgeId: '', mode: 'route', context: null, bridgeToNodeId: bridge,
        continuationSelections: { ...workspace.continuationSelections, [`route:${result.data.routeId}:${result.data.nodeId}`]: bridge },
        error: '', notice: text('已添加独立章节，填写右侧蓝图后保存。', 'Independent chapter added. Complete and save its blueprint.') })
    } catch (error) { if (current()) updateStoryWorkspace(key, { error: error instanceof Error ? error.message : String(error) }) }
    finally { setForking(false) }
  }
  const branch = (id: string) => isMainlineStoryNodeId(id) ? void forkMainline(id, 'branch') : apply(planFork(snapshot, id, route?.id ?? null, [text('走向 A', 'Direction A'), text('走向 B', 'Direction B')]))
  const requestInsert = (id: string) => {
    const source = snapshot.nodes.find(item => item.id === id)
    if (disabled || !source?.mainline) return
    const next = nextInsertChapter(snapshot, source.mainline.chapterNumber)
    selectNode(id)
    setInsertRequest({ nodeId: id, sessionKey: JSON.stringify(session), nextFingerprint: insertChapterFingerprint(next),
      nextTitle: next?.title, canReconnect: Boolean(next && next.mainline?.manuscriptStatus !== 'unavailable') })
  }
  const insertSource = insertRequest?.sessionKey === JSON.stringify(session) ? snapshot.nodes.find(item => item.id === insertRequest.nodeId) : undefined
  const connect = (from: string, to: string) => {
    if (disabled) return
    const sourceRoute = (route?.nodeIds.includes(from) ? route : undefined) ?? snapshot.routes.find(item => item.nodeIds.includes(from))
    const result = planReconnectRoute(snapshot, from, to, sourceRoute?.id ?? null, text('接回', 'Reconnect'))
    apply(result)
    if (result.error) return
    const routeId = result.selectedRouteId ?? sourceRoute?.id ?? ''
    updateStoryWorkspace(key, current => ({ selectedNodeId: from, selectedRouteId: routeId, bridgeToNodeId: to, context: null,
      continuationSelections: { ...current.continuationSelections, [`${current.mode}:${routeId}:${from}`]: to } }))
  }
  const changeBranchField = <K extends EditableChapterBlueprintField>(field: K, value: ChapterBlueprint[K]) => {
    if (!node || node.mainline || disabled || field === 'notesUpdatedAt') return
    const blueprint = { ...(node.chapterBlueprint ?? blankBlueprint(node.title)), [field]: value }
    stageStoryOperations(key, [{ type: 'put-node', node: { ...nodeInput(node), chapterBlueprint: blueprint,
      ...(field === 'title' ? { title: String(value) } : {}), ...(field === 'keyEvents' ? { event: String(value) } : {}),
    } }])
  }
  const saveBranch = () => { void saveStoryWorkspace(key).catch(() => undefined) }
  const chapterNumber = node?.chapterNumber ?? Math.max(1, (route?.nodeIds.indexOf(node?.id ?? '') ?? 0) + 1)
  const canonicalBlueprint = node?.mainline ? plan.blueprints.find(item => item.chapterNumber === node.mainline!.chapterNumber) : undefined
  const branchBlueprint = node?.chapterBlueprint ? { ...node.chapterBlueprint, chapterNumber, notesUpdatedAt: '' } : undefined
  const sourceUnavailable = node?.mainline && ['missing', 'unavailable'].includes(node.mainline.manuscriptStatus)
  const hasManuscript = node?.mainline?.hasManuscript ?? Boolean(node?.body.trim())
  const canOpenManuscript = !sourceUnavailable && (!node?.mainline || Boolean(canonicalBlueprint) || hasManuscript)
  const showManuscript = () => { if (node) openStoryManuscript(session, node.id, workspace.selectedRouteId) }
  return <section className="chapter-tree-workspace" aria-label={text('章节树工作台', 'Chapter tree workspace')} data-project={projectKey}>
    <div className="chapter-tree-bar"><label>{text('当前路线', 'Current route')}<select aria-label={text('当前章节路线', 'Current chapter route')} value={workspace.selectedRouteId} onChange={event => {
      const next = snapshot.routes.find(item => item.id === event.target.value)
      if (!next) { updateStoryWorkspace(key, { selectedRouteId: '', context: null, bridgeToNodeId: '' }); return }
      if (next && node && !next.nodeIds.includes(node.id)) selectNode(next.nodeIds[0], next.id)
      else if (node) selectNode(node.id, next?.id ?? '')
      else updateStoryWorkspace(key, { selectedRouteId: next?.id ?? '' })
    }}><option value="">{text('全图', 'Whole tree')}</option>{snapshot.routes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <span>{pending ? text('分支修改未保存', 'Unsaved branch changes') : text('主线与分支，共用一棵章节树', 'One tree for mainline and branches')}</span>
      {pending && <><Button variant="secondary" size="sm" disabled={disabled || workspace.reviewRequired || Boolean(sharing.length && !workspace.sharedEditConfirmed)} onClick={saveBranch}>{text('保存分支内容', 'Save story changes')}</Button><Button variant="text" size="sm" disabled={disabled} onClick={() => setDanger('discard')}>{text('放弃修改', 'Discard changes')}</Button></>}
      <Button variant="text" size="sm" disabled={disabled} onClick={() => void loadStoryWorkspace(key, session, true)}>{text('刷新章节树', 'Refresh chapter tree')}</Button>
    </div>
    {workspace.error && <p className="chapter-tree-message is-error" role="alert">{storyMessage(workspace.error, text)}</p>}
    {workspace.notice && <p className="chapter-tree-message" role="status">{storyMessage(workspace.notice, text)}</p>}
    {workspace.reviewRequired && <div className="chapter-tree-message"><p>{text('来源变化时已保留你的输入。核对当前树与右侧内容后再保存。', 'Your input was retained when sources changed. Review the tree and content before saving.')}</p><Button variant="secondary" size="sm" onClick={() => updateStoryWorkspace(key, { reviewRequired: false, notice: '' })}>{text('已核对保留的输入', 'Reviewed retained input')}</Button></div>}
    {sharing.length > 0 && <label className="chapter-tree-message"><input type="checkbox" checked={workspace.sharedEditConfirmed} onChange={event => updateStoryWorkspace(key, { sharedEditConfirmed: event.target.checked })} />{text(`此修改影响共用路线：${sharing.join('、')}，我已确认。`, `I confirm this change affects shared routes: ${sharing.join(', ')}.`)}</label>}
    <ChapterTreeSplit mobileNavigation={{ pane: mobilePane, onChange: setMobilePane, detailsAvailable: Boolean(node || edge), title: node?.title }}><aside className="chapter-tree-map" aria-label={text('章节规划', 'Chapter plan')}><StoryTreeCanvas snapshot={snapshot} selectedNodeId={workspace.selectedNodeId} selectedEdgeId={workspace.selectedEdgeId} selectedRouteId={workspace.selectedRouteId} disabled={disabled} onSelectNode={selectNode} onSelectEdge={id => { setMobilePane('details'); updateStoryWorkspace(key, { selectedEdgeId: id }) }}
      onAddChild={id => apply(planContinueRoute(snapshot, id, route?.id ?? null, text('后续章节', 'Next chapter')))} onContinueMainline={continueMainline} onFork={branch} onInsertAfter={requestInsert} onMerge={id => { setMobilePane('details'); setMergeSources([id]) }} onConnect={connect} onCreateRoot={plan.addChapter} onDeleteNode={deletion.requestDeleteNode} canDeleteNode={deletion.canDeleteNode} /></aside>
      <div className="chapter-tree-inspector" data-selected-story-node={node?.id ?? ''}>
        {node ? <>
          <header className="chapter-tree-selected"><div><span>{node.mainline ? text('主线章节', 'Mainline chapter') : text('独立分支章节', 'Independent chapter')}</span><strong>{node.title}</strong></div>{canOpenManuscript && <Button variant="secondary" size="sm" onClick={showManuscript}><BookOpen size={14} aria-hidden />{text('打开正文', 'Open manuscript')}</Button>}</header>
          {node.mainline && <div className="chapter-tree-source-actions"><Button variant="secondary" size="sm" disabled={disabled || plan.saving || Boolean(sourceUnavailable)} onClick={() => continueMainline(node.id)}><Plus size={14} aria-hidden />{text('继续下一章', 'Continue to next chapter')}</Button><Button variant="secondary" size="sm" disabled={disabled || plan.saving || Boolean(sourceUnavailable)} onClick={() => void forkMainline(node.id, 'branch')}><GitBranch size={14} aria-hidden />{text('从本章分支', 'Branch from this chapter')}</Button><Button variant="secondary" size="sm" disabled={disabled || plan.saving || Boolean(sourceUnavailable)} onClick={() => requestInsert(node.id)}><ListPlus size={14} aria-hidden />{text('在两章间插入', 'Insert between chapters')}</Button></div>}
          {canonicalBlueprint ? <BlueprintCard key={node.id} blueprint={canonicalBlueprint} row={rows.get(canonicalBlueprint.chapterNumber)} saving={plan.saving} onField={(field, value) => plan.updateChapterField(canonicalBlueprint.chapterNumber, field, value)} onSave={() => void plan.saveChapter(canonicalBlueprint.chapterNumber)} onDelete={() => onDeleteMainline(canonicalBlueprint.chapterNumber)} />
            : node.mainline ? <section className="chapter-tree-no-blueprint" aria-label={sourceUnavailable ? text('章节来源不可用', 'Chapter source unavailable') : text('正文尚无蓝图', 'Manuscript without blueprint')}><BookOpen size={26} aria-hidden /><h2>{sourceUnavailable ? node.mainline.manuscriptStatus === 'missing' ? text('这一章的来源已缺失', 'This chapter source is missing') : text('暂时无法读取这一章的来源', 'This chapter source cannot be read right now') : !hasManuscript ? text('这一章尚无正文或蓝图', 'This chapter has no manuscript or blueprint yet') : text('这一章已有正文，尚无蓝图', 'This chapter has manuscript but no blueprint')}</h2><p>{sourceUnavailable ? text('已保留树上的关联位置。请核对原章节的蓝图与正文来源，再刷新章节树。', 'Its position in the story is retained. Review the original blueprint and manuscript sources, then refresh the tree.') : !hasManuscript ? text('树上保留这个章节的关联位置，尚未发现已保存的正文内容。', 'This position in the story is retained, with no saved manuscript content yet.') : text('保留原有正文。可以打开正文阅读编辑，或从本章展开独立分支。', 'Keep the original manuscript. Open it to read or edit, or branch into an independent chapter.')}</p>{canOpenManuscript && <Button variant="primary" onClick={showManuscript}>{text('打开本章正文', 'Open this manuscript')}</Button>}</section>
              : branchBlueprint ? <BlueprintCard key={node.id} blueprint={branchBlueprint} row={{ number: chapterNumber, title: node.title, phase: node.body ? 'draft' : 'todo', running: false, draft: null, hasFinal: false }} saving={workspace.busy} onField={changeBranchField} onSave={saveBranch} onDelete={() => deletion.requestDeleteBlueprint(node.id)} />
                : <section className="chapter-tree-no-blueprint"><h2>{text('为这个分支规划章节蓝图', 'Plan this branch chapter')}</h2><Button variant="primary" disabled={disabled} onClick={() => stageStoryOperations(key, [{ type: 'put-node', node: { ...nodeInput(node), chapterBlueprint: blankBlueprint(node.title) } }])}><Plus size={14} aria-hidden />{text('添加分支蓝图', 'Add branch blueprint')}</Button></section>}
          {!node.mainline && <><StoryChapterActions session={session} node={node} workspaceKey={key} /><StoryRouteManager session={session} node={node} workspaceKey={key} /></>}
        </> : <p className="chapter-tree-no-blueprint">{text('选择树上的章节，在这里编辑蓝图。', 'Select a chapter to edit its blueprint.')}</p>}
        {edge && <section className="chapter-tree-edge-editor" aria-label={text('连接设置', 'Link settings')}><h3>{text('章节连接', 'Chapter link')}</h3><p>{snapshot.nodes.find(item => item.id === edge.from)?.title} → {snapshot.nodes.find(item => item.id === edge.to)?.title}</p>{isMainlineStoryEdgeId(edge.id) ? <p>{text('主线顺序来自原始章号。插章会保留这条主线连接。', 'Mainline order follows original chapter numbers. Inserting keeps this link.')}</p> : <><label>{text('走向名称', 'Link label')}<input aria-label={text('走向名称', 'Link label')} value={edge.label} disabled={disabled} onChange={event => stageStoryOperations(key, [{ type: 'put-edge', edge: { ...edge, label: event.target.value } }])} /></label><label>{text('进入条件', 'Entry condition')}<textarea aria-label={text('进入条件', 'Entry condition')} value={edge.condition} disabled={disabled} onChange={event => stageStoryOperations(key, [{ type: 'put-edge', edge: { ...edge, condition: event.target.value } }])} /></label></>}</section>}
        {mergeSources.length > 0 && <section className="chapter-tree-edge-editor" aria-label={text('汇合章节', 'Merge chapters')}><h3>{text('选择汇合入口', 'Choose merge entrances')}</h3>{snapshot.nodes.filter(item => !item.mainline).map(item => <label key={item.id}><input type="checkbox" checked={mergeSources.includes(item.id)} onChange={event => setMergeSources(event.target.checked ? [...mergeSources, item.id] : mergeSources.filter(id => id !== item.id))} />{item.title}</label>)}<Button variant="primary" disabled={disabled || mergeSources.length < 2} onClick={() => { apply(planMerge(snapshot, mergeSources, text('两路汇合', 'Paths converge'))); setMergeSources([]) }}>{text('建立汇合', 'Create merge')}</Button><Button variant="text" onClick={() => setMergeSources([])}>{text('取消', 'Cancel')}</Button></section>}
      </div></ChapterTreeSplit>
    {deletion.dialog}
    {insertRequest && insertSource && !stale && !disabled && <InsertChapterDialog key={`${insertRequest.sessionKey}:${insertRequest.nodeId}`} canReconnect={insertRequest.canReconnect} nextTitle={insertRequest.nextTitle} onCancel={() => setInsertRequest(null)} onConfirm={placement => {
      if (!sameProjectSessionContext(latest.current.session, session) || insertRequest.sessionKey !== JSON.stringify(latest.current.session)
        || !sameProjectSessionContext(session, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
      setInsertRequest(null); void forkMainline(insertRequest.nodeId, placement, insertRequest.nextFingerprint)
    }} />}
    <DangerConfirm open={danger !== null} onOpenChange={open => { if (!open) setDanger(null) }} title={text('放弃分支修改？', 'Discard story edits?')} consequence={text('未保存的分支输入将被放弃。', 'Unsaved branch edits will be discarded.')} recoverability={text('已保存的历史版本仍保留。', 'Saved history remains available.')} confirmLabel={text('确认', 'Confirm')} cancelLabel={text('取消', 'Cancel')} onConfirm={() => { discardStoryWorkspace(key); setDanger(null) }} />
  </section>
}
