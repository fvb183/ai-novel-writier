import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler) } }))
let root = '', configFile = ''
let setProxy = vi.fn(async (_rule: unknown) => {})
const proxy = { enabled: true, type: 'http' as const, host: '127.0.0.1', port: 17890 }
async function save(value: unknown) { return mocks.handlers.get('config:set')!({}, value) }

beforeEach(async () => {
  vi.resetModules(); mocks.handlers.clear()
  root = fs.mkdtempSync(path.join(process.cwd(), '.runtime', 'network-config-fixture-'))
  const home = await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(root)
  configFile = path.join(home, 'config.json')
  setProxy = vi.fn(async (_rule: unknown) => {})
  const { DesktopNetworkTransport } = await import('../../services/network-transport')
  const { installNetworkTransport } = await import('../../services/network-fetch')
  installNetworkTransport(new DesktopNetworkTransport({ initialProxy: () => undefined,
    createSession: () => ({ setProxy, fetch: async () => new Response('synthetic'), closeAllConnections: async () => {} }) }))
  ;(await import('../config-controller')).registerConfigController()
})
afterEach(() => {
  delete process.env.AI_NOVEL_VELA_HOME; delete process.env.AI_NOVEL_APP_DATA_HOME
  const allowed = path.resolve(process.cwd(), '.runtime') + path.sep
  if (!path.resolve(root).startsWith(allowed)) throw new Error('fixture cleanup outside allowed root')
  fs.rmSync(root, { recursive: true, force: true })
})

describe('saved proxy settings apply before acknowledgment', () => {
  it('keeps first-use settings on the system route and atomically removes a saved explicit direct selection', async () => {
    const initial = await mocks.handlers.get('config:get')!({}) as { proxy?: unknown }
    expect(Object.hasOwn(initial, 'proxy')).toBe(false)
    await expect(save({ theme: 'light' })).resolves.toEqual({ success: true })
    expect(Object.hasOwn(JSON.parse(fs.readFileSync(configFile, 'utf8')), 'proxy')).toBe(false)
    await expect(save({ proxy: { ...proxy, enabled: false } })).resolves.toEqual({ success: true })
    expect(setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).proxy.enabled).toBe(false)
    await expect(save({ proxy: undefined })).resolves.toEqual({ success: true })
    expect(setProxy).toHaveBeenLastCalledWith({ mode: 'system' })
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toMatchObject({ theme: 'light' })
    expect(Object.hasOwn(JSON.parse(fs.readFileSync(configFile, 'utf8')), 'proxy')).toBe(false)
    const reloaded = await mocks.handlers.get('config:get')!({}) as { proxy?: unknown }
    expect(Object.hasOwn(reloaded, 'proxy')).toBe(false)
  })
  it('preserves explicit direct mode if applying the requested system route fails', async () => {
    await save({ proxy: { ...proxy, enabled: false } })
    const before = fs.readFileSync(configFile)
    setProxy.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_TRANSPORT_DETAIL'))
    await expect(save({ proxy: undefined })).resolves.toEqual({ success: false, error: 'Error: NETWORK_PROXY_APPLY_FAILED' })
    expect(fs.readFileSync(configFile)).toEqual(before)
  })
  it('waits for actual proxy application and serializes simultaneous non-proxy saves', async () => {
    let release!: () => void
    setProxy.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    let acknowledged = false
    const first = save({ proxy }).then(value => { acknowledged = true; return value })
    const second = save({ theme: 'light' })
    await vi.waitFor(() => expect(setProxy).toHaveBeenCalledOnce())
    expect(acknowledged).toBe(false); expect(fs.existsSync(configFile)).toBe(false)
    fs.writeFileSync(configFile, JSON.stringify({ theme: 'dark', defaultModelId: 'other-controller-model', stageModelIds: { drafting: 'new-stage-model' } }))
    release()
    await expect(first).resolves.toEqual({ success: true })
    await expect(second).resolves.toEqual({ success: true })
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toMatchObject({ proxy, theme: 'light', defaultModelId: 'other-controller-model', stageModelIds: { drafting: 'new-stage-model' } })
  })

  it('keeps the saved configuration when native proxy application fails without exposing details', async () => {
    await save({ theme: 'light' })
    const before = fs.readFileSync(configFile)
    setProxy.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_TRANSPORT_DETAIL'))
    await expect(save({ proxy })).resolves.toEqual({ success: false, error: 'Error: NETWORK_PROXY_APPLY_FAILED' })
    expect(fs.readFileSync(configFile)).toEqual(before)
    await expect(save({ proxy: { ...proxy, enabled: false } })).resolves.toEqual({ success: true })
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).proxy.enabled).toBe(false)
  })

  it('rejects invalid destinations before applying them or reporting a saved setting', async () => {
    await expect(save({ proxy: { ...proxy, host: 'user:password@host' } })).resolves.toEqual({ success: false, error: 'ProxyConfigError: NETWORK_PROXY_ADDRESS_INVALID' })
    expect(setProxy).not.toHaveBeenCalled(); expect(fs.existsSync(configFile)).toBe(false)
  })

  it.each([
    { enabled: true, type: 'http', host: '127.0.0.1', port: 17891 },
    { enabled: true, type: 'HTTP', host: '127.0.0.1', port: '17891' },
    { enabled: true, type: 'http:', host: 'http://127.0.0.1:17891', port: 9000 },
  ])('applies and durably saves a canonical 17891 proxy from input %j', async input => {
    await expect(save({ proxy: input, theme: 'dark' })).resolves.toEqual({ success: true })
    expect(setProxy).toHaveBeenLastCalledWith({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:17891', proxyBypassRules: '<-loopback>' })
    const expected = { enabled: true, type: 'http', host: '127.0.0.1', port: 17891 }
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toMatchObject({ proxy: expected, theme: 'dark' })
    expect(await mocks.handlers.get('config:get')!({})).toMatchObject({ proxy: expected })
  })

  it('preserves an observed legacy empty-host config until a real host is supplied', async () => {
    const existing = { proxy: { enabled: true, type: 'http', host: '', port: 17891 }, theme: 'dark' }
    fs.mkdirSync(path.dirname(configFile), { recursive: true }); fs.writeFileSync(configFile, JSON.stringify(existing))
    const before = fs.readFileSync(configFile)
    await expect(save({ proxy: existing.proxy })).resolves.toEqual({ success: false, error: 'ProxyConfigError: NETWORK_PROXY_ADDRESS_REQUIRED' })
    expect(fs.readFileSync(configFile)).toEqual(before); expect(setProxy).not.toHaveBeenCalled()
    await expect(save({ proxy: { ...existing.proxy, host: '127.0.0.1' } })).resolves.toEqual({ success: true })
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toMatchObject({ proxy: { ...existing.proxy, host: '127.0.0.1' }, theme: 'dark' })
  })
})
