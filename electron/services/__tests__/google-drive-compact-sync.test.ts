import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ProjectAssetBlob } from '../../../src/shared/project-sync-assets'
import type { DriveFile, GoogleDriveClient } from '../google-drive-client'
import { collectDriveAssetGarbage, DRIVE_ASSET_GC_GRACE_MS, type DriveAssetGarbageState } from '../google-drive-asset-gc'

const projectId = '00000000-0000-4000-8000-000000000101', folderId = 'synthetic_folder'
const confirmedSnapshotHash = 'f'.repeat(64), initialTime = 1_000_000
const bytes = (text: string) => Buffer.from(text)
const digest = (text: string) => createHash('sha256').update(bytes(text)).digest('hex')
const reference = (text: string): ProjectAssetBlob => ({ sha256: digest(text), byteSize: bytes(text).byteLength, mime: 'text/plain' })

/** Independent transport-only fixture: no Google network, account or native storage. */
class MemoryAssets {
  files = new Map<string, DriveFile>()
  deleted: string[] = []
  afterList?: () => void
  beforeDelete?: (file: DriveFile) => void
  add(id: string, text: string): DriveFile {
    const file: DriveFile = { id, name: id, parents: [folderId], size: String(bytes(text).byteLength), md5Checksum: createHash('md5').update(bytes(text)).digest('hex'),
      createdTime: new Date(initialTime).toISOString(), appProperties: { ainwApp: 'ai-novel-writer-sync-v1', ainwKind: 'asset', ainwProject: projectId, ainwDigest: digest(text) } }
    this.files.set(id, file); return file
  }
  async listObjects(folder: string, project: string, kind: string) {
    expect([folder, project, kind]).toEqual([folderId, projectId, 'asset'])
    const snapshot = structuredClone([...this.files.values()]); this.afterList?.(); return snapshot
  }
  async deleteAssetFile(folder: string, project: string, expected: DriveFile) {
    expect([folder, project]).toEqual([folderId, projectId]); this.beforeDelete?.(expected)
    const current = this.files.get(expected.id)
    if (current) {
      expect(current.appProperties?.ainwDigest).toBe(expected.appProperties?.ainwDigest)
      expect(current.md5Checksum).toBe(expected.md5Checksum); expect(current.size).toBe(expected.size)
    }
    this.files.delete(expected.id); this.deleted.push(expected.id)
  }
  client() { return this as unknown as GoogleDriveClient }
}
async function collect(cloud: MemoryAssets, previous: DriveAssetGarbageState = {}, references: ProjectAssetBlob[] = [], now = initialTime,
  refresh: () => Promise<ProjectAssetBlob[]> = async () => references, revalidate: () => void = () => {}) {
  return collectDriveAssetGarbage({ client: cloud.client(), projectId, folderId, confirmedSnapshotHash, currentReferences: references,
    previous, now, refreshLiveReferences: refresh, revalidate })
}

describe('independent compact cloud asset collection review', () => {
  it('requires a prior stable observation and a full grace period before deleting an orphan', async () => {
    const cloud = new MemoryAssets(); cloud.add('old_blob', '旧知识原文')
    const first = await collect(cloud)
    expect(first.deleted).toEqual([]); expect(first.candidates.old_blob.observations).toBe(1)
    const early = await collect(cloud, first.candidates, [], initialTime + DRIVE_ASSET_GC_GRACE_MS - 1)
    expect(early.deleted).toEqual([])
    const aged = await collect(cloud, early.candidates, [], initialTime + DRIVE_ASSET_GC_GRACE_MS)
    expect(aged.deleted).toEqual(['old_blob']); expect(cloud.files.size).toBe(0)
    expect(aged.reclaimedBytes).toBe(bytes('旧知识原文').byteLength)
  })

  it('keeps a newly published same-hash ID outside the old marked sweep set', async () => {
    const cloud = new MemoryAssets(); cloud.add('old_blob', '重新采用的知识原文')
    const marked = await collect(cloud)
    const result = await collect(cloud, marked.candidates, [], initialTime + DRIVE_ASSET_GC_GRACE_MS, async () => {
      // An offline writer publishes a fresh object after the collector listed old IDs.
      cloud.add('fresh_blob', '重新采用的知识原文')
      return [] // Its new domain delta is not yet visible to this collector.
    })
    expect(result.deleted).toEqual(['old_blob'])
    expect(cloud.files.has('fresh_blob')).toBe(true)
    expect(cloud.deleted).not.toContain('fresh_blob')
  })

  it('rechecks current heads and cancels sweeping a blob referenced after marking', async () => {
    const cloud = new MemoryAssets(); cloud.add('restored_blob', '恢复采用的原文')
    const marked = await collect(cloud)
    const result = await collect(cloud, marked.candidates, [], initialTime + DRIVE_ASSET_GC_GRACE_MS, async () => [reference('恢复采用的原文')])
    expect(result.deleted).toEqual([]); expect(cloud.files.has('restored_blob')).toBe(true)
    expect(result.candidates.restored_blob).toBeUndefined()
  })

  it('retains bytes required by either unresolved conflict variant', async () => {
    const cloud = new MemoryAssets(); cloud.add('desktop_blob', '电脑知识版本'); cloud.add('phone_blob', '手机知识版本')
    const result = await collect(cloud, {}, [reference('电脑知识版本'), reference('手机知识版本')], initialTime + 10 * DRIVE_ASSET_GC_GRACE_MS)
    expect(result.deleted).toEqual([]); expect(result.candidates).toEqual({}); expect(cloud.files.size).toBe(2)
  })

  it('uses a stable retained duplicate while two collectors sweep concurrently', async () => {
    const cloud = new MemoryAssets(); cloud.add('asset_a', '相同原文'); cloud.add('asset_b', '相同原文'); cloud.add('asset_c', '相同原文')
    const refs = [reference('相同原文')], first = await collect(cloud, {}, refs)
    expect(Object.keys(first.candidates).sort()).toEqual(['asset_b', 'asset_c'])
    await Promise.all([collect(cloud, structuredClone(first.candidates), refs, initialTime + DRIVE_ASSET_GC_GRACE_MS), collect(cloud, structuredClone(first.candidates), refs, initialTime + DRIVE_ASSET_GC_GRACE_MS)])
    expect([...cloud.files.keys()]).toEqual(['asset_a'])
    expect(cloud.deleted).not.toContain('asset_a')
  })

  it('revalidates a suspended operation after refreshing heads and before deleting', async () => {
    const cloud = new MemoryAssets(); cloud.add('old_blob', '被标记原文')
    const marked = await collect(cloud); let valid = true
    await expect(collect(cloud, marked.candidates, [], initialTime + DRIVE_ASSET_GC_GRACE_MS, async () => { valid = false; return [] },
      () => { if (!valid) throw Error('DRIVE_SYNC_TIMEOUT') })).rejects.toThrow('DRIVE_SYNC_TIMEOUT')
    expect(cloud.deleted).toEqual([]); expect(cloud.files.has('old_blob')).toBe(true)
  })

  it('restarts the grace period when the observed immutable identity changes', async () => {
    const cloud = new MemoryAssets(); cloud.add('old_blob', '原内容')
    const marked = await collect(cloud)
    cloud.add('old_blob', '不同内容不沿用旧标记')
    const result = await collect(cloud, marked.candidates, [], initialTime + 2 * DRIVE_ASSET_GC_GRACE_MS)
    expect(result.deleted).toEqual([]); expect(result.candidates.old_blob.observations).toBe(1)
    expect(result.candidates.old_blob.firstUnreferencedAt).toBe(initialTime + 2 * DRIVE_ASSET_GC_GRACE_MS)
  })
})
