# .kdjv 视频工程格式（版本 1）

一个 UTF-8 JSON 文件，扩展名 `.kdjv`。KDJ 只读它、不改写它；你保存时整份写入。

```json
{
  "kdjv": 1,
  "title": "开场 · Set A",
  "canvas": { "width": 1920, "height": 1080, "fps": 30 },
  "tracks": [
    { "clips": [
      { "src": "/Users/me/AI/renders/title.mov", "at": 0, "in": 0, "out": 4, "fade_out": 0.5 }
    ] },
    { "clips": [
      { "src": "/Users/me/Music/VJ/city.mp4", "at": 0,  "in": 12.5, "out": 42.5, "muted": true },
      { "src": "/Users/me/Music/VJ/neon.mp4", "at": 30, "in": 0,    "out": 20,   "muted": true, "fade_in": 1 }
    ] },
    { "clips": [
      { "src": "/Users/me/Music/Set/track01.flac", "at": 0, "in": 0, "out": 50 }
    ] }
  ],
  "generated": {
    "/Users/me/AI/renders/title.mov": { "tool": "remotion", "entry": "src/index.ts", "composition": "Title", "props": { "text": "Set A" } }
  }
}
```

## 顶层

| 字段 | 必填 | 说明 |
|---|---|---|
| `kdjv` | 是 | 固定为 `1` |
| `title` | 否 | 曲库里显示的标题；不写用文件名 |
| `canvas` | 否 | `width`、`height`（偶数，2–7680）、`fps`（1–120，默认 30）。不写就跟第一个视频素材 |
| `tracks` | 是 | 轨道数组。**第一条在最上层**，后面的依次在下面；空白处是黑色 |
| `generated` | 否 | 你渲染出来的片段是怎么做的，键是文件路径，值随意（工具、参数），KDJ 不读 |
| 其它字段 | — | 允许存在；保存时必须原样保留 |

## 片段（`tracks[].clips[]`）

时间都是**秒**。

| 字段 | 默认 | 说明 |
|---|---|---|
| `src` | 必填 | 素材路径：绝对路径，或相对 .kdjv 所在文件夹。视频、音频、图片（png/jpg/webp/gif）都可以，不能是另一个 .kdjv |
| `at` | 必填 | 片段在成片里开始的时间 |
| `in` | 0 | 素材里从哪里开始 |
| `out` | 必填 | 素材里到哪里结束（> `in`，不超过素材长度；图片则是显示多久，`in` 写 0） |
| `speed` | 1 | 0.5–2；成片里的长度 = (`out` − `in`) / `speed`，声音保持音高 |
| `volume` | 1 | 0–2 |
| `muted` | false | 静音这一段 |
| `x`, `y` | 0.5 | 画面中心在画布上的位置，0–1 |
| `scale` | 1 | 0.1–2，1 = 适配画布 |
| `opacity` | 1 | 0–1，盖在下层上 |
| `fill` | false | true = 铺满画布（裁掉多出来的边），false = 完整放进画布 |
| `fade_in`, `fade_out` | 0 | 画面和声音的淡入、淡出（秒） |
| `audio_fade_in`, `audio_fade_out` | 同上 | 单独给声音的淡入淡出 |

## 常见写法

- **剪一段**：一个片段，`in`/`out` 取要的部分。
- **拼接**：同一条轨道里一个接一个，后一个的 `at` = 前一个的 `at` + 前一个的长度。
- **把成片的 A–B 秒换成别的画面**：把覆盖 A–B 的原片段拆成三段（A 之前、A–B、B 之后），去掉中间那段，在同一位置（`at` = A）
  放新素材的同样长度；或者在上一层轨道 `at` = A 放一个长度 B−A、`muted: true` 的新片段盖住它（声音照旧）。
- **画面配另一首歌**：视频轨 `muted: true`，下面放一条只有音频的轨道。
- **叠加/画中画**：上层轨道放一个 `scale: 0.35, x: 0.8, y: 0.8` 的片段。
- **交叉淡化**：两个片段在相邻轨道重叠一小段，上面那个 `fade_in` 等于重叠长度。更复杂的转场用 FFmpeg 渲染一段过渡片段放进去。

## 检查

`kdj_project_save` 保存后会检查：素材是否存在、时间是否在素材范围内、参数是否在范围内；返回 `duration`、画布和素材列表。
报错就照着改了再存。
