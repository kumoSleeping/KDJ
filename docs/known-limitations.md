# 已知限制

KDJ 不带 FFmpeg（1.1.0-rc19 之后去掉），也不打包自己的解码器：声音由 symphonia 和 kdj-media（纯 Rust）处理，
画面由系统的 WebView 解码和编码（WebCodecs）。下面是因此做不到、交给用户自己的系统播放器的事，以及以后可以怎么补。
遇到用户反馈时先看这里。

## Opus 声音不能播放

symphonia 0.5 没有 Opus 解码器。影响：

- 曲库里的 `.opus` 文件、Ogg 里装的 Opus（`.ogg` 也可能是 Vorbis，Vorbis 能播）播不了，也分析不了。
- WebM / MKV 视频的 Opus 音轨没有声音：画面照放（播放内核按画面长度播一段静音，`kdj-player` 的 `silent_duration`），
  窗口提示「这个视频的声音无法播放」，并提供「用系统播放器打开」。
- YouTube Music 下载因此优先选 AAC（`crates/kdj-providers/src/youtubemusic/provider.rs` 的 `pick_format`），
  只有没有 AAC 时才会拿到 Opus。
- `kdj align` 遇到 Opus 音轨报「读取音轨失败」。

可选方案：引入 libopus（C 库，BSD 许可，`opus` / `audiopus` crate）做解码；或者等 symphonia 自己支持 Opus。
在那之前不加依赖。

## 其他读不了的声音

AC-3 / E-AC-3（杜比）、DTS 等 symphonia 不支持的音轨，处理同 Opus：视频静音播放并提示，`kdj align` 报错。
下载里的杜比音轨不能加 Offset，也不能转成 AAC（报「这个音轨的编码解不了（例如杜比 E-AC-3）……」）。

## 画面解不了的视频

本地视频的画面由 WebView 解码：macOS 是 VideoToolbox，Windows（WebView2）是 Media Foundation，Android 是 MediaCodec，
Linux 是 WebKitGTK 用的 GStreamer。系统不支持的编码（例如 Windows 没装 HEVC 扩展时的 HEVC、旧系统上的 AV1）显示
「无法显示这个视频的画面」和「用系统播放器打开」，声音照常。没有兼容转码。

曲库只收 `mp4`、`m4v`、`mov`、`webm`、`mkv`（`tags.rs::VIDEO_EXTENSIONS`）。AVI、WMV、RMVB、FLV 不进曲库，用系统播放器看。

## 可视化导出

导出用 WebView 的 `VideoEncoder`（H.264）编码画面，音轨复制原曲的 AAC 或用系统 AAC 编码器（macOS AudioToolbox、
Windows Media Foundation、Android MediaCodec）编码。

- macOS 10.15 的 WebKit 和多数 Linux 的 WebKitGTK 没有 `VideoEncoder`：导出键置灰并说明原因，可视化预览照常。
- Linux 没有系统 AAC 编码器：即使有视频编码器，也只能导出原曲是 AAC（M4A）的歌。
- `kdj visualizer render` 由 KDJ 的窗口渲染（`--no-gui` 时隐藏的主窗口也算），同样受这些限制。

可选方案：openh264 软件编码（BSD-2；思科的专利许可只覆盖思科自己发的二进制）加 Opus 或其他不用系统编码器的音频，
工作量较大，用户确有需要时再做。

## 截帧（`kdj peek`）和曲库视频的封面帧

都由 KDJ 的窗口用 `VideoDecoder` 解码。没有 WebCodecs 的系统（macOS 10.15、多数 Linux）上 `kdj peek` 报错，
曲库里没有内嵌封面的视频显示视频图标。WebView 解不了的编码同样如此。YouTube 在线视频要先下载才能截帧。

## 下载

- 不再出 MKV，不再做 CRF 转码，视频一律 MP4。
- 带 Offset，或把非 AAC 音轨（FLAC、FLV 里的 MP3）装进 M4A，要用系统 AAC 编码器重编：Linux 上做不了。
- B 站只给 FLV 单流的老视频：画面是 H.264 才能转封装成 MP4；增强 FLV 里的 HEVC / AV1 不行。
- FLV 里的 MP3 加 Offset 时没有扣除 MP3 的编码器延迟，可能差几十毫秒以内。

## 曲库分析

- MKV / WebM 视频的节拍网格不再按「声音晚于画面开始」的偏移校正（MP4 / MOV 按 edit list 校正）。
- 曲库读时长：标签和 MP4 结构都读不出时，用 symphonia 从容器读；再读不出就空着。
- B 站 Offset 自动校准：本地歌 symphonia 读不了，或在线音轨开头 9 MB 不够解出 30 秒时，直接报错。

## 留在用户数据目录里的旧东西

代码不再读写，也不会自动删除（AGENTS.md：用户数据只增不减）：

- `<data>/ai/`：已删除的内置 AI 的服务商 Key 和会话。
- `<data>/tools/ffmpeg/`：以前在设置里装的 FFmpeg。
- `vj-projects.json`、`workshop-backups/`、各处的 `.kdjv` 工程文件：已移出 KDJ 的剪辑功能的工程，以后用 KDJ 系列的剪辑软件打开。
- `<data>/video-cache/`：旧的兼容转码缓存，设置 → 系统 → 存储空间 能清掉；`<data>/cache/vj-workshop/`、`<data>/cache/renders/`：旧的剪辑渲染缓存和导出记录，要手动删。
