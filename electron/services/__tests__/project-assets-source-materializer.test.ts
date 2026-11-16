import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { createProjectDatabase } from '../../database'
import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { parseProjectAuthorAsset, projectAssetBlobs, projectPromptAssetGroup, type ProjectAssetEnvelope, type ProjectAuthorAsset } from '../../../src/shared/project-sync-assets'
import { ProjectAssetBlobStore } from '../project-asset-blob-store'
import { snapshotSavedProjectAssets, type SavedKnowledgeSnapshot } from '../project-asset-source-service'
import { materializeSelectedProjectAssets } from '../project-asset-materializer'
import { applySelectedProjectAssets, captureProjectAssets, parseProjectAssetRecords, pendingProjectAssets, projectAssetIdentity,
  recordCapturedProjectAssets, validateProjectAssetChanges, validateProjectAssetHistory } from '../project-sync-assets'
import { ProjectSyncEngine, syncDigest } from '../project-sync-engine'
import { captureCompact, prepareCompactAuthorProjection } from '../project-sync-projection'
import { selectedKnowledgeAssetHash } from '../project-sync-assets'
import { hashSyncKnowledgeDocuments, serializeSyncKnowledgeDocument, type SyncKnowledgeDocument } from '../../../src/shared/project-sync-knowledge'
import { readSyncKnowledgeDocuments, registerSyncKnowledgeReadGuard, replaceSyncKnowledgeDocuments } from '../../vector-store'

type Files = Extract<ProjectAuthorAsset, { category: 'files' }>
type Fixture = ReturnType<typeof fixture>
const roots: string[] = [], handles = new Set<Database.Database>()
const releases: Array<() => void> = []
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function fixture(projectId: string = randomUUID()) {
  const temporary = fs.realpathSync.native(os.tmpdir())
  if (process.platform === 'win32' && path.parse(temporary).root.toLowerCase() !== 'c:\\') throw new Error('C_SCRATCH_REQUIRED')
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, 'ainw-af-'))); roots.push(project)
  const root = path.join(project, '.ai-novel'); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId, createdAt: '2026-10-29T00:00:00.000Z' })))
  createProjectDatabase(project, Buffer.alloc(32, 93))
  const db = new Database(path.join(root, 'project.db')); handles.add(db); db.pragma('foreign_keys = ON')
  expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
  const store = new ProjectAssetBlobStore(root)
  const engine = new ProjectSyncEngine(db, projectId, { capture: captureProjectAssets, validate: parseProjectAssetRecords,
    validateChanges: validateProjectAssetChanges, validateHistory: validateProjectAssetHistory,
    apply: (database, records) => applySelectedProjectAssets(database, records, store) })
  return { project, root, db, store, projectId, engine }
}
function at(run: Fixture, relative: string): string {
  const file = path.resolve(run.root, relative), inside = path.relative(run.root, file)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('fixture path outside owned root')
  return file
}
function write(run: Fixture, relative: string, bytes: string | Buffer) {
  const file = at(run, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file
}
function remove(run: Fixture, relative: string) { fs.rmSync(at(run, relative), { force: true, recursive: true }) }
function files(run: Fixture, logicalName: string, contents: Record<string, string>, group: Files['group'] = 'prompt'): Files {
  return parseProjectAuthorAsset({ version: 1, category: 'files', group, logicalName: group === 'prompt' ? projectPromptAssetGroup(logicalName) : logicalName,
    files: Object.entries(contents).map(([name, content]) => ({ path: name, blob: run.store.put(Buffer.from(content), 'text/plain') })) }) as Files
}
function envelope(run: Fixture, value: ProjectAuthorAsset): ProjectAssetEnvelope { return { id: projectAssetIdentity(run.projectId, value), value } }
function select(run: Fixture, records: ProjectAssetEnvelope[]) {
  run.db.transaction(() => applySelectedProjectAssets(run.db, records.map(record => ({ kind: 'project-asset', ...record })), run.store))()
}
async function materialize(run: Fixture, extra: Partial<Parameters<typeof materializeSelectedProjectAssets>[0]> = {}) {
  await materializeSelectedProjectAssets({ database: run.db, storageRoot: run.root, revalidate: () => {},
    replaceKnowledge: async () => { throw new Error('unexpected knowledge materialization') }, ...extra })
}
function knowledge(run: Fixture, beforeVerify?: () => Promise<void>): () => Promise<SavedKnowledgeSnapshot> {
  const text = '本机知识源完整原文。', textHash = hash(Buffer.from(text))
  const document: SyncKnowledgeDocument = { version: 1, docId: 'source-doc', fileName: 'source-doc.md', corpusKind: 'project-knowledge',
    importedAt: '2026-10-29T00:00:00Z', logicalSource: { kind: 'legacy-unbound' },
    chunks: [{ id: 'source-doc:original:0', chunkIndex: 0, text, textHash, importedAt: '2026-10-29T00:00:00Z' }],
    copy: { availability: 'available', content: text, contentHash: textHash, indexedHash: textHash, edited: false, indexDirty: false } }
  const file = write(run, 'knowledge-copies/source-document.json', serializeSyncKnowledgeDocument(document))
  return async () => {
    const bytes = fs.readFileSync(file), original = hash(bytes)
    return { documents: [{ documentId: 'source-doc', bytes }], canonicalHash: hashSyncKnowledgeDocuments([JSON.parse(bytes.toString())]),
      verifyUnchanged: async () => { await beforeVerify?.(); return hash(fs.readFileSync(file)) === original } }
  }
}
async function source(run: Fixture, options: Partial<Parameters<typeof snapshotSavedProjectAssets>[0]> = {}) {
  return snapshotSavedProjectAssets({ database: run.db, storageRoot: run.root, projectId: run.projectId, revalidate: () => {},
    scope: 'complete', readKnowledge: async () => ({ documents: [], canonicalHash: syncDigest([]), verifyUnchanged: async () => true }), ...options })
}
function addCharacter(run: Fixture, id: string) { run.db.prepare('INSERT INTO characters(character_id,name,role) VALUES(?,?,?)').run(id, id, 'supporting') }
function bound(run: Fixture, id: string, relative: string) {
  addCharacter(run, id); write(run, relative, png)
  run.db.prepare('INSERT INTO character_avatar_assets VALUES(?,?,?,?,?,?,?)').run(id, 1, relative, hash(png), 'image/png', png.length, 'synthetic-local-source')
}
function orphan(run: Fixture, id: string, relative: string) {
  write(run, relative, png)
  run.db.prepare('INSERT INTO character_avatar_unresolved VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, 'orphan', 'synthetic-local-source', relative, relative, hash(png), 'image/png', png.length, '[]')
}
function copyBlobs(left: Fixture, right: Fixture, records: ProjectAssetEnvelope[]) {
  for (const record of records) for (const blob of projectAssetBlobs(record.value)) {
    expect(right.store.put(left.store.read(blob), blob.mime)).toEqual(blob)
  }
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  for (const release of releases.splice(0)) release()
  for (const handle of handles) if (handle.open) handle.close()
  handles.clear()
  const temporary = fs.realpathSync.native(os.tmpdir())
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== temporary || !path.basename(root).startsWith('ainw-af-')) throw new Error('unsafe fixture cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('saved author-source snapshots on the actual schema 11 database', () => {
  it('retires legacy static manifests and machine evidence without deleting local prompt or Skill files', async () => {
    const run = fixture()
    write(run, 'prompts/draft.json', 'local prompt'); write(run, 'skills/scene/SKILL.md', 'local Skill')
    write(run, 'writing-skills.json', '{"version":1,"bindings":{"drafting":"project:scene"}}')
    const original = await source(run); recordCapturedProjectAssets(run.db, original.records)
    const payload = JSON.stringify('old generated plot history')
    run.db.prepare('INSERT INTO project_sync_history VALUES(?,?,?)').run('history:plot\u0000old', payload, hash(Buffer.from(payload)))
    expect(captureCompact(run.db).some(record => record.kind.startsWith('history:') || record.kind === 'project-asset'
      && parseProjectAuthorAsset(record.value).category === 'files' && ['prompt', 'skill'].includes((parseProjectAuthorAsset(record.value) as Files).group))).toBe(false)
    prepareCompactAuthorProjection(run.db)
    expect(run.db.prepare('SELECT COUNT(*) FROM project_sync_history').pluck().get()).toBe(0)
    expect(captureProjectAssets(run.db).map(record => (parseProjectAuthorAsset(record.value) as Files).group)).toEqual(['skill-bindings'])
    expect(pendingProjectAssets(run.db)).toEqual([])
    await materialize(run)
    expect(fs.readFileSync(at(run, 'prompts/draft.json'), 'utf8')).toBe('local prompt')
    expect(fs.readFileSync(at(run, 'skills/scene/SKILL.md'), 'utf8')).toBe('local Skill')
  }, 60000)
  it('ordinary sync skips prompt and Skill bytes and creation logs while carrying author architecture and Skill choices', async () => {
    const run = fixture()
    write(run, 'prompts/draft.json', '{"saved":"local prompt"}')
    write(run, 'skills/scene/SKILL.md', 'local Skill')
    write(run, 'chapter_creation_log.json', '{"generated":"local log"}')
    write(run, 'partial_arch/outline.md', 'author architecture')
    write(run, 'writing-skills.json', '{"version":1,"bindings":{"draft":"project:scene"}}')
    const stats = vi.spyOn(fs, 'lstatSync'), directories = vi.spyOn(fs, 'readdirSync')
    const imported: string[] = [], original = ProjectAssetBlobStore.prototype.importFile
    vi.spyOn(ProjectAssetBlobStore.prototype, 'importFile').mockImplementation(function (this: ProjectAssetBlobStore, file, ...args) {
      imported.push(file.replaceAll('\\', '/')); return original.call(this, file, ...args)
    })
    const snapshot = await source(run, { scope: 'continuous' })
    expect(snapshot.records.map(record => record.value.category === 'files' ? record.value.logicalName : record.value.category).sort())
      .toEqual(['partial_arch', 'writing-skills.json'])
    expect(imported.some(file => /\/prompts\/|\/skills\/|chapter_creation_log/.test(file))).toBe(false)
    expect(stats.mock.calls.some(([file]) => /\/(?:prompts|skills)(?:\/|$)|chapter_creation_log/.test(String(file).replaceAll('\\', '/')))).toBe(false)
    expect(directories.mock.calls.some(([file]) => path.resolve(String(file)) === path.resolve(run.root))).toBe(false)
    // Excluded local configuration can change without invalidating an author snapshot.
    write(run, 'prompts/draft.json', 'new local prompt')
    write(run, 'skills/scene/SKILL.md', 'new local Skill')
    await snapshot.verifyUnchanged()
  }, 60000)

  it('freezes legacy static manifests without reading changed or missing local static files or creating author deletes', async () => {
    const run = fixture()
    write(run, 'prompts/draft.json', 'original prompt')
    write(run, 'skills/scene/SKILL.md', 'original Skill')
    const old = await source(run)
    recordCapturedProjectAssets(run.db, old.records)
    run.engine.enable(); const before = run.engine.exportBundle()
    write(run, 'prompts/draft.json', 'independent local edit'); remove(run, 'skills')
    const current = await source(run, { scope: 'continuous' })
    expect(current.records).toEqual(old.records)
    run.engine.captureMutation(() => recordCapturedProjectAssets(run.db, current.records))
    expect(run.engine.exportBundle()).toEqual(before)
    expect(fs.readFileSync(at(run, 'prompts/draft.json'), 'utf8')).toBe('independent local edit')
  }, 60000)

  it('freezes complete Skill and partial_arch directory aggregates alongside prompts bindings and canonical knowledge bytes', async () => {
    const run = fixture()
    write(run, 'prompts/draft.json', '{"saved":"作者提示词"}')
    write(run, 'skills/scene/SKILL.md', '作者完整 Skill')
    write(run, 'skills/scene/examples/note.txt', '配套示例')
    write(run, 'partial_arch/a.json', '{"chapter":1}')
    write(run, 'partial_arch/nested/b.json', '{"chapter":2}')
    write(run, 'writing-skills.json', '{"binding":"scene"}')
    const snapshot = await source(run, { readKnowledge: knowledge(run) })
    const skill = snapshot.records.find(record => record.value.category === 'files' && record.value.group === 'skill')!.value as Files
    const architecture = snapshot.records.find(record => record.value.category === 'files' && record.value.logicalName === 'partial_arch')!.value as Files
    expect(skill.files.map(file => file.path).sort()).toEqual(['skills/scene/SKILL.md', 'skills/scene/examples/note.txt'])
    expect(architecture.files.map(file => file.path)).toEqual(['partial_arch/a.json', 'partial_arch/nested/b.json'])
    expect(snapshot.records.filter(record => record.value.category === 'files')).toHaveLength(4)
    for (const record of snapshot.records) if (record.value.category === 'files') for (const file of record.value.files) {
      expect(run.store.read(file.blob)).toEqual(fs.readFileSync(at(run, file.path)))
    }
    const savedKnowledge = snapshot.records.find(record => record.value.category === 'knowledge')!.value as Extract<ProjectAuthorAsset, { category: 'knowledge' }>
    expect(run.store.read(savedKnowledge.blob)).toEqual(fs.readFileSync(at(run, 'knowledge-copies/source-document.json')))
    await snapshot.verifyUnchanged()
    expect(pendingProjectAssets(run.db)).toEqual([])
  }, 60000)

  it('preserves distinct bound/unassigned identities with identical image bytes and a reference-only record without guessing an owner', async () => {
    const run = fixture()
    bound(run, 'person-a', 'avatars/a.png'); bound(run, 'person-b', 'avatars/b.png'); orphan(run, 'orphan-image', 'avatars/orphan.png')
    run.db.prepare('INSERT INTO character_avatar_unresolved VALUES(?,?,?,?,?,?,?,?,?)')
      .run('missing-reference', 'reference-only', 'synthetic-reference', 'avatars/missing.png', null, null, null, null, '["person-a","person-b"]')
    const snapshot = await source(run)
    expect(snapshot.records).toHaveLength(4); expect(new Set(snapshot.records.map(record => record.id)).size).toBe(4)
    expect(snapshot.records.filter(record => record.value.category === 'avatar')).toHaveLength(2)
    expect(snapshot.records.find(record => record.value.category === 'unassigned-avatar' && record.value.originId === 'missing-reference')!.value)
      .toMatchObject({ disposition: 'reference-only', blob: null, candidateCharacterIds: ['person-a', 'person-b'] })
    expect(new Set(snapshot.records.flatMap(record => projectAssetBlobs(record.value).map(blob => blob.sha256))).size).toBe(1)
    expect(run.db.prepare('SELECT COUNT(*) FROM character_avatar_assets').pluck().get()).toBe(2)
  }, 60000)

  it.each(['prompts/draft.json', 'skills/scene/SKILL.md', 'partial_arch/a.json'])('rejects %s changing while asynchronous knowledge verification is suspended', async relative => {
    const run = fixture(); write(run, relative, 'saved-before-await')
    let suspend = false, entered!: () => void, resume!: () => void
    const didEnter = new Promise<void>(resolve => { entered = resolve }), release = new Promise<void>(resolve => { resume = resolve })
    const snapshot = await source(run, { readKnowledge: knowledge(run, async () => { if (suspend) { entered(); await release } }) })
    suspend = true
    const verify = snapshot.verifyUnchanged(); await didEnter
    write(run, relative, 'edited-during-await'); resume()
    await expect(verify).rejects.toThrow('PROJECT_SYNC_ASSET_SOURCE_CHANGED')
    expect(fs.readFileSync(at(run, relative), 'utf8')).toBe('edited-during-await')
  }, 60000)

  it('rejects image bytes changing without any corresponding SQL metadata update', async () => {
    const run = fixture(); bound(run, 'person-a', 'avatars/a.png')
    const snapshot = await source(run), before = run.db.prepare('SELECT * FROM character_avatar_assets').all()
    const edited = Buffer.from(png); edited[edited.length - 1] ^= 1; write(run, 'avatars/a.png', edited)
    await expect(snapshot.verifyUnchanged()).rejects.toThrow('PROJECT_SYNC_ASSET_SOURCE_CHANGED')
    expect(run.db.prepare('SELECT * FROM character_avatar_assets').all()).toEqual(before)
    expect(fs.readFileSync(at(run, 'avatars/a.png'))).toEqual(edited)
  }, 60000)

  it('refuses a stale project session or pending remote materialization before treating it as a saved local deletion', async () => {
    const run = fixture(); write(run, 'prompts/draft.json', 'local saved source')
    let active = true
    const snapshot = await source(run, { revalidate: () => { if (!active) throw new Error('SYNC_SESSION_STALE') } })
    active = false; await expect(snapshot.verifyUnchanged()).rejects.toThrow('SYNC_SESSION_STALE')
    const selected = envelope(run, files(run, 'prompts/remote.json', { 'prompts/remote.json': 'remote bytes' }))
    select(run, [selected])
    await expect(source(run)).rejects.toThrow('PROJECT_SYNC_ASSET_NOT_READY')
    expect(pendingProjectAssets(run.db)).toHaveLength(1)
    expect(fs.readFileSync(at(run, 'prompts/draft.json'), 'utf8')).toBe('local saved source')
  }, 60000)
})

describe('restartable author-asset materialization with real SQLite CAS and files', () => {
  it('updates and deletes a saved file while keeping every superseded byte in immutable storage', async () => {
    const run = fixture(), previous = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'old author bytes' }))
    select(run, [previous]); await materialize(run)
    const updated = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'new selected bytes' }))
    select(run, [updated]); expect(pendingProjectAssets(run.db)).toHaveLength(1)
    await materialize(run)
    expect(fs.readFileSync(at(run, 'prompts/draft.json'), 'utf8')).toBe('new selected bytes')
    expect(run.store.read((previous.value as Files).files[0]!.blob).toString()).toBe('old author bytes')
    select(run, []); await materialize(run)
    expect(fs.existsSync(at(run, 'prompts/draft.json'))).toBe(false)
    expect(pendingProjectAssets(run.db)).toEqual([])
    expect(run.store.read((updated.value as Files).files[0]!.blob).toString()).toBe('new selected bytes')
    const preserved = fs.readdirSync(at(run, 'sync-assets/materialize-backups')).map(name => fs.readFileSync(at(run, `sync-assets/materialize-backups/${name}`), 'utf8'))
    expect(preserved.sort()).toEqual(['new selected bytes', 'old author bytes'])
  }, 60000)

  it('does not overwrite an independently edited local source with selected remote bytes', async () => {
    const run = fixture(), original = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'old acknowledged bytes' }))
    select(run, [original]); await materialize(run)
    write(run, 'prompts/draft.json', 'author changed after acknowledgment')
    const remote = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'remote selected bytes' })); select(run, [remote])
    await expect(materialize(run)).rejects.toThrow('PROJECT_SYNC_ASSET_SOURCE_CHANGED')
    expect(fs.readFileSync(at(run, 'prompts/draft.json'), 'utf8')).toBe('author changed after acknowledgment')
    expect(pendingProjectAssets(run.db)).toEqual([{ id: remote.id, selected: remote.value, materialized: original.value }])
    expect(run.store.read((original.value as Files).files[0]!.blob).toString()).toBe('old acknowledged bytes')
  }, 60000)

  it('does not delete an untracked author file while replacing a selected directory layout with a file', async () => {
    const run = fixture(), original = envelope(run, files(run, 'skills/scene', { 'skills/scene/SKILL.md': 'old Skill', 'skills/scene/node/tracked.md': 'tracked old bytes' }, 'skill'))
    select(run, [original]); await materialize(run)
    const remote = envelope(run, files(run, 'skills/scene', { 'skills/scene/SKILL.md': 'remote Skill', 'skills/scene/node': 'selected file layout' }, 'skill'))
    select(run, [remote]); write(run, 'skills/scene/node/author-untracked.txt', 'independent author addition')
    await expect(materialize(run)).rejects.toThrow()
    expect(fs.readFileSync(at(run, 'skills/scene/node/author-untracked.txt'), 'utf8')).toBe('independent author addition')
    expect(pendingProjectAssets(run.db)).toHaveLength(1)
    expect(run.store.read((original.value as Files).files.find(file => file.path.endsWith('tracked.md'))!.blob).toString()).toBe('tracked old bytes')
  }, 60000)

  it('recovers after a restart between owned staging hardlink installation and temp unlink', async () => {
    const run = fixture(), asset = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'fully installed before crash' }))
    select(run, [asset])
    const staging = write(run, `sync-assets/materialize-staging/${randomUUID()}`, 'fully installed before crash')
    fs.mkdirSync(at(run, 'prompts')); fs.linkSync(staging, at(run, 'prompts/draft.json'))
    expect(fs.statSync(at(run, 'prompts/draft.json')).nlink).toBe(2)
    run.db.close(); handles.delete(run.db)
    const reopened = new Database(path.join(run.root, 'project.db')); handles.add(reopened)
    await materializeSelectedProjectAssets({ database: reopened, storageRoot: run.root, revalidate: () => {}, replaceKnowledge: async () => { throw new Error('unexpected knowledge') } })
    expect(fs.existsSync(staging)).toBe(false); expect(fs.statSync(at(run, 'prompts/draft.json')).nlink).toBe(1)
    expect(fs.readFileSync(at(run, 'prompts/draft.json'), 'utf8')).toBe('fully installed before crash')
    expect(pendingProjectAssets(reopened)).toEqual([])
  }, 60000)

  it('rejects external hardlinks while retaining pending intent and all source bytes', async () => {
    const run = fixture(), asset = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'untrusted hardlink bytes' }))
    select(run, [asset]); const external = path.join(run.project, 'external-owned-fixture.txt'); fs.writeFileSync(external, 'untrusted hardlink bytes')
    fs.mkdirSync(at(run, 'prompts')); fs.linkSync(external, at(run, 'prompts/draft.json'))
    fs.mkdirSync(at(run, 'sync-assets/materialize-staging'))
    await expect(materialize(run)).rejects.toThrow('PROJECT_SYNC_ASSET_UNSAFE_PATH')
    expect(fs.readFileSync(external, 'utf8')).toBe('untrusted hardlink bytes')
    expect(pendingProjectAssets(run.db)).toHaveLength(1)
  }, 60000)

  it('keeps pending intent after session invalidation mid-install and resumes in a new session', async () => {
    const run = fixture(), previous = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'previous author bytes before session change' }))
    select(run, [previous]); await materialize(run)
    const asset = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'installed under old lease' }))
    select(run, [asset])
    let failure: unknown
    try { await materialize(run, { revalidate: () => {
      const file = at(run, 'prompts/draft.json')
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'installed under old lease') throw new Error('SYNC_SESSION_STALE')
    } }) }
    catch (error) { failure = error }
    expect(pendingProjectAssets(run.db)).toEqual([{ id: asset.id, selected: asset.value, materialized: previous.value }])
    expect(run.store.read((previous.value as Files).files[0]!.blob).toString()).toBe('previous author bytes before session change')
    expect(run.store.read((asset.value as Files).files[0]!.blob).toString()).toBe('installed under old lease')
    await materialize(run)
    expect(pendingProjectAssets(run.db)).toEqual([])
    expect(fs.readFileSync(at(run, 'prompts/draft.json'), 'utf8')).toBe('installed under old lease')
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('SYNC_SESSION_STALE')
  }, 60000)

  it('keeps superseded bytes and pending intent after an actual filesystem installation failure', async () => {
    const run = fixture(), old = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'old bytes before disk failure' }))
    select(run, [old]); await materialize(run)
    const incoming = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'new bytes awaiting disk' })); select(run, [incoming])
    const actualLink = fs.linkSync
    vi.spyOn(fs, 'linkSync').mockImplementation((existing, target) => {
      if (String(existing).includes(`${path.sep}materialize-staging${path.sep}`)) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' })
      return actualLink(existing, target)
    })
    await expect(materialize(run)).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(pendingProjectAssets(run.db)).toEqual([{ id: incoming.id, selected: incoming.value, materialized: old.value }])
    expect(run.store.read((old.value as Files).files[0]!.blob).toString()).toBe('old bytes before disk failure')
    expect(run.store.read((incoming.value as Files).files[0]!.blob).toString()).toBe('new bytes awaiting disk')
    vi.restoreAllMocks(); await materialize(run)
    expect(fs.readFileSync(at(run, 'prompts/draft.json'), 'utf8')).toBe('new bytes awaiting disk')
  }, 60000)

  it('does not acknowledge a file whose owned staging unlink failed and can recover it later', async () => {
    const run = fixture(), asset = envelope(run, files(run, 'prompts/draft.json', { 'prompts/draft.json': 'bytes with incomplete cleanup' }))
    select(run, [asset]); const unlink = fs.unlinkSync
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (String(file).includes(`${path.sep}materialize-staging${path.sep}`)) throw Object.assign(new Error('synthetic cleanup IO failure'), { code: 'EIO' })
      return unlink(file)
    })
    await expect(materialize(run)).rejects.toThrow()
    expect(pendingProjectAssets(run.db)).toHaveLength(1)
    expect(run.store.read((asset.value as Files).files[0]!.blob).toString()).toBe('bytes with incomplete cleanup')
    vi.restoreAllMocks(); await materialize(run)
    expect(pendingProjectAssets(run.db)).toEqual([])
    expect(fs.statSync(at(run, 'prompts/draft.json')).nlink).toBe(1)
  }, 60000)

  it('keeps selected and previous knowledge bytes pending when the new knowledge callback fails', async () => {
    const run = fixture()
    vi.stubGlobal('fetch', () => { throw new Error('NO_EMBEDDING_NETWORK_IN_REAL_ASSET_TEST') })
    const document = (text: string): SyncKnowledgeDocument => ({ version: 1, docId: 'doc', fileName: 'doc.md', corpusKind: 'project-knowledge',
      importedAt: '2026-10-29T00:00:00Z', logicalSource: { kind: 'legacy-unbound' },
      chunks: [{ id: 'doc:original:0', chunkIndex: 0, text, textHash: hash(Buffer.from(text)), importedAt: '2026-10-29T00:00:00Z' }],
      copy: { availability: 'available', content: text, contentHash: hash(Buffer.from(text)), indexedHash: hash(Buffer.from(text)), edited: false, indexDirty: false } })
    const oldDocument = document('旧知识完整原文。'), newDocument = document('新知识完整原文。')
    const oldBytes = Buffer.from(serializeSyncKnowledgeDocument(oldDocument)), newBytes = Buffer.from(serializeSyncKnowledgeDocument(newDocument))
    const old = envelope(run, { version: 1, category: 'knowledge', documentId: 'doc', blob: run.store.put(oldBytes, 'application/json') })
    select(run, [old]); releases.push(registerSyncKnowledgeReadGuard(run.root, () => selectedKnowledgeAssetHash(run.db)))
    await materialize(run, { replaceKnowledge: async value => {
      await replaceSyncKnowledgeDocuments(run.root, value.selected.map(item => JSON.parse(item.bytes.toString()) as SyncKnowledgeDocument), {
        expectedBeforeHash: hashSyncKnowledgeDocuments([]), selectionHash: value.selectionHash, verifySelected: value.verifySelected })
    } })
    expect(await readSyncKnowledgeDocuments(run.root)).toEqual([oldDocument])
    const previousPointer = fs.readFileSync(at(run, 'knowledge-sync-projection.json'))
    const selected = envelope(run, { version: 1, category: 'knowledge', documentId: 'doc', blob: run.store.put(newBytes, 'application/json') }); select(run, [selected])
    expect(pendingProjectAssets(run.db)).toEqual([{ id: selected.id, selected: selected.value, materialized: old.value }])
    await expect(materialize(run, { replaceKnowledge: async value => {
      expect(value.previous, 'callback previous knowledge records').toEqual([{ documentId: 'doc', bytes: oldBytes }])
      expect(value.selected, 'callback selected knowledge records').toEqual([{ documentId: 'doc', bytes: newBytes }])
      await replaceSyncKnowledgeDocuments(run.root, value.selected.map(item => JSON.parse(item.bytes.toString()) as SyncKnowledgeDocument), {
        expectedBeforeHash: hashSyncKnowledgeDocuments([oldDocument]), selectionHash: value.selectionHash, verifySelected: value.verifySelected,
        onPhase: phase => { if (phase === 'built') throw new Error('INJECTED_NEW_KNOWLEDGE_FAILURE') } })
    } })).rejects.toThrow('INJECTED_NEW_KNOWLEDGE_FAILURE')
    expect(pendingProjectAssets(run.db)).toEqual([{ id: selected.id, selected: selected.value, materialized: old.value }])
    expect(fs.readFileSync(at(run, 'knowledge-sync-projection.json'))).toEqual(previousPointer)
    await expect(readSyncKnowledgeDocuments(run.root)).rejects.toThrow('KNOWLEDGE_SYNC_NOT_READY')
    expect(run.store.read(projectAssetBlobs(old.value)[0]!)).toEqual(oldBytes)
    expect(run.store.read(projectAssetBlobs(selected.value)[0]!)).toEqual(newBytes)
  }, 60000)

  it('materializes equal image content into distinct bound/unassigned physical paths without violating UNIQUE', async () => {
    const run = fixture(); addCharacter(run, 'person-a'); addCharacter(run, 'person-b')
    const blob = run.store.put(png, 'image/png')
    const records = [envelope(run, { version: 1, category: 'avatar', characterId: 'person-a', blob }),
      envelope(run, { version: 1, category: 'avatar', characterId: 'person-b', blob }),
      envelope(run, { version: 1, category: 'unassigned-avatar', originId: 'orphan-image', disposition: 'orphan', candidateCharacterIds: [], blob })]
    select(run, records); await materialize(run)
    const boundPaths = run.db.prepare('SELECT relative_path FROM character_avatar_assets ORDER BY character_id').pluck().all() as string[]
    const orphanPath = run.db.prepare('SELECT preserved_relative_path FROM character_avatar_unresolved').pluck().get() as string
    expect(new Set([...boundPaths, orphanPath]).size).toBe(3)
    for (const relative of [...boundPaths, orphanPath]) expect(fs.readFileSync(at(run, relative))).toEqual(png)
    expect(pendingProjectAssets(run.db)).toEqual([])
  }, 60000)

  it.each(['file-to-directory', 'directory-to-file'])('selects a complete multi-file Skill and partial_arch version across two SQLite replicas (%s)', async direction => {
    const left = fixture(), right = fixture(left.projectId)
    for (const [relative, content] of Object.entries({ 'skills/scene/SKILL.md': 'base Skill', 'skills/scene/node': 'base file', 'partial_arch/node': 'base architecture' })) write(left, relative, content)
    const base = (await source(left)).records; recordCapturedProjectAssets(left.db, base); left.engine.enable()
    copyBlobs(left, right, base); right.engine.join(left.engine.exportBundle()); await materialize(right)
    for (const run of [left, right]) { remove(run, 'skills/scene/node'); remove(run, 'partial_arch/node') }
    const leftDirectory = direction === 'file-to-directory'
    for (const [run, directory, label] of [[left, leftDirectory, 'left'], [right, !leftDirectory, 'right']] as const) {
      write(run, 'skills/scene/SKILL.md', `${label} complete Skill`)
      write(run, directory ? 'skills/scene/node/child.md' : 'skills/scene/node', `${label} chosen Skill layout`)
      write(run, 'skills/scene/extra.md', `${label} extra file`)
      write(run, directory ? 'partial_arch/node/child.json' : 'partial_arch/node', `${label} chosen architecture layout`)
      const records = (await source(run)).records
      run.engine.captureMutation(() => recordCapturedProjectAssets(run.db, records))
    }
    const chosen = captureProjectAssets(left.db).map(record => ({ id: record.id, value: parseProjectAuthorAsset(record.value) }))
    const losingBytes = captureProjectAssets(right.db).flatMap(record => projectAssetBlobs(parseProjectAuthorAsset(record.value)))
      .map(blob => ({ blob, bytes: right.store.read(blob) }))
    copyBlobs(left, right, chosen)
    const preview = right.engine.receive(left.engine.exportBundle()); expect(preview.conflicts).toHaveLength(2)
    const choices = preview.conflicts.map(conflict => {
      const wanted = chosen.find(record => record.id === conflict.id)!
      const selected = conflict.variants.find(variant => syncDigest(variant.value) === syncDigest(wanted.value))!
      expect(selected).toBeDefined()
      return { kind: 'project-asset', id: conflict.id, expectedHeads: conflict.variants.map(variant => variant.revision), selectedRevision: selected.revision }
    })
    expect(right.engine.apply(preview.token, choices).applied).toBe(true)
    await materialize(right)
    for (const record of chosen) if (record.value.category === 'files') for (const file of record.value.files) expect(fs.readFileSync(at(right, file.path))).toEqual(left.store.read(file.blob))
    for (const record of chosen) if (record.value.category === 'files') for (const file of record.value.files) expect(fs.readFileSync(at(left, file.path))).toEqual(left.store.read(file.blob))
    for (const saved of losingBytes) expect(right.store.read(saved.blob)).toEqual(saved.bytes)
    expect(fs.readFileSync(at(right, 'skills/scene/SKILL.md'), 'utf8')).toBe('left complete Skill')
    expect(fs.readFileSync(at(right, 'skills/scene/extra.md'), 'utf8')).toBe('left extra file')
    expect(pendingProjectAssets(right.db)).toEqual([])
  }, 60000)
})
