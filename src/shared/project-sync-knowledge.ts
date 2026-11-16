import { createHash } from 'node:crypto'
import { Buffer } from 'buffer'

/** Canonical author content. No paths, vector spaces, task receipts or capabilities. */
export type SyncKnowledgeCorpusKind = 'reference' | 'project-knowledge' | 'unknown'
export interface SyncKnowledgeChunk {
  id: string; chunkIndex: number; text: string; textHash: string; importedAt: string
  chapterNumber?: number; chapterTitle?: string
}
export type SyncKnowledgeLogicalSource = { kind: 'legacy-unbound' } | { kind: 'bound'; references: Array<{
  type: 'draft' | 'story-node' | 'route' | 'finalization' | 'import'; id: string; contentHash: string
}> }
export interface SyncKnowledgeDocument {
  version: 1; docId: string; fileName: string; corpusKind: SyncKnowledgeCorpusKind; importedAt: string
  logicalSource: SyncKnowledgeLogicalSource
  chunks: SyncKnowledgeChunk[]
  copy: { availability: 'unavailable' } | { availability: 'available'; content: string; contentHash: string;
    indexedHash: string; edited: boolean; indexDirty: boolean }
}
export const MAX_SYNC_KNOWLEDGE_BYTES = 64 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/
function fail(): never { throw new Error('SYNC_KNOWLEDGE_INVALID') }
export const syncKnowledgeTextHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) ? value as Record<string, unknown> : fail()
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail()
}
function text(value: unknown, maximum = 512, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > maximum || value.includes('\0')) fail()
  return value
}
function hash(value: unknown): string { return typeof value === 'string' && HASH.test(value) ? value : fail() }
function identity(value: unknown): string {
  const id = text(value)
  if (/[/\\\u0000-\u001f\u007f]/.test(id)) fail()
  return id
}
function source(value: unknown): SyncKnowledgeLogicalSource {
  const item = record(value)
  if (item.kind === 'legacy-unbound') { keys(item, ['kind']); return { kind: 'legacy-unbound' } }
  keys(item, ['kind', 'references'])
  if (item.kind !== 'bound' || !Array.isArray(item.references) || !item.references.length || item.references.length > 128) fail()
  const seen = new Set<string>()
  const references = item.references.map(raw => {
    const ref = record(raw); keys(ref, ['type', 'id', 'contentHash'])
    if (!['draft', 'story-node', 'route', 'finalization', 'import'].includes(String(ref.type))) fail()
    const id = identity(ref.id), key = `${ref.type}:${id}`
    if (seen.has(key)) fail(); seen.add(key)
    return { type: ref.type as Extract<SyncKnowledgeLogicalSource, { kind: 'bound' }>['references'][number]['type'], id, contentHash: hash(ref.contentHash) }
  }).sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id))
  return { kind: 'bound', references }
}
export function parseSyncKnowledgeDocument(value: unknown): SyncKnowledgeDocument {
  const item = record(value)
  keys(item, ['version', 'docId', 'fileName', 'corpusKind', 'importedAt', 'logicalSource', 'chunks', 'copy'])
  if (item.version !== 1 || !['reference', 'project-knowledge', 'unknown'].includes(String(item.corpusKind))) fail()
  const docId = identity(item.docId), fileName = text(item.fileName), normalized = fileName.normalize('NFKC')
  if (/[/\\<>:"|?*\u0000-\u001f\u007f]/.test(normalized) || /[. ]$/.test(normalized)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized)) fail()
  if (!Array.isArray(item.chunks) || !item.chunks.length || item.chunks.length > 100_000) fail()
  const ids = new Set<string>()
  const chunks = item.chunks.map((raw, index): SyncKnowledgeChunk => {
    const chunk = record(raw); keys(chunk, ['id', 'chunkIndex', 'text', 'textHash', 'importedAt'], ['chapterNumber', 'chapterTitle'])
    const id = identity(chunk.id), body = text(chunk.text, MAX_SYNC_KNOWLEDGE_BYTES, true), textHash = hash(chunk.textHash)
    if (ids.has(id) || chunk.chunkIndex !== index || syncKnowledgeTextHash(body) !== textHash) fail()
    ids.add(id)
    if (chunk.chapterNumber !== undefined && (!Number.isSafeInteger(chunk.chapterNumber) || Number(chunk.chapterNumber) < 0 || Number(chunk.chapterNumber) > 2147483647)) fail()
    return { id, chunkIndex: index, text: body, textHash, importedAt: text(chunk.importedAt),
      ...(chunk.chapterNumber === undefined ? {} : { chapterNumber: Number(chunk.chapterNumber) }),
      ...(chunk.chapterTitle === undefined ? {} : { chapterTitle: text(chunk.chapterTitle, 4096, true) }) }
  })
  const copy = record(item.copy)
  let parsedCopy: SyncKnowledgeDocument['copy']
  if (copy.availability === 'unavailable') { keys(copy, ['availability']); parsedCopy = { availability: 'unavailable' } }
  else {
    keys(copy, ['availability', 'content', 'contentHash', 'indexedHash', 'edited', 'indexDirty'])
    const content = text(copy.content, MAX_SYNC_KNOWLEDGE_BYTES, true), contentHash = hash(copy.contentHash), indexedHash = hash(copy.indexedHash)
    if (copy.availability !== 'available' || typeof copy.edited !== 'boolean' || typeof copy.indexDirty !== 'boolean'
      || syncKnowledgeTextHash(content) !== contentHash || (!copy.indexDirty && contentHash !== indexedHash)) fail()
    parsedCopy = { availability: 'available', content, contentHash, indexedHash, edited: copy.edited, indexDirty: copy.indexDirty }
  }
  const result: SyncKnowledgeDocument = { version: 1, docId, fileName, corpusKind: item.corpusKind as SyncKnowledgeCorpusKind,
    importedAt: text(item.importedAt), logicalSource: source(item.logicalSource), chunks, copy: parsedCopy }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SYNC_KNOWLEDGE_BYTES) fail()
  return result
}
export function parseSyncKnowledgeDocuments(value: unknown): SyncKnowledgeDocument[] {
  if (!Array.isArray(value) || value.length > 10_000) fail()
  const documents = value.map(parseSyncKnowledgeDocument).sort((a, b) => a.docId.localeCompare(b.docId))
  const docs = new Set<string>(), chunks = new Set<string>()
  for (const document of documents) {
    if (docs.has(document.docId)) fail(); docs.add(document.docId)
    for (const chunk of document.chunks) { if (chunks.has(chunk.id)) fail(); chunks.add(chunk.id) }
  }
  return documents
}
export const serializeSyncKnowledgeDocument = (value: unknown): string => JSON.stringify(parseSyncKnowledgeDocument(value))
export const hashSyncKnowledgeDocuments = (value: unknown): string => syncKnowledgeTextHash(JSON.stringify(parseSyncKnowledgeDocuments(value)))
