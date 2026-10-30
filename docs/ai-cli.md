# KDJ 命令行（给外部 AI agent 用）

`kdj` 让 Claude Code、Codex 这类 agent 替用户在 KDJ 里找歌和视频、下载、截帧、做声学定位、查曲库。KDJ 自己不带 AI。
核心命令是 `search`、`download`、`peek`、`align`（声学定位接口）和 `visualizer render`；`status`、`login`、`library` 是辅助。
文件的移动、改名、删除交给 agent 自己的工具；放进曲库根目录的文件 KDJ 会自己跟上。

**安装**：设置 → 系统 → 命令行 →「安装」。macOS 装 `/usr/local/bin/kdj` 软链（需要时请管理员授权），
Linux 装 `~/.local/bin/kdj` 软链（AppImage 链到 AppImage 文件本身；`~/.local/bin` 要在 PATH 里），
Windows 装用户级 `kdj.cmd` 并把它的目录加进用户 PATH。KDJ 更新后入口跟着新版本走，面板显示版本不一致时点「更新」。

**第一步**：`kdj status`。它列出全部命令和参数、各平台登录状态、默认下载目录和曲库根目录；KDJ 没在运行时也能读。
每个命令都有 `--help`。

实现：CLI 在 `src-tauri/src/cli/`（桌面程序本身，带子命令运行时是客户端），服务端在
`crates/kdj-server/src/cli_api.rs`（status / search / download）和 `cli_media.rs`（peek / align）。

## 约定

- stdout 只有一行 JSON。成功 `{"ok":true,"data":…}`；失败 `{"ok":false,"error":{"code","message","hint"?,"candidates"?}}`。
- `error.code`：`usage`（参数不对）、`not_found`、`ambiguous`（不止一个，附 `candidates`）、`failed`。
- **退出码**：`0` 成功；`2` usage；`1` 其余失败（not_found / ambiguous / failed）。
- 时间单位一律是秒。
- KDJ 没在运行时，除 `status` 外的命令会在后台拉起它（`--no-gui`，不开窗口，主窗口在后台隐藏着）。
- `download`、`login`、`peek`、`align`、`visualizer render` 跑到结束才输出，整张歌单或长视频要几分钟，放后台或调大超时；
  中断命令（进程退出、连接断开）即取消对应任务。`library get` 中断只是不再等，分析照常跑完。
- `download` 运行中往 stderr 写进度行 `{"event":"progress","done":N,"total":M}`，数字变了才写；stdout 仍只有最终结果。
- `ref`：`search` 结果和 `status.playlists` 里的短引用，交给 `download` 或 `search`。形如 `wyy:17455790`、
  `bilibili:BV1GJ411x7h7[:p2]`、`youtube:<id>`、`wyy:playlist:42`、`qqm:mine:7`（账号歌单）。存在 KDJ 内存里，
  KDJ 重启后要重新 search；视频 ref（`bilibili:BV…`、`youtube:<id>`）随时可用。

## 命令

| 命令 | 作用 | 返回 `data` |
|---|---|---|
| `kdj status` | 说明和现状；不拉起 KDJ | `cli{version,path}`、`commands[]{usage,about,options}`、`notes[]`、`running`；运行时另有 `kdj{version,matches_cli}`、`accounts[]{platform,label,state,nickname,login[]}`、`browsers[]{id,label,profiles[]}`、`playlists[]{ref,platform,title,count}`、`search{default_platforms,kinds}`、`download{default_dir,library_roots,quality,video_max_height}`、`auto_analysis` |
| `kdj search <TEXT> [--kind song\|playlist\|album\|artist\|radio] [--platform a,b] [--limit N]` | 和 KDJ 搜索框同一条路：关键词、分享链接或 ref；歌单、专辑、歌手的 ref 直接展开 | `items[]{ref,type(song\|video),platform,title,artists,album,duration,max_quality,vip,alternatives?[],page?,heights?}`、`collections?[]{ref,type,platform,title,subtitle,count}`、`title?`、`errors?` |
| `kdj download <REF>... [--to DIR] [--quality flac\|320\|128] [--as audio\|video] [--height N]` | 立即下载（不排在用户队列后面，用户的下载栏里看得到），全部结束才返回。默认下到 `status` 的 `download.default_dir`；`--to` 换成曲库根目录（`download.library_roots`）里任意一个已存在的文件夹 | `complete`、`items[]{ref,title,state(done\|failed\|canceled\|paused),path?,track_id?,error?}` |
| `kdj login <PLATFORM> [--browser ID] [--profile ID]` | wyy / qqm / bilibili 默认扫码（二维码在用户屏幕上打开，请用户用 App 扫）；youtube / ytm / soundcloud 或给了 `--browser` 时从本机浏览器导入登录 | `platform`、`state:"done"`、`account{platform,state,nickname}` |
| `kdj peek <SOURCE> (--at 75,1:30 \| --every 10) [--width 480]` | 截视频画面存成 JPEG；SOURCE 是曲库 id、文件路径、bilibili ref 或链接（在线视频不用下载）；最多 48 张，多张时另给一张按时间拼好的 sheet | `source{…}`、`frames[]{at,path}`、`sheet?{path,columns,rows,order}`、`dir`、`failed?[]` |
| `kdj align --ref <REF> --video <SOURCE>` | **声学定位接口**：把视频或音频的声音对到参考曲上，返回几套定位方案（见下「定位表」）。REF 是曲库 id 或文件路径；SOURCE 是曲库 id、文件路径、bilibili ref 或链接（在线 B 站视频只读它的 DASH 纯音频流，不下载画面）。各读前 30 分钟，声音由 symphonia 解码；读不了的音轨（例如 Opus、E-AC-3）报错 | `reference`、`video`、`matched`、`formula`、`plans[]`、`reason?`、`note?` |
| `kdj library list [--q] [--key 8A] [--bpm 124..130] [--energy N] [--folder DIR] [--limit 50] [--offset 0]` | 查曲库，不触发分析 | `items[]{id,title,artist,duration,bpm,key,energy,rating,path,folder,analyzed}`、`total` |
| `kdj library get --id 1,2 \| --path P \| --q TEXT [--beats]` | 曲目详情；缺分析时当场补齐（可能几十秒） | 单首为对象，多首为 `items[]`：上表字段加 `album,music_key,comment,tags,cue_points,source?{platform,key},grid{bpm,confidence,downbeat_confidence,downbeats[],segments[]{start,end,bpm},beats?[]}` |
| `kdj library add <DIR>` | 和「添加文件夹」一样：导入其中的歌并登记为曲库根目录 | 导入结果 |
| `kdj visualizer render <ID> --out <MP4> [--width W --height H]` | 用歌曲内嵌封面和可视化的默认样式，渲染整首歌的可视化视频（30 fps；偶数宽高，320×180–2560×1440，默认 1920×1080）。由 KDJ 的窗口用系统的视频编码器（WebCodecs）渲染，后台运行时隐藏的主窗口也能接，30 秒内没有窗口接手就失败；系统没有可用的视频编码器（多数 Linux、macOS 10.15）时失败并说明原因；没有系统 AAC 编码器（Linux）时只能渲染原曲是 AAC 的歌；不覆盖已有文件 | `path`、`duration`、`width`、`height`、`fps` |

- 截图只能核对画面内容，判断不了音画是否同步。YouTube 在线视频要先 `download` 才能 `peek`（它的流要界面里的 WebView 准备）。
- 不提供播放控制、队列、下载管理、曲库打分和标签、歌词这类命令：这些由用户在 KDJ 里操作。

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
- 时间都是文件自己的时间：MP4 的声音晚于画面开始（edit list 里的前导空段）时已经加上。`speed` 保留到百万分之一。

- `offset`：视频 0 秒对应参考曲的时间。`similarity` 只在模糊匹配方案上出现。
- `ref_bar`：参考曲小节号（1 起，带小数），参考曲有小节线时才给。
- `auto=false` 的方案需要用户试听确认，不能直接采用。
- 音画是否同步只能看 `evidence` / `similarity`；截图（peek）只能核对画面内容。
