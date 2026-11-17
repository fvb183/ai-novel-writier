import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { actionToast } from '../ui/ActionToast'

/** 完成提示只属于当前打开的作品；运行历史和仍需处理的恢复内容不在这里修改。 */
export function installWorkflowCompletionScope(): () => void {
  const unsubscribe = useProjectStore.subscribe((state, previous) => {
    if (!sameProjectSessionContext(
      projectSessionContextFromProject(state.currentProject),
      projectSessionContextFromProject(previous.currentProject),
    )) actionToast.clearWorkflowComplete()
  })
  return () => { unsubscribe(); actionToast.clearWorkflowComplete() }
}
