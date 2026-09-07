# YouTube API / Safari HLS 实测与优化计划

日期：2026-09-07。模式：研究、真实网络验证、计划；**本轮没有修改生产播放实现**。

## 1. 决策摘要

1. **不能全局删除 PO Token。** 不带 Token 的 Safari HLS 在部分请求中确实能解码、播放和跳转；但也复现了“主清单 200、子清单 200、首片 403”。同一份 watch HLS 地址随后附带新生成的 Token，首片变为 200 并完成解码和跳转。第一次成功不能代表整个客户端免验证。
2. **直接 InnerTube `player` API 是真实候选，而不只是文档里的接口。** 使用真实 Safari 客户端上下文和 signature timestamp，两个公开视频都取得了 HLS；使用各视频的新鲜上下文时，两者返回的流都实际完成过系统解码与跳转。
3. **“API 返回 OK”不等于能播放，也不能直接缓存整份网页上下文。** 把第一个视频的整份上下文原样复用于第二个视频时，API 在 796 ms 返回 OK + HLS，但带/不带 Token 的首片都 403。上下文含有绑定具体 watch URL 的 `client.originalUrl`；但仅修正这个字段后仍复现 403。会话字段、页面字段和脚本版本必须分开管理，403 的根因尚未定位到唯一字段。
4. **确定可优先做的是预热接线、显式重试与缓存生命周期、阶段计时。** 本轮复现了失败结果被缓存两分钟；原生 HLS 和 YTM 预热函数没有连接到普通使用入口。
5. 保持 Rust + Tauri、独立 proof realm、系统解码、共用视频调度。没有证据支持为提速整体替换成 YouTube.js/RustyPipe，或加入 Python/Node/Deno 播放运行时。

## 2. 验证边界与方法

### 环境

- macOS 26.5（25F71），Apple Silicon / arm64；辅助 HTTP 客户端 Node 25.8.0。
- 仓库 HEAD `e3ccda6`，工作区已有其它未提交改动；验证按工作区当前实现取样，不代表干净 HEAD 的行为。
- 使用正常数据目录下 **普通 YouTube 自己的现有会话**，只读 Cookie，不读取或更改 YTM 会话，不导入其它浏览器账号。
- `youtube_preview_player=kdj`，播放画质上限 720；没有更改设置、曲库、下载队列或已有 Tauri 开发进程。
- HTTP 请求无显式代理环境变量；没有据此断言系统/TUN 层不存在代理。没有记录出口 IP。账号 Premium 身份没有可靠确认。
- Safari 请求标识与 `src/lib/youtubeNativePo.ts` 的 `YOUTUBE_HLS_USER_AGENT` 一致。
- 公开视频 A：Big Buck Bunny，`aqz-KE-bpKQ`。
- 公开视频 B：Never Gonna Give You Up，`dQw4w9WgXcQ`。

### 实验实现

临时辅助程序做以下事情，并不是给 KDJ 添加新运行时：

1. 用现有 Cookie、固定 Safari UA 请求 watch HTML。API 试验从中读取真实 `INNERTUBE_CONTEXT`、player URL 与签名时间戳；普通 HLS 试验读取 watch 自带 HLS。
2. 按 `vite.tauri.config.ts` 相同 esbuild 参数构建**现有** `youtubeNativePo.worker.ts`：IIFE、browser、Safari 13、minify。没有另写 BotGuard 或 n 解密算法。
3. 用独立、非持久 WKWebView 加载精确的 YouTube `robots.txt` 网络 origin，安装与生产一致的 CSP，再运行该 worker。没有导入 Cookie，没有 Tauri command、任意本地文件或任意 URL 接口。
4. 普通对照使用同一份签名清单、同一 n 变换结果、相同 UA/Referer/720p H.264 + AAC 变体，仅改变是否附带 `/pot/<token>`。不带 Token 的分支不向 GVS 发送生成结果。
5. 另开全新辅助进程，**整个试验不调用 mint**，排除“其实仍启动了 BotGuard”的混淆。另做先无 Token、失败记录后再有 Token的配对；这是两个明确命名的实验分支，不是上线后的静默重试。
6. 每条链检查主清单、子清单、前两片及 60 秒附近一片。第一片失败即停止该分支，不用后续成功覆盖原始失败。
7. 分片成功后，通过临时 loopback 代理交给系统 AVFoundation；用 `AVPlayerItemVideoOutput` 实际提取解码像素缓冲。验证时钟从开头推进超过 4 秒，跳到 60 秒，再推进到 64 秒且继续产生解码帧。全程静音，不进行 GUI 自动化。

**这不是当前 Tauri UI 的端到端性能验收。**

- proof/player 的 JS 源码与生产相同，但宿主是临时 WKWebView，而不是 Tauri IPC 桥。
- 媒体使用同一系统解码体系，但实验代理先缓存整片；生产 Rust 使用边下载边读取的 spool。两者的预取、Range、缓存和首播策略不同。
- “首解码帧”从辅助 AVPlayer 开始加载已取得的子清单起计，指成功提取像素缓冲，不是 KDJ 界面呈现时间，也不含此前授权、API、清单和抽样耗时。
- seek 指发出跳转后，时钟和解码帧均超过目标 1 秒的耗时，不是仅完成 `seek()` 调用。
- 不是独占网络/系统负载的统计基准；不能用这些小样本给出 P95、平台成功率或宣称整机加速百分比。

## 3. Safari HLS / PO Token 的结果

本轮媒体矩阵共 **18 个显式实验分支**：13 个完成解码和 seek，5 个因首片 403 停止。包括故意省略授权、原样缓存 context 等候选方案，不能把 13/18 当作 KDJ 产品成功率。另有 2 次仅检查 player 信息的请求、匿名边界探测和缓存单元行为验证。

### 3.1 已生成 minter/token 的配对试验

同一轮内使用同一 watch HLS 和 n 结果；第二轮交换两种模式的执行顺序。A 第二次是新 watch 授权请求，不是同一 prepared URL 热命中。

| 轮次 | 模式 | 主/子清单 | 3 个抽样分片 | 系统解码与 seek | 首解码帧 | seek 后推进 |
| --- | --- | --- | --- | --- | ---: | ---: |
| A-1 | 不带 Token | 200 / 200 | 全 200 | 通过，164 帧 | 801 ms | 8,649 ms |
| A-1 | 带 Token | 200 / 200 | 全 200 | 通过，163 帧 | 2,451 ms | 10,300 ms |
| B | 带 Token（先执行） | 200 / 200 | 全 200 | 通过，163 帧 | 1,904 ms | 12,950 ms |
| B | 不带 Token | 200 / 200 | 全 200 | 通过，162 帧 | 2,815 ms | 10,900 ms |
| A-2 | 不带 Token | 200 / 200 | 全 200 | 通过，164 帧 | 602 ms | 13,200 ms |
| A-2 | 带 Token | 200 / 200 | 全 200 | 通过，164 帧 | 1,202 ms | 9,350 ms |

每个成功分支都从 0 秒附近推进到 4 秒后，跳到 60 秒，再继续到 64 秒以上。这里的耗时波动没有呈现可靠的“省 Token 后必然更快”。

### 3.2 真正不生成 Token 的新进程

| 样本 | 主/子清单 | 首片 | 后续结果 |
| --- | --- | --- | --- |
| A | 200 / 200 | 200 | 3 个抽样片成功；解码 163 帧并完成 seek，首解码帧 750 ms |
| B | 200 / 200 | **403** | 停止；没有宣称可播放 |

### 3.3 对 B 重新做同地址配对

新建辅助进程；先 n 变换，不生成 Token：

- 无 Token：主清单 200，子清单 200，**首片 403**。
- 然后 mint，保留原 watch HLS / n / UA / 画质，仅附带 Token：3 个抽样片均 200，实际解码 163 帧，seek 后继续至 64 秒。
- 该轮 mint 用时 1,618 ms；有 Token 分支首解码帧 604 ms，seek 后推进 4,301 ms。

**结论：当前无 Token 路径不能替代正式路径。** 它不是完全不可用，而是缺少足够稳定的适用条件。不能仅用清单请求成功判断是否可省验证，不能为绕过首次失败自动轮询不同 client、binding 或 proof。

### 3.4 匿名边界

A 的同机探测：

- 带现有 Cookie：watch HTTP 200，`LOGGED_IN=true`，包含 HLS。
- 不带 Cookie：watch HTTP 200，`LOGGED_IN=false`，**没有 HLS**。

这里只验证了一个匿名样本。没有证明整个 Safari 客户端都必须登录，也没有证明 API 能取消登录前提。

## 4. 直接 InnerTube API 的结果

### 4.1 获取播放信息

请求 `https://www.youtube.com/youtubei/v1/player?prettyPrint=false`，使用网页当前 WEB/Safari 上下文、Cookie + SAPISIDHASH、visitor、对应 signature timestamp。没有改用 Android/iOS/TV client。

此次网页给出的 client version 是 `2.20260904.01.00`。这是实验观察值，**不应硬编码成新生产常量**。

| 样本 | 读取本视频 watch | player API | API 返回体（解压后） | 结果 |
| --- | ---: | ---: | ---: | --- |
| A | 1,899 ms | 229 ms | 43,301 B | HTTP 200，OK，HLS + SABR |
| B | 1,142 ms | 808 ms | 232,968 B | HTTP 200，OK，HLS + SABR |

这两个时间是同一轮内先后执行的不同请求，不是“端到端提速”。API 首次初始化仍需要上下文和脚本；只有**正确且有效地复用 bootstrap**，才有机会消除每视频 watch HTML 请求。

### 4.2 API 流的实际播放，以及整份上下文缓存的失败

随后单独做媒体层试验：

| 请求 | API 用时 | bootstrap | 不带 Token | 带 Token |
| --- | ---: | --- | --- | --- |
| A | 765 ms | 本视频新鲜 watch + script | 解码 / seek 通过，163 帧 | 解码 / seek 通过，162 帧 |
| B | 796 ms | **原样复用 A 的整份 context 和脚本** | 清单 200，首片 403 | 清单 200，首片 403 |

B 的 API 准备加 n 变换总计约 850 ms，**但不能播放，所以这不是成功的“850 ms 播放优化”**。

接着，B 使用自己的新鲜 watch 上下文重新请求 API：不带和带 Token 两个分支均实际完成解码与 seek（162 / 163 帧）。这说明 B 并非天然不能用 API，但整份 context 跨视频原样缓存不可靠。

静态检查真实 context，发现它包含：

- 客户端版本、浏览器标识等客户端字段；
- visitor、user 等会话字段；
- `client.originalUrl`，其中明确含当前 video ID；
- `clickTracking`、`configInfo`、`rolloutToken` 等其它上下文字段。

**这些字段不是一份可以无限期、跨视频原样复用的“API key”。** `originalUrl` 是已确认的页面绑定字段；本轮尚不能把所有 403 唯一归因于它或 Token。

### 4.3 仅修正 originalUrl 的缓存对照

保留 bootstrap 缓存方案，唯一的 context 构造变化是为每个视频更新 `client.originalUrl`，所有媒体分支都带新 mint 的 Token：

| 样本 | API 用时 / 返回体 | bootstrap | 首片 | 解码 / seek |
| --- | --- | --- | --- | --- |
| A | 274 ms / 43,294 B | 新鲜 | 200 | 通过，164 帧 |
| B | 1,037 ms / 228,093 B | 复用 A，originalUrl 改为 B | **403** | 未进入 |

B 仍返回 HTTP 200、playability OK、HLS，仍不能播放。因此 **“只把 originalUrl 改一下就完成可靠缓存”也未通过**。这使得原样跨视频缓存失败成为可重复观察，但还不能认定唯一原因；必须继续核实 context 的其它绑定、player response 的脚本/会话关系，以及上游分发变化。

对照数据：B 使用自己新鲜上下文的 API 请求为 703 ms，带 Token 的流可解码并 seek；但该次仍付出 watch 2,848 ms 与脚本下载 3,350 ms，不能把 703 ms 宣传为用户首播耗时。

### API 路线决策

- “完全不存在可用 API”不成立；已有两个视频在新鲜上下文下完成 API → HLS → 真解码。
- “直接用 API 就已经解决卡顿”也不成立；快速返回的无效流只会把等待变成后续 403。
- 下一步应做**有边界的 bootstrap / per-video context 契约**，而不是整体替换 provider，或把完整网页 JSON 永久塞进缓存。
- API 更换的是**播放信息取得方式**；不等于免登录、免 PO Token、免 n 变换，也不等于补齐 Windows 原生 HLS。

## 5. 实测开销与已确认的代码问题

### 5.1 冷 / 热授权开销

首次三轮 watch 试验：

| 阶段 | A-1 | B | A-2 |
| --- | ---: | ---: | ---: |
| watch HTML | 2,141 ms / 1,429,342 B | 3,513 ms / 2,277,388 B | 3,346 ms / 1,437,406 B |
| player script 下载 | 762 ms | 1,611 ms | 1,341 ms |
| n 处理 | 321 ms | 21 ms | 22 ms |
| mint | **2,747 ms（冷）** | **21 ms（热）** | **21 ms（热）** |

脚本解压后为 2,598,178 B。这些是读取到的 body 大小，不是压缩后网络流量。后续独立进程的冷 mint 为 1,618 / 2,012 / 3,467 / 3,531 ms；已有 minter 的另两次 mint 为 2 ms。可观察到冷初始化远重于热 mint，但这不是去除 Token 后可直接兑现的整机节省时间。

辅助进程的 proof 文档/worker 初次启动约 0.6–1.6 秒；即便不 mint，n 变换仍使用隔离运行器，不能声称删 Token 就能删 WebView。

**重要口径：** 此三轮辅助程序为明确区分阶段，每轮都重新下载 script；生产 `loadYoutubePlayerScript()` 已按 route + player URL 缓存脚本，因此表中的重复下载开销不能当作生产缺陷。生产视频链已经用 `Promise.all` 并行 proof 和脚本/n；不能把两个阶段的耗时相加后承诺可节省同样的时间。

### 5.2 预热有实现，但日常入口没有使用正确的路径

- `src/lib/youtubeVideoPreview.ts::prewarmYoutubeVideoPreview`：源码只有定义，无调用者。
- `src/components/download/VideoResultRow.tsx::prewarmVideoPreview`：YouTube 结果行预热的是 `prewarmYoutubeEmbed()`，没有按当前 `youtube_preview_player` 选择原生 HLS 预热。
- `src/lib/api.ts::prewarmYtmPlayback`：普通 UI 无调用者；当前唯一调用在 `youtubePlaybackE2e.ts`。
- `prewarmYtmPlayback` 成功 Promise 没有租期更新逻辑；以后接 UI 时不能把“一次预热成功”当成整个进程永远有效。worker 的 minter 自身已有租期检查，应沿用而不是复制失效规则。

这是**调用链证据**，不是已经量化的用户首播改善。

### 5.3 失败缓存阻断明确的新尝试——已复现

用现有 `youtubeVideoPreview.ts` 原函数，通过 esbuild 仅替换 API 请求为可计数桩、控制 Date.now，得到：

| 时点 | 函数结果 | 累计真正准备请求 |
| --- | --- | ---: |
| 第一次请求 | 拒绝 | 1 |
| 1 秒后再次调用 | 仍拒绝 | 1 |
| 119 秒后调用 | 仍拒绝 | 1 |
| 121 秒后调用 | 重新请求并成功 | 2 |

这是确定性的缓存行为验证，不是故意让真实 YouTube 请求失败。代码原意是去重 pointer-down 与 double-click，但目前缓存键不能区分同一操作的去重与用户明确发起的下一次尝试。

此外：

- 成功/失败准备缓存键只有 platform + video ID + page，没有 maxHeight 或账号会话修订号。
- `clearYoutubeVideoPreviewCache()` 只有定义，没有退出账号/重新连接处的调用者。
- 改画质、重连账号后，在缓存租期内复用旧准备结果存在正确性风险；本轮没有进行真实账号切换或设置变更测试，不能宣称已复现跨账号播放。

### 5.4 画质和分片

`routes.rs::rewrite_youtube_hls_playlist` 固定保留上限内最高的一条 muxed H.264/AAC，不保留自适应变体集合。本机设置为 720p。

实验中，同一约 2.08 MB 分片下载出现过 3.3–7.4 秒波动。说明不能把启动/seek 等待都归为 JavaScript 运算。但实验代理整片缓存，与生产 spool 不同，**不能把本轮约 4–19 秒的辅助播放器 seek 数字直接标成 KDJ seek 缺陷**。

## 6. 后续实施计划（按依赖排序）

### P0：建立当前 Tauri 路径的阶段基线，不改协议

**文件 / 所有者：**

- `src/lib/api.ts`：begin、脚本、proof、n、complete 的编排阶段。
- `src-tauri/src/youtube_proof.rs` 与 `youtubeNativePo.worker.ts`：realm 创建、minter 冷/热、脚本缓存命中。
- `crates/kdj-server/src/routes.rs`、`youtube_hls.rs`：清单请求、分片首字节、spool 可读与取消。
- 现有 `videoPlaybackEngine.ts`、`videoFrames.ts`、`videoSeekQueue.ts`：媒体 ready、实际视频帧、seek 完成；不新增另一套调度器。

**要做：**

1. 为单次尝试建立随机 trace ID，区分冷 realm、热 realm、新视频、prepared 命中；HTTP 200 与媒体成功分别记状态。
2. 本地诊断只记录阶段、毫秒、字节数、cache hit、固定错误类别，不记录 Cookie、SAPISIDHASH、visitor/account ID、PO Token、签名 URL 或正文。
3. 用正常资料目录的真实 Tauri 壳，选择原生 HLS 进行冷播、切换、热回播、seek、显式失败测试。现有 E2E 强制官方 embed，不能直接当作 KDJ HLS 的基线。

**验收：** 每次失败有准确阶段；首帧不能用 duration/loadedmetadata 代替；所有取消的上游请求、媒体会话及临时 spool 最终被释放。

### P1：修正预热与尝试缓存——低协议风险，优先落地

**文件：** `VideoResultRow.tsx`、`youtubeVideoPreview.ts`、`api.ts`、账号连接/退出入口与设置变更入口。

**要做：**

1. 按正式播放器选择接线：KDJ 模式预热对应 HLS 的共享准备；官方模式只预热官方视图。不要两套同时初始化。
2. 对明确进入 YouTube/YTM 功能、pointer-down 或下一首已确定等有限意图预热；不扫描所有结果，不隐式开始播放，不为每次 hover mint。
3. 同一个 attempt ID 的 pointer-down/double-click 共享同一请求；**用户明确重试产生新的 attempt ID**，不复用旧失败。保留可见失败，不加后台自动换 client/proof 的逻辑。
4. 成功 capability 缓存至少关联 provider、video ID、page、maxHeight、accountRevision、backendInstance；租期取服务器授权/本地 lease 的有效交集。
5. 退出、重新连接、画质改变、后端实例改变时撤销或失效对应准备。迟到的旧结果不能写回新会话；清理 hook 必须实际接上，而不是仅导出。
6. minter、脚本解析器按已有边界复用；不把某个视频生成的 Token 变成跨播放上下文缓存。

**验收：**

- 一次用户动作只发一份准备请求；一次显式重试立即发出新请求，不需要等 120 秒。
- 账号/画质变化后不会命中旧 capability；关闭预览后无悬挂请求。
- 预热打开与关闭两组在同一 Tauri 壳比较；分别报告预热本身成本和点击后等待，不把“后台先等了几秒”宣传成协议零成本。
- YTM 单独验证，不能用视频 HLS 成功推断 SABR 音频成功。

### P2：API bootstrap 试验分支——先契约，再替换 begin

**文件：** `crates/kdj-providers/src/youtube/client.rs`、provider 契约、`routes.rs` 的 begin/complete、`src/lib/api.ts` 的已有隔离 player 配置桥。

**要做：**

1. 先解决本轮已复现的“缓存 context 后首片 403”：在同一视频、同一时间窗口下比较新鲜与缓存上下文，逐类改变字段，保持 UA、n、Token、画质和解码链不变。每次都校验真实媒体，不做大规模盲探。根因未明确前不接默认入口。
2. 从真实网页取得客户端/会话 bootstrap，明确区分客户端字段、账号 epoch、页面/视频字段、实验配置和 player 脚本版本；禁止整份 context 无差别复用。逐视频重建 `originalUrl` 等页面字段；对 clickTracking、实验/rollout 参数确定保留/刷新规则。返回 `assets.js` 改变时必须使用响应对应脚本。
3. 在不改 codec、清晰度、GVS proof 和解码器的前提下，仅将“每视频 watch HTML”替换为 `player` JSON 请求，以隔离变量。
4. bootstrap 与成功请求都必须有明确 lease、single-flight、账号变更失效和 bounded size；不硬编码本轮 client version，不在 403 后盲目循环切换客户端。
5. 保留正式 Token 路径。若将来要允许无 Token 模式，必须另有可靠适用性证据，而不是按一次清单成功或固定视频白名单推断。

**门禁：**

- 至少 10 个不同公开视频（音乐/普通视频、长短不同），每条覆盖首片、后续片、seek 后片及实际媒体帧；再加账号失效、bootstrap 过期、player 版本变化与退出重连。
- 冷/热、A→B→A、同视频新授权都测试；不能用同一次签名 URL 的重复 GET 代替不同授权上下文。
- 先完成源码与小范围协议门禁，再在 Tauri 上做对照：建议同一网络、同一清晰度至少 20 次交替尝试。报告原始失败和各阶段分布；样本不足时不宣称 SLA。
- 目标是减少热切歌的 watch 请求和响应体、缩短点击到首帧且不增加失败。没有通过媒体层门禁，不合入默认链路。

### P3：YTM 编排并行化与共享初始化（独立验收）

`api.ts::resolveYtmSabrPlayback` 当前按 identity → mint → player URL → script/config → player 顺序等待。确认依赖后，可以在 identity 已确定时并行准备 proof 与 player 脚本；signature timestamp 就绪后 player 请求也有机会与内容 proof mint 重叠。

约束：Music 与 Video 的 Cookie、账号、identity 和结果缓存继续隔离；只复用允许共享的昂贵运行器/脚本机制。对应音轨 itag、SABR spool、取消和失败状态不改变。

验收：真实 Tauri 的 YTM 音频时钟推进和 source 切换；不恢复已退休直链/客户端回退，不以 npm 包更换代替耗时对照。

### P4：网络/画质调优——只针对媒体阶段瓶颈

1. 先用 P0 计时确认卡在首片、后续片还是 seek 后片，再比较 360/480/720/1080 的固定画质组。
2. 检查取消、首片可读时机、upstream single-flight、Range 和 spool flush；生产已边下载边提供，不应先假定它在等整段下载。
3. 若较低画质显著改善卡顿，可在正式设置里提供清楚的策略选择；不要静默改变用户画质，不在本次研究里擅自加入 ABR、多解码器或新播放器依赖。
4. native decoding、共享 seek 调度和 source loading 分别验收。Windows WebView2 没有原生 HLS 时，取得 URL 仍不等于可播放；Android 同样需独立能力验证。

## 7. 本轮变更、清理与证据保留

- 仅新增本报告，并在 `youtube-proof-runtime.md` 交叉链接；没有修改生产 API、proof、播放器、缓存或设置。
- 临时辅助进程和试验文件在验证结束后删除；不保留媒体分片、watch HTML、完整 API 正文、签名 URL、Token 或 Cookie 副本。未保留新的 npm/Cargo 任务或测试 runtime。
- 所有实验报告的会话文件前后摘要一致，未改变登录态。本轮没有重启或停止既有开发壳。
- 复现需要按第 2 节重新建立临时探针；不存在可直接调用的已提交 `npm run probe:youtube-api` 命令。
- worker 源 SHA-256：`4ff330ef81451498dc3d639ccb73b30162dc4cb7a528da68478e09d0911686d6`。
- player wrapper 源 SHA-256：`c32034ccf4346eb57dab0d5bb2e6a39ea35c07752a0e87087f13bc0c9ee4714d`。
- 缓存行为被测文件 SHA-256：`922ef7ab569dd2f8a51affc1a82f967a11fe26679e26e28cf7d6696ee638cd3e`。

## 8. 上游依据与条款边界

- [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)：当前表格将 Safari HLS 列为部分不需要 GVS Token 的场景；同时明确策略持续变化。它是实验假设来源，不是对本机账号/所有视频的保证。
- [YouTube Data API](https://developers.google.com/youtube/v3/docs)：公开数据/管理 API，不提供 KDJ 原生播放所需媒体直链。
- [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)：官方播放器控制，不等于媒体文件 API。
- [YouTube Developer Policies Guide](https://developers.google.com/youtube/terms/developer-policies-guide)：官方下载、分离音视频和改动播放行为的使用条款需单独审视；非商业用途不自动豁免平台条款。
- [YouTube.js](https://github.com/LuanRT/YouTube.js/)：项目已有 MIT 来源的窄化 player 解析代码与许可文件；本轮没有新增依赖或改变再分发方式。

最终建议：**先把现有链路的预热、缓存和计时做好；继续验证“正确构造的 API 请求”，但不把删除 Token 或原样缓存网页 context 作为默认优化。**
