import { app, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from '../utils/config-utils'
import type { GlobalConfig } from '../../src/shared/ipc-channels'
import { DesktopNetworkTransport } from './network-transport'
import { installNetworkTransport } from './network-fetch'

export function installDesktopNetworkTransport(): void {
  installNetworkTransport(new DesktopNetworkTransport({
    ready: () => app.whenReady(),
    initialProxy: () => readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG).proxy,
    createSession: () => {
      const active = session.fromPartition(`ai-novel-api-${randomUUID()}`, { cache: false })
      return {
        setProxy: config => active.setProxy(config),
        fetch: (input, init) => active.fetch(input instanceof URL ? input.href : input, init),
        closeAllConnections: () => active.closeAllConnections(),
      }
    },
  }))
}
