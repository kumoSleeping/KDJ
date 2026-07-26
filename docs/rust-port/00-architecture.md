# 00 · 纯 Rust 重写：架构与取舍

分支：`rust-rewrite`（**未经用户审阅批准前不得合并/切换 main**）。
目标：行为和 v0.1.0 一模一样 → 体积大幅缩小 → 能出安卓安装包。

## 1. 为什么是纯 Rust

v0.1.0 的三平台产物：mac arm64 DMG 155MB / mac x64 160MB / Win EXE 135MB /
Linux AppImage 204MB。体积来源实测：

| 来源 | 大小 | 能不能砍 |
| --- | --- | --- |
| `node_modules/electron/dist` | 242MB（打包后压到 ~80MB） | 换 Tauri 就没了（系统 WebView） |
| `sidecar/.venv` | 163MB | 只有不要 Python 才没 |
| ├ numpy | 25MB | 分析算法自己写就没了 |
| ├ lxml | 20MB | bilibili-api 拖进来的 |
| ├ yt-dlp | 15MB | SoundCloud 自己实现就没了 |
| ├ PIL | 14MB | 只用来放大二维码 |
| ├ qh3 + urllib3-future（QUIC） | 15MB | niquests 拖进来的 |
| └ cryptography + pycryptodomex | 22MB | 只用到 AES/RSA/MD5/SHA1 |

**决定性的约束不是体积而是安卓**：Python sidecar 是一个独立进程，安卓上
应用根本没法 spawn 任意可执行文件。所以"要安卓"和"要纯 Rust"是同一个决定，
不是两个。

## 2. 技术栈

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 壳 | Tauri 2 | 系统 WebView，桌面 + 安卓同一套 |
| 后端 | Rust workspace，**编进 Tauri 进程内** | 没有 sidecar 进程 = 安卓能跑 |
| 传输 | axum + 127.0.0.1 随机端口 + 随机 token | **保留** HTTP/WS 契约 |
| 前端 | **保留现有 React 19 + TS** | 见下 |
| HTTP | reqwest（rustls，不要 OpenSSL） | 交叉编译安卓不用 C 工具链 |
| 加密 | RustCrypto（aes/cbc/ecb/rsa/md5/sha1/hmac） | 纯 Rust，无 OpenSSL |
| 解码 | symphonia | mp3/flac/aac/mp4/ogg/wav 纯 Rust |
| DSP | rustfft / realfft | 替掉 numpy |
| 标签 | lofty | 替掉 mutagen，格式覆盖更全 |
| 数据库 | rusqlite（bundled） | 安卓可用 |
| 二维码 | qrcode（生成） | 替掉 segno + PIL |

### 2.1 前端不换 Svelte

用户最初提的是 "rust+svelte+tauri"，但也说了「不用我的也行」。这里选择**保留 React**：

- 体积上没差别。前端 bundle 现在 gzip 后 ~180KB，换 Svelte 大概省 40KB——
  相对于要砍掉的 300MB 是噪声。
- 现有 5792 行 TSX 是"和原本一模一样"这个验收标准的直接载体。重写它等于
  把风险从"后端算法对不对"扩大到"UI 每一个像素对不对"。
- 真正要改的只有 240 行 Electron glue（`window.kumodeck.*` → Tauri plugin）。

如果之后想换 Svelte，那是独立一件事，不该和"砍体积 + 上安卓"绑在一起。

### 2.2 为什么保留 localhost HTTP 而不是全走 Tauri IPC

- `src/lib/api.ts` 是前后端契约的唯一入口，保留 HTTP 意味着它几乎不动。
- 播放器要 **Range 请求**才能拖动进度条（`/api/library/audio/{id}`），
  IPC 传 base64 大文件是灾难。
- 安卓上绑 127.0.0.1 端口是允许的。
- 代价：axum + tokio 约 +1.5MB。值。

安全模型原样保留：**只绑 127.0.0.1**，每次启动生成随机 token，
HTTP 走 `X-KumoDeck-Token` 头、WS 走 `?token=`，比较用 constant-time。

## 3. Workspace 布局

```
Cargo.toml                    # workspace
crates/
  kumodeck-core/              # models（= src/types.ts 契约）、config、events、db
  kumodeck-providers/         # provider trait + 网易云/QQ/B站/SoundCloud + 各家加密
  kumodeck-analysis/          # decode / tempo / key / loudness / waveform
  kumodeck-library/           # scan / folders / service / tagging
  kumodeck-server/            # axum 路由 + ws + token 鉴权 + 下载队列
src-tauri/                    # Tauri app：起 server、原生对话框、窗口控制
src/                          # 现有 React 前端（保留）
```

## 4. Provider 抽象（用户明确要求的那层接口）

四家平台的差异比想象中大：网易云/QQ 是"搜索 → 拿直链 → 下音频"，
B 站是"解析 → DASH 双流 → 混流成视频"，SoundCloud 没有登录体系。
所以 trait 要能容纳"能力不对齐"这件事，而不是强行让 B 站假装自己是音乐平台。

```rust
#[async_trait]
pub trait MusicProvider: Send + Sync {
    fn platform(&self) -> Platform;
    fn label(&self) -> &str;
    fn capabilities(&self) -> Capabilities;   // supports_login / has_quality_tiers / is_video

    async fn account(&self) -> Account;                       // 不返回 Err，网络问题降级 unknown
    async fn create_qr(&self) -> Result<QrSession>;
    async fn poll_qr(&self, session_id: &str) -> Result<(QrStateValue, String)>;
    async fn logout(&self) -> Result<()>;

    async fn search(&self, keyword: &str, limit: usize) -> Result<Vec<SongSource>>;
    /// 不是本平台的链接返回 Ok(None)，让上层继续问下一个 provider
    async fn resolve(&self, url: &str, limit: usize) -> Result<Option<ResolveResponse>>;

    async fn download(&self, req: DownloadJob<'_>) -> Result<PathBuf>;
}
```

`DownloadJob` 带 `source / quality / cancel: CancellationToken / progress: ProgressSink`，
比 Python 版的四个位置参数好扩展。聚合排序（平台优先级、分档）留在 trait **之上**，
provider 自己不知道别人的存在——和现在一样。

## 5. 三件必须原样带过来的安全约束

1. **host 精确匹配**：判断"是不是本平台链接"必须解析 URL 取 host 比对，
   不能用子串。`?ref=163cn.tv` 曾经能把我们变成盲 SSRF 跳板。
2. **短链逐跳校验**：B 站 b23.tv 展开必须 `redirect::Policy::none()` 手动跟，
   每一跳都重新校验域名白名单 + DNS 出来的 IP 是公网。
3. **先 `.partial` 再原子改名**：ffmpeg/下载都写临时名，校验通过才 `rename`。
   否则失败会把上一次的成品截断成坏文件。

外加：`detect_best_streams` 的 `[video, audio]` 是**定长二元组语义**，
按位置解包、不能过滤 None；文件夹操作的目标路径要过 normalize + realpath 包含性检查。

## 6. ffmpeg 与安卓

现状：v0.1.0 **没有**打包 ffmpeg，视频混流/抽音轨依赖用户机器上有 ffmpeg
（`shutil.which`）。所以"一模一样"= 桌面端仍然可以要求 ffmpeg。

- **桌面**：沿用 ffmpeg 路径（混流 `-c copy`、可选转码），行为不变。
- **安卓**：没有 ffmpeg。两条路：
  1. 向 B 站要 **durl 单流**（`fnval=0/1`）——直接就是一个完整 mp4/flv，不需要混流。
     这是安卓的默认路径。
  2. 后续实现纯 Rust 的 fMP4 remux（video.m4s + audio.m4s → mp4），
     把桌面端也从 ffmpeg 解放出来。列为独立里程碑，不阻塞第一版。
- **分析解码**不再需要 ffmpeg：symphonia 直接解 mp3/flac/m4a/ogg/wav。
  这一条是纯收益——现在没装 ffmpeg 的用户连 BPM 都分析不了。

## 7. 分析算法的数值保真

用户曲库 1379 首已经分析过。如果 Rust 版算出来的 BPM/调号和 Python 版不一致，
和声推荐会整个重排——那是最难被发现、也最伤的回归。

验证方案：
1. 从 `/Users/kumo/git/djay/` 抽 30 首覆盖各种 BPM/调号的曲子；
2. 用现有 Python 分析器跑一遍，落成 golden JSON；
3. Rust 版对同一批文件跑，断言 BPM 完全相等、camelot 完全相等、
   energy 差 ≤1、first_beat 差 ≤20ms；
4. 不达标就调窗口/hop/插值细节，而不是"差不多就行"。

## 8. 安卓的诚实范围

安卓是 scoped storage：没有"任意目录的曲库树"这回事。

- **能做**：搜索、下载（落进应用私有目录 / SAF 选定目录）、播放、
  已下载曲目的 BPM/调号分析、和声推荐。
- **不做（桌面专属）**：多根曲库目录扫描、文件夹拖拽排序、
  `.kumodeck.json` 顺序管理、move/hardlink 操作。

前端按 `/api/health` 回的 `platform` 字段隐藏桌面专属入口。

## 9. 里程碑（依赖顺序）

1. **M0** workspace 骨架 + core models + config + Tauri 起 axum + `/api/health` 通。
2. **M1** SQLite schema + library 只读查询（tracks/stats/folders）。
3. **M2** provider trait + 网易云（weapi/eapi）→ 搜索/解析/下载跑通。
4. **M3** QQ 音乐（musicu.fcg + zzc_sign + vkey）、B 站（WBI + DASH）、SoundCloud（client_id）。
5. **M4** 下载队列 + WS 事件 + 标签写入。
6. **M5** 分析管线 + golden 验证。
7. **M6** 曲库写操作（scan/folders/move/link/manifest）。
8. **M7** 前端接线（Tauri plugin 替 Electron IPC）+ 桌面三平台打包。
9. **M8** 安卓 APK。

## 10. 体积预算（目标）

| 项 | 预估 |
| --- | --- |
| Tauri runtime + WebView glue | 3–5MB |
| Rust 后端（含 rusqlite bundled、rustfft、symphonia、reqwest+rustls） | 8–12MB |
| 前端 bundle | ~0.6MB |
| **桌面安装包合计** | **12–18MB**（对比 135–204MB） |
| **安卓 APK** | **8–15MB** |
