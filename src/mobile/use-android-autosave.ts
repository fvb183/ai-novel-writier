import { useEffect } from 'react'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../stores/editor-store'
import { countUnsavedEditorItemsForProject } from '../stores/editor-unsaved'
import { useProjectStore } from '../stores/project-store'
import { useLocaleStore } from '../stores/locale-store'
import { toast } from '../components/ui/Toast'

/** Background signals are best effort; dirty state is cleared only by a real save. */
export function useAndroidAutosave() {
  useEffect(() => {
    if (document.documentElement.dataset.platform !== 'android') return
    let saving: Promise<void> | null = null
    const save = () => {
      if (saving || useProjectStore.getState().loading) return
      const projectPath = useProjectStore.getState().currentProject?.path
      if (!projectPath) return
      const editor = useEditorStore.getState()
      if (!countUnsavedEditorItemsForProject(editor.tabs, editor.draftLedgers, projectPath)) return
      saving = saveDirtyEditorChangesForExit(projectPath, 'project')
        .catch(() => {
          const text = useLocaleStore.getState().text
          toast.error(text(
            '退到后台前的保存未完成。修改仍已保留，请回到编辑器保存。',
            'Background saving did not finish. Your edits were kept; return to the editor to save.',
          ))
        }).finally(() => { saving = null })
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') save() }
    window.addEventListener('android-background', save)
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('android-background', save)
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
