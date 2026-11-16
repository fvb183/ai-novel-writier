import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { FinalizationRepository } from '../finalization-repository'
import { DraftRepository } from '../draft-repository'
import { getAuthoritativeFinalizedDraftId, setAuthoritativeFinalizedDraft } from '../../services/finalized-draft-head'

let root = ''
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'v14-local-finalization-'))
  openCanonicalProjectFixture(root)
})
afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

it('repairs duplicate finals around the explicit synced head even when its display version is lower', () => {
  const db = getProjectDb()!
  const selected = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '作者选定的正文', wordCount: 8 })
  const other = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '另一个显示版本', wordCount: 8 })
  db.prepare("UPDATE drafts SET status='finalized' WHERE id IN (?,?)").run(selected, other)
  setAuthoritativeFinalizedDraft(db, 1, selected)

  expect(FinalizationRepository.repairDuplicateFinalizations()).toMatchObject({ chapters: [{
    chapterNumber: 1, keptDraftId: selected, keptVersion: 1, superseded: [{ draftId: other, version: 2 }],
  }] })
  expect(getAuthoritativeFinalizedDraftId(db, 1)).toBe(selected)
  expect(FinalizationRepository.isAuthoritative(selected)).toBe(true)
  expect(FinalizationRepository.isAuthoritative(other)).toBe(false)
  expect(() => DraftRepository.updateContent(other, '不能改写历史', 6)).toThrow('DRAFT_FINALIZED_READ_ONLY')
  expect(DraftRepository.getFull(other)?.content).toBe('另一个显示版本')
  expect(FinalizationRepository.repairDuplicateFinalizations()).toEqual({ chapters: [] })
})

it('keeps duplicate rows intact when their explicit authoring head is invalid', () => {
  const db = getProjectDb()!
  const first = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '第一稿', wordCount: 3 })
  const second = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '第二稿', wordCount: 3 })
  const invalid = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '仍在编辑', wordCount: 4 })
  db.prepare("UPDATE drafts SET status='finalized' WHERE id IN (?,?)").run(first, second)
  db.prepare('INSERT INTO chapter_finalization_heads(chapter_number,draft_id) VALUES(1,?)').run(invalid)
  expect(() => FinalizationRepository.repairDuplicateFinalizations()).toThrow('FINALIZED_HEAD_INVALID')
  expect(db.prepare("SELECT COUNT(*) FROM drafts WHERE status='finalized'").pluck().get()).toBe(2)
})

