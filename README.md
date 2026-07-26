# KumoDeck

面向 DJ 的跨平台桌面工作台：**多平台音乐下载 + 视频扒轨 + 曲库分析（BPM / 调性 / 能量 / 和声混音）**。

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
# 前置：Node 20+、Python 3.10+、ffmpeg（macOS: brew install ffmpeg）
npm install
npm run sidecar:setup     # 建 sidecar/.venv 并装 Python 依赖
npm run dev               # Vite + Electron
```

Electron 主进程会自动在随机空闲端口拉起 Python sidecar，健康检查通过后才开窗口。
sidecar 只监听 `127.0.0.1`，且每次启动生成一次性 token。

## 结构

```
electron/       主进程：sidecar 生命周期、窗口、IPC
src/            渲染层：React 19 + zustand，只用 design.css 里的 .kd-* 类
sidecar/        Python：FastAPI + 平台 provider + 分析引擎 + SQLite 曲库
docs/           契约与逐步实现记录
```

- 前后端契约：[`docs/00-architecture.md`](docs/00-architecture.md) —— **改接口先改这份文档**
- 类型双写：`sidecar/kumodeck/models.py` ⇄ `src/types.ts`

## 分析算法

只依赖 **numpy + ffmpeg**，不引入 librosa / scipy / aubio（避免编译型依赖）：

- **BPM**：mel 频谱通量 → 起音包络 → 自相关（对数正态先验抑制倍频）→ 梳状滤波打分选倍频 →
  Ellis 动态规划节拍跟踪 → 由拍间隔中位数回算精修 BPM，并给出首拍偏移与整条节拍网格。
- **调性**：谐波增强 → 音级色度（chroma）→ Krumhansl-Schmuckler 24 调模板相关 → Camelot / Open Key。
- **能量**：RMS / 峰值 / 波峰因数 → 1–10 分级。

细节见 [`docs/00-architecture.md`](docs/00-architecture.md) 第 3 节。

## 不在 Demo 1 范围内

播放器混音与变速、Rekordbox/Serato 曲库互导、云同步、自动更新与签名分发。
