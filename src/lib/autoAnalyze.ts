/**
 * 分析的自动化：播放即分析、选中即分析、空闲时后台补齐。
 *
 * 为什么三件事挤在一个模块里：它们共享同一份「这一首已经交给后端了」的记号。
 * 分散到各自的组件里记的话，双击播放（浏览器先发 click 选中、再发 dblclick 播放）
 * 会把同一首歌排两遍队。
 *
 * **硬约束：任何一条路径都不许传 force。** Rust 版和 Python 版的 BPM 有约 10%
 * 会选到不同的倍数（算法在这些曲子上本来就是平局），重算已分析的曲目
 * 会把用户上千首的和声推荐整体打乱。详见 docs/rust-port/03-analysis-pipeline.md。
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
let backfillInFlight = false;

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
    // 一批跑完立刻接上下一批。等下一次轮询的话中间空 4 秒，
    // 那条进度行会灭一下再亮，底下整张表跟着跳一次高度。
    if (state.analyze !== previous.analyze && !selectAnalyzing(state)) void tick();
  });
  // 兜底轮询。空闲与否是三个 store 合起来的状态（分析、扫描、下载），
  // 全靠事件推的话每多一个来源就要记得补一条订阅，漏一条就再也不补齐了。
  const timer = setInterval(() => void tick(), IDLE_POLL_MS);
  return () => {
    unsubscribe();
    clearInterval(timer);
    if (selectionTimer !== null) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
    }
  };
}
