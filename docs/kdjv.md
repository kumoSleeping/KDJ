# .kdjv 视频工程

KDJ 剪视频的方式：AI 写一个 `.kdjv` 工程，放进曲库文件夹，它就是曲库里的一行，标着「工程」，点开像普通视频一样播放。
工程是一张剪辑表——哪些本机文件、在成片的什么时候、从哪到哪、多快、多响、画面在哪、怎么淡入淡出——原文件一个都不动。
手动操作的剪辑器（原 VJ 剪辑工坊）和 VJ 投放已经删掉，代码在 git 历史里；剪辑完全交给 AI。

## 格式

UTF-8 JSON，扩展名 `.kdjv`，`"kdjv": 1`。字段说明写给 AI 看，在技能里：
`crates/kdj-server/src/ai/skills/kdj-video/references/kdjv.md`（这一份是格式的唯一说明，改格式先改它）。

要点：时间都是秒；`tracks` 的第一条在最上层；`src` 可以是绝对路径或相对 `.kdjv` 所在文件夹；`out` 必填，所以曲库不打开
任何素材就能算出时长；不认识的字段（例如 AI 记录生成片段做法的 `generated`）一律保留。

## KDJ 怎么读它

- **扫描**（`kdj-providers/src/tags.rs`）：`is_media_extension` 认 `kdjv`；`read_tags` 只读 JSON 里的 `title` 和最后一个片段的
  结束时间，`format` 是 `kdjv`。工程不分析、不写标签、不写封面、没有波形（和图片一样被这些地方跳过）。曲库的「视频」筛选
  包含工程。
- **播放**（`compositions/workshop/kdjv.rs`）：`.kdjv` → 工坊的 `CompositionProject`（每个素材 ffprobe 一次、记签名）→ 用工坊
  原来的声音混合（`mix_file`）和画面合成（`picture_file`，`render_export` 拆出来的两段）渲染成一个 MP4，放在
  `<data>/cache/vj-workshop/kdjv-<键>.mp4`。键由片段、素材签名和画布算出：工程或任一素材变了就重新渲染，没变就直接用缓存
  （缓存按工坊原来的 2 GB 上限淘汰）。同一个工程同时只渲染一次。
- **路由**：`POST /api/kdjv/render`（`track_id` 或 `path`，渲染或找到缓存，`kdjv.progress` 事件报进度）、`POST /api/kdjv/check`
  （只检查：时长、画布、素材，或不能播放的原因）。曲库的 `/api/library/video|audio/{id}` 遇到工程时换成它最近一次的渲染，
  还没渲染过时回 409。CLI：`kdj project check|render <path>`。
- **窗口**（`src/lib/kdjvPlay.ts`）：`playTrack` 遇到工程先要渲染；缓存里有就立即播放，没有就在右下角出一个任务气泡显示进度，
  渲染好后播放同一行（路径换成渲染文件，id、标题、「工程」标记不变）。渲染中途用户放了别的歌，渲染照样完成但不抢播放。

## 写工程

KDJ 自己从不写 `.kdjv`。AI 用 `kdj_project_save` 保存（`kdj-video.ts`）：只能写进曲库根目录；改已有工程时新内容不能少掉
原有的顶层字段，旧版本先备份到 AI 工作目录的 `backups/`；保存后立即 `kdj project check`。`kdj_project_render` 预先渲染。
用户也可以手写，规则一样。
