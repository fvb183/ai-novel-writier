import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DRIVE_APP_TAG, GoogleDriveClient, type DriveFile } from '../google-drive-client'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function fixture() {
  const projectId = randomUUID(), folderId = 'synthetic_folder', bytes = Buffer.from('仅用于自动回收边界验证')
  const asset: DriveFile = { id: 'synthetic_asset', name: 'synthetic_asset', mimeType: 'application/octet-stream', parents: [folderId], size: String(bytes.byteLength), md5Checksum: createHash('md5').update(bytes).digest('hex'),
    appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'asset', ainwProject: projectId, ainwDigest: createHash('sha256').update(bytes).digest('hex') } }
  const folder: DriveFile = { id: folderId, name: '合成作品', mimeType: 'application/vnd.google-apps.folder', appProperties: { ainwApp: DRIVE_APP_TAG, ainwKind: 'project', ainwProject: projectId } }
  const files = new Map([[folderId, folder], [asset.id, asset]]), deletes: string[] = []
  let valid = true, invalidateAfterAssetMetadata = false
  const client = new GoogleDriveClient(async () => 'SYNTHETIC_TOKEN', { revalidate: () => { if (!valid) throw Error('SYNC_SESSION_STALE') }, fetch: async (input, init) => {
    const url = new URL(String(input)), id = url.pathname.split('/').at(-1)!
    expect(url.origin).toBe('https://www.googleapis.com'); expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer SYNTHETIC_TOKEN')
    const file = files.get(id)
    if (!file) return json({}, 404)
    if (init?.method === 'DELETE') { deletes.push(id); files.delete(id); return new Response(null, { status: 204 }) }
    if (id === asset.id && invalidateAfterAssetMetadata) valid = false
    return json(file)
  } })
  return { client, projectId, folderId, expected: structuredClone(asset), files, deletes, invalidate: () => { invalidateAfterAssetMetadata = true } }
}

describe('independent permanent asset deletion boundary review', () => {
  it('deletes an unchanged asset in the exact project and treats a missing retry as already collected', async () => {
    const f = fixture()
    await f.client.deleteAssetFile(f.folderId, f.projectId, f.expected)
    expect(f.files.has(f.expected.id)).toBe(false); expect(f.deletes).toEqual([f.expected.id])
    await f.client.deleteAssetFile(f.folderId, f.projectId, f.expected)
    expect(f.deletes).toEqual([f.expected.id])
  })
  it.each(['parent', 'project', 'kind'] as const)('rejects an expected asset with the wrong %s without a DELETE request', async mode => {
    const f = fixture(), wrong = structuredClone(f.expected)
    if (mode === 'parent') wrong.parents = ['another_folder']
    if (mode === 'project') wrong.appProperties!.ainwProject = randomUUID()
    if (mode === 'kind') wrong.appProperties!.ainwKind = 'backup'
    await expect(f.client.deleteAssetFile(f.folderId, f.projectId, wrong)).rejects.toThrow('DRIVE_OBJECT_MISMATCH')
    expect(f.deletes).toEqual([]); expect(f.files.has(f.expected.id)).toBe(true)
  })
  it.each(['size', 'md5Checksum', 'ainwDigest'] as const)('rejects changed %s metadata after observation', async field => {
    const f = fixture(), stored = f.files.get(f.expected.id)!
    if (field === 'ainwDigest') stored.appProperties!.ainwDigest = '0'.repeat(64)
    else stored[field] = field === 'size' ? '999999' : '0'.repeat(32)
    await expect(f.client.deleteAssetFile(f.folderId, f.projectId, f.expected)).rejects.toThrow('DRIVE_IMMUTABLE_OBJECT_CHANGED')
    expect(f.deletes).toEqual([]); expect(f.files.has(f.expected.id)).toBe(true)
  })
  it('rechecks the lease after asynchronous metadata lookup and before DELETE', async () => {
    const f = fixture(); f.invalidate()
    await expect(f.client.deleteAssetFile(f.folderId, f.projectId, f.expected)).rejects.toThrow('SYNC_SESSION_STALE')
    expect(f.deletes).toEqual([]); expect(f.files.has(f.expected.id)).toBe(true)
  })
})
