import type { GlobalConfig } from './ipc-channels'

export type ProxyConfigErrorCode = 'NETWORK_PROXY_CONFIG_INVALID' | 'NETWORK_PROXY_ADDRESS_REQUIRED'
  | 'NETWORK_PROXY_ADDRESS_INVALID' | 'NETWORK_PROXY_TYPE_INVALID' | 'NETWORK_PROXY_PORT_INVALID'

export class ProxyConfigError extends Error {
  constructor(readonly code: ProxyConfigErrorCode) { super(code); this.name = 'ProxyConfigError' }
}

const ERROR_TEXT: Record<ProxyConfigErrorCode, readonly [string, string]> = {
  NETWORK_PROXY_CONFIG_INVALID: ['代理设置格式不正确，请重新选择代理类型并检查地址和端口。', 'Proxy settings are invalid. Choose the proxy type and check the address and port.'],
  NETWORK_PROXY_ADDRESS_REQUIRED: ['请填写代理地址，例如 127.0.0.1:7890。', 'Enter a proxy address, for example 127.0.0.1:7890.'],
  NETWORK_PROXY_ADDRESS_INVALID: ['代理地址只填写主机和端口，不包含用户名、密码、路径或查询参数。', 'Use only the proxy host and port, without credentials, a path or query parameters.'],
  NETWORK_PROXY_TYPE_INVALID: ['目前支持 HTTP 和 SOCKS5 代理，请检查地址开头或代理类型。', 'HTTP and SOCKS5 proxies are supported. Check the address scheme or proxy type.'],
  NETWORK_PROXY_PORT_INVALID: ['端口必须是 1 到 65535 之间的整数；可在代理地址中指定，或填写下方端口。', 'The port must be an integer from 1 to 65535. Include it in the proxy address or enter it in the Port field.'],
}

/** Accepts IPC-wrapped errors too, without displaying raw configuration values. */
export function proxyConfigErrorText(error: unknown, text: (zh: string, en: string) => string): string | null {
  const source = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const code = Object.keys(ERROR_TEXT).find(key => new RegExp(`(?:^|\\b)${key}(?:$|\\b)`, 'u').test(source)) as ProxyConfigErrorCode | undefined
  return code ? text(...ERROR_TEXT[code]) : null
}

function reject(code: ProxyConfigErrorCode): never { throw new ProxyConfigError(code) }
function normalizedType(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/:(?:\/\/)?$/u, '') : value
}
function activePort(value: unknown): number {
  if (typeof value === 'string') {
    const source = value.trim()
    if (!/^\d+$/u.test(source)) reject('NETWORK_PROXY_PORT_INVALID')
    value = Number(source)
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) reject('NETWORK_PROXY_PORT_INVALID')
  return value
}

/** Canonical IPC shape stays { enabled, type, host, port }. Presentation accepts
 * endpoint URLs and host:port, but transports receive a bare host and numeric port.
 * undefined selects the system route; explicitly disabled settings select direct. */
export function normalizeProxyConfig(value: unknown): GlobalConfig['proxy'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('NETWORK_PROXY_CONFIG_INVALID')
  const input = value as Record<string, unknown>
  if (input.enabled === false) {
    // Inactive fields must not prevent an author from returning to direct mode.
    // Keep useful preferences, and represent an absent inactive port as 0 rather
    // than silently choosing a live endpoint for the next enabled configuration.
    const port = typeof input.port === 'number' ? input.port
      : typeof input.port === 'string' && input.port.trim() ? Number(input.port) : 0
    return { enabled: false, type: normalizedType(input.type ?? input.protocol) === 'socks5' ? 'socks5' : 'http',
      host: typeof input.host === 'string' ? input.host.trim() : '', port: Number.isFinite(port) ? port : 0 }
  }
  if (input.enabled !== true) reject('NETWORK_PROXY_CONFIG_INVALID')
  if (typeof input.host !== 'string' || !input.host.trim()) reject('NETWORK_PROXY_ADDRESS_REQUIRED')
  let type = normalizedType(input.type ?? input.protocol), address = input.host.trim()
  const scheme = /^([a-z][a-z\d+.-]*):\/\/(.*)$/iu.exec(address)
  if (scheme) { type = scheme[1].toLowerCase(); address = scheme[2] }
  if (type !== 'http' && type !== 'socks5') reject('NETWORK_PROXY_TYPE_INVALID')
  // A root slash copied with a URL is harmless; paths, credentials and rule
  // separators cannot be smuggled into the Chromium/Android proxy authority.
  if (address.endsWith('/')) address = address.slice(0, -1)
  if (!address || /[\s/\\@?#;]/u.test(address)) reject('NETWORK_PROXY_ADDRESS_INVALID')
  let host: string, embeddedPort: string | undefined
  if (address.startsWith('[')) {
    const ipv6 = /^(\[[^\]]+\])(?::(.*))?$/u.exec(address)
    if (!ipv6) reject('NETWORK_PROXY_ADDRESS_INVALID')
    host = ipv6[1]; embeddedPort = ipv6[2]
  } else if ((address.match(/:/gu) ?? []).length === 1) {
    const separator = address.lastIndexOf(':')
    host = address.slice(0, separator); embeddedPort = address.slice(separator + 1)
  } else host = address.includes(':') ? `[${address}]` : address
  if (!host) reject('NETWORK_PROXY_ADDRESS_INVALID')
  const port = activePort(embeddedPort === undefined ? input.port : embeddedPort)
  let parsed: URL
  try { parsed = new URL(`http://${host}:${port}`) } catch { return reject('NETWORK_PROXY_ADDRESS_INVALID') }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) reject('NETWORK_PROXY_ADDRESS_INVALID')
  return { enabled: true, type, host: parsed.hostname.replace(/^\[|\]$/gu, ''), port }
}

/** Reused by Chromium and Android so IPv6 authorities have exactly one bracket pair. */
export function proxyServerUrl(value: unknown): string | undefined {
  const proxy = normalizeProxyConfig(value)
  if (!proxy?.enabled) return undefined
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
  return `${proxy.type}://${host}:${proxy.port}`
}
