import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { OpenAIProvider } from '../openai-provider'

// Exercise the actual HTTP parser against a local synthetic server. No account or external host is used.
let responseMode: 'json' | 'sse' | 'truncated' = 'json'
const requests: { url: string; authorization: string; body: Record<string, unknown> }[] = []
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  requests.push({ url: request.url ?? '', authorization: request.headers.authorization ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
  if (responseMode === 'json') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: '本机模拟正文。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }))
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const payload = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: '铜钥匙仍在林岚手里。' } }] })}\r\n\r\n`)
  const offset = payload.indexOf(Buffer.from('铜')) + 1
  response.write(payload.subarray(0, offset))
  await new Promise<void>(resolve => setImmediate(resolve))
  response.write(payload.subarray(offset))
  if (responseMode === 'sse') response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n')
  else response.end()
})
let model: ModelProfile
beforeAll(async () => {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  model = { id: 'synthetic-novelai-loopback', name: 'Synthetic NovelAI', provider: 'novelai', protocol: 'openai',
    modelName: 'synthetic-model', apiKey: 'synthetic-local-token', baseUrl: `http://127.0.0.1:${port}/oa/v1`, temperature: 0.7, maxTokens: 512, purposes: ['generation'] }
})
beforeEach(() => { requests.length = 0; responseMode = 'json' })
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })

describe('NovelAI compatibility over actual loopback HTTP', () => {
  it('completes a JSON request through a versioned endpoint with the narrow NovelAI payload', async () => {
    const result = await new OpenAIProvider().generate(model, [{ role: 'user', content: '写作当前章。' }], {
      temperature: 0.2, maxTokens: 512, responseFormat: { type: 'json_object' },
    })
    expect(result).toMatchObject({ success: true, content: '本机模拟正文。', finishReason: 'stop', usage: { totalTokens: 20 } })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ url: '/oa/v1/chat/completions', authorization: 'Bearer synthetic-local-token', body: { stream: false } })
    expect(requests[0].body).not.toHaveProperty('response_format')
    expect(requests[0].body).not.toHaveProperty('enable_thinking')
  })
  it('decodes split UTF-8 SSE and accepts only the explicit completion marker and stop reason', async () => {
    responseMode = 'sse'
    const onChunk = vi.fn(), onDone = vi.fn(), onError = vi.fn()
    await new OpenAIProvider().generateStream(model, [{ role: 'user', content: '继续当前章。' }], {
      temperature: 0.2, maxTokens: 512, visibleOnly: true, signal: new AbortController().signal, onChunk, onDone, onError,
    })
    expect(onChunk.mock.calls.map(call => call[0]).join('')).toBe('铜钥匙仍在林岚手里。')
    expect(onDone).toHaveBeenCalledWith('铜钥匙仍在林岚手里。', undefined, 'stop')
    expect(onError).not.toHaveBeenCalled()
    expect(requests[0].url).toBe('/oa/v1/chat/completions')
    expect(requests[0].body).not.toHaveProperty('stream_options')
  })
  it('retains a truncated candidate without treating transport close as completed prose', async () => {
    responseMode = 'truncated'
    const onDone = vi.fn(), onError = vi.fn()
    await new OpenAIProvider().generateStream(model, [{ role: 'user', content: '继续当前章。' }], {
      temperature: 0.2, maxTokens: 512, visibleOnly: true, signal: new AbortController().signal, onChunk: vi.fn(), onDone, onError,
    })
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('LLM_STREAM_INCOMPLETE', '铜钥匙仍在林岚手里。', undefined)
  })
})
