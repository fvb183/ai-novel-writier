import { useEffect, useMemo } from 'react'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { ensureStoryWorkspace, loadStoryWorkspace, storyPreview, useStoryWorkspaces } from './story-workspace'

/** A lease-scoped read. Mounting the sidebar or manuscript never creates story records. */
export function useProjectStory() {
  const project = useProjectStore(state => state.currentProject)
  const session = useMemo(() => projectSessionContextFromProject(project), [project])
  const key = session ? ensureStoryWorkspace(session) : ''
  const workspace = useStoryWorkspaces(state => state.entries[key])
  useEffect(() => {
    if (session && key && !workspace?.snapshot && !workspace?.busy) void loadStoryWorkspace(key, session)
  }, [key, session?.leaseId])
  const snapshot = useMemo(() => workspace ? storyPreview(workspace) : null, [workspace])
  return { session, key, workspace, snapshot }
}
