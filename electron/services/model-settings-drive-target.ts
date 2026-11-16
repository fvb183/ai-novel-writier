import type { ModelSettingsSource } from '../../src/shared/google-drive-sync'
import { GoogleDriveClient, MODEL_SETTINGS_ACCOUNT_SCOPE } from './google-drive-client'
import { GoogleDriveStateStore } from './google-drive-state'

/** An account-owned settings folder is deliberately excluded from the novel catalog. */
export async function accountModelSettingsTarget(client: GoogleDriveClient, state: GoogleDriveStateStore, accountId: string,
  create: boolean, check: () => void): Promise<ModelSettingsSource | undefined> {
  let folders = await client.modelSettingsFolders(accountId); check()
  if (folders.length > 1) throw new Error('MODEL_SYNC_CLOUD_CONFLICT')
  if (!folders.length && create) {
    const key = `model-settings-account|${accountId}`, pending = state.read().creating[key]
    if (pending && pending.accountId !== accountId) throw new Error('DRIVE_ACCOUNT_MISMATCH')
    const folderId = pending?.folderId ?? await client.allocateId(); check()
    state.update(value => { value.creating[key] = { accountId, folderId } })
    await client.createModelSettingsFolder(accountId, folderId); check()
    // Another device can create its own reserved folder concurrently. Ambiguity
    // is reported, never resolved by silently selecting one device's API keys.
    folders = await client.modelSettingsFolders(accountId); check()
    if (folders.length !== 1) throw new Error('MODEL_SYNC_CLOUD_CONFLICT')
    state.update(value => { delete value.creating[key] })
  }
  if (!folders.length) return undefined
  const folder = await client.checkModelSettingsFolder(folders[0]!.id, accountId); check()
  return { kind: 'account', folderId: folder.id, projectId: MODEL_SETTINGS_ACCOUNT_SCOPE, name: folder.name }
}
