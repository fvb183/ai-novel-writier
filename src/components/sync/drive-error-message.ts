import { syncAssetMessage } from './sync-asset-messages'

/** Only protocol error codes may reach the UI; native messages can contain paths or credentials. */
export function safeDriveErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /^(?:DRIVE|GOOGLE|SYNC|PROJECT_SYNC|MODEL_SYNC)_[A-Z0-9_]{1,80}$/.test(value) ? value : 'DRIVE_OPERATION_FAILED'
}

type Text = (zh: string, en: string) => string
export function driveMessage(error: unknown, text: Text): string {
  const code = safeDriveErrorCode(error)
  const assetMessage = syncAssetMessage(code, text)
  if (assetMessage) return `${assetMessage} (${code})`
  const messages: Record<string, [string, string]> = {
    GOOGLE_AUTH_CHANGED: ['Google 授权已变化，已停止这次传输。请核对当前账户后重试。', 'Google authorization changed, so this transfer stopped. Check the current account and retry.'],
    SYNC_READER_FEATURE_REQUIRED: ['同步包缺少所需的项目同步能力标记。请更新来源应用后重新传输。', 'The bundle lacks a required project sync capability marker. Update the source app and transfer again.'],
    SYNC_READER_FEATURE_UNSUPPORTED: ['云端内容需要更新版本的同步能力，请先更新两台设备。', 'The cloud content requires newer sync capabilities. Update both devices first.'],
    PROJECT_SYNC_NARRATIVE_INVALID: ['伏笔计划或定稿证据不完整，未应用到本地作品。请在来源设备核对。', 'Narrative plans or finalized evidence are inconsistent and were not applied. Review the source device.'],
    PROJECT_SYNC_NARRATIVE_EVENT_IMMUTABLE: ['更新试图改写已保存的伏笔确认，已拒绝应用；请核对来源副本。', 'The update attempts to rewrite saved narrative confirmations and was rejected. Review the source copy.'],
    GOOGLE_AUTH_REQUIRED: ['请先连接 Google 账户；本地写作不受影响。', 'Connect your Google account first. Local writing is still available.'],
    GOOGLE_CLIENT_ID_INVALID: ['请输入正确的 Desktop OAuth 客户端 ID。', 'Enter a valid Desktop OAuth client ID.'],
    GOOGLE_CLIENT_NOT_CONFIGURED: ['请先完成下面的 Google 应用配置。', 'Complete the Google application setup below first.'],
    GOOGLE_AUTH_NETWORK_FAILED: ['无法完成 Google 授权请求，请检查网络后重试。', 'The Google authorization request failed. Check your network and retry.'],
    GOOGLE_CLIENT_REJECTED: ['Google 未接受此应用的 OAuth 配置。请核对 Desktop 客户端 ID、客户端类型及测试用户设置后重试。', 'Google rejected this app’s OAuth configuration. Check the Desktop client ID, client type and test users, then retry.'],
    GOOGLE_AUTH_REQUEST_REJECTED: ['Google 拒绝了授权码兑换请求。请核对 Desktop OAuth 客户端配置后重新连接。', 'Google rejected the authorization-code exchange. Check the Desktop OAuth client setup and connect again.'],
    GOOGLE_CLIENT_SECRET_REQUIRED: ['Google 要求此客户端提供客户端密钥。请在“Google 应用配置”中填写该 Desktop OAuth JSON 的 client_secret，然后重新连接。', 'Google requires a client secret for this client. Enter client_secret from its Desktop OAuth JSON in Google application setup, then connect again.'],
    GOOGLE_CLIENT_SECRET_INVALID: ['客户端密钥格式无效。请从该 Desktop OAuth JSON 复制 client_secret 的值，不要填写访问令牌。', 'The client secret format is invalid. Copy the client_secret value from this Desktop OAuth JSON, not an access token.'],
    GOOGLE_AUTH_SCOPE_INVALID: ['Google 未接受云同步所需的授权范围。请核对 Google 应用配置后重试。', 'Google rejected the cloud sync permission scope. Check the Google app configuration and retry.'],
    GOOGLE_AUTH_RESPONSE_INVALID: ['Google 未返回有效的授权结果，请重新连接。', 'Google did not return a valid authorization result. Connect again.'],
    GOOGLE_AUTH_CANCELLED: ['已取消 Google 授权。', 'Google authorization cancelled.'],
    GOOGLE_AUTH_INTERRUPTED: ['Google 授权流程中断，请检查 Google Play 服务与网络后重试。', 'Google authorization was interrupted. Check Google Play services and your network, then retry.'],
    GOOGLE_AUTH_RESULT_MISSING: ['Google 未返回完整的授权结果，请重试。', 'Google did not return a complete authorization result. Retry.'],
    GOOGLE_OAUTH_CONFIGURATION_REQUIRED: ['Google 未接受此 Android 应用。请核对 Android OAuth 客户端的包名与签名 SHA-1，确认已启用 Drive API 并添加测试用户。', 'Google rejected this Android app. Check the Android OAuth package name and signing SHA-1, enable Drive API and add your test user.'],
    GOOGLE_NETWORK_ERROR: ['手机的 Google 服务无法连接网络，请检查 Google Play 服务、网络及 VPN 后重试。', 'Google services on this phone could not connect. Check Google Play services, your network and VPN, then retry.'],
    GOOGLE_PLAY_SERVICES_CONNECTION_FAILED: ['Google Play 服务连接中断或正在更新，请检查服务状态后重试。', 'Google Play services disconnected or are updating. Check their status and retry.'],
    GOOGLE_PLAY_SERVICES_ERROR: ['Google Play 服务暂时出错，请重试；若持续失败，请检查或更新 Google Play 服务。', 'Google Play services encountered an error. Retry, or check and update Google Play services if it persists.'],
    GOOGLE_ACCOUNT_INVALID: ['设备上的 Google 账户需要重新检查，请在系统设置中确认账户可正常使用后重试。', 'Check the Google account in your device settings, then retry.'],
    GOOGLE_AUTH_UNAVAILABLE: ['无法打开 Google 授权窗口，请检查 Google Play 服务后重试。', 'The Google authorization window could not open. Check Google Play services and retry.'],
    GOOGLE_AUTH_FAILED: ['Google 授权未完成，请检查 Google 服务、应用配置与网络后重试。', 'Google authorization did not complete. Check Google services, app setup and your network, then retry.'],
    GOOGLE_AUTH_TIMEOUT: ['授权等待已超时，请重新连接并在浏览器完成授权。', 'Authorization timed out. Connect again and finish in your browser.'],
    GOOGLE_BROWSER_FAILED: ['无法打开系统浏览器，请检查默认浏览器后重试。', 'The system browser could not be opened. Check your default browser and retry.'],
    GOOGLE_PLAY_SERVICES_UNAVAILABLE: ['本设备的 Google Play 服务不可用，请先检查 Google 服务。', 'Google Play services are unavailable on this device. Check Google services first.'],
    DRIVE_BUSY: ['另一项同步正在处理，请稍后重试。', 'Another sync is running. Retry shortly.'],
    DRIVE_PREPARE_FAILED: ['读取或整理本地作品资料时失败；本地作品已保留，请保留此错误码以便排查。', 'Reading or preparing local book data failed. Your local book is retained. Keep this error code for diagnosis.'],
    DRIVE_LOCAL_ACCESS_DENIED: ['系统拒绝了同步所需的本地文件操作；本地作品已保留。', 'The system denied a local file operation required for sync. Your local book is retained.'],
    DRIVE_LOCAL_STORAGE_FULL: ['本地存储空间不足，无法保存同步资料。请释放空间后重试；现有作品已保留。', 'Local storage is full. Free space and retry; your existing book is retained.'],
    DRIVE_BIND_FAILED: ['创建或关联云端副本时失败，请检查网络后重试；本地作品已保留。', 'Creating or linking the cloud copy failed. Check your connection and retry; your local book is retained.'],
    DRIVE_UPLOAD_FAILED: ['上传作品时失败；已记录开启同步的请求，联网后会继续重试，本地作品已保留。', 'The upload failed. Your sync choice is saved and will retry when online; your local book is retained.'],
    DRIVE_REQUEST_FAILED: ['Google Drive 未接受本次请求，请检查网络和云端存储空间后重试。', 'Google Drive did not accept this request. Check your connection and cloud storage, then retry.'],
    DRIVE_PROJECT_EMPTY: ['请在原设备为这部作品开启同步，并等待首次上传完成。', 'Enable sync on the source device and wait for its first upload to finish.'],
    SYNC_COMPACT_UPGRADE_REQUIRED: ['这部作品使用新的精简同步格式，请将电脑与手机同时更新到 1.4.4 或更高版本。', 'This book uses compact sync. Update both desktop and phone to version 1.4.4 or newer.'],
    DRIVE_PACKAGE_INVALID: ['云端变更格式或校验不正确，尚未应用。请先确认电脑与手机已更新到同一版本。', 'Cloud changes failed format or integrity checks and were not applied. Check that desktop and phone use the same current version.'],
    SYNC_JOIN_INCOMPLETE: ['云端作品有尚未解决的版本冲突，请先在原设备处理；现有内容已保留。', 'Resolve pending cloud conflicts on the source device first. Existing content is retained.'],
    DRIVE_FOLDER_SELECTION_REQUIRED: ['云端有同一作品的多个副本，请在高级云端操作中选择要关联的副本。', 'This book has multiple cloud folders. Choose a folder in advanced cloud operations.'],
    DRIVE_REQUEST_TIMEOUT: ['连接 Google Drive 超时。请检查网络、VPN 或代理后重试；本地内容已保留。', 'The Google Drive request timed out. Check your network, VPN or proxy and retry. Local content is retained.'],
    DRIVE_SYNC_TIMEOUT: ['本次同步等待超时，检查已停止。已保存内容和完整资料保留，重试时会继续传输。', 'This sync timed out and stopped. Saved content and complete assets are retained; retry to continue transferring.'],
    DRIVE_CANCELLED: ['本次云端操作已停止，本地已保存的内容保留。', 'This cloud operation stopped. Saved local content is retained.'],
    DRIVE_NETWORK_FAILED: ['暂时无法访问 Google Drive，已保存的本地内容仍可继续编辑。', 'Google Drive is unreachable. Continue editing your saved local content and retry later.'],
    DRIVE_ACCESS_DENIED: ['此账户无权访问云端作品，请核对账户与授权。', 'This account cannot access the cloud project. Check the account and authorization.'],
    DRIVE_ACCOUNT_MISMATCH: ['当前 Google 账户与这部作品原绑定的账户不同。请切回原账户，或重新关联当前账户的云端副本。', 'This Google account differs from the project’s linked account. Switch back or link a cloud copy belonging to the current account.'],
    DRIVE_RATE_LIMITED: ['Google Drive 暂时限制请求，请稍后重试。', 'Google Drive is temporarily rate limiting requests. Retry later.'],
    DRIVE_FILE_NOT_FOUND: ['云端作品或变更文件已不存在，请重新读取云端列表。', 'The cloud project or change file no longer exists. Reload the cloud list.'],
    DRIVE_LOCAL_SAVE_FAILED: ['本地内容尚未保存，已停止云端传输。请先保存本地内容后重试。', 'Local content has not been saved. Cloud transfer was stopped. Save locally and retry.'],
    DRIVE_PROJECT_MISMATCH: ['所选云端作品与当前本地作品不一致，请重新选择。', 'The selected cloud project does not match the current local project. Choose again.'],
    DRIVE_HASH_MISMATCH: ['云端变更未通过完整性校验，尚未应用。请重新传输。', 'Cloud changes failed integrity verification and were not applied. Transfer again.'],
    SYNC_SESSION_STALE: ['项目已切换，已停止旧项目的同步操作。', 'The project changed. The previous sync operation was stopped.'],
    SYNC_INPUT_CHANGED: ['保存期间出现新输入，请保存后再同步。当前输入已保留。', 'New input arrived while saving. Save again before syncing. Your input is retained.'],
    SYNC_PROJECT_BUSY: ['请先结束当前创作任务，再同步这部作品。', 'Finish the current creative task before syncing this project.'],
    SYNC_ACTIVE_OPERATION: ['另一个项目任务正在运行，请完成后重试。', 'Another project task is running. Finish it and retry.'],
  }
  const message = messages[code] ? text(...messages[code]) : text('云端操作未完成，本地作品已保留。可使用下面的错误码排查后重试。', 'The cloud operation did not complete. Your local book is retained. Use the error code below to diagnose and retry.')
  return `${message} (${code})`
}

