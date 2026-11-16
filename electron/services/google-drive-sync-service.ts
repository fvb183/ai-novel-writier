import { createHash } from 'node:crypto'
import type { SyncBundle, SyncPreview, SyncStatus } from '../../src/shared/project-sync'
import type { ProjectAssetBlob } from '../../src/shared/project-sync-assets'
import type { GoogleDriveProjectStatus, GoogleDriveProgressReporter } from '../../src/shared/google-drive-sync'
import { validateSyncBundle } from './project-sync-engine'
import { DRIVE_APP_TAG, GoogleDriveClient, type DriveFile, type DriveUpload } from './google-drive-client'
import { coveredCloudFiles, DRIVE_HISTORY_BYTE_LIMIT, DRIVE_HISTORY_FILE_LIMIT, selectCloudBatches } from './google-drive-sync-history'
import { driveReplicaKey, GoogleDriveStateStore, type DriveBinding, type DriveEnableIntent } from './google-drive-state'
import { ProjectAssetBlobStore } from './project-asset-blob-store'
import { assertBundleAuthorAssetBytes, hydrateBundleAssets, hydrateProjectAssetReferences, referencedProjectAssetBlobs } from './project-sync-asset-transfer'
import type { CompactClock, CompactRecord } from '../../src/shared/project-sync-compact'
import { GoogleDriveCompactSync, downloadCompactDriveProject, COMPACT_EXCHANGE_DEADLINE_MS } from './google-drive-compact-sync'
import { collectDriveAssetGarbage } from './google-drive-asset-gc'

export interface CloudSyncEngine {
  enable(): unknown
  exportBundle(): SyncBundle
  exportIncrementalBundle?(knownHashes: ReadonlySet<string>, includePending?: boolean): SyncBundle | undefined
  exportCompactBundle?(knownClock?: CompactClock, includePending?: boolean): SyncBundle | undefined
  liveCompactRecords?(includePending?: boolean): CompactRecord[]
  receive(bundle: SyncBundle): SyncPreview
  preview(): SyncPreview
  status(): SyncStatus
}
function fail(code: string): never { throw new Error(code) }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function parseDriveBundle(bytes: Uint8Array): SyncBundle {
  try { return validateSyncBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
  catch (error) {
    if (error instanceof Error && /^SYNC_READER_(?:VERSION_UNSUPPORTED|FEATURE_REQUIRED|FEATURE_UNSUPPORTED)$/.test(error.message)) throw error
    return fail('DRIVE_PACKAGE_INVALID')
  }
}

/** Transport never applies content or resolves a conflict. Existing sync transactions remain authoritative. */
export class GoogleDriveSyncService {
  private uploads = new Map<string, DriveUpload>()
  constructor(private state: GoogleDriveStateStore) {}
  status(projectId: string, replicaId: string | null): GoogleDriveProjectStatus {
    const binding = replicaId ? this.state.binding(projectId, replicaId) : undefined
    const pending = replicaId ? this.state.read().enabling?.[driveReplicaKey(projectId, replicaId)] : undefined
    return binding ? { bound: true, autoSync: pending !== undefined || binding.autoSync === true, ...(binding.pendingDisable || pending ? { preferencePending: true } : {}), folderId: binding.folderId, lastTransferredAt: binding.lastTransferredAt,
      lastUploadedHash: binding.lastUploadedHash, receivedFiles: Object.keys(binding.received).length,
      ...(binding.historyCleanupError ? { historyCleanupError: binding.historyCleanupError } : {}) } : { bound: false, ...(pending ? { autoSync: true, preferencePending: true } : {}) }
  }
  requestEnable(intent: DriveEnableIntent): void {
    this.state.update(state => {
      const key = driveReplicaKey(intent.projectId, intent.replicaId), binding = state.bindings[key]
      if (binding && binding.accountId !== intent.accountId) fail('DRIVE_ACCOUNT_MISMATCH')
      if (state.enabling?.[key] && state.enabling[key].accountId !== intent.accountId) fail('DRIVE_ACCOUNT_MISMATCH')
      state.enabling ??= {}; state.enabling[key] = intent
      if (binding) { binding.autoSync = true; binding.pendingDisable = false; binding.localPath = intent.localPath }
    })
  }
  cancelEnable(projectId: string, replicaId: string | null): void {
    if (replicaId) this.state.update(state => { if (state.enabling) delete state.enabling[driveReplicaKey(projectId, replicaId)] })
  }
  setAutoSync(projectId: string, replicaId: string | null, enabled: boolean): GoogleDriveProjectStatus {
    if (typeof enabled !== 'boolean') fail('DRIVE_INPUT_INVALID')
    if (!replicaId || !this.state.binding(projectId, replicaId)) fail('DRIVE_PROJECT_NOT_BOUND')
    this.state.update(state => {
      const key = driveReplicaKey(projectId, replicaId)
      state.bindings[key].autoSync = enabled
      if (!enabled && state.enabling) delete state.enabling[key]
    })
    return this.status(projectId, replicaId)
  }
  async bind(client: GoogleDriveClient, projectId: string, replicaId: string, name: string, selectedFolder: string | undefined, revalidate: () => void): Promise<DriveBinding> {
    const key = driveReplicaKey(projectId, replicaId)
    const accountId = await client.accountId(); revalidate()
    const intent = this.state.read().enabling?.[key]
    if (intent && intent.accountId !== accountId) fail('DRIVE_ACCOUNT_MISMATCH')
    const creationKey = `${accountId}|${projectId}`
    let folderId = selectedFolder
    if (folderId) await client.checkFolder(folderId, projectId)
    else {
      const existing = (await client.projects()).filter(project => project.projectId === projectId); revalidate()
      if (existing.length > 1) fail('DRIVE_FOLDER_SELECTION_REQUIRED')
      folderId = existing[0]?.folderId
      if (!folderId) {
        const pending = this.state.read().creating[creationKey]
        if (pending && pending.accountId !== accountId) fail('DRIVE_ACCOUNT_MISMATCH')
        folderId = pending?.folderId ?? await client.allocateId(); revalidate()
        this.state.update(state => { state.creating[creationKey] = { accountId, folderId: folderId! } })
        await client.createProject(projectId, intent?.name ?? name, folderId, intent ? false : undefined)
      }
    }
    revalidate()
    const old = this.state.binding(projectId, replicaId)
    const binding: DriveBinding = old?.accountId === accountId && old.folderId === folderId ? old : { accountId, projectId, replicaId, folderId, files: [], received: {}, uploads: {} }
    this.state.update(state => {
      if (intent) { binding.autoSync = true; binding.pendingDisable = false; binding.localPath = intent.localPath }
      state.bindings[key] = binding; delete state.creating[creationKey]
      if (state.excludedProjects?.[accountId]) state.excludedProjects[accountId] = state.excludedProjects[accountId].filter(id => id !== projectId)
    })
    return binding
  }
  async exchange(client: GoogleDriveClient, projectId: string, engine: CloudSyncEngine, revalidate: () => void, store?: ProjectAssetBlobStore, progress?: GoogleDriveProgressReporter, discoveryRetry = 0): Promise<{
    success: true; status: SyncStatus; preview: SyncPreview; drive: GoogleDriveProjectStatus; uploaded: boolean; downloaded: number
  }> {
    const replicaId = engine.status().replicaId
    if (!replicaId) fail('SYNC_NOT_ENABLED')
    const key = driveReplicaKey(projectId, replicaId)
    const binding = this.state.binding(projectId, replicaId)
    if (!binding) fail('DRIVE_PROJECT_NOT_BOUND')
    if (await client.accountId() !== binding.accountId) fail('DRIVE_ACCOUNT_MISMATCH')
    revalidate()
    if (engine.exportCompactBundle && engine.liveCompactRecords) {
      const started = Date.now()
      const checked = () => { revalidate(); if (Date.now() - started >= COMPACT_EXCHANGE_DEADLINE_MS) fail('DRIVE_SYNC_TIMEOUT') }
      const result = await new GoogleDriveCompactSync({ client, state: this.state, engine, binding, key, store, check: checked,
        publish: bundle => this.publishBundle(client, bundle, this.state.binding(projectId, replicaId)!, key, checked),
        publishAssets: async (bundle, fresh) => {
          if (!referencedProjectAssetBlobs(bundle).length) return
          if (!store) fail('PROJECT_SYNC_ASSET_STORE_REQUIRED')
          assertBundleAuthorAssetBytes(bundle, blob => store.read(blob), checked)
          await this.publishAssets(client, bundle, this.state.binding(projectId, replicaId)!, key, store, checked, fresh)
        },
        collectAssets: async (live, check, confirmedSnapshotHash) => {
          const current = this.state.binding(projectId, replicaId)!
          const collected = await collectDriveAssetGarbage({ client, folderId: binding.folderId, projectId, confirmedSnapshotHash,
            currentReferences: live, previous: current.assetGarbage ?? {}, revalidate: check,
            refreshLiveReferences: async () => {
              const remote = await this.downloadProject(client, binding.folderId, check)
              check()
              if (!remote.bundle.compact) fail('SYNC_COMPACT_UPGRADE_REQUIRED')
              return referencedProjectAssetBlobs(remote.bundle)
            } })
          check()
          this.state.update(value => {
            const current = value.bindings[key]; current.assetGarbage = collected.candidates
            for (const [hash, id] of Object.entries(current.uploads)) if (collected.deleted.includes(id)) {
              delete current.uploads[hash]; if (current.uploadSessions) delete current.uploadSessions[hash]
            }
            for (const [hash, reservation] of Object.entries(current.freshAssetUploads ?? {})) if (collected.deleted.includes(reservation.fileId)) delete current.freshAssetUploads![hash]
          })
        },
      }).exchange()
      const intent = this.state.read().enabling?.[key]
      if (intent) {
        if (intent.accountId !== binding.accountId) fail('DRIVE_ACCOUNT_MISMATCH')
        await client.setProjectAutoSync(binding.folderId, projectId, true); checked()
        this.state.update(value => { value.bindings[key].autoSync = true; value.bindings[key].pendingDisable = false; delete value.enabling![key] })
      }
      return { ...result, drive: this.status(projectId, replicaId) }
    }
    const references = new Map((binding.assetReferences ?? []).map(blob => [blob.sha256, blob]))
    const addReferences = (blobs: ProjectAssetBlob[]) => {
      for (const blob of blobs) {
        const existing = references.get(blob.sha256)
        if (existing && existing.byteSize !== blob.byteSize) fail('PROJECT_SYNC_ASSET_INVALID')
        if (!existing) references.set(blob.sha256, blob)
      }
      if (references.size > 100_000) fail('DRIVE_ASSET_REFERENCE_LIMIT')
    }
    if (binding.assetReferences?.length) {
      progress?.({ stage: 'assets', projectId })
      if (!store) fail('PROJECT_SYNC_ASSET_STORE_REQUIRED')
      // Dormant history needs missing-file recovery, not a byte scan on every
      // author save. Incoming, outgoing and actually used assets remain hashed.
      await hydrateProjectAssetReferences(client, projectId, [...references.values()], binding.folderId, store, revalidate, false); revalidate()
    }
    progress?.({ stage: 'catalog', projectId })
    const discovered = await client.discover(binding.folderId, projectId, discoveryRetry ? [] : binding.files, discoveryRetry ? undefined : binding.cursor); revalidate()
    let downloaded = 0
    let inspected = 0
    const liveIds = new Set(discovered.files.map(file => file.id))
    const received = Object.fromEntries(Object.entries(binding.received).filter(([id]) => liveIds.has(id)))
    const cloudBatches = Object.fromEntries(Object.entries(binding.cloudBatches ?? {}).filter(([id]) => liveIds.has(id)))
    // A peer collector may have deleted our previously confirmed upload. Never reuse that consumed reserved ID.
    const removedIds = new Set(binding.files.filter(file => !liveIds.has(file.id)).map(file => file.id))
    for (const [hash, id] of Object.entries(binding.uploads)) if (removedIds.has(id)) {
      delete binding.uploads[hash]; if (binding.uploadSessions) delete binding.uploadSessions[hash]
      this.uploads.delete(`${binding.accountId}:${binding.folderId}:${hash}`)
    }
    if (removedIds.size) this.state.update(state => {
      const current = state.bindings[key]
      if (!current || current.accountId !== binding.accountId || current.folderId !== binding.folderId) fail('DRIVE_BINDING_CHANGED')
      for (const [hash, id] of Object.entries(current.uploads)) if (removedIds.has(id)) {
        delete current.uploads[hash]; if (current.uploadSessions) delete current.uploadSessions[hash]
      }
    })
    for (const file of discovered.files) {
      progress?.({ stage: 'download', projectId, completed: inspected++, total: discovered.files.length })
      const fileDigest = file.appProperties!.ainwDigest
      if (received[file.id]) {
        if (received[file.id] !== fileDigest) fail('DRIVE_IMMUTABLE_OBJECT_CHANGED')
        const before = binding.files.find(previous => previous.id === file.id)
        if (before?.md5Checksum && before.md5Checksum === file.md5Checksum && before.size === file.size
          && cloudBatches[file.id]?.length && binding.assetPolicyVersion === 1 && (!store || binding.assetReferences !== undefined)) continue
      }
      let bytes: Uint8Array
      try { bytes = await client.download(file, binding.folderId, projectId); revalidate() }
      catch (error) {
        revalidate()
        // A collector publishes and verifies the replacement before deletion. Refresh the catalog and retry that replacement.
        if (error instanceof Error && error.message === 'DRIVE_FILE_NOT_FOUND' && discoveryRetry < 2) {
          return this.exchange(client, projectId, engine, revalidate, store, progress, discoveryRetry + 1)
        }
        throw error
      }
      const bundle = parseDriveBundle(bytes)
      if (bundle.projectId !== projectId) fail('DRIVE_PROJECT_MISMATCH')
      const assets = referencedProjectAssetBlobs(bundle); addReferences(assets)
      if (assets.length) {
        progress?.({ stage: 'assets', projectId })
        if (!store) fail('PROJECT_SYNC_ASSET_STORE_REQUIRED')
        await hydrateBundleAssets(client, bundle, binding.folderId, store, revalidate); revalidate()
      }
      // Durable staging is idempotent. An interrupted exchange never loses already received batches.
      engine.receive(bundle); received[file.id] = fileDigest; downloaded++
      cloudBatches[file.id] = bundle.batches.map(batch => batch.hash)
    }
    revalidate()
    const knownHashes = new Set(Object.values(cloudBatches).flat())
    const bundle = engine.exportIncrementalBundle ? engine.exportIncrementalBundle(knownHashes)
      : (() => { const all = engine.exportBundle(); return selectCloudBatches(all, all.batches.filter(batch => !knownHashes.has(batch.hash))) })()
    const outgoingAssets = bundle ? referencedProjectAssetBlobs(bundle) : []
    addReferences(outgoingAssets)
    if (outgoingAssets.length) {
      progress?.({ stage: 'assets', projectId })
      if (!store) fail('PROJECT_SYNC_ASSET_STORE_REQUIRED')
      assertBundleAuthorAssetBytes(bundle!, blob => store.read(blob), revalidate)
      await this.publishAssets(client, bundle!, binding, key, store, revalidate); revalidate()
    }
    let uploaded = false
    const files = [...discovered.files]
    if (bundle) {
      const publication = await this.publishBundle(client, bundle, binding, key, revalidate)
      uploaded = publication.uploaded
      received[publication.file.id] = publication.file.appProperties!.ainwDigest
      cloudBatches[publication.file.id] = bundle.batches.map(batch => batch.hash)
      if (!files.some(file => file.id === publication.file.id)) files.push(publication.file)
    }
    this.state.update(state => {
      const current = state.bindings[key]
      if (!current || current.accountId !== binding.accountId || current.folderId !== binding.folderId) fail('DRIVE_BINDING_CHANGED')
      current.cursor = discovered.cursor; current.files = files; current.received = received; current.cloudBatches = cloudBatches
      if (bundle) current.lastUploadedHash = bundle.hash
      current.lastTransferredAt = new Date().toISOString()
      if (store) current.assetReferences = [...references.values()].sort((a, b) => a.sha256.localeCompare(b.sha256))
      current.assetPolicyVersion = 1
    })
    let cleanupError: string | undefined
    try { cleanupError = await this.cleanupHistory(client, projectId, engine, this.state.binding(projectId, replicaId)!, key, revalidate) }
    catch (error) {
      revalidate() // Cancellation/account/session changes still terminate the operation.
      const code = error instanceof Error ? error.message : ''
      if (/^(?:GOOGLE_AUTH_|DRIVE_ACCOUNT_|DRIVE_CANCELLED)/.test(code)) throw error
      cleanupError = /^(?:DRIVE|SYNC|PROJECT_SYNC)_[A-Z0-9_]+$/.test(code) ? code : 'DRIVE_HISTORY_CLEANUP_FAILED'
    }
    this.state.update(state => {
      const current = state.bindings[key]
      if (!current || current.accountId !== binding.accountId || current.folderId !== binding.folderId) fail('DRIVE_BINDING_CHANGED')
      if (cleanupError) current.historyCleanupError = cleanupError
      else delete current.historyCleanupError
    })
    // Only an explicit, still-pending switch-on publishes a newly created
    // folder. Other devices must not attempt to join an empty first upload.
    const intent = this.state.read().enabling?.[key]
    if (intent) {
      if (intent.accountId !== binding.accountId) fail('DRIVE_ACCOUNT_MISMATCH')
      await client.setProjectAutoSync(binding.folderId, projectId, true); revalidate()
      this.state.update(state => {
        if (state.enabling?.[key]?.accountId !== binding.accountId) fail('DRIVE_BINDING_CHANGED')
        state.bindings[key].autoSync = true; state.bindings[key].pendingDisable = false
        delete state.enabling[key]
      })
    }
    return { success: true as const, status: engine.status(), preview: engine.preview(), drive: this.status(projectId, replicaId), uploaded, downloaded }
  }
  private async publishBundle(client: GoogleDriveClient, bundle: SyncBundle, binding: DriveBinding, key: string, revalidate: () => void) {
    const bytes = new TextEncoder().encode(JSON.stringify(bundle)), hash = digest(bytes)
    let fileId = binding.uploads[hash]
    if (!fileId) {
      fileId = await client.allocateId(); revalidate()
      this.state.update(state => {
        const current = state.bindings[key]
        if (!current || current.accountId !== binding.accountId || current.folderId !== binding.folderId) fail('DRIVE_BINDING_CHANGED')
        current.uploads[hash] = fileId
      })
    }
    const uploadKey = `${binding.accountId}:${binding.folderId}:${hash}`
    const upload = this.uploads.get(uploadKey) ?? { fileId, digest: hash }
    const savedSession = binding.uploadSessions?.[hash]
    if (!upload.sessionUrl && savedSession) upload.sessionUrl = this.state.unsealSession(savedSession)
    this.uploads.set(uploadKey, upload)
    let uploaded: boolean
    try { uploaded = await client.publish(binding.folderId, binding.projectId, bytes, upload); revalidate() }
    finally {
      // Resumable URLs grant upload authority: persist only a device-encrypted envelope.
      let currentSession = true
      try { revalidate() } catch { currentSession = false }
      if (currentSession && upload.sessionUrl) {
        const sealed = this.state.sealSession(upload.sessionUrl)
        if (sealed) this.state.update(state => {
          const current = state.bindings[key]
          if (current?.accountId === binding.accountId && current.folderId === binding.folderId) {
            current.uploadSessions ??= {}; current.uploadSessions[hash] = sealed
          }
        })
      } else if (currentSession) this.state.update(state => { if (state.bindings[key]?.uploadSessions) delete state.bindings[key].uploadSessions![hash] })
    }
    this.uploads.delete(uploadKey)
    // publish() has already confirmed all of these immutable metadata fields.
    const file: DriveFile = { id: fileId, name: `${hash}.ainovelsync`, parents: [binding.folderId], mimeType: 'application/json',
      size: String(bytes.byteLength), md5Checksum: createHash('md5').update(bytes).digest('hex'),
      appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'sync', ainwProject: binding.projectId, ainwDigest: hash } }
    return { file, uploaded }
  }
  private async cleanupHistory(client: GoogleDriveClient, projectId: string, engine: CloudSyncEngine, binding: DriveBinding, key: string, revalidate: () => void): Promise<string | undefined> {
    const files = [...binding.files], coverage = { ...binding.cloudBatches }
    let warning: string | undefined
    let covered = coveredCloudFiles(files, coverage)
    const remaining = files.filter(file => !covered.some(old => old.id === file.id))
    // Exclude the largest retained baseline: a large novel must not re-upload its checkpoint on every small save.
    const sizes = remaining.map(file => Number(file.size ?? 0)), deltaBytes = sizes.reduce((sum, size) => sum + size, 0) - Math.max(0, ...sizes)
    if (remaining.length >= DRIVE_HISTORY_FILE_LIMIT || deltaBytes >= DRIVE_HISTORY_BYTE_LIMIT) {
      // Pending conflict variants also belong to the checkpoint; collecting them must not select a winner.
      let checkpoint: SyncBundle | undefined
      try { checkpoint = engine.exportIncrementalBundle?.(new Set(), true) ?? engine.exportBundle() }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'SYNC_PACKAGE_TOO_LARGE') throw error
        warning = 'DRIVE_HISTORY_CHECKPOINT_LIMIT'
      }
      const hashes = new Set(checkpoint?.batches.map(batch => batch.hash))
      if (checkpoint && files.every(file => coverage[file.id]?.every(hash => hashes.has(hash)))) {
        const publication = await this.publishBundle(client, checkpoint, binding, key, revalidate)
        // Read back the complete replacement before deleting a single source object.
        const verified = parseDriveBundle(await client.download(publication.file, binding.folderId, projectId)); revalidate()
        if (verified.hash !== checkpoint.hash) fail('DRIVE_HISTORY_CHECKPOINT_INVALID')
        coverage[publication.file.id] = verified.batches.map(batch => batch.hash)
        if (!files.some(file => file.id === publication.file.id)) files.push(publication.file)
        covered = coveredCloudFiles(files, coverage)
      }
    }
    const deleted = new Set<string>()
    for (const file of covered) {
      revalidate()
      await client.deleteSyncFile(binding.folderId, projectId, file); revalidate()
      deleted.add(file.id)
    }
    this.state.update(state => {
      const current = state.bindings[key]
      if (!current || current.accountId !== binding.accountId || current.folderId !== binding.folderId) fail('DRIVE_BINDING_CHANGED')
      current.files = files.filter(file => !deleted.has(file.id))
      current.cloudBatches = Object.fromEntries(current.files.map(file => [file.id, coverage[file.id]]))
      current.received = Object.fromEntries(current.files.map(file => [file.id, file.appProperties!.ainwDigest]))
      // Deleted immutable IDs cannot be reused on a retry. Assets have a separate namespace.
      for (const [hash, id] of Object.entries(current.uploads)) if (deleted.has(id)) { delete current.uploads[hash]; if (current.uploadSessions) delete current.uploadSessions[hash] }
    })
    return warning
  }
  async downloadProject(client: GoogleDriveClient, folderId: string, revalidate: () => void, progress?: GoogleDriveProgressReporter, discoveryRetry = 0): Promise<{ bundle: SyncBundle; binding: Omit<DriveBinding, 'replicaId'> }> {
    const accountId = await client.accountId(), folder = await client.checkFolder(folderId); revalidate()
    const projectId = folder.appProperties!.ainwProject
    progress?.({ stage: 'catalog', projectId })
    const downloaded = await downloadCompactDriveProject(client, folderId, projectId, revalidate, discoveryRetry)
    const assetReferences = referencedProjectAssetBlobs(downloaded.bundle)
    if (assetReferences.length > 100_000) fail('DRIVE_ASSET_REFERENCE_LIMIT')
    return { bundle: downloaded.bundle, binding: { accountId, folderId, projectId, files: downloaded.files,
      cursor: downloaded.cursor, received: downloaded.received, cloudCompact: downloaded.cloudCompact,
      cloudBatches: downloaded.cloudBatches, uploads: {}, assetReferences, assetPolicyVersion: 1 } }
  }
  rememberJoined(binding: Omit<DriveBinding, 'replicaId'>, replicaId: string): void {
    this.state.update(state => {
      state.bindings[driveReplicaKey(binding.projectId, replicaId)] = { ...binding, replicaId }
      if (state.excludedProjects?.[binding.accountId]) state.excludedProjects[binding.accountId] = state.excludedProjects[binding.accountId].filter(id => id !== binding.projectId)
    })
  }
  async hydrateBundleAssets(client: GoogleDriveClient, bundle: SyncBundle, folderId: string, store: ProjectAssetBlobStore, revalidate: () => void): Promise<void> {
    await hydrateBundleAssets(client, bundle, folderId, store, revalidate); revalidate()
  }
  private async publishAssets(client: GoogleDriveClient, bundle: SyncBundle, binding: DriveBinding, key: string, store: ProjectAssetBlobStore, revalidate: () => void,
    forceFresh: ReadonlySet<string> = new Set()): Promise<void> {
    const blobs = referencedProjectAssetBlobs(bundle)
    if (!blobs.length) return
    const files = await client.listObjects(binding.folderId, binding.projectId, 'asset'); revalidate()
    for (const blob of blobs) {
      revalidate(); const source = store.source(blob)
      const fresh = forceFresh.has(blob.sha256), reservation = binding.freshAssetUploads?.[blob.sha256]
      const validReservation = reservation && Date.now() >= reservation.createdAt && Date.now() - reservation.createdAt < COMPACT_EXCHANGE_DEADLINE_MS
      const existing = files.filter(file => file.appProperties?.ainwDigest === blob.sha256 && (!fresh || validReservation && file.id === reservation.fileId))
      if (existing.length) {
        if (existing.some(file => Number(file.size) !== blob.byteSize || file.md5Checksum !== source.md5)) fail('DRIVE_IMMUTABLE_OBJECT_CHANGED')
        continue
      }
      const assetKey = `asset:${blob.sha256}`
      let fileId = fresh ? validReservation ? reservation.fileId : undefined
        : binding.uploadSessions?.[assetKey] ? binding.uploads[assetKey] : undefined
      const reusedReservation = !!fileId && fileId === binding.uploads[assetKey]
      if (!fileId) {
        fileId = await client.allocateId(); revalidate()
        this.state.update(state => {
          const current = state.bindings[key]
          if (!current || current.accountId !== binding.accountId || current.folderId !== binding.folderId) fail('DRIVE_BINDING_CHANGED')
          current.uploads[assetKey] = fileId!
          if (current.uploadSessions) delete current.uploadSessions[assetKey]
          if (fresh) { current.freshAssetUploads ??= {}; current.freshAssetUploads[blob.sha256] = { fileId: fileId!, createdAt: Date.now() } }
        })
      }
      const uploadKey = `${binding.accountId}:${binding.folderId}:${assetKey}`
      if (this.uploads.get(uploadKey)?.fileId !== fileId) this.uploads.delete(uploadKey)
      const upload = this.uploads.get(uploadKey) ?? { fileId, digest: blob.sha256 }
      if (!upload.sessionUrl && reusedReservation && binding.uploadSessions?.[assetKey]) upload.sessionUrl = this.state.unsealSession(binding.uploadSessions[assetKey])
      this.uploads.set(uploadKey, upload)
      try {
        await client.publishObject(binding.folderId, binding.projectId, 'asset', { ...source, read: async (offset, length) => {
          await new Promise(resolve => setTimeout(resolve, 0)); revalidate(); const bytes = source.read(offset, length); revalidate(); return bytes
        } }, upload)
        revalidate(); this.uploads.delete(uploadKey)
      } finally {
        let live = true
        try { revalidate() } catch { live = false }
        if (live) {
          const sealed = upload.sessionUrl ? this.state.sealSession(upload.sessionUrl) : undefined
          this.state.update(state => {
            const current = state.bindings[key]
            if (!current || current.accountId !== binding.accountId || current.folderId !== binding.folderId) fail('DRIVE_BINDING_CHANGED')
            if (sealed) { current.uploadSessions ??= {}; current.uploadSessions[assetKey] = sealed }
            else if (!upload.sessionUrl && current.uploadSessions) delete current.uploadSessions[assetKey]
          })
        }
      }
    }
  }
}
