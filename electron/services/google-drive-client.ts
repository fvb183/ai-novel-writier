import { createHash } from 'node:crypto'
import type { GoogleDriveProject } from '../../src/shared/google-drive-sync'
import { networkFetch } from './network-fetch'
import { createDriveRequestBudget, driveAbortError, waitForDriveResponse, withDriveResponseBudget } from './google-drive-request-budget'

export const DRIVE_APP_TAG = 'ai-novel-writer-sync-v1'
export const MODEL_SETTINGS_ACCOUNT_SCOPE = '00000000-0000-4000-8000-000000000001'
export const MAX_DRIVE_PACKAGE_BYTES = 64 * 1024 * 1024
const METADATA_LIMIT = 2 * 1024 * 1024
const MAX_FILES = 2048
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const ID = /^[a-zA-Z0-9_-]{1,200}$/
const HASH = /^[a-f0-9]{64}$/
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export interface DriveFile { id: string; name: string; mimeType?: string; parents?: string[]; trashed?: boolean; appProperties?: Record<string, string>; size?: string; md5Checksum?: string; createdTime?: string }
export interface DriveUpload { fileId: string; digest: string; sessionUrl?: string }
export interface DriveDiscovery { files: DriveFile[]; cursor: string }
export type DriveObjectKind = 'asset' | 'backup' | 'backup-manifest' | 'model-settings'
export interface DriveObjectSource {
  byteSize: number; sha256: string; md5: string
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>
}
export const DRIVE_OBJECT_LIMITS: Record<DriveObjectKind, number> = { asset: 2 * 1024 ** 3, backup: 16 * 1024 ** 3, 'backup-manifest': 2 * 1024 ** 2, 'model-settings': 2 * 1024 ** 2 }
export function driveBytesSource(bytes: Uint8Array): DriveObjectSource {
  return { byteSize: bytes.byteLength, sha256: sha256(bytes), md5: createHash('md5').update(bytes).digest('hex'), read: (offset, length) => bytes.slice(offset, offset + length) }
}
const fields = 'id,name,mimeType,parents,trashed,appProperties,size,md5Checksum,createdTime'
function fail(code: string): never { throw new Error(code) }
export const validDriveId = (value: unknown): value is string => typeof value === 'string' && ID.test(value)

async function bytesLimited(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel().catch(() => {}); fail('DRIVE_FILE_TOO_LARGE') }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break
      size += part.value.byteLength
      if (size > limit) { await reader.cancel(); fail('DRIVE_FILE_TOO_LARGE') }
      parts.push(part.value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size); let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.byteLength }
  return result
}

/** Drive transports immutable objects. No endpoint or token is accepted from the renderer. */
export class GoogleDriveClient {
  private base: string
  constructor(private token: (signal?: AbortSignal) => Promise<string>, private options: { fetch?: typeof fetch; apiBase?: string; revalidate?: () => void; signal?: AbortSignal; requestTimeoutMs?: number } = {}) {
    this.base = options.apiBase ?? 'https://www.googleapis.com'
  }
  private check(): void { if (this.options.signal?.aborted) throw driveAbortError(this.options.signal); this.options.revalidate?.() }
  private async request(resource: string, init: RequestInit = {}): Promise<Response> {
    this.check()
    const budget = createDriveRequestBudget(this.options.signal, this.options.requestTimeoutMs)
    try {
      const token = await budget.race(this.token(budget.signal)); this.check()
      if (budget.signal.aborted) throw driveAbortError(budget.signal)
      budget.refreshNativeTimeout()
      let response: Response
      const uploadPut = init.method === 'PUT' && resource.startsWith('/upload/drive/')
      try {
        response = await waitForDriveResponse((this.options.fetch ?? networkFetch)(`${this.base}${resource}`, { ...init, redirect: uploadPut ? 'manual' : 'error',
          signal: budget.signal, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${token}` } }), budget)
      } catch (error) {
        this.check()
        if (budget.signal.aborted) throw driveAbortError(budget.signal)
        if ((error as { code?: string })?.code === 'NETWORK_TIMEOUT') fail('DRIVE_REQUEST_TIMEOUT')
        return fail('DRIVE_NETWORK_FAILED')
      }
      try { this.check() } catch (error) { await response.body?.cancel().catch(() => {}); throw error }
      if (uploadPut && (response.type === 'opaqueredirect' || response.status === 0
        || response.status >= 300 && response.status < 400 && (response.status !== 308 || response.headers.has('location')))) {
        await response.body?.cancel().catch(() => {}); fail('DRIVE_REDIRECT_REJECTED')
      }
      if ([401, 403, 429].includes(response.status)) {
        await response.body?.cancel().catch(() => {})
        fail(response.status === 401 ? 'GOOGLE_AUTH_REQUIRED' : response.status === 403 ? 'DRIVE_ACCESS_DENIED' : 'DRIVE_RATE_LIMITED')
      }
      return withDriveResponseBudget(response, budget)
    } catch (error) { budget.finish(); throw error }
  }
  private async json<T>(response: Response): Promise<T> {
    if (!response.ok) { await response.body?.cancel().catch(() => {}); fail(response.status === 404 ? 'DRIVE_FILE_NOT_FOUND' : response.status === 410 ? 'DRIVE_CURSOR_EXPIRED' : 'DRIVE_REQUEST_FAILED') }
    try { const bytes = await bytesLimited(response, METADATA_LIMIT); this.check(); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T }
    catch (error) { if (error instanceof Error && error.message.startsWith('DRIVE_')) throw error; return fail('DRIVE_RESPONSE_INVALID') }
  }
  async accountId(): Promise<string> {
    const result = await this.json<{ user?: { permissionId?: string } }>(await this.request('/drive/v3/about?fields=user(permissionId)'))
    if (!validDriveId(result.user?.permissionId)) fail('DRIVE_ACCOUNT_UNAVAILABLE')
    return result.user!.permissionId!
  }
  async metadata(id: string): Promise<DriveFile> {
    if (!validDriveId(id)) fail('DRIVE_INPUT_INVALID')
    const file = await this.json<DriveFile>(await this.request(`/drive/v3/files/${id}?fields=${fields}`))
    if (file.id !== id || typeof file.name !== 'string') fail('DRIVE_RESPONSE_INVALID')
    return file
  }
  private async list(query: string, maximum = MAX_FILES): Promise<DriveFile[]> {
    const result: DriveFile[] = []; let page = ''; const seen = new Set<string>()
    do {
      if (seen.has(page)) fail('DRIVE_RESPONSE_INVALID'); seen.add(page)
      const params = new URLSearchParams({ q: query, spaces: 'drive', pageSize: '1000', fields: `nextPageToken,files(${fields})`, ...(page ? { pageToken: page } : {}) })
      const value = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(await this.request(`/drive/v3/files?${params}`))
      if (!Array.isArray(value.files) || value.files.some(file => !validDriveId(file.id) || typeof file.name !== 'string')) fail('DRIVE_RESPONSE_INVALID')
      result.push(...value.files)
      if (result.length > maximum) fail('DRIVE_TOO_MANY_FILES')
      page = value.nextPageToken ?? ''
    } while (page)
    return result
  }
  async projects(): Promise<GoogleDriveProject[]> {
    const folders = await this.list(`trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='ainwApp' and value='${DRIVE_APP_TAG}' } and appProperties has { key='ainwKind' and value='project' }`)
    return folders.filter(file => UUID.test(file.appProperties?.ainwProject ?? '')).map(file => ({ folderId: file.id, projectId: file.appProperties!.ainwProject, name: file.name, autoSync: file.appProperties!.ainwAutoSync !== '0' }))
  }
  async setProjectAutoSync(folderId: string, projectId: string, enabled: boolean): Promise<void> {
    await this.checkFolder(folderId, projectId)
    await this.json(await this.request(`/drive/v3/files/${folderId}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties: { ainwAutoSync: enabled ? '1' : '0' } }) }))
    const checked = await this.checkFolder(folderId, projectId)
    if (checked.appProperties!.ainwAutoSync !== (enabled ? '1' : '0')) fail('DRIVE_UPLOAD_UNCONFIRMED')
  }
  async checkFolder(folderId: string, projectId?: string): Promise<DriveFile> {
    const file = await this.metadata(folderId)
    if (file.trashed || file.mimeType !== 'application/vnd.google-apps.folder' || file.appProperties?.ainwApp !== DRIVE_APP_TAG
      || file.appProperties.ainwKind !== 'project' || !UUID.test(file.appProperties.ainwProject ?? '')
      || projectId && file.appProperties.ainwProject !== projectId) fail('DRIVE_PROJECT_MISMATCH')
    return file
  }
  async modelSettingsFolders(accountId: string): Promise<DriveFile[]> {
    if (!validDriveId(accountId)) fail('DRIVE_ACCOUNT_UNAVAILABLE')
    const files = await this.list(`trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='ainwApp' and value='${DRIVE_APP_TAG}' } and appProperties has { key='ainwKind' and value='model-settings-root' } and appProperties has { key='ainwAccount' and value='${accountId}' }`)
    return files.filter(file => file.appProperties?.ainwProject === MODEL_SETTINGS_ACCOUNT_SCOPE && file.appProperties?.ainwAccount === accountId)
  }
  async checkModelSettingsFolder(folderId: string, accountId?: string): Promise<DriveFile> {
    const file = await this.metadata(folderId)
    if (file.trashed || file.mimeType !== 'application/vnd.google-apps.folder' || file.appProperties?.ainwApp !== DRIVE_APP_TAG
      || file.appProperties.ainwKind !== 'model-settings-root' || file.appProperties.ainwProject !== MODEL_SETTINGS_ACCOUNT_SCOPE
      || !validDriveId(file.appProperties.ainwAccount) || accountId && file.appProperties.ainwAccount !== accountId) fail('DRIVE_OBJECT_MISMATCH')
    return file
  }
  async createModelSettingsFolder(accountId: string, reservedId: string): Promise<DriveFile> {
    if (!validDriveId(accountId) || !validDriveId(reservedId)) fail('DRIVE_INPUT_INVALID')
    try { return await this.checkModelSettingsFolder(reservedId, accountId) }
    catch (error) { if (!(error instanceof Error) || error.message !== 'DRIVE_FILE_NOT_FOUND') throw error }
    try {
      await this.json(await this.request('/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reservedId, name: 'AI Novel Editor · Model Settings', mimeType: 'application/vnd.google-apps.folder',
          appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'model-settings-root', ainwProject: MODEL_SETTINGS_ACCOUNT_SCOPE, ainwAccount: accountId } }) }))
    } catch (error) {
      try { return await this.checkModelSettingsFolder(reservedId, accountId) } catch { throw error }
    }
    return this.checkModelSettingsFolder(reservedId, accountId)
  }
  async allocateId(): Promise<string> {
    const result = await this.json<{ ids?: string[] }>(await this.request('/drive/v3/files/generateIds?count=1&space=drive&type=files'))
    if (!Array.isArray(result.ids) || result.ids.length !== 1 || !validDriveId(result.ids[0])) fail('DRIVE_RESPONSE_INVALID')
    return result.ids[0]
  }
  async createProject(projectId: string, name: string, reservedId: string, autoSync?: boolean): Promise<string> {
    if (!UUID.test(projectId) || !validDriveId(reservedId)) fail('DRIVE_INPUT_INVALID')
    try { await this.checkFolder(reservedId, projectId); return reservedId }
    catch (error) { if (!(error instanceof Error) || error.message !== 'DRIVE_FILE_NOT_FOUND') throw error }
    try {
      const result = await this.json<DriveFile>(await this.request('/drive/v3/files?fields=id,name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: reservedId,
        name: `AI Novel Writer · ${name.slice(0, 120)}`, mimeType: 'application/vnd.google-apps.folder', appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'project', ainwProject: projectId, ...(autoSync === false ? { ainwAutoSync: '0' } : {}) } }) }))
      if (result.id !== reservedId) fail('DRIVE_RESPONSE_INVALID')
      return reservedId
    } catch {
      // A lost acknowledgement can only resolve to this reserved identity.
      try { await this.checkFolder(reservedId, projectId); return reservedId } catch { return fail('DRIVE_UPLOAD_UNCONFIRMED') }
    }
  }
  private matches(file: DriveFile, folderId: string, projectId: string): boolean {
    return !file.trashed && Boolean(file.parents?.includes(folderId)) && file.appProperties?.ainwApp === DRIVE_APP_TAG
      && file.appProperties.ainwKind === 'sync' && file.appProperties.ainwProject === projectId && HASH.test(file.appProperties.ainwDigest ?? '')
  }
  async discover(folderId: string, projectId: string, cache: DriveFile[], cursor?: string): Promise<DriveDiscovery> {
    await this.checkFolder(folderId, projectId)
    if (!cursor) {
      const start = await this.json<{ startPageToken?: string }>(await this.request('/drive/v3/changes/startPageToken?fields=startPageToken'))
      if (!start.startPageToken) fail('DRIVE_RESPONSE_INVALID')
      const files = await this.list(`'${folderId}' in parents and trashed = false and appProperties has { key='ainwApp' and value='${DRIVE_APP_TAG}' } and appProperties has { key='ainwKind' and value='sync' }`)
      return { cursor: start.startPageToken, files: files.filter(file => this.matches(file, folderId, projectId)) }
    }
    const files = new Map(cache.map(file => [file.id, file])); let page = cursor; const seen = new Set<string>()
    for (;;) {
      if (seen.has(page) || seen.size > 100) fail('DRIVE_RESPONSE_INVALID'); seen.add(page)
      const params = new URLSearchParams({ pageToken: page, pageSize: '1000', spaces: 'drive', fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${fields}))` })
      let value: { nextPageToken?: string; newStartPageToken?: string; changes?: { fileId: string; removed?: boolean; file?: DriveFile }[] }
      try { value = await this.json(await this.request(`/drive/v3/changes?${params}`)) }
      catch (error) { if (error instanceof Error && error.message === 'DRIVE_CURSOR_EXPIRED') return this.discover(folderId, projectId, []); throw error }
      if (!Array.isArray(value.changes)) fail('DRIVE_RESPONSE_INVALID')
      for (const change of value.changes) {
        if (!validDriveId(change.fileId)) fail('DRIVE_RESPONSE_INVALID')
        if (change.removed || !change.file || !this.matches(change.file, folderId, projectId)) files.delete(change.fileId)
        else { if (change.file.id !== change.fileId) fail('DRIVE_RESPONSE_INVALID'); files.set(change.fileId, change.file) }
      }
      if (files.size > MAX_FILES) fail('DRIVE_TOO_MANY_FILES')
      if (value.nextPageToken) { page = value.nextPageToken; continue }
      if (!value.newStartPageToken) fail('DRIVE_RESPONSE_INVALID')
      return { files: [...files.values()], cursor: value.newStartPageToken }
    }
  }
  async download(file: DriveFile, folderId: string, projectId: string): Promise<Uint8Array> {
    if (!validDriveId(file.id) || !this.matches(file, folderId, projectId)) fail('DRIVE_PROJECT_MISMATCH')
    if (Number(file.size) > MAX_DRIVE_PACKAGE_BYTES) fail('DRIVE_FILE_TOO_LARGE')
    const response = await this.request(`/drive/v3/files/${file.id}?alt=media`)
    if (!response.ok) { await response.body?.cancel().catch(() => {}); fail('DRIVE_DOWNLOAD_FAILED') }
    const bytes = await bytesLimited(response, MAX_DRIVE_PACKAGE_BYTES)
    if (sha256(bytes) !== file.appProperties!.ainwDigest) fail('DRIVE_HASH_MISMATCH')
    return bytes
  }
  async publish(folderId: string, projectId: string, bytes: Uint8Array, upload: DriveUpload): Promise<boolean> {
    if (bytes.byteLength > MAX_DRIVE_PACKAGE_BYTES || !validDriveId(upload.fileId) || sha256(bytes) !== upload.digest) fail('DRIVE_INPUT_INVALID')
    const verify = async () => {
      try { const file = await this.metadata(upload.fileId); if (!this.matches(file, folderId, projectId) || file.appProperties!.ainwDigest !== upload.digest
        || file.md5Checksum !== createHash('md5').update(bytes).digest('hex') || Number(file.size) !== bytes.byteLength) fail('DRIVE_OBJECT_MISMATCH'); return true }
      catch (error) { if (error instanceof Error && error.message === 'DRIVE_FILE_NOT_FOUND') return false; throw error }
    }
    if (await verify()) return false
    let offset = 0
    try {
      if (upload.sessionUrl && !upload.sessionUrl.startsWith('/upload/drive/')) fail('DRIVE_INPUT_INVALID')
      if (!upload.sessionUrl) {
        const response = await this.request('/upload/drive/v3/files?uploadType=resumable&fields=id,name,appProperties,parents,size', { method: 'POST', headers: {
          'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/json', 'X-Upload-Content-Length': String(bytes.byteLength) }, body: JSON.stringify({ id: upload.fileId,
          name: `${upload.digest}.ainovelsync`, parents: [folderId], mimeType: 'application/json', appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'sync', ainwProject: projectId, ainwDigest: upload.digest } }) })
        await response.body?.cancel().catch(() => {}); this.check()
        if (!response.ok) fail('DRIVE_UPLOAD_FAILED')
        const location = response.headers.get('location'), expected = new URL(this.base)
        if (!location) fail('DRIVE_RESPONSE_INVALID')
        const target = new URL(location)
        if (target.origin !== expected.origin || !target.pathname.startsWith('/upload/drive/')) fail('DRIVE_RESPONSE_INVALID')
        upload.sessionUrl = target.pathname + target.search
      } else {
        const response = await this.request(upload.sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${bytes.byteLength}` } })
        await response.body?.cancel().catch(() => {}); this.check()
        if (response.ok) { if (await verify()) return true; fail('DRIVE_UPLOAD_UNCONFIRMED') }
        if (response.status === 404 || response.status === 410) { delete upload.sessionUrl; return fail('DRIVE_UPLOAD_RETRY_REQUIRED') }
        if (response.status !== 308) fail('DRIVE_UPLOAD_FAILED')
        const range = response.headers.get('range'); offset = range ? Number(/^bytes=0-(\d+)$/.exec(range)?.[1]) + 1 : 0
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) fail('DRIVE_RESPONSE_INVALID')
      }
      const chunk = 4 * 1024 * 1024
      while (offset < bytes.byteLength) {
        const end = Math.min(offset + chunk, bytes.byteLength)
        const response = await this.request(upload.sessionUrl!, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Range': `bytes ${offset}-${end - 1}/${bytes.byteLength}` }, body: bytes.slice(offset, end) as BodyInit })
        await response.body?.cancel().catch(() => {}); this.check()
        if (response.ok) { if (end !== bytes.byteLength) fail('DRIVE_RESPONSE_INVALID'); break }
        if (response.status !== 308) fail('DRIVE_UPLOAD_FAILED')
        const range = /^bytes=0-(\d+)$/.exec(response.headers.get('range') ?? ''), next = range ? Number(range[1]) + 1 : 0
        if (!Number.isSafeInteger(next) || next <= offset || next > end) fail('DRIVE_RESPONSE_INVALID')
        offset = next
      }
      if (!await verify()) fail('DRIVE_UPLOAD_UNCONFIRMED')
      delete upload.sessionUrl
      return true
    } catch (error) {
      if (await verify().catch(() => false)) { delete upload.sessionUrl; return true }
      throw error
    }
  }

  /** Permanent deletion is restricted to an unchanged sync object in this exact project folder. */
  async deleteSyncFile(folderId: string, projectId: string, expected: DriveFile): Promise<void> {
    await this.checkFolder(folderId, projectId); this.check()
    if (!validDriveId(expected.id) || !this.matches(expected, folderId, projectId)) fail('DRIVE_OBJECT_MISMATCH')
    let current: DriveFile
    try { current = await this.metadata(expected.id) }
    catch (error) { if (error instanceof Error && error.message === 'DRIVE_FILE_NOT_FOUND') return; throw error }
    if (!this.matches(current, folderId, projectId) || current.appProperties!.ainwDigest !== expected.appProperties!.ainwDigest
      || current.size !== expected.size || current.md5Checksum !== expected.md5Checksum) fail('DRIVE_IMMUTABLE_OBJECT_CHANGED')
    const response = await this.request(`/drive/v3/files/${expected.id}`, { method: 'DELETE' })
    await response.body?.cancel().catch(() => {}); this.check()
    if (!response.ok && response.status !== 404) fail('DRIVE_HISTORY_CLEANUP_FAILED')
  }

  /** Only a previously observed immutable asset in this exact project may be swept. */
  async deleteAssetFile(folderId: string, projectId: string, expected: DriveFile): Promise<void> {
    await this.checkFolder(folderId, projectId); this.check()
    if (!this.objectMatches(expected, folderId, projectId, 'asset') || !/^[a-f0-9]{32}$/.test(expected.md5Checksum ?? '')) fail('DRIVE_OBJECT_MISMATCH')
    let current: DriveFile
    try { current = await this.metadata(expected.id) }
    catch (error) { if (error instanceof Error && error.message === 'DRIVE_FILE_NOT_FOUND') return; throw error }
    if (!this.objectMatches(current, folderId, projectId, 'asset') || current.appProperties!.ainwDigest !== expected.appProperties!.ainwDigest
      || current.size !== expected.size || current.md5Checksum !== expected.md5Checksum) fail('DRIVE_IMMUTABLE_OBJECT_CHANGED')
    const response = await this.request(`/drive/v3/files/${expected.id}`, { method: 'DELETE' })
    await response.body?.cancel().catch(() => {}); this.check()
    if (!response.ok && response.status !== 404) fail('DRIVE_ASSET_CLEANUP_FAILED')
  }

  private objectMatches(file: DriveFile, folderId: string, projectId: string, kind: DriveObjectKind): boolean {
    return !file.trashed && validDriveId(file.id) && Boolean(file.parents?.includes(folderId))
      && file.appProperties?.ainwApp === DRIVE_APP_TAG && file.appProperties.ainwProject === projectId
      && file.appProperties.ainwKind === kind && HASH.test(file.appProperties.ainwDigest ?? '')
      && Number.isSafeInteger(Number(file.size)) && Number(file.size) >= 0 && Number(file.size) <= DRIVE_OBJECT_LIMITS[kind]
  }
  async listObjects(folderId: string, projectId: string, kind: DriveObjectKind): Promise<DriveFile[]> {
    if (!Object.hasOwn(DRIVE_OBJECT_LIMITS, kind)) fail('DRIVE_INPUT_INVALID')
    if (kind === 'model-settings' && projectId === MODEL_SETTINGS_ACCOUNT_SCOPE) await this.checkModelSettingsFolder(folderId)
    else await this.checkFolder(folderId, projectId)
    this.check()
    const files = await this.list(`'${folderId}' in parents and trashed = false and appProperties has { key='ainwApp' and value='${DRIVE_APP_TAG}' } and appProperties has { key='ainwProject' and value='${projectId}' } and appProperties has { key='ainwKind' and value='${kind}' }`, kind === 'asset' ? 100_000 : 10_000)
    this.check()
    if (files.some(file => !this.objectMatches(file, folderId, projectId, kind))) fail('DRIVE_OBJECT_MISMATCH')
    return files
  }
  async downloadObject(file: DriveFile, folderId: string, projectId: string, kind: DriveObjectKind,
    expected: { sha256: string; byteSize: number }, write: (chunk: Uint8Array) => void | Promise<void>): Promise<void> {
    this.check()
    if (!Object.hasOwn(DRIVE_OBJECT_LIMITS, kind) || !this.objectMatches(file, folderId, projectId, kind)
      || !HASH.test(expected.sha256) || file.appProperties!.ainwDigest !== expected.sha256
      || Number(file.size) !== expected.byteSize) fail('DRIVE_OBJECT_MISMATCH')
    const hash = createHash('sha256'), md5 = createHash('md5'); let size = 0
    // Each range owns its request timeout; a large archive is not restricted to
    // sixty seconds for the entire stream. Never replay a mutating request.
    const chunkSize = 8 * 1024 ** 2
    while (size < expected.byteSize) {
      const start = size, end = Math.min(expected.byteSize, start + chunkSize) - 1
      const response = await this.request(`/drive/v3/files/${file.id}?alt=media`, { headers: { Range: `bytes=${start}-${end}` } })
      if (response.status === 404) { await response.body?.cancel().catch(() => {}); fail('DRIVE_FILE_NOT_FOUND') }
      const ranged = response.status === 206
      if (!response.ok || !response.body || (ranged ? response.headers.get('content-range') !== `bytes ${start}-${end}/${expected.byteSize}` : start !== 0 || expected.byteSize > chunkSize)) {
        await response.body?.cancel().catch(() => {}); fail('DRIVE_DOWNLOAD_FAILED')
      }
      const reader = response.body!.getReader(), limit = ranged ? end + 1 : expected.byteSize
      try {
        for (;;) {
          const part = await reader.read(); this.check()
          if (part.done) break
          size += part.value.byteLength
          if (size > limit) fail('DRIVE_FILE_TOO_LARGE')
          hash.update(part.value); md5.update(part.value)
          await write(part.value); this.check()
        }
        if (size !== limit) fail('DRIVE_HASH_MISMATCH')
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    if (size !== expected.byteSize || hash.digest('hex') !== expected.sha256 || md5.digest('hex') !== file.md5Checksum) fail('DRIVE_HASH_MISMATCH')
  }
  async downloadObjectBytes(file: DriveFile, folderId: string, projectId: string, kind: DriveObjectKind): Promise<Uint8Array> {
    if (Number(file.size) > METADATA_LIMIT) fail('DRIVE_FILE_TOO_LARGE')
    const parts: Uint8Array[] = []
    await this.downloadObject(file, folderId, projectId, kind, { sha256: file.appProperties?.ainwDigest ?? '', byteSize: Number(file.size) }, chunk => { parts.push(chunk.slice()) })
    this.check()
    const bytes = new Uint8Array(Number(file.size)); let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
    return bytes
  }

  /** Separate opt-in account settings. Ordinary novel batches/backups never include this file. */
  async readModelSettings(folderId: string, projectId: string): Promise<Uint8Array> {
    const files = await this.listObjects(folderId, projectId, 'model-settings')
    if (!files.length) fail('MODEL_SYNC_NOT_FOUND')
    if (files.length !== 1) fail('MODEL_SYNC_CLOUD_CONFLICT')
    return this.downloadObjectBytes(files[0], folderId, projectId, 'model-settings')
  }
  async writeModelSettings(folderId: string, projectId: string, bytes: Uint8Array): Promise<void> {
    if (!bytes.length || bytes.length > DRIVE_OBJECT_LIMITS['model-settings']) fail('MODEL_SYNC_CONFIG_INVALID')
    const files = await this.listObjects(folderId, projectId, 'model-settings')
    if (files.length > 1) fail('MODEL_SYNC_CLOUD_CONFLICT')
    const source = driveBytesSource(bytes)
    if (!files.length) {
      await this.publishObject(folderId, projectId, 'model-settings', source, { fileId: await this.allocateId(), digest: source.sha256 })
      return
    }
    const file = files[0]
    if (file.appProperties!.ainwDigest === source.sha256 && file.md5Checksum === source.md5 && Number(file.size) === source.byteSize) return
    const currentResponse = await this.request(`/drive/v3/files/${file.id}?fields=${fields}`)
    const etag = currentResponse.headers.get('etag')
    const current = await this.json<DriveFile>(currentResponse)
    if (current.id !== file.id || !this.objectMatches(current, folderId, projectId, 'model-settings') || current.appProperties!.ainwDigest !== file.appProperties!.ainwDigest) fail('MODEL_SYNC_CLOUD_CHANGED')
    const boundary = `ainw_models_${source.sha256.slice(0,32)}`
    const metadata = JSON.stringify({ mimeType: 'application/json', appProperties: { ...current.appProperties, ainwDigest: source.sha256 } })
    const prefix = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`)
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`), body = new Uint8Array(prefix.length + bytes.length + suffix.length)
    body.set(prefix); body.set(bytes,prefix.length); body.set(suffix,prefix.length+bytes.length)
    const verify = async () => {
      const saved = await this.metadata(file.id)
      return this.objectMatches(saved,folderId,projectId,'model-settings') && saved.appProperties!.ainwDigest === source.sha256
        && saved.md5Checksum === source.md5 && Number(saved.size) === source.byteSize
    }
    try {
      const response = await this.request(`/upload/drive/v3/files/${file.id}?uploadType=multipart&fields=id`, { method:'PATCH',
        headers:{'Content-Type':`multipart/related; boundary=${boundary}`, ...(etag ? {'If-Match':etag} : {})}, body:body as BodyInit })
      await response.body?.cancel().catch(() => {}); this.check()
      if (response.status === 412) fail('MODEL_SYNC_CLOUD_CHANGED')
      if (!response.ok || !await verify()) fail('MODEL_SYNC_UPLOAD_UNCONFIRMED')
    } catch (error) {
      this.check()
      if (await verify().catch(() => false)) return
      if (error instanceof Error && /^(?:GOOGLE|DRIVE|MODEL_SYNC)_[A-Z0-9_]+$/.test(error.message)) throw error
      fail('MODEL_SYNC_UPLOAD_UNCONFIRMED')
    }
  }
  async publishObject(folderId: string, projectId: string, kind: DriveObjectKind, source: DriveObjectSource, upload: DriveUpload): Promise<boolean> {
    this.check()
    if (!validDriveId(folderId) || !UUID.test(projectId) || !Object.hasOwn(DRIVE_OBJECT_LIMITS, kind)
      || !validDriveId(upload.fileId) || !HASH.test(source.sha256) || !/^[a-f0-9]{32}$/.test(source.md5)
      || upload.digest !== source.sha256 || !Number.isSafeInteger(source.byteSize) || source.byteSize < 0 || source.byteSize > DRIVE_OBJECT_LIMITS[kind]) fail('DRIVE_INPUT_INVALID')
    const verify = async () => {
      try {
        const file = await this.metadata(upload.fileId); this.check()
        if (!this.objectMatches(file, folderId, projectId, kind) || file.appProperties!.ainwDigest !== source.sha256 || file.md5Checksum !== source.md5 || Number(file.size) !== source.byteSize) fail('DRIVE_OBJECT_MISMATCH')
        return true
      } catch (error) { if (error instanceof Error && error.message === 'DRIVE_FILE_NOT_FOUND') return false; throw error }
    }
    if (await verify()) return false
    const chunkSize = 4 * 1024 * 1024, hash = createHash('sha256'), md5 = createHash('md5')
    for (let offset = 0; offset < source.byteSize; offset += chunkSize) {
      const length = Math.min(chunkSize, source.byteSize - offset), bytes = await source.read(offset, length); this.check()
      if (bytes.byteLength !== length) fail('DRIVE_SOURCE_CHANGED')
      hash.update(bytes); md5.update(bytes)
    }
    if (hash.digest('hex') !== source.sha256 || md5.digest('hex') !== source.md5) fail('DRIVE_SOURCE_CHANGED')
    let offset = 0
    const mime = kind === 'backup-manifest' ? 'application/json' : 'application/octet-stream'
    try {
      if (source.byteSize === 0) {
        // Multipart has a real empty media part; its fixed ID is queried after
        // any uncertain acknowledgement, without creating a replacement.
        const boundary = `ainw_${source.sha256.slice(0, 32)}`
        const metadata = { id: upload.fileId, name: `${source.sha256}.blob`, parents: [folderId], mimeType: mime,
          appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: kind, ainwProject: projectId, ainwDigest: source.sha256 } }
        const body = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n\r\n--${boundary}--\r\n`)
        const response = await this.request('/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: body as BodyInit })
        await response.body?.cancel().catch(() => {}); this.check()
        if (!response.ok || !await verify()) fail('DRIVE_UPLOAD_UNCONFIRMED')
        delete upload.sessionUrl; return true
      }
      if (upload.sessionUrl && !upload.sessionUrl.startsWith('/upload/drive/')) fail('DRIVE_INPUT_INVALID')
      if (!upload.sessionUrl) {
        const response = await this.request('/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(source.byteSize) }, body: JSON.stringify({ id: upload.fileId, name: `${source.sha256}.${kind === 'backup' ? 'ainovel' : kind === 'backup-manifest' ? 'json' : 'blob'}`, parents: [folderId], mimeType: mime,
          appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: kind, ainwProject: projectId, ainwDigest: source.sha256 } }) })
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => {}); this.check()
        if (!response.ok || !location) fail('DRIVE_UPLOAD_UNCONFIRMED')
        const target = new URL(location!), base = new URL(this.base)
        if (target.origin !== base.origin || !target.pathname.startsWith('/upload/drive/')) fail('DRIVE_RESPONSE_INVALID')
        upload.sessionUrl = target.pathname + target.search
      } else {
        const response = await this.request(upload.sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${source.byteSize}` } })
        await response.body?.cancel().catch(() => {}); this.check()
        if (response.ok) { if (await verify()) { delete upload.sessionUrl; return true }; fail('DRIVE_UPLOAD_UNCONFIRMED') }
        if ([404, 410].includes(response.status)) { delete upload.sessionUrl; fail('DRIVE_UPLOAD_RETRY_REQUIRED') }
        if (response.status !== 308) fail('DRIVE_UPLOAD_FAILED')
        offset = response.headers.get('range') ? Number(/^bytes=0-(\d+)$/.exec(response.headers.get('range')!)?.[1]) + 1 : 0
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.byteSize) fail('DRIVE_RESPONSE_INVALID')
      }
      const sentHash = createHash('sha256'), sentMd5 = createHash('md5')
      // Include resumed bytes in the source proof without retransmitting them.
      for (let start = 0; start < offset; start += chunkSize) {
        const bytes = await source.read(start, Math.min(chunkSize, offset - start)); this.check(); sentHash.update(bytes); sentMd5.update(bytes)
      }
      while (offset < source.byteSize) {
        const length = Math.min(chunkSize, source.byteSize - offset), bytes = await source.read(offset, length); this.check()
        if (bytes.byteLength !== length) fail('DRIVE_SOURCE_CHANGED')
        sentHash.update(bytes); sentMd5.update(bytes)
        const end = offset + length
        const response = await this.request(upload.sessionUrl!, { method: 'PUT', headers: { 'Content-Type': mime, 'Content-Range': `bytes ${offset}-${end - 1}/${source.byteSize}` }, body: bytes as BodyInit })
        await response.body?.cancel().catch(() => {}); this.check()
        if (response.ok) { if (end !== source.byteSize) fail('DRIVE_RESPONSE_INVALID'); offset = end; break }
        const next = Number(/^bytes=0-(\d+)$/.exec(response.headers.get('range') ?? '')?.[1]) + 1
        // An ambiguous partial chunk is resumed only by a later explicit retry.
        if (response.status !== 308 || next !== end) fail('DRIVE_UPLOAD_RETRY_REQUIRED')
        offset = next
      }
      if (sentHash.digest('hex') !== source.sha256 || sentMd5.digest('hex') !== source.md5) fail('DRIVE_SOURCE_CHANGED')
      if (!await verify()) fail('DRIVE_UPLOAD_UNCONFIRMED')
      delete upload.sessionUrl; return true
    } catch (error) {
      this.check()
      if (await verify().catch(() => false)) { delete upload.sessionUrl; return true }
      throw error
    }
  }
}
