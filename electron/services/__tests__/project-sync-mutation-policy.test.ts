import { describe, expect, it } from 'vitest'
import { isPortableProjectMutation } from '../project-sync-mutation-policy'

describe('portable author SQL capture policy', () => {
  it.each([
    'SELECT * FROM drafts',
    "SELECT 'INSERT INTO drafts' FROM project_core -- UPDATE drafts",
    "UPDATE generation_runs SET status='completed' WHERE run_id=?",
    'INSERT OR IGNORE INTO reviews(id) VALUES(?)',
    "INSERT INTO generation_runs(run_id,status) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status",
    'DELETE FROM main.summary_snapshots',
    'UPDATE "project_core" SET "plot_tree_snapshot"=?,character_states=? WHERE id=?',
  ])('skips local or read SQL: %s', sql => expect(isPortableProjectMutation(sql)).toBe(false))
  it.each([
    'UPDATE project_core SET genre=? WHERE id=?',
    'UPDATE project_core SET characters_arch=? WHERE id=?',
    'UPDATE contents SET body=? WHERE id=?',
    'INSERT INTO drafts(chapter_number) VALUES(?)',
    'DELETE FROM story_nodes WHERE id=?',
    'UPDATE project_core SET plot_tree_snapshot=?,genre=? WHERE id=?',
    'UPDATE future_author_table SET value=?',
    'DELETE FROM reviews; UPDATE blueprints SET title=?',
    'CREATE TRIGGER author_change AFTER UPDATE ON reviews BEGIN UPDATE drafts SET word_count=0; END',
  ])('retains authoritative or unknown writes: %s', sql => expect(isPortableProjectMutation(sql)).toBe(true))
})
