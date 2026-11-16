import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { StoryBranchRepository as Stories, storyCanonicalJson } from '../../repositories/story-branch-repository'
import { forkStoryFromChapter } from '../story-chapter-planning'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { generationOutputContract } from '../../../src/shared/generation-owner-contract'
import type { AgentGenerationInput } from '../../../src/shared/agent-generation'
import type { StoryContextRequest } from '../../../src/shared/story-branches'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool } from '../../../src/services/agent/tools/story-tools'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks() })
function fixture(afterChapter = 1, placement: 'branch' | 'insert' = 'insert') {
  const root = fs.mkdtempSync(path.resolve('.runtime', 'live-mainline-agent-')), db = new Database(':memory:')
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.prepare("INSERT INTO project_core(id,project_name,core_outline,synopsis) VALUES('main','实时章节项目','主线未来总纲秘密','主线未来梗概秘密')").run()
  for (const [chapter, body] of [[1, '第一章导入正文：主人公抵达海岸'], [2, '指定后文第二章：援军已在塔下等候']] as const) {
    const content = db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid
    db.prepare('INSERT INTO drafts(chapter_number,version,content_id) VALUES(?,1,?)').run(chapter, content)
  }
  db.prepare("INSERT INTO blueprints(chapter_number,title,key_events) VALUES(3,'未写的第三章','未写规划的秘密事件')").run()
  const fork = forkStoryFromChapter(db, { expectedRevision: Stories.read(db).revision, afterChapter, title: '独立灯塔章', placement })
  const { revisionId: _revision, ...node } = fork.snapshot.nodes.find(value => value.id === fork.nodeId)!
  Stories.commit(db, fork.snapshot.revision, [{ type: 'put-node', node: { ...node,
    chapterBlueprint: { ...node.chapterBlueprint!, purpose: '找到灯塔援军', keyEvents: '点亮塔灯；听见回声', userGuidance: '保留暴雨声' } } }])
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'synthetic', apiKey: 'synthetic-only', baseUrl: 'https://example.invalid', temperature: .7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  let response = ''
  const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => { options.onVisible({ kind: 'delta', text: response }); return { finishReason: 'stop', usage: null } })
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: () => JSON.stringify({ key: 'assistant_writing_identity', content: '合成写作助手', systemRole: '小说写作' }) }
  const owner = createMainGenerationOwner({ database: db, projectId: 'project', epoch: 'epoch', assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch,
    buildBinding: (selection, receipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch: 'epoch', modelReceipt: receipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, receipt) => rebuildGenerationSourceBinding(deps, previous, 'epoch', receipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const request = (bridgeToNodeId?: string): StoryContextRequest => ({ nodeId: fork.nodeId, routeId: fork.routeId, mode: 'route', ...(bridgeToNodeId ? { bridgeToNodeId } : {}) })
  const begin = (bridgeToNodeId?: string) => {
    const input: AgentGenerationInput = { mode: 'fast', uiLocale: 'zh-CN', historyMessages: [], userMessage: '按独立蓝图生成本章，只提出当前正文', storyContext: request(bridgeToNodeId),
      tools: [readStoryGraphTool, readStoryContextTool, proposeStoryChangesTool].map(({ name, description, inputSchema, requiresConfirmation, isReadOnly, source }) => ({ name, description, inputSchema: { ...inputSchema }, requiresConfirmation, isReadOnly, source })) }
    return owner.agents.begin({ uiActionNonce: randomUUID(), modelId: model.id, input })
  }
  const propose = () => {
    const { revisionId: _version, ...target } = Stories.read(db).nodes.find(value => value.id === fork.nodeId)!
    response = '章节候选。<tool_call>' + JSON.stringify({ name: 'propose_story_changes', arguments: { operations: [{ type: 'put-node', node: { ...target, body: '暴雨中点亮塔灯，主人公向回声迈去。' } }] } }) + '</tool_call>'
  }
  const messages = () => JSON.stringify((dispatch.mock.calls[0][0] as { task: { messages: unknown[] } }).task.messages)
  const facts = () => Object.fromEntries(['blueprints', 'drafts', 'contents'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]))
  return { db, fork, owner, dispatch, begin, propose, messages, facts }
}

describe('live mainline chapters bind actual Agent generation', { timeout: 120_000 }, () => {
  it('normalizes R1 frozen parents and bridge sources before the actual model scope and preserves their immutable history after approval', async () => {
    const f = fixture(), read = Stories.read(f.db), planning = { title: '', role: '', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '', notes: '' }
    const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
    const old = [1, 2].map(chapterNumber => ({ id: randomUUID(), kind: 'content' as const, title: `R1原稿标题${chapterNumber}`, chapterNumber,
      event: '', body: `不得注入模型的R1冻结旧正文${chapterNumber}`, chapterBlueprint: planning,
      chapterSource: { chapterNumber, blueprintHash: digest(storyCanonicalJson(planning)), manuscriptHash: digest(`不得注入模型的R1冻结旧正文${chapterNumber}`) } }))
    const parent = read.edges.find(edge => edge.from === 'chapter:1' && edge.to === f.fork.nodeId)!, next = read.edges.find(edge => edge.from === f.fork.nodeId && edge.to === 'chapter:2')!
    Stories.commit(f.db, read.revision, [
      ...old.map(node => ({ type: 'put-node' as const, node })),
      { type: 'put-edge', edge: { ...parent, from: old[0].id } }, { type: 'put-edge', edge: { ...next, to: old[1].id } },
      { type: 'put-edge', edge: { id: randomUUID(), from: old[0].id, to: old[1].id, label: '', condition: '' } },
      { type: 'put-route', route: { id: randomUUID(), title: '主线快照 · 第 2 章', nodeIds: old.map(node => node.id) } },
      { type: 'put-route', route: { id: f.fork.routeId, title: 'R1保存的插章路线', nodeIds: [old[0].id, f.fork.nodeId, old[1].id] } },
    ])
    const facts = f.facts(), frozen = f.db.prepare('SELECT * FROM story_nodes WHERE id IN (?,?) ORDER BY id').all(old[0].id, old[1].id)
    f.propose(); const start = f.begin('chapter:2'), result = await f.owner.agents.executeRound({ handle: start.handle, index: 0 })
    expect(f.messages()).toContain('第一章导入正文：主人公抵达海岸')
    expect(f.messages()).toContain('指定后文第二章：援军已在塔下等候')
    expect(f.messages()).not.toContain('不得注入模型的R1冻结旧正文')
    const ref = result.rounds[0].actions[0].ref
    f.owner.agents.claimTool({ ref, confirmed: true }); f.owner.agents.commitDomainTool(ref)
    expect(Stories.read(f.db).nodes.find(node => node.id === f.fork.nodeId)?.body).toBe('暴雨中点亮塔灯，主人公向回声迈去。')
    expect(Stories.read(f.db).edges.some(edge => edge.from === 'chapter:1' && edge.to === f.fork.nodeId)).toBe(true)
    expect(f.db.prepare('SELECT * FROM story_nodes WHERE id IN (?,?) ORDER BY id').all(old[0].id, old[1].id)).toEqual(frozen)
    expect(f.facts()).toEqual(facts)
  })
  it.each([false, true])('uses the live imported parent and only the explicitly selected future bridge (bridge=%s)', async bridge => {
    const f = fixture(), facts = f.facts(); f.propose()
    const start = f.begin(bridge ? 'chapter:2' : undefined), result = await f.owner.agents.executeRound({ handle: start.handle, index: 0 })
    const messages = f.messages()
    for (const included of ['第一章导入正文：主人公抵达海岸', '找到灯塔援军', '点亮塔灯；听见回声', '保留暴雨声']) expect(messages).toContain(included)
    if (bridge) expect(messages).toContain('指定后文第二章：援军已在塔下等候')
    else expect(messages).not.toContain('指定后文第二章：援军已在塔下等候')
    for (const excluded of ['未写规划的秘密事件', '主线未来总纲秘密', '主线未来梗概秘密']) expect(messages).not.toContain(excluded)
    const ref = result.rounds[0].actions[0].ref
    f.owner.agents.claimTool({ ref, confirmed: true })
    expect(f.owner.agents.commitDomainTool(ref).kind).toBe('story')
    const reloaded = Stories.read(f.db)
    expect(reloaded.nodes.find(node => node.id === f.fork.nodeId)?.body).toBe('暴雨中点亮塔灯，主人公向回声迈去。')
    expect(reloaded.edges.some(edge => edge.from === 'chapter:1' && edge.to === f.fork.nodeId)).toBe(true)
    expect(reloaded.edges.some(edge => edge.from === f.fork.nodeId && edge.to === 'chapter:2')).toBe(true)
    expect(f.facts()).toEqual(facts)
  })

  it('does not promote an unwritten mainline blueprint into earlier facts', async () => {
    const f = fixture(3, 'branch'); f.propose()
    const start = f.begin(); await f.owner.agents.executeRound({ handle: start.handle, index: 0 })
    expect(f.messages()).toContain('unwritten')
    expect(f.messages()).not.toContain('未写规划的秘密事件')
    expect(Stories.context(f.db, { nodeId: f.fork.nodeId, routeId: f.fork.routeId, mode: 'route' }).prefix.at(-1)?.event).toBe('')
  })

  it('rejects canonical planning changes before model dispatch', async () => {
    const f = fixture(); f.propose(); const start = f.begin('chapter:2')
    f.db.prepare("INSERT INTO blueprints(chapter_number,title,key_events) VALUES(1,'原作者新增蓝图','原作者改变本章安排')").run()
    await expect(f.owner.agents.executeRound({ handle: start.handle, index: 0 })).rejects.toThrow('GENERATION_SOURCE_CHANGED')
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(Stories.read(f.db).nodes.find(node => node.id === f.fork.nodeId)?.body).toBe('')
  })

  it('retains the visible candidate and blocks approval after canonical parent prose changes', async () => {
    const f = fixture(); f.propose(); const start = f.begin('chapter:2')
    const result = await f.owner.agents.executeRound({ handle: start.handle, index: 0 }), ref = result.rounds[0].actions[0].ref
    f.db.prepare("UPDATE contents SET body='原作者在父章改写了抵达地点' WHERE id=(SELECT content_id FROM drafts WHERE chapter_number=1)").run()
    expect(() => f.owner.agents.claimTool({ ref, confirmed: true })).toThrow('GENERATION_AGENT_TOOL_STALE')
    expect(result.run.artifacts[0].text).toContain('章节候选')
    expect(Stories.read(f.db).nodes.find(node => node.id === f.fork.nodeId)?.body).toBe('')
  })

  it('rechecks the canonical future bridge between author approval and commit', async () => {
    const f = fixture(); f.propose(); const start = f.begin('chapter:2')
    const result = await f.owner.agents.executeRound({ handle: start.handle, index: 0 }), ref = result.rounds[0].actions[0].ref
    f.owner.agents.claimTool({ ref, confirmed: true })
    f.db.prepare("UPDATE contents SET body='原作者已改变指定后文的开场状态' WHERE id=(SELECT content_id FROM drafts WHERE chapter_number=2)").run()
    expect(() => f.owner.agents.commitDomainTool(ref)).toThrow('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
    expect(Stories.read(f.db).nodes.find(node => node.id === f.fork.nodeId)?.body).toBe('')
  })
})
