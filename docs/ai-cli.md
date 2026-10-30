# KDJ CLI（给 AI 用）

KDJ 只提供 AI 自己做不到的事：平台搜索、登录、下载，曲库里的分析结果，在线视频截帧，音频对齐。
文件的移动、改名、删除、剪辑交给 AI 自己的工具（shell、ffmpeg）。设置 → 让 AI 操作 KDJ →「复制提示词」
给出的提示词只让 AI 先跑 `kdj status`，其余全由 `status` 说明。

实现：CLI 在 `src-tauri/src/cli/`（同一个桌面二进制，有子命令时当客户端），服务端在
`crates/kdj-server/src/cli_api.rs`（status / search / download）和 `cli_media.rs`（peek / align）。

## 约定

- 输出一行 JSON。成功 `{"ok":true,"data":…}`；失败 `{"ok":false,"error":{"code","message","hint?","candidates?"}}`，
  code ∈ `usage`（参数错，退出码 2）/ `not_found` / `ambiguous`（附 `candidates`）/ `failed`（退出码 1）。
- 时间单位一律是秒。
- KDJ 没在运行时，除 `status` 外的命令会在后台拉起 `--no-gui` 驻留进程。
- `download`、`login`、`peek`、`align` 跑到结束才输出；中断命令（进程退出、连接断开）即取消，KDJ 停掉对应任务、ffmpeg 和分析。
  `library get` 中断只是不再等待，分析照常跑完。
- `download` 运行中往 stderr 写进度行 `{"event":"progress","done":N,"total":M}`，只在数字变化时写；stdout 仍只有最终结果。
- `ref`：`search` 结果和 `status.playlists` 里的短引用，交给 `download` 或 `search`。
  形如 `wyy:17455790`、`bilibili:BV1GJ411x7h7[:p2]`、`youtube:<id>`、`wyy:playlist:42`、`qqm:mine:7`（账号歌单）。
  存在 KDJ 内存里，重启后需重新 search；视频 ref 不依赖缓存，随时可用。

## 命令

| 命令 | 作用 | 返回 `data` |
|---|---|---|
| `kdj status` | 唯一的说明文件；KDJ 没运行也能用，不拉起它 | `cli{version,path}`、`commands[]{usage,about,options}`（clap 生成）、`notes[]`、`running`；运行时另有 `kdj{version,matches_cli}`、`accounts[]{platform,label,state,nickname,login[]}`、`browsers[]{id,label,profiles[]}`、`playlists[]{ref,platform,title,count}`、`search{default_platforms,kinds}`、`download{default_dir,library_roots,quality,video_max_height}`、`auto_analysis` |
| `kdj search <TEXT> [--kind song\|playlist\|album\|artist\|radio] [--platform a,b] [--limit N]` | 与搜索框同一路径：关键词、分享链接、ref；集合 ref 直接展开 | `items[]{ref,type(song\|video),platform,title,artists,album,duration,max_quality,vip,alternatives?[]{ref,platform,max_quality},page?,heights?}`、`collections?[]{ref,type,platform,title,subtitle,count}`、`title?`、`errors?` |
| `kdj download <REF>... [--to DIR] [--quality flac\|320\|128] [--as audio\|video] [--height N]` | 立即下载（不排在用户队列后，用户下载栏可见），全部结束才返回 | `complete`、`items[]{ref,title,state(done\|failed\|canceled\|paused),path?,track_id?,error?}` |
| `kdj login <PLATFORM> [--browser ID] [--profile ID]` | wyy/qqm/bilibili 默认扫码（二维码图片在用户屏幕打开）；youtube/ytm/soundcloud 或给了 `--browser` 时从本机浏览器导入 | `platform`、`state:"done"`、`account{platform,state,nickname}` |
| `kdj library list [--q] [--key] [--bpm 124..130] [--energy N] [--folder DIR] [--limit] [--offset]` | 查曲库，不触发分析 | `items[]{id,title,artist,duration,bpm,key,energy,rating,path,folder,analyzed}`、`total` |
| `kdj library get --id 1,2 \| --path P \| --q TEXT [--beats]` | 缺分析当场补齐（基础 + 节拍网格）再返回 | 单首为对象，多首为 `items[]`：上表字段 + `album,music_key,comment,tags,cue_points,source?{platform,key},grid{bpm,confidence,downbeat_confidence,downbeats[],segments[]{start,end,bpm},beats?[]}` |
| `kdj peek <SOURCE> (--at 75,1:30 \| --every 10) [--width 480]` | 截帧；SOURCE 为曲库 id、文件路径、bilibili ref 或链接（在线不下载）；最多 48 张 | `source{…}`、`frames[]{at,path}`、`sheet?{path,columns,rows,order}`、`dir`、`failed?[]` |
| `kdj align --ref <id\|path> --video <SOURCE>` | 把视频对齐到参考曲；在线 B 站视频只读音轨；读前 30 分钟 | 见下 |
| `kdj project check <PATH>` | 打开一个 `.kdjv` 视频工程（`docs/kdjv.md`）：能否播放、为什么不能 | `title`、`duration`、`width`、`height`、`fps`、`sources[]`、`ready` |
| `kdj project render <PATH>` | 把 `.kdjv` 工程渲染进 KDJ 的缓存，之后在 KDJ 里点开立即播放；全部结束才返回，中断命令不取消渲染 | `path`（渲染文件） |
| `kdj visualizer render <ID> --out <MP4> [--width W --height H]` | 用歌曲内嵌封面和编辑器的默认工程渲染整首的可视化（30 fps，偶数宽高 320×180–2560×1440）：由打开着的 KDJ 窗口按编辑器的导出路径渲染（WebCodecs，不需要 FFmpeg）；8 秒内没有窗口接手时，服务端用 FFmpeg 画基础样式（需要已安装 FFmpeg）；不覆盖已有文件，全部结束才返回 | `path`、`duration`、`width`、`height`、`fps` |

YouTube 在线视频的 peek / align 需要先 download（它的流要界面里的 WebView 准备）。

## 定位表（`kdj align`）

```json
{
  "reference": {"path": "…", "title": "…", "duration": 212.3, "track_id": 1},
  "video": {"ref": "bilibili:BV1GJ411x7h7", "title": "…", "duration": 213.0, "online": true},
  "matched": true,
  "formula": "ref = ref_at + (video - video_in) / speed，单位秒",
  "plans": [
    {"id": "whole", "label": "完整对齐", "evidence": "verified", "auto": true, "speed": 1.0, "offset": 0.0,
     "segments": [{"video_in": 0.0, "video_out": 212.3, "ref_at": 0.0, "speed": 1.0, "ref_bar": 1.0}]}
  ],
  "reason?": "…", "note?": "…"
}
```

| `id` | 含义 | `evidence` | `auto` |
|---|---|---|---|
| `whole` | 整段固定偏移 | verified | true |
| `sections` | 按音乐编排切开的多段（只往前，不重复用视频） | verified | true |
| `speed-whole` | 有速度差：按最长核实片段推算整段位置；`verified` 列出真正核实过的视频区间 | verified | true |
| `speed-sections` | 有速度差的多段 | verified | true |
| `melody-N` | 旋律候选（翻唱、换伴奏等弱对应） | melody | false |
| `short-N` | 短版分段（前段对应 + 后段跳到更晚位置） | partial | false |
| `<id>-beat-whole` | 上面某个方案对到歌的拍上（`beat_lock.rs`：视频自己的拍和歌的拍配对，最小二乘拟合速度和起点），整段视频按这个速度放（保留完整） | 同原方案 | 原方案 auto 时为 true |
| `<id>-beat` | 同上，只放匹配到的那一段（裁切匹配段）；多段方案每段各自对拍（对拍分段） | 同原方案 | false |
| `<id>-beat-bend` | 同上，歌里节奏有变化时分成几段，每段自己的速度，首尾相接（分段变速） | 同原方案 | false |

- 同一个找到的位置的几种放法 `group` 相同，`group_label` 说它怎么找到的、在哪、多快；`label` 是放法（保留完整 / 裁切匹配段 /
  分段变速 / 不对拍）。能对拍时原方案改叫「不对拍」、不再 auto。同一录音的 `whole` / `sections` 已按采样对齐，不再对拍。
- `beat`：对拍的方案才有，`error_ms` 是配上对的拍离歌的拍的中位误差（毫秒），`matched` / `beats` 是配上的拍数 / 这段视频的拍数。
- 时间都是文件自己的时间：视频的声音流晚于画面开始（`audio_shift`）时已经加上。`speed` 保留到百万分之一。

- `offset`：视频 0 秒对应参考曲的时间。`similarity` 只在模糊匹配方案上出现。
- `ref_bar`：参考曲小节号（1 起，带小数），参考曲有小节线时才给。
- `auto=false` 的方案需要用户试听确认，不能直接采用。
- 截图只能核对画面内容；音画是否同步只能看 `evidence` / `similarity`。
