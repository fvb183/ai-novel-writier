import { describe, expect, it } from 'vitest'
import { authoritativeFinalizedDraft, authoritativeFinalizedDrafts } from '../draft-authority'
import { deriveChapters, focusChapter } from '../../stores/navigation/stage-progress'
import type { DraftMeta } from '../../services/draft-index'

const draft = (id: number, version: number, authority?: boolean, chapterNumber = 1): DraftMeta => ({
  id, version, chapterNumber, status: 'finalized', authoritativeFinalized: authority, source: 'write',
  createdAt: '', filePath: 'ai-novel://draft/' + id, fileName: 'draft_v' + version + '.md',
  chapterTitle: 'title-' + id,
})

describe('renderer finalized authority', () => {
  it('uses the author-selected head even when a higher finalized version appears first', () => {
    const older = draft(10, 1, true), newer = draft(20, 8, false)
    expect(authoritativeFinalizedDraft([newer, older])).toBe(older)
    const rows = deriveChapters({ blueprints: [], drafts: { 1: [newer, older] }, runningChapters: new Set() })
    expect(rows[0]).toMatchObject({ draft: older, title: 'title-10', phase: 'final' })
    expect(focusChapter(rows)?.draft).toBe(older)
  })
  it('fails closed when the backend marks every finalized version non-authoritative', () => {
    expect(authoritativeFinalizedDraft([draft(1, 1, false), draft(2, 2, false)])).toBeNull()
  })
  it('does not use array order to guess between unannotated legacy finals or duplicate heads', () => {
    expect(authoritativeFinalizedDraft([draft(1, 1), draft(2, 2)])).toBeNull()
    expect(authoritativeFinalizedDraft([draft(1, 1, true), draft(2, 2, true)])).toBeNull()
  })
  it('accepts an unambiguous legacy final but excludes all non-head candidates per chapter', () => {
    const single = draft(1, 1)
    expect(authoritativeFinalizedDraft([single])).toBe(single)
    const selected = draft(2, 1, true, 2)
    expect(authoritativeFinalizedDrafts([single, draft(3, 9, false, 2), selected])).toEqual([single, selected])
  })
})
