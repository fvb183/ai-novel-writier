import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalConfig } from '../../../../shared/ipc-channels'
import { useLocaleStore } from '../../../../stores/locale-store'
import { leaveSettings, settleSettingsLeave, useSettingsLeave } from '../../../settings/unsaved-settings'
import ProxySection from '../ProxySection'
import { networkProxyRule } from '../../../../../electron/services/network-transport'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const direct = { enabled: false, type: 'http' as const, host: '127.0.0.1', port: 7890 }
let stored: Partial<GlobalConfig>, host: HTMLDivElement, root: Root, invoke: ReturnType<typeof vi.fn>
let saveReply: () => Promise<{ success: boolean; error?: string }>
const priorLocale = useLocaleStore.getState()
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name)!
const click = async (name: string) => { expect(button(name)).toBeTruthy(); await act(async () => button(name).click()) }
const mount = async () => { await act(async () => root.render(<ProxySection />)); await expect.poll(() => button('保存代理设置').disabled).toBe(false) }
const writes = () => invoke.mock.calls.filter(call => call[0] === 'config:set')
const changeHost = async (value: string) => act(async () => {
  const input = host.querySelector<HTMLInputElement>('input[aria-describedby]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const changePort = async (value: string) => act(async () => {
  const input = host.querySelector<HTMLInputElement>('input[type="number"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const dirty = async () => {
  const proceeded = vi.fn()
  await act(async () => leaveSettings(proceeded))
  const result = !proceeded.mock.calls.length
  await act(async () => settleSettingsLeave(false))
  return result
}
beforeEach(() => {
  delete document.documentElement.dataset.platform
  stored = {}; saveReply = async () => ({ success: true })
  invoke = vi.fn(async (channel: string, input?: Partial<GlobalConfig>) => {
    if (channel === 'config:get') return structuredClone(stored)
    if (channel === 'config:set') {
      networkProxyRule(input?.proxy)
      const result = await saveReply()
      if (result.success) stored = JSON.parse(JSON.stringify({ ...stored, ...input }))
      return result
    }
    throw new Error(`Unexpected settings channel ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div'); host.className = 'stage-settings paper-ink'; document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); settleSettingsLeave(false)
  expect(useSettingsLeave.getState().pending).toBeNull()
  useLocaleStore.setState(priorLocale, true); Reflect.deleteProperty(window, 'aiNovelAPI'); delete document.documentElement.dataset.platform
})
describe('desktop system network selection', () => {
  it('shows first-use system mode without creating a direct setting', async () => {
    await mount()
    expect(host.textContent).toContain('当前使用：系统网络设置')
    expect(await dirty()).toBe(false); expect(writes()).toHaveLength(0)
    await click('保存代理设置')
    expect(writes()[0][1]).toEqual({ proxy: undefined }); expect(Object.hasOwn(stored, 'proxy')).toBe(false)
  })
  it('lets an existing explicit direct user return to system mode and retains it after remount', async () => {
    stored = { proxy: direct, theme: 'dark' }; await mount()
    expect(host.textContent).toContain('当前使用：直接连接')
    await click('使用系统网络设置')
    expect(writes()[0][1]).toEqual({ proxy: undefined })
    expect(stored).toEqual({ theme: 'dark' }); expect(host.textContent).toContain('当前使用：系统网络设置')
    expect(await dirty()).toBe(false)
    await act(async () => root.unmount()); root = createRoot(host); await mount()
    expect(host.textContent).toContain('当前使用：系统网络设置')
  })
  it('keeps custom unsaved input and dirty protection when switching to system fails', async () => {
    stored = { proxy: { ...direct, enabled: true } }; await mount(); await changeHost('localhost')
    expect(await dirty()).toBe(true)
    saveReply = async () => ({ success: false, error: 'NETWORK_PROXY_APPLY_FAILED' })
    await click('使用系统网络设置')
    expect(host.textContent).toContain('当前使用：自定义代理'); expect(host.querySelector<HTMLInputElement>('input[aria-describedby]')!.value).toBe('localhost')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('保存失败')
    expect(await dirty()).toBe(true); expect(stored.proxy?.host).toBe('127.0.0.1')
    saveReply = async () => ({ success: true }); await click('使用系统网络设置')
    expect(host.textContent).toContain('当前使用：系统网络设置'); expect(await dirty()).toBe(false)
  })
  it('preserves the explicit-off meaning when disabling and saving a custom proxy', async () => {
    stored = { proxy: { ...direct, enabled: true, type: 'socks5' } }; await mount()
    await act(async () => host.querySelector<HTMLInputElement>('input[role="switch"]')!.click())
    expect(await dirty()).toBe(true); expect(host.textContent).toContain('当前使用：自定义代理')
    await click('保存代理设置')
    expect(stored.proxy).toEqual({ ...direct, type: 'socks5' }); expect(host.textContent).toContain('当前使用：直接连接'); expect(await dirty()).toBe(false)
  })
  it('waits for the save receipt before clearing dirty state and blocks concurrent edits or saves', async () => {
    stored = { proxy: { ...direct, enabled: true } }; await mount(); await changeHost('localhost')
    let release!: () => void
    saveReply = () => new Promise(resolve => { release = () => resolve({ success: true }) })
    await click('使用系统网络设置')
    expect(button('使用系统网络设置').disabled).toBe(true)
    expect(host.querySelector<HTMLInputElement>('input[aria-describedby]')!.disabled).toBe(true)
    expect(host.textContent).toContain('当前使用：自定义代理'); expect(await dirty()).toBe(true)
    await click('使用系统网络设置'); expect(writes()).toHaveLength(1)
    await act(async () => release())
    expect(host.textContent).toContain('当前使用：系统网络设置'); expect(await dirty()).toBe(false)
  })
  it('keeps the phone proxy controls without exposing the desktop system-route action', async () => {
    document.documentElement.dataset.platform = 'android'; stored = { proxy: direct }; await mount()
    expect(button('使用系统网络设置')).toBeUndefined()
    expect(host.textContent).toContain('Google 原生授权由系统 Google 服务处理')
    await click('保存代理设置'); expect(stored.proxy).toEqual(direct)
  })

  it.each([
    ['http://127.0.0.1:7890', 'http', '127.0.0.1', 7890],
    ['127.0.0.1:8080', 'http', '127.0.0.1', 8080],
    ['socks5://localhost:1080', 'socks5', 'localhost', 1080],
    ['http://[::1]:7890/', 'http', '::1', 7890],
  ] as const)('saves pasted address %s as canonical host/type/port and restores it after remount', async (address, type, expectedHost, port) => {
    stored = { proxy: { ...direct, enabled: true, port: 9000 }, theme: 'dark' }; await mount()
    await changeHost(address); await click('保存代理设置')
    expect(writes()[0][1]).toEqual({ proxy: { enabled: true, type, host: expectedHost, port } })
    expect(stored.theme).toBe('dark')
    expect(host.querySelector<HTMLInputElement>('input[aria-describedby]')!.value).toBe(expectedHost)
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe(String(port))
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe(type)
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(await dirty()).toBe(false)
    await act(async () => root.unmount()); root = createRoot(host); await mount()
    expect(host.querySelector<HTMLInputElement>('input[aria-describedby]')!.value).toBe(expectedHost)
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe(String(port))
  })

  it('normalizes a legacy string port on save', async () => {
    stored = { proxy: { ...direct, enabled: true, port: '7890' as unknown as number } }; await mount()
    await click('保存代理设置')
    expect(stored.proxy?.port).toBe(7890)
  })

  it.each(['', '0', '65536', '7890.5'])('keeps invalid port %s visible and refuses to submit it without inventing a default', async value => {
    stored = { proxy: { ...direct, enabled: true } }; await mount()
    await changePort(value); await click('保存代理设置')
    expect(writes()).toHaveLength(0)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('1 到 65535')
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe(value)
    expect(host.textContent).not.toContain('NETWORK_PROXY_CONFIG_INVALID')
    expect(await dirty()).toBe(true)
  })

  it('allows a complete address to supply the port when the separate port is empty', async () => {
    stored = { proxy: { ...direct, enabled: true } }; await mount()
    await changePort(''); await changeHost('http://127.0.0.1:8080'); await click('保存代理设置')
    expect(stored.proxy).toEqual({ ...direct, enabled: true, port: 8080 })
  })

  it('keeps rejected input and still permits explicit direct or system routing', async () => {
    stored = { proxy: { ...direct, enabled: true } }; await mount()
    await changeHost('http://user:password@127.0.0.1:7890'); await click('保存代理设置')
    expect(writes()).toHaveLength(0)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('不包含用户名')
    await changePort('')
    await act(async () => host.querySelector<HTMLInputElement>('input[role="switch"]')!.click())
    await click('保存代理设置')
    expect(stored.proxy?.enabled).toBe(false); expect(host.textContent).toContain('当前使用：直接连接')
    await click('使用系统网络设置')
    expect(Object.hasOwn(stored, 'proxy')).toBe(false); expect(host.textContent).toContain('当前使用：系统网络设置')
  })

  it('renders an IPC validation failure as readable advice and retains the pending form', async () => {
    stored = { proxy: { ...direct, enabled: true } }; await mount(); await changeHost('localhost')
    saveReply = async () => ({ success: false, error: 'Error: NETWORK_PROXY_CONFIG_INVALID' })
    await click('保存代理设置')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('检查地址和端口')
    expect(host.textContent).not.toContain('NETWORK_PROXY_CONFIG_INVALID')
    expect(host.querySelector<HTMLInputElement>('input[aria-describedby]')!.value).toBe('localhost')
    expect(await dirty()).toBe(true)
  })

  it('requires a real host value for the observed legacy HTTP / empty host / 17891 configuration, then saves the exact three fields', async () => {
    stored = { proxy: { enabled: true, type: 'http', host: '', port: 17891 } }; await mount()
    const field = () => host.querySelector<HTMLInputElement>('input[aria-describedby]')!
    expect(field().value).toBe(''); expect(field().placeholder).toContain('必填')
    expect(host.textContent).toContain('已保存的代理地址不完整')
    await click('保存代理设置')
    expect(writes()).toHaveLength(0); expect(stored.proxy?.host).toBe('')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('请填写代理地址')
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('select')!
      select.value = 'http'; select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await changeHost('127.0.0.1'); await changePort('17891')
    expect(field().value).toBe('127.0.0.1')
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('http')
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('17891')
    await click('保存代理设置')
    expect(writes()[0][1]).toEqual({ proxy: { enabled: true, type: 'http', host: '127.0.0.1', port: 17891 } })
    expect(host.textContent).toContain('已保存'); expect(await dirty()).toBe(false)
    await act(async () => root.unmount()); root = createRoot(host); await mount()
    expect(field().value).toBe('127.0.0.1')
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('17891')
    expect(host.textContent).toContain('当前使用：自定义代理')
  })

  it.each([
    [{ type: 'HTTP' }, 'http'],
    [{ type: 'http:' }, 'http'],
    [{ type: 'HTTP://' }, 'http'],
    [{ type: 'SOCKS5' }, 'socks5'],
    [{ type: undefined, protocol: 'socks5:' }, 'socks5'],
  ] as const)('restores a legacy proxy type %j to the actual visible control before saving', async (legacy, type) => {
    stored = { proxy: { ...direct, enabled: true, port: 17891, ...legacy } as unknown as NonNullable<GlobalConfig['proxy']> }; await mount()
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe(type)
    await click('保存代理设置')
    expect(writes()[0][1]).toEqual({ proxy: { enabled: true, type, host: '127.0.0.1', port: 17891 } })
    expect(stored.proxy?.type).toBe(type)
  })

  it('does not silently change an unsupported saved protocol to HTTP', async () => {
    stored = { proxy: { ...direct, enabled: true, type: 'https' as never } }; await mount()
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('')
    expect(host.textContent).toContain('请选择代理类型')
    await click('保存代理设置')
    expect(writes()).toHaveLength(0)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('目前支持 HTTP 和 SOCKS5')
  })
})
