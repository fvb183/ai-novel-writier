import { useEffect, useRef, useState } from 'react'
import { GitBranch, ListPlus } from 'lucide-react'
import { ipc } from '../../services/ipc-client'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { openStoryBlueprint } from './story-manuscript-navigation'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { isProjectSessionCurrent } from '../project-session-gate'
import { Button } from '../ui/Button'
import { ensureStoryWorkspace, getStoryWorkspace, updateStoryWorkspace } from './story-workspace'
import './story-branches.css'
import InsertChapterDialog, { insertChapterFingerprint, nextInsertChapter } from './InsertChapterDialog'

/** The source chapter must be persisted before main freezes its branch ancestry. */
export default function StoryChapterEntry({ chapterNumber, projectKey, onSaveSource, disabled }: {
  chapterNumber: number
  projectKey: string
  onSaveSource: () => Promise<boolean>
  disabled: boolean
}) {
  const text = useLocaleStore(state => state.text)
  const project = useProjectStore(state => state.currentProject)
  const session = projectSessionContextFromProject(project)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [insertRequest, setInsertRequest] = useState<{ sessionKey: string; chapterNumber: number; nextFingerprint: string; canReconnect: boolean; nextTitle?: string } | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const latest = useRef({ chapterNumber, projectKey, session })
  latest.current = { chapterNumber, projectKey, session }
  const requestInsert = async () => {
    if (busy || disabled || !session || session.projectPath !== projectKey) return
    const captured = { ...session }, sourceChapter = chapterNumber
    const current = () => mounted.current && latest.current.chapterNumber === sourceChapter && latest.current.projectKey === projectKey
      && sameProjectSessionContext(latest.current.session, captured) && isProjectSessionCurrent(captured)
    setBusy(true); setError('')
    try {
      const read = await ipc.invokeWithProjectSession(captured, 'story:read', {})
      if (!current()) return
      if (!read.success) throw new Error(read.error)
      const next = nextInsertChapter(read.data, sourceChapter)
      setInsertRequest({ sessionKey: JSON.stringify(captured), chapterNumber: sourceChapter,
        nextFingerprint: insertChapterFingerprint(next), canReconnect: Boolean(next && next.mainline?.manuscriptStatus !== 'unavailable'), nextTitle: next?.title })
    } catch { if (current()) setError(text('无法读取后文章节，请刷新章节树后重试。', 'Unable to read later chapters. Refresh the chapter tree and retry.')) }
    finally { if (mounted.current) setBusy(false) }
  }
  const start = async (placement: 'branch' | 'insert', expectedNext?: string) => {
    if (busy || disabled || !session || session.projectPath !== projectKey) return
    const captured = { chapterNumber, projectKey, session }
    const current = () => mounted.current && latest.current.chapterNumber === captured.chapterNumber
      && latest.current.projectKey === captured.projectKey
      && sameProjectSessionContext(latest.current.session, captured.session) && isProjectSessionCurrent(captured.session)
    setBusy(true); setError('')
    try {
      const key = ensureStoryWorkspace(session)
      if (getStoryWorkspace(key)?.pending.length || getStoryWorkspace(key)?.busy) throw new Error('STORY_UNSAVED_INPUT')
      if (!await onSaveSource()) throw new Error('STORY_SOURCE_NOT_SAVED')
      if (!current()) return
      const read = await ipc.invokeWithProjectSession(session, 'story:read', {})
      if (!read.success) throw new Error(read.error)
      if (!current()) return
      if (placement === 'insert' && expectedNext !== insertChapterFingerprint(nextInsertChapter(read.data, chapterNumber))) throw new Error('STORY_INSERT_TARGET_CHANGED')
      // Do not replace a tree draft that appeared while the source was saving.
      if (getStoryWorkspace(key)?.pending.length || getStoryWorkspace(key)?.busy) throw new Error('STORY_UNSAVED_INPUT')
      const result = await ipc.invokeWithProjectSession(session, 'story:fork-chapter', {
        expectedRevision: read.data.revision, afterChapter: chapterNumber, placement,
        title: placement === 'insert' ? text(`第 ${chapterNumber} 章后的插章`, `Interlude after chapter ${chapterNumber}`)
          : text(`第 ${chapterNumber} 章后的分支`, `Branch after chapter ${chapterNumber}`),
      })
      if (!result.success) throw new Error(result.error)
      if (!current()) return
      const workspace = getStoryWorkspace(key)
      if (workspace?.pending.length || workspace?.busy) throw new Error('STORY_RELOAD_REQUIRED')
      const route = result.data.snapshot.routes.find(route => route.id === result.data.routeId)
      const offset = route?.nodeIds.indexOf(result.data.nodeId) ?? -1
      const bridge = placement === 'insert' && offset >= 0 ? route?.nodeIds[offset + 1] ?? '' : ''
      updateStoryWorkspace(key, { session, snapshot: result.data.snapshot, selectedNodeId: result.data.nodeId,
        selectedRouteId: result.data.routeId, selectedEdgeId: '', mode: 'route', context: null,
        bridgeToNodeId: bridge,
        continuationSelections: { ...workspace?.continuationSelections, [`route:${result.data.routeId}:${result.data.nodeId}`]: bridge },
        error: '', notice: text('分支章节已连接到父章。先编写独立蓝图，再按蓝图生成正文。', 'The branch chapter is linked to its parent. Plan its blueprint, then generate its manuscript.') })
      openStoryBlueprint(session, result.data.nodeId, result.data.routeId)
    } catch (failure) {
      if (!current()) return
      const code = failure instanceof Error ? failure.message : String(failure)
      const messages: Record<string, [string, string]> = {
        STORY_UNSAVED_INPUT: ['章节树还有未保存修改，请先到章节蓝图保存或放弃后再创建。', 'The chapter tree has pending edits. Save or discard them in Chapter blueprint first.'],
        STORY_SOURCE_NOT_SAVED: ['当前蓝图尚未完整保存，已停止创建分支。请保存后重试。', 'The source blueprint was not fully saved. Save it and retry.'],
        STORY_CHAPTER_NEXT_REQUIRED: ['这一章之后还没有章节蓝图。可以选择“从本章分支”展开新剧情。', 'There is no next chapter blueprint. Choose Branch from this chapter to start a new path.'],
        STORY_CHAPTER_NOT_FOUND: ['当前章节蓝图不存在，请重新读取后重试。', 'The source chapter blueprint no longer exists. Reload and retry.'],
        STORY_REVISION_STALE: ['剧情树已变化，尚未创建分支，请重试。', 'The story tree changed. No branch was created; retry.'],
        STORY_RELOAD_REQUIRED: ['分支已建立；当前树稿已保留，请到章节蓝图重新读取并核对。', 'The branch was created and your current tree edits are retained. Reload and compare in Chapter blueprint.'],
        STORY_INSERT_TARGET_CHANGED: ['接回目标已变化，请重新选择插章走向。', 'The reconnect target changed. Choose the inserted chapter direction again.'],
      }
      setError(messages[code] ? text(...messages[code]) : text('创建分支章节失败，请保存蓝图并核对项目后重试。', 'Could not create the branch chapter. Save the blueprint, check the project and retry.'))
    } finally { setBusy(false) }
  }
  return <section className="story-chapter-entry" aria-label={text('章节剧情分支', 'Chapter story branches')} aria-busy={busy}>
    <div><strong><GitBranch size={16} aria-hidden />{text(`从第 ${chapterNumber} 章展开剧情`, `Expand from chapter ${chapterNumber}`)}</strong><p>{text('从本章分支独立续写；两章间插入时先选择接回下一章或独立延伸。', 'Start an independent branch, or choose whether an inserted chapter reconnects to the next one.')}</p></div>
    <div className="story-toolbar"><Button variant="secondary" disabled={disabled || busy} onClick={() => void start('branch')}><GitBranch size={14} aria-hidden />{text('从本章分支', 'Branch from this chapter')}</Button><Button variant="secondary" disabled={disabled || busy} onClick={() => void requestInsert()}><ListPlus size={14} aria-hidden />{text('在两章间插入', 'Insert between chapters')}</Button></div>
    {error && <p role="alert" className="story-error">{error}</p>}
    {insertRequest && insertRequest.sessionKey === JSON.stringify(session) && insertRequest.chapterNumber === chapterNumber && !disabled && !busy
      && session && isProjectSessionCurrent(session) && <InsertChapterDialog canReconnect={insertRequest.canReconnect} nextTitle={insertRequest.nextTitle} onCancel={() => setInsertRequest(null)} onConfirm={placement => {
        if (insertRequest.sessionKey !== JSON.stringify(latest.current.session) || latest.current.chapterNumber !== insertRequest.chapterNumber || !isProjectSessionCurrent(session)) return
        setInsertRequest(null); void start(placement, insertRequest.nextFingerprint)
      }} />}
  </section>
}
