import { randomUUID } from 'node:crypto'
import type { ModelSettingsSnapshot, ModelSettingsPreview } from '../../src/shared/model-settings-sync'
import type { ModelSettingsSource } from '../../src/shared/google-drive-sync'
import { decodeModelSettings, encodeModelSettings } from '../../src/shared/model-settings-sync'
import type { GoogleDriveClient } from '../services/google-drive-client'
import { GoogleDriveStateStore } from '../services/google-drive-state'
import { accountModelSettingsTarget } from '../services/model-settings-drive-target'
import { ModelSettingsStore } from '../services/model-settings-sync'

interface Captured { projectId: string; folderId: string; accountId: string; check(): void }
interface AccountLease { generation: number; check(): void }
interface Preview { owner: number; accountId: string; generation: number; revision: string; expires: number; snapshot: ModelSettingsSnapshot; source: ModelSettingsSource }
export function registerModelSettingsSyncController(options: {
  handle(channel: string, action: (event: { sender: { id: number } }, raw: unknown) => Promise<unknown>): void
  capture(raw: unknown): Captured; captureAccount(): AccountLease
  client(check: () => void): GoogleDriveClient; locks: Set<string>; store?: ModelSettingsStore; state?: GoogleDriveStateStore
}) {
  const store = options.store ?? new ModelSettingsStore(), state = options.state ?? new GoogleDriveStateStore()
  const previews = new Map<string, Preview>(), timers = new Map<string, ReturnType<typeof setTimeout>>()
  const fail = (code: string): never => { throw new Error(code) }
  const remove = (token: string) => { previews.delete(token); const timer = timers.get(token); if (timer) clearTimeout(timer); timers.delete(token) }
  const discard = (owner: number) => { for (const [key, value] of previews) if (value.owner === owner || value.expires < Date.now()) remove(key) }
  for (const action of ['upload', 'preview', 'apply', 'discard', 'sources'] as const) options.handle(`drive:model-settings-${action}`, async (event, raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('DRIVE_INPUT_INVALID')
    const value = raw as Record<string, unknown>
    if (action === 'discard') { discard(event.sender.id); return { success: true } }
    const lease = options.captureAccount(), lock = 'account:model-settings'
    lease.check()
    if (options.locks.has(lock)) fail('DRIVE_BUSY')
    options.locks.add(lock)
    try {
      const client = options.client(lease.check), accountId = await client.accountId(); lease.check()
      const projectSource = async (folderId: string): Promise<ModelSettingsSource> => {
        const folder = await client.checkFolder(folderId); lease.check()
        return { kind: 'project', folderId: folder.id, projectId: folder.appProperties!.ainwProject, name: folder.name.replace(/^AI Novel Writer · /, '') }
      }
      if (action === 'sources') {
        const projects = await client.projects(); lease.check()
        const sources: ModelSettingsSource[] = []
        for (const project of projects) {
          const files = await client.listObjects(project.folderId, project.projectId, 'model-settings'); lease.check()
          if (files.length) sources.push({ kind: 'project', folderId: project.folderId, projectId: project.projectId, name: project.name.replace(/^AI Novel Writer · /, '') })
        }
        return { success: true, modelSettingsSources: sources }
      }
      if (action === 'upload') {
        discard(event.sender.id)
        const snapshot = store.snapshot(), target = await accountModelSettingsTarget(client, state, accountId, true, lease.check)
        if (!target) fail('MODEL_SYNC_NOT_FOUND')
        await client.writeModelSettings(target!.folderId, target!.projectId, encodeModelSettings(snapshot)); lease.check()
        return { success: true, modelCount: snapshot.models.length, modelSettingsSource: target }
      }
      if (action === 'preview') {
        discard(event.sender.id)
        let source: ModelSettingsSource | undefined
        if (value.sourceFolderId !== undefined) {
          if (typeof value.sourceFolderId !== 'string') fail('DRIVE_INPUT_INVALID')
          source = await projectSource(value.sourceFolderId as string)
        } else {
          source = await accountModelSettingsTarget(client, state, accountId, false, lease.check)
          if (!source && value.projectSession !== undefined) {
            // Legacy project files remain readable migration sources; applying
            // models is global and does not mutate that book or upload its API keys.
            try {
              const old = options.capture(value.projectSession); old.check()
              if (old.accountId !== accountId) fail('DRIVE_ACCOUNT_MISMATCH')
              source = await projectSource(old.folderId); old.check()
            } catch (error) {
              if ((error as Error).message !== 'DRIVE_PROJECT_NOT_BOUND') throw error
            }
          }
        }
        if (!source) fail('MODEL_SYNC_NOT_FOUND')
        const snapshot = decodeModelSettings(await client.readModelSettings(source!.folderId, source!.projectId)); lease.check()
        const local = store.capture(), token = randomUUID()
        previews.set(token, { owner: event.sender.id, accountId, generation: lease.generation, revision: local.revision, expires: Date.now() + 300_000, snapshot, source: source! })
        timers.set(token, setTimeout(() => remove(token), 300_000)); timers.get(token)?.unref?.()
        const preview: ModelSettingsPreview = { token, total: snapshot.models.length, modelNames: snapshot.models.map(model => model.name || model.modelName),
          embeddings: snapshot.models.filter(model => model.purposes.includes('embedding')).length,
          added: snapshot.models.filter(model => !local.models.some(old => old.id === model.id)).length,
          updated: snapshot.models.filter(model => local.models.some(old => old.id === model.id && JSON.stringify(old) !== JSON.stringify(model))).length }
        return { success: true, modelSettingsPreview: preview, modelSettingsSource: source }
      }
      if (typeof value.token !== 'string') fail('MODEL_SYNC_PREVIEW_EXPIRED')
      const pending = previews.get(value.token as string)
      if (!pending || pending.owner !== event.sender.id || pending.expires < Date.now()) fail('MODEL_SYNC_PREVIEW_EXPIRED')
      if (pending!.accountId !== accountId) fail('DRIVE_ACCOUNT_MISMATCH')
      if (pending!.generation !== lease.generation) fail('MODEL_SYNC_PREVIEW_EXPIRED')
      remove(value.token as string); lease.check()
      return { success: true, modelCount: store.apply(pending!.snapshot, pending!.revision, lease.check), modelSettingsSource: pending!.source }
    } finally { options.locks.delete(lock) }
  })
  return { cancelAll() { for (const token of previews.keys()) remove(token) } }
}
