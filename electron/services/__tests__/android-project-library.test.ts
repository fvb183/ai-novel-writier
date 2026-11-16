import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'

const state = vi.hoisted(() => ({ value: null as unknown, writes: 0 }))
vi.mock('../app-data-locator', () => ({ getGlobalDataRoot: () => 'D:/private-app' }))
vi.mock('../../utils/config-utils', () => ({
  tryReadJsonFile: () => state.value === null ? { status: 'missing' } : { status: 'ok', value: state.value },
  writeJsonFile: (_path: string, value: unknown) => { state.value = value; state.writes++ },
}))
import { androidProjectLibraryRoots, isAndroidLibraryProjectHidden, recoverAndroidLibraryProjects, setAndroidLibraryProjectHidden } from '../android-project-library'

const roots: string[] = []
function fixture() {
  const parent = path.resolve('.runtime/library-recovery-tests'); fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'run-')); roots.push(root); return root
}
function book(root: string, name = '已经保存的小说', parent = 'Projects') {
  const directory = path.join(root, parent, name), storage = path.join(directory, '.ai-novel')
  fs.mkdirSync(storage, { recursive: true })
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: '2026-11-11T00:00:00.000Z' })
  fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify(manifest))
  const bytes = Buffer.alloc(4096); bytes.write('SQLite format 3\0'); fs.writeFileSync(path.join(storage, 'project.db'), bytes)
  return { name, path: directory, projectId: manifest.projectId, updatedAt: manifest.createdAt }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); state.value = null; state.writes = 0 })

describe('Android private library recovery', () => {
  it('recovers a committed project without a recent-list or cloud binding, and avoids duplicate entries', () => {
    const root = fixture(), project = book(root)
    expect(recoverAndroidLibraryProjects(root, [], [])).toEqual([project])
    expect(recoverAndroidLibraryProjects(root, [project], [])).toEqual([])
  })
  it('recovers both native Projects and the former automatic-sync root', () => {
    const root = fixture(), native = book(root), automatic = book(root, randomUUID().slice(0, 13), 'AI-Novel-Writer')
    expect(androidProjectLibraryRoots(root)).toEqual([path.join(root, 'Projects'), path.join(root, 'AI-Novel-Writer')])
    expect(recoverAndroidLibraryProjects(root, [], [])).toEqual([native, automatic])
  })
  it('does not recover join staging, missing databases, invalid SQLite, or an unfinished migration', () => {
    const root = fixture(), staging = book(root, '.ainovelsync-join-pending'), missing = book(root, 'missing'), invalid = book(root, 'invalid'), migrating = book(root, 'migrating')
    fs.unlinkSync(path.join(missing.path, '.ai-novel/project.db'))
    fs.writeFileSync(path.join(invalid.path, '.ai-novel/project.db'), Buffer.alloc(4096))
    fs.mkdirSync(path.join(migrating.path, '.ai-novel-migration'))
    fs.writeFileSync(path.join(migrating.path, '.ai-novel-migration/journal.json'), JSON.stringify({ version: 1, phase: 'copying', projectId: migrating.projectId }))
    expect(recoverAndroidLibraryProjects(root, [], [])).toEqual([])
    expect(fs.existsSync(staging.path)).toBe(true)
  })
  it('keeps explicitly removed books hidden across recovery and allows an explicit open to restore them', () => {
    const root = fixture(), project = book(root)
    setAndroidLibraryProjectHidden(project.path, true)
    expect(isAndroidLibraryProjectHidden(project.path)).toBe(true)
    expect(recoverAndroidLibraryProjects(root, [])).toEqual([])
    setAndroidLibraryProjectHidden(project.path, false)
    expect(recoverAndroidLibraryProjects(root, [])).toEqual([project])
    expect(state.writes).toBe(2)
  })
  it('rejects a corrupt removal ledger instead of resurrecting hidden books or replacing it', () => {
    const root = fixture(); book(root); state.value = { version: 1, paths: ['relative/path'] }
    expect(() => recoverAndroidLibraryProjects(root, [])).toThrow('PROJECT_LIBRARY_INDEX_INVALID')
    expect(() => setAndroidLibraryProjectHidden('/private/book', false)).toThrow('PROJECT_LIBRARY_INDEX_INVALID')
    expect(state.writes).toBe(0)
  })
  it('does not read unrelated user-selected folders or register a linked database', () => {
    const root = fixture(), project = book(root)
    const original = path.join(project.path, '.ai-novel/project.db'), other = path.join(root, 'linked.db')
    fs.linkSync(original, other)
    book(root, 'unrelated', 'External')
    expect(recoverAndroidLibraryProjects(root, [], [])).toEqual([])
  })
  it('recovers the saved Chinese title offline and repairs an existing UUID placeholder without duplicating it', () => {
    const root = fixture(), project = book(root, randomUUID().slice(0, 13)), readName = vi.fn(() => '手机三的中文小说')
    expect(recoverAndroidLibraryProjects(root, [], [], readName)).toEqual([{ ...project, name: '手机三的中文小说' }])
    expect(recoverAndroidLibraryProjects(root, [project], [], readName)).toEqual([{ ...project, name: '手机三的中文小说' }])
    expect(readName).toHaveBeenCalledWith(path.join(project.path, '.ai-novel/project.db'))
    expect(recoverAndroidLibraryProjects(root, [{ ...project, name: '作者指定书名' }], [], readName)).toEqual([])
    expect(readName).toHaveBeenCalledTimes(2)
  })
  it('retains the fallback book if its title cannot be read and never reads a hidden or incomplete book database', () => {
    const root = fixture(), project = book(root), readName = vi.fn(() => undefined)
    expect(recoverAndroidLibraryProjects(root, [], [], readName)).toEqual([project])
    expect(recoverAndroidLibraryProjects(root, [], [project.path], readName)).toEqual([])
    fs.writeFileSync(path.join(project.path, '.ai-novel/project.db'), Buffer.alloc(4096))
    expect(recoverAndroidLibraryProjects(root, [], [], readName)).toEqual([])
    expect(readName).toHaveBeenCalledOnce()
  })
})
