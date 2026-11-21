# Android 构建

安卓独立正式版从 1.0.0 开始，基于 1.4.7 的业务代码。最低 Android 11（API 30），目标 API 35。安卓版本、包名和公开签名指纹保存在 `android/release.json`，1.0.0 的 versionCode 为 1000000。

## 环境与命令

- Node 与 pnpm，先在项目根目录执行 `pnpm install --frozen-lockfile`。
- JDK 17，设置 `JAVA_HOME`。
- Android SDK：`platforms;android-35`、`build-tools;35.0.0`，设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT`。
- 使用仓库内 Gradle 8.11.1 Wrapper、Android Gradle Plugin 8.9.2；第一次构建需要下载构建依赖。Wrapper 分发包设置了 SHA-256 校验。

在项目根目录执行：

```powershell
$env:JAVA_HOME = 'C:\path\to\jdk-17'
$env:ANDROID_HOME = 'C:\path\to\android-sdk'
pnpm run typecheck:android
pnpm run build:android
```

脚本以隐藏进程调用 Java，不要求安装全局 Gradle。默认将 Gradle 缓存及 Android 用户目录放在仓库忽略的 `.runtime/` 内，也尊重显式 `GRADLE_USER_HOME`、`ANDROID_USER_HOME`。

开发包输出到 `android/build/outputs/apk/debug/`，包名为 `io.github.fvb183.ainoveleditor.dev`。

### 签署安卓正式包

`pnpm run build:android:release` 构建前端、签署 APK 并核对最终产物。正式包位于 `android/build/outputs/apk/release/`，包名为 `io.github.fvb183.ainoveleditor`。后续正式更新沿用此包名和签名，递增安卓版本。

签名目录使用 `AI_NOVEL_ANDROID_RELEASE_SIGNING_DIR` 指定。云端开发工作区默认读取仓库旁的 `.private/ai-novel-editor/android-release/`。在授权构建机上分别提供加密 PKCS12 文件 `release.p12` 和口令文件 `store-password`，密钥别名为 `android-release`。先运行 `node scripts/build-android.mjs --release --check-signing` 可验证签名身份。Gradle 会拒绝证书与基线不符的正式构建。

## 本地验证

```powershell
pnpm run prepare:native-node
pnpm run test:android:unit
pnpm run test:android:backend
pnpm run build:android:web
pnpm run test:android:browser
```

`test:android:unit` 顺序运行文件适配、路径身份、共享向量运行时、流适配四套独立 Vitest 配置；每套使用独立进程。默认桌面 `pnpm test` 不收集 `mobile/tests/`，Android 测试由此入口执行。

归档专项保留独立配置：

```powershell
pnpm exec vitest run --config mobile/vitest-archive.config.ts
```

归档专项包含文件符号链接拒绝测试。当前 Windows 宿主缺少创建文件符号链接的权限，该项环境前置操作失败，原测试和断言保持不变；四套 unit 通过不代表归档专项全量通过。

后端测试在独立临时项目里运行真实业务层，并以 Node 文件系统、SQLite 和密码库实现 AndroidBridge 协议。浏览器测试加载实际 `mobile-dist`，默认使用 Windows 已安装的 Chrome；可用 `AI_NOVEL_VITEST_CHROMIUM` 指定可执行文件。报告明确标注 `deviceTest: false`，不代表 Android Java 桥或真机验收。

测试夹具会使用 Node 原生 SQLite 模块。若随后运行桌面 Electron，应先执行 `pnpm run rebuild:electron`，使 `better-sqlite3` 匹配 Electron ABI。

原生权限、系统文件选择器、中文输入法、低内存回收、真实网络和覆盖安装仍需 Android 设备验证。详细阶段状态见 [开发记录](../docs/development/dual-platform-progress.md)。
