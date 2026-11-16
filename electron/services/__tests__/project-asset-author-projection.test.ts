import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectAuthorFileBytes, assertProjectAuthorFileBytes } from '../project-asset-author-projection'
import { createPortableProjectAssetProvider } from '../portable-project-assets'
import { withKnowledgeSourceGate } from '../knowledge-source-gate'
import { randomUUID } from 'node:crypto'

const roots: string[] = []
const scope = (root: string) => ({ sourceProjectRoot: root, sourceDatabasePath: path.join(root, '.ai-novel', 'project.db'),
  projectSession: { projectId: randomUUID(), leaseId: 'fixture-lease', projectPath: root }, snapshotGeneration: 'fixture-snapshot' })
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const checkpoint = () => Buffer.from(JSON.stringify({ synopsis_result: '作者候选🌙', synopsis_incomplete: true,
  synopsis_range: { from: 2, to: 5 }, synopsis_generation_handle: { projectId: 'old-project', epoch: 'old-epoch', runId: 'local-run' },
  world_building_generation_handle: { runId: 'local-world-run' } }))
describe('author checkpoints never transfer live execution handles', () => {
  it('preserves author fields while excluding both known runtime handles, and keeps ordinary author bytes exact', () => {
    const original = checkpoint(), projected = projectAuthorFileBytes('partial_arch.json', original)
    expect(JSON.parse(projected.toString())).toEqual({ synopsis_result: '作者候选🌙', synopsis_incomplete: true, synopsis_range: { from: 2, to: 5 } })
    expect(() => assertProjectAuthorFileBytes('PARTIAL_ARCH.JSON', original)).toThrow('PROJECT_SYNC_ASSET_RUNTIME_AUTHORITY')
    assertProjectAuthorFileBytes('partial_arch.json', projected)
    const text = Buffer.from('Skill中同名字段为作者内容\r\n🌙')
    expect(projectAuthorFileBytes('skills/story/SKILL.md', text)).toBe(text)
  })
  it('projects portable/cloud backup checkpoints without modifying the source bytes', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ainw-checkpoint-archive-'))); roots.push(root)
    const storage = path.join(root, '.ai-novel'); fs.mkdirSync(storage)
    const source = path.join(storage, 'partial_arch.json'), original = checkpoint(); fs.writeFileSync(source, original)
    const snapshot = await createPortableProjectAssetProvider().snapshot(scope(root))
    const file = snapshot.files.find(file => file.archivePath === 'partial_arch.json')!
    expect(file.sourcePath).toBe(''); expect(file.bytes).toEqual(projectAuthorFileBytes('partial_arch.json', original))
    expect(fs.readFileSync(source)).toEqual(original)
    expect(await snapshot.verifyUnchanged()).toBe(true)
  })
  it('rechecks physical author files after awaiting the knowledge source gate during backup validation', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ainw-checkpoint-race-'))); roots.push(root)
    const storage = path.join(root, '.ai-novel'); fs.mkdirSync(storage)
    const source = path.join(storage, 'partial_arch.json'); fs.writeFileSync(source, checkpoint())
    const snapshot = await createPortableProjectAssetProvider().snapshot(scope(root))
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { entered = resolve })
    const gate = withKnowledgeSourceGate(storage, async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
    await held
    const checking = snapshot.verifyUnchanged()
    fs.writeFileSync(source, JSON.stringify({ synopsis_result: '等待期间的新作者正文' }))
    release(); await gate
    expect(await checking).toBe(false)
    expect(fs.readFileSync(source, 'utf8')).toContain('等待期间的新作者正文')
  })
})
