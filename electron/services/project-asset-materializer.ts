import { installProjectFileExclusive } from './project-file-install'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { projectAssetPathKey, parseProjectAuthorAsset, type ProjectAssetFile, type ProjectAuthorAsset } from '../../src/shared/project-sync-assets'
import { avatarMime, detectAvatarExtension } from './avatar-image'
import { ProjectAssetBlobStore, recoverProjectAssetInstallLinks } from './project-asset-blob-store'
import { assertProjectAssetSelection, captureProjectAssets, markProjectAssetMaterialized, pendingProjectAssets, selectedKnowledgeAssetHash } from './project-sync-assets'
import { validatePlatformDirectoryChain } from './migration-file-system'
import { isAuthorCheckpointPath, projectAuthorFileBytes } from './project-asset-author-projection'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function fail(code: string): never { throw new Error(`PROJECT_SYNC_ASSET_${code}`) }
const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino
const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
export interface MaterializeProjectAssetsInput {
  database: Database.Database
  storageRoot: string
  revalidate(): void
  replaceKnowledge(input: {
    selectionHash: string
    selected: Array<{ documentId: string; bytes: Buffer }>
    previous: Array<{ documentId: string; bytes: Buffer }>
    verifySelected(): void
  }): Promise<void>
}

/** The database already contains the chosen manifests. Local projections are
 * restartable, and remain explicitly pending until every byte and binding is ready.
 * Superseded files are preserved in the CAS and in the owned materialization area. */
export async function materializeSelectedProjectAssets(input: MaterializeProjectAssetsInput): Promise<void> {
  const { database: db, revalidate } = input, root = path.resolve(input.storageRoot), store = new ProjectAssetBlobStore(root)
  const rootIdentity = fs.lstatSync(root, { bigint: true })
  const assertRoot = () => {
    revalidate()
    if (!validatePlatformDirectoryChain(root)) {
      for (let cursor = root;; cursor = path.dirname(cursor)) {
        const info = fs.lstatSync(cursor)
        if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH')
        if (cursor === path.dirname(cursor)) break
      }
    }
    const current = fs.lstatSync(root, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || !same(current, rootIdentity)
      || normalize(fs.realpathSync.native(root)) !== normalize(root)) fail('UNSAFE_PATH')
  }
  const target = (relative: string): string => {
    projectAssetPathKey(relative); assertRoot()
    const file = path.resolve(root, ...relative.split('/')), within = path.relative(root, file)
    if (!within || within.startsWith('..') || path.isAbsolute(within)) fail('UNSAFE_PATH')
    let cursor = root
    for (const segment of relative.split('/').slice(0, -1)) {
      cursor = path.join(cursor, segment)
      try {
        const info = fs.lstatSync(cursor)
        if (!info.isDirectory() || info.isSymbolicLink() || normalize(fs.realpathSync.native(cursor)) !== normalize(cursor)) fail('UNSAFE_PATH')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return file
  }
  const ensureParent = (file: string) => {
    const relative = path.relative(root, path.dirname(file)); let cursor = root
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment); assertRoot()
      try { fs.mkdirSync(cursor, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      const info = fs.lstatSync(cursor)
      if (!info.isDirectory() || info.isSymbolicLink() || normalize(fs.realpathSync.native(cursor)) !== normalize(cursor)) fail('UNSAFE_PATH')
    }
  }
  const installAbsent = (relative: string, blob: ProjectAssetFile['blob'], check: () => void) => {
    const file = target(relative); ensureParent(file)
    const temporaryRelative = `sync-assets/materialize-staging/${randomUUID()}`
    const temporary = target(temporaryRelative); ensureParent(temporary)
    const fd = fs.openSync(temporary, 'wx', 0o600)
    const identity = fs.fstatSync(fd, { bigint: true }); let closed = false, installed = false
    try {
      const source = store.source(blob)
      for (let offset = 0; offset < source.byteSize; offset += 256 * 1024) {
        const bytes = source.read(offset, Math.min(256 * 1024, source.byteSize - offset))
        let written = 0
        while (written < bytes.length) {
          const count = fs.writeSync(fd, bytes, written, bytes.length - written, offset + written)
          if (!count) fail('WRITE_FAILED')
          written += count
        }
      }
      fs.fsyncSync(fd); fs.closeSync(fd); closed = true
      target(relative); check()
      const info = fs.lstatSync(temporary, { bigint: true })
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || !same(info, identity)) fail('UNSAFE_PATH')
      installProjectFileExclusive(temporary, file) // Never replace an independently created target.
      installed = true
    } finally {
      if (!closed) fs.closeSync(fd)
      try {
        target(temporaryRelative)
        const info = fs.lstatSync(temporary, { bigint: true })
        if (info.isFile() && !info.isSymbolicLink() && same(info, identity)) fs.unlinkSync(temporary)
      } catch (error) {
        // A linked target is not ready until its private extra link is gone.
        // Its selected manifest stays pending and restart recovery can finish it.
        if (installed && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (error instanceof Error && !(error as NodeJS.ErrnoException).code) throw error
          fail('WRITE_FAILED')
        }
      }
    }
  }
  const currentHash = (file: string, mime: string, expected?: ProjectAssetFile['blob'], logicalPath = path.relative(root, file).split(path.sep).join('/')): string | null => {
    try {
      if (expected && fs.lstatSync(file, { bigint: true }).nlink !== 1n) recoverProjectAssetInstallLinks(root, file, expected, 'materialize-staging')
      const rawBlob = store.importFile(file, mime)
      return isAuthorCheckpointPath(logicalPath) ? store.put(projectAuthorFileBytes(logicalPath, store.read(rawBlob)), mime).sha256 : rawBlob.sha256
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  const moveSuperseded = (relative: string, expectedHash: string, mime: string, check: () => void) => {
    const file = target(relative)
    if (currentHash(file, mime) !== expectedHash) fail('SOURCE_CHANGED')
    const backupRelative = `sync-assets/materialize-backups/${digest(relative)}-${randomUUID()}`
    const backup = target(backupRelative); ensureParent(backup)
    check(); target(relative); fs.renameSync(file, backup)
    // An external write racing with the move is preserved, never silently discarded.
    if (currentHash(backup, mime, undefined, relative) !== expectedHash) {
      if (!fs.existsSync(file)) {
        target(relative); target(backupRelative)
        const identity = fs.lstatSync(backup, { bigint: true })
        installProjectFileExclusive(backup, file)
        if (fs.existsSync(backup) && same(fs.lstatSync(backup, { bigint: true }), identity)) fs.unlinkSync(backup)
      }
      fail('SOURCE_CHANGED')
    }
  }
  assertRoot()
  const pending = pendingProjectAssets(db)
  const selected = captureProjectAssets(db).map(record => ({ id: record.id, value: parseProjectAuthorAsset(record.value) }))
  const knowledgePending = pending.filter(item => item.selected?.category === 'knowledge' || item.materialized?.category === 'knowledge')
  for (const item of pending.filter(item => item.selected?.category === 'files' || item.materialized?.category === 'files')) {
    const check = () => { assertRoot(); assertProjectAssetSelection(db, item.id, item.selected) }
    const before = item.materialized?.category === 'files' ? item.materialized.files : []
    const after = item.selected?.category === 'files' ? item.selected.files : []
    const wanted = new Map(after.map(file => [projectAssetPathKey(file.path), file]))
    for (const file of [...before].sort((a, b) => b.path.length - a.path.length)) if (!wanted.has(projectAssetPathKey(file.path))) {
      const current = currentHash(target(file.path), file.blob.mime, file.blob)
      if (current !== null) {
        if (current !== file.blob.sha256) fail('SOURCE_CHANGED')
        moveSuperseded(file.path, current, file.blob.mime, check)
      }
    }
    const directoryBoundary = item.materialized?.category === 'files' ? item.materialized.logicalName : ''
    const oldDirectories = new Set<string>()
    for (const file of before) {
      let parent = path.posix.dirname(file.path)
      while (parent !== '.' && parent !== directoryBoundary && parent !== 'prompts' && parent !== 'skills' && parent !== 'partial_arch') {
        oldDirectories.add(parent); parent = path.posix.dirname(parent)
      }
    }
    for (const relative of [...oldDirectories].sort((a, b) => b.length - a.length)) {
      check()
      const directory = target(`${relative}/.directory-check`)
      try {
        const parent = path.dirname(directory), info = fs.lstatSync(parent)
        if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH')
        fs.rmdirSync(parent) // Empty directories only; unknown author files are retained.
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    for (const file of after) {
      check()
      const current = currentHash(target(file.path), file.blob.mime, file.blob)
      if (current === file.blob.sha256) continue
      const previous = before.find(old => projectAssetPathKey(old.path) === projectAssetPathKey(file.path))
      if (current !== null) {
        if (!previous || current !== previous.blob.sha256) fail('SOURCE_CHANGED')
        moveSuperseded(file.path, current, file.blob.mime, check)
      }
      installAbsent(file.path, file.blob, check)
    }
    check(); markProjectAssetMaterialized(db, item.id, item.selected)
  }
  for (const item of pending.filter(item => item.selected?.category === 'avatar' || item.selected?.category === 'unassigned-avatar'
    || item.materialized?.category === 'avatar' || item.materialized?.category === 'unassigned-avatar')) {
    const check = () => { assertRoot(); assertProjectAssetSelection(db, item.id, item.selected) }
    check()
    const asset = item.selected
    let installedPath: string | null = null
    if (asset && (asset.category === 'avatar' || asset.category === 'unassigned-avatar') && asset.blob) {
      const bytes = store.read(asset.blob, 20 * 1024 * 1024), extension = detectAvatarExtension(bytes)
      if (asset.blob.mime !== 'application/octet-stream' && (!extension || avatarMime(extension) !== asset.blob.mime)) fail('INVALID')
      installedPath = `avatars/sync/${item.id}/${asset.blob.sha256}.${extension === 'jpeg' ? 'jpg' : extension ?? 'bin'}`
      const current = currentHash(target(installedPath), asset.blob.mime, asset.blob)
      if (current === null) installAbsent(installedPath, asset.blob, check)
      else if (current !== asset.blob.sha256) fail('HASH_MISMATCH')
    }
    check()
    db.transaction(() => {
      if (item.materialized?.category === 'avatar' && (asset?.category !== 'avatar' || asset.characterId !== item.materialized.characterId)) {
        db.prepare('DELETE FROM character_avatar_assets WHERE character_id=?').run(item.materialized.characterId)
      }
      if (item.materialized?.category === 'unassigned-avatar' && (asset?.category !== 'unassigned-avatar' || asset.originId !== item.materialized.originId)) {
        db.prepare('DELETE FROM character_avatar_unresolved WHERE record_id=?').run(item.materialized.originId)
      }
      if (asset?.category === 'avatar') {
        const existing = db.prepare('SELECT * FROM character_avatar_assets WHERE character_id=?').get(asset.characterId) as { asset_revision: number; content_hash: string } | undefined
        const revision = existing && existing.content_hash === asset.blob.sha256 ? existing.asset_revision : (existing?.asset_revision ?? 0) + 1
        db.prepare(`INSERT INTO character_avatar_assets VALUES(?,?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET
          asset_revision=excluded.asset_revision,relative_path=excluded.relative_path,content_hash=excluded.content_hash,
          mime=excluded.mime,byte_size=excluded.byte_size,source_reference=excluded.source_reference`)
          .run(asset.characterId, revision, installedPath, asset.blob.sha256, asset.blob.mime, asset.blob.byteSize, 'synced')
      } else if (asset?.category === 'unassigned-avatar') {
        db.prepare(`INSERT INTO character_avatar_unresolved VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET
          disposition=excluded.disposition,source_reference=excluded.source_reference,source_relative_path=excluded.source_relative_path,
          preserved_relative_path=excluded.preserved_relative_path,content_hash=excluded.content_hash,mime=excluded.mime,
          byte_size=excluded.byte_size,candidate_character_ids_json=excluded.candidate_character_ids_json`)
          .run(asset.originId, asset.disposition, 'synced', installedPath ?? `avatars/unavailable-${item.id}`,
            installedPath, asset.blob?.sha256 ?? null, asset.blob?.mime ?? null, asset.blob?.byteSize ?? null, JSON.stringify(asset.candidateCharacterIds))
      }
      markProjectAssetMaterialized(db, item.id, item.selected)
    })()
  }
  if (knowledgePending.length) {
    const selectionHash = selectedKnowledgeAssetHash(db)!
    const selectedDocuments = selected.filter((item): item is { id: string; value: Extract<ProjectAuthorAsset, { category: 'knowledge' }> } => item.value.category === 'knowledge')
    const previous = new Map(selectedDocuments.map(item => [item.id, item.value]))
    for (const item of knowledgePending) {
      if (item.materialized?.category === 'knowledge') previous.set(item.id, item.materialized)
      else previous.delete(item.id)
    }
    const verifySelected = () => { assertRoot(); if (selectedKnowledgeAssetHash(db) !== selectionHash) fail('SELECTION_CHANGED') }
    await input.replaceKnowledge({ selectionHash,
      selected: selectedDocuments.map(item => ({ documentId: item.value.documentId, bytes: store.read(item.value.blob) })),
      previous: [...previous.values()].map(item => ({ documentId: item.documentId, bytes: store.read(item.blob) })), verifySelected })
    verifySelected()
    db.transaction(() => { for (const item of knowledgePending) markProjectAssetMaterialized(db, item.id, item.selected) })()
  }
}
