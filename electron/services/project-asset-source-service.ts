import path from 'node:path'
import type Database from 'better-sqlite3'
import { parseProjectAuthorAsset, projectPromptAssetGroup, validateProjectAssetSet, type ProjectAuthorAsset, type ProjectAssetEnvelope } from '../../src/shared/project-sync-assets'
import { readPortableCharacterAvatarRows } from '../repositories/character-asset-repository'
import { enumerateRawProjectAssets } from './portable-project-assets'
import { ProjectAssetBlobStore } from './project-asset-blob-store'
import { assertProjectAssetsReady, captureProjectAssets, projectAssetIdentity, projectAssetLogicalKey } from './project-sync-assets'
import { canonicalSyncJson, syncDigest } from './project-sync-engine'
import { projectAuthorFileBytes } from './project-asset-author-projection'
import { CONTINUOUS_RAW_PROJECT_ASSETS, isContinuousProjectAsset } from './project-sync-scope'

export interface SavedKnowledgeDocument { documentId: string; bytes: Uint8Array }
export interface SavedKnowledgeSnapshot {
  documents: SavedKnowledgeDocument[]
  /** Digest of all canonical documents, also used when adopting already-local changes. */
  canonicalHash: string
  verifyUnchanged(): Promise<boolean>
}
export interface ProjectAssetSourceOptions {
  storageRoot: string
  projectId: string
  database: Database.Database
  readKnowledge(): Promise<SavedKnowledgeSnapshot>
  revalidate(): void
  /** Complete exports are explicit; routine sync captures changing author data. */
  scope?: 'continuous' | 'complete'
}
function fail(code: string): never { throw new Error(`PROJECT_SYNC_ASSET_${code}`) }
function source(root: string, relative: string): string {
  if (relative.includes('\\') || !relative.startsWith('avatars/')
    || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) fail('UNSAFE_PATH')
  const file = path.resolve(root, ...relative.split('/')), within = path.relative(root, file)
  if (within.startsWith('..') || path.isAbsolute(within)) fail('UNSAFE_PATH')
  return file
}

/** Capture saved author sources once, freeze all bytes in the CAS, then recheck
 * the same sources before a caller commits their manifests into the sync outbox. */
export async function snapshotSavedProjectAssets(options: ProjectAssetSourceOptions): Promise<{
  records: ProjectAssetEnvelope[]
  knowledgeCanonicalHash: string
  verifyUnchanged(): Promise<void>
}> {
  const { database, projectId, revalidate } = options, root = path.resolve(options.storageRoot)
  revalidate(); assertProjectAssetsReady(database)
  const enumeration = options.scope === 'complete' ? {} : { includeTopLevel: CONTINUOUS_RAW_PROJECT_ASSETS }
  const store = new ProjectAssetBlobStore(root), raw = enumerateRawProjectAssets(root, enumeration)
  const rawDigest = syncDigest(raw.map(file => [file.archivePath, file.sha256, file.byteSize]))
  const avatars = readPortableCharacterAvatarRows(database), avatarDigest = syncDigest(avatars)
  const knowledge = await options.readKnowledge(); revalidate()
  const observed: ProjectAuthorAsset[] = [], groups = new Map<string, Extract<ProjectAuthorAsset, { category: 'files' }>>()
  for (const file of raw) {
    revalidate()
    const name = file.archivePath, pieces = name.split('/')
    const group = pieces[0] === 'prompts' ? 'prompt' : pieces[0] === 'skills' ? 'skill'
      : name === 'writing-skills.json' ? 'skill-bindings' : 'author-content'
    const logicalName = group === 'skill' ? pieces.slice(0, 2).join('/') : pieces[0] === 'partial_arch' ? 'partial_arch'
      : group === 'prompt' ? projectPromptAssetGroup(name) : name
    if (group === 'skill' && pieces.length < 3) fail('INVALID')
    const rawBlob = store.importFile(file.sourcePath, name.endsWith('.json') ? 'application/json' : name.endsWith('.md') ? 'text/markdown' : 'application/octet-stream')
    if (rawBlob.sha256 !== file.sha256 || rawBlob.byteSize !== file.byteSize) fail('SOURCE_CHANGED')
    const blob = name === 'partial_arch.json' ? store.put(projectAuthorFileBytes(name, store.read(rawBlob)), rawBlob.mime) : rawBlob
    const key = `${group}:${logicalName}`
    const manifest = groups.get(key) ?? { version: 1, category: 'files', group, logicalName, files: [] }
    manifest.files.push({ path: name, blob }); groups.set(key, manifest)
  }
  observed.push(...groups.values())
  for (const avatar of avatars) {
    revalidate()
    if (avatar.kind === 'unresolved-reference') {
      observed.push({ version: 1, category: 'unassigned-avatar', originId: avatar.recordId,
        disposition: 'reference-only', candidateCharacterIds: avatar.candidateCharacterIds, blob: null })
      continue
    }
    const blob = store.importFile(source(root, avatar.relativePath), avatar.mime)
    if (blob.sha256 !== avatar.contentHash || blob.byteSize !== avatar.byteSize) fail('SOURCE_CHANGED')
    observed.push(avatar.kind === 'bound' ? { version: 1, category: 'avatar', characterId: avatar.characterId, blob }
      : { version: 1, category: 'unassigned-avatar', originId: avatar.recordId,
        disposition: avatar.disposition, candidateCharacterIds: avatar.candidateCharacterIds, blob })
  }
  for (const document of knowledge.documents) {
    revalidate()
    observed.push({ version: 1, category: 'knowledge', documentId: document.documentId, blob: store.put(document.bytes, 'application/json') })
  }
  const existing = captureProjectAssets(database).map(record => ({ id: record.id, value: parseProjectAuthorAsset(record.value) }))
  const known = new Map(existing.map(record => [projectAssetLogicalKey(record.value), record.id]))
  const records = observed.map(asset => {
    const value = parseProjectAuthorAsset(asset), id = known.get(projectAssetLogicalKey(value)) ?? projectAssetIdentity(projectId, value)
    return { id, value }
  })
  // Older accepted batches may refer to static assets. Preserve those exact
  // manifests without opening their files, importing new bytes or deleting them.
  if (options.scope !== 'complete') records.push(...existing.filter(record => !isContinuousProjectAsset(record.value)))
  records.sort((left, right) => left.id.localeCompare(right.id))
  validateProjectAssetSet(records)
  const verifyUnchanged = async (): Promise<void> => {
    revalidate(); assertProjectAssetsReady(database)
    if (!await knowledge.verifyUnchanged()) fail('SOURCE_CHANGED')
    revalidate()
    if (syncDigest(enumerateRawProjectAssets(root, enumeration).map(file => [file.archivePath, file.sha256, file.byteSize])) !== rawDigest
      || syncDigest(readPortableCharacterAvatarRows(database)) !== avatarDigest) fail('SOURCE_CHANGED')
    for (const avatar of avatars) if (avatar.kind !== 'unresolved-reference') {
      const current = store.importFile(source(root, avatar.relativePath), avatar.mime)
      if (current.sha256 !== avatar.contentHash || current.byteSize !== avatar.byteSize) fail('SOURCE_CHANGED')
    }
    revalidate()
    // Reject duplicate ids/names even if a future adapter mutates its DTO after capture.
    const checkedRecords = records.map(record => ({ id: record.id, value: parseProjectAuthorAsset(record.value) }))
    if (canonicalSyncJson(records) !== canonicalSyncJson(checkedRecords)) fail('INVALID')
  }
  await verifyUnchanged()
  return { records, knowledgeCanonicalHash: knowledge.canonicalHash, verifyUnchanged }
}
