# YouTube 播放链路与凭证风险结论

- 复核日期：2026-08-30
- 已发布基线：`v0.2.44`（提交 `508a7cdf`）
- 当前候选：`1.0.0-rc1`（正式全量更新），Rust + Tauri
- 设计原则：普通 YouTube 视频和 YouTube Music 音频各只有一条正式播放链路；不以旧实现、替代 client、替代 binding 或刷新后重试作为成功条件。

## 1. GitHub 是否真的报告过 token 泄露

目前不能从公开页面证明“有”或“没有”仓库 Secret scanning alert。`v0.2.44` 的 release、tag 构建和发布 workflow 均成功，但 Secret scanning alert 详情只对有安全权限的仓库管理员开放；当前机器保存的 GitHub CLI 登录已失效，公开 REST 请求返回 `401`，隔离浏览器也没有 GitHub 登录态，管理页只返回登录入口/404。因此，公开 workflow 全绿不能代替仓库 `Security and quality → Secret scanning` 的结果。

能够核实的本地与公开证据如下：

1. `v0.2.44` 的可达 Git 历史没有发现私钥、GitHub token、AWS、Slack、OpenAI 或 Stripe 这类高置信特权 token；命中的强格式只有五个源码位置中的六处 `AIza...` Google API key。
2. 这些 `AIza...` 值是 YouTube 网页/InnerTube/BotGuard 客户端公开携带的 client key，不是 KDJ 用户的 QQ、YouTube Cookie，不赋予 KDJ 仓库、Google 账号或本机文件权限。GitHub 的默认模式确实会把 Google API Key 作为 `google_api_key` 扫描，因此它们是最可能的告警来源。
3. 下载并解包了公开的 `KDJ.app.tar.gz` v0.2.44。包内没有 session/credential 文件，也没有匹配真实 `SAPISID`、`SAPISIDHASH`、QQ musickey/access/refresh token 或私钥的值；只在主二进制里命中上述编译进去的公开 Google client key。
4. Tauri v0.2.44 没有把应用数据目录声明为 bundle resource。QQ 与 YouTube 登录态在用户运行应用后才写入应用数据目录，不会因为正常 release 构建而进入安装包。

这里还要区分“从知名项目参考的客户端实现”和“用户自己的凭证”。QQ 请求签名、公开客户端参数和匿名设备字段可以来自社区项目；真正的 `musickey`、`access_token`、`refresh_token` 与 `refresh_key` 只会在用户完成登录后生成。YouTube 的公开 InnerTube/BotGuard client key 同样不是登录态；从浏览器复用的 `SAPISID` 类 Cookie 才是能代表账号的高敏感会话。两类真实会话都只落在本机 `data/sessions`，不应进入源码、release artifact、日志或 issue。v0.2.44 的 QQ/网易云风险是旧会话文件可能按 `0644` 写入，并不等于它们已被提交到 GitHub；当前版本会把当前及历史 session 目录/文件持续收紧为 `0700`/`0600`。

若管理员页面中的告警位置正好是这些公开 client key，可以在逐项核对位置和 secret type 后，以“不是 KDJ 持有的私密凭证”为依据处理；不要通过拆字符串等方式规避扫描。若位置是 session JSON、用户 Cookie、私钥或发布 token，则必须先在对应提供方撤销/轮换，不能只删 Git 历史。

## 2. v0.2.44 和整改中间态原来怎么播放

需要区分两个阶段：

- 正式版 `v0.2.44` 的普通 YouTube provider 已有搜索、解析和下载，但前端视频预览 URL 与后端 `/api/video/preview` 仍固定走 Bilibili preview provider，并没有一条完整、独立的普通 YouTube 预览链路。
- `v0.2.44` 的 YouTube Music 受保护播放会在拥有 Tauri IPC、本地 API、DOM 和持久状态的主 renderer 中运行 BotGuard challenge，并执行从官方 player `base.js` 提取的变换程序。它能拿到 GVS proof、签名和 SABR 音频，但远程脚本一旦被上游供应链或解析器漏洞利用，影响会落进主窗口权限边界。
- 安全整改最初采用 fail-closed：删除主窗口远程执行后，依赖 BotGuard、`s` 或 `n` 变换的受保护 YouTube Music 播放明确不可用。截图里的报错描述的就是这个阶段。它失去的是受保护的 YTM 试听/下载准备，不是 QQ 或网易云登录。
- 随后的普通 YouTube 试验链使用 direct DASH、独立音视频轨、`s`/`n` 解码和 MSE/SIDX 拼接。它请求多、首播等待长、seek 要重建字节区间，WebKit 下也更容易出现音画轨不同步或某一路 403，因此没有保留为正式路径。

## 3. 当前普通 YouTube 桌面链路

1. macOS 优先使用官方 `https://www.youtube.com/embed/<video-id>` 子 WebView。它使用非持久数据存储，不导入浏览器登录 Cookie，并在首次远程导航前移除 Tauri user script 与 `ipc` handler；清晰度、自适应、解码和 seek 由官方播放器负责。
2. macOS 官方 embed 明确失败、用户进入显式回退，或平台没有 embed bridge 时，前端只走 KDJ HLS 准备链：Rust 校验 11 位 video id，隔离 proof/player WebView 生成 GVS proof 并完成 `s`/`n` 变换，后端再签发本地不透明 HLS capability。
3. proof/player WebView 是 incognito，固定在 YouTube `robots.txt` origin，拒绝其它导航和新窗口，不导入账号 Cookie，也不匹配任何 Tauri command capability。远程 BotGuard/player 代码不会进入主 renderer。
4. 前端在创建播放会话前检查媒体元素的原生 HLS 能力。WKWebView 可进入系统 H.264/AAC 管线；WebView2 通常返回不支持并显式失败。本次没有重新引入 DASH/MSE 或 hls.js。
5. 两条路径都不在一次失败后切换 client、binding、proof 服务或媒体编码；短时预热缓存仍属于同一次用户播放尝试，拒绝结果不会被第二次请求悄悄覆盖。

因此本次三端统一的是 proof/player 运行器，不是三端普通视频播放保证。普通 YouTube 也不读取浏览器登录会话；只有进入 KDJ HLS 回退时才生成 proof、解析 `s`/`n` 和代理 GoogleVideo HLS。

## 4. 当前 YouTube Music 音频链路

YTM 仍需要它自己的登录会话和 WEB_REMIX player：读取 identity 与 player URL，隔离 WKWebView 生成同一 Safari 标识下的 proof 和签名配置，Rust 发出一次 protected Player 请求；若响应声明了更新的官方 `assets.js`，同一请求链严格使用响应对应的脚本解码。隔离区只复用昂贵的 BotGuard minter，每个实际播放上下文都会重新 mint content proof，避免相同 video id 在普通 YouTube 与 YTM 的不同签名上下文之间串用旧 proof。Rust 按当前音质设置选定唯一 AAC itag，前端只接受这个精确格式，不再误取最低码率 AAC。GoogleVideo 负责 SABR/UMP，网络请求通过 Rust 的 URL/请求体校验代理写入有界 spool；首批 128 KiB 即发布给 KDJ 原生音频播放器，后续按 256 KiB 写入，以缩短首播等待。该 SABR 代理所需的 `X-KDJ-Sabr-Url` 已加入精确 CORS header allowlist，避免 WebKit preflight 在真正请求前确定性失败。

这里也没有失败后改 client、换 binding 或回到旧直链的分支；通用 `/song/preview` 端点现在会主动拒绝 YTM，防止旧直链以后被误接回来。YTM 还被明确排除在播放器通用的“媒体报错后自动强制回源一次”机制之外，GoogleVideo `maxRetries` 固定为 `0`，Rust 也不会在 401/403 或续传失败后换 proof 重试。首轮失败会以固定状态/类别显式暴露；创建 spool 后若 SABR 启动失败，会立刻终止同一会话，不留下十分钟等待项，控制台与 spool 错误也不会保存原始 URL、proof 或上游正文。SABR 一次成功响应中的连续分片请求是协议本身，不是失败回退。

## 5. 防护、代价与依赖体积

### 带来的保护

- 主 renderer 的生产 CSP 不需要 `unsafe-eval`，不执行 BotGuard 或 player 远程代码。
- 普通视频的官方子 WebView 为 incognito；首次远程导航前移除全部 Tauri user script 和 `ipc` message handler，并以精确 host/path allowlist 拒绝非官方导航和新窗口。
- 普通视频不读取浏览器会话；官方 embed 不生成 proof，KDJ HLS 回退会在隔离运行器内生成 proof。两条路径都不把 GoogleVideo URL、Cookie 或本地控制 bearer 交给 renderer；renderer 只拿到有界、可撤销的本地 HLS capability。
- YTM 必需的 BotGuard/WebPO 只在无导入 Cookie、无命令 capability、网络受限的隐藏 Tauri 系统 WebView 中运行；macOS、Windows、Linux 共用同一 Rust/Tauri 适配，proof 和上游媒体 URL 不会进入主页面错误文案或日志。
- QQ、网易云和 YouTube session 目录在 Unix 上为 `0700`、文件为 `0600`；当前版本还会收紧 `kumodeck` 与 Labs 历史数据目录中遗留的普通 session 文件。

### 失去或限制的功能

- macOS 官方 embed 仍受匿名、年龄、会员、私有与禁嵌条件限制，也可能显示 YouTube 品牌、广告和自身控件；它不会借用用户浏览器里的 YouTube 登录态。
- KDJ HLS 回退固定选择一条受支持的 H.264/AAC 变体，不做自动 rendition/client 切换；系统画中画能力只在这条原生媒体路径实际可用时成立。
- 普通视频的官方 embed 子视图仍只在 macOS 启用。KDJ HLS 准备链可在 Windows/Linux 运行，但媒体元素只有在系统 WebView 宣告原生 HLS 能力时才会进入播放；WebView2 通常不支持，因此本次不能视为补齐 Windows 普通视频播放。两条桌面链需要的 WebPO/player 隔离运行器已经统一到 Tauri 系统 WebView，不再为 Windows/Linux 嵌入 Deno/V8，也没有新增 MSE/hls.js。
- 官方远程播放器、地区策略或网络仍可能令单次播放失败；工程上不能仅凭一次 E2E 声称 `99.9%` 成功率，需要发布后的匿名成功率与延迟遥测才能量化。

### 实际体积

- 普通 YouTube 视频没有新增播放器 npm 包、JS 引擎、Node/Python sidecar、FFmpeg 或 yt-dlp；官方 embed 与 proof/player 都复用 Tauri 已经依赖的系统 WebView。新增的是少量 Rust/TypeScript 桥接与原本只在 macOS 打包的 worker 资产。
- 官方播放器本体从 YouTube 远程加载，因此不会进入 KDJ 安装包，但冷启动仍有网络脚本、广告/策略检查和播放器资源开销；本地空白子视图预热只减少 WebView 创建时间，不伪装网络性能。
- `googlevideo@4.1.1` 只服务 YTM 的 SABR/UMP 音频；当前生产延迟 chunk 是 `85,471 B` raw / `20,475 B` gzip，proof/player worker 是 `170,552 B` raw / `53,728 B` gzip。macOS 原本就包含两项；Windows/Linux 新增前端资产合计 `256,023 B` raw / `74,203 B` gzip，没有新增 Rust 依赖。安装包增量预算取 `< 0.5 MB`，最终值以三平台 CI 产物差分为准。

## 6. 风险评级与发布动作

| 风险 | 当前评级 | 结论 |
| --- | --- | --- |
| v0.2.44 安装包携带用户登录凭证 | 低 | 对公开 macOS release 的结构与强格式实扫未发现；正常 bundle 配置也不包含数据目录。 |
| GitHub 实际存在 Secret scanning alert | 未知 | 需要仓库管理员登录后查看；公开 API、workflow 与 release 页面无法证明没有私有告警。最可能命中公开 Google client key。 |
| QQ/YouTube 本机会话被同机其他账号读取 | 低 | 正式数据目录已是 0700/0600；发现的历史 QQ、网易云及其他 session 副本也已统一收紧，新版本会持续迁移权限，调试覆盖目录也不能绕过。会话一旦被复制仍属高影响凭证。 |
| 远程 YouTube JavaScript 影响主窗口 | 低 | 官方 embed 会移除 Tauri IPC；proof/player 窗口保留 Tauri 的跨平台求值回调，但不匹配任何 command capability，且无登录 Cookie、非持久、网络和导航受限。两者都不把远程程序放进主 renderer。 |
| 官方 embed 不支持某些视频/地区/账号条件 | 中 | 匿名、允许嵌入的公开视频是正式支持边界。登录、年龄、会员、私有或禁嵌内容会显式失败；不会为提高覆盖率而导入用户浏览器 Cookie。 |
| YouTube 远程播放器或策略变更导致播放失效 | 中 | 无法从工程上降为零；官方 embed 比复制未公开 proof/HLS 协议少一层脆弱面，但仍依赖 YouTube 在线服务。失败会显式暴露，不静默换路。 |
| GoogleVideo 依赖重量/攻击面 | 低 | 仅 YTM worker 使用，普通视频的官方 embed 不打包该库；YTM 的远程 URL 和请求仍经 Rust allowlist。 |

最终代码已在 macOS 原生 Tauri 会话中完成一次静音、非置前的连续真实验收，实际挂载正式 `VideoPipHost`：空白子视图预热 `4.759 s`；冷播公开视频在 `3.089 s` 进入可播放、`6.938 s` 确认媒体时钟推进；seek 调用 `1 ms`；切换到第二个严格视频后 `0.521 s` 可播放、`2.705 s` 确认推进；切回热播 `0.520 s` 可播放、`4.263 s` 确认推进；随后 YTM 音频在 `8.575 s` 可播放、`9.595 s` 确认推进。整条“冷播 → seek → 切换 → 热播 → YTM AAC”报告状态为 `passed`，没有触发备用 URL、client、binding 或失败重试。

这证明上述固定样本和当前网络下的功能链路成立，但不是 1000 次统计，也不应包装成 `99.9%` SLA。发布后若要量化“一次成功率”，应只记录不含 video id、URL、Cookie、proof 的匿名阶段耗时与结果类别。

此外，管理员应检查并处理 Secret scanning 页面；保持 push protection；不要把请求头、session JSON、日志中的 URL 或 proof 粘贴到 issue。若管理员看到的不是已记录的公开 client key，立即停止发布并按 secret provider 的控制台先撤销/轮换。
