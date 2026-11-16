import { useCallback, useEffect, useState } from 'react'
import { GitBranch, X } from 'lucide-react'
import { canExecuteGraph } from '../../../services/graph-generation'
import type { NarrativeThreadView } from '../../../shared/narrative-thread'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { projectSessionContextFromProject } from '../../../shared/project-session-context'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { SegmentedControl } from '../../ui/SegmentedControl'
import PlotThreads from './PlotThreads'
import PlotTimeline from './PlotTimeline'
import { openStoryBlueprint } from '../../story/story-manuscript-navigation'
import { ensureStoryWorkspace, getStoryWorkspace } from '../../story/story-workspace'
import { usePlotThreads } from './use-plot-threads'
import { pluralEn } from '../../../shared/plural-en'

export type PlotThreads = ReturnType<typeof usePlotThreads>

type View = 'plot-tree' | 'plans' | 'branches'

const OPERATION_NAMES: Record<string, [string, string]> = {
  'plot-tree-snapshot': ['剧情梳理', 'Plot overview'],
  'narrative-thread-plan-candidate': ['伏笔建议', 'Thread suggestions'],
  'narrative-thread-event-candidate': ['定稿事件', 'Final events'],
}

/** 整理记录：剧情梳理与 AI 候选可恢复、继续、取消或保存原结果。 */
function GenerationRecords({ plot, onClose }: { plot: PlotThreads; onClose?: () => void }) {
  const text = useLocaleStore(s => s.text)
  const recovery = plot.graphRecovery
  const busy = plot.plotBusy || plot.aiBusy
  return (
    <section className="stage-plot-records" aria-label={text('整理记录', 'Build records')}>
      <header className="stage-plot-records-head">
        <h2 className="stage-plot-h2">{text('整理记录', 'Build records')}</h2>
        <Button variant="text" size="sm" onClick={() => void plot.loadGraphRuns()}>{text('刷新记录', 'Refresh records')}</Button>
        {busy && <Button variant="text" size="sm" onClick={() => void plot.cancelGraph()}>{text('取消当前生成', 'Cancel current build')}</Button>}
        <span className="stage-plot-gap" />
        {onClose && <Button variant="icon" size="sm" aria-label={text('收起整理记录', 'Hide build records')} onClick={onClose}><X size={14} aria-hidden="true" /></Button>}
      </header>
      {plot.graphRuns.length === 0
        ? <p className="stage-plot-help">{text('还没有生成记录。', 'No build records yet.')}</p>
        : (
          <ul className="stage-plot-runs">
            {plot.graphRuns.map(run => (
              <li key={run.handle.runId}>
                <Button variant="text" size="sm" disabled={busy} onClick={() => void plot.restoreGraph(run)}>
                  {text('恢复原生成', 'Recover')} · {text(...(OPERATION_NAMES[run.operation ?? ''] ?? OPERATION_NAMES['narrative-thread-event-candidate']))} · {run.handle.runId}
                </Button>
              </li>
            ))}
          </ul>
        )}
      {plot.graphError && <p role="alert" className="stage-plot-error">{plot.graphError}</p>}
      {recovery && (
        <div className="stage-plot-recovery">
          {busy && <p role="status">{text('正在生成，请等待本次结果', 'Generation is in progress. Please wait for the result.')}</p>}
          {!busy && recovery.result?.kind === 'plot' && (recovery.effects.length > 0
            ? <p role="status">{text('生成结果已保存', 'The generated result has been saved.')}</p>
            : recovery.sourceStatus === 'current' && recovery.view.status !== 'cancelled' && <p role="status">{text('生成已完成，结果尚未保存。请确认后保存', 'Generation is complete. Confirm and save the result.')}</p>)}
          <p className="stage-plot-help">{text('原模型', 'Original model')}：{recovery.modelId} · {text('已确认', 'Confirmed')}：{recovery.effects.length}</p>
          {recovery.sourceStatus === 'conflict' && <p role="status">{text('来源已变化，仅可查看和复制。', 'Sources changed. Viewing and copying remain available.')}</p>}
          <div className="stage-plot-recovery-actions">
            <Button variant="secondary" size="sm" onClick={() => void plot.copyOriginalResult()}>{text('复制原结果', 'Copy original result')}</Button>
            <Button variant="secondary" size="sm" disabled={busy || !canExecuteGraph(recovery)} onClick={() => void plot.continueGraph()}>{text('继续原运行', 'Continue original run')}</Button>
            <Button variant="secondary" size="sm" onClick={plot.cancelOriginalRun}>{text('取消原运行', 'Cancel original run')}</Button>
            {recovery.result?.kind === 'plot' && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || recovery.sourceStatus !== 'current' || recovery.view.status === 'cancelled' || recovery.effects.length > 0}
                onClick={plot.saveOriginalPlotTree}
              >
                {text('保存原梳理结果', 'Save original overview')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

interface StagePlotProps {
  projectKey: string
  initialView: View
  viewRequest?: number
}

/**
 * 伏笔计划与只读剧情梳理。章节结构和分支只在蓝图编辑，旧分支链接仍能回到同一章节。
 */
export default function StagePlot({ projectKey, initialView, viewRequest }: StagePlotProps) {
  const text = useLocaleStore(s => s.text)
  const plot = usePlotThreads(projectKey, { initialView: initialView === 'branches' ? 'plans' : initialView, viewRequest })
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [deleting, setDeleting] = useState<NarrativeThreadView | null>(null)
  const [clearingOverview, setClearingOverview] = useState(false)
  const openBlueprint = useCallback(() => {
    const session = projectSessionContextFromProject(useProjectStore.getState().currentProject)
    if (!session || session.projectPath !== projectKey) return
    const workspace = getStoryWorkspace(ensureStoryWorkspace(session))
    openStoryBlueprint(session, workspace?.selectedNodeId ?? '', workspace?.selectedRouteId ?? '')
  }, [projectKey])
  useEffect(() => { if (initialView === 'branches') openBlueprint() }, [initialView, openBlueprint, viewRequest])
  const confirmedEvents = deleting?.events.length ?? 0
  // 整理进行中或结果尚未保存时自动保留运行记录，方便继续、取消或核对。
  const pinnedRecords = plot.plotBusy || plot.aiBusy || (plot.graphRecovery?.result?.kind === 'plot' && plot.graphRecovery.effects.length === 0)

  return (
    <div className="stage-plot-frame">
      <div className="stage-plot">
        <header className="stage-plot-head">
          <div>
            <div className="stage-plot-eyebrow">{text('作品资料', 'Reference')}</div>
            <h1 className="stage-plot-title">{text('剧情与伏笔', 'Plot & threads')}</h1>
          </div>
          <div className="stage-plot-navigation">
            <Button variant="secondary" size="sm" onClick={openBlueprint}><GitBranch size={14} aria-hidden />{text('前往章节蓝图', 'Open chapter blueprint')}</Button>
            <SegmentedControl<'plot-tree' | 'plans'>
              label={text('剧情与伏笔的视图', 'Plot views')}
              value={plot.view}
              onChange={plot.setView}
              options={[
                { value: 'plans', label: text('伏笔线索', 'Threads') },
                { value: 'plot-tree', label: text('剧情梳理', 'Plot overview') },
              ]}
            />
          </div>
        </header>

        {(recordsOpen || pinnedRecords) && <GenerationRecords plot={plot} onClose={pinnedRecords ? undefined : () => setRecordsOpen(false)} />}

        {plot.view === 'plot-tree'
          ? <PlotTimeline plot={plot} onShowRecords={() => setRecordsOpen(true)} onClear={() => setClearingOverview(true)} />
          : <PlotThreads plot={plot} onDelete={setDeleting} />}
        {!recordsOpen && !pinnedRecords && <Button variant="text" size="sm" onClick={() => setRecordsOpen(true)}>{text('整理记录', 'Build records')}</Button>}

        <DangerConfirm open={clearingOverview} onOpenChange={setClearingOverview}
          title={text('清除剧情梳理快照？', 'Clear the plot overview?')}
          consequence={text('只清除这份只读梳理结果，章节蓝图、正文、分支和伏笔计划都保留。', 'Only this read-only overview is cleared. Blueprints, manuscripts, branches and thread plans are retained.')}
          recoverability={text('之后可以根据原资料重新整理。', 'You can build another overview from the original sources.')}
          confirmLabel={text('清除快照', 'Clear overview')} cancelLabel={text('取消', 'Cancel')} onConfirm={() => void plot.clearPlotTree()} />

        <DangerConfirm
          open={deleting !== null}
          onOpenChange={open => { if (!open) setDeleting(null) }}
          title={text('删除这条线索？', 'Delete this thread?')}
          consequence={text(
            `会删除线索「${deleting?.title ?? ''}」和它已确认的 ${confirmedEvents} 个定稿事件。写作时不再提醒它。`,
            `The thread “${deleting?.title ?? ''}” and its ${confirmedEvents} confirmed ${pluralEn(confirmedEvents, 'event')} are removed. Writing will no longer keep it in mind.`,
          )}
          recoverability={text('删除后无法恢复，只能重新建这条线索。', 'This cannot be undone. You would have to create the thread again.')}
          confirmLabel={text('删除线索', 'Delete thread')}
          cancelLabel={text('取消', 'Cancel')}
          onConfirm={() => { if (deleting) void plot.deletePlan(deleting.id) }}
        />
      </div>
    </div>
  )
}
