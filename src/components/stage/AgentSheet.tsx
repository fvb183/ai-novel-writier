import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useAgentStore } from '../../stores/agent-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useStageStore } from '../../stores/navigation/stage-store'
import AgentHeader from '../panels/agent/AgentHeader'
import AgentConversation from '../panels/agent/AgentConversation'
import { Button } from '../ui/Button'

/** The same generation, confirmation and domain-commit chain on both platforms. */
export default function AgentSheet() {
  const text = useLocaleStore(s => s.text)
  useEffect(() => { useAgentStore.getState().initializeTools() }, [])
  return <aside className="stage-agent-sheet" aria-label={text('AI 写作助手', 'AI Writing Assistant')}>
    <div className="stage-agent-heading">
      <div className="stage-agent-header"><AgentHeader /></div>
      <Button variant="icon" size="sm" aria-label={text('收起助手', 'Close assistant')} onClick={() => useStageStore.setState({ sheet: null })}>
        <X size={16} aria-hidden="true" />
      </Button>
    </div>
    <div className="stage-agent-conversation"><AgentConversation /></div>
  </aside>
}
