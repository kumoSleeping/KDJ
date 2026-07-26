# 02 · B 站 + SoundCloud：四家 provider 全部纯 Rust 跑通

这一步之后，`sidecar/` 里那 2000 行 provider 代码和它背后的
pyncm / qqmusic-api / bilibili-api / yt-dlp 四个库全部不再需要。

## 真机验证结果

```
cargo run -p kumodeck-providers --example smoke_bili
cargo run -p kumodeck-providers --example smoke_sc -- lofi
```

- **B 站**：搜索 3 条、解析出 2 个画质档（480P/360P，都识别成 AVC）、
  下载 480P 视频 → WBI 签名 playurl → DASH 双流 → ffmpeg `-c copy` 混流 →
  产出 14.7MB MP4；扫码登录链接正常生成。
- **SoundCloud**：搜索 5 条（时长/封面齐全）、resolve 单曲、
  下载 2.7MB MP3，lofty 读回 165.198s，和接口自报的 165.218s 对得上。
  **完全不经过 yt-dlp**。

WBI 的 mixin key 推导和 `w_rid` 都有对拍测试（向量取自 `bilibili_api`）。

## 坑

### 1. B 站搜索被风控：`code=0` 却一条结果都没有

现象：`/x/web-interface/wbi/search/type` 回 `code=0, message="OK"`，
但 `data` 里只有一个 `v_voucher` 字段，没有 `result`。**不报错、不返回错误码**，
纯粹就是"搜不到东西"。

排查过程（这段值得记下来，因为方向错了两次）：

1. 先怀疑 WBI 签名错了 —— 但 playurl 用同一套签名下载成功了，排除。
2. 再怀疑缺 `buvid3`（B 站的设备标识）—— 补了 `finger/spi` 接口拿 buvid3/buvid4，无效。
3. 又怀疑缺 `bili_ticket`（HMAC-SHA256 生成的风控令牌）—— 补了，还是无效。
4. 于是去看 `bilibili_api` 到底发了什么：hook `httpx.AsyncClient.send`
   把最终请求头原样打出来，再用 Rust 逐因素二分：

   | 变量 | 结果 |
   | --- | --- |
   | 完全照抄 Python 的请求 | 42 条 |
   | query 参数改成排序 | 42 条 |
   | 只带 buvid3 / 带 buvid3+buvid4 / **完全不带 cookie** | 42 条 |
   | Referer 结尾加斜杠 | 42 条 |
   | **只把 UA 换回我原来那个** | **0 条 + v_voucher** |

**是 User-Agent。** 我从 Python 版的 `USER_AGENT` 常量抄了
`Chrome/131.0`——那是个不存在的 Chrome 版本号（真实的是 `131.0.0.0` 四段）。
Python 版里这个常量只用于下载和短链展开，搜索走的是 bilibili_api 自带的 UA，
所以这个瑕疵一直没暴露；我移植时把它当成"全局 UA"复用到搜索上，就踩中了。

教训有两条：
- **假成功比报错难查**。QQ 的 `searchid`、B 站的 UA，两次都是
  "接口说成功但结果是空的"。以后遇到"能通但没数据"，第一反应应该是
  逐因素二分对拍，而不是继续往上堆猜出来的参数。
- 猜出来的补丁要**回头删掉**。`buvid3` 和 `bili_ticket` 那两段被证明无效之后
  已经删了，连带 `hmac`/`sha2` 两个依赖也去掉了——留着就是永远没人敢动的死代码。

### 2. `[视频流, 音频流]` 在类型上就不该会错位

Python 版这里有个真实 bug：`detect_best_streams` 返回的是**定长二元组语义**，
未命中的位置是 `None`，而当时的代码 `[s for s in streams if s]` 先过滤再按下标取，
于是"只有音频没有视频"时音频滑到下标 0，被当成视频流下载。

Rust 版直接返回 `(Option<MediaStream>, Option<MediaStream>)`，
下标错位不可能发生。测试 `video_and_audio_positions_never_swap` 钉住了这个场景。

### 3. SoundCloud 的 client_id 只能从 JS bundle 里抓

SoundCloud 不发官方 key，网页端把 `client_id` 硬编码在 bundle 里，
文件名带 hash、每次发版都变。做法：取首页 → 提取所有 `<script src>` →
**倒序**逐个下载扫描（越靠后的 bundle 越可能带）→ 命中就缓存 12 小时。
接口回 401 时清缓存重试一次。

拿到 `client_id` 之后，曲目的 `media.transcodings[]` 里挑 `protocol == "progressive"`
就是一个 MP3 直链，用授权地址换到 CDN URL 直接流式下载——不需要 HLS 分片拼接。

### 4. 安卓的 ffmpeg 退路已经埋好

`download_video` 里判断 `ffmpeg::available()`：
- 有 ffmpeg → 要 `fnval=4048`（DASH），下双流后混流；
- 没有 ffmpeg → 要 `fnval=1`（durl 单文件），下下来**直接就是成品**，不经过 ffmpeg。

安卓走的就是第二条。这条路径现在是写好的，等 Tauri 安卓端起来直接生效。

## 体积账（截至这一步）

砍掉的 Python 依赖：yt-dlp 15MB（含 curl-cffi/deno）、bilibili-api 拖的 lxml 20MB、
qqmusic-api 拖的 cryptography 12MB + QUIC 栈 15MB、pyncm 的 requests 栈、
PIL 14MB（二维码放大改用 `image` crate）。

换来的 Rust 依赖全部编进同一个二进制，没有解释器、没有第二个进程。

## 下一步

分析管线（tempo/key/energy，要和现有 1379 首的结果对齐）、曲库层（SQLite）、
axum server、Tauri 壳。
