# 流媒体曲库长期任务路线图

> 目标：在 Rust + Tauri 当前架构内，把“搜索、曲库、播放、平台歌单”做成同一条可追踪的来源链。本文是实现契约，不把会员权限、第三方聚合服务或不稳定的接口伪装成已支持能力。

## 现状盘点

- 搜索入口：`src/components/workspace/Workspace.tsx` → `/api/intake` → `crates/kdj-server/src/aggregate.rs` → `MusicProvider`。
- 平台适配：`crates/kdj-providers/src/{netease,qqmusic,soundcloud}`；前后端契约分别在 `src/types.ts` 与 `crates/kdj-core/src/models.rs`，新增字段必须同步。
- 本地曲库：`crates/kdj-library` + `src/components/library/FolderTree.tsx`，文件夹树已有扫描、链接/复制/移动和搜索结果拖入下载队列。
- 在线试听基础已经存在：`/api/song/preview`、`src/lib/streamTrack.ts`、`src/lib/songPreview.ts`；但它目前是“临时试听曲目”，还没有持久化的流媒体曲目来源。
- 播放下一曲已有桌面原生预加载，但只对本地文件生效；在线流需要单独的 URL 预解析/缓存策略。

## 三大板块与实现顺序

### 1. 平台感知搜索（当前优先落地）

1. 引入 `SearchKind = song | artist | album`，由 provider 声明能力，后端提供能力矩阵。
2. 搜索栏只在满足以下条件时显示筛选：选择 1 个平台，或选择 2 个平台且二者存在共同能力；超过 2 个平台只显示“单曲”。
3. 网易云：`cloudsearch` 的 `type=1/10/100`；专辑/作者结果是集合，先展示集合卡片，再通过详情接口载入可下载歌曲。
4. QQ：`search_type=0/1/2`；专辑/歌手结果同样不能伪装成歌曲，必须通过 `GetAlbumSongList` / `GetSingerSongList` 展开。非单曲搜索需要 mobile comm，登录态/风控失败要显示可解释错误。
5. SoundCloud、Bilibili 暂保留单曲能力，不在 UI 里声称支持作者搜索。
6. 集合结果不得直接进入下载队列；只有展开出的 `SongSource` 才能试听、下载、入库。

### 2. 本地曲库与流媒体来源

1. 下载按钮前增加“添加到曲库”。该动作只保存平台来源（平台、歌曲 key、标题、封面、偏好音质），不伪造本地文件。
2. 文件夹右键提供“下载未下载歌曲”；它只针对该文件夹里仍无本地文件的流媒体来源，已有文件不重复下载。
3. 搜索结果拖入文件夹和文件夹内拖入继续共用现有 DnD；设置增加默认动作：`添加到流媒体曲库`（默认）或 `下载到本地`。
4. 旧的本地文件复制/链接语义不改：本地文件落点仍由 `library_paste` 的 link/copy/move 控制。
5. 流媒体曲目使用独立的来源表/播放引用，不写入 `tracks.path`，避免扫描器把远程条目当成文件。

### 3. 平台文件夹、歌单与播放质量

1. 左侧增加网易云、QQ 音乐、SoundCloud 三个平台根节点；展开后读取歌单，首项固定为“我的收藏”（登录态可用时）。
2. 歌单节点以远程来源 ID 为稳定键，加载歌曲后复用搜索结果/曲库播放队列；网络错误必须保留在节点上，不清空整个文件夹树。
3. 在线播放请求流媒体 URL；当前曲目播放时提前解析下一曲并缓存短期 URL。URL 过期后自动重新解析。
4. 设置中增加流媒体音质与视频播放画质。下载队列中的逐任务覆盖优先于全局默认；会员/版权限制只允许按平台返回的实际能力降级。
5. SoundCloud 的 client_id 轮换、HLS/DRM、限流；网易云/QQ 的会员和版权限制；均作为运行时错误/降级信息展示，不绕过权限。

## 可实现性与明确限制

| 平台 | 单曲搜索/播放 | 作者/专辑 | 收藏/歌单 | 主要限制 |
|---|---|---|---|---|
| 网易云 | 已有 eapi/weapi 基础 | `type=10/100` + album/artist 详情可接 | 登录后可取“我喜欢的音乐” | VIP/版权曲目可能无 URL；第三方聚合 API 不作为依赖 |
| QQ 音乐 | 已有搜索、vkey、登录 | mobile comm 的 `search_type=1/2` 可接，歌手结果有 `songInfo` 包装 | 登录态优先；歌单接口已有 | 绿钻/版权限制；非单曲接口受风控与请求指纹影响 |
| SoundCloud | 已有 resolve/transcoding 试听 | 暂不承诺作者搜索；playlist/album resolve 可用 | likes/playlist 读取需独立适配 | client_id 轮换、429、Datadome、Go+/DRM；原文件下载需授权 |

## 数据与状态边界

- `SongSource.key` 永远表示“歌曲 key”；作者/专辑集合使用独立 `CollectionResult`，禁止把集合 ID 塞入下载队列。
- 远程曲库来源与本地 `Track` 分离；本地 Track 仍必须有真实磁盘路径。
- 所有外部响应在 provider 边界解析；server 只编排集合/歌曲，前端只消费稳定契约。
- 能力矩阵由 provider 声明并通过 API 暴露，前端不复制平台名单作为唯一事实来源。

## 验证门槛

每一阶段至少运行：

```text
npm run typecheck
npm run tauri:web:build
cargo test -p kdj-core -p kdj-providers -p kdj-server
```

Rust、provider、路由或配置改动后，按仓库规则停止并重启 `npm run tauri:dev` 做一次端到端验证；不使用 Electron/Python sidecar 作为运行时证据。

## 当前执行记录

- 已在开始改动前创建本地 checkpoint commit：`52b212f chore: checkpoint local workspace changes`；未推送。
- 已落地搜索能力矩阵、作者/专辑集合结果与展开链路：网易云 `type=10/100`、QQ mobile comm `search_type=1/2`，集合不会伪装成歌曲。
- 已落地流媒体来源表 `stream_library`、搜索结果“添加到曲库”、拖入文件夹默认“添加流媒体/下载”设置、文件夹级一键下载未下载来源。
- 已落地三类左侧平台根节点与“我的收藏”入口；网易云登录态可读取远程歌单，QQ 登录态读取创建歌单和收藏歌曲，SoundCloud 因尚未实现 OAuth 仍保留本地流媒体收藏，不伪造远程数据。
- 已落地在线流播放音质设置、B 站预览画质设置、下一首在线流 URL 预加载。
- 尚未完成：Finder/资源管理器原生文件拖入的 Tauri drop 路径导入、SoundCloud OAuth/远程收藏、远程歌单的分页/缓存和流媒体 Track 的独立波形/离线缓存。这些保留为下一阶段，不影响已完成的来源链。
