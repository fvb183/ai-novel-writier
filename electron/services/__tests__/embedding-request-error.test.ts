import { describe, expect, it } from 'vitest'

import { EmbeddingRequestError, explainEmbeddingRequestFailure } from '../embedding-response-error'

describe('safe embedding HTTP failure advice', () => {
  it.each(['zh-CN', 'en-US'] as const)('keeps HTTP 402 actionable without asserting an account balance in %s', locale => {
    const failure = new EmbeddingRequestError('OpenAI', 402, 'https://api.siliconflow.cn/v1')
    const message = explainEmbeddingRequestFailure(failure, locale)
    expect(message).toContain('HTTP 402')
    expect(message).toContain('SiliconFlow')
    expect(message).toMatch(locale === 'zh-CN' ? /无法确认具体原因/ : /does not establish the exact cause/)
    expect(message).toMatch(locale === 'zh-CN' ? /费用账单.*实名认证/ : /billing.*identity verification/)
    expect(message).not.toMatch(/余额不足|请充值|top up|insufficient balance/iu)
  })

  it.each([
    [401, /API key/u], [403, /model access/u], [404, /Base URL path/u],
    [429, /quota or rate limit/u], [422, /batch sizes/u], [503, /gateway/u],
  ])('explains HTTP %s with relevant next steps', (status, advice) => {
    expect(explainEmbeddingRequestFailure(new EmbeddingRequestError('Gemini', status, 'https://gateway.example/v1'), 'en-US')).toMatch(advice)
  })

  it.each([
    'https://api.siliconflow.cn.gateway.example/v1',
    'https://gateway.example/api.siliconflow.cn/v1',
    'http://api.siliconflow.cn/v1',
    'https://api.siliconflow.cn:8443/v1',
  ])('does not attribute a configured gateway to SiliconFlow: %s', baseUrl => {
    const failure = new EmbeddingRequestError('OpenAI', 402, baseUrl)
    expect(failure.service).toBeUndefined()
    expect(explainEmbeddingRequestFailure(failure, 'en-US')).not.toContain('SiliconFlow')
  })

  it('does not copy an arbitrary URL, provider message or credential into diagnostics', () => {
    const secret = 'sensitive-fixture-key-and-input'
    const failure = new EmbeddingRequestError('OpenAI', 402, `https://gateway.example/v1?api_key=${secret}`)
    Object.assign(failure, { upstreamMessage: secret, body: secret })
    expect(failure.message).toBe('EMBEDDING_REQUEST_FAILED')
    expect(explainEmbeddingRequestFailure(failure, 'en-US')).not.toContain(secret)
    expect(explainEmbeddingRequestFailure(failure, 'en-US')).not.toContain('gateway.example')
  })

  it.each([null, 'upstream body', { code: 'OTHER', status: 402 }, { code: 'EMBEDDING_REQUEST_FAILED', status: '402' }, { code: 'EMBEDDING_REQUEST_FAILED', status: Number.NaN }])('leaves unrelated or malformed failures to their own handler', failure => {
    expect(explainEmbeddingRequestFailure(failure, 'en-US')).toBeUndefined()
  })
})
