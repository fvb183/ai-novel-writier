# Android 构建

本分支把 Java WebView 宿主接到官方 1.3.0 共享业务层。最低 Android 11（API 30），目标 API 35。版本从根目录 `package.json` 读取；`1.3.0` 对应 versionCode `1003000`。

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

调试 APK 输出目录：`android/build/outputs/apk/debug/`。调试包 ID 为 `io.github.ethanyoq.ainovelwriter.dev`，可与原应用并存，数据目录独立。构建脚本不会安装 APK，也不会修改原应用。

发布候选的未签名产物：

```powershell
pnpm run build:android:web
node scripts/build-android.mjs --release
```

输出目录为 `android/build/outputs/apk/release/`。正式包 ID 保持 `io.github.ethanyoq.ainovelwriter`；覆盖原安装前必须核对原签名和迁移结果。本仓库不包含正式签名材料，也不自动签名或安装发布包。

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
