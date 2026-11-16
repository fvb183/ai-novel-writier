interface FinalizedAuthority {
  chapterNumber: number
  status: string
  authoritativeFinalized?: boolean
}

/** Versions order the history, not the current finalization selected by the author. */
export function authoritativeFinalizedDraft<T extends FinalizedAuthority>(drafts: readonly T[]): T | null {
  const finals = drafts.filter(draft => draft.status === 'finalized')
  const selected = finals.filter(draft => draft.authoritativeFinalized === true)
  if (selected.length === 1) return selected[0]
  if (selected.length || finals.some(draft => draft.authoritativeFinalized !== undefined)) return null
  // Older read adapters may omit the marker. Only an unambiguous single final
  // is compatible; never infer an authority from MAX(version) or array order.
  return finals.length === 1 ? finals[0] : null
}

export function authoritativeFinalizedDrafts<T extends FinalizedAuthority>(drafts: readonly T[]): T[] {
  const chapters = new Map<number, T[]>()
  for (const draft of drafts) {
    const group = chapters.get(draft.chapterNumber) ?? []
    group.push(draft)
    chapters.set(draft.chapterNumber, group)
  }
  return [...chapters.values()].flatMap(group => {
    const selected = authoritativeFinalizedDraft(group)
    return selected ? [selected] : []
  })
}
