# KDJ

面向 DJ 的跨平台桌面工作台：**多平台音乐下载 + 视频扒轨 + 曲库分析（BPM / 调性 / 能量 / 和声混音）**。

> **当前唯一正式技术栈：Rust + Tauri。** 旧 Electron 壳与 Python sidecar 已停用，
> 仅保留为历史参考；不得再用于开发、运行、测试或打包。

算法承接自已经在生产环境跑通的机器人插件
（`kumocode_v2/entari_plugin_kumo_music_dl`、`entari_plugin_kumo_video_dl`），
按桌面端的交互重新组织；界面沿用 `pi-web-platform` 的视觉语言：**零圆角 + 红色角标 + 扁平卡片**。

## 三个板块

| 板块 | 能做什么 |
| --- | --- |
| **下载**（主） | 网易云 / QQ 音乐 / SoundCloud 的关键词搜索、**跨平台混合搜索去重**、歌单与分享链接解析、扫码登录、批量下载、音质梯度自动降级（FLAC → 320 → 128） |
| **曲库**（核心） | 目录扫描入库 → **BPM + 节拍网格**、**调性 + Camelot 轮**、能量分级 → 和声混音推荐、标签写回文件（Rekordbox / Serato / Traktor 都能读） |
| **视频**（次） | 哔哩哔哩视频下载，支持 **只扒音轨（.m4a）** —— 现场 / Mashup 素材的高频路径 |

## 跑起来

```bash
# 前置：Node 20+、Rust 1.85+、Tauri 平台依赖、ffmpeg
npm install
npm run dev               # Rust + Tauri 桌面开发
npm run typecheck         # 前端类型检查
npm run build             # Tauri 正式构建
```

`npm run dev` 等价于 `npm run tauri:dev`。应用后端编进 Tauri 进程，不启动 Electron，
也不启动 Python sidecar。

## 结构

```
crates/         Rust：核心模型、平台 provider、分析、曲库与 HTTP 服务
src-tauri/      Tauri 桌面壳与 Rust 后端生命周期
src/            React 19 + zustand 前端
electron/       已停用，只读历史代码
sidecar/        已停用，只读 Python 参考实现
docs/rust-port/ Rust 重写架构与迁移记录
```

- 当前架构：[`docs/rust-port/00-architecture.md`](docs/rust-port/00-architecture.md)
- Rust 交接说明：[`docs/rust-port/HANDOFF.md`](docs/rust-port/HANDOFF.md)

## 分析算法

当前分析实现位于 `crates/kumodeck-analysis/`，使用纯 Rust DSP 与 Symphonia 解码：

- **BPM**：mel 频谱通量 → 起音包络 → 自相关（对数正态先验抑制倍频）→ 梳状滤波打分选倍频 →
  Ellis 动态规划节拍跟踪 → 由拍间隔中位数回算精修 BPM，并给出首拍偏移与整条节拍网格。
- **调性**：谐波增强 → 音级色度（chroma）→ Krumhansl-Schmuckler 24 调模板相关 → Camelot / Open Key。
- **能量**：RMS / 峰值 / 波峰因数 → 1–10 分级。

细节见 [`docs/rust-port/03-analysis-pipeline.md`](docs/rust-port/03-analysis-pipeline.md)。

## 不在 Demo 1 范围内

Rekordbox/Serato 曲库互导与云同步。
