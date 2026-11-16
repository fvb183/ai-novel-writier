import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ProjectAssetBlobStore } from '../project-asset-blob-store'
import { previewProjectAuthorAsset } from '../project-asset-preview'
import { syncKnowledgeTextHash } from '../../../src/shared/project-sync-knowledge'
import type { ProjectAuthorAsset } from '../../../src/shared/project-sync-assets'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ainw-asset-preview-'))); roots.push(root)
  return new ProjectAssetBlobStore(root)
}
describe('read-only author version previews from verified CAS bytes', () => {
  it('paginates an actual UTF-8 file without splitting an emoji and rejects a path outside the selected manifest', () => {
    const store = fixture(), text = `${'a'.repeat(32 * 1024 - 1)}🌙中文后续`, blob = store.put(Buffer.from(text), 'application/json')
    const asset: ProjectAuthorAsset = { version: 1, category: 'files', group: 'prompt', logicalName: 'prompts/draft.zh-cn.json',
      files: [{ path: 'prompts/draft.zh-CN.json', blob }] }
    const first = previewProjectAuthorAsset(asset, store, {}), second = previewProjectAuthorAsset(asset, store, { offset: first.nextOffset })
    expect(first.text! + second.text!).toBe(text)
    expect(first.text).not.toContain('�'); expect(second.text).not.toContain('�')
    expect(second.nextOffset).toBeUndefined()
    expect(() => previewProjectAuthorAsset(asset, store, { filePath: '../private' })).toThrow('SYNC_ASSET_PREVIEW_INVALID')
    expect(() => previewProjectAuthorAsset(asset, store, { offset: blob.byteSize + 1 })).toThrow('SYNC_ASSET_PREVIEW_INVALID')
    expect(store.read(blob).toString()).toBe(text)
  })
  it('distinguishes an empty author file from binary or invalid text', () => {
    const store = fixture()
    for (const [bytes, binary] of [[Buffer.alloc(0), false], [Buffer.from([0x80, 0x81]), true], [Buffer.from([0, 1, 2]), true]] as const) {
      const result = previewProjectAuthorAsset({ version: 1, category: 'files', group: 'skill', logicalName: 'skills/a',
        files: [{ path: 'skills/a/example.bin', blob: store.put(bytes) }] }, store, {})
      expect(result.binary === true).toBe(binary)
      if (!binary) expect(result.text).toBe('')
    }
  })
  it('shows dirty original text and explicitly distinguishes unavailable originals from indexed chunks', () => {
    const store = fixture(), original = `${'a'.repeat(32 * 1024 - 1)}🌙当前原文`, indexed = '上次索引分块'
    const document = { version: 1, docId: 'doc-a', fileName: '知识资料.txt', corpusKind: 'project-knowledge', importedAt: '2026-10-29T00:00:00Z',
      logicalSource: { kind: 'legacy-unbound' }, chunks: [{ id: 'chunk-a', chunkIndex: 0, text: indexed, textHash: syncKnowledgeTextHash(indexed), importedAt: '2026-10-29T00:00:00Z' }],
      copy: { availability: 'available', content: original, contentHash: syncKnowledgeTextHash(original), indexedHash: syncKnowledgeTextHash(indexed), edited: true, indexDirty: true } }
    const asset: ProjectAuthorAsset = { version: 1, category: 'knowledge', documentId: 'doc-a', blob: store.put(Buffer.from(JSON.stringify(document)), 'application/json') }
    const first = previewProjectAuthorAsset(asset, store, {}), second = previewProjectAuthorAsset(asset, store, { offset: first.nextOffset })
    expect(first.document).toMatchObject({ originalAvailable: true, indexDirty: true, chunkCount: 1 })
    expect(first.text! + second.text!).toBe(original)
    const unavailable = { ...document, copy: { availability: 'unavailable' } }
    const source = { ...asset, blob: store.put(Buffer.from(JSON.stringify(unavailable)), 'application/json') }
    expect(previewProjectAuthorAsset(source, store, {})).toMatchObject({ text: indexed, document: { originalAvailable: false, indexDirty: false } })
  })
  it('returns an image preview for a valid avatar and keeps a reference-only record distinct', () => {
    const store = fixture(), bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
    const image = previewProjectAuthorAsset({ version: 1, category: 'avatar', characterId: 'person-a', blob: store.put(bytes, 'image/png') }, store, {})
    expect(image.image?.mime).toBe('image/png'); expect(Buffer.from(image.image!.base64, 'base64').length).toBeGreaterThan(0)
    const reference = previewProjectAuthorAsset({ version: 1, category: 'unassigned-avatar', originId: 'unresolved', disposition: 'reference-only', candidateCharacterIds: [], blob: null }, store, {})
    expect(reference.image).toBeUndefined(); expect(reference.byteSize).toBeUndefined()
  })
})
