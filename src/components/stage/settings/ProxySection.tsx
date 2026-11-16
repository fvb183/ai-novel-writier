import { useId } from 'react'
import { useLocaleStore } from '../../../stores/locale-store'
import { useUnsavedSettings } from '../../settings/unsaved-settings'
import { useProxySettings } from '../../settings/use-proxy-settings'
import { Button } from '../../ui/Button'
import { Check } from '../../ui/Check'

/** 网络代理：开关、类型、主机与端口，保存后所有 AI 请求都走代理。 */
export default function ProxySection() {
  const text = useLocaleStore(s => s.text)
  const { proxy, dirty, update, saving, saved, saveError, save, networkMode, loading, loaded, useSystemNetwork } = useProxySettings()
  const isAndroid = document.documentElement.dataset.platform === 'android'
  const disabled = saving || loading || !loaded
  useUnsavedSettings(dirty)
  const typeId = useId()
  const hostId = useId()
  const portId = useId()
  return (
    <div className="stage-set-rows">
      <div className="stage-set-row">
        <div>
          <p className="stage-set-row-title">{text('启用代理', 'Use a proxy')}</p>
          <p className="stage-set-row-desc">{isAndroid
            ? text('代理关闭时使用手机当前网络。开启后按下方地址连接；Google 原生授权由系统 Google 服务处理。', 'With the proxy off, the phone network is used. Enable it to use the address below. Native Google authorization is handled by Google services.')
            : text('未配置时沿用系统网络；保存为关闭后直接连接。电脑版的模型请求与 Google 云同步共用此设置。', 'Without a saved setting, the system network is used. Saving this as off selects a direct connection. Desktop model requests and Google cloud sync share this setting.')}</p>
          {!isAndroid && <p className="stage-set-row-desc" role="status">{loading ? text('正在读取网络设置…', 'Reading network settings…') : !loaded ? text('网络设置尚未读取。', 'Network settings have not loaded.') : networkMode === 'system'
            ? text('当前使用：系统网络设置', 'Currently using: system network settings') : networkMode === 'invalid'
              ? text('已保存的代理地址不完整，请补填后保存，或选择系统网络设置。', 'The saved proxy address is incomplete. Complete and save it, or use system network settings.') : networkMode === 'direct'
              ? text('当前使用：直接连接', 'Currently using: direct connection') : text('当前使用：自定义代理', 'Currently using: custom proxy')}</p>}
        </div>
        <div className="stage-set-row-ctl">
          <Check kind="switch" checked={proxy.enabled} disabled={disabled} onChange={enabled => update({ enabled })}
            label={<span className="stage-visually-hidden">{text('启用代理', 'Use a proxy')}</span>} />
        </div>
      </div>
      {proxy.enabled && (
        <div className="stage-set-form">
          <div className="stage-set-field">
            <label htmlFor={typeId}>{text('代理类型', 'Proxy type')}</label>
            <select id={typeId} className="stage-select" value={proxy.type} disabled={disabled} onChange={event => update({ type: event.target.value as 'http' | 'socks5' })}>
              {proxy.type === '' && <option value="" disabled>{text('请选择代理类型', 'Choose a proxy type')}</option>}
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </div>
          <div className="stage-set-field stage-set-field--grow">
            <label htmlFor={hostId}>{text('主机地址', 'Host')}</label>
            <input id={hostId} className="pi-input" value={proxy.host} disabled={disabled} required placeholder={text('必填，例如 127.0.0.1', 'Required, e.g. 127.0.0.1')} aria-invalid={!proxy.host.trim() || undefined} aria-describedby={`${hostId}-hint`} onChange={event => update({ host: event.target.value })} />
            <p id={`${hostId}-hint`} className="stage-set-row-desc">{text('主机地址必填，灰色示例不是已填写的值。也可粘贴主机:端口或 HTTP/SOCKS5 地址；地址里的类型和端口优先。', 'Enter a host; the gray example is not a saved value. You can also paste host:port or an HTTP/SOCKS5 address. The address scheme and port take precedence.')}</p>
          </div>
          <div className="stage-set-field">
            <label htmlFor={portId}>{text('端口', 'Port')}</label>
            <input id={portId} className="pi-input" type="number" min={1} max={65535} step={1} inputMode="numeric" value={proxy.port} disabled={disabled}
              onChange={event => update({ port: event.target.value })} />
          </div>
        </div>
      )}
      <div className="stage-set-actions">
        {saveError && <p className="stage-set-error" role="alert">{saveError}</p>}
        <span className="stage-set-saved" role="status">{saved ? text('已保存', 'Saved') : ''}</span>
        {!isAndroid && <Button variant="secondary" disabled={disabled} onClick={() => void useSystemNetwork()}>{text('使用系统网络设置', 'Use system network settings')}</Button>}
        <Button variant="primary" disabled={disabled} onClick={() => void save()}>
          {saving ? text('正在保存…', 'Saving…') : text('保存代理设置', 'Save proxy settings')}
        </Button>
      </div>
    </div>
  )
}
