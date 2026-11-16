import { useState } from 'react'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import type { StoryNode, StorySnapshot } from '../../shared/story-branches'
import { isMainlineStoryNodeId } from '../../shared/story-branches'
import './story-insert-dialog.css'

export function nextInsertChapter(snapshot: StorySnapshot, afterChapter: number) {
  return snapshot.nodes.filter(node => isMainlineStoryNodeId(node.id) && node.mainline?.manuscriptStatus !== 'missing'
    && (node.mainline?.chapterNumber ?? node.chapterNumber ?? 0) > afterChapter)
    .sort((left, right) => (left.mainline?.chapterNumber ?? left.chapterNumber ?? 0) - (right.mainline?.chapterNumber ?? right.chapterNumber ?? 0))[0]
}
/** The displayed next source, independent of a source chapter's own save revision. */
export function insertChapterFingerprint(node: StoryNode | undefined): string {
  const blueprint = node?.chapterBlueprint, source = node?.chapterSource, live = node?.mainline
  return JSON.stringify(node ? [node.id, node.revisionId, node.chapterNumber, node.title, node.body, node.event,
    blueprint ? [blueprint.title, blueprint.role, blueprint.purpose, blueprint.keyEvents, blueprint.characters, blueprint.suspenseHook, blueprint.userGuidance, blueprint.notes] : null,
    source ? [source.chapterNumber, source.blueprintHash, source.manuscriptHash] : null,
    live ? [live.chapterNumber, live.manuscriptStatus, live.hasBlueprint, live.hasManuscript ?? Boolean(node.body.trim())] : null,
  ] : null)
}

/** Choose structure before saving the source or creating any independent chapter. */
export default function InsertChapterDialog({ canReconnect, nextTitle, onCancel, onConfirm }: {
  canReconnect: boolean; nextTitle?: string; onCancel(): void; onConfirm(placement: 'insert' | 'branch'): void
}) {
  const text = useLocaleStore(state => state.text)
  const [choice, setChoice] = useState<'insert' | 'branch' | null>(null)
  const placement = canReconnect && choice !== 'branch' ? 'insert' : 'branch'
  return <Dialog open onOpenChange={open => { if (!open) onCancel() }}>
    <DialogContent className="story-insert-dialog">
      <DialogHeader><DialogTitle>{text('插入独立章节', 'Insert an independent chapter')}</DialogTitle>
        <DialogDescription>{text('先选择支线路线是否接回。原主线章号、蓝图和正文保持原样。', 'Choose whether this route reconnects. Existing mainline numbers, blueprints and manuscripts are preserved.')}</DialogDescription></DialogHeader>
      <div className="pi-dialog-body"><fieldset className="story-insert-options"><legend>{text('插章后的走向', 'After the inserted chapter')}</legend>
        <label><input type="radio" name="insert-continuation" checked={placement === 'insert'} disabled={!canReconnect} onChange={() => setChoice('insert')} />
          <span>{text('接回下一章（生成同时参考前后文）', 'Reconnect to the next chapter (generate using both ends)')}{nextTitle && <small>{nextTitle}</small>}</span></label>
        <label><input type="radio" name="insert-continuation" checked={placement === 'branch'} onChange={() => setChoice('branch')} />
          <span>{text('暂不接回（独立延伸，只参考前文）', 'Continue independently (use earlier text only)')}<small>{text('以后可在章节树手动连接后文，再生成或审查衔接。', 'Later, link another chapter on the tree, then generate or review continuity.')}</small></span></label>
      </fieldset>{!canReconnect && <p className="story-help">{nextTitle
        ? text('下一章来源暂时不可用，当前只能独立延伸。恢复来源后可再手动接回。', 'The next chapter source is unavailable. Continue independently and reconnect after restoring its source.')
        : text('后面还没有章节，当前将建立独立支线。', 'There is no later chapter yet, so this creates an independent route.')}</p>}</div>
      <DialogFooter><Button variant="secondary" onClick={onCancel}>{text('取消', 'Cancel')}</Button><Button variant="primary" onClick={() => onConfirm(placement)}>{text('创建插章', 'Create chapter')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
