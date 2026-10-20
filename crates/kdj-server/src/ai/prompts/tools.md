# 工具说明

模型看到的每个工具的说明和参数说明都在这里，代码里不写（`kdj-prompts.ts` 读这个文件，`mod.rs` 的测试核对两边一一对应）。

格式：`## 工具名` 下面的正文原样是工具说明；`### 参数` 下面每行 `` - `参数`：说明 `` 是参数说明（数组里的对象写成 `questions[].question`）。
没列出的参数没有说明，模型只看到它的名字和类型。参数的类型、取值范围和工具怎么执行在代码里：`kdj-tools.ts`、`kdj-video.ts`、`kdj-web.ts`。

## kdj_status

KDJ 的状态：各平台登录状态与登录方式、本机浏览器、账号歌单 ref、下载位置。

## kdj_search

在 KDJ 的聚合搜索里搜索，搜索页同时显示这次搜索。text 可以是关键词、分享链接或之前给出的 ref；集合 ref 会直接展开。结果里的 ref 交给 kdj_download。只用来找要下载的东西（新歌、别的版本、视频素材）。曲库里已有的歌（用户拖进来的、kdj_library_list 找到的）不要搜它本身：歌名、歌手、专辑、出自哪部作品看 kdj_library_get，段落看它的小节线和段落，还不清楚用网页搜索。

### 参数

- `text`：关键词、链接或 ref
- `platforms`：只搜这些平台：wyy qqm soundcloud ytm youtube bilibili；默认用 KDJ 设置
- `limit`：每个平台的结果数

## kdj_download

立即下载 kdj_search 给出的 ref（或链接），用户能在下载栏看到，全部结束才返回路径和 track_id。用户未指定音质或分辨率时，先读 kdj_status 的 download.quality 和 download.video_max_height，显式传入对应的 quality 或 height，使用用户设置的默认值；没有目标画质时自动取最接近的较低画质，返回里每个视频带 height，画质低于要的会有 note：照常使用，在给用户的报告里写明。

### 参数

- `to`：目标文件夹的绝对路径，须在曲库根目录内；默认下载文件夹
- `as`：视频只要音轨（audio）或保留画面（video，默认）
- `height`：视频最高画面高度；用户未指定时传入 kdj_status 的 download.video_max_height（省略参数的工具兜底是 1080，不代表用户设置）

## kdj_folders

在曲库根目录和它们的全部子文件夹里按名字找文件夹（不分空格、分隔符，八=8，yue=月），按相似度排序，返回绝对路径 path、相对路径和歌曲数。下到某个文件夹前先用它找到准确的 path，不要自己猜路径。query 留空则列出全部文件夹。

### 参数

- `query`：用户说的文件夹名

## kdj_login

登录平台。wyy/qqm/bilibili 默认扫码，二维码会在用户屏幕上打开；youtube/ytm/soundcloud 或给了 browser 时从本机浏览器导入（见 kdj_status 的 browsers）。完成才返回。

## kdj_library_list

按文本、调性、BPM 区间（如 124..130）、能量或文件夹（绝对路径）筛选本地曲库，不触发分析；KDJ 的曲库页同时显示这次筛选。

## kdj_library_get

曲目详情（bpm、调性、小节线、段落、cue），缺分析时当场补齐（可能要几十秒）。按 id、文件路径或唯一匹配的文本取。时间单位都是秒，grid.downbeats 是小节线。

### 参数

- `beats`：同时返回每一拍的时间

## kdj_library_add_root

把本机一个已有的文件夹加进 KDJ 曲库（和设置里「添加文件夹」一样）：导入其中的歌，并把它登记为曲库根目录，之后它和它的子文件夹会出现在曲库里。用户说「导入到 KDJ」「加进曲库」指的就是这个。已经在某个曲库根目录里的文件夹不用加。只在用户要求时用。

### 参数

- `path`：文件夹的绝对路径

## kdj_play

在 KDJ 里播放曲库中的一首歌：用 kdj_download 或 kdj_library_list 给出的 track_id。

## ask_user

需要用户决定时调用：KDJ 右下角弹出一个气泡。
一件事：question 加文字选项（options）或歌曲选项（songs：kdj_search 给出的 ref，显示封面、歌名、艺术家和来源），multiple 允许多选；给了 timeout（秒）就显示倒计时，到时没选则按 default。返回 choices（选中的选项文字或 ref）和 note。
几件事一起定（比如视频方案）：写 body，用 Markdown 写清你打算怎么做（做法、会下什么、大约多大、最后交什么），短句、列表、粗体都可以；要用户选的地方嵌进标签，系统负责画出来：
- <choice q="问题id" value="值">按钮上的字</choice>：一个按钮，点了就选这个值；
- <media q="问题id" ref="ref"/>：一张素材卡片（封面、标题、来源、时长、打开链接），ref 是 kdj_search 给的或 kdj_library_list 的 library:<id>；不给 q 只展示；
- <shot src="kdj_peek 给出的帧路径">这张图说明什么</shot>：你看过的画面，贴给用户自己判断（字幕、水印、是不是原作）。方案里有视频素材时必须给：每个推荐的视频素材至少一张；能截帧的（在线 B 站、曲库视频）没贴截图，方案会被退回。
同一个问题默认单选；questions 里给 {id, multiple, default} 改成多选或预选。返回 answers（每个问题选中的值）和 note。方案不给 timeout。
用户还可以写一句补充（note），要照着做。用户关掉或点「暂停」则 cancelled 为 true，停下。

### 参数

- `question`：一句问题；写 body 时是标题，可以不给
- `body`：方案：Markdown，嵌 <choice> <media> <shot>
- `preview`：（旧写法）写在问题上面：你打算怎么做
- `questions[].question`：不写 body 时的问题
- `questions[].options`：不写 body 时的选项
- `songs`：kdj_search 给出的 ref
- `default`：选项文字或 ref

## tell_user

做事中途给用户发一条消息，显示在 KDJ 顶部。少用：结果和报告写在最后收尾的那段话里，不用它发。seconds 是停留秒数，不给则一直停留到用户关掉。

## kdj_web_search

搜索网页，返回标题、链接和摘要。用来确认歌名、出处、版本等。

### 参数

- `query`：搜索词，最多 128 字

## kdj_web_fetch

读取一个网页的正文（Markdown，过长会截断）。

## kdj_peek

看视频的画面：从曲库视频、文件路径、bilibili ref 或链接截帧（只有在线 B 站不用下载；YouTube 等其它在线视频截不了，先 kdj_download 下载再截），截下的画面直接给你看（多张时是按时间顺序拼好的一张）。at 是逗号分隔的时间（75,1:30），或用 every 秒数均匀截取。画面只用来核对内容，判断不了音画是否同步。

## kdj_align

把视频按声音对齐到参考曲（音视频合并的核心；short 版 MV/NCED 对整首歌也用它），返回几套定位方案 plans：segments 里 ref = ref_at + (video - video_in) / speed（秒）；ref_bar 是参考曲的小节号。每个视频对一次，结果就是结论（下载后用本地文件再对一次）：ref 用这首歌在曲库里的那一行或用户给的歌文件，不要截取歌的片段、不要把视频变调变速后再对、不要换个参考再试，工作目录里的文件会被拒绝；plans 没覆盖到的部分就是 gaps。每个 segment 原样写成工程里的一个片段（at=ref_at、in=video_in、out=video_out、speed），不拆成镜头重排、不另调速度；ref_at 是参考曲文件里的时间，歌在工程里不是从 0 秒、从头放时，at 再加上歌片段的 at − in。evidence 为 verified 的经过声学核实，auto=true 的可以直接采用；melody / partial 只是候选，auto=false 的方案照样铺好请用户试听确认，不要因为相似度低就换成自己算的位置。一个方案只管它 segments 覆盖的那一段，几套方案可以各管一段。只有部分对得上时用「裁切匹配段」（sections）。每套方案的 gaps 是参考曲里没有画面的空档（start、end、length，秒）：空档怎么填照用户在方案里选的办法（只剪拼时按小节从同一素材里剪；其余在方案里问过用户），不要拉和歌无关的素材填。matched 为 false 是对不上，告诉用户，不要硬拼。

### 参数

- `ref`：参考曲：曲库 id 或用户给的歌文件路径（不能是工作目录里的文件）
- `video`：视频：曲库 id、文件路径、bilibili ref 或链接（YouTube 在线视频对不了，先 kdj_download；不能是工作目录里的文件）

## read

读取文件：技能（skill）的文件、你的工作目录里的文件（相对路径以工作目录为准）、以及 .kdjv 工程。目录则列出其中的文件；图片直接给你看。

### 参数

- `path`：文件或目录路径
- `offset`：从第几个字符读起

## write

在你的工作目录里写一个文本文件（整份覆盖；需要的目录会自动建立）。Remotion 工程在工作目录的 remotion/ 下，组件写在 remotion/src/。

### 参数

- `path`：工作目录里的路径（相对或绝对）

## kdj_probe

读出一个媒体文件的时长、画面（宽高、帧率、编码）和声音（采样率、声道）。

### 参数

- `path`：媒体文件的绝对路径，或工作目录里的相对路径

## kdj_ffmpeg

运行一次 FFmpeg。args 是输出文件之前的全部参数（输入、滤镜、编码），不要写输出文件，也不要写 -y；output 是输出文件（相对路径放进工作目录的 renders/，已存在会覆盖）。返回输出路径和时长；失败时返回 FFmpeg 的最后几行。

### 参数

- `output`：输出文件，例如 intro.mp4

## kdj_remotion_render

用 Remotion 渲染一段画面（标题、动态图形、转场、遮罩）。工程在工作目录的 remotion/（KDJ 装好的 remotion、@remotion/cli、@remotion/transitions、react），入口和组件用 write 写在 remotion/src/。entry 是相对 remotion/ 的入口文件，composition 是要渲染的 id，output 是输出文件（相对路径放进 renders/），props 会作为 inputProps 传入。

### 参数

- `entry`：例如 src/index.ts
- `output`：例如 title.mp4；要透明底就用 .mov 或 .webm，并在 args 里给编码
- `args`：其它 remotion render 参数，例如 --codec=prores --prores-profile=4444

## kdj_project_save

把一个 .kdjv 视频工程（格式见 kdj-video 技能的 references/kdjv.md）写进曲库里的文件夹，KDJ 曲库里会出现这一行，标着「工程」。path 是 .kdjv 文件的绝对路径，必须在曲库根目录内一个已有的文件夹里（用 kdj_folders 找文件夹；它不建文件夹）；document 是整份工程。改已有的工程先用 read 读出整份，改完整份写回：原有的顶层字段一个都不能少。旧版本会先备份到工作目录的 backups/。写入前先检查：不能播放（区间越界、淡入淡出过长、素材不存在…）时不写，直接报错说明原因，改好再保存；通过了才写进曲库，返回时长、画布和素材。

## kdj_project_render

把一个已保存的 .kdjv 工程整片渲染进 KDJ 的缓存。播放不需要它：KDJ 点开工程就实时预览，改了工程也一样，保存后直接 kdj_play。只在用户要求预先渲染时用；改了工程要重新渲染。全部结束才返回（长工程可能要几分钟）。

### 参数

- `path`：.kdjv 文件的绝对路径

## kdj_project_export

把一个已保存的 .kdjv 工程导出成一个 MP4 文件，放进曲库里的文件夹（to，绝对路径，必须在曲库根目录内；不给就放在工程旁边）。只在用户同意导出后用：默认先给 .kdjv 让用户预览。不覆盖已有文件，同名时换一个 name。全部结束才返回。

### 参数

- `path`：.kdjv 文件的绝对路径
- `to`：放 MP4 的文件夹
- `name`：文件名（不含 .mp4），默认和工程同名

## kdj_visualizer_render

可视化生成用：给曲库里的一首歌渲染整首的 KDJ 可视化（歌曲封面 + 频谱，默认样式，不是用户在可视化编辑器里调过的样子），30 fps。也可以用来填 VJ 剪辑里没画面的空档（在 .kdjv 里用 in/out 取需要的一段）。不给 to 时文件在工作目录的 renders/，用它的路径作为 .kdjv 片段的 src；给了 to（曲库里的文件夹，绝对路径）就直接导出成一个 MP4。宽高是偶数，320×180 至 2560×1440（竖屏最多 810×1440）。歌曲要有内嵌封面。全部结束才返回。

### 参数

- `to`：直接导出时放 MP4 的曲库文件夹
- `name`：文件名（不含 .mp4）
