# 行列表（Row list）

工作区的两张列表（本地曲库 `library/TrackTable.tsx`、搜索结果 `download/ResultTable.tsx`）都建在同一个原语上。它不是 `<table>`。

## 为什么不是表格

WebKit 的表格布局不是增量的：往 `<table>` 里插几行，整张表重排；表格行和格也拿不到自己的合成层，行上的 opacity/transform 动画退回主线程逐帧重绘。再加上滚动由 WebView 的滚动线程执行、页面只能事后追，每次追赶都是一次大型同步布局——起步卡、落地卡、动画丢帧，都是这个结构的直接后果。

## 节奏：为什么不按帧渲染

WKWebView 的合成器自己滚，显示的是主线程事先画好的瓦片。滚动内容的 DOM 每改一次，相关瓦片就作废要重画；主线程在滚动期间每忙一毫秒，就是少画一毫秒前方的瓦片。所以：

- 几千行以内（`ROW_LIST_WHOLE`）的列表整体挂载：先挂视口附近的窗口，再每隔一帧挂一块（250 行），直到全部建完；之后滚动时 DOM 零改动，封面也都在。
- 更长的列表只保留视口前后各三屏；虚拟化器用自己的滚动观察器（`observeRowListOffset`）：滚过整整一屏才知会一次，停稳再知会一次，不用 flushSync。于是行的挂卸发生在离视口两三屏之外，可见瓦片不受影响。
- 等着在某个位置"呈现"的列表（换查询、恢复位置、板块重新显示）在滚动监听里自己要一次渲染（`useScrollMotion` 的 `onScroll`），因为小位移不会让虚拟化器渲染。

## 一次与行无关的更新不该碰到行

整份列表在页面里时，行的任何一个 prop 换了身份就是全部行重渲染。两个已经踩过的：

- `useVirtualizer` 把 `rangeExtractor` 的结果缓存到可见范围或这个函数变化为止。分块建行靠一个计数推进，函数的身份不跟着变，计数走完页面上还是原来那几十行，剩下的在下一次滚动里一次提交全部建出（2026-10-12 的日志：首次滚动 `rowRenders` 三千多、帧间隔 1.6 秒）。所以它依赖 `grown`。
- 曲库统计每分析完一批换一个新对象。行只读其中三个中位数，表格按值取这三个数再下发，值不变行就不动。

## 结构

- `src/components/common/RowList.css`：布局。
  - `.kd-list`：内容容器（滚动容器 `.kd-scroll` 的第一个子元素），带 `--kd-list-cols`（grid 列模板，列宽偏好写在这一个变量里）和 `--kd-list-min-width`。
  - `.kd-list-head`：表头，sticky，和行同一个 grid。
  - `.kd-list-body`：行按文档流排列，上下 padding（`rowListPadding`）代替没有建出来的行，撑出整份列表的高度。行**不定位、不 contain**：定位元素是 WebKit 的一个层，两千个层会让每次滚动通知、命中测试和瓦片绘制都遍历两千个层。
  - `.kd-list-row`：一行，`display: grid; grid-template-columns: var(--kd-list-cols)`。曲库的行直接是 body 的子元素；搜索结果的一个"块"（`.kd-list-block`）里装一行和在它下面展开的内容（来源、分 P、整个包），块内的行按流排列、高度由内容决定，块被测量。
  - `.kd-list-cell` / `.kd-list-hcell`：格。文字格是 block 并省略号；装封面、标记、控件的格加 `data-flex`。
- `src/components/common/rowList.ts`：`useRowList`（`@tanstack/react-virtual`；固定行高或按块估算 + 测量；整体挂载或前后各三屏；`scrollMargin` 是表头高；`scrollToFn` 直接写 `scrollTop`；返回 `{ virtualizer, whole, mounted }`）和 `useScrollMotion`（上一帧的位置、方向、是否在滚；在 scroll 事件里读位置不触发布局）。
- `src/components/common/listArrival.ts` + `ListArrival.css`：行的到场（`present` 呈现一份列表，`chase` 让晚到的行接上一个时钟）。标记只在行上。
- 外观（墨色、悬停、选中、批选、各列的格）在 `src/design.css` 的"行列表"一节；结果表自己的在 `ResultTable.css`。

## 规则

1. 滚动帧里不渲染、不 `flushSync`、不读布局（`getBoundingClientRect`、`offsetTop`、`scrollHeight`）、不画 canvas、不切祖先的属性；位置从 `useScrollMotion` 读。
2. 行要便宜：只渲染可见列；格里不套包装层；每行不订阅 store（曲库的响度基准由表读一次下发）；封面是普通 `<img>`，在视口外两三屏就挂好，显示过的同步解码。
3. 行和块永远不定位（没有 `position`、`top`、`transform`、`contain`）；到场动画用 transform 动行本身。
4. 动画的标记在行上（`data-kd-arrive*`、`--kd-arrive-*`），结束后去掉；不在 `.kd-scroll`、`.kd-list`、`.kd-list-body` 上放任何会被后代选择器用到的属性。
5. 新的一张列表：给 `useRowList` 一个 `count`、`getKey`、行高（或块估算）和表头高，用 `getVirtualItems()` 渲染，`getTotalSize()` 撑 body；在 layout effect 里按"呈现"与"追上"的规则调用 `listArrival`（建过一次的行不再追上）；外部要找行用 `.kd-list-row[...]`，不要假定没挂载的行在 DOM 里（Shift 区间、MIDI 步进这类要用数据模型，不要用 DOM 顺序）。

## 两张列表怎么用它

- 曲库：块 = 行；`getKey` 是曲目 id（待下载任务在前）；`libraryDemand` 按渲染出的行向数据层要摘要；停稳时记下顶部的行作为锚点（会话恢复、后台换索引、板块隐藏后恢复）。
- 搜索结果：`resultBlocks.ts` 把 items 摊成块（单曲、集合、整个包）；每次 delivery 的块键都带 delivery id，所以新的一份列表全是新的行；Shift 区间沿 `resultPickKeys` 走；展开/折叠在块内，块的高度由 ResizeObserver 重新量。
