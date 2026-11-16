import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  locale: 'zh-CN' as 'zh-CN' | 'en-US',
  canonical: vi.fn(async () => [{ id: 'synthetic-chunk', text: 'Synthetic material, never logged.' }]),
  plan: vi.fn(),
  rebuild: vi.fn(),
}))
vi.mock('../services/project-data-locator', () => ({ getProjectDataRoot: () => path.resolve('.runtime/nonexistent-http-failure-fixture') }))
vi.mock('../database', () => ({ getCurrentProjectPath: vi.fn(), getProjectDb: vi.fn() }))
vi.mock('../repositories/import-run-repository', () => ({ ImportRunRepository: {} }))
vi.mock('../services/knowledge-source-gate', () => ({ withKnowledgeSourceGate: vi.fn() }))
vi.mock('../i18n', () => ({ getMainLocale: () => mocks.locale }))
vi.mock('../vector-store', () => ({
  getCanonicalChunksForEmbeddingRebuild: mocks.canonical,
  planEmbeddingRebuild: mocks.plan,
  rebuildPlannedEmbeddingSpace: mocks.rebuild,
}))

import { backfillVectors } from '../knowledge-base'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('knowledge-base HTTP failure propagation', () => {
  it.each([
    { index: 0, embedding: ['synthetic-private-response-sentinel'] },
    { index: 'synthetic-private-response-sentinel', embedding: [0.1] },
  ])('does not echo invalid response fields through knowledge-base warnings or errors', async item => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [item] }), { status: 200 })))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await backfillVectors('synthetic-project', 'openai', {
      provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'BAAI/bge-m3', apiKey: 'synthetic-key',
    })

    expect(result).toMatchObject({ success: false, error: 'EMBEDDING_RESPONSE_INVALID' })
    const displayed = [...errors.mock.calls.flat(), ...warnings.mock.calls.flat(), result.error].map(String).join('\n')
    expect(displayed).not.toContain('synthetic-private-response-sentinel')
    expect(displayed).toContain('类型 string')
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.rebuild).not.toHaveBeenCalled()
  })

  it.each(['zh-CN', 'en-US'] as const)('returns safe HTTP 402 advice and makes no index writes or automatic retries in %s', async locale => {
    mocks.locale = locale
    const secret = 'synthetic-key-and-raw-provider-body'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: secret }), { status: 402 }))
    vi.stubGlobal('fetch', fetchMock)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await backfillVectors('synthetic-project', 'openai', {
      provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'BAAI/bge-m3', apiKey: secret,
    })

    expect(result).toMatchObject({ success: false, processed: 0, failed: 0, error: expect.stringContaining('HTTP 402') })
    expect(result.error).toMatch(locale === 'zh-CN' ? /费用账单/ : /billing/)
    expect(result.error).not.toMatch(/EMBEDDING_REQUEST_FAILED|余额不足|top up/iu)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(logged.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(logged.mock.calls)).not.toContain('Synthetic material')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.rebuild).not.toHaveBeenCalled()
  })
})
