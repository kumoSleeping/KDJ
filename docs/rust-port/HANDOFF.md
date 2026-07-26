# 交接说明 · 纯 Rust 重写

**这份文档是活的，每完成一步都要更新。** 接手的人只读这一份就能知道
"现在到哪了、下一步做什么、哪里有坑"。细节在 `00`~`0N` 各步文档里。

---

## 0. 铁律

1. **不许动 main。** 分支是 `rust-rewrite`。用户明确说过：
   「在我审视完成之后，我允许了才能把正式的分支换成这个当前的尝试分支。」
   没有用户当面点头，不合并、不切换、不 force push。
2. **验收标准三条**：行为和 v0.1.0 一模一样 → 体积大幅缩小 → 能出安卓安装包。
3. **契约不许悄悄改**：`crates/kumodeck-core/src/models.rs` 的字段名必须和
   `src/types.ts` 一一对应。改一个字段就要全量回归 5792 行前端。

## 1. 现在到哪了

| 里程碑 | 状态 | 证据 |
| --- | --- | --- |
| M0 workspace + 契约模型 + 配置 + 事件总线 | ✅ | `crates/kumodeck-core`，22 测试 |
| M2 provider 抽象 + 网易云 | ✅ 真机验证 | `--example smoke_netease` |
| M3 QQ 音乐 / B 站 / SoundCloud | ✅ 真机验证 | `--example smoke_qq / smoke_bili / smoke_sc` |
| M5 分析管线（tempo/key/loudness/decode） | ✅ 40 首真机对拍：调号 98%、能量 100% | `docs/rust-port/03` |
| M1 曲库 SQLite 层 + 文件夹 + 扫描 | ✅ 真实 1379 首曲库集成测试 | `docs/rust-port/04` |
| M4 下载队列 + WS 事件 | ✅ 队列/取消/进度 + `/ws` 实连收到事件 | `crates/kumodeck-server/downloads.rs`、`ws.rs` |
| M6 曲库写操作（scan/folders/manifest） | ✅ 含 move/link/清单顺序 | `crates/kumodeck-library` |
| M7 axum server + Tauri 壳 + 前端接线 | ✅ 34 条路由 + `/ws`；6 条 Tauri 命令；`bridge.ts` 运行时探测壳 | `crates/kumodeck-server`、`src-tauri`、`src/lib/bridge.ts` |
| M8 安卓 APK | ⬜ 未开始（CI 骨架已就位，没在真机上跑过） | `.github/workflows/rust-android.yml` |
| CI：桌面三平台 + 安卓骨架 | ✅ YAML 就位（未在 GitHub 上真跑过） | `docs/rust-port/05` |

跑一遍全部测试：`cargo test --workspace`（当前 275 个）。

前端和壳这一侧的验收命令：`npx tsc --noEmit`、`npm run tauri:web:build`。
`src-tauri` 已经是 workspace 成员，所以 `cargo build --workspace` 会把壳一起编——
**不需要**先跑前端构建：不带 `custom-protocol` feature 时 `generate_context!` 不去读
`dist-tauri/`，CI 里"先 cargo test 再 npm ci"的顺序因此是成立的（已实测）。

曲库层另有一组**跑在用户真实曲库上**的集成测试，默认跳过：

```bash
KUMODECK_TEST_DB="$HOME/Library/Application Support/kumodeck/data/kumodeck.db" \
  cargo test -p kumodeck-library --test real_library
```

（内部会先拷贝再打开，不碰原库。）

## 2. 怎么验证一件事是真的做完了

这个项目里**单元测试通过不等于做完**。四家平台的接口都会
"返回 200 但内容是空的"，所以每个 provider 都配了真机冒烟脚本：

```bash
cargo run -p kumodeck-providers --example smoke_netease -- Supernova
cargo run -p kumodeck-providers --example smoke_qq       -- Supernova
cargo run -p kumodeck-providers --example smoke_bili
cargo run -p kumodeck-providers --example smoke_sc       -- lofi
```

改动 provider 之后**必须**把对应的冒烟跑一遍，看有没有真的搜到东西、
真的下下来文件。只看 `cargo test` 会漏掉全部风控类问题。

## 3. 已经踩过的坑（别再踩一遍）

| 坑 | 症状 | 真因 |
| --- | --- | --- |
| QQ 搜索空结果 | `code=0` 但 `meta.sum=0` | `searchid` 必须是 18~19 位大数，不能传 `"1"` |
| B 站搜索空结果 | `code=0` 但 `data` 只有 `v_voucher` | UA 里的 `Chrome/131.0` 不是真实版本号，要 `131.0.0.0` |
| 网易云偶发登录失败 | 约 1/256 概率 | RSA 结果没左补零到 128 字节 |
| 网易云接口不认 | 间歇性 | weapi 的 base64 必须按 76 列换行且结尾带换行 |
| `/ws` 一律 401 | 进度条永远不动，页面其余部分全正常 | Starlette 的 `@app.middleware("http")` 根本不作用于 websocket 作用域，Python 版的 `/ws` 是**隐式**绕过鉴权中间件的；axum 这边升级请求就是普通 GET，会实打实过中间件，而 token 只能放 query（浏览器 `new WebSocket()` 带不了自定义头）。修在 `auth.rs::accepts_query_token` |

**共同点：三次都是"接口说成功但结果是空的"。** 遇到这种现象，
正确做法是**逐因素二分对拍**（把 Python 版的真实请求头抓出来，一个变量一个变量换），
而不是继续往上堆猜出来的参数。猜出来的补丁被证伪之后**要删掉**——
`buvid3` / `bili_ticket` 那两段就是这么删的，连带去掉了 `hmac`/`sha2` 两个依赖。

## 4. 安全约束（移植时最容易丢的东西）

这四条都是**修过的真实漏洞**，代码里都有注释和测试：

| 约束 | 位置 |
| --- | --- |
| host 精确匹配，不能用子串（盲 SSRF） | `providers/src/net.rs::host_is` |
| 短链逐跳展开 + 每跳校验公网 IP | `providers/src/net.rs::expand_short_link` |
| 先写 `.partial` 再原子改名 | `providers/src/net.rs::AtomicDownload`（靠 `Drop` 保证清理） |
| 媒体直链只挡协议和内网 | `providers/src/net.rs::ensure_media_url` |

另外 `streams::pick_best` 返回 `(Option<video>, Option<audio>)`，
位置固定——Python 版在这里错位过一次，别改成返回 `Vec`。

## 5. 关键设计决定与理由

- **前端保留 React，不换 Svelte。** 体积差异只有几十 KB，而"和原本一模一样"
  这条验收标准的载体就是现有 5792 行 TSX。换框架等于把风险从后端扩大到 UI。
- **保留 localhost HTTP + token，不全走 Tauri IPC。** `src/lib.api.ts` 几乎不用动；
  播放器要 Range 请求才能拖进度条；安卓上绑 127.0.0.1 也是允许的。
- **不走 QQ 的 Android 平台。** Android comm 需要 QIMEI 设备指纹，
  那是 12MB `cryptography` 依赖的唯一用途。Desktop 平台够用（已验证）。
- **解码用 symphonia 不用 ffmpeg。** 安卓没法 spawn 进程；顺带修好
  "没装 ffmpeg 就完全不能分析"这个现存缺陷。
- **B 站视频仍然需要 ffmpeg 混流**（和 v0.1.0 一致）。安卓走 `fnval=1` 要 durl
  单流，下下来直接就是成品，代码里已经埋好分支。

## 6. 下一步该做什么

按依赖顺序：

1. **server 层**（`crates/kumodeck-server`）：38 条路由 + `/ws`，
   清单见 `sidecar/kumodeck/app.py`。token 鉴权用 constant-time 比较。
2. **Tauri 壳**：只需要替掉 240 行 Electron glue
   （`openPath` / `revealPath` / `pickFolder` / `pickFolders` / `windowControl`）。
3. **安卓**：范围要诚实——下载 + 播放 + 已下载曲目的分析；
   多根曲库目录扫描和文件夹拖拽排序是桌面专属。

## 6.1 关于重新分析：用户已明确放行

**曾经**有一条约束是"绝不能重算已分析的曲目"，理由是 Rust 版和 Python 版的 BPM
有约 10% 会选到不同的倍数（见 `03-analysis-pipeline.md`），重算会打乱已有的和声推荐。

**这条约束已经作废。** 用户原话：

> 其实可以把本地的清理一下，然后重算都是没有问题的。
> 已经算好的其实都无所谓，反正现在新算法应该也挺快的。

所以：

- `force = true` 是**正当的用户选项**，UI 上要给入口，不要藏着。
- 全库重算反而是**更好的终局**：现在库里 1217 首是 Python 算的、新下载的是 Rust 算的，
  两套算法混在一起，BPM 的可比性反而更差。统一重算一次就干净了。
- 后台自动分析仍然默认只挑 `analyzed_at IS NULL`——那是为了**省时间**，不再是为了安全。
- 耗时参考：实测 40 首约 100 秒（2 worker），1379 首约 30 分钟，可以当后台任务跑。

## 7. 目录速查

```
crates/kumodeck-core/       契约模型 models.rs、配置 config.rs、事件 events.rs、路径 paths.rs
crates/kumodeck-providers/  net.rs(安全) provider.rs(trait) tags.rs ffmpeg.rs
                            netease/ qqmusic/ bilibili/ soundcloud/
crates/kumodeck-analysis/   dsp.rs decode.rs tempo.rs key.rs loudness.rs engine.rs
                            examples/golden.rs  ← 对拍工具
crates/kumodeck-library/    db.rs camelot.rs service.rs folders.rs scan.rs
                            tests/real_library.rs  ← 真库集成测试
crates/kumodeck-analysis/   ……waveform.rs（波形，给 /api/library/waveform）
crates/kumodeck-server/     routes.rs(34 条路由) ws.rs auth.rs downloads.rs jobs.rs aggregate.rs
                            bin/kumodeck-server.rs  ← 开发用独立进程，端口 8788 / token dev-token
src-tauri/                  Tauri 壳：lib.rs 里 6 条命令 + 进程内起 axum；main.rs 只转调
sidecar/                    Python 原版，**保留着当参照物**，最后再删
src/                        现有 React 前端，保留
src/lib/bridge.ts           运行时探测壳（Tauri / Electron / 浏览器），装回 window.kumodeck
vite.tauri.config.ts        Tauri 专用前端构建（端口 5275、产物 dist-tauri/、剥 index.html 的 CSP meta）
docs/rust-port/             本目录，每步一份
.github/workflows/
  build.yml / test.yml      旧的 Electron + PyInstaller 线，**不许动**
  rust-build.yml            Tauri 桌面三平台（src-tauri 不存在时自动只跑测试）
  rust-android.yml          安卓 APK 骨架，风险写在 YAML 注释里
```

`sidecar/` 现在还是可运行的参照实现，对拍完之前不要删。
