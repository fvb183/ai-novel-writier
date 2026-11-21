# AI小说编辑器 · AI Novel Editor

本仓库是基于 [AI Novel Writer](https://github.com/EthanYoQ/AI-Novel-Writer) 的定制开发版本，面向 Windows 和 Android 的本地小说创作与跨设备同步。遵循仓库内的 GNU GPL v3 许可证；保留原作者及第三方字体等组件的版权说明。

**已验收基线：1.4.5（2026-11-16）。** 用户已确认旧项目兼容、手机章节蓝图、模型/API 配置同步、能力声明识别、软件名称和精简同步行为。原始验收记录见 [验收说明](docs/development/2026-11-16-v145-user-acceptance.md) 和 [包哈希记录](docs/development/2026-11-16-v145-user-acceptance.json)。后续安卓 UI 修复以此版本为起点，单独提交。

**安卓独立正式版 1.0.0** 基于 1.4.7，后续安卓更新从此版本开始。 修复定稿正文和模型设置相同时误报来源变化的问题。此前卡在“章节剧情要点”的本机章节，重新打开后会核对原定稿记录。核对通过即可点击“重试失败步骤”，补完后继续写下一章。PC 端是否有同样现象待确认，Windows 验收版本为 1.4.5。

安卓 **1.4.6** 的变更：恢复稿提示随页面滚动，支持确认后持久删除恢复稿；修正剧情树/详情的滚动绘制边界；连续生成后的“已生成”完成提示只保留最新一条并按时消失；打开“本次写作选项”或架构指导时清除旧完成条目，编辑期间新完成提示也不会盖住表单，关闭后恢复正常。说明及验证边界见 [本轮变更](docs/development/2026-11-16-android-ui-146.md)。Windows 继续使用已验收的 1.4.5 安装包，1.4.5 固定在 `accepted/v1.4.5-20261116` 标签；本轮候选不覆盖该基线。

## 当前功能

- 本机保存小说正文、章节蓝图、设定、知识原文及主线/支线剧情树。
- Windows / Android 使用同一 Google 账户同步作品；增量传输，自动清理旧同步历史和无引用资产，不保留完整正文恢复链。
- 手动保存及返回前台保存后同步，无 15 秒自动轮询。
- 设置内可显式上传、读取预览及应用模型/API 配置，无需打开作品；API Key 随配置传递，预览不显示 Key。Google 授权和网络代理保留各端。
- 能力信息采用接口声明、精确官方模型目录或手动值；接口没有声明不等于模型不支持，不按中转别名猜测能力。

## 本地开发

需要 Node.js 22.14 或更新版本，以及与 `package.json` 一致的 pnpm。依赖版本固定在 `pnpm-lock.yaml`。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run dev
```

Android 需要 JDK 17、Android SDK platform 35 和 build-tools 35.0.0。参见 [Android 构建说明](android/BUILD.md)。

```sh
pnpm run typecheck:android
pnpm run build:android
```

桌面构建、浏览器测试和专项测试命令见 `package.json`。源码包含 Gradle Wrapper、图标、字体和合成测试夹具，不包含依赖目录、已编译安装包、用户小说、API Key、Google 授权、个人安装位置、私有签名或本地运行时数据。复制代码并不会复制现有应用的账户或资料。

## 版本与发布

应用显示名称为 **AI小说编辑器**。安卓 1.0.0 的独立包名为 `io.github.fvb183.ainoveleditor`，与 1.4.x 各有自己的本地书架。迁移时保留旧安装，在新应用中用原 Google 账号读取同步作品，或导入可访问的项目归档。云端读取需要在旧 Google Cloud 项目登记新包的签名。详见 [安卓配置](android/README.md) 和 [正式包构建说明](android/BUILD.md)。

继承的正式发布工作流只通过手动调度运行，部分上游发布目标及旧版本验证配置尚未改成此定制仓库。上传源码不会自动发布安装包；在准备自己的发行版前，应明确配置发布目标和签名，使用 `--publish never` 进行本机构建。
