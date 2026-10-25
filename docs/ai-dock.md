# KDJ 的 AI（搜索栏的 /pi）

KDJ 里的 AI 是用户自己装的 [pi](https://pi.dev)，由 kdj-server 以 `pi --mode rpc` 启动。它从聚合搜索栏进入：
输入框以 `/pi` 开头时，后面的话交给 AI（栏末的 AI 键替你加上或去掉这个前缀）。AI 做事时不说话——只调用工具，做完写一段收尾的话（见「收尾」）；
用户看到的是它做的事本身：搜索页里的结果、下载栏里的任务、顶部的步骤提示、右下角的任务，以及需要用户决定时右下角的选项。

代码：`src/components/download/SearchBar.tsx`（AI 键与输入）、`src/lib/piPrefix.ts`（前缀）、`src/stores/aiStore.ts`、
`src/components/ai/aiEvents.tsx`（pi 的事件流 → 窗口里的动作）、`src/lib/aiTasks.ts`（每个工具的提示文字）、
`src/lib/aiSearch.ts`（AI 的搜索交给搜索页）、`src/lib/searchInterleave.ts`（多行搜索交错成一张表）、`src/lib/aiPlay.ts`、`src/components/settings/AiPanel.tsx`、
`src/components/ai/AiLessons.tsx`；后端 `crates/kdj-server/src/ai/`（`mod.rs`、`pi.rs`、`kdj-tools.ts`、
`kdj-web.ts`、`kdj-prompts.ts`）。交给模型的话全部在 `crates/kdj-server/src/ai/prompts/`（`README.md` 是总览）。

## 搜索栏的 /pi

- **没有单独的模式**：搜索栏一直是聚合搜索那一行，不翻转、不换行、平台标志照常显示。输入框以 `/pi` 开头（不分大小写，
  后面跟空格或什么都没有）时，后面的话是交给 AI 的请求（`piPrefix.ts`），Enter 交给 AI，不搜索。自己打出 `/pi` 也行。
- **栏末的 ✨ 键**（只在桌面端）在输入框已有的字前面加上 `/pi `，光标放到末尾；再点一次去掉前缀，`/pi` 后面写的字回到搜索框，
  后面什么都没写时搜索框原来的字原样回来。删掉 `/pi` 本身也回到搜索。✨ 键是墨色，有前缀时全色加粗（选中控件的写法）。
  它不再兼作停止键：停止是每个任务自己气泡上的键。
- **前缀期间的字归 aiStore**（`draft`，null 是普通搜索）：搜索框自己的关键词留在下面不动，AI 的搜索往搜索框里写关键词时也不会
  冲掉正在写的请求。
- **提示**：只有 `/pi ` 还没写内容时，前缀后面接一行淡色的字「在这里向 AI 提出你的需求」（叠在输入框上，前缀不可见地排在前面，
  所以提示正好从光标处开始，不挡点击）。还没配置模型（没装 pi、pi 无法运行、没选服务商或没 Key，即 `aiBlocker`）时提示换成
  「还没有配置模型，先去 设置 → AI 配置」，其中「设置 → AI」是可以点的键。这是用户要求的，不受「空状态不放说明文字」那条约束。
- 有前缀时输入框是红、橙、黄三色薄薄地调进面板色的底，慢慢流动（亮色主题里黄色那端取深一点）。这是界面里两处暖色之一
  （另一处是正在做的 AI 任务气泡的边光，见下）：只有这个输入框，✨ 键和其它控件仍然是墨色。输入是句子，会折行；
  Shift + Enter 换行时框跟着长高（最多五行），和聚合搜索的多行一样。
- **每句话是一个独立的任务**：交出去的话离开输入框（`/pi ` 留着，可以接着写下一个），成为右下角的**任务**（正在播放的气泡上方；
  顶部是短时的步骤，右下角是长期的任务），开一个自己的 pi 会话。写着这句话和附带的卡片，没有倒计时。
  点击标题或展开键，从气泡原地展开底板，显示每次工具调用和「正在思考」；截帧那一步下面带着截到的画面。
  底板沿用任务宿主的展开动效、滚动区域和拖宽能力，默认跟随末尾，向上翻阅后暂停跟随，回到底部恢复。
- **跑马灯在任务上，不在搜索栏上**：任务做着时，它的气泡边上有一段彩色的光绕着走（由红到橙到黄，两头淡出；任务气泡的 `working`，
  由 `TaskBubbleHost` 画，减弱动态时是一圈静止的同色淡边）。搜索栏不显示 AI 在不在做事。
- **可以连着布置几个**：AI 做着时再交一句，是右下角又一个任务「排队中 · 下一个 / 第 N 个」，等前面的做完按顺序开始，各开各的会话
  （它们都要用同一个窗口——搜索页、曲库筛选、播放——所以一次只做一个）。排队的任务可以「撤销」，不会交给 pi。轮到它时才带上
  那时的 `<kdj-status>`（用户那时在哪）。pi 退出或出错时，排队的任务一起撤掉，顶部说原因。
- 做着时不能被收起（`held`，没有收起键、Esc 也不行）；完成或中断后保留记录，允许手动收起，新任务不改写旧记录。
  停下只有它自己的键：还没开始时是「撤销」，做着时是「停止任务」（■）；停下一个任务，排在后面的接着开始。
- **一个请求一个会话**：kdj-server 收到不带 `follow` 的请求时先开一个新的 pi 会话（`new_session`）再交给它，
  上一个请求的上下文不带过去。只有「用户改变了页面」带 `follow`，并进当前会话：AI 做着时是 pi 的 `steer`。只有在历史里点了
  「继续」之后的第一句话接着那个会话。pi 刚启动或刚开过新会话、还没收过请求时不再另开一个。开新会话后把设置里的模型和推理强度
  再交给 pi 一次（`set_model`、`set_thinking_level`）：pi 按启动参数建新会话，运行中换过的设置不会自己带过去。
- 没装 pi、pi 无法运行、未设置模型：顶部一句状态，带「AI 设置」键。
- **推理强度**：有 `/pi` 前缀时输入框和 ✨ 键之间一个字「低 / 中 / 高 / 极高」，点一下换下一档。默认「高」，存在
  `kdj-ai.json` 的 `thinking`，启动 pi 时 `--thinking`，pi 运行中改用 `set_thinking_level` 立即生效（`PUT /api/ai/thinking`）；
  模型做不到的档位由 pi 自己就近取。
- **粘贴图片**：在搜索栏里粘贴图片（截图、复制的图），图片存进 AI 工作目录的 `pasted/`（`POST /api/ai/paste`），成为一张带
  缩略图的卡片，并在输入框前面加上 `/pi`。交出去时 kdj-server 把卡片里的图片（粘贴的和拖进来的图片文件）读出来、缩到 1600 像素以内，
  随 pi 的 `prompt` 的 `images` 一起给模型——模型直接看到，不用再调工具；路径也在附件里，可以拿来做视频工程的素材。
- **当前页面**（`src/lib/aiStatus.ts`）：每个新请求（补充不带）在附件后面再带一个 `<kdj-status>` 块，一行 JSON：`page`
  （本地曲库或搜索页）、`folder`（曲库打开的文件夹，null 是全部曲库）和 `subfolders`、`library_search`、`selected`（列表里选中的歌）、
  `playing`（正在播放的歌），歌都带 `track_id`、标题、艺术家和路径。提示词说「这个文件夹」「这首」没拖东西时指的就是它们。
  会话历史读回请求时去掉这个块（`sessions.rs`）。
- **拖进来的东西**（`src/lib/aiAttachments.ts`）：曲库的歌曲和视频、搜索结果（歌和视频）、从访达/资源管理器拖来的文件，
  放到搜索栏这一行上（普通搜索时也行，顺便加上 `/pi`），变成输入框下面的一排卡片：封面、名字、
  标在它上面的时间、一个移除键。时间是播放条波形上按住 Shift 拖出来的那一段（`playRange.ts`），没有就取正在播放的位置
  （只对正在播放的那首）。拖动时这一行的边亮成它自己的颜色。卡片跟着下一句话交出去：消息末尾一个 `<kdj-attachments>` 块，
  每项一行 JSON（本地的 `track_id`、`path`，在线的 `url`；`at`、`range` 都是秒），提示词讲了怎么读；任务气泡里只写用户的话和
  「附带：……」。在线歌曲交的是分享链接（AI 的搜索 ref 只认它自己搜过的）。
- **Shift + 拖动标一段**：播放条的波形上按住 Shift 拖，标出一段（波形上一层墨色），播放马上跳进这一段，到段尾回到段首
  （普通的跳转，视频跟着走），直到在段外点一下、按 Esc 或换歌。段尾离歌曲结尾至少 0.2 秒，自动接歌不会在段里触发。

## AI 做事时窗口里发生什么（`aiEvents.tsx`）

- **每种步骤一个顶部气泡**：同一个任务里同一个工具的调用共用一条顶部气泡（`placement: "top"`）——截五次帧、搜三次网页
  都只是一条，不再一次调用一条。气泡写最近一个还在跑的调用，都结束了写最近结束的那个的结果；同时跑着几个时第二行是
  「N 个进行中」，调用过不止一次时多一行「共 N 次」；渲染的百分比照常是进度条。停留时长按设置（设置 → 通用 → 提示停留，
  默认 30 秒），失败是琥珀色、停两倍长。运行中也是有时限的（最多五分钟），所以顶部排满三条时，最旧的先让位给最新的；任务、
  询问和 AI 的消息一直留着，不会被挤掉。文字由 `aiTasks.ts` 决定（搜索、网页搜索、读网页、登录、查曲库、截帧、对齐）。
  顶部气泡叠在抽屉面板上面，面板不动。
- **截帧把画面摆出来**：`kdj_peek` 结束时，它交给模型看的那几张图（有拼图时是拼图，否则前几帧，`aiShots.ts`）作为一排
  缩略图出现在截帧气泡上，每张角上写着时间（拼图写「N 帧」），没给模型的帧记一个「+N」；点一张在气泡里放大，再点收起。
  几次截帧的画面接着排（最多显示最近 12 张）。同样的缩略图也在右下角任务记录里截帧那一步下面。看不到图片的模型没拿到图，
  这里也就没有。任务结束时其它步骤的气泡跟着收走，带画面的截帧气泡留到它的停留时间结束，让人看完。
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
  里。提示词要它少发：只在中途真有要说的时候发，结果写在收尾的话里。
- **收尾**：任务结束（`agent_settled`）时，右下角原任务保留完整流式记录，包括最后的回复；不再另弹顶部收尾气泡。
  这次任务在顶部留下的步骤气泡同时清掉（带画面的截帧气泡留到停留时间结束），未结束的工具标记为已停止。抽屉的任务页在步骤下面也写着最后回复（`AiRun.reply`）。
  记录归并在 `src/lib/aiTrace.ts`，`AiTaskTrace.tsx` 只画内容，底板由 `TaskBubbleHost` 的 `body` 槽承载。
- **出错**：模型报错、pi 退出，顶部琥珀色一句。

## AI 抽屉：任务与历史（`AiDrawer.tsx`、`src/lib/aiDrawer.ts`）

列表抽屉里的一个 app「AI」，从抽屉头的入口打开。标题行两页：

- **任务**：正在做的请求，没有就是上一个——用户的话、附带的卡片、补充，下面是 AI 的每一步（工具调用），做着的转圈、
  做完打勾、失败琥珀色，文字和顶部提示同一套（`aiTasks.ts` 的 `stepLine`，下载、播放、询问这些不出顶部提示的也列出来）。
  内容来自 `aiStore.run`，由 `aiEvents.tsx` 随 pi 的事件更新。
- **历史**（`AiSessions.tsx`，设置 → AI 的「会话历史」是同一个列表）：KDJ 自己的会话文件夹里 pi 的会话，最近的在前
  （`/api/ai/sessions`，`sessions.rs` 只读这些 JSONL）：第一句请求作标题，时间、请求数、步数。点开读回这次问了什么、做了什么；
  「继续」让下一句话接着这个会话（pi 的 `switch_session`）：输入框前面加上 `/pi`，下面多一张「接着 <会话标题>」的卡片，和拖进来的
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

模型看到的每一句话——系统提示的各段（`preamble.md`、`system.md`、`blind.md`）、每个工具的说明和参数说明（`tools.md`）、
视频技能（`skills/kdj-video/`）——都在 `crates/kdj-server/src/ai/prompts/`，一处可查；`prompts/README.md` 写了模型按什么
顺序收到哪些、哪些话不在那里（用户消息里附带的块、工具的拒绝原因）。代码只按名字引用：工具用 `toolText("名字")`
（`kdj-prompts.ts` 读 `KDJ_PROMPTS` 指向的那份），`mod.rs` 的测试不许代码里再写说明文字，也核对 `tools.md` 和工具一一对应。
kdj-server 把这个文件夹写到 `<data>/ai/pi-agent/kdj/prompts/`，每次启动 pi 时覆盖。

## pi 的隔离

- KDJ 不打包 pi。PATH 或 GUI 看不到的位置（Homebrew、npm 全局、nvm、`KDJ_PI`）里找到的 pi 原样使用；
  npm 上有新版本时设置里提示可更新（`pi update`），不替用户更新。
- 运行目录全部在 `<data>/ai/` 下，不碰全局 `~/.pi`：`PI_CODING_AGENT_DIR=<data>/ai/pi-agent`
  （`auth.json` 存设置里填的 Key，合并写入，只改该服务商一项）、`workspace/`、`sessions/`、
  `kdj-ai.json`（选中的服务商、模型和网页搜索方式）。启动时 `--no-skills --no-context-files --no-builtin-tools`
  加 `--skill <pi-agent/kdj/prompts/skills/kdj-video>`：`--no-skills` 关掉一切自动发现的技能，明确给出的只有 KDJ 的视频技能；
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
它是非视觉模型，剪辑、VJ 这类视频请求一律拒绝（收尾的话里说一句后结束），只用可视化的可以照做（`prompts/blind.md`，
由 `kdj-tools.ts` 的 `before_agent_start` 加上）。

`kdj_align` 只对曲库里的歌和视频、用户给的文件：参考曲或视频在 AI 的工作目录里（截出来的一段歌、变调变速后的视频）时
直接拒绝。整首对一次就知道哪几段有画面，逐段去试只会找出整首的方案已经排除的东西（见 `docs/ai-video-presets.md`）。

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

pi 通过 `--no-builtin-tools --tools +bash` 只启用内置 shell，保留 KDJ 和网页扩展工具，不启用内置文件工具。
AI 可用 bash 做用户明确要求的文件操作；删除、覆盖先确认，不得绕过专用工具的路径限制。
bash 以当前用户权限运行，并非文件沙箱；保存工程、导出仍只写进已有的文件夹，不建目录。
`kdj_library_add_root`（`kdj library add <PATH>`，走「添加文件夹」同一条 `/api/library/scan`）把一个已有文件夹加进曲库。
系统提示开头 pi 自带的「编程助手、能执行命令」一句由 `kdj-tools.ts` 在 `before_agent_start` 换成 KDJ 的
（`customPrompt`；非视觉模型的那句放在 `blind` 段）。

## 视频（kdj-video 技能）

剪视频交给 AI：它做出来的是 `.kdjv` 视频工程（`docs/kdjv.md`），曲库里的一行，点开像视频一样播放。手动的剪辑器已经删掉。

- **分类与方案**：按阶段分的几类（需求、确认、查歌、找素材、可视化、标准剪辑、定制剪辑、对齐、改工程）、素材顺序、先探索再交方案、报告，见
  `docs/ai-video-presets.md`。
- **技能**：`crates/kdj-server/src/ai/prompts/skills/kdj-video/`（`SKILL.md` 和 `references/` 下每一类一个文件，
  加上工程格式 `kdjv.md`），由 kdj-server 写进 pi 目录。pi 只把名字和描述放进系统提示，模型遇到视频的事才用 `read` 读全文。pi 只在有
  名为 `read`（或 `bash`）的工具时才列出技能，所以 KDJ 自己注册了一个只读得到技能、工作目录和 `.kdjv` 的 `read`。
- **视频工具**（`kdj-video.ts`；shell 由 pi 提供）：`read`；`write`（只写工作目录，`remotion/node_modules` 除外）；`kdj_probe`（ffprobe）；
  `kdj_ffmpeg`（参数 + 输出文件，输出只能在工作目录，相对路径进 `renders/`，KDJ 自己的 FFmpeg，经 `KDJ_FFMPEG`）；
  `kdj_remotion_render`（用跑 pi 的那个 node 跑工作目录 `remotion/` 里的 Remotion CLI）；`kdj_project_save`（写进曲库根目录，
  改已有工程不许少字段、旧版先备份）、`kdj_project_render`（经 `kdj project check|render`）、`kdj_project_export`（渲染后复制成
  曲库文件夹里的一个 MP4，不覆盖）和 `kdj_visualizer_render`（经 `kdj visualizer render`：歌曲封面 + 默认场景的整首可视化，
  进 `renders/` 当片段，或给了曲库文件夹就直接出片）。`kdj_align` 的每套方案带 `gaps`（参考曲里没画面的段）。`kdj_peek` 截下的画面作为图片交给
  模型。`read`、`write` 不出顶部提示，其余几步各有自己的一句（`aiTasks.ts`）。
- **Remotion**：设置 → AI → 视频，「安装/更新」用跑 pi 的那个 node 旁边的 npm，在 `<data>/ai/workspace/remotion/` 装
  `remotion`、`@remotion/cli`、`@remotion/transitions`、`react`、`react-dom`，再 `remotion browser ensure` 下好渲染用的浏览器；
  后台进行，`ai.status` 的 `remotion` 报版本、是否在装、失败原因。Remotion 对个人和三人以内的团队免费（源码可见、非开源），
  它带的 FFmpeg 是 GPL；KDJ 不打包它。Windows 上使用 bash 需要可用的 Bash（如 Git Bash）；视频专用工具本身不依赖 shell。

## 使用提示

使用提示的 **AI** 页（`AiLessons.tsx`，只在桌面端）按步骤教：下载 [pi](https://pi.dev)（链接到官网，附安装
命令）；以 DeepSeek 为例创建 Key、填进 设置 → AI（或从全局 pi 导入）；在聚合搜索栏以 `/pi` 开头（或点 AI 键）一句话说需求——
示例句点一下就以 `/pi 示例句` 写进输入框（`useAiStore.suggest`），不会直接发出。
