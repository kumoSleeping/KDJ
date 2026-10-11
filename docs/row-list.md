# 行列表（Row list）

工作区的两张列表（本地曲库 `library/TrackTable.tsx`、搜索结果 `download/ResultTable.tsx`）都建在同一个原语上。它不是 `<table>`。

## 为什么不是表格

WebKit 的表格布局不是增量的：往 `<table>` 里插几行，整张表重排；表格行和格也拿不到自己的合成层，行上的 opacity/transform 动画退回主线程逐帧重绘。再加上滚动由 WebView 的滚动线程执行、页面只能事后追，每次追赶都是一次大型同步布局——起步卡、落地卡、动画丢帧，都是这个结构的直接后果。

## 节奏：为什么不按帧渲染

WKWebView 的合成器自己滚，显示的是主线程事先画好的瓦片。滚动内容的 DOM 每改一次，相关瓦片就作废要重画；主线程在滚动期间每忙一毫秒，就是少画一毫秒前方的瓦片。所以：

- 几千行以内（`ROW_LIST_WHOLE`）的列表整体挂载：先挂视口附近的窗口，再每隔一帧挂一块（250 行），直到全部建完；之后滚动时 DOM 零改动，封面也都在。
- 更长的列表只保留视口前后各三屏；虚拟化器用自己的滚动观察器（`observeRowListOffset`）：滚过整整一屏才知会一次，停稳再知会一次，不用 flushSync。于是行的挂卸发生在离视口两三屏之外，可见瓦片不受影响。
- 等着在某个位置"呈现"的列表（换查询、恢复位置、板块重新显示）在滚动监听里自己要一次渲染（`useScrollMotion` 的 `onScroll`），因为小位移不会让虚拟化器渲染。

## WebKit 里列表自己滚（`own`，曲库和搜索结果都是）

上面是把滚动交给 WebView 的做法。在 WebKit（macOS 和 Linux 的 WebView；`listScrollsItself()`）里曲库反过来，由页面自己滚，原因是 WebKit 自己的两件事：

- 它给 overflow 容器只预画视口外大约一块瓦片（整页滚动是三倍可视高度，`TileController::adjustTileCoverageRectForScrolling`）。滚动线程自己执行的甩动一两帧就越过去，页面再快也是白的。
- 凡是裁剪溢出的盒子都是一个层（`RenderBox::requiresLayer()` 里的 `hasNonVisibleOverflow()`；`contain: layout`、定位、z-index 也是），每个带省略号的格都算。每次滚动 WebKit 把容器里所有的层走一遍，清裁剪缓存、重算重绘范围（`RenderLayer::recursiveUpdateLayerPositionsAfterScroll`），画瓦片时再走。两千行整体挂载是两万个层：2026-10-12 的滚动日志里 React 每次渲染一两毫秒，主线程却只有二三十帧。

所以这样的列表：

- 自己接滚轮（`ownWheel`）：`wheel` 取消默认动作，页面写 `scrollTop`。一次手势（一划连同它的惯性、滚轮的一格）沿它开始的那个轴走，竖着甩不会带着比板块宽的列表左右晃；捏合缩放、落在列表里另一个能滚的东西上的滚轮不接。没有回弹。
- 只保留视口前后各半屏的行（至少 8 行），不整体挂载。层数是整体挂载的几十分之一。
- 容器是 `overflow: hidden`（`data-own-scroll`，RowList.css），不是 `auto`。WebKit 只给 `auto` / `scroll` 的容器滚动线程节点（`RenderBox::scrollsOverflowY` → `RenderLayerScrollableArea::canUseCompositedScrolling`），有节点的容器页面一写 `scrollTop` 就立刻交给滚动线程（`AsyncScrollingCoordinator::requestScrollToPosition`），瓦片先动、主线程后画：每帧走过的距离一旦超过预画的那一块瓦片（约 500 像素，2026-10-12 的日志里 715 像素/帧的甩动必白、223 的不白），行建得再早也白一帧。hidden 的容器由主线程滚：滚动、要露出的行、它们的瓦片在同一次提交里。页面慢了，列表停一帧，不会白。代价是滚动的每一帧都重画视口（不再是合成器挪瓦片）。
- 每个 scroll 事件都知会虚拟化器，并在事件里渲染（`useFlushSync`）。
- hidden 的容器不再自己答应键盘：`ownKeys` 接 Page Up / Down、空格、Home、End，焦点在列表里或上一次按下在列表里时才接，输入框里不接。
- 页面自己写的滚动（滚轮、拖滑块）先建行、后移动：`scrollTopTo`（`src/lib/wheelScroll.ts`）先把目的地告诉虚拟化器，行建好了再写 `scrollTop`。WebKit 把页面写入的滚动位置立刻交给滚动线程（`RenderLayerScrollableArea::scrollToOffset` 先走 `requestScrollToPosition`），而能让行建出来的 scroll 事件要到下一次渲染更新才来：先移动的话，一次十几行的轻甩会落在还没有行的地方，露白一帧。只能在事件处理里调用（它同步渲染一次），effect 和渲染里照旧直接写 `scrollTop`。
- 一次进来的行超过 `FILL_ROWS`（拖滑块、跳到正在播的歌）时，这些行先只有序号，不占那一帧；跳动停下 60 毫秒后离视口近的先填内容，每 16 毫秒一步。被呈现的列表（换查询、恢复位置）整行到场，不走这条。一次很快的甩动在最快的那几帧里也会超过这个数（每帧十二行约是每秒两万多像素）：那几帧进来的行只有序号，甩动慢下来后进来的行是整行，留在窗口里的序号行随后补上。这是有意的，不是没渲染完：那个速度下内容读不了，序号能让人知道滚到了哪里。
- 没有"行追上滚动"（`chase`）：行在露出的那一帧就在。

搜索结果和其它引擎（Chromium 的光栅化远在视口之前；触摸屏不发滚轮）不变。

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

1. 滚动帧里不读布局（`getBoundingClientRect`、`offsetTop`、`scrollHeight`）、不画 canvas、不切祖先的属性；位置从 `useScrollMotion` 读。交给 WebView 滚的列表在滚动帧里也不渲染、不 `flushSync`；自己滚的列表只由虚拟化器在 scroll 事件里渲染进出窗口的那几行。
2. 行要便宜：只渲染可见列；格里不套包装层；每行不订阅 store（曲库的响度基准由表读一次下发）；封面是普通 `<img>`，显示过的同步解码。在 WebKit 里每个裁切溢出的盒子都是一个层，每次滚动都要遍历全部层，所以只有文字可能超长的格才带 `data-clip`（省略号），数字和日期格不裁切；封面框不裁切，图片自己圆角；评分是一个元素两张遮罩，不是五个 SVG 按钮。
3. 行和块永远不定位（没有 `position`、`top`、`transform`、`contain`）；到场动画用 transform 动行本身。
4. 动画的标记在行上（`data-kd-arrive*`、`--kd-arrive-*`），结束后去掉；不在 `.kd-scroll`、`.kd-list`、`.kd-list-body` 上放任何会被后代选择器用到的属性。
5. 新的一张列表：给 `useRowList` 一个 `count`、`getKey`、行高（或块估算）和表头高，用 `getVirtualItems()` 渲染，`getTotalSize()` 撑 body；在 layout effect 里按"呈现"与"追上"的规则调用 `listArrival`（建过一次的行不再追上）；外部要找行用 `.kd-list-row[...]`，不要假定没挂载的行在 DOM 里（Shift 区间、MIDI 步进这类要用数据模型，不要用 DOM 顺序）。

## 两张列表怎么用它

- 曲库：块 = 行；`getKey` 是曲目 id（待下载任务在前）；`libraryDemand` 按渲染出的行向数据层要摘要；停稳时记下顶部的行作为锚点（会话恢复、后台换索引、板块隐藏后恢复）。
- 搜索结果：`resultBlocks.ts` 把 items 摊成块（单曲、集合、整个包）；每次 delivery 的块键都带 delivery id，所以新的一份列表全是新的行；Shift 区间沿 `resultPickKeys` 走；展开/折叠在块内，块的高度由 ResizeObserver 重新量。
