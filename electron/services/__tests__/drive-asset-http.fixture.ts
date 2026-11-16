import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { GoogleDriveClient, DRIVE_APP_TAG, type DriveFile } from '../google-drive-client'

const hash = (bytes: Uint8Array, algorithm: string) => createHash(algorithm).update(bytes).digest('hex')
/** Loopback REST substitute. The production Drive client performs every request. */
export async function createDriveAssetHttpFixture(projectId: string) {
  const folderId = 'asset-folder', files = new Map<string, DriveFile>(), bodies = new Map<string, Buffer>()
  files.set(folderId, { id: folderId, name: 'Synthetic assets', mimeType: 'application/vnd.google-apps.folder', appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'project', ainwProject: projectId } })
  const sessions = new Map<string, { metadata: DriveFile; total: number; bytes: Buffer }>()
  const events: Array<{ sequence: number; fileId: string; file: DriveFile }> = []
  const calls: Array<{ method: string; path: string; kind?: string }> = [], committed: string[] = []
  let counter = 0, sequence = 0, base = '', interruptAsset = false, redirectAsset = false
  let beforeAssetRead: (() => void) | undefined
  const commit = (file: DriveFile, bytes: Buffer) => {
    const value = { ...file, size: String(bytes.length), md5Checksum: hash(bytes, 'md5') }
    files.set(file.id, value); bodies.set(file.id, bytes); committed.push(file.appProperties!.ainwKind)
    events.push({ sequence: ++sequence, fileId: file.id, file: value })
  }
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url!, base), method = request.method ?? 'GET'
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    try {
      if (request.headers.authorization !== 'Bearer SYNTHETIC_ASSET_TOKEN') { json({}, 401); return }
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part))
      const body = Buffer.concat(parts); let kind: string | undefined
      if (method === 'POST' && url.searchParams.get('uploadType') === 'resumable') kind = JSON.parse(body.toString()).appProperties?.ainwKind
      calls.push({ method, path: url.pathname + url.search, kind })
      if (url.pathname.startsWith('/upload/drive/v3/files/') && method === 'PATCH') {
        const id=url.pathname.split('/').at(-1)!,previous=files.get(id)
        if(!previous){json({},404);return}
        const boundary=/boundary=([^;]+)/.exec(String(request.headers['content-type']))![1]
        const segments=body.toString().split(`--${boundary}`)
        const metadata=JSON.parse(segments[1].split('\r\n\r\n')[1].trim())
        const content=segments[2].slice(segments[2].indexOf('\r\n\r\n')+4).replace(/\r\n$/,'')
        commit({...previous,...metadata},Buffer.from(content));json({id});return
      }
      if (url.pathname === '/drive/v3/about') { json({ user: { permissionId: 'asset-account' } }); return }
      if (url.pathname.endsWith('/files/generateIds')) { json({ ids: [`reserved_${++counter}`] }); return }
      if (url.pathname === '/drive/v3/changes/startPageToken') { json({ startPageToken: String(sequence) }); return }
      if (url.pathname === '/drive/v3/changes') {
        json({ changes: events.filter(event => event.sequence > Number(url.searchParams.get('pageToken'))).map(({ fileId, file }) => ({ fileId, file })), newStartPageToken: String(sequence) }); return
      }
      if (url.pathname === '/drive/v3/files' && method === 'GET') {
        const query = url.searchParams.get('q')!, selectedKind = /key='ainwKind' and value='([^']+)'/.exec(query)?.[1]
        json({ files: [...files.values()].filter(file => !file.trashed && (!selectedKind || file.appProperties?.ainwKind === selectedKind)
          && (query.includes(' in parents') ? file.parents?.includes(folderId) : true)) }); return
      }
      if (url.pathname.startsWith('/drive/v3/files/')) {
        const id = url.pathname.split('/').at(-1)!, file = files.get(id)
        if (!file) { json({}, 404); return }
        if (url.searchParams.get('alt') !== 'media') { json(file); return }
        if (file.appProperties?.ainwKind === 'asset') beforeAssetRead?.()
        const bytes = bodies.get(id)!, range = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range ?? ''))
        if (range) {
          const start = Number(range[1]), end = Number(range[2])
          response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${bytes.length}` })
          response.end(bytes.subarray(start, end + 1))
        } else { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(bytes) }
        return
      }
      if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
        if (url.searchParams.get('uploadType') === 'multipart') {
          const boundary = /boundary=([^;]+)/.exec(String(request.headers['content-type']))![1]
          const segments = body.toString().split(`--${boundary}`), metadata = JSON.parse(segments[1].split('\r\n\r\n')[1].trim())
          commit(metadata, Buffer.alloc(0)); json({ id: metadata.id }); return
        }
        const metadata = JSON.parse(body.toString()), session = String(++counter)
        sessions.set(session, { metadata, total: Number(request.headers['x-upload-content-length']), bytes: Buffer.alloc(0) })
        response.writeHead(200, { Location: `${base}/upload/drive/v3/files?upload_id=${session}` }); response.end(); return
      }
      if (url.pathname === '/upload/drive/v3/files' && method === 'PUT') {
        const session = sessions.get(url.searchParams.get('upload_id')!)
        if (!session) { json({}, 404); return }
        if (redirectAsset && session.metadata.appProperties?.ainwKind === 'asset') { redirectAsset = false; response.writeHead(308, { Location: `${base}/sink`, Range: 'bytes=0-0' }); response.end(); return }
        const range = String(request.headers['content-range'])
        if (!range.startsWith('bytes */')) session.bytes = Buffer.concat([session.bytes, body])
        if (session.bytes.length === session.total) { commit(session.metadata, session.bytes); json({ id: session.metadata.id }); return }
        if (interruptAsset && session.metadata.appProperties?.ainwKind === 'asset' && body.length) { interruptAsset = false; request.socket.destroy(); return }
        response.writeHead(308, session.bytes.length ? { Range: `bytes=0-${session.bytes.length - 1}` } : {}); response.end(); return
      }
      json({}, 404)
    } catch { if (!response.headersSent) json({}, 500); else response.destroy() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { folderId, files, bodies, calls, committed,
    client: (check: () => void = () => {}) => new GoogleDriveClient(async () => 'SYNTHETIC_ASSET_TOKEN', { apiBase: base, fetch: globalThis.fetch, revalidate: check }),
    interruptNextAssetChunk() { interruptAsset = true }, redirectNextAssetPut() { redirectAsset = true }, beforeAssetRead(callback: (() => void) | undefined) { beforeAssetRead = callback },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
