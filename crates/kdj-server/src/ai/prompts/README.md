# KDJ 的 AI 提示词

KDJ 交给模型的话都在这个文件夹里，改提示词只改这里。代码只按名字引用它们，不写一句给模型看的说明
（`crates/kdj-server/src/ai/mod.rs` 的测试 `every_word_a_tool_gives_the_model_is_in_prompts` 守着这一点）。

运行时 kdj-server 把这个文件夹原样写到 `<数据目录>/ai/pi-agent/kdj/prompts/`（macOS：
`~/Library/Application Support/com.kdj.app/data/ai/pi-agent/kdj/prompts/`），pi 和 KDJ 的工具从那里读。
那一份每次启动 pi 都会被这里的覆盖，只用来查看，不在那里改。

## 模型收到什么，按顺序

**系统提示**，pi 按这几段拼成一份：

| 段 | 文件 | 说明 |
|---|---|---|
| 开场 | `preamble.md` | 换掉 pi 自己的“编程助手”开场（`kdj-tools.ts`，`customPrompt`） |
| 正文 | `system.md` | 怎么做事、找歌下载、附件和页面状态、本机文件的规矩（`--append-system-prompt`） |
| 技能列表 | `skills/kdj-video/SKILL.md` 的 `description` | pi 只列出名字、描述和位置；模型做视频的事时用 `read` 读全文（`--skill`） |
| 工作目录 | — | pi 写上当前目录（`<数据目录>/ai/workspace`） |
| 看不到图 | `blind.md` | 只有当前模型不收图片时才加，`{model}` 换成模型 id |

**工具**：每个工具的说明和参数说明在 `tools.md`，和系统提示分开、作为工具定义交给模型。工具名、参数的类型和
取值范围、工具怎么执行在代码里（`kdj-tools.ts`、`kdj-video.ts`、`kdj-web.ts`）。另有 pi 自带的 `bash`，它的说明是 pi 的。
选了 pi-web-access 做网页搜索时，`kdj_web_search` / `kdj_web_fetch` 换成它自己的工具和说明。

**视频技能** `skills/kdj-video/`：`SKILL.md` 是总纲；`references/` 下是工程格式（`kdjv.md`，也是 .kdjv 格式的唯一说明）、
FFmpeg 和 Remotion 的写法、四种做法（`preset-vj.md`、`preset-cut.md`、`preset-merge.md`、`preset-visualizer.md`）。
模型照 SKILL.md 的指引按需读。

## 不在这里、但模型也看得到的

- **用户消息里附带的块**，由窗口拼在用户的话后面（`system.md` 讲了怎么读）：
  - `<kdj-attachments>`：拖进来的歌、视频和图片，每行一项 JSON（`src/lib/aiAttachments.ts`）；
  - `<kdj-status>`：交这句话时 KDJ 的页面、文件夹、选中和正在播放的歌，一行 JSON（`src/lib/aiStatus.ts`）；
  - 用户中途改了页面时，窗口补一句「用户改变了页面：……。以用户为准，接着完成任务。」（`src/stores/aiStore.ts`）。
- **工具的返回**：结果本身是数据；拒绝和报错的原因（路径不许、方案没贴截图、对齐用了工作目录里的文件……）
  写在执行它的代码旁边，因为它们说的是那一次调用哪里不对。

## 改的时候

- 文件是 UTF-8 的 Markdown，模型拿到的就是文件里的字（首尾空白去掉）。
- `tools.md` 的格式写在它自己的开头。加一个工具：代码里 `defineTool` 用 `toolText("名字")`，这里加一节 `## 名字`；
  两边对不上时 `mod.rs` 的测试会失败，pi 加载扩展时也会报出缺了哪一项。
- 加一个新文件：放进这个文件夹，再加进 `mod.rs` 的 `PROMPTS`。
- 改了什么、为什么，记在 `docs/ai-dock.md`（窗口和流程）或 `docs/ai-video-presets.md`（视频做法的来由）。
