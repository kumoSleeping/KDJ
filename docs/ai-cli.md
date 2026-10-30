# KDJ 命令行（给外部 AI agent 用）

`kdj` 让 Claude Code、Codex 这类 agent 替用户在 KDJ 里找歌和视频、下载、截帧、查曲库。KDJ 自己不带 AI。
文件的移动、改名、删除交给 agent 自己的工具；放进曲库根目录的文件 KDJ 会自己跟上。

**安装**：设置 → 系统 → 命令行 →「安装」。macOS 装 `/usr/local/bin/kdj` 软链（需要时请管理员授权），
Linux 装 `~/.local/bin/kdj` 软链（AppImage 链到 AppImage 文件本身；`~/.local/bin` 要在 PATH 里），
Windows 装用户级 `kdj.cmd` 并把它的目录加进用户 PATH。KDJ 更新后入口跟着新版本走，面板显示版本不一致时点「更新」。

**第一步**：`kdj status`。它列出全部命令和参数、各平台登录状态、默认下载目录和曲库根目录；KDJ 没在运行时也能读。
每个命令都有 `--help`。

实现：CLI 在 `src-tauri/src/cli/`（桌面程序本身，带子命令运行时是客户端），服务端在
`crates/kdj-server/src/cli_api.rs`（status / search / download）和 `cli_media.rs`（peek）。

## 约定

- stdout 只有一行 JSON。成功 `{"ok":true,"data":…}`；失败 `{"ok":false,"error":{"code","message","hint"?,"candidates"?}}`。
- `error.code`：`usage`（参数不对）、`not_found`、`ambiguous`（不止一个，附 `candidates`）、`failed`。
- **退出码**：`0` 成功；`2` usage；`1` 其余失败（not_found / ambiguous / failed）。
- 时间单位一律是秒。
- KDJ 没在运行时，除 `status` 外的命令会在后台拉起它（`--no-gui`，不开窗口，主窗口在后台隐藏着）。
- `download`、`login`、`peek`、`visualizer render` 跑到结束才输出，整张歌单或长视频要几分钟，放后台或调大超时；
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
| `kdj library list [--q] [--key 8A] [--bpm 124..130] [--energy N] [--folder DIR] [--limit 50] [--offset 0]` | 查曲库，不触发分析 | `items[]{id,title,artist,duration,bpm,key,energy,rating,path,folder,analyzed}`、`total` |
| `kdj library get --id 1,2 \| --path P \| --q TEXT [--beats]` | 曲目详情；缺分析时当场补齐（可能几十秒） | 单首为对象，多首为 `items[]`：上表字段加 `album,music_key,comment,tags,cue_points,source?{platform,key},grid{bpm,confidence,downbeat_confidence,downbeats[],segments[]{start,end,bpm},beats?[]}` |
| `kdj library add <DIR>` | 和「添加文件夹」一样：导入其中的歌并登记为曲库根目录 | 导入结果 |
| `kdj visualizer render <ID> --out <MP4> [--width W --height H]` | 用歌曲内嵌封面和可视化的默认样式，渲染整首歌的可视化视频（30 fps；偶数宽高，320×180–2560×1440，默认 1920×1080）。由 KDJ 的窗口用系统的视频编码器（WebCodecs）渲染，后台运行时隐藏的主窗口也能接，30 秒内没有窗口接手就失败；系统没有可用的视频编码器（多数 Linux、macOS 10.15）时失败并说明原因；没有系统 AAC 编码器（Linux）时只能渲染原曲是 AAC 的歌；不覆盖已有文件 | `path`、`duration`、`width`、`height`、`fps` |

- 截图只能核对画面内容，判断不了音画是否同步。YouTube 在线视频要先 `download` 才能 `peek`（它的流要界面里的 WebView 准备）。
- 不提供播放控制、队列、下载管理、曲库打分和标签、歌词这类命令：这些由用户在 KDJ 里操作。
