# KDJ — 架构与实现契约（Demo 1）

> 这份文档是**唯一契约**。所有模块按这里的接口、文件名、字段名实现，不得擅自改名。
> 改契约必须先改这份文档。

## 0. 它是什么

面向 DJ 的跨平台桌面软件（Electron）：

- **下载（主）**：网易云 / QQ 音乐 / SoundCloud 的搜索、混合搜索、歌单解析、扫码登录、批量下载、音质梯度降级。
- **视频（次板块）**：哔哩哔哩视频/音轨下载。
- **曲库（核心差异化）**：本地曲库扫描 → BPM / 调性（Camelot）/ 能量 / 节拍网格分析 → 和声混音推荐（Camelot wheel）→ 标签回写。

算法直接沿用已在机器人里跑通的实现：

| 来源 | 复用到 |
| --- | --- |
| `kumocode_v2/entari_plugin_kumo_music_dl/service.py` | `sidecar/kdj/providers/{netease,qqmusic,soundcloud}.py` |
| `kumocode_v2/entari_plugin_kumo_video_dl/service.py` | `sidecar/kdj/providers/bilibili.py` |
| `pi-web-platform/client/src/design.css` | `src/design.css`（红色角标 + 直角 + 扁平） |

## 1. 进程结构

```
Electron main (electron/main.ts)
 ├─ 启动 Python sidecar：<venv>/bin/python -m kdj --port <free> --token <random>
 │    等待 GET /api/health 通过后再 loadURL
 ├─ BrowserWindow (titleBarStyle: hiddenInset, 无圆角风格)
 └─ preload.ts → contextBridge 暴露 window.kdj = { baseUrl, token, platform, openPath, pickFolder, minimize/maximize/close }

Renderer (React 19 + Vite)  ── HTTP/WS ──▶  Python sidecar (FastAPI + uvicorn, 127.0.0.1)
```

- sidecar **只监听 127.0.0.1**，所有请求必须带 `X-KDJ-Token: <token>`（WS 用 `?token=`）。
- 数据目录：`app.getPath("userData")/kdj` → 通过 `--data-dir` 传给 sidecar。
  - `data/kdj.db`（SQLite 曲库）
  - `data/sessions/`（各平台登录态）
  - `Downloads/KDJ/`（默认下载目录，可在设置里改）

## 2. Python sidecar

### 2.1 文件职责（不要跨文件写）

```
sidecar/pyproject.toml
sidecar/kdj/
  __init__.py
  __main__.py        # argparse(--port --token --data-dir --download-dir) → uvicorn.run
  config.py          # AppConfig 数据类 + 落盘 settings.json + 目录解析
  models.py          # 【已给定】pydantic 模型，全部 API 出入参
  app.py             # FastAPI 实例、全部路由、鉴权中间件、WS hub
  events.py          # EventHub：广播 WS 事件（线程安全，供工作线程调用）
  providers/
    base.py          # MusicProvider 协议 + SongItem/PreviewJob/工具函数（sanitize/render_filename/embed_metadata/quality_gradient）
    netease.py       # NeteaseProvider
    qqmusic.py       # QQMusicProvider
    soundcloud.py    # SoundCloudProvider
    bilibili.py      # BilibiliProvider（视频）
  aggregate.py       # 混合搜索：并发搜索 → 归一化 → 相似度聚合 → 排序
  downloader.py      # DownloadManager：任务队列、线程池、进度回调、取消
  tagging.py         # mutagen 读/写（含 BPM/KEY 写回）
  analysis/
    decode.py        # ffmpeg → numpy float32 mono
    tempo.py         # 节拍强度 → 速度估计 → DP 节拍跟踪 → 网格
    key.py           # chroma → Krumhansl-Schmuckler → 24 调 → Camelot
    loudness.py      # RMS / 峰值 / 能量分级
    engine.py        # analyze_file(path) → AnalysisResult
  library/
    db.py            # SQLite 建表 / 迁移 / 连接管理
    scan.py          # 目录遍历 + mutagen 读标签 + 入库
    service.py       # LibraryService：查询/过滤/和声推荐/歌单/统计
    folders.py       # 文件夹模式：目录树 / 越界校验 / 移动与硬链接 / .kdj/manifest.json 清单
```

### 2.2 HTTP API（前缀 `/api`）

鉴权：除 `/api/health` 外全部要求 `X-KDJ-Token`。

| 方法 | 路径 | 入参 | 出参 |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ok: true, version, ffmpeg: bool}` |
| GET | `/settings` | — | `Settings` |
| PUT | `/settings` | `Settings` | `Settings` |
| GET | `/accounts` | — | `Account[]` |
| POST | `/accounts/{platform}/login/qr` | — | `QrSession` |
| GET | `/accounts/{platform}/login/qr/{session_id}` | — | `QrState` |
| POST | `/accounts/{platform}/logout` | — | `Account` |
| POST | `/search` | `SearchRequest` | `SearchResponse` |
| POST | `/resolve` | `{url: str}` | `ResolveResponse` |
| POST | `/intake` | `IntakeRequest`（一大段文本，按行/逗号拆） | `IntakeResponse` |
| GET | `/downloads` | — | `DownloadTask[]` |
| POST | `/downloads` | `DownloadRequest` | `DownloadTask[]` |
| POST | `/downloads/{task_id}/cancel` | — | `DownloadTask` |
| POST | `/downloads/clear` | — | `{removed: int}` |
| POST | `/video/resolve` | `{url: str}` | `VideoInfo` |
| POST | `/video/download` | `VideoDownloadRequest` | `DownloadTask` |
| GET | `/library/tracks` | query: `q,key,bpm_min,bpm_max,energy_min,sort,order,limit,offset,analyzed,folder,folder_deep` | `TrackPage` |
| GET | `/library/tracks/{id}` | — | `Track` |
| PATCH | `/library/tracks/{id}` | `TrackPatch` | `Track` |
| DELETE | `/library/tracks/{id}` | query `delete_file: bool=false` | `{ok}` |
| POST | `/library/scan` | `{paths: str[], recursive: bool=true}` | `{job_id, found: int}` |
| POST | `/library/analyze` | `{track_ids: int[] \| null, force: bool=false}` | `{job_id, queued: int}` |
| POST | `/library/tracks/{id}/write-tags` | — | `Track` |
| GET | `/library/harmonic/{id}` | query `bpm_tolerance=12.0, limit=60, wide=true` | `HarmonicMatch[]` |
| GET | `/library/stats` | — | `LibraryStats` |
| GET | `/library/waveform/{id}` | query `buckets=640` | `{duration, amp[], r[], g[], b[]}`，磁盘缓存 |
| GET | `/library/folders` | — | `FolderTree` |
| POST | `/library/folders/create` | `{parent, name}` | `FolderTree` |
| POST | `/library/folders/rename` | `{path, name}` | `FolderTree`（同时 rebase 该枝下所有曲目的 path） |
| POST | `/library/folders/delete` | `{path}` | `FolderTree`（只删空目录） |
| POST | `/library/folders/init` | `{path?}` | `FolderTree`（每层写 `.kdj/manifest.json`） |
| POST | `/library/folders/order` | `{path, names[]}` | `FolderTree` |
| POST | `/library/folders/move` | `{path, dest_parent}` | `FolderTree`（整枝搬走并 rebase path） |
| POST | `/library/folders/apply` | `{track_ids[], dest, op: "move"\|"link"}` | `FolderOpResult` |
| GET | `/library/audio/{id}` | — | 音频文件流（`Range` 支持，供试听） |
| GET | `/library/cover/{id}` | — | 封面 jpeg/png，无则 404 |

### 2.3 WS `/ws?token=...`

服务端单向推送 JSON：`{ "type": ..., "payload": ... }`

| type | payload |
| --- | --- |
| `download.updated` | `DownloadTask` |
| `download.list` | `DownloadTask[]`（连上时全量一次） |
| `scan.progress` | `{job_id, done, total, current: str, phase: "walk"\|"tag"\|"done"}` |
| `analyze.progress` | `{job_id, done, total, current: str, track_id: int\|null}` |
| `library.updated` | `{track_ids: int[]}` |
| `account.changed` | `Account` |
| `toast` | `{level: "info"\|"warn"\|"error", text: str}` |

## 3. 分析算法（`analysis/`）

> 只依赖 **numpy + ffmpeg**，不引入 librosa/scipy，避免安装摩擦。

### 3.1 decode.py

```python
def decode_audio(path: Path, sr: int = 22050, mono: bool = True,
                 max_seconds: float | None = None,
                 offset: float = 0.0) -> tuple[np.ndarray, int]
```
`ffmpeg -v error -i <path> [-ss offset] [-t max_seconds] -f f32le -acodec pcm_f32le -ac 1 -ar 22050 -`
→ `np.frombuffer(stdout, dtype="<f4")`。ffmpeg 缺失抛 `FfmpegMissing`。

### 3.2 tempo.py — BPM + 节拍网格

1. STFT：`n_fft=2048, hop=512`（→ 帧率 `fps = sr/hop ≈ 43.07 Hz`），Hann 窗。
2. **梅尔化**：64 段 mel 滤波器组（自己写 `hz_to_mel/mel_to_hz` + 三角滤波），取 `log(1 + 10·S)`。
3. **起音强度包络** onset envelope：沿时间做一阶差分 → 半波整流 → 频带求和 → 减去 `sliding mean`（窗 ≈ 0.5 s）→ 再半波整流 → 归一化。
4. **速度估计**：
   - 对 onset envelope 做自相关（用 FFT 加速），lag 范围对应 `bpm ∈ [60, 200]`。
   - 乘以对数正态先验 `exp(-0.5 * (log2(bpm/120) / 0.9)**2)`（同 librosa 思路，防止倍频误判）。
   - 取前 3 个峰做候选；对每个候选用**梳状滤波器打分**（把包络按周期折叠求和，取相位最优值），选得分最高者。
   - 倍频修正：显式比较 `bpm/2, bpm, bpm*2, bpm*1.5, bpm/1.5` 的梳状分，落在 DJ 常用区间 `[85, 175]` 时加 8% 权重。
5. **节拍跟踪（Ellis 动态规划）**：
   - 目标函数 `D[t] = onset[t] + max_τ (α · penalty(τ, period) + D[t-τ])`，`penalty = -(log(τ/period))**2`，`α = 100 * tightness(=100/…)`，回溯得到 beat 帧序列。
   - 由相邻拍间隔中位数**回算精修 BPM**（`60 * fps / median_interval`），这是最终返回的 `bpm`。
6. 输出：
```python
@dataclass
class TempoResult:
    bpm: float              # 精修后，保留 2 位小数
    bpm_raw: float          # 自相关粗估
    confidence: float       # 0..1 = 拍间隔一致性（1 - IQR/median，截断）
    beat_times: list[float] # 秒
    first_beat: float       # 首拍偏移（秒），DJ 对齐用
    beat_interval: float    # 秒
```

**验证要求**：用合成信号自测——以 128 BPM 生成 20 s 的点击轨（每拍一个 20 ms 白噪声爆发），`abs(bpm - 128) < 1.0`；再测 90 / 174 BPM。

### 3.3 key.py — 调性 + Camelot

1. STFT 同上；只取 `65.4 Hz (C2) ~ 2093 Hz (C7)` 范围。
2. **Chroma**：对每个 STFT bin 求其频率 `f` → `midi = 69 + 12*log2(f/440)` → 音级 `pc = round(midi) % 12`，用三角权重把能量摊到最近的两个半音上；每帧归一化（L2）后沿时间取**中位数**（比均值抗鼓点干扰）。
3. 谐波抑制：先对幅度谱沿时间做长度 17 的中值滤波（harmonic-ish），再算 chroma。
4. **Krumhansl-Schmuckler**：大调/小调各一条 12 维模板（用 **Temperley/Albrecht-Shanahan** 修正版，见下），对 12 个旋转求皮尔逊相关，24 个分数取最大。

```python
MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
```

5. **Camelot 映射**（DJ 用的“调号轮”，务必逐条核对）：

| 调 | Camelot | 调 | Camelot |
| --- | --- | --- | --- |
| Ab minor / G# minor | 1A | B major | 1B |
| Eb minor | 2A | F# major | 2B |
| Bb minor | 3A | Db major | 3B |
| F minor | 4A | Ab major | 4B |
| C minor | 5A | Eb major | 5B |
| G minor | 6A | Bb major | 6B |
| D minor | 7A | F major | 7B |
| A minor | 8A | C major | 8B |
| E minor | 9A | G major | 9B |
| B minor | 10A | D major | 10B |
| F# minor | 11A | A major | 11B |
| Db minor / C# minor | 12A | E major | 12B |

6. 输出：
```python
@dataclass
class KeyResult:
    key: str          # "A minor"
    key_short: str    # "Am"
    camelot: str      # "8A"
    open_key: str     # "1m"   （= Camelot 数字 -7 mod 12 + 1，A→m/B→d）
    confidence: float # 最佳与次佳相关系数的归一化差
    chroma: list[float]  # 12 维，前端画图用
```

**验证要求**：合成 C 大调三和弦（C4/E4/G4 正弦）+ G/F 和弦循环 → 结果应为 `C major`(8B) 或其相对小调 `A minor`(8A)；A 小调三和弦（A3/C4/E4）→ `A minor`。

### 3.4 loudness.py

```python
@dataclass
class LoudnessResult:
    rms_db: float       # 20*log10(rms)
    peak_db: float
    crest_db: float     # peak - rms
    energy: int         # 1..10，按 rms_db 分档（-30dB→1 … -6dB→10，线性夹取）
```

### 3.5 engine.py

```python
def analyze_file(path: Path, *, duration_limit: float = 240.0) -> AnalysisResult
```
- 从**音轨 15% 处**开始截取最多 `duration_limit` 秒（跳过 intro 静音/人声铺垫，对 BPM 更稳）；若音轨 < 60 s 则整段。
- 顺序：decode → tempo → key → loudness，任一子分析异常都不能让整体失败（对应字段置 None，记 `errors`）。
- 结果写回 `tracks` 表并广播 `analyze.progress`。

## 4. 混合搜索（`aggregate.py`）

```python
def merge_results(query: str, results: dict[str, list[SongItem]]) -> list[MergedGroup]
```

1. **归一化** `normalize_title`：小写；去 `【】()（）[]` 内的 `live/remix/remaster/伴奏/cover/feat./ft./官方/HQ/高清` 等噪声词；去全部标点与空白；全角→半角。
2. **艺人归一化**：拆分 `/、&,feat.` → set。
3. **相似度** `score(a, b)`：
   - `title_sim` = 归一化标题的 **token 集合 Jaccard × 0.5 + 编辑距离比 × 0.5**（编辑距离自己写，`difflib.SequenceMatcher` 即可）。
   - `artist_sim` = 艺人 set 的 Jaccard（任一为空则 0.5 中性）。
   - `dur_sim` = 两边时长差 ≤ 3 s → 1.0，≤ 8 s → 0.6，否则 0.0（缺时长则 0.5）。
   - 总分 `0.6*title_sim + 0.3*artist_sim + 0.1*dur_sim`，`>= 0.82` 判为同一首。
4. 贪心聚类（按各平台原排名交错遍历，先到先成簇）。
5. 组排序：`源数量 × 0.35 + 与 query 的 title_sim × 0.5 + 平台优先级 × 0.15`（平台优先级 wyy=1.0, qqm=0.95, soundcloud=0.8）。
6. `MergedGroup.best_source`：优先有 flac 标记的源，其次平台优先级。

## 5. SQLite（`library/db.py`）

```sql
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  title TEXT, artist TEXT, album TEXT, genre TEXT, year TEXT,
  duration REAL,           -- 秒
  bitrate INTEGER, samplerate INTEGER, channels INTEGER,
  format TEXT,             -- mp3/flac/m4a/wav
  size INTEGER,
  bpm REAL, bpm_confidence REAL,
  first_beat REAL,
  music_key TEXT,          -- "A minor"
  camelot TEXT,            -- "8A"
  open_key TEXT,
  key_confidence REAL,
  energy INTEGER,
  rms_db REAL, peak_db REAL,
  rating INTEGER DEFAULT 0,
  color TEXT,
  comment TEXT,
  cue_ms INTEGER,
  source_platform TEXT,    -- wyy/qqm/soundcloud/bilibili/local
  source_key TEXT,
  analyzed_at TEXT,        -- ISO8601，NULL = 未分析
  added_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  file_mtime REAL,
  analysis_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracks_camelot ON tracks(camelot);
CREATE INDEX IF NOT EXISTS idx_tracks_bpm ON tracks(bpm);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL, track_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE TABLE IF NOT EXISTS tags (
  track_id INTEGER NOT NULL, tag TEXT NOT NULL,
  PRIMARY KEY (track_id, tag)
);
```

**和声推荐**（`library/service.py::harmonic_matches`）：给定曲目的 Camelot `nA/nB`，兼容目标为
`同号`、`±1 同字母`（n±1 mod 12）、`同号异字母`（相对大小调）、`+7 同字母`（能量提升，可选），
并且 `abs(bpm - target_bpm) <= tolerance`（或 ±半速/倍速匹配）。返回按 `bpm 差 + 调性距离` 升序。

## 6. 前端

### 6.1 视觉规范（`src/design.css`，已给定）

- **零圆角**：所有 `border-radius: 0`。
- **红色角标** `.kd-corner-badge`：绝对定位挂在容器左上角外侧（`-0.5rem`），红底白字、大写、`font-weight: 800`、`letter-spacing: .05em`。
- 底色 `#f2f2f2`，卡片纯白 + 1px `#e5e7eb` 描边 + 极淡阴影；主色 `--kd-theme: #ef4444`。
- 数字一律 `font-variant-numeric: tabular-nums`（BPM / 时长 / 进度）。
- 深色模式：`:root[data-theme="dark"]` 覆写 token（DJ 场景默认深色，但两套都要能看）。

### 6.2 路由 / 布局

```
App
├─ TitleBar         （可拖拽区、窗口按钮、右侧全局搜索）
├─ Sidebar          （下载 / 曲库 / 视频 / 设置 四个板块 + 队列徽标）
└─ <section>
   ├─ DownloadView   搜索栏(平台多选 + 混合开关) → 结果表 → 选中加入队列 → QueuePanel
   ├─ LibraryView    工具条(扫描/分析/过滤) → TrackTable → 右侧 TrackDetail(含 CamelotWheel + 波形/节拍网格) 
   ├─ VideoView      URL 输入 → 视频信息卡 → 画质选择 → 下载（仅音轨开关）
   └─ SettingsView   账号(扫码登录卡) / 目录 / 音质 / 分析参数 / 主题
└─ PlayerBar        （底部试听条：波形进度、BPM、Camelot、音量）
```

### 6.3 文件清单（不要新增未列出的顶层文件）

```
src/main.tsx
src/App.tsx
src/design.css
src/types.ts            # 【已给定】
src/lib/api.ts          # 【已给定】fetch 封装 + WS 客户端
src/lib/format.ts       # 时长/字节/BPM/日期格式化
src/lib/camelot.ts      # Camelot 轮相关纯函数 + 配色
src/stores/appStore.ts     # zustand: 当前板块、设置、toast
src/stores/downloadStore.ts# 队列 + WS 事件接入
src/stores/libraryStore.ts # 曲库列表、筛选、选中、分析进度
src/components/common/{CornerBadge,Panel,Button,Field,Table,EmptyState,ProgressBar,Toasts}.tsx
src/components/chrome/{TitleBar,Sidebar}.tsx
src/components/download/{DownloadView,SearchBar,ResultTable,MergedGroupRow,QueuePanel}.tsx
src/components/library/{LibraryView,LibraryToolbar,TrackTable,TrackDetail,CamelotWheel,BeatGrid,HarmonicList}.tsx
src/components/video/VideoView.tsx
src/components/settings/{SettingsView,AccountCard,QrLoginDialog}.tsx
src/components/player/PlayerBar.tsx
```

## 7. 运行

```bash
cd kdj
npm install
npm run sidecar:setup     # uv venv + uv pip install -e sidecar
npm run dev               # vite + electron 并行
```

## 8. Demo 1 的边界（明确不做）

- 不做实际的播放器混音/时间伸缩，试听只用 `<audio>`。
- 不做云同步、不做 Rekordbox/Serato 数据库导出（预留 `docs/roadmap.md`）。
- 不做自动更新、不做代码签名打包分发。


---

## 9. 文件夹模式（`library/folders.py`）

**文件夹就是磁盘上的文件夹**，不是数据库里的虚拟分组。DJ 出场前要把一套歌拷进
U 盘、要用 Rekordbox / Serato 再读一遍，虚拟分组到那一步就没了。

- **根目录** = `Settings.library_dirs`。`POST /library/scan` 会把显式扫描的目录
  自动登记进去；老库（`library_dirs` 为空但已有曲目）由 `infer_roots()` 从曲目
  路径反推一次并写回设置。
- **越界校验**：所有写操作的 `dest` 必须同时通过「归一化路径在某个根下」和
  「realpath 在该根的 realpath 下」两道检查。前者挡 `..`，后者挡符号链接逃逸。
- **移动** = `shutil.move`（支持跨卷）+ `LibraryService.relocate()` 改 path，
  分析结果与人工标记原样保留。同名不覆盖，自动加 ` (2)`。
- **链接** = `os.link` → 失败退 `os.symlink` → 再退 `shutil.copy2`，
  然后 `upsert_file()` 建新行 + `clone_metadata()` 把分析结果抄过去。
  一首歌同时进两个 set 不多占空间。`Track.link` 字段告诉前端打不打链接标记。
- **顺序** 存在每个目录里的 `.kdj/manifest.json`（`{version, order: [子目录名]}`）。
  每目录一份而不是根目录一份大清单：清单跟着文件夹走，拷贝/搬移之后依然成立。
  升级时优先读新位置，同时兼容旧 `.kdj.json`；新文件原子提交并校验成功后才删除旧文件。
  清单里有磁盘上没有的名字直接丢弃，磁盘上有清单里没有的按名字排在后面。
  读坏了只退回按名字排序，不让整棵树打不开。

## 10. 彩色波形（`app.py::_band_waveform`）

模型来自 libdjwaveform / Serato：**一列 = 一根柱子，高度是响度，颜色是频谱构成**。
Serato 的交叉点：红↔绿 ≈ 200 Hz，绿↔蓝 ≈ 1.5 kHz。

高度取三段功率之和开根号，再做 P5–P99 对比拉伸（只除 P99 的话，压过的母带整首
挤在 0.6~1.0，画出来是一条实心带）。

颜色取**这一列的频段占比相对全曲常态占比的偏离量**，γ=6。试过并否掉的两种：
三段同尺度直接当 RGB（中频带宽最宽，整首绿成一片）；三段各按自己的 P95 归一
（三段响度高度相关，归一后每列都接近白）。配色前沿时间轴做滑动平均，
不平滑的话每根柱子颜色都跳，出来是彩色噪点；高度不参与平滑。


## 11. 界面结构

**一个工作台，没有板块。** `ViewId = "workspace" | "settings"`。

```
标题栏           KDJ · (N 个下载中) · 日夜切换
大搜索框         去网上搜歌来下：输入 / 目录 / 音质 / 音乐·视频 / 批量 / 搜索
平台条           网易云 · QQ · SoundCloud · 混合去重      （视频模式下隐藏）
状态行           曲库 N 首 …   ／  搜索结果 N 首 · [加入队列] [回曲库]
筛选条           调号 / BPM / 能量 / 已分析 / 扫描 / 分析  （只在曲库模式）
─────────────────────────────────────────────────────────
文件夹树   │  曲目表  ／ 搜索结果 ／ 视频详情  │  曲目详情 ／ 下载队列
─────────────────────────────────────────────────────────
播放条           ⚙设置 · 播放 · 唱片位 · 曲名 · 波形进度 · 时间
```

搜出结果 → 中间换成候选、右边换成下载队列；「回曲库」关掉结果就回到曲库。
理由：找歌 → 下载 → 进曲库 → 排 set 本来是一条线上的动作，
拆成并列板块之后每做一步都要先想"我现在该在哪个板块"。

两个搜索框职责分开，不并排：顶上的大框搜**网上的歌**，
文件夹栏顶上的小框筛**已经有的歌**。

详情栏顺序：分析 → 接下一首（限高 13rem，内部滚动）→ 文件 → 标记 → 调号轮。

设置在左下角（播放条最左的齿轮），再点一次回工作台。

### 分析的两条通道

- **批量**：`analysis_pool`，2 个 worker。工具栏上有进度条和**停止分析**
  （`POST /library/analyze/cancel`）。取消是协作式的——只在每首开始前检查一次，
  正在跑的那首会跑完；中途硬杀会留下半写的数据库行。
- **插队**：`priority_pool`，1 个 worker。播放条放到一首还没分析的歌时自动触发
  （`AnalyzeRequest.priority=true`）。"现在放的是什么速度什么调"是最急的一条信息，
  不能让它排在几百首后面。插队任务不进 `current_analysis`，
  「停止分析」停的是批量那批，不会把它一起掐掉。

### 文件夹树的两个计数

- 无标记的数字 = 库里有几首（`total_count`）
- 红色 `+N` = 磁盘上有、库里还没有（`pending_count`）。**点这个文件夹就自动扫描导入**，
  按设置决定要不要顺带分析。用户不该为了看见歌先去顶栏点一次「扫描目录」。

### 曲库根目录不允许嵌套

`resolve_roots()` 会把互相包含的根只留最外层。点子目录触发的自动导入也会扫描，
如果每次扫描都登记成根，那个子目录会同时以"根"和"父目录的子节点"两个身份
出现在树上。写入端（scan 路由）和读取端（resolve_roots）都做了收口。
