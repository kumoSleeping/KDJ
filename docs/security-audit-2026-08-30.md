# KDJ 发布前安全审计报告

> 历史快照：本报告记录整改前状态。15 项问题的最新处置、验证和发布判断见
> [security-remediation-2026-08-30.md](security-remediation-2026-08-30.md)。

- 审计日期：2026-08-30
- 审计对象：当前工作区 `/Users/kumo/git/kdj`
- 当前提交：`508a7cd`（`main`）
- 有效架构：Rust + Tauri；已按仓库规则排除 Electron 与 Python sidecar 历史代码
- 结论：**NO-GO，暂不建议发布**

## 1. 执行摘要

本轮快速审计从 Rust/Tauri 服务边界、前端与 WebView、依赖供应链、会话与密钥、Android、CI/CD、安装包签名和版本发布规则等方面并行展开。确认结果如下：

| 级别 | 数量 | 发布判断 |
| --- | ---: | --- |
| P1 高危/阻断 | 3 | 发布前必须修复，或明确移除受影响平台/功能 |
| P2 中危 | 9 | 建议在本次发布前修复；至少应完成风险接受与补偿控制 |
| P3 低危/条件性风险 | 3 | 可排期，但应建立跟踪项 |

最重要的三个阻断项是：

1. 本地 HTTP/WebSocket 控制面没有认证，同时允许任意 CORS；网页、扩展、WebView 注入或本地低权限进程可能读取库数据、修改设置、触发下载、删除实际媒体文件、扫描/注册目录、退出应用等。
2. “导出 CLI Skill”会递归删除名为 `kdj` 的既有目录；如果用户选择当前仓库目录，代码会删除整个项目目录。
3. Android Activity 重建时会重复初始化 `ndk_context`；依赖要求全进程只初始化一次，第二次可能 panic，而 release 配置为 `panic = "abort"`，会直接终止进程。

依赖扫描未发现 npm 或 Cargo 中已登记的普通漏洞，但这不覆盖上述一方代码缺陷。当前版本仍是 `0.2.44`，与最新标签 `v0.2.44` 相同，也不满足仓库“新版本必须高于最新标签”的发布规则。

## 2. 审计范围与方法

已执行：

- 静态检查 Rust/Tauri 路由、文件操作、进程边界、JNI、WebView CSP、远程脚本执行与前端调用链。
- 检查 npm 与 Cargo 依赖漏洞、签名/证明、弃用与不安全告警。
- 扫描当前跟踪文件及可达 Git 历史中的常见密钥、令牌、私钥、证书、会话与环境文件模式。
- 检查 GitHub Actions 权限、Action 固定方式、秘密暴露范围、签名校验、版本门禁与发布脚本。
- 执行前端构建、Rust workspace 检查和测试。

限制：

- 为避免数据损失，没有实际触发递归删除、媒体删除等破坏性路径。
- 未在真实 Android 设备上执行 Activity 重建复现；Android 问题由调用链和依赖契约静态确认。
- 未用正式发布证书执行 Apple notarization、Windows Authenticode 或 Android 证书指纹端到端验证。
- 这是面向快速发布决策的高覆盖审计，不等同于完整渗透测试或形式化安全证明。

## 3. P1：发布阻断项

### SEC-001 本地 HTTP/WebSocket 控制面无认证且 CORS 全开放

**影响：高；桌面与 Android 共用服务边界；可导致数据泄露、设置篡改、文件删除与应用控制。**

证据：

- `crates/kdj-server/src/lib.rs:31-68` 注册全部路由和 `/ws`，并设置 `allow_origin(Any)`、`allow_methods(Any)`、`allow_headers(Any)`，未安装认证中间件。
- `crates/kdj-server/src/ws.rs:12-33` 未校验 token 或 `Origin` 即升级 WebSocket。
- `src-tauri/src/lib.rs:120-124` 的 `BridgeInfo` 只返回 `base_url` 和平台；`src-tauri/src/lib.rs:1345-1363` 仅依赖随机 loopback 端口，没有生成会话密钥。
- `src/lib/api.ts:98-119` 与 `src-tauri/src/cli/http.rs:14-63` 发起请求时都没有认证信息。
- `src-tauri/src/cli/runtime.rs:14-37` 持久化 PID、版本和地址，没有认证秘密，也没有强制 `0600`。
- `crates/kdj-server/src/routes.rs:213-222` 的健康接口泄露绝对数据/下载目录；`routes.rs:233-239` 可退出应用。
- `crates/kdj-server/src/routes.rs:3478-3501`、`3515-3558` 可直接或批量删除记录；当 disposal 为 Remove 时，`crates/kdj-library/src/service.rs:1441-1450` 会调用 `remove_file` 删除实际文件。
- `crates/kdj-server/src/routes.rs:4633-4706` 可扫描并注册任意已存在目录；`routes.rs:4858-4884`、`4966-4997` 可读取本地音视频内容。

可行攻击链：探测随机端口 → 调用 health 识别 KDJ 并获取路径 → 枚举/修改库数据 → 扫描目录或删除媒体 → 退出应用。浏览器 Private Network Access 在部分场景可能增加预检限制，但它不是服务端认证；浏览器扩展、本地进程、WebView/XSS 场景仍然不受其可靠保护。

修复要求：

1. 启动时生成至少 256-bit 随机会话 token；HTTP 和 WebSocket 使用同一认证策略，并在首次升级前校验。
2. renderer 与 CLI 必须安全携带 token；不要把随机端口当作秘密。
3. 对 `<audio>/<video>` 等不便加 Header 的请求使用短时、单资源、单用途签名票据。
4. CORS 与 WebSocket `Origin` 改成精确 allowlist；health 不返回绝对路径。
5. destructive API 使用独立 capability，并增加用户确认、范围限制和审计日志。
6. runtime/session 目录强制 `0700`，文件强制 `0600`，并迁移已存在文件权限。

### SEC-002 导出 CLI Skill 可递归删除任意名为 `kdj` 的既有目录

**影响：高；可造成整个仓库或用户目录不可恢复的数据丢失。**

证据：

- `src-tauri/src/lib.rs:778-791` 的 Tauri command 接收 renderer 传入的任意目录。
- `src-tauri/src/cli/skill.rs:68-85` 在所选目录本身名为 `kdj` 时，把该目录直接作为目标；目标存在即执行 `remove_dir_all`，之后只重新创建目录并写入 `SKILL.md`。
- `src/components/settings/SettingsPanel.tsx:495-565` 允许用户通过原生目录选择器传入任意路径。

当前仓库根目录正是 `/Users/kumo/git/kdj`。如果在该功能中选择它，现有逻辑会递归删除整个仓库。本轮没有进行破坏性动态复现。

修复要求：

1. 禁止对用户选择的未知目录执行 `remove_dir_all`。
2. 仅覆盖 KDJ 自己管理的文件，并使用不可伪造/明确的 marker 和严格文件 allowlist。
3. canonicalize 后拒绝仓库、Home、磁盘根目录、非预期父目录及含未知内容的目录。
4. 先写入同父目录 staging，再原子替换受管文件；必要时使用可恢复备份或废纸篓。
5. 对任何会覆盖既有内容的操作给出准确确认，界面展示最终 canonical path。

### SEC-003 Android Activity 重建会重复初始化 `ndk_context`

**影响：高；Android 可稳定触发崩溃/进程终止。若本次不发布 Android，可将其转为平台发布阻断。**

证据：

- `src-tauri/gen/android/app/src/main/java/com/kdj/app/MainActivity.kt:19-33` 在每次 `onCreate` 中加载库并调用 `initNdkContext(this)`。
- `src-tauri/src/lib.rs:1401-1439` 每次 JNI 调用都先执行 unsafe `ndk_context::initialize_android_context`，之后才尝试设置项目自己的全局值。
- `Cargo.toml:22-30` 将 release panic 策略设置为 `abort`。

`ndk_context` 文档明确要求初始化函数必须在 `main` 前后只调用一次；当前实现没有把依赖调用放在一次性门禁内。Activity 因配置变化、系统回收或生命周期重建后，第二次调用可能 panic 并跨 JNI 终止进程。[ndk-context 0.1.1 文档](https://docs.rs/ndk-context/0.1.1/ndk_context/fn.initialize_android_context.html)

修复要求：使用进程级 once gate 包住依赖初始化；一次性 native context 应优先使用 Application context，当前 Activity 引用另行维护和安全更新；不得让 panic 穿过 JNI。修复后必须在真机或模拟器覆盖旋转、后台恢复、Activity recreate 与冷启动。

## 4. P2：中危问题

### SEC-004 NetEase 与 QQ Music 会话文件权限不安全

- `crates/kdj-providers/src/netease/client.rs:41-58`、`122-140` 保存包含 `MUSIC_U`/CSRF 的会话，但只写入并 rename，没有设置权限。
- `crates/kdj-providers/src/qqmusic/client.rs:30-60`、`250-267` 保存 access/refresh token、musickey/refresh_key，同样没有设置权限。
- 当前本机对应两个 session 文件实际权限为 `0644`；Bilibili、YouTube Music、SoundCloud 的相邻实现已使用 `0600`，可作为修复参考。

建议：目录 `0700`；临时文件创建时即为 `0600`，再原子 rename；启动时迁移既有权限；Windows 使用仅当前用户可读 ACL。

### SEC-005 主 WebView 执行远程 JavaScript，CSP 同时允许 `unsafe-eval`

- `src-tauri/tauri.conf.json:35-37` 的生产 CSP 允许 `script-src 'unsafe-eval'`。
- `src/lib/youtubePoToken.ts:60-92` 将远端挑战内容交给 `new Function(...)()`。
- `src/lib/youtubePlayer/player.ts:36-41` 会执行从 YouTube player script 提取出的代码；`src/lib/youtubePlayer/JsExtractor.ts:345-353` 向其暴露真实的 `global/window/document/self`。
- `src/lib/bridge.ts:60-64` 表明同一个主 renderer 能调用 Tauri IPC。
- 后端对 player URL 有严格的官方 `https://*.youtube.com/s/player/**/base.js` 约束（`crates/kdj-providers/src/youtubemusic/client.rs:612-627`），降低了任意源风险，但不能消除上游内容被利用后进入高权限 WebView 的后果。

当前 CSP 的 `connect-src` 又没有放行 YouTube，`src/lib/api.ts:70-85` 的 BotGuard 直连在生产中很可能被 CSP 阻止；这意味着该路径当前更可能表现为功能回归，而非已确认可利用链。player script 经本地后端取得的 eval 路径仍存在。

Tauri 官方建议尽量严格限制 CSP，并把远程内容视为攻击面。[Tauri CSP 指南](https://v2.tauri.app/security/csp/)

建议：不得在拥有 Tauri IPC、本地 API、localStorage、DOM 与通用网络权限的主 WebView 中 eval 远端代码。迁移到无 IPC、无本地 API、无持久存储、网络受限的隔离进程/Worker/WebView，或实现严格 AST/操作码解释器；完成隔离后移除 `unsafe-eval`。发布前必须用生产包人工验证 YouTube Music 登录与播放。

整改状态（2026-08-30）：主 renderer 的远程动态执行与生产 `unsafe-eval` 已移除。普通 YouTube 已改为唯一的官方 embed 子 WebView，并在首次远程导航前移除 Tauri user script/IPC，使用非持久数据存储且不导入浏览器登录 Cookie；它不再自行生成普通视频 proof、解析 `s`/`n` 或代理 GoogleVideo。YTM 必需的 WebPO/player 变换进入另一无 Cookie、无 IPC、网络受限的隐藏原生 WKWebView。最终 macOS 静音 E2E 已连续通过普通视频冷播、seek、两视频切换、热播与 YTM AAC；生产签名包仍应在发布负责人配置正式凭据后再做一次人工 smoke test。

### SEC-006 tag 发布允许 Rust 测试失败，且 CI 未运行前端逻辑测试

- `.github/workflows/rust-build.yml:126-145` 对测试使用 `continue-on-error`；main 会在后续失败，但 tag 仅警告并继续。
- `.github/workflows/rust-build.yml:147-151` 只执行安装和 typecheck，未运行 `package.json` 已定义的 `test:frontend-logic`。
- `scripts/release.sh:86-95` 运行 typecheck、web build 与 Cargo 测试，但同样未运行前端逻辑测试。

建议：tag 与 main 都必须 hard-fail；真正 flaky 的测试应被单独隔离并明确审批。把前端逻辑测试、web build、npm audit、cargo audit 纳入不可绕过的 release gate。

### SEC-007 CI 权限、第三方 Action 与签名身份校验过宽

- `.github/workflows/rust-build.yml` 多个 job 使用 `contents: write`，同时使用未固定到完整 commit SHA 的第三方 Action。
- `.github/workflows/rust-android.yml:149-164` 把 Android 签名秘密写入 `$GITHUB_ENV`，使其对后续所有步骤和 Action 持续可见。
- release workflow 主要检查秘密非空；桌面 updater 只检查 `.sig` 存在，Android `apksigner verify` 只证明“由某证书签过”，没有断言预期证书 SHA-256 指纹。

建议：所有 Action 固定完整 SHA；build job 默认 `contents: read`，只有 publish job 获得写权限；build/sign/publish 分离；签名秘密只注入签名步骤并立即清理；用内嵌 updater 公钥实际验证发布产物，并断言 Android 证书指纹。

### SEC-008 首次安装包缺少平台原生可信签名

- `.github/workflows/rust-build.yml:176-188` 明确使用 Apple ad-hoc 签名 `APPLE_SIGNING_IDENTITY: "-"`，没有 Developer ID 与 notarization。
- `src-tauri/tauri.conf.json:62-84` 未发现 Windows Authenticode 配置。

updater 的 minisign 能保护应用内更新，但不能替代用户第一次下载 DMG/EXE/MSI 时的操作系统信任链。建议正式配置 Apple Developer ID + notarization、Windows Authenticode；在完成前至少发布独立签名校验值和清晰验证说明，并明确风险接受。

### SEC-009 Android 全局允许明文 HTTP

- `scripts/android-postinit.sh:34-51` 将 Manifest 的全局 `usesCleartextTraffic` 从 false 改成 true；注释声称存在 token/auth 保护，但当前服务并无对应实现。
- `crates/kdj-providers/src/net.rs:176-189` 的远程媒体 URL 校验同时允许 `http` 与 `https`。

因此明文放行不只覆盖 `127.0.0.1`，远程 HTTP 媒体也可遭中间人篡改。建议使用 Android Network Security Config，仅对 loopback 域例外，所有远程资源强制 HTTPS。

### SEC-010 封面代理在重定向后才校验目标，形成 blind SSRF 窗口

- `crates/kdj-server/src/routes.rs:552-580` 只校验初始 host；reqwest 默认自动跟随最多 5 次重定向，最终 host 是请求已经发出后才检查。

若允许域存在开放重定向，服务可能先向私网或 metadata 地址发送请求，再拒绝最终结果。建议关闭自动重定向，逐跳校验 scheme、host 和解析后的 IP，拒绝 loopback/link-local/private/metadata 地址，并处理 DNS rebinding/TOCTOU。

### SEC-011 登录二维码 IPC 未限制体积与 PNG 结构

- `src-tauri/src/lib.rs:363-404` 接受 renderer 提供的 base64 data URL，没有限制编码/解码尺寸，也没有验证 PNG magic、图像尺寸或像素上限，直接写固定文件。

renderer 被攻陷时可造成内存/磁盘 DoS，或写入伪装成 PNG 的任意字节。建议在解码前后分别限长，校验 magic，并用安全解码器限制宽高、像素数和压缩炸弹，最后原子写入。

### SEC-012 CI 版本门禁不保证版本严格递增

- `.github/workflows/release.yml:63-81` 只校验版本形状及同名 tag 不存在，没有比较最新 `v*` 标签。
- `scripts/release.sh:50-58` 有严格递增检查，但直接 push main 可以绕过本地脚本。

建议把版本严格递增比较放进 CI release gate，且以远端最新 release/tag 为准。

## 5. P3：低危与条件性风险

### SEC-013 Cargo 依赖存在 unsound 与停止维护告警

`cargo audit` 未发现普通漏洞，但报告：

- `glib 0.18.5` 命中 `RUSTSEC-2024-0429`，影响范围 `>=0.15,<0.20`，修复版本为 `>=0.20`。这是 `VariantStrIter` 的 unsound/潜在 UB 告警。[RustSec advisory](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
- 另有 19 个停止维护告警。

当前 `glib` 经 Linux GTK/Tauri 依赖链进入，项目中未发现直接调用相关 API，因此暂定为条件性 Linux 风险。建议升级 Tauri/GTK 依赖链，并在 Linux 构建与运行测试后关闭该项。

### SEC-014 Android 包含疑似未使用的原生 ML 运行时与不完整 notices

`scripts/android-postinit.sh:101-180` 下载并注入 ExecuTorch Vulkan 1.0.1、SoLoader、fbjni；当前 stems 实现已声明为 model-free Classical Redress。实际 APK 中仍可见约 19.7 MB 的 `libexecutorch.so`，扩大了包体、native 攻击面和许可证维护范围，而 `THIRD_PARTY_NOTICES.md` 未提供与这些精确版本匹配的完整说明。

建议：确认无运行时引用后删除；如保留，记录精确版本、许可证、notice/源码提供义务并纳入 CVE 审计。项目为非商业用途不代表可以忽略归属、share-alike 或再分发条款。

### SEC-015 WebView/IPC 防御纵深不足

主 CSP 缺少更完整的 `object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`、`form-action` 等限制；`open_path`、`reveal_in_file_manager`、`start_file_drag` 等 IPC 信任 renderer 路径（`src-tauri/src/lib.rs:147-198`）。这些单独看不是已确认漏洞，但会放大 renderer/XSS 被攻陷后的能力。建议增加 IPC scope、canonical path allowlist 与 CSP 基线。

## 6. 依赖、密钥与构建验证结果

| 检查 | 结果 |
| --- | --- |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` | 0 vulnerabilities |
| npm registry signatures | 143 个包签名验证通过，43 个 attestations |
| `cargo audit` | 0 个普通漏洞；1 个 unsound、19 个 unmaintained 告警 |
| 当前文件与可达 Git 历史密钥扫描 | 未发现私钥、GitHub token、云访问密钥、密码、`.env`、keystore/cert 或真实 session cookie 被提交 |
| `npm run tauri:web:build` | 通过；只有 chunk/dynamic-import 警告 |
| `cargo check --workspace --all-targets` | 通过；只有 dead-code 警告 |
| `cargo test --workspace --lib --bins --tests` | 通过；未见失败测试 |
| `git diff --check` | 通过 |

代码中的 Google `AIza...` 常量属于公开的 YouTube/Innertube 客户端标识，不应误报为 KDJ 的特权后端密钥；仍建议记录来源和允许用途。更新端点使用 HTTPS，并配置了 updater 公钥，这是现有的正向控制。

## 7. 当前发布状态额外阻断

这些不是漏洞，但会直接阻止或污染发布：

1. `package.json`、`package-lock.json`、workspace `Cargo.toml`、`Cargo.lock` 与 `src-tauri/tauri.conf.json` 当前均为 `0.2.44`；最新标签也是 `v0.2.44`，版本没有递增。
2. 工作区当前共有 304 个状态项：159 modified、115 deleted、30 untracked。`scripts/release.sh:40-43` 会拒绝 dirty worktree。
3. 大量未提交改动属于当前用户工作，本轮审计没有修改、清理或覆盖这些改动。

## 8. 最短安全发布路径

### 若发布所有平台

1. 修复 SEC-001、SEC-002、SEC-003，并为三项补充回归测试。
2. 修复 SEC-004、SEC-006、SEC-007、SEC-009、SEC-010；对其余 P2 明确风险接受人和截止日期。
3. 将版本同步提升到高于 `0.2.44`，清理并审阅工作区，确保发布提交可复现。
4. 重新执行 npm/Cargo 审计、前端逻辑测试、typecheck、Tauri web build、Cargo workspace check/test。
5. 使用正式证书验证 macOS notarization、Windows Authenticode、Android 预期证书指纹和 updater 签名。
6. 做生产包 smoke test：本地 API 鉴权、WebSocket、音视频播放、文件删除确认、CLI、YouTube Music、Android Activity recreate。

### 若必须先发布桌面版

仍必须先修复 SEC-001 与 SEC-002。可以暂时停止生成/发布 Android 产物，并把 SEC-003、SEC-009 标为恢复 Android 发布前的硬门禁；这不影响桌面端对会话权限、远程 JS 执行、CI 和安装包签名风险的处理要求。

## 9. 最终结论

**当前不满足发布条件。** 即使 npm/Cargo 已知漏洞为零、构建和测试均通过，无认证控制面与递归目录删除仍是可直接影响用户数据和本机文件的高危缺陷；Android 还存在生命周期可触发的进程终止问题。建议至少完成 P1 修复和验证后再做一次针对性复审，再决定 Go/No-Go。
