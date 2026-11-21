# Android 宿主

与桌面共用 React、领域逻辑和项目格式；本地文件、SQLite、HTTP 和 Google 授权通过应用私有的原生桥处理。普通离线写作不要求 Google 登录。

## Google Drive 授权

使用 `com.google.android.gms:play-services-auth:22.0.0` 的 `AuthorizationClient`，权限固定为 `https://www.googleapis.com/auth/drive.file`。Google Play 服务维护本机账户及授权缓存；应用不把令牌、账户配置写入小说或同步记录。

异步原生操作（通过 `mobile/bridge.ts` 的 `nativeRequest`）：

| 操作 | 参数 | 结果 |
| --- | --- | --- |
| `google.status` | 无 | `{ available, authorized? }`，不返回令牌；重启后尚未验证授权时省略 `authorized` |
| `google.authorize` | `{ interactive: boolean }` | `{ accessToken }`；Google API 未承诺精确有效期，因此不猜测 `expiresAt` |
| `google.invalidate` | 无 | 清除当前访问令牌缓存，保留授权，供 401 后重新取得令牌 |
| `google.cancel` | 无 | 取消正在等待的操作；原操作返回 `GOOGLE_AUTH_CANCELLED`，晚到的结果不生效 |
| `google.disconnect` | 无 | 向 Google 撤销访问并清除本机缓存；网络失败会报错，不把失败显示成已撤销 |

只有显式连接时传入 `interactive: true`。静默同步传入 `false`，需要授权时返回 `GOOGLE_AUTH_REQUIRED`，不自动打开账户选择器。缺少 Google Play 服务返回 `GOOGLE_PLAY_SERVICES_UNAVAILABLE`；OAuth 包名/签名配置错误返回 `GOOGLE_OAUTH_CONFIGURATION_REQUIRED`。

旧云端作品使用旧 OAuth 客户端所在 Google Cloud 项目的 Drive API。请在同一项目添加 Android OAuth 客户端，保留旧客户端。1.0.0 正式包的包名为 `io.github.fvb183.ainoveleditor`，证书 SHA-1 为 `A3:F1:7F:7F:FA:12:AA:F1:4E:5E:F7:FD:A2:AA:89:4E:B8:C5:E8:D4`。开发包 `io.github.fvb183.ainoveleditor.dev` 使用单独的客户端。应用会通过 Google Play 服务申请授权。

官方参考：[Android 授权](https://developer.android.com/identity/authorization)、[OAuth 令牌撤销](https://developers.google.com/identity/protocols/oauth2/native-app#tokenrevoke)。

本机需要持久保存的续传会话地址等敏感全局状态，经 `secureStorage.available/encrypt/decrypt` 使用 Android Keystore AES-256-GCM 加密；每次加密随机 IV、版本封装及应用专属认证上下文。密钥不导出，也不要求额外的解锁弹窗。解密失败不会退回明文。Google 访问令牌仍由 Google Play 服务缓存，不改用项目文件保存。

## 构建与校验

需要 JDK 17、Android SDK platform 35 / build-tools 35.0.0。设置 `JAVA_HOME`、`ANDROID_HOME`，构建前先生成 `mobile-dist`。`scripts/build-android.mjs` 使用固定校验的 Gradle wrapper；输出位于 `android/build/outputs/apk/`。1.0.0 可与 1.4.x 并存，后续正式更新须沿用 1.0.0 的签名。详见 [签名与打包说明](BUILD.md)。

为开发包指定签名时，可使用 `AI_NOVEL_ANDROID_DEBUG_KEYSTORE` 和 `AI_NOVEL_ANDROID_EXPECTED_DEBUG_CERT_SHA1`。正式包的密钥和公开指纹由独立的发布配置管理。

`node scripts/verify-android-artifact.mjs <APK路径>` 检查 APK 签名、包名、版本，以及包内每一份 Web 资源是否与当前 `mobile-dist` 完全一致，报告写入 `.runtime/android-delivery-report.json`。

APK 编译、静态校验或浏览器模拟不能证明真实手机输入法、键盘、系统文件选择器或 Google 授权已经通过。真机结果单独记录。
