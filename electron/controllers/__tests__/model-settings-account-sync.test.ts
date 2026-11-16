import { expect, it, vi } from 'vitest'
import { registerModelSettingsSyncController } from '../model-settings-sync-controller'
import { ModelSettingsStore } from '../../services/model-settings-sync'
import { GoogleDriveStateStore, type DriveState } from '../../services/google-drive-state'
import { MODEL_SETTINGS_ACCOUNT_SCOPE, type GoogleDriveClient } from '../../services/google-drive-client'
import { encodeModelSettings, parseModelSettingsSnapshot } from '../../../src/shared/model-settings-sync'
import type { GlobalConfig, ModelProfile } from '../../../src/shared/ipc-channels'

const key = 'SYNTHETIC_ACCOUNT_TRANSFER_KEY'
const model = (id: string, embedding = false): ModelProfile => ({ id, name: id, provider: 'custom', protocol: 'openai', modelName: id,
  baseUrl: 'https://synthetic.invalid/v1', apiKey: key, temperature: .7, maxTokens: 4096, purposes: [embedding ? 'embedding' : 'generation'] })
function local(initial = [model('unrelated')]) {
  let models = structuredClone(initial), config = { theme: 'light', editorFontSize: 20, editorFontFamily: 'font', autoSaveInterval: 30,
    defaultModelId: initial[0]?.id ?? null, proxy: { enabled: true, type: 'http', host: '127.0.0.1', port: 17891 } } as GlobalConfig
  const store = new ModelSettingsStore({ readModels: () => structuredClone(models), readConfig: () => structuredClone(config),
    writeModels: value => { models = structuredClone(value) }, updateConfig: update => { config = update(config); return true } })
  return { store, get models() { return models }, get config() { return config }, edit() { models[0]!.apiKey = 'SYNTHETIC_LOCAL_EDIT' } }
}
function cloud() {
  let account = 'account-a', generation = 0, ids = 0
  const folders = new Map<string, { id: string; name: string; account: string }>(), configs = new Map<string, Uint8Array>()
  const projects = [{ folderId: 'legacy-a', projectId: 'project-a', name: 'AI Novel Writer · 旧作品甲' }, { folderId: 'legacy-b', projectId: 'project-b', name: 'AI Novel Writer · 旧作品乙' }]
  let onRead: (() => void) | undefined, concurrentCreate = false
  const client = { accountId: async () => account, allocateId: async () => `folder-${++ids}`,
    modelSettingsFolders: async (owner: string) => [...folders.values()].filter(folder => folder.account === owner),
    checkModelSettingsFolder: async (id: string, owner: string) => { const folder = folders.get(id); if (!folder || folder.account !== owner) throw new Error('DRIVE_OBJECT_MISMATCH'); return folder },
    createModelSettingsFolder: async (owner: string, id: string) => {
      folders.set(id, { id, name: '账户模型配置', account: owner })
      if (concurrentCreate) folders.set('other-device-folder', { id: 'other-device-folder', name: '另一设备同时创建', account: owner })
    },
    projects: async () => projects,
    checkFolder: async (id: string) => { const p = projects.find(project => project.folderId === id); if (!p) throw new Error('DRIVE_PROJECT_MISMATCH'); return { id, name: p.name, appProperties: { ainwProject: p.projectId } } },
    listObjects: async (id: string) => configs.has(id) ? [{ id: `${id}-settings` }] : [],
    readModelSettings: vi.fn(async (id: string) => { onRead?.(); const bytes = configs.get(id); if (!bytes) throw new Error('MODEL_SYNC_NOT_FOUND'); return bytes }),
    writeModelSettings: vi.fn(async (id: string, _project: string, bytes: Uint8Array) => { configs.set(id, bytes.slice()) }) }
  const install = (target = local(), legacyCapture = false) => {
    const handlers = new Map<string, Function>(), capture = vi.fn(() => {
      if (!legacyCapture) throw new Error('PROJECT_NOT_OPEN')
      return { projectId: 'project-a', folderId: 'legacy-a', accountId: account, check() {} }
    })
    let state: DriveState = { version: 1, bindings: {}, creating: {} }
    const registration = registerModelSettingsSyncController({ handle: (name, handler) => { handlers.set(name, handler) }, capture,
      captureAccount() { const captured = generation; return { generation: captured, check() { if (captured !== generation) throw new Error('GOOGLE_AUTH_CHANGED') } } },
      state: new GoogleDriveStateStore({ read: () => structuredClone(state), write: value => { state = structuredClone(value) } }),
      locks: new Set(), store: target.store, client: () => client as unknown as GoogleDriveClient })
    const call = (action: string, raw: Record<string, unknown> = {}, owner = 1) => handlers.get(`drive:model-settings-${action}`)!({ sender: { id: owner } }, raw)
    return { ...target, target, capture, call, registration }
  }
  const seed = (id: string, name: string) => configs.set(id, encodeModelSettings(parseModelSettingsSnapshot({ format: 'ai-novel-model-settings', version: 1,
    models: [model(name)], defaultModelId: name, defaultEmbeddingModelId: null, stageModelIds: {} })))
  return { client, install, seed, folders, configs, changeAccount(value = 'account-b') { account = value; generation++ }, duringRead(action: () => void) { onRead = action }, race() { concurrentCreate = true } }
}

it('uploads on one device and explicitly previews/applies on another without any open project or key in responses', async () => {
  const c = cloud(), source = c.install(local([model('text'), model('embedding', true)])), target = c.install()
  try {
    const uploaded = await source.call('upload'); expect(uploaded.modelSettingsSource.kind).toBe('account')
    expect(uploaded.modelSettingsSource.projectId).toBe(MODEL_SETTINGS_ACCOUNT_SCOPE)
    const read = await target.call('preview'); expect(read.modelSettingsPreview.total).toBe(2)
    expect(target.target.models).toHaveLength(1)
    const applied = await target.call('apply', { token: read.modelSettingsPreview.token })
    expect(applied.modelCount).toBe(2); expect(target.target.models.map(item => item.id)).toEqual(['unrelated', 'text', 'embedding'])
    expect(target.target.models.find(item => item.id === 'embedding')!.apiKey).toBe(key)
    expect(target.target.config.proxy?.host).toBe('127.0.0.1')
    expect(source.capture).not.toHaveBeenCalled(); expect(target.capture).not.toHaveBeenCalled()
    expect(JSON.stringify([uploaded, read, applied])).not.toContain(key)
  } finally { source.registration.cancelAll(); target.registration.cancelAll() }
})
it('rejects a preview after account change, including switching away and back to the same account', async () => {
  const c = cloud(), f = c.install(); await f.call('upload')
  try {
    const preview = await f.call('preview'); c.changeAccount()
    await expect(f.call('apply', { token: preview.modelSettingsPreview.token })).rejects.toThrow('DRIVE_ACCOUNT_MISMATCH')
    c.changeAccount('account-a')
    await expect(f.call('apply', { token: preview.modelSettingsPreview.token })).rejects.toThrow('MODEL_SYNC_PREVIEW_EXPIRED')
  } finally { f.registration.cancelAll() }
})
it('rejects an authorization change while reading cloud keys before issuing a preview', async () => {
  const c = cloud(), f = c.install(); await f.call('upload')
  try { c.duringRead(() => c.changeAccount()); await expect(f.call('preview')).rejects.toThrow('GOOGLE_AUTH_CHANGED') }
  finally { f.registration.cancelAll() }
})
it('preserves a local model edit made after preview and refuses foreign-window tokens', async () => {
  const c = cloud(), f = c.install(); await f.call('upload')
  try {
    const preview = await f.call('preview'), token = preview.modelSettingsPreview.token
    await expect(f.call('apply', { token }, 2)).rejects.toThrow('MODEL_SYNC_PREVIEW_EXPIRED')
    f.target.edit(); await expect(f.call('apply', { token })).rejects.toThrow('MODEL_SYNC_LOCAL_CHANGED')
    expect(f.target.models[0]!.apiKey).toBe('SYNTHETIC_LOCAL_EDIT')
  } finally { f.registration.cancelAll() }
})
it('invalidates an old import preview when the same window explicitly uploads local settings', async () => {
  const c = cloud(), f = c.install(); await f.call('upload')
  try {
    const preview = await f.call('preview'); await f.call('upload')
    await expect(f.call('apply', { token: preview.modelSettingsPreview.token })).rejects.toThrow('MODEL_SYNC_PREVIEW_EXPIRED')
  } finally { f.registration.cancelAll() }
})
it('lists old project sources without keys and never silently chooses between their different settings', async () => {
  const c = cloud(), f = c.install(); c.seed('legacy-a', '旧甲模型'); c.seed('legacy-b', '旧乙模型')
  const original = c.configs.get('legacy-a')!.slice()
  try {
    const sources = await f.call('sources'); expect(sources.modelSettingsSources.map((source: { name: string }) => source.name)).toEqual(['旧作品甲', '旧作品乙'])
    expect(JSON.stringify(sources)).not.toContain(key)
    await expect(f.call('preview')).rejects.toThrow('MODEL_SYNC_NOT_FOUND')
    const preview = await f.call('preview', { sourceFolderId: 'legacy-a' }); expect(preview.modelSettingsSource.kind).toBe('project')
    await f.call('apply', { token: preview.modelSettingsPreview.token }); await f.call('upload')
    expect(c.configs.get('legacy-a')).toEqual(original); expect(c.folders.size).toBe(1)
    expect((await f.call('preview')).modelSettingsSource.kind).toBe('account')
  } finally { f.registration.cancelAll() }
})
it('reads the explicitly supplied current project as an old migration source when no account configuration exists', async () => {
  const c = cloud(), f = c.install(local(), true); c.seed('legacy-a', '旧项目配置')
  try {
    const preview = await f.call('preview', { projectSession: {} }); expect(preview.modelSettingsSource).toMatchObject({ kind: 'project', folderId: 'legacy-a' })
    expect(f.capture).toHaveBeenCalledOnce()
  } finally { f.registration.cancelAll() }
})
it('reports concurrent account-folder creation instead of uploading keys to an arbitrary folder', async () => {
  const c = cloud(), f = c.install(); c.race()
  try {
    await expect(f.call('upload')).rejects.toThrow('MODEL_SYNC_CLOUD_CONFLICT')
    expect(c.client.writeModelSettings).not.toHaveBeenCalled(); expect(c.configs.size).toBe(0)
    await expect(f.call('preview')).rejects.toThrow('MODEL_SYNC_CLOUD_CONFLICT')
  } finally { f.registration.cancelAll() }
})
