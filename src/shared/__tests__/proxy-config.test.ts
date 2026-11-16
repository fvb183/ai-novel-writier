import { describe, expect, it } from 'vitest'
import { normalizeProxyConfig, proxyConfigErrorText, proxyServerUrl } from '../proxy-config'
import { networkProxyRule } from '../../../electron/services/network-transport'

const enabled = { enabled: true, type: 'http', host: '127.0.0.1', port: 7890 }

describe('proxy input and transport boundary', () => {
  it.each([
    ['http://127.0.0.1:7890', 9000, 'http', '127.0.0.1', 7890],
    ['127.0.0.1:7890', 9000, 'http', '127.0.0.1', 7890],
    ['  http://localhost:8080/  ', 9000, 'http', 'localhost', 8080],
    ['socks5://localhost:1080', 7890, 'socks5', 'localhost', 1080],
    ['SOCKS5://LOCALHOST:1080/', 7890, 'socks5', 'localhost', 1080],
    ['http://127.0.0.1', '7890', 'http', '127.0.0.1', 7890],
    ['http://127.0.0.1:80', 9000, 'http', '127.0.0.1', 80],
    ['127.0.0.1:80', '', 'http', '127.0.0.1', 80],
    ['[::1]:7890', 9000, 'http', '::1', 7890],
    ['http://[::1]:7890/', '', 'http', '::1', 7890],
    ['::1', '7890', 'http', '::1', 7890],
  ])('normalizes %s into a bare host and explicit numeric port', (host, inputPort, type, expectedHost, port) => {
    const result = normalizeProxyConfig({ ...enabled, host, port: inputPort })
    expect(result).toEqual({ enabled: true, type, host: expectedHost, port })
    expect(networkProxyRule(result).rule.mode).toBe('fixed_servers')
  })

  it('normalizes the selected type and decimal port strings without changing a bare-host choice', () => {
    expect(normalizeProxyConfig({ ...enabled, type: ' SOCKS5 ', port: ' 01080 ' })).toEqual({ enabled: true, type: 'socks5', host: '127.0.0.1', port: 1080 })
  })

  it.each([{ type: 'HTTP' }, { type: 'HTTP://' }, { type: 'http:' }, { type: undefined, protocol: 'HTTP:' }])('accepts legacy HTTP type fields %j and the exact three-field 17891 endpoint', legacy => {
    const proxy = normalizeProxyConfig({ ...enabled, ...legacy, port: '17891' })
    expect(proxy).toEqual({ enabled: true, type: 'http', host: '127.0.0.1', port: 17891 })
    expect(proxyServerUrl(proxy)).toBe('http://127.0.0.1:17891')
  })

  it('keeps the observed legacy empty host invalid instead of choosing the placeholder as a destination', () => {
    expect(() => normalizeProxyConfig({ enabled: true, type: 'http', host: '', port: 17891 })).toThrow('NETWORK_PROXY_ADDRESS_REQUIRED')
  })

  it('formats a bare IPv6 address consistently for the native proxy URL', () => {
    expect(proxyServerUrl({ ...enabled, type: 'socks5', host: '::1', port: 17891 })).toBe('socks5://[::1]:17891')
    expect(proxyServerUrl({ ...enabled, enabled: false, host: '' })).toBeUndefined()
  })

  it.each(['', null, undefined, 0, -1, 65536, 7890.5, NaN, Infinity, '0', '8e3', '7890.5', '7890x'])('rejects an enabled invalid port %s instead of inventing an endpoint', port => {
    expect(() => normalizeProxyConfig({ ...enabled, port })).toThrow('NETWORK_PROXY_PORT_INVALID')
  })

  it('does not silently choose a port for a URL without an embedded or separate port', () => {
    expect(() => normalizeProxyConfig({ ...enabled, host: 'http://127.0.0.1', port: '' })).toThrow('NETWORK_PROXY_PORT_INVALID')
  })

  it.each(['http://user:password@127.0.0.1:7890', '127.0.0.1:7890/path', 'http://127.0.0.1:7890?query=1',
    'http://127.0.0.1:7890#fragment', '127.0.0.1;other:7890', 'local host', '[invalid]:7890'])('rejects non-proxy authority input without exposing it in the error: %s', host => {
    expect(() => normalizeProxyConfig({ ...enabled, host })).toThrow('NETWORK_PROXY_ADDRESS_INVALID')
  })

  it('distinguishes missing addresses from unsupported proxy schemes', () => {
    expect(() => normalizeProxyConfig({ ...enabled, host: '  ' })).toThrow('NETWORK_PROXY_ADDRESS_REQUIRED')
    expect(() => normalizeProxyConfig({ ...enabled, host: 'https://127.0.0.1:7890' })).toThrow('NETWORK_PROXY_TYPE_INVALID')
  })

  it('preserves system and explicit direct routing even when inactive fields are incomplete', () => {
    expect(normalizeProxyConfig(undefined)).toBeUndefined()
    const direct = normalizeProxyConfig({ enabled: false, type: 'socks5', host: ' unfinished/address ', port: '' })
    expect(direct).toEqual({ enabled: false, type: 'socks5', host: 'unfinished/address', port: 0 })
    expect(networkProxyRule(direct).rule).toEqual({ mode: 'direct' })
  })

  it('provides readable localized errors for local and IPC-wrapped rejections', () => {
    const english = proxyConfigErrorText('Error: NETWORK_PROXY_PORT_INVALID', (_zh, en) => en)
    expect(english).toContain('1 to 65535')
    expect(english).not.toContain('NETWORK_PROXY')
    const chinese = proxyConfigErrorText(new Error('NETWORK_PROXY_ADDRESS_INVALID: secret-input'), zh => zh)
    expect(chinese).toContain('主机和端口')
    expect(chinese).not.toContain('secret-input')
  })
})
