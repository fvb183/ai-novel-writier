import { afterEach, describe, expect, it, vi } from 'vitest'

import { embedGemini, embedOpenAI, generateEmbeddings } from '../embedding'
import { BUILTIN_PRESETS } from '../../src/shared/provider-presets'

const model = {
  baseUrl: 'https://embedding.example/v1',
  apiKey: 'test-key',
  modelName: 'test-embedding-model',
}

function successfulResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => payload,
  }
}

function openAIEmbedding(index: number) {
  return { index, embedding: [index + 0.25] }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('embedding batch response contract', () => {
  it.each([
    ['OpenAI invalid vector value', 'openai', { data: [{ index: 0, embedding: ['private-fixture-key-and-text'] }] }],
    ['OpenAI invalid index', 'openai', { data: [{ index: 'private-fixture-key-and-text', embedding: [0.1] }] }],
    ['Gemini invalid vector value', 'gemini', { embeddings: [{ values: ['private-fixture-key-and-text'] }] }],
  ] as const)('does not echo rejected response data in %s diagnostics', async (_label, protocol, payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse(payload)))
    const failure = await generateEmbeddings(['synthetic input'], protocol, model).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' })
    expect(String(failure)).not.toContain('private-fixture-key-and-text')
    expect(String(failure)).toContain('类型 string')
  })

  it('reports an out-of-range index by response position without echoing the rejected numeric value', async () => {
    const rejectedIndex = 987654321
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({ data: [{ index: rejectedIndex, embedding: [0.1] }] })))
    const failure = await embedOpenAI(['synthetic input'], model).catch((error: unknown) => error)

    expect(String(failure)).toContain('第 1 项 index 超出范围 0..0')
    expect(String(failure)).not.toContain(String(rejectedIndex))
  })

  it('reports a bounded actionable error when OpenAI returns 2xx HTML instead of JSON', async () => {
    const bodyMarker = 'DO-NOT-EXPOSE-THIS-LONG-UPSTREAM-HTML-BODY'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      `<!doctype html><html><body>${bodyMarker.repeat(100)}</body></html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      },
    )))

    const error = await embedOpenAI(['第一段'], model).catch((reason: unknown) => reason)

    expect(error).toMatchObject({
      name: 'EmbeddingResponseValidationError',
      code: 'EMBEDDING_RESPONSE_INVALID',
    })
    expect((error as Error).message).toMatch(
      /OpenAI Embedding 响应无效：服务端返回非 JSON 响应.*Base URL、网关或鉴权页/,
    )
    expect((error as Error).message).not.toContain(bodyMarker)
    expect((error as Error).message).not.toContain("Unexpected token '<'")
  })

  it('reports a bounded actionable error when Gemini returns 2xx HTML instead of JSON', async () => {
    const bodyMarker = 'DO-NOT-EXPOSE-THIS-LONG-GEMINI-HTML-BODY'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      `<!doctype html><html><body>${bodyMarker.repeat(100)}</body></html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      },
    )))

    const error = await embedGemini(['第一段'], model).catch((reason: unknown) => reason)

    expect(error).toMatchObject({
      name: 'EmbeddingResponseValidationError',
      code: 'EMBEDDING_RESPONSE_INVALID',
    })
    expect((error as Error).message).toMatch(
      /Gemini Embedding 响应无效：服务端返回非 JSON 响应.*Base URL、网关或鉴权页/,
    )
    expect((error as Error).message).not.toContain(bodyMarker)
    expect((error as Error).message).not.toContain("Unexpected token '<'")
  })

  it('reports a bounded actionable error when OpenAI labels malformed 2xx content as JSON', async () => {
    const bodyMarker = 'DO-NOT-EXPOSE-THIS-MALFORMED-JSON-BODY'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      bodyMarker.repeat(100),
      {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    )))

    const error = await embedOpenAI(['第一段'], model).catch((reason: unknown) => reason)

    expect(error).toMatchObject({
      name: 'EmbeddingResponseValidationError',
      code: 'EMBEDDING_RESPONSE_INVALID',
    })
    expect((error as Error).message).toMatch(
      /OpenAI Embedding 响应无效：服务端返回非 JSON 响应.*响应体无法解析为 JSON.*Base URL、网关或鉴权页/,
    )
    expect((error as Error).message).not.toContain(bodyMarker)
    expect((error as Error).message).not.toContain('Unexpected token')
  })

  it.each([
    {
      provider: 'OpenAI',
      embed: embedOpenAI,
      payload: { data: [openAIEmbedding(0)] },
    },
    {
      provider: 'Gemini',
      embed: embedGemini,
      payload: { embeddings: [{ values: [0.25] }] },
    },
  ])('$provider accepts valid JSON with missing or non-standard Content-Type', async ({ embed, payload }) => {
    for (const contentType of [undefined, 'text/plain', 'text/json']) {
      const response = new Response(JSON.stringify(payload), {
        status: 200,
        headers: contentType ? { 'content-type': contentType } : undefined,
      })
      if (!contentType) {
        response.headers.delete('content-type')
      }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

      await expect(embed(['第一段'], model)).resolves.toEqual([[0.25]])
    }
  })

  it.each([
    ['OpenAI', embedOpenAI],
    ['Gemini', embedGemini],
  ] as const)('%s keeps non-2xx response errors bounded and actionable', async (provider, embed) => {
    const bodyMarker = 'DO-NOT-EXPOSE-THIS-NON-2XX-UPSTREAM-BODY'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bodyMarker.repeat(100), {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })))

    const error = await embed(['第一段'], model).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: 'EMBEDDING_REQUEST_FAILED', code: 'EMBEDDING_REQUEST_FAILED', provider, status: 401 })
    expect((error as Error).message).not.toContain(bodyMarker)
  })

  it('rejects a short first OpenAI batch before a later oversized batch can offset the total', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(successfulResponse({
        data: Array.from({ length: 49 }, (_, index) => openAIEmbedding(index)),
      }))
      .mockResolvedValueOnce(successfulResponse({
        data: Array.from({ length: 51 }, (_, index) => openAIEmbedding(index)),
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateEmbeddings(
      Array.from({ length: 100 }, (_, index) => `正文-${index}`),
      'openai',
      model,
      50,
    )).rejects.toThrow(/OpenAI Embedding 响应.*数量.*49.*50/)

    // The later 51-item response cannot mask the first batch's missing item.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a Gemini response array whose count differs from its batch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({
      embeddings: [{ values: [0.1] }, { values: [0.2] }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateEmbeddings(
      ['第一段', '第二段', '第三段'],
      'gemini',
      model,
      3,
    )).rejects.toThrow(/Gemini Embedding 响应.*数量.*2.*3/)
  })

  it.each([
    {
      name: 'duplicate index',
      data: [openAIEmbedding(0), openAIEmbedding(0), openAIEmbedding(2)],
      expectedError: /index 0 重复/,
    },
    {
      name: 'out-of-range index',
      data: [openAIEmbedding(0), openAIEmbedding(1), openAIEmbedding(3)],
      expectedError: /第 3 项 index 超出范围/,
    },
    {
      name: 'missing index',
      data: [openAIEmbedding(0), openAIEmbedding(2)],
      expectedError: /index 覆盖不完整.*1/,
    },
  ])('rejects an OpenAI batch with $name before returning any vectors', async ({ data, expectedError }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({ data })))

    await expect(embedOpenAI(['第一段', '第二段', '第三段'], model)).rejects.toThrow(expectedError)
  })

  it('keeps valid unordered OpenAI responses aligned to their input indexes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({
      data: [
        { index: 1, embedding: [0.2] },
        { index: 0, embedding: [0.1] },
      ],
    })))

    await expect(embedOpenAI(['第一段', '第二段'], model)).resolves.toEqual([
      [0.1],
      [0.2],
    ])
  })

  it.each([
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects an OpenAI vector containing %s at the response boundary', async (_label, invalidValue) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({
      data: [{ index: 0, embedding: [0.1, invalidValue, 0.3] }],
    })))

    await expect(embedOpenAI(['第一段'], model)).rejects.toThrow(
      /OpenAI Embedding 响应无效.*第 1 个向量.*第 2 个值.*有限数字/,
    )
  })

  it('rejects inconsistent OpenAI vector dimensions at the response boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 1, embedding: [0.3] },
      ],
    })))

    await expect(embedOpenAI(['第一段', '第二段'], model)).rejects.toThrow(
      /OpenAI Embedding 响应无效.*第 2 个向量.*1 维.*期望 2 维/,
    )
  })

  it('rejects a Gemini vector containing null at the response boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({
      embeddings: [{ values: [0.1, null, 0.3] }],
    })))

    await expect(embedGemini(['第一段'], model)).rejects.toThrow(
      /Gemini Embedding 响应无效.*第 1 个向量.*第 2 个值.*有限数字/,
    )
  })

  it('rejects a dimension change between OpenAI batches before returning the aggregate', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(successfulResponse({
        data: [
          { index: 0, embedding: [0.1, 0.2] },
          { index: 1, embedding: [0.3, 0.4] },
        ],
      }))
      .mockResolvedValueOnce(successfulResponse({
        data: [{ index: 0, embedding: [0.5] }],
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateEmbeddings(['第一段', '第二段', '第三段'], 'openai', model, 2)).rejects.toThrow(
      /OpenAI Embedding 响应无效.*第 3 个向量.*1 维.*期望 2 维/,
    )
  })
})

describe('OpenAI embedding endpoint construction', () => {
  it('preserves the SiliconFlow endpoint, model and request while retaining a safe HTTP 402 failure', async () => {
    const cancel = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 402 }))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const configured = { baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'BAAI/bge-m3', apiKey: 'synthetic-credential' }

    const error = await embedOpenAI(['synthetic input'], configured, signal).catch((reason: unknown) => reason)

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://api.siliconflow.cn/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-credential' },
      body: JSON.stringify({ model: 'BAAI/bge-m3', input: ['synthetic input'] }),
      signal,
    })
    expect(error).toMatchObject({ code: 'EMBEDDING_REQUEST_FAILED', status: 402, provider: 'OpenAI', service: 'siliconflow' })
    expect(String(error)).not.toMatch(/synthetic-credential|synthetic input/)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not read, log or forward a rejected provider body, and stops the remaining batches', async () => {
    const raw = 'synthetic-key-and-novel-body-never-forwarded'
    const response = new Response(JSON.stringify({ message: raw, error: { message: raw } }), { status: 402 })
    const json = vi.spyOn(response, 'json')
    const text = vi.spyOn(response, 'text')
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)

    const error = await generateEmbeddings(['first', 'second', 'third'], 'openai', model, 1).catch((reason: unknown) => reason)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(json).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(JSON.stringify(error)).not.toContain(raw)
    expect(String(error)).not.toContain(raw)
  })

  it.each([
    ['localhost', 'http://localhost:11434/api', 'http://localhost:11434/v1'],
    ['127.0.0.1', 'http://127.0.0.1:11434/api/', 'http://127.0.0.1:11434/v1'],
  ])('explains how to replace the Ollama native /api base for %s', async (_name, baseUrl, recommendedBaseUrl) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(embedOpenAI(['第一段'], { ...model, baseUrl })).rejects.toMatchObject({
      message: 'EMBEDDING_OLLAMA_NATIVE_URL',
      suggestedBaseUrl: recommendedBaseUrl,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a complete endpoint', 'https://embedding.example/v1/embeddings', 'https://embedding.example/v1/embeddings'],
    ['a v1 base', 'https://embedding.example/v1', 'https://embedding.example/v1/embeddings'],
    ['a versioned compatible base', 'https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/embeddings'],
    ['the OpenAI root', 'https://api.openai.com', 'https://api.openai.com/v1/embeddings'],
    ['the Ollama root', 'http://localhost:11434', 'http://localhost:11434/v1/embeddings'],
  ])('uses the expected endpoint for %s', async (_name, baseUrl, expectedUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({
      data: [openAIEmbedding(0)],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await embedOpenAI(['第一段'], { ...model, baseUrl })

    expect(fetchMock.mock.calls[0][0]).toBe(expectedUrl)
  })

  it('keeps the Ollama preset aligned with the OpenAI-compatible embedding endpoint', async () => {
    const ollamaPreset = BUILTIN_PRESETS.find((preset) => preset.provider === 'ollama')
    expect(ollamaPreset?.baseUrl).toBe('http://localhost:11434/v1')

    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({
      data: [openAIEmbedding(0)],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await embedOpenAI(['第一段'], { ...model, baseUrl: ollamaPreset!.baseUrl })

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/embeddings')
  })

  it('does not infer a v1 path for a user-configured /api base', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({
      data: [openAIEmbedding(0)],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await embedOpenAI(['第一段'], { ...model, baseUrl: 'https://gateway.example/api' })

    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/api/embeddings')
  })
})
