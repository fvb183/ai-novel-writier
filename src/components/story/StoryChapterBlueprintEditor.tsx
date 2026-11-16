import { useEffect, useRef, useState } from 'react'
import { BookOpen, ScanText, Sparkles } from 'lucide-react'
import type { ModelProfile } from '../../shared/ipc-channels'
import type { StoryChapterBlueprint, StoryNode } from '../../shared/story-branches'
import { useLocaleStore } from '../../stores/locale-store'
import { isGenerationModel } from '../../services/workflows/chapter-write-launch'
import { Button } from '../ui/Button'

export default function StoryChapterBlueprintEditor({ node, disabled, pending, generating, models, modelId, onModelChange, canGenerate, onChange, onGenerate, onReview, onShowManuscript, continuationTargets, bridgeToNodeId, onBridgeChange }: {
  node: StoryNode
  disabled: boolean
  pending: boolean
  generating: boolean
  models: ModelProfile[]
  modelId: string | null
  onModelChange(id: string): void
  canGenerate: boolean
  onChange(blueprint: StoryChapterBlueprint): void
  onGenerate(): void
  onReview(): void
  onShowManuscript(): void
  continuationTargets: { id: string; title: string }[]
  bridgeToNodeId: string
  onBridgeChange(id: string): void
}) {
  const text = useLocaleStore(state => state.text)
  const blueprint = node.chapterBlueprint
  const [peopleText, setPeopleText] = useState(blueprint?.characters.join('、') ?? '')
  const peopleInput = useRef<HTMLInputElement>(null)
  const currentPeople = blueprint?.characters.join('、') ?? ''
  useEffect(() => { if (document.activeElement !== peopleInput.current) setPeopleText(currentPeople) }, [currentPeople])
  if (!blueprint) return <div className="story-form"><p className="story-help">{text('为这个节点建立独立章节蓝图，再按蓝图生成正文。原有正文会保留。', 'Plan a chapter blueprint for this scene, then generate its manuscript. Existing prose remains.')}</p><Button variant="secondary" disabled={disabled} onClick={() => onChange({ title: node.title, role: '', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '', notes: '' })}><BookOpen size={14} aria-hidden />{text('建立本章蓝图', 'Plan this chapter')}</Button></div>
  const change = (delta: Partial<StoryChapterBlueprint>) => onChange({ ...blueprint, ...delta })
  const generationModels = models.filter(isGenerationModel)
  const ready = Boolean(blueprint.title.trim() && (blueprint.purpose.trim() || blueprint.keyEvents.trim()))
  return <div className="story-form story-chapter-blueprint">
    {node.chapterSource && <p className="story-source-reference">{text(`来自主线第 ${node.chapterSource.chapterNumber} 章的独立快照；这里的编辑只影响树内路线。`, `An independent snapshot of mainline chapter ${node.chapterSource.chapterNumber}. Edits here affect only story-tree routes.`)}</p>}
    <fieldset className="story-form" disabled={disabled}>
      <legend>{text('这一章的独立规划', 'Plan this chapter independently')}</legend>
      <label>{text('分支章节标题', 'Branch chapter title')}<input aria-label={text('分支章节标题', 'Branch chapter title')} value={blueprint.title} onChange={event => change({ title: event.target.value })} /></label>
      <label>{text('章节定位', 'Chapter role')}<input aria-label={text('章节定位', 'Chapter role')} placeholder={text('铺垫、发展、转折…', 'Setup, development, turning point…')} value={blueprint.role} onChange={event => change({ role: event.target.value })} /></label>
      <label>{text('本章目标', 'Chapter purpose')}<textarea aria-label={text('本章目标', 'Chapter purpose')} rows={3} value={blueprint.purpose} onChange={event => change({ purpose: event.target.value })} /></label>
      <label>{text('冲突与关键事件', 'Conflict and key events')}<textarea aria-label={text('冲突与关键事件', 'Conflict and key events')} rows={5} value={blueprint.keyEvents} onChange={event => change({ keyEvents: event.target.value })} /></label>
      <label>{text('出场人物', 'Characters')}<input ref={peopleInput} aria-label={text('出场人物', 'Characters')} placeholder={text('用顿号或逗号分隔', 'Separate names with commas')} value={peopleText} onChange={event => { setPeopleText(event.target.value); change({ characters: [...new Set(event.target.value.split(/[、,，]/u).map(value => value.trim()).filter(Boolean))] }) }} onBlur={() => setPeopleText(blueprint.characters.join('、'))} /></label>
      <label>{text('悬念钩子', 'Suspense hook')}<textarea aria-label={text('悬念钩子', 'Suspense hook')} rows={2} value={blueprint.suspenseHook} onChange={event => change({ suspenseHook: event.target.value })} /></label>
      <label>{text('作者微操指导', 'Author guidance')}<textarea aria-label={text('作者微操指导', 'Author guidance')} rows={3} value={blueprint.userGuidance} onChange={event => change({ userGuidance: event.target.value })} /></label>
      <label>{text('章节备注', 'Chapter notes')}<textarea aria-label={text('章节备注', 'Chapter notes')} rows={2} value={blueprint.notes} onChange={event => change({ notes: event.target.value })} /></label>
    </fieldset>
    <section className="story-blueprint-generation" aria-label={text('按蓝图创作', 'Write from this blueprint')}>
      <label>{text('接入后文（可选）', 'Later scene to connect to (optional)')}<select aria-label={text('接入后文（可选）', 'Later scene to connect to (optional)')} disabled={disabled || generating} value={bridgeToNodeId} onChange={event => onBridgeChange(event.target.value)}><option value="">{text('仅参考前文', 'Earlier text only')}</option>{continuationTargets.map(target => <option key={target.id} value={target.id}>{target.title}</option>)}</select></label>
      <p className="story-help">{text('后文选择只控制本次写作上下文，不会更改树上的连接。', 'The later-text choice controls this writing context; it does not change tree links.')}</p>
      <p className="story-help">{bridgeToNodeId ? text('同时参考父级前文和指定后文，生成能衔接两端的这一章。后文作为目标约束，不当作已经发生的事件。', 'Use earlier events and the selected later scene to bridge both ends. The later scene is a future constraint, not an event that has already happened.') : text('当前只使用所选路线的父级前情。需要接回时，可在树上连接后文，再在这里选择它。', 'Use only the selected earlier path. To reconnect later, link a later scene on the tree and select it here.')}</p>
      <label>{text('本次生成模型', 'Model for this chapter')}<select aria-label={text('本次生成模型', 'Model for this chapter')} disabled={disabled || generating} value={modelId ?? ''} onChange={event => onModelChange(event.target.value)}><option value="">{text('选择文本生成模型', 'Choose a generation model')}</option>{generationModels.map(model => <option key={model.id} value={model.id}>{model.name || model.modelName}</option>)}</select></label>
      <Button variant="primary" disabled={disabled || pending || generating || !ready || !canGenerate || !generationModels.some(model => model.id === modelId)} onClick={onGenerate}><Sparkles size={14} aria-hidden />{generating ? text('正在生成…', 'Generating…') : text('按蓝图生成章节', 'Generate chapter from blueprint')}</Button>
      <Button variant="secondary" disabled={disabled || pending || generating || !canGenerate || !node.body.trim() || !generationModels.some(model => model.id === modelId)} onClick={onReview}><ScanText size={14} aria-hidden />{text('审查衔接一致性', 'Review story continuity')}</Button>
      <p className="story-help">{pending ? text('先保存蓝图修改，再生成这一章。', 'Save blueprint changes before generating this chapter.') : !canGenerate ? text('先选择经过当前节点的路线；汇合节点也可选择共用写作。', 'Select a route containing this scene, or choose shared writing at a merge.') : generationModels.length === 0 ? text('请先在设置中添加可用于文本生成的模型。', 'Add a text generation model in Settings first.') : text('点击即调用所选模型。候选在助手中展示，经你批准后保存到当前节点，并保留父级连接。', 'Starts the selected model. Review its candidate in the assistant and approve to save this node, keeping its parent links.')}</p>
    </section>
    <Button variant="text" onClick={onShowManuscript}>{text('查看本章正文', 'Read this chapter manuscript')}{node.body && <span> · {node.body.length}</span>}</Button>
  </div>
}
