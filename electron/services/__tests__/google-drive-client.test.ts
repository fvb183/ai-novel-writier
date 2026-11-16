import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DRIVE_APP_TAG, DRIVE_OBJECT_LIMITS, MODEL_SETTINGS_ACCOUNT_SCOPE, driveBytesSource, GoogleDriveClient, type DriveFile, type DriveUpload } from '../google-drive-client'

const hash = (bytes: Uint8Array, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function transport(options: { revalidate?: () => void; signal?: AbortSignal } = {}) {
  const projectId = randomUUID(), folderId = 'synthetic_folder', files = new Map<string, DriveFile>(), bodies = new Map<string, Uint8Array>()
  files.set(folderId, { id: folderId, name: 'Synthetic novel', mimeType: 'application/vnd.google-apps.folder', appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'project', ainwProject: projectId } })
  const sessions = new Map<string, { metadata: DriveFile; bytes: Uint8Array; total: number }>(), calls: { path: string; method: string }[] = []
  let ids = 0, loseFinalAck = false, loseChunkAck = false, hostileLocation = false
  let changes: { fileId: string; file?: DriveFile; removed?: boolean }[] = []
  const fetcher: typeof fetch = async (raw, init = {}) => {
    const url = new URL(String(raw)), method = init.method ?? 'GET', headers = new Headers(init.headers)
    expect(url.origin).toBe('https://www.googleapis.com')
    expect(headers.get('Authorization')).toBe('Bearer SYNTHETIC_TOKEN')
    expect(init.redirect).toBe(method === 'PUT' && url.pathname.startsWith('/upload/drive/') ? 'manual' : 'error')
    calls.push({ path: url.pathname + url.search, method })
    if (url.pathname.startsWith('/upload/drive/v3/files/') && method === 'PATCH') {
      const id=url.pathname.split('/').at(-1)!,previous=files.get(id)
      if(!previous)return json({},404)
      const boundary=/boundary=([^;]+)/.exec(headers.get('Content-Type')!)![1]
      const parts=(await new Response(init.body).text()).split(`--${boundary}`)
      const metadata=JSON.parse(parts[1].split('\r\n\r\n')[1].trim())
      const media=parts[2].slice(parts[2].indexOf('\r\n\r\n')+4).replace(/\r\n$/,'')
      const body=new TextEncoder().encode(media)
      files.set(id,{...previous,...metadata,size:String(body.length),md5Checksum:hash(body,'md5')});bodies.set(id,body)
      if(loseFinalAck){loseFinalAck=false;throw new TypeError('synthetic lost update acknowledgement')}
      return json({id})
    }
    if (url.pathname === '/drive/v3/about') return json({ user: { permissionId: 'synthetic_account' } })
    if (url.pathname === '/drive/v3/files/generateIds') return json({ ids: [`reserved_${++ids}`] })
    if (url.pathname === '/drive/v3/changes/startPageToken') return json({ startPageToken: '7' })
    if (url.pathname === '/drive/v3/changes') return url.searchParams.get('pageToken') === 'expired' ? json({}, 410) : json({ changes, newStartPageToken: '9' })
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const query = url.searchParams.get('q')!, kind = /key='ainwKind' and value='([^']+)'/.exec(query)?.[1]
      const parent = /'([^']+)' in parents/.exec(query)?.[1], account = /key='ainwAccount' and value='([^']+)'/.exec(query)?.[1]
      return json({ files: [...files.values()].filter(file => !file.trashed && (!query.includes('mimeType') || file.mimeType?.includes('folder'))
        && (!parent || file.parents?.includes(parent)) && (!kind || file.appProperties?.ainwKind === kind) && (!account || file.appProperties?.ainwAccount === account)) })
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') { const metadata = JSON.parse(String(init.body)); files.set(metadata.id, metadata); return json({ id: metadata.id }) }
    if (url.pathname.startsWith('/drive/v3/files/')) {
      const id = url.pathname.split('/').at(-1)!, file = files.get(id)
      if (!file) return json({}, 404)
      if (method === 'DELETE') { files.delete(id); bodies.delete(id); return new Response(null, { status: 204 }) }
      if (method === 'PATCH') {
        const update = JSON.parse(String(init.body))
        file.appProperties = { ...file.appProperties, ...update.appProperties }
        return json({ id })
      }
      if (url.searchParams.get('alt') !== 'media') return json(file)
      const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get('Range') ?? ''), body = bodies.get(id)!
      return range ? new Response(body.slice(Number(range[1]), Number(range[2]) + 1) as BodyInit, { status: 206, headers: { 'Content-Range': `bytes ${range[1]}-${range[2]}/${body.byteLength}` } }) : new Response(body as BodyInit)
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      if (url.searchParams.get('uploadType') === 'multipart') {
        const boundary = /boundary=([^;]+)/.exec(headers.get('Content-Type')!)![1]
        const parts = (await new Response(init.body).text()).split(`--${boundary}`)
        const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1].trim())
        expect(parts[2].split('\r\n\r\n')[1]).toBe('\r\n')
        const body = new Uint8Array()
        files.set(metadata.id, { ...metadata, size: '0', md5Checksum: hash(body, 'md5') }); bodies.set(metadata.id, body)
        if (loseFinalAck) { loseFinalAck = false; throw new TypeError('synthetic lost empty acknowledgement') }
        return json({ id: metadata.id })
      }
      const metadata = JSON.parse(String(init.body)), session = String(++ids)
      sessions.set(session, { metadata, bytes: new Uint8Array(), total: Number(headers.get('X-Upload-Content-Length')) })
      return new Response(null, { status: 200, headers: { Location: hostileLocation ? 'https://example.invalid/steal-token' : `https://www.googleapis.com/upload/drive/v3/files?upload_id=${session}` } })
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'PUT') {
      const session = sessions.get(url.searchParams.get('upload_id')!)
      if (!session) return json({}, 404)
      const range = headers.get('Content-Range')!
      if (!range.startsWith('bytes */')) {
        const addition = new Uint8Array(await new Response(init.body).arrayBuffer()), combined = new Uint8Array(session.bytes.length + addition.length)
        combined.set(session.bytes); combined.set(addition, session.bytes.length); session.bytes = combined
      }
      if (session.bytes.length === session.total) {
        const bytes = new Uint8Array(session.bytes)
        files.set(session.metadata.id, { ...session.metadata, size: String(bytes.length), md5Checksum: hash(bytes, 'md5') }); bodies.set(session.metadata.id, bytes)
        if (loseFinalAck) { loseFinalAck = false; throw new TypeError('synthetic lost acknowledgement') }
        return json({ id: session.metadata.id })
      }
      if (loseChunkAck) { loseChunkAck = false; throw new TypeError('synthetic interrupted chunk') }
      return new Response(null, { status: 308, headers: session.bytes.length ? { Range: `bytes=0-${session.bytes.length - 1}` } : {} })
    }
    throw new Error(`unexpected synthetic Drive request ${method} ${url.pathname}`)
  }
  const client = new GoogleDriveClient(async () => 'SYNTHETIC_TOKEN', { fetch: fetcher, ...options })
  return { projectId, folderId, client, files, bodies, calls, loseFinal: () => { loseFinalAck = true }, loseChunk: () => { loseChunkAck = true }, hostile: () => { hostileLocation = true }, changes: (value: typeof changes) => { changes = value } }
}

describe('Google Drive immutable transport protocol', () => {
  it('keeps account model configuration in its own verified folder outside the novel catalog', async () => {
    const t = transport(), account = 'synthetic_account', id = await t.client.allocateId()
    expect(await t.client.modelSettingsFolders(account)).toEqual([])
    const folder = await t.client.createModelSettingsFolder(account, id)
    expect(folder.appProperties).toMatchObject({ ainwKind: 'model-settings-root', ainwAccount: account, ainwProject: MODEL_SETTINGS_ACCOUNT_SCOPE })
    expect(await t.client.modelSettingsFolders(account)).toHaveLength(1)
    expect((await t.client.projects()).map(project => project.folderId)).toEqual([t.folderId])
    const bytes = new TextEncoder().encode('{"synthetic":"explicit API settings"}')
    await t.client.writeModelSettings(id, MODEL_SETTINGS_ACCOUNT_SCOPE, bytes)
    expect(await t.client.readModelSettings(id, MODEL_SETTINGS_ACCOUNT_SCOPE)).toEqual(bytes)
    await expect(t.client.checkModelSettingsFolder(id, 'another_account')).rejects.toThrow('DRIVE_OBJECT_MISMATCH')
    await expect(t.client.checkFolder(id, MODEL_SETTINGS_ACCOUNT_SCOPE)).rejects.toThrow('DRIVE_PROJECT_MISMATCH')
  })
  it('permanently collects only unchanged sync objects in the exact project folder and retries missing files safely', async () => {
    const t = transport(), bytes = new TextEncoder().encode('{"synthetic":"checkpoint-covered"}')
    await t.client.publish(t.folderId, t.projectId, bytes, { fileId: 'old_history', digest: hash(bytes) })
    const file = structuredClone(t.files.get('old_history')!)
    const changed = structuredClone(file); changed.size = '123456'
    await expect(t.client.deleteSyncFile(t.folderId, t.projectId, changed)).rejects.toThrow('DRIVE_IMMUTABLE_OBJECT_CHANGED')
    expect(t.files.has(file.id)).toBe(true)
    const foreign = structuredClone(file); foreign.appProperties!.ainwKind = 'asset'
    await expect(t.client.deleteSyncFile(t.folderId, t.projectId, foreign)).rejects.toThrow('DRIVE_OBJECT_MISMATCH')
    expect(t.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    await t.client.deleteSyncFile(t.folderId, t.projectId, file)
    expect(t.files.has(file.id)).toBe(false)
    await t.client.deleteSyncFile(t.folderId, t.projectId, file)
    expect(t.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
  })
  it('shares the per-book switch through folder metadata without replacing its identity properties', async () => {
    const t = transport()
    expect((await t.client.projects())[0].autoSync).toBe(true)
    await t.client.setProjectAutoSync(t.folderId, t.projectId, false)
    expect((await t.client.projects())[0].autoSync).toBe(false)
    expect(t.files.get(t.folderId)!.appProperties).toMatchObject({ ainwApp: DRIVE_APP_TAG, ainwKind: 'project', ainwProject: t.projectId })
    await t.client.setProjectAutoSync(t.folderId, t.projectId, true)
    expect((await t.client.projects())[0].autoSync).toBe(true)
  })
  it('transfers explicitly requested model settings separately, updates one file, and confirms a lost update acknowledgement',async()=>{
    const t=transport(),first=new TextEncoder().encode(JSON.stringify({apiKey:'SYNTHETIC_FIRST_KEY',modelName:'text'}))
    await t.client.writeModelSettings(t.folderId,t.projectId,first)
    expect(await t.client.readModelSettings(t.folderId,t.projectId)).toEqual(first)
    expect([...t.files.values()].filter(f=>f.appProperties?.ainwKind==='model-settings')).toHaveLength(1)
    expect([...t.files.values()].filter(f=>['sync','asset','backup'].includes(f.appProperties?.ainwKind??''))).toHaveLength(0)
    const next=new TextEncoder().encode(JSON.stringify({apiKey:'SYNTHETIC_SECOND_KEY',modelName:'向量模型🙂'}));t.loseFinal()
    await t.client.writeModelSettings(t.folderId,t.projectId,next)
    expect(await t.client.readModelSettings(t.folderId,t.projectId)).toEqual(next)
    expect([...t.files.values()].filter(f=>f.appProperties?.ainwKind==='model-settings')).toHaveLength(1)
    expect(t.calls.filter(c=>c.method==='PATCH')).toHaveLength(1)
  })
  it('refuses missing, ambiguous and corrupt model files instead of applying partial settings',async()=>{
    const t=transport();await expect(t.client.readModelSettings(t.folderId,t.projectId)).rejects.toThrow('MODEL_SYNC_NOT_FOUND')
    await t.client.writeModelSettings(t.folderId,t.projectId,new TextEncoder().encode('synthetic-settings'))
    const file=[...t.files.values()].find(f=>f.appProperties?.ainwKind==='model-settings')!
    t.bodies.set(file.id,new Uint8Array(Number(file.size)).fill(42))
    await expect(t.client.readModelSettings(t.folderId,t.projectId)).rejects.toThrow(/DRIVE_(HASH_MISMATCH|FILE_TOO_LARGE)/)
    t.files.set('duplicate',{...file,id:'duplicate'})
    await expect(t.client.readModelSettings(t.folderId,t.projectId)).rejects.toThrow('MODEL_SYNC_CLOUD_CONFLICT')
  })
  it('confirms a lost final acknowledgement using server checksum and reserved identity without duplicate creates', async () => {
    const test = transport(), bytes = new TextEncoder().encode('合成同步内容'), upload = { fileId: await test.client.allocateId(), digest: hash(bytes) }
    test.loseFinal()
    expect(await test.client.publish(test.folderId, test.projectId, bytes, upload)).toBe(true)
    expect(await test.client.publish(test.folderId, test.projectId, bytes, upload)).toBe(false)
    expect(test.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(test.bodies.get(upload.fileId)).toEqual(bytes)
  })
  it('queries and resumes an interrupted upload rather than starting a second object', async () => {
    const test = transport(), bytes = new Uint8Array(6 * 1024 * 1024).fill(77)
    const upload: DriveUpload = { fileId: await test.client.allocateId(), digest: hash(bytes) }
    test.loseChunk()
    await expect(test.client.publish(test.folderId, test.projectId, bytes, upload)).rejects.toThrow('DRIVE_NETWORK_FAILED')
    expect(upload.sessionUrl).toBeTruthy()
    expect(await test.client.publish(test.folderId, test.projectId, bytes, upload)).toBe(true)
    expect(test.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(hash(test.bodies.get(upload.fileId)!)).toBe(hash(bytes))
  })
  it('does not trust self-declared digest metadata when server media checksum differs', async () => {
    const test = transport(), bytes = new TextEncoder().encode('AAAA'), upload = { fileId: await test.client.allocateId(), digest: hash(bytes) }
    await test.client.publish(test.folderId, test.projectId, bytes, upload)
    test.files.get(upload.fileId)!.md5Checksum = hash(new TextEncoder().encode('BBBB'), 'md5')
    await expect(test.client.publish(test.folderId, test.projectId, bytes, upload)).rejects.toThrow('DRIVE_OBJECT_MISMATCH')
  })
  it('rebuilds discovery after an expired cursor and applies incremental removal without deleting local prose', async () => {
    const test = transport(), bytes = new TextEncoder().encode('synthetic'), upload = { fileId: await test.client.allocateId(), digest: hash(bytes) }
    await test.client.publish(test.folderId, test.projectId, bytes, upload)
    const full = await test.client.discover(test.folderId, test.projectId, [], 'expired')
    expect(full.cursor).toBe('7'); expect(full.files.map(file => file.id)).toEqual([upload.fileId])
    test.changes([{ fileId: upload.fileId, removed: true }])
    expect((await test.client.discover(test.folderId, test.projectId, full.files, full.cursor)).files).toHaveLength(0)
    expect(test.bodies.get(upload.fileId)).toEqual(bytes)
  })
  it('rejects altered downloads and mismatched project folders before domain import', async () => {
    const test = transport(), bytes = new TextEncoder().encode('AAAA'), upload = { fileId: await test.client.allocateId(), digest: hash(bytes) }
    await test.client.publish(test.folderId, test.projectId, bytes, upload)
    test.bodies.set(upload.fileId, new TextEncoder().encode('BBBB'))
    await expect(test.client.download(test.files.get(upload.fileId)!, test.folderId, test.projectId)).rejects.toThrow('DRIVE_HASH_MISMATCH')
    await expect(test.client.checkFolder(test.folderId, randomUUID())).rejects.toThrow('DRIVE_PROJECT_MISMATCH')
  })
  it('never forwards a bearer token to an untrusted resumable location', async () => {
    const test = transport(), bytes = new TextEncoder().encode('synthetic'), upload = { fileId: await test.client.allocateId(), digest: hash(bytes) }
    test.hostile()
    await expect(test.client.publish(test.folderId, test.projectId, bytes, upload)).rejects.toThrow('DRIVE_RESPONSE_INVALID')
    expect(test.calls.filter(call => call.method === 'PUT')).toHaveLength(0)
  })
})

describe('Google Drive bounded binary objects', () => {
  it('publishes an actual zero-byte asset and verifies an unknown result without an extra create', async () => {
    const test = transport(), source = driveBytesSource(new Uint8Array()), upload = { fileId: await test.client.allocateId(), digest: source.sha256 }
    test.loseFinal()
    await test.client.publishObject(test.folderId, test.projectId, 'asset', source, upload)
    await test.client.publishObject(test.folderId, test.projectId, 'asset', source, upload)
    expect(test.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(test.files.get(upload.fileId)).toMatchObject({ size: '0', md5Checksum: hash(new Uint8Array(), 'md5') })
    await test.client.downloadObject(test.files.get(upload.fileId)!, test.folderId, test.projectId, 'asset', { sha256: source.sha256, byteSize: 0 }, () => { throw new Error('empty object has no chunks') })
  })
  it('streams a multi-chunk archive, verifies it and keeps it out of sync discovery', async () => {
    const test = transport(), bytes = new Uint8Array(9 * 1024 ** 2 + 17).fill(37), source = driveBytesSource(bytes)
    const upload = { fileId: await test.client.allocateId(), digest: source.sha256 }
    await test.client.publishObject(test.folderId, test.projectId, 'backup', source, upload)
    const listed = await test.client.listObjects(test.folderId, test.projectId, 'backup')
    expect(listed.map(file => file.id)).toEqual([upload.fileId])
    expect((await test.client.discover(test.folderId, test.projectId, [])).files).toEqual([])
    const parts: Uint8Array[] = []
    await test.client.downloadObject(listed[0], test.folderId, test.projectId, 'backup', { sha256: source.sha256, byteSize: source.byteSize }, chunk => { parts.push(chunk) })
    expect(hash(Buffer.concat(parts))).toBe(source.sha256)
    expect(DRIVE_OBJECT_LIMITS.backup).toBeGreaterThan(64 * 1024 ** 2)
    expect(test.calls.some(call => new URL(`https://synthetic.invalid${call.path}`).searchParams.get('q')?.includes("key='ainwKind' and value='sync'"))).toBe(true)
  })
  it('resumes an interrupted binary upload at the same session and reserved identity', async () => {
    const test = transport(), source = driveBytesSource(new Uint8Array(5 * 1024 ** 2 + 1).fill(9))
    const upload: DriveUpload = { fileId: await test.client.allocateId(), digest: source.sha256 }
    test.loseChunk()
    await expect(test.client.publishObject(test.folderId, test.projectId, 'asset', source, upload)).rejects.toThrow('DRIVE_NETWORK_FAILED')
    expect(upload.sessionUrl).toBeTruthy()
    await test.client.publishObject(test.folderId, test.projectId, 'asset', source, upload)
    expect(test.calls.filter(call => call.method === 'POST' && call.path.startsWith('/upload/'))).toHaveLength(1)
    expect(test.bodies.get(upload.fileId)?.byteLength).toBe(source.byteSize)
  })
  it('confirms unknown completion without duplicate binary creates and rejects altered media', async () => {
    const test = transport(), source = driveBytesSource(new TextEncoder().encode('synthetic archive'))
    const upload = { fileId: await test.client.allocateId(), digest: source.sha256 }
    test.loseFinal()
    await test.client.publishObject(test.folderId, test.projectId, 'backup', source, upload)
    await test.client.publishObject(test.folderId, test.projectId, 'backup', source, upload)
    expect(test.calls.filter(call => call.method === 'POST' && call.path.startsWith('/upload/'))).toHaveLength(1)
    test.bodies.set(upload.fileId, new TextEncoder().encode('tampered archive!'))
    await expect(test.client.downloadObject(test.files.get(upload.fileId)!, test.folderId, test.projectId, 'backup', { sha256: source.sha256, byteSize: source.byteSize }, () => {})).rejects.toThrow(/DRIVE_(HASH_MISMATCH|FILE_TOO_LARGE)/)
  })
  it('checks cancellation and the frozen lease during streamed consumption', async () => {
    let current = true
    const test = transport({ revalidate: () => { if (!current) throw new Error('SYNC_SESSION_STALE') } }), source = driveBytesSource(new TextEncoder().encode('streamed data'))
    const upload = { fileId: await test.client.allocateId(), digest: source.sha256 }
    await test.client.publishObject(test.folderId, test.projectId, 'backup', source, upload)
    await expect(test.client.downloadObject(test.files.get(upload.fileId)!, test.folderId, test.projectId, 'backup', { sha256: source.sha256, byteSize: source.byteSize }, () => { current = false })).rejects.toThrow('SYNC_SESSION_STALE')
    const cancel = new AbortController(); cancel.abort()
    const stopped = transport({ signal: cancel.signal })
    await expect(stopped.client.publishObject(stopped.folderId, stopped.projectId, 'backup', source, { fileId: 'fixed', digest: source.sha256 })).rejects.toThrow('DRIVE_CANCELLED')
    expect(stopped.calls).toHaveLength(0)
  })
})
