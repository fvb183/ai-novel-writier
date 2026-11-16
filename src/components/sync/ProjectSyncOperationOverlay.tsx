import { createPortal } from 'react-dom'
import { useProjectSyncOperation } from '../../stores/project-sync-operation'
import { useLocaleStore } from '../../stores/locale-store'
import './project-sync.css'
import { useInkOverlayHost } from '../ui/ink-overlay'

export default function ProjectSyncOperationOverlay() {
  const phase = useProjectSyncOperation(state => state.phase)
  const text = useLocaleStore(state => state.text)
  const host = useInkOverlayHost()
  if (!phase || !host) return null
  const labels = {
    saving: ['正在保存当前输入…', 'Saving current input…'],
    checking: ['正在重新核对同步预览…', 'Checking the sync preview…'],
    applying: ['正在应用同步…', 'Applying sync…'],
    reopening: ['正在重新打开项目…', 'Reopening the project…'],
  } as const
  return createPortal(<div className="sync-operation-overlay" role="dialog" aria-modal="true" aria-label={text('正在处理同步', 'Sync in progress')}>
    <div role="status"><strong>{text(labels[phase][0], labels[phase][1])}</strong><p>{text('编辑暂时锁定，当前输入将受到保护。', 'Editing is temporarily locked to protect current input.')}</p></div>
  </div>, host)
}
