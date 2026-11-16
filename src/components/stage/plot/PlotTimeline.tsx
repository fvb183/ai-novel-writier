import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Eye, GitBranch, MoreHorizontal, RefreshCw } from 'lucide-react'
import type { PlotTreeEvent, PlotTreeSourceReference, PlotTreeTrack } from '../../../shared/plot-tree'
import { hasUsablePlotTreeEventSource } from '../../../shared/plot-tree'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { Menu } from '../../ui/Menu'
import { Notice } from '../../ui/Notice'
import { chapterWindow, plotChapters } from './plot-shape'
import type { PlotThreads } from './StagePlot'

type Text = (zh: string, en: string) => string

const WINDOW = 6

function sourceLabel(source: PlotTreeSourceReference, text: Text): string {
  if (source.type === 'blueprint') return text(`第 ${source.chapterNumber} 章蓝图`, `Chapter ${source.chapterNumber} blueprint`)
  if (source.type === 'finalized-chapter') return text(`第 ${source.chapterNumber} 章定稿`, `Chapter ${source.chapterNumber} final`)
  return text('伏笔线索计划', 'Thread plan')
}

interface Selection {
  track: PlotTreeTrack
  event: PlotTreeEvent
}

/**
 * 剧情梳理：按剧情线回看计划与已定稿事实，一页 6 章。它不编辑章节结构。
 */
export default function PlotTimeline({ plot, onShowRecords, onClear }: { plot: PlotThreads; onShowRecords: () => void; onClear: () => void }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [requestedStart, setRequestedStart] = useState<number | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const sources = plot.plotSources
  const snapshot = sources?.snapshot ?? null
  const finalized = useMemo(() => new Set(sources?.finalizedChapters.map(chapter => chapter.chapterNumber) ?? []), [sources])
  const titles = useMemo(() => new Map(sources?.blueprints.map(blueprint => [blueprint.chapterNumber, blueprint.title]) ?? []), [sources])
  const currentChapter = Math.max(1, ...finalized)
  const all = useMemo(() => plotChapters(snapshot, currentChapter), [snapshot, currentChapter])
  const { start, maximum, visible } = chapterWindow(all, currentChapter, WINDOW, requestedStart)
  const sourceReady = Boolean(sources && hasUsablePlotTreeEventSource(sources))
  const busy = plot.plotBusy || plot.aiBusy
  const stale = Boolean(snapshot && sources && snapshot.sourceRevision !== sources.sourceRevision)
  const error = plot.plotError || plot.plotModelSelectionError
  const generate = () => void plot.refreshPlotTree()

  const generateButton = (
    <Button variant="primary" disabled={busy || !plot.selectedPlotModel || !sourceReady} onClick={generate}>
      {busy ? <RefreshCw size={14} className="stage-plot-spin" aria-hidden="true" /> : snapshot ? <RefreshCw size={14} aria-hidden="true" /> : <GitBranch size={14} aria-hidden="true" />}
      {busy ? text('整理中…', 'Building…') : snapshot ? text('重新整理剧情', 'Refresh plot overview') : text('整理剧情', 'Build plot overview')}
    </Button>
  )

  return (
    <>
      <p className="stage-plot-note">
        <Eye size={14} aria-hidden="true" />
        <span>{text(
          '按剧情线回看故事的只读梳理：实点来自定稿，虚点来自蓝图计划。它不修改章节连接；章节与分支统一在章节蓝图中编辑。',
          'A read-only overview by plot thread: solid events come from finals; hollow events are blueprint plans. Edit chapter structure and branches in Chapter blueprint.',
        )}</span>
      </p>

      <div className="stage-plot-tools">
        {snapshot && all.length > WINDOW && (
          <div className="stage-plot-pager" role="group" aria-label={text('章节分页', 'Chapter pages')}>
            <Button variant="icon" size="sm" aria-label={text('上一组章节', 'Previous chapters')} disabled={start === 0} onClick={() => setRequestedStart(Math.max(0, start - WINDOW))}>
              <ChevronLeft size={14} aria-hidden="true" />
            </Button>
            <span className="stage-plot-range">{text(`第 ${visible[0]}–${visible.at(-1)} 章`, `Ch. ${visible[0]}–${visible.at(-1)}`)}</span>
            <Button variant="icon" size="sm" aria-label={text('下一组章节', 'Next chapters')} disabled={start >= maximum} onClick={() => setRequestedStart(Math.min(maximum, start + WINDOW))}>
              <ChevronRight size={14} aria-hidden="true" />
            </Button>
          </div>
        )}
        {snapshot && (
          <div className="stage-plot-legend" aria-hidden="true">
            <span><i data-state="occurred" />{text('已定稿发生', 'Happened in a final')}</span>
            <span><i data-state="planned" />{text('蓝图计划', 'Planned in the blueprint')}</span>
          </div>
        )}
        <div className="stage-plot-actions">
          {snapshot && (
            <span className="stage-plot-stamp">
              {text(`${new Date(snapshot.generatedAt).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 整理`, `Built ${new Date(snapshot.generatedAt).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`)}
              {stale && text(' · 之后资料有更新', ' · sources changed since')}
            </span>
          )}
          <select
            className="pi-input stage-plot-model"
            aria-label={text('本次整理用的模型', 'Model for this build')}
            value={plot.selectedPlotModel?.id ?? ''}
            disabled={busy || plot.generationModels.length === 0}
            onChange={event => plot.setPlotModelId(event.target.value)}
          >
            <option value="" disabled>{text('选择模型', 'Choose a model')}</option>
            {plot.generationModels.map(model => <option key={model.id} value={model.id}>{model.name || model.modelName}</option>)}
          </select>
          {snapshot && generateButton}
          <Menu
            label={text('剧情梳理的更多操作', 'More plot overview actions')}
            icon={<MoreHorizontal size={16} aria-hidden="true" />}
            align="end"
            groups={[
              { id: 'records', items: [{ id: 'records', label: text('查看整理记录', 'View build records'), onSelect: onShowRecords }] },
              ...(snapshot ? [{ id: 'danger', tone: 'danger' as const, items: [{ id: 'clear', label: text('清除梳理快照…', 'Clear plot overview…'), onSelect: onClear, disabled: busy }] }] : []),
            ]}
          />
        </div>
      </div>

      {error && <Notice tone="danger" title={error} />}
      {sources?.storedSnapshotInvalid && (
        <Notice tone="warn" title={text('旧剧情梳理无法安全显示，已隔离', 'The stored plot overview could not be shown safely')}>
          {text('你的资料没有被修改，请重新生成。', 'Your sources were not changed. Build it again.')}
        </Notice>
      )}

      {!snapshot ? (
        <EmptyState
          icon={<GitBranch />}
          heading={text('还没有剧情梳理', 'No plot overview yet')}
          description={sourceReady
            ? text('整理一次，就能按章回看主线与支线的走向。', 'Build it once to look back at the main plot and subplots chapter by chapter.')
            : text('先在蓝图里规划章节，或定稿一章、建一条伏笔线索，再来整理剧情。', 'Plan chapters in the blueprint, finalize a chapter or add a thread first.')}
          action={generateButton}
        />
      ) : (
        <div className="stage-plot-grid-wrap">
          <table className="stage-plot-grid" aria-label={text('剧情梳理', 'Plot overview')}>
            <thead>
              <tr>
                <th scope="col" className="stage-plot-corner">{text('轨道', 'Track')}</th>
                {visible.map(chapter => (
                  <th key={chapter} scope="col" className="stage-plot-chapter" data-final={finalized.has(chapter) || undefined}>
                    {text('第 ', 'Chapter ')}<span className="stage-plot-chapter-no">{chapter}</span>{text(' 章', '')}
                    <b>{titles.get(chapter) ?? ''}{finalized.has(chapter) && <small>{text(' · 已定稿', ' · final')}</small>}</b>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshot.tracks.map(track => (
                <tr key={track.id} data-role={track.role}>
                  <th scope="row" className="stage-plot-lane">
                    <b>{track.role === 'main' ? text('主线', 'Main plot') : text('支线', 'Subplot')}</b>
                    <span>{track.title}</span>
                  </th>
                  {visible.map(chapter => (
                    <td key={chapter} className="stage-plot-cell" data-inside={chapter >= track.startChapter && chapter <= track.endChapter || undefined}>
                      {track.events.filter(event => event.chapterNumber === chapter).map((event, index) => (
                        <button
                          key={`${chapter}:${index}`}
                          type="button"
                          className="stage-plot-event"
                          data-state={event.status}
                          aria-pressed={selection?.event === event}
                          onClick={() => setSelection({ track, event })}
                        >
                          <span className="stage-plot-node" aria-hidden="true" />
                          {event.summary}
                        </button>
                      ))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {snapshot && selection && (
        <section className="stage-plot-detail" aria-label={text('事件详情', 'Event details')}>
          <div>
            <div className="stage-plot-meta">
              {selection.track.role === 'main' ? text('主线', 'Main plot') : text('支线', 'Subplot')} · {text(`第 ${selection.event.chapterNumber} 章`, `Chapter ${selection.event.chapterNumber}`)} · {selection.event.status === 'occurred' ? text('已定稿发生', 'Happened in a final') : text('蓝图计划', 'Planned in the blueprint')}
            </div>
            <h3>{selection.event.summary}</h3>
          </div>
          <div className="stage-plot-sources">
            {selection.event.sources.map((source, index) => (
              <Button key={`${source.type}:${index}`} variant="secondary" size="sm" onClick={() => plot.openPlotSource(source)}>
                <ExternalLink size={13} aria-hidden="true" />{text(`打开来源：${sourceLabel(source, text)}`, `Open source: ${sourceLabel(source, text)}`)}
              </Button>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
