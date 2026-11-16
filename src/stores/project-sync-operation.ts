import { create } from 'zustand'

/** Global, so the lock survives a settings panel unmount during project reopen. */
export const useProjectSyncOperation = create<{ phase: 'saving' | 'checking' | 'applying' | 'reopening' | null }>(() => ({ phase: null }))
