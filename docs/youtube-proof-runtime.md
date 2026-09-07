# YouTube proof/player 桌面统一方案

更新日期：2026-09-07

补充研究：[YouTube API / Safari HLS 实测与优化计划](youtube-api-validation-2026-09-07.md)。
该实验确认部分无 Token 请求可播放，但也复现首片 403；直接 player API 的新鲜上下文可用，
跨视频 bootstrap 缓存仍未通过媒体门禁。研究没有替换本文的正式播放路径。

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
| PR 门禁 | 快进更新原 PR；仓库当前没有 `pull_request` workflow，本轮按要求不手动触发含完整测试集的发布流水线 | PR 已更新，自动检查不适用 |
| 发布门禁 | Windows/Linux 实机各做 proof/player + YTM 试听；Google 拒绝内嵌登录时验证 profile/header 回退 | 合并前人工项 |

## 合入 main 后的补充验证（2026-09-07）

- 合并提交：`e3ccda6`；未推送。原工作区的工作站、曲库等未提交修改已保留。
- 补充修复：Music/Video 独立的内嵌登录入口、窗口与会话；浏览器/请求头候选
  会话先验证再保存；识别 HTTP 200 中的退出登录信号。Firefox 使用 SQLite 只读
  连接读取实时 WAL，并拒绝截断的 Mozilla recovery 文件。
- 回归测试：171 首跨页结果、顺序及重复歌曲保留、limit、中途请求失败与循环 token；
  会话失效识别、Firefox WAL、Music/Video 登录 UI 分发与错误展示均通过。
- macOS 正常 Tauri 开发壳使用原数据目录，确认载入 1620 首曲库与原登录状态。
  从 Music 歌单双击歌曲，完成解析、缓存、波形与播放，时钟推进到 0:41，暂停成功。
- macOS 普通 YouTube 视频：当前设置为 `youtube_preview_player=kdj`，即 KDJ 原生
  HLS 路径。搜索 Big Buck Bunny 后双击出画面，时钟推进到 2:04；进度条跳转到
  5:00 后继续推进，并在 5:27 暂停。**这不是官方 embed 成功的证据。**
- 独立自动验收：YTM proof/SABR 音频约 2.37 秒可播放、3.28 秒确认时钟推进；
  强制 `platform` 的官方 embed 测试仍失败（未推进时钟/缓冲超时），不能标记全套
  E2E 通过。视频失败不会再跳过独立音频测试，音频通过后的错误阶段标记为
  `official-video`，避免误报成 YTM 故障。
- 后续「可预览但下载报机器人验证」反馈：受保护 HLS 已准备好后，视频下载仍先调用
  旧 iOS/WEB `video_info`，导致不相关的旧接口拒绝阻断下载。已改为直接消费已校验的
  本地 HLS capability；只有直接流/音频下载继续解析 formats。缺少展示标题时使用
  视频 ID，不再为了命名重发 player 请求。离线回归用本地代理拦截所有旧接口，确认
  首个请求是 HLS、非法来源被拒绝、失败不残留临时文件；测试通过。
  下载队列错误同时改为完整换行展示。
- 经用户同意完整重启开发壳，按原 1080p 与 `9.13` 目录重新提交两项视频下载：
  两项均进入下载阶段，不再被旧 player 验证阻断。God-ish 首次上游 HLS 403，
  重新准备会话后下载 8,734,480 字节；Morfonica 下载 263,285,728 字节。
  两项最终均在转封装时报 `MPEG-TS segment does not contain an H.264 or HEVC
  video stream`，未生成成品，停止继续重试。该结果仅证明旧接口阻断已解除，
  **不代表视频下载端到端通过**。
- 转封装补丁：本地固定 `hls-transmux 0.2.1` 源码及 MIT 许可，保留首片 A/V 初始化
  校验，允许后续单轨分片，拒绝空片/无媒体样本片和损坏 TS；不跳过分片、不补造帧。
  基于上游 TS fixture 的音频尾片/视频尾片测试先复现原错误，修复后逐轨 MP4 样本数
  完整；3 项集成回归及 29 项上游单元测试通过。详见
  `vendor/hls-transmux/KDJ-VENDORING.md`。
- 补丁后经用户同意完整重启并重试原两项任务，均 `done/completed`：God-ish
  成品 6,926,262 字节，1080×1080 H.264 + AAC，约 204.51 秒；Morfonica 成品
  253,036,379 字节，1920×1080 H.264 + AAC，约 515.11 秒。只读探测完整遍历
  两份文件的音视频包；macOS AVFoundation 成功解码两份文件接近末尾的画面。
  成品保存在用户原 `9.13` 目录，其他暂停任务未启动。此结果是 macOS 真实下载
  验收，不替代 Windows/Linux 实机验证。
- `output` 误入库：只读检查确认曲库曾索引 `.partial-youtube-…/output.mp4`。
  watcher 的单文件事件绕过了递归扫描的隐藏目录剪枝。现让扫描与 watcher 共享内部
  暂存路径过滤，YouTube 暂存文件改为 `output.part`，完成后才原子更名为真实标题。
  显式暂存文件/目录扫描与「暂存创建→成品改名」两项回归通过；普通用户自己的
  `output.mp4` 不受过滤。经用户同意已仅清除确认来自暂存目录的误入库记录，
  原暂存文件仍在；真实下载期间及完成后没有再索引暂存路径，成品文件名与曲库标题
  正确，不再继承 `output`。
- macOS/Windows/Linux/Android 前端目标构建及体积门禁通过；Windows/Linux 目标
  的前端构建不代表相应系统的原生编译或实机验收。桌面 worker 必须打包，移动端
  不得打包。普通视频跨平台 embed、Windows/Linux 实机及新的交互登录流程仍待验收。

## PR 收口策略

保留现有 PR 的 WebView 登录与歌单 continuation 修复，新增统一 Tauri proof/player
实现，并以普通 revert 撤回 V8/Deno 提交，保留完整审计历史。优先快进更新原 PR；
只有上游分支拒绝维护者写入时，才从当前分支开替代 PR 并在原 PR 互链，不做强推。
