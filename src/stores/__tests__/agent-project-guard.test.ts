import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installAgentProjectGuard, useAgentStore } from '../agent-store'
import { useProjectStore } from '../project-store'
import type { ProjectData } from '../../shared/ipc-channels'

const project = (id: string, lease = 'lease-1') => ({
  id, path: `C:/synthetic/${id}`, sessionLease: lease, name: id,
} as ProjectData)
let dispose: () => void

beforeEach(() => {
  useAgentStore.setState({ conversations: [], activeConversationId: null, generating: false, toolsInitialized: true })
  useProjectStore.setState({ currentProject: project('a') })
  dispose = installAgentProjectGuard()
})
afterEach(() => {
  dispose()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
})

describe('assistant project ownership', () => {
  it('keeps each project history and restores only that project when returning', () => {
    const a = useAgentStore.getState().createConversation()
    useProjectStore.setState({ currentProject: project('b') })
    expect(useAgentStore.getState().getActiveConversation()).toBeNull()
    expect(useAgentStore.getState().getProjectConversations()).toEqual([])
    useAgentStore.getState().selectConversation(a.id)
    expect(useAgentStore.getState().getActiveConversation()).toBeNull()
    const b = useAgentStore.getState().createConversation()
    useProjectStore.setState({ currentProject: project('a', 'lease-2') })
    expect(useAgentStore.getState().getActiveConversation()?.id).toBe(a.id)
    expect(useAgentStore.getState().getProjectConversations().map(c => c.id)).toEqual([a.id])
    useAgentStore.getState().clearAll()
    expect(useAgentStore.getState().conversations.map(c => c.id)).toEqual([b.id])
  })

  it('cancels a live turn on project or session change, even with the sheet closed', () => {
    const cancel = vi.spyOn(useAgentStore.getState(), 'cancelGeneration').mockResolvedValue()
    useAgentStore.setState({ generating: true })
    useProjectStore.setState({ currentProject: project('a', 'lease-2') })
    expect(cancel).toHaveBeenCalledOnce()
    useProjectStore.setState({ currentProject: project('b') })
    expect(cancel).toHaveBeenCalledTimes(2)
  })
})
