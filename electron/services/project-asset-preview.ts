import { type ProjectAssetPreview, type ProjectAuthorAsset } from '../../src/shared/project-sync-assets'
import { parseSyncKnowledgeDocument } from '../../src/shared/project-sync-knowledge'
import { ProjectAssetBlobStore } from './project-asset-blob-store'
import { avatarMime, compressAvatarImage, detectAvatarExtension } from './avatar-image'

const PAGE = 32 * 1024
function fail(): never { throw new Error('SYNC_ASSET_PREVIEW_INVALID') }
function offset(value: unknown): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail()
  return Number(value)
}
function textPage(text: string, position: number): Pick<ProjectAssetPreview, 'text' | 'offset' | 'nextOffset'> {
  if (position > text.length) fail()
  let start = position, end = Math.min(text.length, start + PAGE)
  if (start && /[\uDC00-\uDFFF]/.test(text[start] ?? '') && /[\uD800-\uDBFF]/.test(text[start - 1] ?? '')) start++
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
  return { text: text.slice(start, end), offset: start, ...(end < text.length ? { nextOffset: end } : {}) }
}
/** Preview only a manifest already selected by the controller from current conflict heads.
 * No arbitrary renderer hash or path is accepted as authority to read a blob. */
export function previewProjectAuthorAsset(asset: ProjectAuthorAsset, store: ProjectAssetBlobStore,
  request: { filePath?: unknown; offset?: unknown }): ProjectAssetPreview {
  const position = offset(request.offset)
  if (asset.category === 'files') {
    const file = request.filePath === undefined ? asset.files[0] : asset.files.find(file => file.path === request.filePath)
    if (!file) fail()
    const result: ProjectAssetPreview = { category: 'files', title: asset.logicalName, filePaths: asset.files.map(file => file.path),
      filePath: file.path, byteSize: file.blob.byteSize }
    if (position > file.blob.byteSize) fail()
    const source = store.source(file.blob)
    const buffer = source.read(position, Math.min(PAGE + 4, source.byteSize - position))
    let start = 0, end = Math.min(PAGE, buffer.length)
    if (!position && buffer.length && (buffer[0]! & 0xc0) === 0x80) return { ...result, binary: true }
    while (start < end && (buffer[start]! & 0xc0) === 0x80) start++
    if (position + end < source.byteSize) {
      let last = end - 1
      while (last >= start && (buffer[last]! & 0xc0) === 0x80) last--
      const lead = buffer[last] ?? 0, length = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead <= 0xef ? 3 : 4
      if (end - last < length) end = last
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(start, end))
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return { ...result, binary: true }
      return { ...result, text, offset: position + start, ...(position + end < source.byteSize ? { nextOffset: position + end } : {}) }
    } catch { return { ...result, binary: true } }
  }
  if (request.filePath !== undefined) fail()
  if (asset.category === 'knowledge') {
    const document = parseSyncKnowledgeDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(store.read(asset.blob))))
    if (document.docId !== asset.documentId) fail()
    const available = document.copy.availability === 'available'
    const text = document.copy.availability === 'available' ? document.copy.content : document.chunks.map(chunk => chunk.text).join('\n\n')
    return { category: 'knowledge', title: document.fileName, byteSize: asset.blob.byteSize,
      document: { corpusKind: document.corpusKind, chunkCount: document.chunks.length, originalAvailable: available,
        indexDirty: document.copy.availability === 'available' && document.copy.indexDirty }, ...textPage(text, position) }
  }
  if (position) fail()
  const title = asset.category === 'avatar' ? asset.characterId : asset.originId
  if (!asset.blob) return { category: asset.category, title }
  const bytes = store.read(asset.blob, 20 * 1024 * 1024), extension = detectAvatarExtension(bytes)
  if (!extension) return { category: asset.category, title, byteSize: bytes.length, binary: true }
  const preview = compressAvatarImage(bytes, extension)
  return { category: asset.category, title, byteSize: bytes.length,
    ...(preview.bytes.length <= 4 * 1024 * 1024 ? { image: { mime: avatarMime(preview.extension), base64: preview.bytes.toString('base64') } } : { binary: true }) }
}
