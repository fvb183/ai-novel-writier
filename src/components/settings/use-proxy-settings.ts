import { useEffect, useRef, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { normalizeProxyConfig, proxyConfigErrorText } from '../../shared/proxy-config'

export interface ProxyDraft {
  enabled: boolean
  type: 'http' | 'socks5' | ''
  host: string
  /** Keep author input intact; only an explicit valid port is persisted. */
  port: number | string
}

const DEFAULT_PROXY: ProxyDraft = { enabled: false, type: 'http', host: '', port: 7890 }

/** 网络代理的读取与保存。 */
export function useProxySettings() {
  const text = useLocaleStore(s => s.text)
  const [proxy, setProxy] = useState<ProxyDraft>(DEFAULT_PROXY)
  const [stored, setStored] = useState<ProxyDraft>(DEFAULT_PROXY)
  const [system, setSystem] = useState(true)
  const [storedSystem, setStoredSystem] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const alive = useRef(true), inFlight = useRef(false), savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    alive.current = true
    ipc.invoke('config:get').then((cfg) => {
      if (cancelled) return
      if (cfg?.proxy) {
        const legacy = cfg.proxy as typeof cfg.proxy & { protocol?: unknown }
        const kind = String(legacy.type ?? legacy.protocol ?? 'http').trim().toLowerCase().replace(/:(?:\/\/)?$/u, '')
        let loaded: ProxyDraft = {
          enabled: cfg.proxy.enabled === true,
          type: kind === 'socks5' || kind === 'http' ? kind : '',
          host: typeof cfg.proxy.host === 'string' ? cfg.proxy.host : '',
          port: cfg.proxy.port ?? '',
        }
        try { loaded = normalizeProxyConfig(cfg.proxy)! }
        catch (error) { setSaveError(proxyConfigErrorText(error, text)) }
        setProxy(loaded)
        setStored(loaded)
        setSystem(false)
        setStoredSystem(false)
      }
      setLoaded(true)
    }).catch(() => {
      if (!cancelled) setSaveError(text('无法读取代理配置，请重新打开设置后重试。', 'Could not read proxy settings. Reopen settings and retry.'))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; alive.current = false; if (savedTimer.current) clearTimeout(savedTimer.current) }
  }, [])

  const persist = async (useSystem: boolean) => {
    if (inFlight.current || !loaded) return
    let snapshot: NonNullable<ReturnType<typeof normalizeProxyConfig>>
    try {
      snapshot = normalizeProxyConfig({ ...proxy, enabled: useSystem ? false : proxy.enabled })!
    } catch (error) {
      setSaved(false)
      setSaveError(proxyConfigErrorText(error, text) ?? text('请检查代理地址和端口后再保存。', 'Check the proxy address and port before saving.'))
      return
    }
    inFlight.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const result = await ipc.invoke('config:set', { proxy: useSystem ? undefined : snapshot })
      if (!result.success) throw new Error(result.error || text('未知错误', 'Unknown error'))
      if (!alive.current) return
      setProxy(snapshot)
      setStored(snapshot)
      setSystem(useSystem)
      setStoredSystem(useSystem)
      setSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => { if (alive.current) setSaved(false) }, 2000)
    } catch (error) {
      if (!alive.current) return
      setSaved(false)
      const reason = proxyConfigErrorText(error, text) ?? displayedErrorMessage(useLocaleStore.getState().locale, error)
      setSaveError(text(`代理配置保存失败：${reason}`, `Could not save proxy settings: ${reason}`))
    } finally {
      inFlight.current = false
      if (alive.current) setSaving(false)
    }
  }

  let storedProxyValid = true
  if (!storedSystem && stored.enabled) {
    try { normalizeProxyConfig(stored) } catch { storedProxyValid = false }
  }
  return {
    proxy,
    loading,
    loaded,
    networkMode: storedSystem ? 'system' : !stored.enabled ? 'direct' : storedProxyValid ? 'custom' : 'invalid',
    /** 表单与上次读到或保存的设置不同。 */
    dirty: system !== storedSystem || JSON.stringify(proxy) !== JSON.stringify(stored),
    update: (patch: Partial<ProxyDraft>) => { if (inFlight.current || !loaded) return; setSaved(false); setSaveError(null); setSystem(false); setProxy(previous => ({ ...previous, ...patch })) },
    saving,
    saved,
    saveError,
    save: () => persist(system),
    useSystemNetwork: () => persist(true),
  }
}
