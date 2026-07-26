# 03 · 克制化重设计：红色收敛、批量自动识别、封面修复

日期：2026-07-26。这一步没有动后端，全部是前端（React + CSS）。

## 改了什么

### 1. 红色按钮收敛（核心诉求）

改前一屏最多同时亮着 5 处主题红：搜索、批量（激活时）、加入队列、若干
分段开关的激活块、分析(N)。改后的规则：**红色只给"动作"，不给"状态"；
每个可视区域同时最多一个红块。**

- `kd-segment`（音乐/视频、平台选择、全部/已分析）激活态从主题红填充改成
  中性 `--kd-selected` 底色。开关是状态，不是动作。
- 曲库工具栏的「分析(N)」从 primary 降为默认中性——它和顶部「搜索」原来
  上下叠成两个常亮红块。「停止分析」保持 danger（瞬态）。
- 「加入队列」从常驻页头挪到**勾选后才浮出的底部动作条**（`.kd-picked-bar`，
  含"已选 N 首 / 清除 / 加入队列"）。没勾任何歌时整个面板没有红色。
- 最终清点（CDP 实测）：曲库模式全屏 `data-variant="primary"` 只剩「搜索」。

### 2. 曲库/搜索结果开关挪到面板"眉目"上

原来是一整行 `kd-section-head`（0.85rem 上下 padding 的大标题行）。删掉，
换成中间列表面板顶边一条 2.15rem 的 `.kd-list-head`：

- 搜过之后：下划线式标签（`.kd-list-tabs`，激活态只有 2px 主题色下划线）
  「曲库 | 搜索结果 N」+ 概况数字 + 关闭 ×。
- 没搜过：小号「曲库」标题 + 数字。
- `kd-table-wrap` 因此改成 `flex-direction: column`，子级 `.kd-scroll`
  吃 `flex: 1`。TrackTable / ResultTable / VideoPanel 的根都是 `.kd-scroll`，
  一条 CSS 全覆盖。

### 3. 搜索条瘦身

- 下载目录芯片（"KumoDeck"）删除——目录管理挪到下载队列面板顶部
  （`SaveDirRow`：音乐/视频两个 `kd-path-chip` + 访达打开按钮，点芯片选目录
  直接存回 settings）。搜索时人在想"找什么"，不是"存哪里"。
- 音质选择缩小：`kd-select[data-size="sm"]`（1.6rem 高、xs 字号），文案
  「跟随设置（flac）」→「默认（flac）」。
- 「批量」按钮删除。批量由输入内容推导：`query` 含换行、或含 ≥2 条链接
  即为批量。单行 `<input>` 的 `onPaste` 拦截多行粘贴（浏览器默认会把换行
  压成一行，批量意图就丢了），原样放进 query，随即自动切成 textarea。
  提交按钮显示「批量处理（N）」，N 与后端 `split_intake_text` 同规则去重。

### 4. 封面修复（网易云 + QQ）

- **坑：网易云封面被 CSP 静默拦截。** pyncm 返回的 picUrl 是
  `http://p1.music.126.net/...`（纯 http），而 `index.html` 的 CSP
  `img-src` 只放行 `https:` 和 `http://127.0.0.1:*`。控制台没有显眼报错，
  图就是不出来。修复：`thumbUrl()` 把非本机的 `http://` 升级为 `https://`
  （126.net 支持，实测 `?param=48y48` 返回真 48×48 JPEG）。
- QQ 封面 URL 实际形态是 `https://y.qq.com/music/photo_new/T002R300x300M000….jpg`，
  原正则（qpic.cn / y.gtimg.cn）根本匹配不上。补 `y.qq.com`，尺寸档
  `R\d+x\d+M` 换成 `R90x90M`（curl 实测 R90x90 存在，200）。

## 验证

- `npx tsc --noEmit` 干净，`npm run build` 通过。
- CDP（端口 9333）DOM 级验证：搜索 "Snow halation" → 49 行结果；
  网易云缩略图 `naturalWidth === 48`（说明像素真加载了，不只是 URL 变了）；
  QQ 缩略图为 R90x90；勾选后 `.kd-picked-bar` 出现且唯一红钮是「加入队列」；
  粘贴三行文本自动切 textarea、按钮变「批量处理（3）」。

## 坑 / 排查记录

- **dev 模式 CDP 端口"不生效"的真相**：`vite.config.ts` 里
  `onstart: (args) => args.startup([".", "--remote-debugging-port=9333"])`
  是对的；之前不生效只是因为 dev 进程在配置改动前就启动了，重启 dev 即好。
  注意 `args.startup(argv)` 会**整体替换**默认 `[".", "--no-sandbox"]`。
- **窗口被遮挡时 CDP 截图会挂死**：`document.visibilityState === "hidden"`
  时 macOS 停止出帧，`Page.captureScreenshot`（`fromSurface` 真假都一样）
  一直等不到帧直到超时；页面里的 `setTimeout` 也被节流到 ≥1s。对策：
  验证改走 DOM/`Runtime.evaluate`（查结构、`naturalWidth`、按钮清点），
  长等待拆成"提交一次 eval + shell 里 sleep + 再查一次 eval"。
  不要 `Page.bringToFront` 抢用户焦点。
- JSX 三元分支里不能放 `{/* */}` 注释块（那是表达式位置），要用 `//` 行注释。

## 事后清扫（同日第二遍）

用脚本把 design.css 定义的 124 个 `kd-` 类逐个和 src 全文比对，删掉 11 个
孤儿类（旧侧边栏 `kd-sidebar/kd-nav-*`、旧顶栏 `kd-topnav*`、播放条改版前的
`kd-player-cover/artist`、`kd-panel-stack`、`kd-td-mono`、`kd-hidden`）和
`--kd-sidebar-w` 变量。孤儿模块 / 未使用导出 / 未使用类型导出扫描均为零；
Python 侧 AST 扫 import 只剩 `from __future__ import annotations` 误报。
过时文案三处：ResultTable 空态还在教人"开「批量」"、FolderTree 注释里的
"右上角开关"、SearchBar 的"视频走单独板块"，一并改掉。
复验：build ✓ / pytest 80 ✓ / smoke 19/19 ✓ / 运行中的 app DOM 抽查 ✓。

## 同日第三遍（边用边提的四件事 + 一个 bug）

- **平台按钮品牌色**：搜索平台的激活态不再是中性灰，网易云 #e63329 白字、
  QQ #31c27c 深字、SoundCloud #ff8800 深字（浅底配深字才有对比度）。
  色值和来源小方块（kd-source-dot）同一组。CSS 选择器走 `data-platform`。
- **列表标签去红线**：kd-list-tabs 激活态改为亮字 + `--kd-selected` 中性底。
- **曲库列表封面缩略图**：TrackTable 标题格前加 `kd-thumb`，
  `api.coverUrl(id)` + `loading="lazy"`，无内嵌图时 onError 藏 img 留灰格占位。
  后端 `/library/cover/{id}` 补了 `Cache-Control: private, max-age=3600`——
  没有缓存头的话每次滚回来都重读文件重解 tag。实测 200 行里 196 张加载成功。
- **能量条选中隐形**：`kd-energy` 未点亮档原来用 `--kd-line`，和选中行底色
  `--kd-selected` 几乎同色，一选中整条表就消失。改成
  `color-mix(--kd-faint 55%, transparent)`，两种底上都可见。
- **推荐点击详情不跟（bug）**：「接下一首」点击后右栏变回"选一首看详情"。
  根因：HarmonicList 只回传 id，而 `selectSelectedTrack` 只在当前页 200 行里找，
  被推荐的歌大多在页外 → 返回 null。修复：store 加 `selectedTrack` 暂存 +
  `selectTrack(track)` 方法，选择器页内优先、页外回落暂存；
  updateTrack/writeTags/removeTrack 同步维护暂存。

### 新坑

- **vite-plugin-electron 的 onstart 是碰运气的**：`:startup` 钩子在 main/preload
  两个构建间共用 `closeBundleCount` 计数器，**谁后构建完就触发谁的 onstart**。
  只给 main 配 onstart 传启动参数，输了竞态就静默用默认 argv。
  正解：`electron/main.ts` 里 `app.commandLine.appendSwitch("remote-debugging-port", "9333")`
  （仅 DEV_URL 存在时），vite.config 里不要 onstart。
- **连续触发两次自动重启会把 app 撞挂**：改 main.ts（触发 Electron 重启）后
  紧接着改 vite.config.ts（触发整个 dev server 重启），两次重启竞态后剩下一个
  没有渲染进程也没有 sidecar 的僵尸 Electron。表现：CDP 目标还在但
  `Runtime.evaluate` 永远超时。处理：pkill 全家 → 重启 dev。
- **给运行中的 app 做合成点击会和正在用它的人打架**：两次 eval 之间用户一操作，
  第一步找到的节点第二步就没了。要么整条链路放进一个 eval（页面可见时
  setTimeout 不被节流），要么别碰，让用户自己验。
