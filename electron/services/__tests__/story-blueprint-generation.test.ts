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
import type { StoryChapterBlueprint, StoryNodeInput } from '../../../src/shared/story-branches'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool } from '../../../src/services/agent/tools/story-tools'

const disposers: (() => void)[] = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks() })
const blueprint: StoryChapterBlueprint = { title: '灯塔求援计划', role: '推进抉择', purpose: '找到援军', keyEvents: '点亮塔灯；守塔人回应', characters: ['林岚'], suspenseHook: '回应来自地下', userGuidance: '保留暴雨声', notes: '暂不揭晓回应者' }

function fixture() {
  const root = fs.mkdtempSync(path.resolve('.runtime', 'story-blueprint-agent-')), db = new Database(':memory:')
  db.transaction(() => { initializeLegacyBaselineSchema(db); migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION) })()
  db.prepare("INSERT INTO project_core(id,project_name,core_outline,synopsis) VALUES('main','合成章节项目','主线未来结局秘密','主线未来总纲秘密')").run()
  db.prepare("INSERT INTO blueprints(chapter_number,title,key_events) VALUES(8,'全局主线第八章','全局主线未来蓝图秘密')").run()
  const contentId = db.prepare("INSERT INTO contents(body) VALUES('全局主线旧稿不能覆盖')").run().lastInsertRowid
  db.prepare("INSERT INTO drafts(chapter_number,version,content_id,status) VALUES(8,1,?,'draft')").run(contentId)
  const start = randomUUID(), target = randomUUID(), other = randomUUID(), route = randomUUID(), otherRoute = randomUUID(), next = randomUUID(), unselectedNext = randomUUID()
  const chapterSource = { chapterNumber: 8, blueprintHash: 'a'.repeat(64), manuscriptHash: 'b'.repeat(64) }
  const node = (id: string, title: string, body: string): StoryNodeInput => ({ id, kind: 'content', title, chapterNumber: null, event: title, body })
  StoryBranchRepository.commit(db, StoryBranchRepository.read(db).revision, [
    { type: 'put-node', node: { ...node(start, '父级海岸', '父级已发生：抵达海岸'), kind: 'branch', chapterBlueprint: { ...blueprint, keyEvents: '父级未发生的规划秘密' } } },
    { type: 'put-node', node: { ...node(target, '灯塔分支节点', '分支旧稿'), chapterNumber: 8, chapterBlueprint: blueprint, chapterSource } },
    { type: 'put-node', node: { ...node(other, '其他路线', '他路线独有正文秘密'), chapterBlueprint: { ...blueprint, keyEvents: '他路线独有蓝图秘密' } } },
    { type: 'put-node', node: { ...node(next, '指定接回后文', '指定后文开场：援军等候在地下'), chapterBlueprint: { ...blueprint, keyEvents: '指定后文将要发生的计划' } } },
    { type: 'put-node', node: node(unselectedNext, '另一份后文', '未指定的后文秘密不得注入') },
    ...[target, other].map(to => ({ type: 'put-edge' as const, edge: { id: randomUUID(), from: start, to, label: '继续', condition: '' } })),
    ...[next, unselectedNext].map(to => ({ type: 'put-edge' as const, edge: { id: randomUUID(), from: target, to, label: '衔接后文', condition: '' } })),
    { type: 'put-route', route: { id: route, title: '灯塔路线', nodeIds: [start, target] } },
    { type: 'put-route', route: { id: otherRoute, title: '其他路线', nodeIds: [start, other] } },
  ])
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'synthetic', apiKey: 'synthetic-only', baseUrl: 'https://example.invalid', temperature: .7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  let response = ''
  const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => { options.onVisible({ kind: 'delta', text: response }); return { finishReason: 'stop', usage: null } })
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: () => JSON.stringify({ key: 'assistant_writing_identity', content: '合成章节助手', systemRole: '小说写作' }) }
  const owner = createMainGenerationOwner({ database: db, projectId: 'project', epoch: 'epoch', assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch,
    buildBinding: (selection, receipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch: 'epoch', modelReceipt: receipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, receipt) => rebuildGenerationSourceBinding(deps, previous, 'epoch', receipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  disposers.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const targetNode = () => StoryBranchRepository.read(db).nodes.find(node => node.id === target)!
  const input: AgentGenerationInput = { mode: 'fast', uiLocale: 'zh-CN', historyMessages: [], userMessage: '按当前蓝图生成章节，只提交目标正文', storyContext: { nodeId: target, routeId: route, mode: 'route' },
    tools: [readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool].map(({ name, description, inputSchema, requiresConfirmation, isReadOnly, source }) => ({ name, description, inputSchema: { ...inputSchema }, requiresConfirmation, isReadOnly, source })) }
  const begin = (bridgeToNodeId?: string) => owner.agents.begin({ uiActionNonce: randomUUID(), modelId: model.id,
    input: { ...input, storyContext: { ...input.storyContext!, ...(bridgeToNodeId ? { bridgeToNodeId } : {}) } } })
  const propose = (delta: Partial<StoryNodeInput> = {}) => {
    const { chapterBlueprint: _blueprint, chapterSource: _source, revisionId: _version, ...minimal } = targetNode()
    response = '本章候选。<tool_call>' + JSON.stringify({ name: 'propose_story_changes', arguments: { operations: [{ type: 'put-node', node: { ...minimal, body: '蓝图逐项落实后的灯塔分支章节', ...delta } }] } }) + '</tool_call>'
  }
  const changeSource = (kind: 'blueprint' | 'source') => {
    const before = StoryBranchRepository.read(db), { revisionId: _revision, ...current } = targetNode()
    const changed = kind === 'blueprint' ? { ...current, chapterBlueprint: { ...current.chapterBlueprint!, keyEvents: '作者更新后的关键事件' } }
      : { ...current, chapterSource: { ...current.chapterSource!, blueprintHash: 'c'.repeat(64) } }
    StoryBranchRepository.commit(db, before.revision, [{ type: 'put-node', node: changed }])
  }
  const mainline = () => ({ blueprints: db.prepare('SELECT * FROM blueprints').all(), drafts: db.prepare('SELECT * FROM drafts').all(), contents: db.prepare('SELECT * FROM contents').all() })
  const changeContinuation = () => {
    const before = StoryBranchRepository.read(db), { revisionId: _revision, ...current } = before.nodes.find(node => node.id === next)!
    StoryBranchRepository.commit(db, before.revision, [{ type: 'put-node', node: { ...current, body: '作者更改了指定后文的开场状态' } }])
  }
  return { db, owner, dispatch, start, target, next, route, begin, propose, changeSource, changeContinuation, targetNode, mainline, chapterSource }
}

describe('branch blueprint generation uses the existing actual main owner', { timeout: 120_000 }, () => {
  it('freezes the selected plan and parent prose, preserves imported metadata on approval, and never overwrites mainline drafts', async () => {
    const f = fixture(), originalMainline = f.mainline(); f.propose()
    const start = f.begin(), result = await f.owner.agents.executeRound({ handle: start.handle, index: 0 })
    const messages = JSON.stringify((f.dispatch.mock.calls[0][0] as { task: { messages: unknown[] } }).task.messages)
    for (const included of ['灯塔求援计划', '点亮塔灯；守塔人回应', '保留暴雨声', '父级已发生：抵达海岸']) expect(messages).toContain(included)
    for (const excluded of ['父级未发生的规划秘密', '他路线独有正文秘密', '他路线独有蓝图秘密', '主线未来结局秘密', '主线未来总纲秘密', '全局主线未来蓝图秘密', '全局主线旧稿不能覆盖', '指定后文开场：援军等候在地下', '未指定的后文秘密不得注入']) expect(messages).not.toContain(excluded)
    expect(f.targetNode().body).toBe('分支旧稿')
    const ref = result.rounds[0].actions[0].ref
    f.owner.agents.claimTool({ ref, confirmed: true })
    const receipt = f.owner.agents.commitDomainTool(ref)
    expect(receipt.kind).toBe('story')
    expect(f.targetNode()).toMatchObject({ body: '蓝图逐项落实后的灯塔分支章节', chapterBlueprint: blueprint, chapterSource: f.chapterSource })
    expect(f.mainline()).toEqual(originalMainline)
    expect(StoryBranchRepository.read(f.db).revisions.some(item => item.node.body === '分支旧稿')).toBe(true)
  })

  it.each(['blueprint', 'source'] as const)('rejects a changed %s before model dispatch', async kind => {
    const f = fixture(); f.propose(); const start = f.begin(); f.changeSource(kind)
    await expect(f.owner.agents.executeRound({ handle: start.handle, index: 0 })).rejects.toThrow('GENERATION_SOURCE_CHANGED')
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.targetNode().body).toBe('分支旧稿')
  })

  it.each(['blueprint', 'source'] as const)('retains a candidate but blocks approval and commit after its %s changes', async kind => {
    const waiting = fixture(); waiting.propose(); const start = waiting.begin()
    const candidate = await waiting.owner.agents.executeRound({ handle: start.handle, index: 0 }), ref = candidate.rounds[0].actions[0].ref
    waiting.changeSource(kind)
    expect(() => waiting.owner.agents.claimTool({ ref, confirmed: true })).toThrow('GENERATION_AGENT_TOOL_STALE')
    expect(candidate.run.artifacts[0].text).toContain('本章候选')
    expect(JSON.stringify(candidate.rounds[0].actions[0].arguments)).toContain('蓝图逐项落实后的灯塔分支章节')
    expect(waiting.targetNode().body).toBe('分支旧稿')
    const approved = fixture(); approved.propose(); const begun = approved.begin()
    const result = await approved.owner.agents.executeRound({ handle: begun.handle, index: 0 }), approvedRef = result.rounds[0].actions[0].ref
    approved.owner.agents.claimTool({ ref: approvedRef, confirmed: true }); approved.changeSource(kind)
    expect(() => approved.owner.agents.commitDomainTool(approvedRef)).toThrow('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
    expect(approved.targetNode().body).toBe('分支旧稿')
  })

  it('rejects a model candidate that tries to change its plan while generating prose, even after tool approval', async () => {
    const f = fixture(); f.propose({ chapterBlueprint: { ...blueprint, keyEvents: '模型偷偷换掉计划' } })
    const start = f.begin(), result = await f.owner.agents.executeRound({ handle: start.handle, index: 0 }), ref = result.rounds[0].actions[0].ref
    f.owner.agents.claimTool({ ref, confirmed: true })
    expect(() => f.owner.agents.commitDomainTool(ref)).toThrow('STORY_BLUEPRINT_SEPARATE_PROPOSAL')
    expect(f.targetNode()).toMatchObject({ body: '分支旧稿', chapterBlueprint: blueprint })
  })

  it('uses only the explicitly selected later chapter as a future bridge constraint and preserves it on manuscript approval', async () => {
    const f = fixture(); f.propose()
    const originalLater = StoryBranchRepository.read(f.db).nodes.find(node => node.id === f.next)
    const start = f.begin(f.next), result = await f.owner.agents.executeRound({ handle: start.handle, index: 0 })
    const messages = JSON.stringify((f.dispatch.mock.calls[0][0] as { task: { messages: unknown[] } }).task.messages)
    expect(messages).toContain('父级已发生：抵达海岸')
    expect(messages).toContain('指定后文开场：援军等候在地下')
    expect(messages).toContain('指定后文将要发生的计划')
    expect(messages).toContain('尚未发生的衔接约束')
    expect(messages).not.toContain('未指定的后文秘密不得注入')
    const ref = result.rounds[0].actions[0].ref
    f.owner.agents.claimTool({ ref, confirmed: true }); f.owner.agents.commitDomainTool(ref)
    expect(f.targetNode().body).toContain('蓝图逐项落实')
    expect(StoryBranchRepository.read(f.db).nodes.find(node => node.id === f.next)).toEqual(originalLater)
  })

  it('blocks dispatch, author approval and the commit point when the selected later chapter changes', async () => {
    const beforeDispatch = fixture(); beforeDispatch.propose(); const first = beforeDispatch.begin(beforeDispatch.next); beforeDispatch.changeContinuation()
    await expect(beforeDispatch.owner.agents.executeRound({ handle: first.handle, index: 0 })).rejects.toThrow('GENERATION_SOURCE_CHANGED')
    expect(beforeDispatch.dispatch).not.toHaveBeenCalled()
    const waiting = fixture(); waiting.propose(); const second = waiting.begin(waiting.next)
    const pending = await waiting.owner.agents.executeRound({ handle: second.handle, index: 0 }), pendingRef = pending.rounds[0].actions[0].ref
    waiting.changeContinuation()
    expect(() => waiting.owner.agents.claimTool({ ref: pendingRef, confirmed: true })).toThrow('GENERATION_AGENT_TOOL_STALE')
    const approved = fixture(); approved.propose(); const third = approved.begin(approved.next)
    const result = await approved.owner.agents.executeRound({ handle: third.handle, index: 0 }), approvedRef = result.rounds[0].actions[0].ref
    approved.owner.agents.claimTool({ ref: approvedRef, confirmed: true }); approved.changeContinuation()
    expect(() => approved.owner.agents.commitDomainTool(approvedRef)).toThrow('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
    for (const f of [beforeDispatch, waiting, approved]) expect(f.targetNode().body).toBe('分支旧稿')
  })

  it.each([['', 'unwritten'], ['实际正文：王冠未得，主角仍空手', 'available']])('distinguishes imported prefix plans from actual prose in the main-dispatched request (%s)', async (body, status) => {
    const f = fixture(), before = StoryBranchRepository.read(f.db)
    const { revisionId: _version, ...prior } = before.nodes.find(node => node.id === f.start)!
    StoryBranchRepository.commit(f.db, before.revision, [{ type: 'put-node', node: { ...prior, event: '前置源章蓝图计划：已经取得王冠', body,
      chapterSource: { ...f.chapterSource, chapterNumber: 1 } } }], { confirmedSharedEdit: true })
    const canonicalContext = StoryBranchRepository.context(f.db, { nodeId: f.target, routeId: f.route, mode: 'route' })
    f.propose(); const begun = f.begin()
    await f.owner.agents.executeRound({ handle: begun.handle, index: 0 })
    const messages = JSON.stringify((f.dispatch.mock.calls[0][0] as { task: { messages: unknown[] } }).task.messages)
    expect(messages).toContain('eventStatus')
    expect(messages).toContain('chapter-plan')
    expect(messages).toContain('manuscriptStatus')
    expect(messages).toContain(status)
    expect(messages).toContain('不能当作既成前情')
    expect(messages).toContain('正文与计划冲突时，以实际正文为准')
    expect(StoryBranchRepository.context(f.db, canonicalContext.request)).toEqual(canonicalContext)
    expect(canonicalContext.prefix[0]).not.toHaveProperty('eventStatus')
  })
})
