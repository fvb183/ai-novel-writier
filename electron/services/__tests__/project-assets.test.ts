import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ProjectAssetBlobStore } from '../project-asset-blob-store'
import { referencedProjectAssetBlobs, validateInlineProjectAssetBlobs } from '../project-sync-asset-manifest'
import type { SyncBundle } from '../../../src/shared/project-sync'
import { parseProjectAuthorAsset, projectAssetPathKey, projectPromptAssetGroup, validateProjectAssetSet, type ProjectAssetBlob } from '../../../src/shared/project-sync-assets'

const roots: string[] = []
const temporary = () => { const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ainw-assets-'))); roots.push(root); return root }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const descriptor = (bytes: Uint8Array, mime = 'application/octet-stream'): ProjectAssetBlob => ({
  sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length, mime,
})
const prompt = (name = 'prompts/draft.zh-CN.json') => ({ version: 1, category: 'files', group: 'prompt', logicalName: projectPromptAssetGroup(name),
  files: [{ path: name, blob: descriptor(Buffer.from('模板正文'), 'application/json') }] })

describe('portable author-asset protocol boundaries', () => {
  it('retains compact alternatives and the adopted display view with empty legacy batches and verifies their inline bytes', () => {
    const left = Buffer.from('current knowledge'), right = Buffer.from('conflicting knowledge'), adopted = Buffer.from('still displayed knowledge')
    const a = descriptor(left, 'application/json'), b = descriptor(right, 'application/json'), c = descriptor(adopted, 'application/json')
    const bundle = { batches: [], compact: { records: [{ kind: 'project-asset', id: 'knowledge', heads: [
      { deleted: false, value: { version: 1, category: 'knowledge', documentId: 'source', blob: a } },
      { deleted: false, value: { version: 1, category: 'knowledge', documentId: 'source', blob: b } },
      { deleted: true, value: null },
    ] }], accepted: [{ kind: 'project-asset', heads: [{ deleted: false, value: { version: 1, category: 'knowledge', documentId: 'source', blob: c } }] }] }, inlineBlobs: [
      { sha256: a.sha256, byteSize: a.byteSize, base64: left.toString('base64') },
      { sha256: b.sha256, byteSize: b.byteSize, base64: right.toString('base64') },
      { sha256: c.sha256, byteSize: c.byteSize, base64: adopted.toString('base64') },
    ] }
    expect(referencedProjectAssetBlobs(bundle)).toEqual([a, b, c].sort((x, y) => x.sha256.localeCompare(y.sha256)))
    expect(() => validateInlineProjectAssetBlobs(bundle as unknown as SyncBundle)).not.toThrow()
    expect(() => validateInlineProjectAssetBlobs({ ...bundle, inlineBlobs: [bundle.inlineBlobs[0]] } as unknown as SyncBundle))
      .toThrow('PROJECT_SYNC_ASSET_INLINE_INCOMPLETE')
  })
  it('keeps full skill directory in one version and independent logical files distinct', () => {
    const blob = descriptor(Buffer.from('skill'))
    const skill = { version: 1, category: 'files', group: 'skill', logicalName: 'skills/scene', files: [
      { path: 'skills/scene/SKILL.md', blob }, { path: 'skills/scene/examples/scene.txt', blob },
    ] }
    expect(parseProjectAuthorAsset(skill)).toMatchObject({ ...skill, files: expect.arrayContaining(skill.files) })
    validateProjectAssetSet([{ id: randomUUID(), value: parseProjectAuthorAsset(prompt()) },
      { id: randomUUID(), value: parseProjectAuthorAsset(prompt('prompts/review.zh-CN.json')) }])
    expect(() => parseProjectAuthorAsset({ ...skill, files: [...skill.files, { path: 'skills/other/script.js', blob }] })).toThrow('PROJECT_SYNC_ASSET_INVALID')
  })
  it.each(['../draft.json', '/tmp/draft.json', 'prompts/C:evil', 'prompts/CON.json', 'prompts/a. ',
    'prompts/../draft.json', 'prompts\\draft.json', 'prompts/ＣＯＮ.json', 'prompts/．．/draft.json'])('rejects unsafe portable name %s', name => {
    expect(() => projectAssetPathKey(name)).toThrow('PROJECT_SYNC_ASSET_INVALID')
  })
  it('rejects cross-record NFKC/case collisions without merging same-content entities', () => {
    expect(() => validateProjectAssetSet(['prompts/Ａ.json', 'prompts/a.json'].map(name => ({
      id: randomUUID(), value: parseProjectAuthorAsset(prompt(name)),
    })))).toThrow('PROJECT_SYNC_ASSET_NAME_CONFLICT')
  })
  it('rejects a nonadjacent file/ancestor conflict inside one skill directory', () => {
    const blob = descriptor(Buffer.from('asset'))
    const value = parseProjectAuthorAsset({ version: 1, category: 'files', group: 'skill', logicalName: 'skills/scene',
      files: ['skills/scene/a', 'skills/scene/a-file', 'skills/scene/a/x'].map(path => ({ path, blob })) })
    expect(() => validateProjectAssetSet([{ id: randomUUID(), value }])).toThrow('PROJECT_SYNC_ASSET_NAME_CONFLICT')
  })
  it('keeps partial architecture in one aggregate so offline file-vs-directory changes share a conflict identity', () => {
    const blob = descriptor(Buffer.from('author'))
    expect(parseProjectAuthorAsset({ version: 1, category: 'files', group: 'author-content', logicalName: 'partial_arch',
      files: [{ path: 'partial_arch/a/ch1.json', blob }] })).toMatchObject({ logicalName: 'partial_arch' })
    expect(() => parseProjectAuthorAsset({ version: 1, category: 'files', group: 'author-content', logicalName: 'partial_arch/a',
      files: [{ path: 'partial_arch/a', blob }] })).toThrow('PROJECT_SYNC_ASSET_INVALID')
  })
  it('keeps a legacy Chinese template and its explicit locale version in one record while separating English', () => {
    const blob = descriptor(Buffer.from('template'), 'application/json')
    expect(projectPromptAssetGroup('prompts/foo.json')).toBe(projectPromptAssetGroup('prompts/foo.zh-CN.json'))
    expect(projectPromptAssetGroup('prompts/foo.en-US.json')).not.toBe(projectPromptAssetGroup('prompts/foo.json'))
    const value = { version: 1, category: 'files', group: 'prompt', logicalName: 'prompts/foo.zh-cn.json',
      files: ['prompts/foo.json', 'prompts/foo.zh-CN.json'].map(path => ({ path, blob })) }
    expect(parseProjectAuthorAsset(value)).toMatchObject({ files: expect.arrayContaining(value.files) })
    expect(() => parseProjectAuthorAsset({ ...value, files: [...value.files, { path: 'prompts/foo.en-US.json', blob }] })).toThrow('PROJECT_SYNC_ASSET_INVALID')
  })
  it('requires a real roster identity for a bound avatar and preserves unattached bytes/reference-only records', () => {
    const avatar = { version: 1, category: 'avatar', characterId: 'person-a', blob: descriptor(Buffer.from('PNG'), 'image/png') }
    expect(() => validateProjectAssetSet([{ id: randomUUID(), value: parseProjectAuthorAsset(avatar) }], new Set(['person-b'])))
      .toThrow('PROJECT_SYNC_ASSET_OWNER_MISSING')
    const unresolved = { version: 1, category: 'unassigned-avatar', originId: 'old-id', disposition: 'reference-only', candidateCharacterIds: ['person-a'], blob: null }
    expect(parseProjectAuthorAsset(unresolved)).toEqual(unresolved)
    expect(() => parseProjectAuthorAsset({ ...unresolved, blob: avatar.blob })).toThrow('PROJECT_SYNC_ASSET_INVALID')
    expect(parseProjectAuthorAsset({ ...unresolved, disposition: 'unknown-fork', blob: descriptor(Buffer.from('opaque')) })).toMatchObject({ disposition: 'unknown-fork' })
  })
  it('rejects additional machine authority and malformed hash/length before storage', () => {
    expect(() => parseProjectAuthorAsset({ ...prompt(), absolutePath: 'C:/private' })).toThrow('PROJECT_SYNC_ASSET_INVALID')
    expect(() => parseProjectAuthorAsset({ version: 1, category: 'knowledge', documentId: 'doc',
      blob: { sha256: 'bad', byteSize: 1, mime: 'application/json' } })).toThrow('PROJECT_SYNC_ASSET_INVALID')
  })
})

describe('real immutable CAS receive and restart', () => {
  it('reclaims only unreachable CAS objects while retaining current/conflicting bytes and all author and unknown files', () => {
    const root = temporary(), store = new ProjectAssetBlobStore(root)
    const current = store.put(Buffer.from('current')), conflict = store.put(Buffer.from('unresolved')), old = store.put(Buffer.from('obsolete'))
    fs.writeFileSync(path.join(root, 'author.txt'), 'author source')
    fs.writeFileSync(path.join(store.root, '.unknown-local-file'), 'keep')
    const result = store.pruneUnreferenced([current, conflict])
    expect(result).toEqual({ deleted: 1, reclaimedBytes: old.byteSize })
    expect(store.read(current).toString()).toBe('current'); expect(store.read(conflict).toString()).toBe('unresolved')
    expect(store.contains(old)).toBe(false)
    expect(fs.readFileSync(path.join(root, 'author.txt'), 'utf8')).toBe('author source')
    expect(fs.readFileSync(path.join(store.root, '.unknown-local-file'), 'utf8')).toBe('keep')
  })
  it('skips local collection during an active receive and can reclaim afterward', () => {
    const store = new ProjectAssetBlobStore(temporary()), old = store.put(Buffer.from('old')), next = descriptor(Buffer.from('new'))
    const writer = store.createWriter(next); writer.write(Buffer.from('new'))
    expect(store.pruneUnreferenced([])).toEqual({ deleted: 0, reclaimedBytes: 0 })
    expect(store.contains(old)).toBe(true)
    writer.abort(); expect(store.pruneUnreferenced([]).deleted).toBe(1)
  })
  it('preserves an object identity replaced during the last collection check', () => {
    const store = new ProjectAssetBlobStore(temporary()), old = store.put(Buffer.from('old')), file = path.join(store.root, old.sha256)
    let checks = 0
    expect(store.pruneUnreferenced([], () => {
      if (++checks === 3) { fs.renameSync(file, path.join(store.root, '.race-preserved')); fs.writeFileSync(file, 'concurrent replacement') }
    }).deleted).toBe(0)
    expect(fs.readFileSync(file, 'utf8')).toBe('concurrent replacement')
    expect(fs.readFileSync(path.join(store.root, '.race-preserved'), 'utf8')).toBe('old')
  })
  it.each(['same-size-write', 'new-inode'])('checks dormant presence without scanning bytes and rejects %s when the object is used', mutation => {
    const store = new ProjectAssetBlobStore(temporary()), blob = store.put(Buffer.from('original'))
    const file = path.join(store.root, blob.sha256), source = store.source(blob)
    const reads = vi.spyOn(fs, 'readSync')
    expect(store.contains(blob)).toBe(true)
    expect(reads).not.toHaveBeenCalled()
    if (mutation === 'new-inode') fs.renameSync(file, path.join(store.root, 'superseded-test-inode'))
    fs.writeFileSync(file, Buffer.from('changed!'))
    expect(store.contains(blob)).toBe(true)
    expect(reads).not.toHaveBeenCalled()
    expect(() => store.read(blob)).toThrow('PROJECT_SYNC_ASSET_HASH_MISMATCH')
    expect(() => source.read(0, blob.byteSize)).toThrow('PROJECT_SYNC_ASSET_SOURCE_CHANGED')
  })
  it('keeps missing, malformed and truncated dormant objects distinct', () => {
    const store = new ProjectAssetBlobStore(temporary()), blob = store.put(Buffer.from('original'))
    fs.unlinkSync(path.join(store.root, blob.sha256)); expect(store.contains(blob)).toBe(false)
    fs.writeFileSync(path.join(store.root, blob.sha256), 'short')
    expect(() => store.contains(blob)).toThrow('PROJECT_SYNC_ASSET_HASH_MISMATCH')
  })
  it('streams between two independent stores and survives a reopened instance with byte identity', () => {
    const left = new ProjectAssetBlobStore(temporary()), rightRoot = temporary(), right = new ProjectAssetBlobStore(rightRoot)
    const bytes = Buffer.concat([Buffer.from('多端原文🌙'), Buffer.alloc(800_000, 71)])
    const blob = left.put(bytes), source = left.source(blob), writer = right.createWriter(blob)
    for (let offset = 0; offset < source.byteSize; offset += 128_000) writer.write(source.read(offset, Math.min(128_000, source.byteSize - offset)))
    writer.complete()
    expect(new ProjectAssetBlobStore(rightRoot).read(blob)).toEqual(bytes)
    expect(source.md5).toBe(createHash('md5').update(bytes).digest('hex'))
    expect(fs.readdirSync(right.root)).toEqual([blob.sha256])
  })
  it('does not publish partial/truncated/mismatched downloads and cleans only the owned receive', () => {
    const store = new ProjectAssetBlobStore(temporary()), bytes = Buffer.from('frozen input'), blob = descriptor(bytes)
    const first = store.createWriter(blob); first.write(bytes.subarray(0, 2))
    expect(() => first.complete()).toThrow('PROJECT_SYNC_ASSET_HASH_MISMATCH')
    const second = store.createWriter(blob); second.write(Buffer.alloc(bytes.length, 42))
    expect(() => second.complete()).toThrow('PROJECT_SYNC_ASSET_HASH_MISMATCH')
    const third = store.createWriter(blob); third.write(bytes); third.abort()
    expect(store.has(blob)).toBe(false)
    expect(fs.readdirSync(store.root)).toEqual([])
  })
  it('revalidates lease immediately before immutable install', () => {
    const store = new ProjectAssetBlobStore(temporary()), bytes = Buffer.from('lease'), blob = descriptor(bytes), writer = store.createWriter(blob)
    writer.write(bytes)
    expect(() => writer.complete(() => { throw new Error('SYNC_SESSION_STALE') })).toThrow('SYNC_SESSION_STALE')
    expect(store.has(blob)).toBe(false)
  })
  it('deduplicates identical objects, supports empty documents, and refuses corrupt existing identity', () => {
    const store = new ProjectAssetBlobStore(temporary()), bytes = Buffer.from('shared'), blob = store.put(bytes)
    expect(store.put(bytes)).toEqual(blob)
    const empty = store.put(Buffer.alloc(0)); expect(store.read(empty).length).toBe(0)
    fs.writeFileSync(path.join(store.root, blob.sha256), Buffer.from('broken'))
    expect(() => store.put(bytes)).toThrow('PROJECT_SYNC_ASSET_HASH_MISMATCH')
  })
  it('detects CAS mutation after source preflight without uploading substituted bytes', () => {
    const store = new ProjectAssetBlobStore(temporary()), blob = store.put(Buffer.from('original')), source = store.source(blob)
    fs.writeFileSync(path.join(store.root, blob.sha256), Buffer.from('changed!'))
    expect(() => source.read(0, blob.byteSize)).toThrow('PROJECT_SYNC_ASSET_SOURCE_CHANGED')
  })
  it('imports a local source by bytes and rejects hard-linked sources', () => {
    const storage = temporary(), store = new ProjectAssetBlobStore(storage), original = path.join(storage, 'source')
    fs.writeFileSync(original, 'author saved bytes')
    const blob = store.importFile(original, 'text/plain'); expect(store.read(blob).toString()).toBe('author saved bytes')
    const linked = path.join(storage, 'linked'); fs.linkSync(original, linked)
    expect(() => store.importFile(linked, 'text/plain')).toThrow('PROJECT_SYNC_ASSET_UNSAFE_PATH')
  })
  it('rejects a junction replacing the controlled CAS directory and preserves its target', () => {
    const storage = temporary(), foreign = temporary(), store = new ProjectAssetBlobStore(storage)
    const preserved = path.join(foreign, 'preserve.txt'); fs.writeFileSync(preserved, 'untouched')
    fs.rmdirSync(store.root)
    fs.symlinkSync(foreign, store.root, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => store.put(Buffer.from('unexpected'))).toThrow('PROJECT_SYNC_ASSET_UNSAFE_PATH')
    expect(fs.readFileSync(preserved, 'utf8')).toBe('untouched')
    expect(fs.readdirSync(foreign)).toEqual(['preserve.txt'])
  })
  it('recovers the crash window after exclusive install but before unlinking its owned temporary hard link', () => {
    const storage = temporary(), store = new ProjectAssetBlobStore(storage), bytes = Buffer.from('complete installed bytes'), blob = descriptor(bytes)
    const temporaryFile = path.join(store.root, `.incoming-${randomUUID()}`), installed = path.join(store.root, blob.sha256)
    fs.writeFileSync(temporaryFile, bytes); fs.linkSync(temporaryFile, installed)
    expect(fs.lstatSync(installed).nlink).toBe(2)
    expect(new ProjectAssetBlobStore(storage).read(blob)).toEqual(bytes)
    expect(fs.lstatSync(installed).nlink).toBe(1)
    expect(fs.existsSync(temporaryFile)).toBe(false)
  })
  it('refuses recovery if an unaccounted external hard link exists, preserving all bytes', () => {
    const storage = temporary(), foreign = temporary(), store = new ProjectAssetBlobStore(storage)
    const bytes = Buffer.from('linked outside'), blob = descriptor(bytes), external = path.join(foreign, 'source')
    fs.writeFileSync(external, bytes)
    const temporaryFile = path.join(store.root, `.incoming-${randomUUID()}`), installed = path.join(store.root, blob.sha256)
    fs.linkSync(external, temporaryFile); fs.linkSync(external, installed)
    expect(() => new ProjectAssetBlobStore(storage).read(blob)).toThrow('PROJECT_SYNC_ASSET_UNSAFE_PATH')
    expect(fs.readFileSync(external)).toEqual(bytes)
    expect(fs.existsSync(temporaryFile)).toBe(true)
  })
})
