# 03 · 克制化重设计：红色收敛、批量自动识别、封面修复

日期：2026-07-26。这一步没有动后端，全部是前端（React + CSS）。

## 改了什么

### 当前界面规则（2026-09-06 更新）

- 图标和文字的选中状态使用主题红，不增加选中底色、边框、阴影或装饰线。
- 主操作使用简洁图标与文字，不采用实心红块。
- 不再继承其他项目的强制直角风格；禁止全局覆盖所有元素的圆角。
- 滑块使用细轨道和小圆形滑钮，避免红色矩形手柄。
- 工坊素材、位置分析与时间轴图层合并。本地视频与工坊视频共用
  `FloatingVideoControls` / `FloatingVideoScrub` 和 `kd-pip-float` 样式。
  画面就是小窗；标题、播放、全屏和进度控件浮在画面内，不添加白色顶栏。

下文保留历史功能改动记录，不作为视觉样式规范。

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

- 下载目录芯片（"KDJ"）删除——目录管理挪到下载队列面板顶部
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

- **给运行中的 app 做合成点击会和正在用它的人打架**：两次 eval 之间用户一操作，
  第一步找到的节点第二步就没了。要么整条链路放进一个 eval（页面可见时
  setTimeout 不被节流），要么别碰，让用户自己验。
