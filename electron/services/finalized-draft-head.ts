import type Database from 'better-sqlite3'

/** This is authoring data, independent of transport identity and preserved by portable backups. */
export function hasFinalizedDraftHeads(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chapter_finalization_heads'").get())
}

export function getAuthoritativeFinalizedDraftId(db: Database.Database, chapterNumber: number): number | null {
  if (hasFinalizedDraftHeads(db)) {
    const head = db.prepare('SELECT draft_id FROM chapter_finalization_heads WHERE chapter_number=?').pluck().get(chapterNumber)
    if (head !== undefined) {
      if (!db.prepare("SELECT 1 FROM drafts WHERE id=? AND chapter_number=? AND status='finalized'").get(head, chapterNumber)) {
        throw new Error('FINALIZED_HEAD_INVALID')
      }
      return Number(head)
    }
  }
  const id = db.prepare("SELECT id FROM drafts WHERE chapter_number=? AND status='finalized' ORDER BY version DESC,id DESC LIMIT 1").pluck().get(chapterNumber)
  return id === undefined ? null : Number(id)
}

/** SQL equivalent for joins/bulk reads; an invalid explicit head never falls back to another body. */
export function authoritativeFinalizedPredicate(db: Database.Database, alias: string): string {
  if (!/^[a-z_]+$/i.test(alias)) throw new Error('FINALIZED_HEAD_ALIAS_INVALID')
  const fallback = `(SELECT head_draft.id FROM drafts head_draft WHERE head_draft.chapter_number=${alias}.chapter_number AND head_draft.status='finalized' ORDER BY head_draft.version DESC,head_draft.id DESC LIMIT 1)`
  const id = hasFinalizedDraftHeads(db)
    ? `COALESCE((SELECT draft_id FROM chapter_finalization_heads WHERE chapter_number=${alias}.chapter_number),${fallback})`
    : fallback
  return `${alias}.id=${id}`
}

export function setAuthoritativeFinalizedDraft(db: Database.Database, chapterNumber: number, draftId: number): void {
  if (!hasFinalizedDraftHeads(db)) return // Read/write compatibility for schema 7 and isolated repository fixtures.
  if (!db.prepare("SELECT 1 FROM drafts WHERE id=? AND chapter_number=? AND status='finalized'").get(draftId, chapterNumber)) {
    throw new Error('FINALIZED_HEAD_INVALID')
  }
  db.prepare('INSERT INTO chapter_finalization_heads(chapter_number,draft_id) VALUES(?,?) ON CONFLICT(chapter_number) DO UPDATE SET draft_id=excluded.draft_id').run(chapterNumber, draftId)
}
