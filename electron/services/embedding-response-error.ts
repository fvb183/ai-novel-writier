export class EmbeddingResponseValidationError extends Error {
  readonly code = 'EMBEDDING_RESPONSE_INVALID' as const

  constructor(provider: 'OpenAI' | 'Gemini', details: string) {
    super(`${provider} Embedding 响应无效：${details}`)
    this.name = 'EmbeddingResponseValidationError'
  }
}

type EmbeddingProtocol = 'OpenAI' | 'Gemini'

/** HTTP status is safe diagnostic data; URLs, keys, input and upstream bodies are not. */
export class EmbeddingRequestError extends Error {
  readonly code = 'EMBEDDING_REQUEST_FAILED' as const
  readonly service: 'siliconflow' | undefined

  constructor(
    readonly provider: EmbeddingProtocol,
    readonly status: number,
    baseUrl: string,
  ) {
    super('EMBEDDING_REQUEST_FAILED')
    this.name = 'EmbeddingRequestError'
    try {
      // The saved provider is only a UI label and can point at a gateway. Only
      // the official HTTPS origin qualifies for service-specific advice.
      this.service = new URL(baseUrl).origin === 'https://api.siliconflow.cn'
        ? 'siliconflow'
        : undefined
    } catch {
      this.service = undefined
    }
  }
}

/** Fixed copy only: an HTTP status is not proof of a particular account problem. */
export function explainEmbeddingRequestFailure(
  failure: unknown,
  locale: 'zh-CN' | 'en-US',
): string | undefined {
  if (!failure || typeof failure !== 'object') return undefined
  const detail = failure as { code?: unknown; status?: unknown; service?: unknown }
  if (detail.code !== 'EMBEDDING_REQUEST_FAILED'
    || typeof detail.status !== 'number'
    || !Number.isInteger(detail.status)
    || detail.status < 400
    || detail.status > 599) return undefined

  const zh = locale === 'zh-CN'
  const siliconFlow = detail.service === 'siliconflow'
  const prefix = zh
    ? `检索模型请求失败（HTTP ${detail.status}）。`
    : `Retrieval model request failed (HTTP ${detail.status}). `
  let advice: readonly [string, string]
  switch (detail.status) {
    case 401:
      advice = ['请检查 API Key 是否有效，以及 Key 与 Base URL 是否属于同一服务。', 'Check that the API key is valid and belongs to the service selected by the Base URL.']
      break
    case 402:
      advice = [
        '服务返回了计费或账户相关的拒绝状态。请到对应服务的控制台核对账户状态、费用账单和 Key 所属账户；仅凭 HTTP 402 无法确认具体原因。',
        'The service returned a billing or account-related rejection. Check account status, billing, and the account owning the key in the service console; HTTP 402 alone does not establish the exact cause.',
      ]
      break
    case 403:
      advice = ['请在服务商控制台检查模型访问权限、账户状态与认证要求。', 'Check model access, account status, and verification requirements in the provider console.']
      break
    case 404:
      advice = ['请检查 Base URL 的接口路径及检索模型名称，确认服务提供 Embedding 接口。', 'Check the Base URL path and retrieval model name, and confirm that the service provides an embedding endpoint.']
      break
    case 429:
      advice = ['请求达到限额或速率限制。请检查服务商的调用额度，稍后手动重试，或减小向量化批量大小。', 'A quota or rate limit was reached. Check provider limits, retry manually later, or reduce the embedding batch size.']
      break
    case 400:
    case 422:
      advice = ['请核对检索模型名称、Base URL 以及服务商支持的输入和批量大小。', 'Check the retrieval model name, Base URL, and the input and batch sizes supported by the service.']
      break
    default:
      advice = detail.status >= 500
        ? ['服务或网关暂时无法完成请求，请检查服务状态后重试。', 'The service or gateway could not complete the request. Check service status and retry later.']
        : ['请检查 Base URL、网关与 API Key，并到服务商控制台查看请求记录。', 'Check the Base URL, gateway, and API key, and inspect request records in the provider console.']
  }
  const freeModelAdvice = siliconFlow && (detail.status === 402 || detail.status === 403)
    ? (zh
      ? '当前配置指向 SiliconFlow 官方地址；若使用免费型号，也请核对实名认证和免费调用资格。'
      : 'The configuration points to the official SiliconFlow endpoint; for a free model, also check identity verification and free-model eligibility.')
    : ''
  return prefix + advice[zh ? 0 : 1] + (freeModelAdvice ? `${zh ? '' : ' '}${freeModelAdvice}` : '')
}
