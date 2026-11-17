import { useLayoutEffect } from 'react'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { actionToast } from './ActionToast'

/** 指导窗口实际显示期间清掉旧完成提示并抑制新浮层；关闭或卸载时释放，不修改运行记录。 */
export function useWorkflowCompletionSilence(open: boolean) {
  const session = projectSessionContextFromProject(useProjectStore(s => s.currentProject))
  useLayoutEffect(() => {
    if (open) return actionToast.silenceWorkflowComplete()
  }, [open, session?.projectId, session?.projectPath, session?.leaseId])
}
