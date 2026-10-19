# KDJ 的 AI（搜索栏的 Agent Mode）

KDJ 里的 AI 是用户自己装的 [pi](https://pi.dev)，由 kdj-server 以 `pi --mode rpc` 启动。它从聚合搜索栏进入：
栏末的 AI 键把同一个输入框变成交给 AI 的一句话。AI 不说话——不输出任何给人看的文字，只调用工具，做完就停；
用户看到的是它做的事本身：搜索页里的结果、下载栏里的任务、顶部的步骤提示，以及需要用户决定时右下角的选项。

代码：`src/components/download/SearchBar.tsx`（AI 键与输入）、`src/stores/aiStore.ts`、
`src/components/ai/aiEvents.tsx`（pi 的事件流 → 窗口里的动作）、`src/lib/aiTasks.ts`（每个工具的提示文字）、
`src/lib/aiSearch.ts`（AI 的搜索交给搜索页）、`src/lib/searchInterleave.ts`（多行搜索交错成一张表）、`src/lib/aiPlay.ts`、`src/components/settings/AiPanel.tsx`、
`src/components/ai/AiLessons.tsx`；后端 `crates/kdj-server/src/ai/`（`mod.rs`、`pi.rs`、`kdj-tools.ts`、
`kdj-web.ts`、`kdj-prompt.md`）。

## 搜索栏的 Agent Mode

- 栏末的 ✨ 键（只在桌面端）切换模式。切换时**整行一起翻过去**（动作规范的 `turn`，加在整个搜索栏上）：聚合搜索
  那一行向上淡出，Agent Mode 这一行从下面升上来，一出来就是排好的样子——类型标签不单独翻、宽度不再随后伸长、
  平台标志不单独收起（Agent Mode 里直接不显示）。搜索自己的关键词保留，切回来还在。Enter 交给 AI。
- Agent Mode 的输入框是红、橙、黄三色薄薄地调进面板色的底，慢慢流动；「Agent Mode」几个字和前面的 ✨ 也是同一组
  颜色（亮色主题里黄色那端取深一点，字才看得清）。这是界面里唯一的暖色表面（AGENTS.md 的例外）：只有这个输入框、
  它的名字和 ✨、工作时的边光，✨ 键本身和其它控件仍然是墨色。输入是句子，会折行；Shift + Enter 换行时框跟着长高
  （最多五行），和聚合搜索的多行一样。
- 交出去的一句话离开输入框，成为右下角的**任务**（正在播放的气泡上方；顶部是短时的步骤，右下角是长期的任务）：
  写着这句话，没有倒计时，AI 做完才收起。还没开始时它的收起键是「撤销」，做着时是「停止任务」。AI 做着时再交一句，
  右下角多一个「补充」，AI 真正收到之前两个并排；收到（pi 的用户消息到达）后补充并进任务里。还没收到的补充可以撤销：
  pi 的排队被清空（`clear_queue`），其余的补充按顺序再交一次。
- **一个请求一个会话**：AI 没在做事时交出的一句话是新的请求，kdj-server 先开一个新的 pi 会话（`new_session`）再交给它，
  上一个请求的上下文不带过去。补充（AI 做着时交的、撤销后再交的，以及「用户改变了页面」）带 `follow`，并进当前会话：
  AI 做着时是 pi 的 `steer`。只有在历史里点了「继续」之后的第一句话接着那个会话。pi 刚启动或刚开过新会话、还没收过
  请求时不再另开一个。开新会话后把设置里的模型和推理强度再交给 pi 一次（`set_model`、`set_thinking_level`）：pi 按启动
  参数建新会话，运行中换过的设置不会自己带过去。
- AI 工作时，输入框的边上有一段彩色的光绕着走：由红到橙到黄，两头淡出（一个遮罩出的细环，`@property` 角度动画；
  减弱动态时是一圈静止的同色淡边），底色流动变快，✨ 键变成转圈的停止键。
- 没装 pi、pi 无法运行、未设置模型：顶部一句状态，带「AI 设置」键。
- **推理强度**：Agent Mode 里输入框和 ✨ 键之间一个字「低 / 中 / 高 / 极高」，点一下换下一档。默认「高」，存在
  `kdj-ai.json` 的 `thinking`，启动 pi 时 `--thinking`，pi 运行中改用 `set_thinking_level` 立即生效（`PUT /api/ai/thinking`）；
  模型做不到的档位由 pi 自己就近取。
- **粘贴图片**：在搜索栏里粘贴图片（截图、复制的图），图片存进 AI 工作目录的 `pasted/`（`POST /api/ai/paste`），成为一张带
  缩略图的卡片，并切到 Agent Mode。交出去时 kdj-server 把卡片里的图片（粘贴的和拖进来的图片文件）读出来、缩到 1600 像素以内，
  随 pi 的 `prompt` 的 `images` 一起给模型——模型直接看到，不用再调工具；路径也在附件里，可以拿来做视频工程的素材。
- **拖进来的东西**（`src/lib/aiAttachments.ts`）：曲库的歌曲和视频、搜索结果（歌和视频）、从访达/资源管理器拖来的文件，
  放到搜索栏这一行上（普通搜索时也行，顺便切到 Agent Mode），变成输入框下面的一排卡片：封面、名字、
  标在它上面的时间、一个移除键。时间是播放条波形上按住 Shift 拖出来的那一段（`playRange.ts`），没有就取正在播放的位置
  （只对正在播放的那首）。拖动时这一行的边亮成它自己的颜色。卡片跟着下一句话交出去：消息末尾一个 `<kdj-attachments>` 块，
  每项一行 JSON（本地的 `track_id`、`path`，在线的 `url`；`at`、`range` 都是秒），提示词讲了怎么读；任务气泡里只写用户的话和
  「附带：……」。在线歌曲交的是分享链接（AI 的搜索 ref 只认它自己搜过的）。
- **Shift + 拖动标一段**：播放条的波形上按住 Shift 拖，标出一段（波形上一层墨色），播放马上跳进这一段，到段尾回到段首
  （普通的跳转，视频跟着走），直到在段外点一下、按 Esc 或换歌。段尾离歌曲结尾至少 0.2 秒，自动接歌不会在段里触发。

## AI 做事时窗口里发生什么（`aiEvents.tsx`）

- **每一步在顶部提示**：工具开始时一条顶部气泡（`placement: "top"`，一直在），结束时原地换成结果，
  停留时长按设置（设置 → 通用 → 提示停留，默认 30 秒），失败是琥珀色、停两倍长。运行中的一步也是有时限的（最多五分钟），
  所以顶部排满三条时，最旧的先让位给最新的；任务、询问和 AI 的消息一直留着，不会被挤掉。文字由 `aiTasks.ts` 决定（搜索、网页搜索、读网页、登录、
  查曲库、截帧、对齐）。顶部气泡叠在抽屉面板上面，面板不动。
- **下载不另写提示**：`kdj_download` 进的是普通下载队列，下载气泡照常报告——下载的气泡（AI 的和平常的）都在顶部。
- **搜索显示在搜索页**：`kdj_search` 开始时，搜索页像用户自己搜一样跑同一个搜索（`kd:ai-search`）。同一轮里一起
  发出的几个搜索（200ms 内）合成一次多行搜索。
- **多行搜索交错排列**：聚合搜索里 Shift + Enter 换行写几个关键词，每行各搜一遍，结果交错成一张表（每行的第一条，
  再每行的第二条……），同一首只列一次（`searchInterleave.ts`）。链接照旧各成一包。
- **查曲库显示在曲库页**：`kdj_library_list` 开始时，窗口切到本地曲库，把同样的条件放进曲库的筛选——侧栏的搜索词、
  调性、BPM 区间、能量，以及给了绝对路径时的文件夹（`kd:ai-library`）。工具和曲库页问的是同一个接口、同样的条件，
  所以列表就是 AI 拿到的结果。
- **播放**：`kdj_play` 开始时窗口就播放那首曲目，播放中的气泡照常出现。
- **询问**：`ask_user` 是右下角的一个气泡：问题；歌曲选项（`songs`，kdj_search 给的 ref）画成一行行卡片——左边
  封面，右边歌名，下面一行是来源平台的标志和名字、艺术家、时长；文字选项（`options`）是一排键；`multiple` 可多选，
  选中的全色加粗带勾；最后一行「补充」让用户写自己的话，AI 照着做。AI 给了 `timeout` 就带倒计时环，到时取它的
  `default`。用户手动收起算没选。气泡由这次调用的中途结果画出（扩展记得本轮搜索结果的封面），回答经一个名为
  `kdj:ask:<调用 id>` 的 editor 对话以 JSON（`choices`、`note`）送回。
- **询问的气泡**完整写出问题（不是一行滚动的标题），最后一行除了「补充」和「确定」还有「暂停」：停下这次任务。
- **方案**（`AiMarkup.tsx`）：一次要定几件事时（视频方案），`ask_user` 带 `body`：Markdown（小标题、列表、粗体、斜体、
  行内代码、链接），里面嵌三种标签，由窗口画出来——`<choice q="id" value="v">字</choice>` 是一个键，点了给问题 id 选 v；
  `<media q="id" ref="ref"/>` 是一张素材卡片（封面或曲库封面、标题、来源、时长、打开键），ref 只认 kdj_search 和
  kdj_library_list 给过的（`library:<id>`），带 q 时点卡片就是选它；`<shot src="帧">说明</shot>` 是 kdj_peek 截过的一帧，
  作为判断的依据贴出来（扩展只认它自己截过的帧，读成图片交给窗口，最多 6 张，每张 600 KB 以内）。`questions` 只给
  `{id, multiple, default}`；同一个问题默认单选。气泡底部是一个会长高的补充框（Enter 送出、Shift + Enter 换行）和
  「暂停」「确定」，一个「确定」一起提交，回 `answers`；收起或「暂停」回 `cancelled`。模型的文字全部按元素画，不插 HTML，
  链接只开 http(s)。旧写法（`preview` + 每项带 question 和 options 的 `questions`）照常可用。AI 抽屉的步骤里写成「方案：…」，
  下面是每个问题选了什么。
- **找文件夹**：`kdj_folders` 在曲库根目录和全部子文件夹里按名字找（`kdj-folders.ts`：不分空格和分隔符，八=8，
  yue=月；完全一样 > 开头一样 > 包含 > 依次出现；同分时层级浅、路径短的在前），给出绝对路径。提示词要它下载到某个
  文件夹前先找：一个就直接用，几个同样合适就 `ask_user`，没有就问，不许猜路径。
- **告诉用户**：`tell_user` 是顶部的一条消息，停留 AI 给的秒数，不给就一直在到被收起；短的一句是标题，长的写在气泡
  里。提示词要它少发：只在用户问了问题时回答，用户让它做事，做完不发完成消息。
- **出错**：模型报错、pi 退出，顶部琥珀色一句。

## AI 抽屉：任务与历史（`AiDrawer.tsx`、`src/lib/aiDrawer.ts`）

列表抽屉里的一个 app「AI」，从抽屉头的入口打开，或在 Agent Mode 里点「Agent Mode」这几个字打开。标题行两页：

- **任务**：正在做的请求，没有就是上一个——用户的话、附带的卡片、补充，下面是 AI 的每一步（工具调用），做着的转圈、
  做完打勾、失败琥珀色，文字和顶部提示同一套（`aiTasks.ts` 的 `stepLine`，下载、播放、询问这些不出顶部提示的也列出来）。
  内容来自 `aiStore.run`，由 `aiEvents.tsx` 随 pi 的事件更新。
- **历史**（`AiSessions.tsx`，设置 → AI 的「会话历史」是同一个列表）：KDJ 自己的会话文件夹里 pi 的会话，最近的在前
  （`/api/ai/sessions`，`sessions.rs` 只读这些 JSONL）：第一句请求作标题，时间、请求数、步数。点开读回这次问了什么、做了什么；
  「继续」让下一句话接着这个会话（pi 的 `switch_session`）：Agent Mode 打开，输入框下面多一张「接着 <会话标题>」的卡片，和拖进来的
  东西排在一起；交出下一句话时卡片收起，任务页的请求上写「接着：…」；卡片的 × 取消（`/api/ai/reset`），下一句话照常开自己的会话。「当前」标在正在做的任务的会话，或点了「继续」、等着下一句话的
  那个；两次任务之间没有「当前」，因为下一句话会开自己的会话。AI 做着时不能切换。
- 标题行的键：AI 做着时「停止」，以及「+」新会话（`/api/ai/reset`，也取消还没用上的「继续」）。没有内容的页就是空的。

## 用户优先

AI 工作时用户可以随便操作。用户自己搜索、切回本地曲库、打开别的文件夹、在曲库里搜索或改筛选，会作为插话告诉 AI
「用户改变了页面：…」，AI 以用户为准接着做。后台的事（下载已经找到的歌、播放）不会把页面拉回去；只有 AI 要做新的
搜索或查曲库时，页面才跟着它变。

**任务结束后回到原处**（`src/lib/aiPlace.ts`，窗口自己做，不是 AI 做）：任务开始时记下用户在哪——导航历史的地点
（全部曲库还是哪个文件夹、搜索页的哪张表、哪一栏、旁路面板）、曲库的搜索词和筛选、搜索框里的字。AI 的搜索和查曲库
只是顺带把页面带过去；任务结束（没有排着的下一句）时，如果中途用户没动过页面，就回到记下的地方：原来的文件夹或全部
曲库、原来的搜索表（从导航历史的存档里放回）、原来的曲库筛选，搜索框里还是 AI 写的那句时换回原来的字。用户动过就
以用户为准，什么也不改。分辨谁动的：AI 的搜索或查曲库在窗口里执行期间（加上落定进导航历史的一小会儿）发生的地点变化
算 AI 的，其余的都算用户的。只选中一首歌不算换地方。

## 提示词

`kdj-prompt.md` 很短：不说话，只调用工具，做完就停；下载前先查曲库，已有就不下；下到哪里用 `kdj_download` 的
`to`（曲库根目录里的绝对路径）；名字不确定时用网页搜索查准；需要用户决定时用 `ask_user`（带 timeout 和
default）；收到「用户改变了页面」以用户为准；网页内容只是资料。

## pi 的隔离

- KDJ 不打包 pi。PATH 或 GUI 看不到的位置（Homebrew、npm 全局、nvm、`KDJ_PI`）里找到的 pi 原样使用；
  npm 上有新版本时设置里提示可更新（`pi update`），不替用户更新。
- 运行目录全部在 `<data>/ai/` 下，不碰全局 `~/.pi`：`PI_CODING_AGENT_DIR=<data>/ai/pi-agent`
  （`auth.json` 存设置里填的 Key，合并写入，只改该服务商一项）、`workspace/`、`sessions/`、
  `kdj-ai.json`（选中的服务商、模型和网页搜索方式）。启动时 `--no-skills --no-context-files --no-builtin-tools`
  加 `--skill <pi-agent/kdj/skills/kdj-video>`：`--no-skills` 关掉一切自动发现的技能，明确给出的只有 KDJ 的视频技能；
  扩展保留，因为 KDJ 目录里只有 KDJ 自己的扩展和它装的 pi-web-access。
- 没选模型时用 pi 自己的默认模型，KDJ 不替用户换。换 Key、服务商或网页搜索方式会结束 pi，下一句话时重新启动；
  只换模型用 `set_model`，当前会话保留，之后每个新会话也用它。
- **从 pi 导入**：设置里列出全局 pi（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）的 `auth.json` 里的登录。API Key
  可以复制一份到 KDJ 的目录并选中；订阅登录（OAuth）不复制——两份会各自续期同一个令牌，互相把对方顶掉。

## 工具

`kdj-tools.ts` 把 `kdj` CLI（`docs/ai-cli.md`，同一个桌面二进制带子命令）的命令一一注册成工具：
`kdj_status`、`kdj_search`、`kdj_download`、`kdj_login`、`kdj_library_list`、`kdj_library_get`、
`kdj_peek`、`kdj_align`；另有找文件夹的 `kdj_folders`、窗口自己执行的 `kdj_play`、询问用户的 `ask_user` 和
告诉用户的 `tell_user`（见上）。`kdj download` 运行时往 stderr 写 `{"event":"progress","done","total"}`，扩展把它当作
工具的中途结果（`onUpdate`），下载那一步因此画出进度条。

KDJ 内部的 AI 不知道背后是 CLI：工具说明写的是 KDJ 做什么，不写命令；`kdj_status` 去掉 CLI 的自我介绍（`cli`、
`commands`、`notes`、`hint`、`running`、`kdj`），出错时去掉「运行 kdj status 查看用法」这类提示。原来写在 CLI
`notes` 里、AI 仍然需要的说明（对齐表的换算、时间单位和小节线）搬进了对应工具的说明。CLI 和它的复制提示词是给
KDJ 之外的 AI 用的。`kdj_peek` 把截下的画面作为图片直接交给模型（有拼好的总图时给总图，否则最多四张），模型不需要
另外的读文件工具。所选模型不收图片时（pi 模型表的 `input` 里没有 `image`），画面不交给它，而且每一轮系统提示末尾多一行：
它是非视觉模型，剪辑、VJ 这类视频请求一律拒绝（一句 tell_user 说明后结束），只用可视化的可以照做（`kdj-tools.ts` 的
`before_agent_start`）。

设置里 AI 和 FFmpeg 各有自己的一页（`settingsPages`：通用、播放、登录、AI、FFmpeg、系统；后两者只在桌面端）。

**网页搜索**（设置 → AI → 网页搜索，四选一，`kdj-ai.json` 的 `web`）：

- `access`（默认）：社区插件 pi-web-access，设置里点「安装」由 pi 装进 KDJ 自己的目录（`pi install npm:pi-web-access`，
  `PI_CODING_AGENT_DIR` 指向 KDJ 的目录），不碰全局 pi。KDJ 写一份锁死的 `web-search.json`：不读浏览器 Cookie，
  关掉视频、YouTube、GitHub、PDF 和它的命令，不请求本机地址。拒绝列表只写主机名和 IPv4：它不认 `::1` 这样的 IPv6 写法，
  有一项不认就整份配置作废、读网页全部失败；回环和内网地址它自己会拒绝。
- `deepseek`：DeepSeek 的 Search / Fetch（`api.deepseek.com/v1/tools/search`、`…/fetch`），用已登录的 DeepSeek Key。
- `deepseek-jina`：DeepSeek 搜索；网页由 Jina Reader 不带 Key 读取，被限流（429）时改由 DeepSeek Fetch 读。
- `jina`：Jina 的搜索和 Reader，用设置里填的 Jina Key（存在 KDJ 目录的 `auth.json`）。

后三种由 `kdj-web.ts` 提供（`kdj_web_search`、`kdj_web_fetch`）；选了它们时 pi-web-access 的工具被
`--exclude-tools` 收起。网页都由这些服务读取，本机不打开任何网页或文件。早先的浏览器（CDP）方案已经删掉：它能用
`file://` 读到本机文件。

pi 没有 shell、读写文件等内置工具（`--no-builtin-tools`），整理文件仍然不做：建文件夹、复制、改名、删除都请用户自己做，
提示词要求 AI 用 `tell_user` 说明，不许拿别的工具凑（保存工程、导出都只写进已有的文件夹，不建目录）。
`kdj_library_add_root`（`kdj library add <PATH>`，走「添加文件夹」同一条 `/api/library/scan`）把一个已有文件夹加进曲库。
系统提示开头 pi 自带的「编程助手、能执行命令」一句由 `kdj-tools.ts` 在 `before_agent_start` 换成 KDJ 的
（`customPrompt`；非视觉模型的那句放在 `blind` 段）。

## 视频（kdj-video 技能）

剪视频交给 AI：它做出来的是 `.kdjv` 视频工程（`docs/kdjv.md`），曲库里的一行，点开像视频一样播放。手动的剪辑器已经删掉。

- **做法与方案**：四种做法（完整 VJ、简洁剪辑、音视频合并、可视化）、素材顺序、先探索再交方案、报告，见
  `docs/ai-video-presets.md`。
- **技能**：`crates/kdj-server/src/ai/skills/kdj-video/`（`SKILL.md` 和 `references/` 下的 `kdjv.md`、`ffmpeg.md`、
  `remotion.md`、四种做法的 `preset-*.md`），由 kdj-server 写进 pi 目录。pi 只把名字和描述放进系统提示，模型遇到视频的事才用 `read` 读全文。pi 只在有
  名为 `read`（或 `bash`）的工具时才列出技能，所以 KDJ 自己注册了一个只读得到技能、工作目录和 `.kdjv` 的 `read`。
- **工具**（`kdj-video.ts`，没有 shell）：`read`；`write`（只写工作目录，`remotion/node_modules` 除外）；`kdj_probe`（ffprobe）；
  `kdj_ffmpeg`（参数 + 输出文件，输出只能在工作目录，相对路径进 `renders/`，KDJ 自己的 FFmpeg，经 `KDJ_FFMPEG`）；
  `kdj_remotion_render`（用跑 pi 的那个 node 跑工作目录 `remotion/` 里的 Remotion CLI）；`kdj_project_save`（写进曲库根目录，
  改已有工程不许少字段、旧版先备份）、`kdj_project_render`（经 `kdj project check|render`）、`kdj_project_export`（渲染后复制成
  曲库文件夹里的一个 MP4，不覆盖）和 `kdj_visualizer_render`（经 `kdj visualizer render`：歌曲封面 + 默认场景的整首可视化，
  进 `renders/` 当片段，或给了曲库文件夹就直接出片）。`kdj_align` 的每套方案带 `gaps`（参考曲里没画面的段）。`kdj_peek` 截下的画面作为图片交给
  模型。`read`、`write` 不出顶部提示，其余几步各有自己的一句（`aiTasks.ts`）。
- **Remotion**：设置 → AI → 视频，「安装/更新」用跑 pi 的那个 node 旁边的 npm，在 `<data>/ai/workspace/remotion/` 装
  `remotion`、`@remotion/cli`、`@remotion/transitions`、`react`、`react-dom`，再 `remotion browser ensure` 下好渲染用的浏览器；
  后台进行，`ai.status` 的 `remotion` 报版本、是否在装、失败原因。Remotion 对个人和三人以内的团队免费（源码可见、非开源），
  它带的 FFmpeg 是 GPL；KDJ 不打包它。Windows 上不需要 Git Bash：AI 不用 shell。

## 使用提示

使用提示的 **AI** 页（`AiLessons.tsx`，只在桌面端）按步骤教：下载 [pi](https://pi.dev)（链接到官网，附安装
命令）；以 DeepSeek 为例创建 Key、填进 设置 → AI（或从全局 pi 导入）；点聚合搜索栏的 AI 键一句话说需求——
示例句点一下就切到 AI 模式并写进输入框（`useAiStore.suggest`），不会直接发出。
