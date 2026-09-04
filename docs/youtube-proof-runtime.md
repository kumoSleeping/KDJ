# YouTube proof/player 桌面统一方案

更新日期：2026-09-04

## 结论

macOS、Windows、Linux 统一使用 **Tauri 已经承载主界面的系统 WebView** 执行
YouTube BotGuard/WebPO 与官方 player 的窄化变换。KDJ 不再为 Windows/Linux
嵌入 Deno/V8，也不维护三套平台原生回调代码。

这不是“给应用再加一个 WebView 依赖”：Tauri 桌面应用本来就分别运行在 WKWebView、
WebView2 和 WebKitGTK 上。proof 运行器只是按需新建一个不可见、非持久的 Tauri
窗口，并复用 Tauri/Wry 已有的跨平台 JavaScript 回调适配。平台引擎映射见
[Tauri 进程模型](https://v2.tauri.app/concept/process-model/)与
[WebView 版本说明](https://v2.tauri.app/reference/webview-versions/)。

## 运行链路

1. 首次需要 proof 或 player 变换时，Rust 创建标签为
   `youtube-proof-runtime` 的 1×1 隐藏 incognito WebView。
2. WebView 只允许精确导航到 `https://www.youtube.com/robots.txt`，并拒绝新窗口。
   真实网络 origin 是 BotGuard 接受 proof 的必要条件；本地 HTML 伪造 base URL
   生成的 proof 会被 GVS 拒绝。
3. 页面载入后先安装收紧的 CSP、清空正文，再执行构建进安装包的本地 worker。
   该窗口不匹配任何 Tauri capability，因此远程页面不能调用 KDJ 应用命令。
4. Rust 用随机 128-bit 请求标识启动异步任务，并通过 Tauri
   `eval_with_callback` 轮询一次性结果槽。返回值仍由 Rust 做 token、URL、操作类型、
   大小和 host/path 校验；远程代码不能直接选择本地命令。
5. 成功后保留该 incognito realm，以复用昂贵的 BotGuard minter；任何超时、脚本错误
   或返回值校验失败都会销毁整个 realm，下一次用户操作从同一路径干净重建，不尝试
   备用 client、binding、proof 服务或弱隔离实现。

## 为什么选择这一套

| 方案 | 安装体积 | 三端适配 | 安全/运维结论 |
| --- | ---: | ---: | --- |
| Tauri 系统 WebView（采用） | 约 `0.07 MB` gzip 前端资产增量，仅 Win/Linux | 一套 Rust + 一套 worker | 复用现有壳；远程代码留在无 capability 的独立 realm |
| Deno/V8 + rustypipe-botguard | 通常是数十 MB 级引擎增量 | Rust 表面统一，底层多一套运行时 | 供应链、补丁、内存和构建时间都明显增加 |
| 分别调用 WKWebView/WebView2/WebKitGTK 原生 API | 无额外引擎 | 三套实现 | 行为和生命周期容易漂移，维护成本最高 |
| 主 renderer 直接执行 | 最小 | 一套 | 远程 player/BotGuard 会落入高权限主页面，不接受 |
| 远程 proof 服务 | 客户端最小 | 一套 HTTP | 引入可用性、隐私、成本和服务端合规依赖，不接受 |

原 PR 的 V8 提交为 Cargo lock 增加了 1,112 行，并新增
`rustypipe-botguard 0.1.2`、`deno_core 0.331.0`、`v8 130.0.7`。本方案完整回退
这些依赖；当前 Cargo 清单没有因为三端 proof 增加任何 crate。

## 平台覆盖边界

本方案统一的是三端 **proof/player 变换运行器和 YTM 音频链**，不是承诺三端普通
YouTube 视频都能播放。普通视频的官方 embed 子视图仍是 macOS 专用；KDJ HLS 回退
可以在三端完成 proof、player 解析和本地会话准备，但最终只有系统 WebView 的媒体元素
宣告原生 HLS 能力时才播放。WebView2 通常没有这项能力，本次没有为了补齐它而再引入
MSE/hls.js。这样可以把运行时和体积控制在本 PR 范围内，也避免把“生成了 HLS”误报成
“用户能看到视频”。

| 平台 | 实际引擎 | 安装/运行前提 | 本方案额外前提 |
| --- | --- | --- | --- |
| macOS 10.15+ | 系统 WKWebView | 操作系统内置 | 无；worker 构建目标保持 Safari 13，并移除未被该基线支持的运行时方法 |
| Windows | Edge WebView2 | Windows 11 预装；Tauri 默认安装器会在缺失时下载 bootstrapper | 无额外 runtime；需要联网完成首次补装的老系统仍沿用 KDJ 当前安装策略 |
| Linux | WebKitGTK 4.1 | Tauri 本身即依赖；DEB 声明系统包依赖 | CI 固定 Ubuntu 22.04 构建基线，避免滚动 runner 改变 ABI |

因此，“系统没有 WebView2/WebKitGTK”不是这个功能新增的独立失败面：缺少它们时
Tauri 主窗口本身也不能正常运行。Windows 离线安装若要覆盖极端环境，可以另行选择
约 `127 MB` 的 WebView2 offline installer，但不应为了 YouTube proof 默认让所有用户
承担这部分体积。Linux AppImage 仍受发行版 WebKitGTK 版本影响；官方 DEB 是更可控的
交付形式。对应的安装行为和依赖声明见 Tauri 的
[Windows WebView2 安装选项](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options)
与 [Debian 打包说明](https://v2.tauri.app/distribute/debian/)。

## 体积预算

当前生产构建实测：

- proof/player worker：`170,552 B` raw，`53,728 B` gzip；
- YTM SABR 延迟 chunk：`85,471 B` raw，`20,475 B` gzip；
- Windows/Linux 相比此前 unsupported stub 合计新增：`256,023 B` raw，
  `74,203 B` gzip；
- macOS 原本已带这两份资产，只增加少量 Rust/Tauri glue；
- 新增 Rust/系统依赖：`0`。

安装器还会二次压缩并受文件对齐影响，因此发布预算设为 **三端均小于 0.5 MB 增量**。
Windows/Linux 的最终差值应在 CI 产物生成后与同版本基线安装包逐字节比较；不能把
开发目录或 Cargo 下载缓存的大小当成用户安装包大小。

## 验证与剩余风险

- 本地门禁：Rust `cargo check`、TypeScript 检查、Tauri 前端生产构建；不以测试集
  通过代替逻辑复核。
- macOS 实机门禁：完整停止并重启 Tauri，走真实 YouTube 搜索 → proof → player 变换
  → 本地 HLS 会话 → 媒体时钟推进；本次最小功能验证已完成。最终统一回调实现还直接
  完成了一次真实 YouTube challenge，回传 124 字节 GVS proof，进程保持正常。
- CI 门禁：macOS arm64/x64、Windows x64、Ubuntu 22.04 都完成真实 release 编译和打包。
- 不能承诺所有网络、地区或 YouTube 策略下 100% 成功。系统 WebView 太旧、上游
  BotGuard/player 协议变化、Google 风控、地区限制或网络拦截仍会显式失败。
- Windows/Linux 目前只能由 CI 证明编译与打包成立；发布前仍应各用一台真实设备做
  proof/player 与 YTM 试听 smoke。普通 YouTube 预览若未检测到原生 HLS，应明确显示
  不支持，而不是把它列为这两个平台的成功门禁。
- 内嵌 Google 登录仍受 Google 的设备、账号与风险策略控制；无 capability 的登录窗口
  可以承载流程，但不能保证每个账号/网络都被 Google 接受。已有浏览器 profile/header
  导入路径仍是受风控时的可用替代，不应把一次登录成功写成全量兼容保证。

## 收口执行计划

| 阶段 | 工作与验收条件 | 状态 |
| --- | --- | --- |
| 逻辑复核 | continuation 只从实际歌曲 shelf 尾部读取；去重循环 token，限制 token 大小与最多 512 页 | 已完成 |
| 登录安全 | 顶层导航精确 allowlist、拒绝新窗口；候选 Cookie 在线验证成功后才落盘，不覆盖原有效会话 | 已完成 |
| 架构收敛 | 普通 revert 移除 Deno/V8；三端只保留隐藏 Tauri WebView + 一份 worker + 一份 Rust 回调桥 | 已完成 |
| 最小功能 | 真实 YouTube challenge 回传 124 字节 proof 且进程存活；macOS 搜索到本地 HLS 后媒体时钟推进 | 已通过 |
| 本地静态门禁 | `cargo fmt --check`、`cargo check -p kdj-app --lib`、TypeScript 检查和 Tauri Web 生产构建；按本轮要求不运行测试集 | 已通过 |
| PR 门禁 | 快进更新原 PR，三平台 release 编译/打包完成；失败时只修对应平台编译或产物问题 | 更新 PR 后执行 |
| 发布门禁 | Windows/Linux 实机各做 proof/player + YTM 试听；Google 拒绝内嵌登录时验证 profile/header 回退 | 合并前人工项 |

## PR 收口策略

保留现有 PR 的 WebView 登录与歌单 continuation 修复，新增统一 Tauri proof/player
实现，并以普通 revert 撤回 V8/Deno 提交，保留完整审计历史。优先快进更新原 PR；
只有上游分支拒绝维护者写入时，才从当前分支开替代 PR 并在原 PR 互链，不做强推。
