# .kdjv 视频工程

KDJ 剪视频的方式：AI 写一个 `.kdjv` 工程，放进曲库文件夹，它就是曲库里的一行，标着「工程」，点开就播放（画面实时拼，不等渲染）。
工程是一张剪辑表——哪些本机文件、在成片的什么时候、从哪到哪、多快、多响、画面在哪、怎么淡入淡出——原文件一个都不动。
手动操作的剪辑器（原 VJ 剪辑工坊）和 VJ 投放已经删掉，代码在 git 历史里；剪辑完全交给 AI。

## 格式

UTF-8 JSON，扩展名 `.kdjv`，`"kdjv": 1`。字段说明写给 AI 看，在技能里：
`crates/kdj-server/src/ai/prompts/skills/kdj-video/references/kdjv.md`（这一份是格式的唯一说明，改格式先改它）。

要点：时间都是秒；`tracks` 的第一条在最上层；`src` 可以是绝对路径或相对 `.kdjv` 所在文件夹；`out` 必填，所以曲库不打开
任何素材就能算出时长；不认识的字段（例如 AI 记录生成片段做法的 `generated`）一律保留。

## KDJ 怎么读它

- **扫描**（`kdj-providers/src/tags.rs`）：`is_media_extension` 认 `kdjv`；`read_tags` 只读 JSON 里的 `title` 和最后一个片段的
  结束时间，`format` 是 `kdjv`。工程不分析、不写标签、不写封面（和图片一样被这些地方跳过）。曲库的「视频」筛选
  包含工程。
- **封面和波形**（`routes.rs`）：封面是工程三分之一处正在放的那个视频素材的一帧（`kdjv::cover_frame`；那里没有视频就取第一个
  视频片段的中间），按工程的 id 和 mtime 缓存；没有视频素材的工程没有封面。波形取自工程的声音（有渲染用渲染，没有就用实时
  预览的混音），播放过之后才有，之前回 409。渲染和混音记在 `<cache>/kdjv-index/`（工程路径 → 工程 mtime 和文件；混音的
  索引文件名带 `.sound`），重启后照样找得到。
- **播放 = 实时预览**（`kdjv.rs::kdjv_preview`，`KdjvLivePicture.tsx`）：点开工程不渲染画面，和原来工坊的预览一样秒开。
  `.kdjv` → 工坊的 `CompositionProject`（每个素材 ffprobe 一次、记签名）→ 只混声音（`mix_file`：8 秒一段的 PCM，几段同时混，
  每段缓存；改了工程只重混变了的段）成 `<data>/cache/vj-workshop/kdjv-sound-<键>.wav`，播放器把它当这一行的文件放。
  画面由窗口实时画：每个正在显示和 2.5 秒内要出现的片段一个静音 `<video>`（图片是 `<img>`），直接读素材原文件
  （`GET /api/kdjv/source/{track}/{n}`，只给这个工程列出的文件，带 Range），按渲染的算法放大、定位、淡入淡出、叠放，
  每个都经 `VideoPlaybackEngine` 跟播放器的时钟走（片段的源时间 = `in` + 进片段的秒数 × 速度）。系统解码，不复制像素。
  预览和渲染可能有细微差别（转场的边缘、解码的取整），以渲染为准；gif 自己循环，不跟时钟。
- **渲染**（`kdjv.rs::kdjv_render`）：工坊原来的声音混合和画面合成（`picture_file`）做成一个 MP4，放在
  `<data>/cache/vj-workshop/kdjv-<键>.mp4`，给「导出 MP4」和 AI 的 `kdj_project_render` 用。键由片段、素材签名和画布算出：
  工程或任一素材变了就重新渲染，没变就直接用缓存（缓存按工坊原来的 2 GB 上限淘汰）。同一个工程同时只渲染一次。
  已经有渲染的工程，点开直接放渲染（和普通视频一样）。
- **路由**：`POST /api/kdjv/preview`（`track_id` 或 `path`：混音、渲染（若有）和实时预览要画的片段，`kdjv.progress` 报混音进度）、
  `GET /api/kdjv/source/{track}/{n}`（实时预览读的第 n 个素材）、`POST /api/kdjv/render`（渲染或找到缓存，`kdjv.progress` 事件报
  进度）、`POST /api/kdjv/check`（只检查：时长、画布、素材，或不能播放的原因）、`POST /api/kdjv/export`（渲染后复制成工程旁的
  `<名字>.mp4`，同名时 `<名字> 2.mp4`…，从不覆盖；曲库右键「导出 MP4」）。曲库的 `/api/library/audio/{id}` 遇到工程时换成
  渲染或混音，`/api/library/video/{id}` 换成渲染，都还没有时回 409。CLI：`kdj project check|render <path>`。
- **画面渲染**（`render.rs`）：每个视频输入用 `-ss` + `-t` 只读片段那一段；画面滤镜图用一半的核心（最多 4 个），给播放留出余量。
- **窗口**（`src/lib/kdjvPlay.ts`）：`playTrack` 遇到工程先要它的混音（缓存里有就立即，没有一般几秒，慢时右下角出一个任务气泡
  显示进度），然后播放同一行（路径换成混音文件，id、标题、「工程」标记不变），视频面板和小窗（`LocalVideoPlayer`、
  `VideoPipHost`）看到 `useKdjvLive` 里有这一行就画实时预览，不加载视频文件。有渲染时路径换成渲染，按普通视频放。
  混音中途用户放了别的歌，混音照样完成但不抢播放。系统画中画不支持实时预览（它只能接一个 `<video>`）。

## 写工程

KDJ 自己从不写 `.kdjv`。AI 用 `kdj_project_save` 保存（`kdj-video.ts`）：只能写进曲库根目录；改已有工程时新内容不能少掉
原有的顶层字段，旧版本先备份到 AI 工作目录的 `backups/`；写入前先在工作目录 `checks/` 里用一份把相对 `src` 换成绝对路径的副本
`kdj project check`，不通过就不写，曲库里不会出现打不开的工程。AI 保存后直接 `kdj_play`，用户看的是实时预览；
`kdj_project_render` 只在用户要求预先渲染时用，进度逐行报给 AI 和它的气泡（`/api/kdjv/render` 带 `"stream": true` 时回 NDJSON）。
用户也可以手写，规则一样。
