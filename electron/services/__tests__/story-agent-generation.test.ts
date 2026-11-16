import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { StoryBranchRepository } from '../../repositories/story-branch-repository'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { generationOutputContract } from '../../../src/shared/generation-owner-contract'
import type { AgentGenerationInput } from '../../../src/shared/agent-generation'
import type { StoryContextRequest, StoryNodeInput, StoryOperation } from '../../../src/shared/story-branches'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool } from '../../../src/services/agent/tools/story-tools'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks() })
function fixture() {
  const root = fs.mkdtempSync(path.resolve('.runtime', 'story-agent-'))
  const db = new Database(':memory:')
  db.transaction(() => { initializeLegacyBaselineSchema(db); migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION) })()
  db.prepare("INSERT INTO project_core(id,project_name,characters_arch,character_states) VALUES('main','分支合成项目','旧全局动态状态','全局其他路线状态')").run()
  db.prepare("INSERT INTO characters(character_id,name,role,background,cs_location) VALUES(?,'林岚','protagonist','守塔人的基础设定','外线位置信息')").run(randomUUID())
  const start = randomUUID(), left = randomUUID(), right = randomUUID(), merge = randomUUID(), routeA = randomUUID(), routeB = randomUUID()
  const node = (id: string, kind: StoryNodeInput['kind'], title: string, body: string): StoryNodeInput => ({ id, kind, title, chapterNumber: null, event: title, body })
  const ops: StoryOperation[] = [
    { type: 'put-node', node: node(start, 'branch', '门厅的岔路', '共同门厅正文') },
    { type: 'put-node', node: node(left, 'content', '左路线事件', '红钥匙只在左路获得的孤立事实') },
    { type: 'put-node', node: node(right, 'content', '右路线事件', '蓝钥匙只在右路获得的孤立事实') },
    { type: 'put-node', node: node(merge, 'merge', '汇合正文', '共用节点旧正文') },
    ...[[start, left], [start, right], [left, merge], [right, merge]].map(([from, to]): StoryOperation => ({ type: 'put-edge', edge: { id: randomUUID(), from, to, label: '继续', condition: '' } })),
    { type: 'put-route', route: { id: routeA, title: '左路线', nodeIds: [start, left, merge] } },
    { type: 'put-route', route: { id: routeB, title: '右路线', nodeIds: [start, right, merge] } },
  ]
  StoryBranchRepository.commit(db, StoryBranchRepository.read(db).revision, ops)
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-only', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  let response = '路线候选。'
  const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => { options.onVisible({ kind: 'delta', text: response }); return { finishReason: 'stop', usage: null } })
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: () => JSON.stringify({ key: 'assistant_writing_identity', content: '合成写作助手', systemRole: '小说写作' }) }
  const owner = createMainGenerationOwner({ database: db, projectId: 'project', epoch: 'epoch', assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch,
    buildBinding: (selection, receipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch: 'epoch', modelReceipt: receipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, receipt) => rebuildGenerationSourceBinding(deps, previous, 'epoch', receipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const input = (request: StoryContextRequest): AgentGenerationInput => ({ mode: 'planning', uiLocale: 'zh-CN', historyMessages: [], userMessage: '按照所选路线写作', storyContext: request,
    tools: [readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool].map(({ name, description, inputSchema, requiresConfirmation, isReadOnly, source }) => ({ name, description, inputSchema: { ...inputSchema }, requiresConfirmation, isReadOnly, source })) })
  const begin = (request: StoryContextRequest) => owner.agents.begin({ uiActionNonce: randomUUID(), modelId: model.id, input: input(request) })
  const propose = (id: string) => {
    const { revisionId: _revision, ...target } = StoryBranchRepository.read(db).nodes.find(item => item.id === id)!
    response = '路线候选。<tool_call>' + JSON.stringify({ name: 'propose_story_changes', arguments: { operations: [{ type: 'put-node', node: { ...target, body: '待作者批准的当前路线新正文' } }] } }) + '</tool_call>'
  }
  return { db, owner, dispatch, begin, propose, start, left, right, merge, routeA, routeB }
}

describe('story-bound Agent uses actual main admission and effect receipts', { timeout: 120_000 }, () => {
  it('sends only the selected route and static character facts, then commits only after approval and deduplicates the receipt', async () => {
    const f = fixture(); f.propose(f.left)
    const begin = f.begin({ nodeId: f.left, routeId: f.routeA, mode: 'route' })
    const result = await f.owner.agents.executeRound({ handle: begin.handle, index: 0 })
    const modelMessages = JSON.stringify((f.dispatch.mock.calls[0][0] as { task: { messages: unknown[] } }).task.messages)
    expect(modelMessages).toContain('共同门厅正文'); expect(modelMessages).toContain('守塔人的基础设定')
    for (const excluded of ['蓝钥匙只在右路获得的孤立事实', '全局其他路线状态', '旧全局动态状态', '外线位置信息']) expect(modelMessages).not.toContain(excluded)
    const ref = result.rounds[0].actions[0].ref
    expect(() => f.owner.agents.commitDomainTool(ref)).toThrow('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
    expect(StoryBranchRepository.read(f.db).nodes.find(node => node.id === f.left)!.body).not.toContain('待作者批准')
    expect(f.owner.agents.claimTool({ ref, confirmed: true }).execute).toBe(true)
    const receipt = f.owner.agents.commitDomainTool(ref)
    expect(receipt.kind).toBe('story')
    const revisions = StoryBranchRepository.read(f.db).revisions.length
    expect(f.owner.agents.commitDomainTool(ref)).toMatchObject({ afterHash: receipt.afterHash, current: true })
    expect(StoryBranchRepository.read(f.db).revisions).toHaveLength(revisions)
    expect(StoryBranchRepository.read(f.db).nodes.find(node => node.id === f.left)!.body).toBe('待作者批准的当前路线新正文')
  })

  it('keeps the visible candidate and refuses to commit after a path changes while approval waits', async () => {
    const f = fixture(); f.propose(f.left)
    const begin = f.begin({ nodeId: f.left, routeId: f.routeA, mode: 'route' })
    const result = await f.owner.agents.executeRound({ handle: begin.handle, index: 0 })
    const before = StoryBranchRepository.read(f.db), route = before.routes.find(item => item.id === f.routeA)!
    StoryBranchRepository.commit(f.db, before.revision, [{ type: 'put-route', route: { ...route, title: '作者更新的路线' } }])
    expect(() => f.owner.agents.claimTool({ ref: result.rounds[0].actions[0].ref, confirmed: true })).toThrow('GENERATION_AGENT_TOOL_STALE')
    expect(result.run.artifacts[0].text).toContain('路线候选')
    expect(StoryBranchRepository.read(f.db).nodes.find(node => node.id === f.left)!.body).not.toContain('待作者批准')
  })

  it('rejects unconfirmed shared writing before dispatch, then uses only confirmed common continuity and entry differences', async () => {
    const f = fixture(), request: StoryContextRequest = { nodeId: f.merge, routeId: null, mode: 'shared' }
    expect(() => f.begin(request)).toThrow('GENERATION_AGENT_STORY_CONTEXT_NOT_READY')
    expect(() => f.begin({ nodeId: f.merge, routeId: f.routeA, mode: 'route' })).toThrow('GENERATION_AGENT_STORY_CONTEXT_NOT_READY')
    expect(f.dispatch).not.toHaveBeenCalled()
    const context = StoryBranchRepository.context(f.db, request)
    StoryBranchRepository.commit(f.db, StoryBranchRepository.read(f.db).revision, [{ type: 'put-note', note: { id: randomUUID(), nodeId: f.merge, routeId: null, summary: '共同事实：两人都已进入门厅', characterStates: '都保持清醒', entryDifferences: '左右路线走过的通道不同' }, expectedSourceHash: context.sourceHash, confirm: true }])
    f.propose(f.merge)
    const begin = f.begin(request), result = await f.owner.agents.executeRound({ handle: begin.handle, index: 0 })
    const modelMessages = JSON.stringify((f.dispatch.mock.calls[0][0] as { task: { messages: unknown[] } }).task.messages)
    expect(modelMessages).toContain('共同事实：两人都已进入门厅')
    expect(modelMessages).toContain('左右路线走过的通道不同')
    expect(modelMessages).not.toContain('红钥匙只在左路获得的孤立事实')
    expect(modelMessages).not.toContain('蓝钥匙只在右路获得的孤立事实')
    const ref = result.rounds[0].actions[0].ref
    f.owner.agents.claimTool({ ref, confirmed: true })
    expect(f.owner.agents.commitDomainTool(ref).kind).toBe('story')
  })

  it('does not write when the author refuses, and rechecks a source change after approval before the commit point', async () => {
    const declined = fixture(); declined.propose(declined.left)
    const start = declined.begin({ nodeId: declined.left, routeId: declined.routeA, mode: 'route' })
    const result = await declined.owner.agents.executeRound({ handle: start.handle, index: 0 }), ref = result.rounds[0].actions[0].ref
    expect(declined.owner.agents.claimTool({ ref, confirmed: false }).execute).toBe(false)
    expect(() => declined.owner.agents.commitDomainTool(ref)).toThrow('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
    expect(StoryBranchRepository.read(declined.db).nodes.find(node => node.id === declined.left)!.body).not.toContain('待作者批准')
    const raced = fixture(); raced.propose(raced.left)
    const begun = raced.begin({ nodeId: raced.left, routeId: raced.routeA, mode: 'route' })
    const pending = await raced.owner.agents.executeRound({ handle: begun.handle, index: 0 }), raceRef = pending.rounds[0].actions[0].ref
    raced.owner.agents.claimTool({ ref: raceRef, confirmed: true })
    const before = StoryBranchRepository.read(raced.db), route = before.routes.find(row => row.id === raced.routeA)!
    StoryBranchRepository.commit(raced.db, before.revision, [{ type: 'put-route', route: { ...route, title: '批准后来源变化' } }])
    expect(() => raced.owner.agents.commitDomainTool(raceRef)).toThrow('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
    expect(StoryBranchRepository.read(raced.db).nodes.find(node => node.id === raced.left)!.body).not.toContain('待作者批准')
  })
})
