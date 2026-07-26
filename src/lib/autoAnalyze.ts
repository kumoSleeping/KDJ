/**
 * 分析的自动化：播放即分析、可视区域即分析、选中即分析、空闲时后台补齐。
 *
 * 为什么这几件事挤在一个模块里：它们共享同一份「这一首已经交给后端了」的记号。
 * 分散到各自的组件里记的话，双击播放（浏览器先发 click 选中、再发 dblclick 播放）
 * 会把同一首歌排两遍队；滚动和选中更是天然重叠——看着的那一屏往往就包含选中行。
 *
 * **优先级三档，靠"什么时候提交、提交多少、批内怎么排"实现**：
 * 后端没有全局队列——每收到一批就当场起一组线程跑（`jobs.rs::spawn_analysis`），
 * 同时提交两批只会互相抢 CPU，`priority` 那个布尔管的是"不受停止影响"而不是排序。
 * 所以顺序完全是前端的责任：
 *
 * | 档 | 谁 | 怎么落地 |
 * | --- | --- | --- |
 * | 高 | 正在播放的那一首 | priority=true，单独一批，不和「停止」一起被掐 |
 * | 中 | 可视区域 + 选中 | 立刻提交；批内**真正看得见的行排在预取余量前面** |
 * | 低 | 后台补齐 | 用户刚看过列表的那阵子不提交，把 CPU 让出来 |
 *
 * 自动路径一律不传 force：那是**为了省时间**（1400 首重算约 30 分钟），
 * 不再是安全约束——用户已明确放行重算，工具栏上有显式的「重新分析全部」入口。
 * 见 docs/rust-port/HANDOFF.md §6.1。
 */

import { api } from "./api";
import { useAppStore } from "../stores/appStore";
import { useDownloadStore } from "../stores/downloadStore";
import { selectAnalyzing, useLibraryStore } from "../stores/libraryStore";
import type { Track } from "../types";

/**
 * 选中触发分析的去抖。按住方向键划过一列表曲目时，每一下都发请求
 * 等于把整页都排进队列；500ms 是「手停下来了」的经验值，
 * 和曲库筛选那 250ms 拉开一档：排队比筛选更贵，宁可多等一会。
 */
const SELECTION_DEBOUNCE_MS = 500;

/**
 * 滚动去抖。**滚动过程中一条请求都不发**：飞过去的那几十屏是"路过"不是"在看"，
 * 每一帧都提交等于把整个曲库按滚动路径灌进队列，正好是这条路要避免的事。
 * 250ms 取的是"手指离开触控板"的经验值，和曲库筛选那 250ms 同一档。
 */
const VIEWPORT_DEBOUNCE_MS = 250;

/**
 * 可视区域的预取余量：视口上下各多算一屏。
 * 只算眼前那十几行的话，用户轻轻一滚就走到未分析的行上——
 * 分析一首要好几秒，等看见了才排队，看到的仍然是空白的 BPM。
 */
const VIEWPORT_MARGIN_SCREENS = 1;

/**
 * 可视区域一次最多排这么多。视口 + 上下各一屏大约 60~75 行，
 * 封顶是为了防"窗口拉到全屏 + 行高很小"时一次灌进去几百首，
 * 那样后台补齐让不让路都没意义了。剩下的下次滚动停下来再排。
 */
const VIEWPORT_BATCH = 60;

/**
 * 用户刚滚过之后，后台补齐让路这么久。
 *
 * 10 秒 ≈ 4 首歌的分析时间，够眼前这一屏先出几行结果；
 * 再长的话用户只是把窗口晾在那儿，后台就一直不干活了。
 */
const VIEWPORT_YIELD_MS = 10000;

/**
 * 后台补齐一次只排这么多。一上来把 1379 首全推给后端的话，
 * 进度条会卡在一个几十分钟不动的分母上，中途想停也只能全停。
 * 小批还有个附带好处：后端每批结束才发一次 library.updated，
 * 20 首一刷比 1379 首跑完才刷更早看到 BPM 落到表里。
 */
const BACKFILL_BATCH = 20;

/** 空闲探测间隔。只是读几个 store 的字段，空转成本可以忽略。 */
const IDLE_POLL_MS = 4000;

/** 本会话已经交给后端排过队的 id。同一首不重复排。 */
const queued = new Set<number>();

/** 已经插过队的 id。正在播的那一首最多插一次，避免来回切歌时反复插。 */
const jumped = new Set<number>();

/** 队头那批全是排过还没落库的（被取消、或文件已消失），再排也没用。 */
let stalled = false;

let selectionTimer: ReturnType<typeof setTimeout> | null = null;
let viewportTimer: ReturnType<typeof setTimeout> | null = null;
let backfillInFlight = false;

/**
 * 用户最后一次"在看列表"的时刻（滚了一下，或者刚给可视区域排过一批）。
 * 后台补齐读它来让路。0 = 本会话还没滚过。
 */
let viewportAt = 0;

/**
 * 自动分析的总开关。
 *
 * `auto_analyze` 是设置里那条「自动分析」，扫描/下载后要不要顺带分析看的也是它。
 * `autoAnalyzeSuspended` 是用户刚按过「停止」——几秒后空闲探测又排一批上来的话，
 * 那个按钮等于没按。重新点「分析」才解除。
 */
function autoEnabled(): boolean {
  if (useLibraryStore.getState().autoAnalyzeSuspended) return false;
  return useAppStore.getState().settings?.auto_analyze ?? true;
}

/* ------------------------------------------------------------ 播放即分析 */

/**
 * 放到一首还没分析的歌 → 让它插队。
 *
 * 批量可能排了几百首，正在放的这首等在队尾出不来 BPM/调号，
 * 而「现在放的是什么速度、什么调」恰恰是最急着要知道的一条。
 * 这条路径**不看** autoAnalyzeSuspended：按播放是明确的当下动作，
 * 而且只有一首歌的开销，不属于用户按「停止」时想停掉的那种后台活。
 */
export function analyzePlaying(track: Track): void {
  if (track.analyzed_at || jumped.has(track.id)) return;
  jumped.add(track.id);
  queued.add(track.id);
  void useLibraryStore
    .getState()
    .startAnalyze([track.id], false, true)
    .catch(() => {
      // 插队失败不打扰用户：把记号撤掉，普通队列迟早会轮到它
      jumped.delete(track.id);
      queued.delete(track.id);
    });
}

/* ------------------------------------------------------------ 选中即分析 */

function scheduleSelection(): void {
  if (selectionTimer !== null) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    selectionTimer = null;
    void analyzeSelection();
  }, SELECTION_DEBOUNCE_MS);
}

/**
 * 把选中里还没分析的排进**普通**队列——不插队：插队通道是留给正在放的那一首的，
 * 随手点几下就把它挤掉的话，用户听着的这首反而最后才出结果。
 */
async function analyzeSelection(): Promise<void> {
  if (!autoEnabled()) return;
  const state = useLibraryStore.getState();
  const chosen = new Set(state.selectedIds);
  if (chosen.size === 0) return;

  const ids = state.tracks
    .filter((track) => chosen.has(track.id) && !track.analyzed_at && !queued.has(track.id))
    .map((track) => track.id);
  // 页外选中（从和声推荐点进来的那种）不在当前这页 200 行里，单独看一眼
  const outside = state.selectedTrack;
  if (
    outside &&
    chosen.has(outside.id) &&
    !outside.analyzed_at &&
    !queued.has(outside.id) &&
    !ids.includes(outside.id)
  ) {
    ids.push(outside.id);
  }
  if (ids.length === 0) return;

  for (const id of ids) queued.add(id);
  try {
    await state.startAnalyze(ids, false, false);
  } catch {
    // 排队失败就把记号撤回去，下次再选中还能重试
    for (const id of ids) queued.delete(id);
  }
}

/* ------------------------------------------------------------ 可视区域即分析 */

/**
 * 曲目表的滚动容器。
 *
 * 为什么不是 TrackTable 传进来的 ref：那个文件同时有别人在改，
 * 这条路径必须做到"一行都不用它配合"。想要更稳的话调用 `observeTrackScroller`
 * 显式登记，登记过就不再去 DOM 里现找。
 */
let scroller: HTMLElement | null = null;

/**
 * 显式登记曲目表的滚动容器（可选）。TrackTable 给 `.kd-scroll` 挂个 ref 调这里，
 * 就不用靠下面那条选择器去认表了。传 null = 卸载。
 */
export function observeTrackScroller(element: HTMLElement | null): void {
  scroller = element;
}

/**
 * 找到曲目表的滚动容器。
 *
 * 认表认的是 `td[data-col="title"]`：搜索结果表和曲目表长得一模一样
 * （同一套 `.kd-scroll` + `.kd-table`），按 class 找会认错表，
 * 按下标映射就会算出**另一张表**的曲目 id。`data-col` 只有曲目表在用。
 */
function findScroller(): HTMLElement | null {
  if (scroller?.isConnected) return scroller;
  const cell = document.querySelector("td[data-col='title']");
  scroller = cell?.closest<HTMLElement>(".kd-scroll") ?? null;
  return scroller;
}

/**
 * 视口（含上下各一屏预取余量）里还没分析、也还没排过队的曲目 id。
 *
 * **真正在屏幕里的排在前面**，预取余量排后面：后端是按给定顺序分块跑的，
 * 混在一起的话用户眼前那几行可能被排到屏幕外的行后面——
 * 那就又回到"忙着背后的工作"了。
 */
function viewportIds(): number[] {
  const box = findScroller();
  const body = box?.querySelector("tbody");
  if (!box || !body) return [];
  const { tracks } = useLibraryStore.getState();
  const rows = body.rows;
  // 行数对不上 = DOM 和 store 不是同一批（正在重渲染，或者认错了表）。
  // 按下标映射会排到别人的 id 上，这一轮宁可什么都不做：
  // 下一次滚动、或者下一次 tracks 变化都会重来。
  if (rows.length === 0 || rows.length !== tracks.length) return [];

  const view = box.getBoundingClientRect();
  const margin = view.height * VIEWPORT_MARGIN_SCREENS;
  const inView: number[] = [];
  const nearby: number[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const rect = rows[index].getBoundingClientRect();
    if (rect.bottom < view.top - margin) continue;
    // 行是自上而下排的，越过下边界之后不用再量了（量满 200 行 rect 会强制回流）
    if (rect.top > view.bottom + margin) break;
    const track = tracks[index];
    if (!track || track.analyzed_at || queued.has(track.id)) continue;
    const visible = rect.bottom > view.top && rect.top < view.bottom;
    (visible ? inView : nearby).push(track.id);
    if (inView.length + nearby.length >= VIEWPORT_BATCH) break;
  }
  return [...inView, ...nearby];
}

/**
 * 把眼前这一屏还没分析的排进**普通**队列。
 *
 * 不插队：插队通道只留给正在放的那一首。滚动一下就插队的话，
 * 用户正听着的这首会被自己刚划过去的十几行顶到后面。
 */
async function analyzeViewport(): Promise<void> {
  if (!autoEnabled()) return;
  const ids = viewportIds();
  if (ids.length === 0) return;
  for (const id of ids) queued.add(id);
  // 先记时间再发请求：这一批还在路上时后台补齐就该让开，
  // 等响应回来再记的话，中间那一轮空闲探测正好能插进来抢走队列。
  viewportAt = Date.now();
  try {
    await useLibraryStore.getState().startAnalyze(ids, false, false);
  } catch {
    // 排队失败就把记号撤回去，下次滚动/刷新还能重试
    for (const id of ids) queued.delete(id);
  }
}

function scheduleViewport(): void {
  if (viewportTimer !== null) clearTimeout(viewportTimer);
  viewportTimer = setTimeout(() => {
    viewportTimer = null;
    void analyzeViewport();
  }, VIEWPORT_DEBOUNCE_MS);
}

/**
 * 滚动监听。用捕获阶段挂在 document 上：scroll 不冒泡，
 * 而滚动容器在 TrackTable 内部——捕获是唯一不改那个文件就能听到它的办法。
 */
function onScrollCapture(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("kd-scroll")) return;
  if (target !== findScroller()) return;
  // 光是"在滚"就足以让后台补齐让路：用户显然在找东西，
  // 这时候灌 20 首进队列，等他停下来时眼前这屏得排在那 20 首后面。
  viewportAt = Date.now();
  scheduleViewport();
}

/* ------------------------------------------------------------ 后台补齐 */

/** 现在能不能占用 CPU：分析在跑、扫描在跑、有下载在传，都算不空闲。 */
function idle(): boolean {
  const library = useLibraryStore.getState();
  if (selectAnalyzing(library)) return false;
  if (library.scan !== null && library.scan.phase !== "done") return false;
  // 只看真正在传的：auto_start_downloads 关着时队列里会一直躺着 queued 的任务，
  // 拿它当忙的话后台补齐永远轮不上。
  return !useDownloadStore.getState().list.some((task) => task.state === "running");
}

/** 排上一批就返回 true。返回 false = 这一轮没什么可补的。 */
async function backfill(): Promise<boolean> {
  if (backfillInFlight || stalled) return false;
  if (!autoEnabled() || !idle()) return false;
  // 用户刚在看列表：CPU 先留给他眼前那一屏。
  // 后端每批各起各的线程组，一起跑就是一起慢，所以"低优先级"只能靠**晚点提交**。
  if (Date.now() - viewportAt < VIEWPORT_YIELD_MS) return false;
  const library = useLibraryStore.getState();
  const pending = library.stats ? library.stats.total - library.stats.analyzed : 0;
  if (pending <= 0) return false;

  backfillInFlight = true;
  try {
    // 从最近加进来的开始补：新下的歌最可能是用户下一步要用的
    const page = await api.tracks({
      analyzed: "false",
      sort: "added_at",
      order: "desc",
      limit: BACKFILL_BATCH,
      offset: 0,
    });
    const ids = page.items.map((track) => track.id).filter((id) => !queued.has(id));
    if (ids.length === 0) {
      // 队头这批全排过却还是没分析上（取消掉了，或者文件没了）。
      // 再排一遍还是同一批，这一会话就不补了，等用户手动点「分析」。
      stalled = page.items.length > 0;
      return false;
    }
    // 这中间隔了一次网络往返，用户可能刚好点了播放或开始下载，再确认一次
    if (!autoEnabled() || !idle()) return false;
    for (const id of ids) queued.add(id);
    const response = await library.startAnalyze(ids, false, false);
    return response.queued > 0;
  } catch {
    // 后端没起来之类：下一轮再试，不打扰用户
    return false;
  } finally {
    backfillInFlight = false;
  }
}

/** 后面没有下一批了，把停在 100% 的那条进度收掉。 */
function tidyProgress(): void {
  const library = useLibraryStore.getState();
  if (library.analyze === null || backfillInFlight) return;
  if (selectAnalyzing(library)) return;
  library.clearAnalyzeProgress();
}

async function tick(): Promise<void> {
  const started = await backfill();
  if (!started) tidyProgress();
}

/* ------------------------------------------------------------ 生命周期 */

/**
 * 忘掉所有「排过队」的记号。用户按「停止」之后（那一批被取消了，得能重新排）
 * 和手动点「分析」之后（他要的就是重来一遍）调用。
 */
export function forgetQueuedAnalysis(): void {
  queued.clear();
  stalled = false;
}

/** 挂上选中订阅和空闲探测，返回停掉它们的函数。连不上后端时不该跑，所以由 App 控制。 */
export function startAutoAnalyze(): () => void {
  const unsubscribe = useLibraryStore.subscribe((state, previous) => {
    if (state.selectedIds !== previous.selectedIds) scheduleSelection();
    // 列表换了内容也要重看一眼视口：首屏（用户一次都没滚过）、切文件夹、
    // 改筛选、翻下一页，这些时候"眼前是什么"全变了，但一个 scroll 事件都不会有。
    // 已排过队的 id 会在 viewportIds 里被滤掉，所以稳态下这条不会打出多余请求。
    if (state.tracks !== previous.tracks) scheduleViewport();
    // 一批跑完立刻接上下一批。等下一次轮询的话中间空 4 秒，
    // 那条进度行会灭一下再亮，底下整张表跟着跳一次高度。
    if (state.analyze !== previous.analyze && !selectAnalyzing(state)) void tick();
  });
  document.addEventListener("scroll", onScrollCapture, true);
  // 兜底轮询。空闲与否是三个 store 合起来的状态（分析、扫描、下载），
  // 全靠事件推的话每多一个来源就要记得补一条订阅，漏一条就再也不补齐了。
  const timer = setInterval(() => void tick(), IDLE_POLL_MS);
  return () => {
    unsubscribe();
    document.removeEventListener("scroll", onScrollCapture, true);
    clearInterval(timer);
    if (selectionTimer !== null) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
    }
    if (viewportTimer !== null) {
      clearTimeout(viewportTimer);
      viewportTimer = null;
    }
    scroller = null;
  };
}
