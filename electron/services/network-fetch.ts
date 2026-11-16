import { networkProxyRule, type NetworkProxy, type NetworkTransport } from './network-transport'

let transport: NetworkTransport | undefined

/** Desktop installs its Chromium transport before business IPC; Android retains native fetch. */
export function installNetworkTransport(value: NetworkTransport): void { transport = value }

export const networkFetch: typeof fetch = (input, init) => (transport?.fetch ?? globalThis.fetch)(input, init)

export async function commitNetworkProxy(proxy: NetworkProxy, commit: () => void): Promise<void> {
  networkProxyRule(proxy)
  if (transport) await transport.configure(proxy, commit)
  else commit()
}
