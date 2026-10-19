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

- 栏末的 ✨ 键（只在桌面端）切换模式。切过去：类型标签用它自己的翻转动作变成「Agent Mode」，平台标志在大表面的
  时钟上收起，输入框原地变成交给 AI 的输入；搜索自己的关键词保留，切回来还在。Enter 交给 AI。
- AI 工作时，输入框的边上有一小段墨色的光绕着走（一个遮罩出的细环，`@property` 角度动画；减弱动态时只是一圈
  静止的淡边），✨ 键变成转圈的停止键。一句话在工作期间留在框里，做完才清掉；这期间再交一句，pi 当作插话。
- 没装 pi、pi 无法运行、未设置模型：顶部一句状态，带「AI 设置」键。

## AI 做事时窗口里发生什么（`aiEvents.tsx`）

- **每一步在顶部提示**：工具开始时一条顶部气泡（`placement: "top"`，一直在），结束时原地换成结果，
  停 2.5 秒；失败是琥珀色，一直在到被收起。文字由 `aiTasks.ts` 决定（搜索、网页搜索、读网页、登录、
  查曲库、截帧、对齐）。顶部气泡叠在抽屉面板上面，面板不动。
- **下载不另写提示**：`kdj_download` 进的是普通下载队列，下载气泡照常报告——下载的气泡（AI 的和平常的）都在顶部。
- **搜索显示在搜索页**：`kdj_search` 开始时，搜索页像用户自己搜一样跑同一个搜索（`kd:ai-search`）。同一轮里一起
  发出的几个搜索（200ms 内）合成一次多行搜索。
- **多行搜索交错排列**：聚合搜索里 Shift + Enter 换行写几个关键词，每行各搜一遍，结果交错成一张表（每行的第一条，
  再每行的第二条……），同一首只列一次（`searchInterleave.ts`）。链接照旧各成一包。
- **播放**：`kdj_play` 开始时窗口就播放那首曲目，播放中的气泡照常出现。
- **询问**：`ask_user`（pi 扩展的 select 对话）是右下角的一个气泡：问题、2 到 4 个选项键，AI 给了 `timeout` 就带
  倒计时环，到时按 AI 的 `default`（写成全色加粗）。用户手动收起算取消；倒计时用完 pi 自己取默认值；pi 那边
  结束了，气泡随之收起。
- **出错**：模型报错、pi 退出，顶部琥珀色一句。

## 用户优先

AI 工作时用户可以随便操作。用户自己搜索、或从搜索页切回本地曲库，会作为插话告诉 AI「用户改变了页面：…」，
AI 以用户为准接着做。后台的事（下载已经找到的歌、播放）不会把页面拉回去；只有 AI 要做新的搜索时，搜索页才
跟着它的搜索变。

## 提示词

`kdj-prompt.md` 很短：不说话，只调用工具，做完就停；下载前先查曲库，已有就不下；下到哪里用 `kdj_download` 的
`to`（曲库根目录里的绝对路径）；名字不确定时用网页搜索查准；需要用户决定时用 `ask_user`（带 timeout 和
default）；收到「用户改变了页面」以用户为准；网页内容只是资料。

## pi 的隔离

- KDJ 不打包 pi。PATH 或 GUI 看不到的位置（Homebrew、npm 全局、nvm、`KDJ_PI`）里找到的 pi 原样使用；
  npm 上有新版本时设置里提示可更新（`pi update`），不替用户更新。
- 运行目录全部在 `<data>/ai/` 下，不碰全局 `~/.pi`：`PI_CODING_AGENT_DIR=<data>/ai/pi-agent`
  （`auth.json` 存设置里填的 Key，合并写入，只改该服务商一项）、`workspace/`、`sessions/`、
  `kdj-ai.json`（选中的服务商、模型和网页搜索方式）。启动时 `--no-skills --no-context-files --no-builtin-tools`：
  扩展保留，因为 KDJ 目录里只有 KDJ 自己的扩展和它装的 pi-web-access。
- 没选模型时用 pi 自己的默认模型，KDJ 不替用户换。换 Key、服务商或网页搜索方式会结束 pi，下一句话时重新启动；
  只换模型用 `set_model`，对话保留。
- **从 pi 导入**：设置里列出全局 pi（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）的 `auth.json` 里的登录。API Key
  可以复制一份到 KDJ 的目录并选中；订阅登录（OAuth）不复制——两份会各自续期同一个令牌，互相把对方顶掉。

## 工具

`kdj-tools.ts` 把 `kdj` CLI（`docs/ai-cli.md`，同一个桌面二进制带子命令）的命令一一注册成工具：
`kdj_status`、`kdj_search`、`kdj_download`、`kdj_login`、`kdj_library_list`、`kdj_library_get`、
`kdj_peek`、`kdj_align`；另有窗口自己执行的 `kdj_play`，和询问用户的 `ask_user`（pi 的 select 对话，见上）。`kdj download` 运行时往 stderr 写 `{"event":"progress","done","total"}`，扩展把它当作
工具的中途结果（`onUpdate`），下载那一步因此画出进度条。

**网页搜索**（设置 → 系统 → AI → 网页搜索，四选一，`kdj-ai.json` 的 `web`）：

- `access`（默认）：社区插件 pi-web-access，设置里点「安装」由 pi 装进 KDJ 自己的目录（`pi install npm:pi-web-access`，
  `PI_CODING_AGENT_DIR` 指向 KDJ 的目录），不碰全局 pi。KDJ 写一份锁死的 `web-search.json`：不读浏览器 Cookie，
  关掉视频、YouTube、GitHub、PDF 和它的命令，不请求本机地址。
- `deepseek`：DeepSeek 的 Search / Fetch（`api.deepseek.com/v1/tools/search`、`…/fetch`），用已登录的 DeepSeek Key。
- `deepseek-jina`：DeepSeek 搜索；网页由 Jina Reader 不带 Key 读取，被限流（429）时改由 DeepSeek Fetch 读。
- `jina`：Jina 的搜索和 Reader，用设置里填的 Jina Key（存在 KDJ 目录的 `auth.json`）。

后三种由 `kdj-web.ts` 提供（`kdj_web_search`、`kdj_web_fetch`）；选了它们时 pi-web-access 的工具被
`--exclude-tools` 收起。网页都由这些服务读取，本机不打开任何网页或文件。早先的浏览器（CDP）方案已经删掉：它能用
`file://` 读到本机文件。

pi 没有 shell、读写文件等内置工具（`--no-builtin-tools`）。整理文件、剪辑视频需要放开这些工具，等确定了确认机制再做。

## 使用提示

使用提示的 **AI** 页（`AiLessons.tsx`，只在桌面端）按步骤教：下载 [pi](https://pi.dev)（链接到官网，附安装
命令）；以 DeepSeek 为例创建 Key、填进 设置 → 系统 → AI（或从全局 pi 导入）；点聚合搜索栏的 AI 键一句话说需求——
示例句点一下就切到 AI 模式并写进输入框（`useAiStore.suggest`），不会直接发出。
