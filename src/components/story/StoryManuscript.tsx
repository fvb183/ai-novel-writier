import { useEffect } from 'react'
import { useLocaleStore } from '../../stores/locale-store'
import { registerEditorExitSaveHandler, type EditorTab } from '../../stores/editor-store'
import { resolveStoryNodeAlias } from '../../shared/story-branches'
import { isProjectSessionCurrent } from '../project-session-gate'
import { Button } from '../ui/Button'
import StoryChapterActions from './StoryChapterActions'
import { storyMessage } from './StoryBranches'
import { openStoryBlueprint, openStoryManuscript } from './story-manuscript-navigation'
import { affectedStoryRoutes, resolveStoryWorkspaceRouteId, saveStoryWorkspace, stageStoryOperations, updateStoryWorkspace } from './story-workspace'
import { useProjectStory } from './use-project-story'
import './story-manuscript.css'

/** Branch prose uses the same retained workspace as its blueprint, never a numbered mainline draft. */
export default function StoryManuscript({ tab }: { tab: EditorTab }) {
  const text = useLocaleStore(state => state.text)
  const { session, key, workspace, snapshot } = useProjectStory()
  const node = snapshot && (snapshot.nodes.find(item => item.id === tab.storyNodeId) ?? snapshot.nodes.find(item => item.id === resolveStoryNodeAlias(snapshot, tab.storyNodeId ?? '')))
  const routeId = snapshot && workspace ? resolveStoryWorkspaceRouteId(workspace, snapshot, node?.id ?? tab.storyNodeId ?? '', tab.storyRouteId ?? '') : ''
  const route = snapshot?.routes.find(item => item.id === routeId)
  const offset = node && route ? route.nodeIds.indexOf(node.id) : -1
  const current = Boolean(session && tab.projectKey === session.projectPath && tab.projectSessionLease === session.leaseId
    && isProjectSessionCurrent(session))
  useEffect(() => {
    if (current && node) updateStoryWorkspace(key, { selectedNodeId: node.id, selectedRouteId: routeId, context: null })
  }, [key, current, node?.id, routeId])
  useEffect(() => {
    if (!session || !current) return
    // Like the blueprint ledger, retained prose remains saveable after the tab
    // unmounts. The editor store removes this registration when the tab closes.
    registerEditorExitSaveHandler({ tabId: tab.id, type: 'chapter', projectKey: tab.projectKey, save: async () => {
      if (!isProjectSessionCurrent(session) || tab.projectSessionLease !== session.leaseId) throw new Error('STORY_SESSION_STALE')
      await saveStoryWorkspace(key, false)
    } })
  }, [key, current, session?.leaseId, tab.id, tab.projectKey, tab.projectSessionLease])
  if (!session || !workspace || !snapshot) return <p role="status">{text('正在读取分支正文…', 'Loading branch manuscript…')}</p>
  if (!node) return <p role="alert">{text('这份分支正文已不存在，请从路线中重新选择。', 'This branch manuscript no longer exists. Select another scene from its route.')}</p>
  const sharing = affectedStoryRoutes(workspace)
  const disabled = !current || workspace.busy || Boolean(node.mainline)
  const save = async () => {
    if (!current || workspace.busy) return
    try { await saveStoryWorkspace(key) }
    catch (error) { updateStoryWorkspace(key, { error: error instanceof Error ? error.message : String(error) }) }
  }
  const change = (body: string) => {
    if (disabled) return
    const { revisionId: _revisionId, mainline: _mainline, ...input } = node
    stageStoryOperations(key, [{ type: 'put-node', node: { ...input, body } }])
  }
  return <section className="story-manuscript" aria-label={text('分支正文', 'Branch manuscript')}>
    <header className="story-manuscript-head">
      <div><p className="story-eyebrow">{route?.title ?? text('独立剧情', 'Independent scene')}</p><h1>{node.title}</h1></div>
      <div className="story-toolbar">
        <Button variant="secondary" disabled={!current} onClick={() => openStoryBlueprint(session, node.id, route?.id ?? '')}>{text('章节蓝图', 'Chapter blueprint')}</Button>
        <Button variant="primary" disabled={disabled || !workspace.pending.length || workspace.reviewRequired || Boolean(sharing.length && !workspace.sharedEditConfirmed)} onClick={() => void save()}>{text('保存正文', 'Save manuscript')}</Button>
      </div>
    </header>
    {route && <nav className="story-manuscript-path" aria-label={text('当前正文路线', 'Current manuscript route')}>
      {route.nodeIds.map((id, index) => {
        const scene = snapshot.nodes.find(item => item.id === id)
        return <button key={id} type="button" aria-current={id === node.id ? 'step' : undefined} disabled={!current || !scene}
          onClick={() => openStoryManuscript(session, id, route.id)}>{index + 1}. {scene?.title ?? text('缺失章节', 'Missing chapter')}</button>
      })}
    </nav>}
    <div className="story-manuscript-status" role="status">{workspace.pending.length ? text('有未保存修改，切换章节后仍保留', 'Unsaved changes are retained when switching chapters') : text('已保存', 'Saved')}</div>
    {!current && <p role="alert">{text('项目会话已变化，请从当前项目的路线重新打开。', 'The project session changed. Reopen this scene from the current project.')}</p>}
    {workspace.error && <p className="story-error" role="alert">{storyMessage(workspace.error, text)}</p>}
    {workspace.reviewRequired && <label className="story-check"><input type="checkbox" onChange={event => { if (event.target.checked) updateStoryWorkspace(key, { reviewRequired: false }) }} />{text('我已核对重新读取的版本和保留输入', 'I compared the reloaded version and retained input')}</label>}
    {sharing.length > 0 && <div className="story-shared-warning"><p>{text(`共用正文影响路线：${sharing.join('、')}`, `Shared manuscript affects: ${sharing.join(', ')}`)}</p><label className="story-check"><input type="checkbox" checked={workspace.sharedEditConfirmed} disabled={disabled} onChange={event => updateStoryWorkspace(key, { sharedEditConfirmed: event.target.checked })} />{text('确认修改共用内容', 'Confirm editing shared content')}</label></div>}
    {current && !node.mainline && <StoryChapterActions session={session} node={node} workspaceKey={key} />}
    {current && node.mainline && <Button variant="secondary" onClick={() => openStoryManuscript(session, node.id, route?.id ?? '')}>{text('打开主线正文', 'Open mainline manuscript')}</Button>}
    <textarea className="story-manuscript-prose" aria-label={text('分支正文内容', 'Branch manuscript content')} value={node.body} readOnly={disabled}
      placeholder={text('在这里独立编写本条路线的正文，或按章节蓝图生成。', 'Write this route’s manuscript here, or generate it from its blueprint.')}
      onChange={event => change(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() } }} />
    {route && offset >= 0 && <footer className="story-manuscript-foot">
      <Button variant="text" disabled={!current || offset === 0} onClick={() => openStoryManuscript(session, route.nodeIds[offset - 1], route.id)}>{text('上一章', 'Previous chapter')}</Button>
      <span>{text('正文随当前路线衔接', 'Manuscript follows this route')}</span>
      <Button variant="text" disabled={!current || offset === route.nodeIds.length - 1} onClick={() => openStoryManuscript(session, route.nodeIds[offset + 1], route.id)}>{text('下一章', 'Next chapter')}</Button>
    </footer>}
  </section>
}
