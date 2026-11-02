# .kdjv 视频工程

KDJ 剪视频的方式：剪辑器（抽屉里的「剪辑」）或外部 agent（`kdj project edit`）用剪辑操作写一个 `.kdjv` 工程，放在曲库文件夹里，
它就是曲库里的一行，标着「工程」，点开就播放（画面实时拼，不等渲染）。
工程是一张剪辑表——哪些本机文件、在成片的什么时候、从哪到哪、多快、多响、画面在哪、怎么淡入淡出——原文件一个都不动。
编辑器 2026-10-22 起重写：先做成主线和辅线两条线（格式 2），2026-10-23 改成自由轨道（下面「格式 3」），编辑器只写格式 3。
剪辑在 1.1.0-rc19 之后从 KDJ 拿掉过（273fbe5a），之后搬回来，并去掉了 FFmpeg：声音由 KDJ 自己混（symphonia 解码、WSOLA 变速），
画面由窗口用 WebCodecs 解码、合成和编码（导出见下文）。

## 格式

UTF-8 JSON，扩展名 `.kdjv`，`"kdjv": 1`。格式 1 的字段见 `kdjv.rs` 的 `Doc`/`DocClip`（原来写给内置 AI 的说明在 git 历史里，
1.1.0-rc19 的 `crates/kdj-server/src/ai/prompts/skills/kdj-video/references/kdjv.md`）。

要点：时间都是秒；`tracks` 的第一条在最上层；`src` 可以是绝对路径或相对 `.kdjv` 所在文件夹；`out` 必填，所以曲库不打开
任何素材就能算出时长；不认识的字段（例如 AI 记录生成片段做法的 `generated`）一律保留。

## 格式 3：自由轨道（编辑器写的格式）

`"kdjv": 3`，就是格式 1 的 `tracks`（每个片段带自己的 `at`），每条轨道多了身份：

```json
{
  "kdjv": 3,
  "title": "花ハ踊レヤ VJ",
  "tracks": [
    { "id": "v2", "kind": "picture", "clips": [
      { "id": "c4", "src": "/vj/mv.mp4", "at": 15.9, "in": 0, "out": 40, "speed": 0.906, "muted": true, "fade_in": 1 } ] },
    { "id": "v1", "kind": "picture", "hidden": false, "clips": [
      { "id": "c1", "src": "/vj/ncop.mp4", "at": 0, "in": 0, "out": 91.1, "muted": true, "fill": true } ] },
    { "id": "a1", "kind": "sound", "clips": [
      { "id": "c2", "src": "/music/remix.m4a", "at": 0, "in": 0, "out": 275.1 } ] }
  ],
  "folds": [{ "id": "f1", "tracks": ["v2", "v1"] }]
}
```

- **轨道**：`kind` 是 `picture`（画面）或 `sound`（声音）。第一条在最上层，画面轨上面的盖住下面的；声音轨全部一起出声。
  画面轨上的视频带不带自己的声音看片段的 `muted`；声音轨上的视频只出声音不出画面。`hidden`：这条画面轨不显示；
  `muted`：这条轨不出声；`name`：自己起的名字（不写就叫「画面 1」「声音 2」）。
- **同一条轨道里片段不重叠**：放进来、挪过来、拉长、变慢盖到别的片段上，被盖的就在那里切开、剪短，整个被盖住的去掉，
  被落在中间的切成两段（后半段换新 id）。两条轨道上的片段可以重叠：上面的盖住下面的。
- **转场 = 重叠 + 淡入淡出**：`fade_in`/`fade_out` 是这个片段在成片里淡入、淡出的秒数，最长到片段的整个长度；
  叠在另一条轨道的片段上淡入淡出就是交叉淡化。画面和声音一起淡。
  淡入的片段开始时底下没有画面、而前面的画面正好在这里结束（任一条轨道，相差不到 50 毫秒，它自己没有淡出），就自动是
  交叉淡化：前面那段在它的素材里接着往后放淡入那么长（素材到头为止，图片和 gif 就停在那里），只有画面、静音，垫在淡入
  片段正下面（`kdjv.rs::crossfade_handles`）。文件不改；渲染和实时预览都从这一步之后画，所以两边一样。
- **合并（`folds`）**：挨在一起、同一种的几条轨道显示成一行，只是看的方式，轨道和片段一点都不改：被盖住、被挤短的部分
  都在，展开就能调。`fold` 合并，`unfold` 拆开；删掉轨道后只剩一条的合并自动去掉。
- **剪辑操作**（`tracks.rs`，`POST /api/kdjv/edit` 和 `kdj project edit` 共用）：`new`、`title`、`add_track`（`kind`，`index` 0 是最上面）、
  `remove_track`、`move_track`、`set_track`（`name`、`hidden`、`muted`）、`add`（`clip`；`track` 放进这条，或 `new_track` 在这个位置
  新建一条，或 `kind` 放进这一种的第一条，没有就新建；`at` 不给就接在这条轨道最后一个片段后面；图片不能进声音轨）、
  `move`（`at`，可带 `track` 或 `new_track`；画面片段不能进声音轨，反过来也不能）、`remove`（`ripple` 时这条轨道后面的跟上）、
  `trim`（`in` 改开头时结尾在成片里不动）、`split`、`set`（`speed`、`volume`、`muted`、`x`、`y`、`scale`、`opacity`、`fill`、`crop`、
  `fade_in`、`fade_out`）、`fold`、`unfold`、`restore`、`markers`、`add_title`、`set_title`、`remove_title`。
- **编辑器里拖进来**（`LaneBoard.tsx` `landing`，`laneEditorStore.ts` `placeTracks`）：画面轨上的视频进来就是静音的（`muted`），要它的声音在
  「声音」里打开。松手在一条轨道中间：放进这条，盖住那里原来的；松手在轨道的上下边缘或两条轨道之间（最后一条下面一点也算）：
  在那里新建一条同类的轨道放进去（先 `add_track`，后面的 `add` 用它的 id）。搜索结果下载好才放，不新建轨道。
  按住轨道名上下拖，整条轨道（合并的连同整个合并）换到同类轨道之间的另一个位置（`move_track`），不会插进别的合并中间。
- **新工程放哪、叫什么**（`laneEditorStore.ts` `createFrom`）：第一个文件在曲库的文件夹里，就放在它旁边；不在（别的 App 自己的
  文件夹，比如 QQ 把收到的视频按哈希放在它的沙盒里），就放进默认下载文件夹，否则工程和它旁边导出的 MP4 都在没人看得见的地方。
  名字是歌名加「VJ」或文件名加「剪辑」；文件名是 App 起的（一长串十六进制、UUID）时改用「剪辑 2026-10-25」。
- **改名**（`POST /api/kdjv/rename`，`track_id` 或 `path` 加 `name`；编辑器里双击标题栏上工程的名字）：同一个文件夹里改文件名
  （不覆盖已有的文件，素材按工程文件夹写的相对路径不变），曲库那一行跟着搬（分析、评分、备注都留着），标题改成同一个名字；
  回答和 `/api/kdjv/edit` 一样，编辑器换到新路径。曲库那一行没搬成时文件改回原名。
- **旧格式**：编辑器打开格式 1、2 的工程时按格式 3 显示（只读，不写文件），第一次编辑时写成格式 3。格式 2 换算：主线是
  画面轨 1（空档不留），分叉是它上面的画面轨 2（带淡入淡出和透明度），歌是声音轨 1，一首接一首。格式 1：每条轨道照旧，
  只放声音文件的是声音轨。不认识的字段都留着。旧版本的 KDJ 打不开格式 3（「工程格式版本 3 需要更新的 KDJ」），升级就好。
- 曲库读时长：最后一个片段的结束时间（和格式 1 一样）。

## 格式 2：编辑器的两条线（只读：编辑时转成格式 3）

`"kdjv": 2`。编辑器和 AI 的剪辑操作写这一种；读的时候换算成格式 1 的轨道（`kdjv.rs::Lanes::doc`）：最上面一轨是辅线，
接着是主线，VJ 的歌在最下面。所以播放、实时预览、混音、检查、渲染和导出都和格式 1 一样，不用另写。

```json
{
  "kdjv": 2,
  "title": "ハナヤマタ VJ",
  "song": { "src": "/music/hanayamata.m4a", "in": 0, "out": 275.1 },
  "main": [
    { "id": "a", "src": "/vj/nced.mp4", "in": 0, "out": 30, "muted": true, "fill": true },
    { "gap": 6.6 },
    { "id": "b", "src": "/vj/ncop.mp4", "in": 12, "out": 90, "muted": true }
  ],
  "branches": [
    { "clip": "a", "side": "out", "length": 0.5, "opacity": 1 }
  ]
}
```

- **主线 `main`**：片段一个接一个，像铁轨；`{"gap": 秒}` 是一段黑。片段在成片里的位置由前面所有片段和空档的长度决定，
  不写 `at`。片段的字段和格式 1 一样（`src`、`in`、`out`、`speed`、`volume`、`muted`、`x`、`y`、`scale`、`opacity`、`fill`），
  另有 `id` 给分叉引用。
- **辅线 = 分叉 `branches`**：辅线永远在主线上方，只放交接处的分叉，只有两种：
  `out`——前一个片段的结尾继续往后放 `length` 秒，盖在下一个的开头上；`in`——后一个片段提前 `length` 秒进来，盖在前一个的结尾上。
  默认在整段分叉里淡出（`out`）或淡入（`in`），就是淡入淡出；`opacity` 调透明度，`"fade": false` 不淡、按透明度盖住。
  分叉不出声（声音是主线的），辅线上的分叉不能重叠；`in` 需要片段前面有足够的素材，`out` 需要后面有。
- **VJ 的歌 `song` / 歌曲行 `songs`**：底下的声音，成片的长度就是它的长度，主线超出它的部分在编辑时剪掉。一首歌写 `song`；几首歌写
  `songs`（数组，一首接一首放，合起来是成片的长度和小节线）。剪辑操作 `add_song`（`index` 之前插入，不给就接在最后）、
  `remove_song`、`move_song` 改歌曲行；只剩一首时写回 `song`，所以只认 `song` 的旧版本照样能读一首歌的工程。
  主线、字幕和标记跟着各自的歌走：插进一首歌，它后面的画面整体后移这首歌的长度；挪一首歌，盖在它上面的那段画面一起挪；
  删一首歌，盖在它上面的画面一起删、后面的前移（删到一首不剩时画面留着，成了普通的视频剪辑）。
  不给歌就是普通的视频剪辑。歌曲行（编辑器里叫「声音」）也可以放视频文件：只用它的声音，画面不画（换算成轨道时这一段
  `opacity` 为 0，实时预览和渲染都跳过它）。编辑器里视频松手在「声音」上就是这样放进去的。
- **放进去 / 挪过去**：`add`（带 `at`）和 `move_to` 默认只能放进黑的地方（最后那段黑可以往后延）；带 `"over": true` 就盖在
  原来的东西上，被盖住的片段在它的头尾处切开、剪短，切出来的后半段换新 id。编辑器拖进来和拖动片段都用 `over`。
- **打开**：编辑器打开工程发的是空的操作列表，只读不写（不改文件、不改 mtime）；放不了的工程也能打开，回复里 `problem`
  说为什么。每次回复带 `lengths`（文档里每个素材的时长，按文档里的写法），编辑器据此在素材不够时先剪短片段再做分叉。
- **超出素材的 `out`**：剪辑操作（`/api/kdjv/edit`）先实测每个素材，片段或歌的 `out` 超出文件实际长度时收到文件末尾，
  不报错——曲库的时长常是声音的，比画面长一两百毫秒，MP3 还可能是按码率估的。VJ 里收短的片段后面补黑，后面对好的
  不动；主线超出歌尾的部分剪掉。打开工程时也这样显示，但只在下一次编辑时写回。手写或 AI 写的文件直接播放时仍按原来的
  50 ms 容差检查。
- 曲库读时长（`tags.rs`）：有歌用歌（几首歌的总长），否则是主线的片段和空档首尾相接的总长。

## KDJ 怎么读它

- **扫描**（`kdj-providers/src/tags.rs`）：`is_media_extension` 认 `kdjv`；`read_tags` 只读 JSON 里的 `title` 和最后一个片段的
  结束时间，`format` 是 `kdjv`。工程不分析、不写标签、不写封面（和图片一样被这些地方跳过）。曲库的「视频」筛选
  包含工程。
- **封面和波形**（`routes.rs`）：封面是工程三分之一处正在放的那个视频素材的一帧（`kdjv::cover_frame`；那里没有视频就取第一个
  视频片段的中间）。和本地视频一样由窗口解码：`GET /api/kdjv/cover/{track}` 说是第几个素材的第几秒，窗口用 WebCodecs 解出这帧，
  `POST /api/library/video-cover/{id}` 交给服务端按工程的 id 和 mtime 缓存；没有视频素材的工程没有封面。旧版本给工程行记下的
  「没有封面」标记不算数。波形取自工程的混音，播放过之后才有，之前回 409。混音记在 `<cache>/kdjv-index/`（工程路径 → 工程
  mtime 和文件，文件名带 `.sound`），重启后照样找得到。
- **播放 = 实时预览**（`kdjv.rs::kdjv_preview`，`KdjvCodecPicture.tsx`）：点开工程不渲染画面，秒开。
  `.kdjv` → 工坊的 `CompositionProject`（每个素材读一次容器，`kdj_media::probe`，记签名）→ 只混声音（`render.rs`）成
  `<data>/cache/vj-workshop/kdjv-sound-v2-<键>.wav`，播放器把它当这一行的文件放。
  键只看听得到的东西（`render.rs::heard`：不静音的片段、它们的素材、工程长度），只改画面的编辑还是同一个文件，播放器不重载。
  画面由窗口实时画：每个视频素材按 Range 读原文件（`GET /api/kdjv/source/{track}/{n}`，只给这个工程列出的文件），WebCodecs
  解码，按 `kdjvLive.ts` 的 `clipBox`/`clipAlpha`/`sourceTime` 放大、定位、裁切、淡入淡出，按轨道顺序画在一个 canvas 上
  （docs/video-playback-engine.md）。导出用同一套算法逐帧画，所以预览和成片一样。
- **混音**（`render.rs`，不用 FFmpeg）：每个有声音的素材第一次用到时整段解码一次（`kdj_media::pcm::decode_played`：symphonia，
  跳过 MP4 编辑表里的编码器预滚，48 kHz 立体声），存成缓存里的 `src-<键>.s16`；视频的声音按容器里声音和画面的起点差移开
  （`audio_shift`，原来 ffprobe 的 start_time 差）。然后按 8 秒一段混：每个听得到的片段从中取它那一段，原速时逐个样本照抄，
  变速时用 WSOLA 保持音高（`kdj_media::stretch`，和 FFmpeg 的 atempo 同一种方法：43 ms 的窗半重叠，在 ±11 ms 内找和上一窗
  接得最像的位置），乘音量和淡入淡出（`Fades::alpha`），声音真正开始和结束处加 2 ms 的渐入渐出（纯切开的地方不加），
  全部相加后过一个前看 1 ms、50 ms 放开的限幅器。每段前面多混 0.5 秒再切掉，变速和限幅在段首已经稳定。
  symphonia 解不了的声音（Opus、AC-3 等，docs/known-limitations.md）当作没有声音。
- **素材**：读得了 MP4 / MOV / M4V / MKV / WebM 视频（`kdj_media::probe` 从容器读画面大小、旋转、像素比、帧率、HDR 和时长，
  不解码；窗口解码用的 mediabunny 也只读这四种）、symphonia 解得了的声音、以及图片和 GIF。其他视频容器（AVI、FLV、TS…）
  直接说「请先转成 MP4」。
- **导出**（`export.rs`，`POST /api/kdjv/export`）：先混好要导出那段的声音（`kdjv.progress` 报进度），只要声音
  （`options.audio_only`）就写成工程旁的 `<名字>.wav` 直接回答。要 MP4 时回答一个导出任务（可视化导出的同一套传输：
  `/api/visualizer/jobs/{id}` 的 poll / frames / cancel）、要画的帧（`export`：宽高、整数帧率、`from`/`to` 秒、总帧数、每段帧数，
  第 f 帧是工程的 `from + f / fps` 秒）和工程的画面（`live`）。窗口在后台线程里按实时预览的算法逐帧画（视频按帧解码，
  图片和 GIF 的帧来自 `GET /api/kdjv/image/{track}/{n}?index=&width=`，Rust 解码），转成 BT.709 I420，用 WebView 自己的 H.264
  编码器（优先硬件）一秒一段编成闭合 GOP 上传；服务端检查每段的帧数和参数集，和混音的 AAC（系统编码器）一起写成 MP4，
  校验尺寸、帧数和时长后不覆盖地放到工程旁的 `<名字>.mp4`（同名时 `<名字> 2.mp4`…）。画布大于 3840 × 2160 时等比缩进去。
  同时只有一个导出（可视化或工程）。导出进行中工程文件被写过，且写入改变了导出的内容（按画面、声音、画布、画质和区间的键
  比较，标题、改名、原样再存都不算）就立刻停下：任务 `failed`，`code` 为 `kdjv_project_changed`。窗口重载或关掉，导出就停
  （45 秒收不到窗口的消息）；队列里的任务从头再来。
  编辑器的「导出」和曲库的「导出 MP4」都是「下载 → 导出」队列里的「剪辑」任务（`stores/projectExportStore.ts`）。
- **路由**：`POST /api/kdjv/preview`、`GET /api/kdjv/source/{track}/{n}`、`GET /api/kdjv/image/{track}/{n}`、`GET /api/kdjv/cover/{track}`、
  `POST /api/kdjv/check`（只检查：时长、画布、素材，或不能播放的原因）、`POST /api/kdjv/edit`、`POST /api/kdjv/rename`、
  `POST /api/kdjv/export`、`POST /api/kdjv/title-image`。曲库的 `/api/library/audio/{id}` 遇到工程时换成混音，还没有时回 409；
  `/api/library/video/{id}` 对工程回 400（画面没有文件）。CLI：`kdj project check|edit <path>`。
- **窗口**（`src/lib/kdjvPlay.ts`）：`playTrack` 遇到工程先要它的混音（缓存里有就立即，没有一般几秒，慢时右下角出一个任务气泡
  显示进度），然后播放同一行（路径换成混音文件，id、标题、「工程」标记不变），视频面板和小窗（`LocalVideoPlayer`、
  `VideoPipHost`）看到 `useKdjvLive` 里有这一行就画实时预览，不加载视频文件；工程行还没有它（窗口在播放中重新载入）时
  去要一次（`ensureProjectLive`），其间也不当视频加载。
  混音中途用户放了别的歌，混音照样完成但不抢播放。系统画中画不支持实时预览。
  工程放到结尾就停，不接下一首，结尾前也不混入下一首（自动切歌开着也一样）。关掉剪辑抽屉时，显示它的工程的视频窗一起收起。

## 写工程

剪辑器和 `kdj project edit` 都通过剪辑操作（`tracks.rs`，`POST /api/kdjv/edit`）写工程：操作按顺序做完，能播放才写回，
不认识的字段都留着。打开工程只读不写。用户也可以手写，`kdj project check` 检查能不能播放。
