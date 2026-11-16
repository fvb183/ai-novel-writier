import { app, ipcMain } from 'electron'
import { readJsonFile, updateGlobalConfig, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from '../utils/config-utils'
import { GlobalConfig } from '../../src/shared/ipc-channels'
import { commitNetworkProxy } from '../services/network-fetch'
import { mainText } from '../i18n'
import { normalizeProxyConfig } from '../../src/shared/proxy-config'

export function registerConfigController() {
  let pendingWrite: Promise<unknown> = Promise.resolve()
  ipcMain.handle('config:get', async () => readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG))

  ipcMain.handle('config:set', (_event, config: Partial<GlobalConfig>) => {
    const operation = pendingWrite.then(async () => {
      try {
        const candidate = Object.hasOwn(config, 'proxy') ? { ...config, proxy: normalizeProxyConfig(config.proxy) } : config
        // Proxy preparation awaits Chromium. Read again at commit so concurrent
        // stage assignments and other preferences are preserved.
        const commit = () => {
          if (!updateGlobalConfig(existing => ({ ...existing, ...candidate, stageModelIds: existing.stageModelIds }))) {
            throw new Error(mainText(
              app.getLocale(),
              '全局配置文件已损坏，已拒绝覆盖。请修复或删除应用数据目录里的 config.json 后重试。',
              'The global config file is damaged, so it was not overwritten. Repair or delete config.json in the app data folder, then try again.',
            ))
          }
        }
        if (Object.hasOwn(candidate, 'proxy')) await commitNetworkProxy(candidate.proxy, commit)
        else commit()
        return { success: true }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    })
    pendingWrite = operation.then(() => {}, () => {})
    return operation
  })
}
