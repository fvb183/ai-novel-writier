/** Author assets contain portable logical names and immutable bytes, never local paths or capabilities. */
export const PROJECT_ASSET_FEATURE = 'project-assets-v1' as const
export const MAX_PROJECT_ASSET_BYTES = 2 * 1024 ** 3
export const MAX_PROJECT_ASSET_FILES = 10_000
export type ProjectAssetBlob = { sha256: string; byteSize: number; mime: string }
export type ProjectAssetFile = { path: string; blob: ProjectAssetBlob }
export type ProjectAuthorAsset =
  | { version: 1; category: 'files'; group: 'prompt' | 'skill' | 'skill-bindings' | 'author-content'; logicalName: string; files: ProjectAssetFile[] }
  | { version: 1; category: 'avatar'; characterId: string; blob: ProjectAssetBlob }
  | { version: 1; category: 'unassigned-avatar'; originId: string; disposition: 'orphan' | 'ambiguous' | 'unknown-fork' | 'reference-only'; candidateCharacterIds: string[]; blob: ProjectAssetBlob | null }
  | { version: 1; category: 'knowledge'; documentId: string; blob: ProjectAssetBlob }

export interface ProjectAssetEnvelope { id: string; value: ProjectAuthorAsset }
export interface ProjectAssetPreview {
  category: ProjectAuthorAsset['category']
  title: string
  deleted?: boolean
  filePaths?: string[]
  filePath?: string
  byteSize?: number
  text?: string
  binary?: boolean
  offset?: number
  nextOffset?: number
  image?: { mime: string; base64: string }
  document?: { corpusKind: string; chunkCount: number; originalAvailable: boolean; indexDirty: boolean }
}
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[45][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp']
function fail(): never { throw new Error('PROJECT_SYNC_ASSET_INVALID') }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)) ? value as Record<string, unknown> : fail()
}
function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).sort().join(',') !== [...names].sort().join(',')) fail()
}
function bounded(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail()
  return value
}

/** This key is also used on Android: collisions are rejected before any path is materialized. */
export function projectAssetPathKey(value: unknown): string {
  const name = bounded(value, 1024)
  if (name.includes('\\') || name.startsWith('/') || name.includes(':')) fail()
  const parts = name.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>"|?*]/.test(part)
    || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail()
  // Normalize before repeating the safety check: full-width punctuation must not bypass it.
  const normalized = name.normalize('NFKC').toLowerCase()
  if (normalized !== name && (normalized.includes('\\') || normalized.includes(':')
    || normalized.split('/').some(part => !part || part === '.' || part === '..' || /[<>"|?*]/.test(part)
      || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) fail()
  return normalized
}
/** Legacy untagged Chinese templates and their explicit locale file share one causal record. */
export function projectPromptAssetGroup(value: string): string {
  const name = projectAssetPathKey(value)
  if (!name.startsWith('prompts/') || name.slice(8).includes('/')) fail()
  if (!name.endsWith('.json')) return name
  const stem = name.slice(0, -5)
  return /\.(?:zh-cn|en-us)$/.test(stem) ? `${stem}.json` : `${stem}.zh-cn.json`
}

export function parseProjectAssetBlob(value: unknown): ProjectAssetBlob {
  const blob = record(value); keys(blob, ['sha256', 'byteSize', 'mime'])
  if (typeof blob.sha256 !== 'string' || !HASH.test(blob.sha256)
    || !Number.isSafeInteger(blob.byteSize) || Number(blob.byteSize) < 0 || Number(blob.byteSize) > MAX_PROJECT_ASSET_BYTES
    || typeof blob.mime !== 'string' || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(blob.mime)) fail()
  return { sha256: blob.sha256, byteSize: Number(blob.byteSize), mime: blob.mime }
}
function image(value: unknown): ProjectAssetBlob {
  const blob = parseProjectAssetBlob(value)
  if (!IMAGE_MIMES.includes(blob.mime) || blob.byteSize < 1 || blob.byteSize > 20 * 1024 * 1024) fail()
  return blob
}

export function parseProjectAuthorAsset(value: unknown): ProjectAuthorAsset {
  const item = record(value)
  if (item.version !== 1) fail()
  if (item.category === 'avatar') {
    keys(item, ['version', 'category', 'characterId', 'blob'])
    if (typeof item.characterId !== 'string' || !ID.test(item.characterId)) fail()
    return { version: 1, category: 'avatar', characterId: item.characterId, blob: image(item.blob) }
  }
  if (item.category === 'unassigned-avatar') {
    keys(item, ['version', 'category', 'originId', 'disposition', 'candidateCharacterIds', 'blob'])
    const originId = bounded(item.originId, 256)
    if (!['orphan', 'ambiguous', 'unknown-fork', 'reference-only'].includes(String(item.disposition)) || !Array.isArray(item.candidateCharacterIds)
      || item.candidateCharacterIds.length > 256 || new Set(item.candidateCharacterIds).size !== item.candidateCharacterIds.length
      || item.candidateCharacterIds.some(id => typeof id !== 'string' || !ID.test(id))) fail()
    const blob = item.blob === null ? null : parseProjectAssetBlob(item.blob)
    if (item.disposition === 'reference-only' ? blob !== null : !blob || blob.byteSize < 1
      || blob.byteSize > 20 * 1024 * 1024 || ![...IMAGE_MIMES, 'application/octet-stream'].includes(blob.mime)) fail()
    return { version: 1, category: 'unassigned-avatar', originId, disposition: item.disposition as 'orphan' | 'ambiguous' | 'unknown-fork' | 'reference-only',
      candidateCharacterIds: [...item.candidateCharacterIds].sort(), blob }
  }
  if (item.category === 'knowledge') {
    keys(item, ['version', 'category', 'documentId', 'blob'])
    const documentId = bounded(item.documentId, 512), blob = parseProjectAssetBlob(item.blob)
    if (blob.mime !== 'application/json') fail()
    return { version: 1, category: 'knowledge', documentId, blob }
  }
  if (item.category !== 'files') fail()
  keys(item, ['version', 'category', 'group', 'logicalName', 'files'])
  if (!['prompt', 'skill', 'skill-bindings', 'author-content'].includes(String(item.group))
    || !Array.isArray(item.files) || !item.files.length || item.files.length > MAX_PROJECT_ASSET_FILES) fail()
  const logicalName = bounded(item.logicalName, 1024), logicalKey = projectAssetPathKey(logicalName)
  const group = item.group as Extract<ProjectAuthorAsset, { category: 'files' }>['group']
  if (group === 'author-content' && !['partial_arch', 'partial_arch.json', 'chapter_creation_log.json'].includes(logicalKey)) fail()
  const directoryGroup = group === 'skill' || group === 'author-content' && logicalKey === 'partial_arch'
  const valid = (name: string): boolean => {
    if (group === 'prompt') return name.startsWith('prompts/') && !name.slice(8).includes('/')
    if (group === 'skill') return /^skills\/[^/]+\//.test(name)
    if (group === 'skill-bindings') return name === 'writing-skills.json'
    return name.startsWith('partial_arch/') || ['partial_arch.json', 'chapter_creation_log.json'].includes(name)
  }
  const seen = new Set<string>()
  const files = item.files.map(raw => {
    const file = record(raw); keys(file, ['path', 'blob'])
    const path = bounded(file.path, 1024), key = projectAssetPathKey(path)
    if (!valid(key) || seen.has(key) || (group === 'prompt' ? projectPromptAssetGroup(path) !== projectPromptAssetGroup(logicalName)
      : directoryGroup ? !key.startsWith(`${logicalKey}/`) : key !== logicalKey)) fail()
    seen.add(key)
    return { path, blob: parseProjectAssetBlob(file.blob) }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (!directoryGroup && group !== 'prompt' && files.length !== 1 || group === 'skill' && !/^skills\/[^/]+$/.test(logicalKey)) fail()
  if (group === 'prompt' && (files.length > 2 || projectPromptAssetGroup(logicalName) !== logicalKey)) fail()
  return { version: 1, category: 'files', group, logicalName, files }
}

export function projectAssetBlobs(asset: ProjectAuthorAsset): ProjectAssetBlob[] {
  return asset.category === 'files' ? asset.files.map(file => file.blob) : asset.blob ? [asset.blob] : []
}

export function validateProjectAssetSet(records: readonly ProjectAssetEnvelope[], characterIds?: ReadonlySet<string>): void {
  const ids = new Set<string>(), claims = new Map<string, string>(), paths: string[] = []
  for (const record of records) {
    if (!UUID.test(record.id) || ids.has(record.id)) fail()
    ids.add(record.id)
    const asset = parseProjectAuthorAsset(record.value)
    const claim = asset.category === 'files' ? `files:${projectAssetPathKey(asset.logicalName)}`
      : asset.category === 'avatar' ? `avatar:${asset.characterId}`
        : asset.category === 'knowledge' ? `knowledge:${asset.documentId}` : `orphan:${asset.originId}`
    if (claims.has(claim)) throw new Error('PROJECT_SYNC_ASSET_NAME_CONFLICT')
    claims.set(claim, record.id)
    if (asset.category === 'avatar' && characterIds && !characterIds.has(asset.characterId)) throw new Error('PROJECT_SYNC_ASSET_OWNER_MISSING')
    if (asset.category === 'files') for (const file of asset.files) paths.push(projectAssetPathKey(file.path))
  }
  const all = new Set(paths)
  if (all.size !== paths.length) throw new Error('PROJECT_SYNC_ASSET_NAME_CONFLICT')
  for (const name of paths) {
    const segments = name.split('/')
    for (let length = 1; length < segments.length; length++) if (all.has(segments.slice(0, length).join('/'))) {
      throw new Error('PROJECT_SYNC_ASSET_NAME_CONFLICT')
    }
  }
}
