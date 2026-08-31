# KDJ 发布前安全整改报告

- 整改日期：2026-08-30
- 工作区：`/Users/kumo/git/kdj`
- 基线提交：`508a7cd`（`main`，整改尚未提交）
- 有效架构：Rust + Tauri；未运行或修复已退役的 Electron/Python runtime
- 候选版本：`1.0.0-rc1`（按正式全量更新发布）；远端最新标签：`v0.2.44`
- 结论：**原审计的 15 项问题均已完成代码整改；桌面发布为 Conditional GO，Android 发布仍需环境验收。**

## 1. 执行摘要

整改覆盖了本地控制面鉴权、文件系统边界、Android 生命周期、会话秘密、远程脚本执行、SSRF、CI/CD、安装包签名、版本门禁、依赖不安全告警与 WebView 防御纵深。

原始审计的 3 个 P1、9 个 P2、3 个 P3 均已有代码处置。合并冷启动时额外发现媒体 capability 会出现在封面下载错误日志中，该问题也已脱敏并增加回归测试。

当前自动化结果为 npm 0 个已登记漏洞、Cargo 0 个已登记普通/unsound 漏洞。Cargo 仍报告 19 条停止维护提醒；它们主要来自 Tauri/GTK 上游链，不代表当前已确认漏洞，但需要随框架升级继续消减。

## 2. 逐项整改状态

| 编号 | 原问题 | 状态 | 主要处置 |
| --- | --- | --- | --- |
| SEC-001 | 本地 HTTP/WebSocket 无认证 | 已修复 | 启动时生成相互独立的 256-bit 控制 bearer 与媒体 capability；HTTP、CLI、renderer、WebSocket 全部接入；CORS/Origin 精确限制；health 隐藏绝对路径；runtime 目录/文件分别为 0700/0600。媒体 query capability 仅限明确的 GET/HEAD 音频、视频、封面和预览路由。 |
| SEC-002 | Skill 导出递归删除既有目录 | 已修复 | 移除 `remove_dir_all`；只写 `kdj/SKILL.md` 受管文件；拒绝相对根目录；选择本身名为 `kdj` 的目录也不会删除其内容。 |
| SEC-003 | Android 重复初始化 `ndk_context` | 代码已修复，待设备验收 | Kotlin `AtomicBoolean` 与 Rust `OnceLock` 双门禁，使用 Application Context，JNI 返回明确状态。 |
| SEC-004 | NetEase/QQ 会话文件权限过宽 | 已修复 | 新增统一私密会话写入：目录 0700，临时/既有文件 0600，创建时限权、同步后原子替换。 |
| SEC-005 | 高权限 WebView 执行远程 JavaScript | 已修复（隔离恢复功能） | 主 renderer 删除 BotGuard/player 动态执行并移除生产 CSP 的 `unsafe-eval`。普通 YouTube 使用唯一的官方 embed 子 WebView：非持久、无浏览器登录 Cookie，且首次远程导航前移除全部 Tauri user script/IPC；不再生成普通视频 proof、解析 `s`/`n` 或代理 GoogleVideo。YTM 必需的 challenge 与窄化 player 变换只在无 Cookie、无 Tauri IPC、网络受限的隐藏原生 WKWebView 中运行，并继续使用唯一的隔离 WebPO + SABR 音频链。 |
| SEC-006 | tag 测试可失败、缺前端门禁 | 已修复 | tag/main Rust 测试硬失败；加入全部前端逻辑测试、生产 Web 构建、npm audit/签名与 cargo audit。 |
| SEC-007 | CI 权限/Action/签名校验过宽 | 已修复 | 所有 Actions 固定完整 SHA；构建 job 只读、发布 job 独立写权限；敏感材料只进入签名步骤并清理；updater、Android、macOS、Windows 均签后验证身份。 |
| SEC-008 | 首次安装包缺平台原生可信签名 | 流水线已修复，待凭据 | macOS 配置 Developer ID、notarization、stapling 与 Gatekeeper 验证；Windows 配置 Authenticode 与证书指纹验证。缺凭据会在创建 tag 前失败。 |
| SEC-009 | Android 全局允许明文 HTTP | 已修复 | 全局 `usesCleartextTraffic=false`；Network Security Config 仅给 `localhost`/`127.0.0.1` 回环例外；远程媒体强制 HTTPS。 |
| SEC-010 | 封面重定向 blind SSRF | 已修复 | 禁用自动重定向；每一跳校验 HTTPS、平台域名和解析后的公网 IP，并将校验结果固定到连接，最多 5 跳。短链与远程媒体路径采用同类公网地址限制。 |
| SEC-011 | 二维码 IPC 无体积/结构限制 | 已修复 | 编码和解码均限制 2 MiB；校验 PNG signature、chunk 顺序/CRC、IHDR 参数、最大 4096 边长、最大约 1677 万像素及完整 IEND。 |
| SEC-012 | CI 不保证版本严格递增 | 已修复 | CI 和本地发布脚本都要求语义化 `x.y.z[-suffix]` 且候选版本大于远端最新 `v*` 标签；五处版本已同步至 1.0.0-rc1。 |
| SEC-013 | `glib 0.18.5` unsound | 已修复 | vendored 精确上游源码并回补 `VariantStrIter` 指针修复，Cargo 通过 `[patch.crates-io]` 使用该版本；RustSec unsound 告警归零，notice 已记录。 |
| SEC-014 | Android 残留 ML runtime/notice 不完整 | 已修复 | post-init 主动清除 ExecuTorch、SoLoader、fbjni、StemRuntime、Gradle/AAR/ProGuard 残留；APK 上限降至 28 MiB；第三方说明同步更新。 |
| SEC-015 | WebView/IPC 防御纵深不足 | 已修复 | CSP 新增 `object-src/base-uri/frame-src/frame-ancestors/form-action` 限制；open/reveal/drag 路径 canonicalize 后只允许应用数据、下载、曲库、固定 skill 根或原生 picker 授权；拖出文件进一步限于曲库/下载根。 |

额外整改：桌面冷启动发现封面下载的 reqwest 错误会携带完整媒体 URL，从而把 `kdj_media_token` 写入日志。错误现只暴露状态/类别，测试明确断言 capability 和参数名不会出现在错误文本中。YTM SABR 的启动/后台 pump 失败也改为立即关闭同一 spool，并只保存固定类别或 HTTP 状态，不再把库 Error、GoogleVideo URL 或 proof 写入控制台和媒体错误状态。

## 3. 核心安全边界

### 本地服务

- 控制 bearer 只接受 `Authorization: Bearer`，不接受 query 参数。
- 媒体 capability 与控制 bearer 相互独立；只接受明确媒体路由的 GET/HEAD query 参数。
- WebSocket 通过专用子协议认证，并校验精确 Tauri Origin。
- production CORS 只允许 Tauri origins；本地 Vite origins 仅 debug 构建可用。
- capability 不派生 `Debug`，runtime 文件采用私密权限，错误日志不记录令牌 URL。

### 远程内容

- 主 WebView 不再执行 BotGuard/player 远程 JavaScript。普通视频只在移除 Tauri user scripts 与 IPC handler 的非持久官方 embed 子 WebView 中运行，且不读取浏览器 YouTube Cookie；YTM 的必要运算进入另一隔离的隐藏 WKWebView。
- 官方 embed 导航、YTM 播放器脚本和媒体 URL 都有 HTTPS 官方域名/路径白名单。
- 所有重定向逐跳复核；私网、loopback、link-local、metadata 和其他非公网地址均拒绝。
- Android 远程网络没有明文例外。

### 文件系统

- Skill 导出、Tauri open/reveal/drag、会话持久化和二维码缓存均限制了路径、权限或数据结构。
- 本轮未执行任何真实媒体删除或其他破坏性测试。

### 供应链与发布

- GitHub Actions 固定到完整 commit SHA，build/sign/publish 权限分离。
- updater minisign、Android 预期证书指纹、macOS Developer ID/notarization 与 Windows Authenticode 都有签后验证。
- Android 正式证书锚定现网 `v0.2.44` APK 的 SHA-256 指纹；秘密文件使用后清理。
- 版本已在 `package.json`、`package-lock.json`、workspace `Cargo.toml`、`Cargo.lock` 与 `src-tauri/tauri.conf.json` 同步为 1.0.0-rc1。

## 4. 合并后验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:frontend-logic` | 43 个前端测试套件全部通过；包含 YTM SABR 零自动重试不变量 |
| `npm run tauri:web:build` | 通过；仅既有 chunk/dynamic-import 提示 |
| `cargo test --workspace --lib --bins --tests` | 992 个测试通过，0 失败 |
| `cargo check --workspace --all-targets` | 通过；仅 dead-code 提示 |
| `cargo fmt --all -- --check` / `git diff --check` | 通过 |
| `npm audit --audit-level=low` | 0 vulnerabilities |
| `npm audit signatures` | 143 个 registry signatures、43 个 attestations 验证通过 |
| `cargo audit` | 0 个普通漏洞、0 个 unsound；19 个 unmaintained 提醒 |
| Workflow YAML、相关脚本语法与 Action ref 检查 | 通过；所有 `uses:` 均为完整 SHA |
| 当前跟踪文件与 v0.2.44 可达历史的强格式复核 | 未发现私钥、GitHub/云特权 token、真实 session cookie 或 QQ/YouTube 用户凭证；只命中已记录的公开 YouTube/Google client key |
| 版本/远端标签 | 1.0.0-rc1 严格高于远端最新 v0.2.44 |
| Tauri 完整停止后冷启动，再停止 | 通过；服务与窗口进程正常启动，退出后无残留开发进程 |
| capability 日志脱敏 | 冷启动实测只输出 HTTP 状态，不再输出 URL/token；5 个桌面媒体测试通过 |
| 官方 YouTube embed 单链路测试 | 前端 2 个不重试不变量与 Rust 2 个导航/边界测试通过 |
| macOS 静音真实播放 E2E | 冷播、seek、第二视频切换、热播与 YTM AAC 连续通过；普通视频冷播 3.089 秒可播放，切换/热播约 0.52 秒可播放 |

## 5. 仍需发布负责人完成的外部验收

这些项目不是可继续在仓库中“编造”完成的代码修复；发布门禁已设置为缺失即失败：

1. 使用 `scripts/configure-release-secrets.sh` 配置新的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，以及 Apple Developer ID/notarization、Windows Authenticode、Android 正式签名凭据。
2. 在具备 Android SDK/NDK（包括 `aarch64-linux-android-clang`）的 runner 上完成正式 Android 构建，并在真机/模拟器验证冷启动、旋转、后台恢复与 Activity recreate。当前机器因缺工具链无法完成这项环境验证。
3. 审阅并提交当前庞大的既有工作区改动。工作区仍为 dirty；`scripts/release.sh` 会按设计拒绝从未提交状态发布。本轮没有替用户清理、覆盖或提交无关改动。
4. 使用正式凭据跑一次完整发布 workflow，确认 Apple notarization、Windows Authenticode、Android 指纹和 updater `.sig` 的线上验证全部通过。

## 6. 功能兼容与已知风险

- 普通 YouTube 改为无登录 Cookie、无 Tauri IPC、无持久存储的唯一官方 embed 子 WebView，不再保留 direct DASH/MSE、proof/HLS 代理或备用 client。代价是仅支持官方允许匿名嵌入的公开视频，并接受官方品牌、广告和自适应策略。YTM 的 BotGuard/WebPO 与 player `s`/`n` 仍在另一隔离 WebView 中完成；通用直链入口已关闭，GoogleVideo 与 Rust 代理均不在失败后自动换请求/proof 重试。详见 [YouTube 播放链路与凭证风险结论](youtube-playback-security-2026-08-30.md)。
- Cargo 的 19 条停止维护提醒主要位于 Tauri/GTK 及宏工具上游依赖链。它们没有对应当前已登记漏洞，暂不作为本次安全阻断；后续升级 Tauri/GTK 时应继续清零。
- 本轮是高覆盖发布前扫描、整改与自动化回归，不等同于第三方渗透测试或形式化安全证明。

## 7. 最终发布判断

### 桌面版

**Conditional GO。** 代码层安全阻断已清除。必须先配置正式签名凭据、审阅并提交工作区、让加固后的 CI 全绿，才可创建 `v1.0.0-rc1` 标签并将其提升为面向全体用户的 Latest。

### Android

**暂时 NO-GO。** 代码修复和 CI 门禁已完成，但本机缺少 SDK/NDK，尚未完成 Android 构建与 Activity recreate 设备验收。该验证通过后可转为 GO。

### 不允许绕过的条件

- 不得关闭签名/验签、测试、依赖审计或严格递增版本门禁来赶发布。
- 不得在 dirty worktree 上直接发布。
- 不得重新启用主 WebView 的远程动态代码执行。
