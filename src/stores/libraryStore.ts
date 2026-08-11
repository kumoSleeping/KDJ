/**
 * 曲库列表 + 筛选 + 选中 + 导入/分析进度。
 * 列表数据永远由 refresh() 从后端拉（筛选/排序都在 SQL 里做），前端不做二次过滤。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import { continueDataUpgrade } from "../lib/dataUpgrade";
import { resolveLibraryPasteOp } from "../lib/libraryPaste";
import { isOutsideFolder } from "../lib/outsideFolder";
import { cycleTableSort } from "../lib/tableSort";
import type {
  AnalyzeProgress,
  AnalyzeResponseLike,
  FileDisposalMode,
  FileOp,
  FolderOpResult,
  FolderTree,
  FolderUndoResponse,
  FolderUndoStatus,
  LibraryStats,
  MaintenanceProgress,
  ScanProgress,
  ScanResponseLike,
  Track,
  TrackPatch,
  TrackPatchResult,
  WsEvent,
} from "../types";

/** "custom" = 文件夹清单里的手排顺序（拖动排序写进 .kdj/manifest.json）。 */
export type TrackSort =
  | "added_at" | "title" | "artist" | "album" | "bpm" | "camelot" | "energy" | "duration" | "rating" | "custom";
export type SortOrder = "asc" | "desc";
/** 入库序 = "没有显式排序"。cycleSort 用它判断有没有主键。 */
const DEFAULT_SORT: TrackSort = "added_at";
/** 「已分析」三态筛选：全部 / 只看已分析 / 只看未分析。 */
export type AnalyzedFilter = "all" | "yes" | "no";

/** 多选点击语义，和访达/资源管理器一致。 */
export type SelectMode = "replace" | "toggle" | "range";

export interface LibraryFilter {
  q: string;
  key: string; // Camelot 码，如 "8A"；空串 = 不限
  bpmMin: number | null;
  bpmMax: number | null;
  energyMin: number | null;
  analyzed: AnalyzedFilter;
  /** 绝对目录路径；空串 = 不限目录（看全库）。 */
  folder: string;
  /** true = 连子文件夹一起看。 */
  folderDeep: boolean;
  sort: TrackSort;
  order: SortOrder;
  /**
   * 副排序键：主键相同的那一撮再按它排。null = 只按主键。
   *
   * DJ 排 set 的实际用法是「先按 BPM，同 BPM 里再按调号」——
   * 只有一个键时，同 BPM 的那十几首是乱序的，得靠眼睛在里面找能接的调。
   */
  sort2: TrackSort | null;
  order2: SortOrder;
}

const FOLDER_SESSION_KEY = "kd-library-folder";

function writeSessionFolder(folder: string): void {
  try {
    if (folder.trim()) sessionStorage.setItem(FOLDER_SESSION_KEY, folder);
    else sessionStorage.removeItem(FOLDER_SESSION_KEY);
  } catch {
    /* private mode */
  }
}

export const DEFAULT_FILTER: LibraryFilter = {
  q: "",
  key: "",
  bpmMin: null,
  bpmMax: null,
  energyMin: null,
  analyzed: "all",
  folder: "",
  // 「含子级」的开关已从界面删掉：选中一个歌单文件夹时想看的本来就是
  // 它整棵子树里的曲目，做成开关只是把一个没人会关的选项摆在最显眼的位置。
  // 字段留着——后端 API 仍然收它。
  folderDeep: true,
  sort: "added_at",
  order: "desc",
  sort2: null,
  order2: "asc",
};

const PAGE_SIZE = 200;
const FILTER_DEBOUNCE_MS = 250;

/**
 * 筛选防抖：搜索框每敲一个字母都会打一次 SQLite + 一次 HTTP，
 * 曲库上万条时连打十几次是纯浪费；250ms 是"手停下来"的经验值，
 * 既不会让人觉得卡，又能把一次输入合并成一个请求。
 */
let filterTimer: ReturnType<typeof setTimeout> | null = null;
/** 请求序号：慢的旧响应回来时直接丢弃，避免覆盖新筛选的结果。 */
let requestSeq = 0;

function cancelPending(): void {
  if (filterTimer !== null) {
    clearTimeout(filterTimer);
    filterTimer = null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 插队分析（正在播放的那一首）的 job_id。这些批次不占进度条：
 * 那条进度条讲的是「批量还剩多少」，被一首歌的 0/1 顶掉会让人以为批量被重置了。
 * 批次收尾时删掉，否则挂一整夜这个集合只涨不减。
 */
const quietJobs = new Set<string>();

/**
 * 进度条同一时刻只跟一批走。插队的、选中触发的、后台补齐的批次会同时存在，
 * 谁都往里写的话数字会来回跳（300/1379 突然变成 0/20 再跳回去）。
 * 已经有一批没跑完时，新来的先不抢；跑完了才让位。
 */
function claimProgress(current: AnalyzeProgress | null, next: AnalyzeProgress): AnalyzeProgress {
  // 多个自动分析批次可能同时排队。旧逻辑只要当前批次还是 0/20，就拒绝
  // 其他 job 的所有事件；结果后端明明在满速分析、数据库持续增长，界面却永远
  // 钉在第一个尚未拿到 worker 的 0/20。另一批已经 done>0 时，它才是真正在
  // 工作的批次，应该接管进度显示；只有双方都尚未开始时才保住当前项。
  if (
    current &&
    current.job_id !== next.job_id &&
    current.done < current.total &&
    next.done === 0
  ) {
    return current;
  }
  return next;
}

function toQuery(
  filter: LibraryFilter,
  offset: number,
): Record<string, string | number | undefined> {
  return {
    q: filter.q.trim(),
    key: filter.key,
    bpm_min: filter.bpmMin ?? undefined,
    bpm_max: filter.bpmMax ?? undefined,
    energy_min: filter.energyMin ?? undefined,
    analyzed: filter.analyzed === "all" ? undefined : String(filter.analyzed === "yes"),
    folder: filter.folder,
    folder_deep:
      filter.folder && !isOutsideFolder(filter.folder) && filter.folderDeep ? "true" : undefined,
    sort: filter.sort,
    order: filter.order,
    sort2: filter.sort2 ?? undefined,
    order2: filter.sort2 ? filter.order2 : undefined,
    limit: PAGE_SIZE,
    offset,
  };
}

/** 剪贴板：复制/剪切走的曲目，等一次粘贴。 */
export interface LibraryClipboard {
  ids: number[];
  op: FileOp;
}

export interface LibraryStore {
  tracks: Track[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  filter: LibraryFilter;
  /** 详情栏跟着它走 = 最后点的那一首。 */
  selectedId: number | null;
  /** 多选集合。单选时就是 [selectedId]。 */
  selectedIds: number[];
  /**
   * 显式批选模式（右键 / 长按进入）。Cmd/Ctrl 点选不必开它，
   * 但活动区要靠它决定要不要露出「完成 / 复制」那一排。
   */
  selectionMode: boolean;
  /**
   * 页外选中的暂存：从「接下一首」点的歌大多不在当前这页 200 行里，
   * 只存 id 的话详情栏会因为在页里找不到而变空。带着整个对象选中就没这个洞。
   */
  selectedTrack: Track | null;
  clipboard: LibraryClipboard | null;
  folders: FolderTree | null;
  stats: LibraryStats | null;
  undo: FolderUndoStatus;
  undoError: string;
  scan: ScanProgress | null;
  analyze: AnalyzeProgress | null;
  /** 旧数据升级与缓存维护共用活动栏；不同任务可顺序接力，失败项会保留。 */
  maintenance: MaintenanceProgress[];
  /**
   * 用户刚按过「停止」。自动化的那几条路径（选中即分析、后台补齐）看着它，
   * 否则几秒后空闲探测又排一批上来，那个按钮等于没按。
   * 重新点「分析」才解除。
   */
  autoAnalyzeSuspended: boolean;
  refresh(): Promise<void>;
  /** 连续翻页直到列表里出现该 id（或已到库底）。 */
  ensureTrackLoaded(id: number): Promise<void>;
  loadMore(): Promise<void>;
  refreshStats(): Promise<void>;
  refreshFolders(): Promise<void>;
  refreshUndo(): Promise<void>;
  setFilter(patch: Partial<LibraryFilter>): void;
  /**
   * 点一次排序列。三段式，和用户的描述逐条对应：
   *   · 点的是**主键** → 翻转它的方向；再点一次（回到最初方向）→ 取消这一列
   *   · 点的是**副键** → 它升为主键，原主键降为副键（两者对调）
   *   · 点的是**没参与排序的列** → 成为副键（已有主键时）或主键（没有主键时）
   *
   * 为什么把"取消"挂在主键的第三次点击上：用户明确要"再点一下取消这个操作"，
   * 而一列只有升/降两个有意义的方向，第三次点回原状正好是"我不要按它排了"。
   */
  cycleSort(column: TrackSort): void;
  resetFilter(): void;
  select(id: number | null, mode?: SelectMode): void;
  /** 用完整对象选中（推荐列表这类"来源不在当前页"的入口用这个）。 */
  selectTrack(track: Track): void;
  selectAll(): void;
  setSelectionMode(on: boolean): void;
  copyToClipboard(op: FileOp): void;
  /** `op` 覆盖剪贴板里记的操作：Cmd+Option+V 强制按移动粘贴。 */
  paste(dest: string, op?: FileOp): Promise<FolderOpResult | null>;
  applyFolderOp(ids: number[], dest: string, op: FileOp): Promise<FolderOpResult>;
  undoLast(): Promise<FolderUndoResponse>;
  clearUndoError(): void;
  /**
   * 「添加文件夹」背后的一整套后台动作：把目录登记成曲库根、遍历入库、
   * （analyze 时）把新曲目排进分析队列。调用方只负责把目录交出去，
   * 不用再引导用户点第二个按钮。
   */
  startScan(paths: string[], analyze?: boolean): Promise<ScanResponseLike>;
  startAnalyze(
    trackIds: number[] | null,
    force?: boolean,
    priority?: boolean,
    version?: "v1" | "v2",
    limit?: number,
    folder?: string,
  ): Promise<AnalyzeResponseLike>;
  cancelAnalyze(): Promise<void>;
  setAutoAnalyzeSuspended(value: boolean): void;
  /**
   * 收掉进度条。跑完的那一批会先留在条上（让人看见"完了"），
   * 确认后面没有下一批接着跑之后才由空闲探测收走——
   * 一到 100% 就立刻消失的话，一批接一批跑时整条工具行会一灭一亮，列表跟着跳。
   */
  clearAnalyzeProgress(): void;
  /**
   * 返回的是 `TrackPatchResult`：它就是一条 Track，只是可能多带一个
   * `tag_write_error`。数据库存住了、文件标签没写进去时要靠它告诉用户，
   * 吞掉的话用户会以为拖进 Rekordbox 的也是新的。
   */
  updateTrack(id: number, patch: TrackPatch): Promise<TrackPatchResult>;
  writeTags(id: number): Promise<Track>;
  /** 换封面。返回的 Track 里 size / modified_at 会跟着变，所以要回写进列表。 */
  setCover(id: number, file: Blob): Promise<Track>;
  /** 按文件里现存的标签刷新库里那条记录。 */
  rereadTags(id: number): Promise<Track>;
  removeTrack(id: number, deleteFile?: boolean): Promise<void>;
  /**
   * 批量删除（多选右键菜单走这条）。一次请求删整批：逐条打 N 个请求
   * 会推 N 条 WS 事件、触发 N 轮防抖刷新。
   * 返回后端的失败清单（track id → 原因）；没删成的那些行会留在列表里。
   */
  removeTracks(ids: number[], file: FileDisposalMode): Promise<Record<string, string>>;
  /**
   * 从软件移出文件夹：摘掉库记录（根目录还会注销曲库登记），磁盘文件不动。
   * 返回被摘掉的曲目数，供界面提示。
   */
  forgetFolder(path: string): Promise<number>;
  handleEvent(event: WsEvent): void;
}

export const useLibraryStore = create<LibraryStore>()((set, get) => ({
  tracks: [],
  total: 0,
  loading: false,
  loadingMore: false,
  error: "",
  // 刷新后仍回到刚才打开的文件夹，待下载行才对得上 dest_dir。
  filter: { ...DEFAULT_FILTER, folder: "" },
  selectedId: null,
  selectedIds: [],
  selectionMode: false,
  selectedTrack: null,
  clipboard: null,
  folders: null,
  stats: null,
  undo: { available: false, op: null, count: 0 },
  undoError: "",
  scan: null,
  analyze: null,
  maintenance: [],
  autoAnalyzeSuspended: false,

  async refresh() {
    cancelPending();
    const seq = ++requestSeq;
    // 删曲 / 分析回填都会触发 library.updated → refresh。
    // 若永远只拉第一页，用户滚到第 500 首时列表高度突然塌回 200 行，
    // 视口就会「弹回顶部」——保留当前已加载深度，滚动位置才站得住。
    const keepCount = Math.max(PAGE_SIZE, get().tracks.length);
    set({ loading: true });
    try {
      const items: Track[] = [];
      let total = 0;
      while (items.length < keepCount) {
        const page = await api.tracks(toQuery(get().filter, items.length));
        if (seq !== requestSeq) return;
        total = page.total;
        if (page.items.length === 0) break;
        const seen = new Set(items.map((item) => item.id));
        items.push(...page.items.filter((item) => !seen.has(item.id)));
        if (items.length >= total || page.items.length < PAGE_SIZE) break;
      }
      if (seq !== requestSeq) return;
      // 故意不动 selectedId：分析进度会不停触发 refresh，
      // 一旦顺手清选中，用户看详情时会被反复踢出去。选中项落在页外时
      // selectSelectedTrack 自然返回 null，交给视图处理。
      set({ tracks: items, total, loading: false, error: "" });
    } catch (error) {
      if (seq !== requestSeq) return;
      set({ loading: false, error: errorText(error) });
    }
  },

  /**
   * 把指定曲目滚进已加载窗口：定位「正在播」时，refresh 塌页或尚未翻到那一页
   * 都会让表里找不到行。连续 loadMore，直到看见它或到库底。
   */
  async ensureTrackLoaded(id: number) {
    // refresh 进行中先等它结束，否则 loadMore 会被 loading 守卫挡住。
    for (let i = 0; i < 80 && get().loading; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (;;) {
      const { tracks, total, loadingMore } = get();
      if (tracks.some((track) => track.id === id)) return;
      if (tracks.length >= total) return;
      if (loadingMore) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const before = tracks.length;
      await get().loadMore();
      if (get().tracks.length <= before) return;
    }
  },

  async loadMore() {
    const { tracks, total, loadingMore, loading } = get();
    if (loadingMore || loading || tracks.length >= total) return;
    const seq = requestSeq;
    set({ loadingMore: true });
    try {
      const page = await api.tracks(toQuery(get().filter, tracks.length));
      if (seq !== requestSeq) {
        // 页作废，但 loadingMore 必须跟着复位：后台分析每推一次
        // library.updated 就会触发 refresh 把 requestSeq 往前推，
        // 翻页请求撞上就被作废——不复位的话这道守卫会把之后所有
        // loadMore 都挡掉，底部「加载更多」永远转圈。曲库越大、
        // 后台分析越忙，这个竞态越容易中。
        set({ loadingMore: false });
        return;
      }
      const seen = new Set(get().tracks.map((item) => item.id));
      const merged = [...get().tracks, ...page.items.filter((item) => !seen.has(item.id))];
      set({ tracks: merged, total: page.total, loadingMore: false });
    } catch (error) {
      // 已被新筛选取代的请求失败，只复位状态，别把过期错误糊到现在的筛选上
      if (seq !== requestSeq) {
        set({ loadingMore: false });
        return;
      }
      set({ loadingMore: false, error: errorText(error) });
    }
  },

  async refreshStats() {
    try {
      set({ stats: await api.stats() });
    } catch {
      // 统计只是标题栏/概览的装饰，拉不到就保持旧值，不打扰用户
    }
  },

  cycleSort(column) {
    const { sort, order, sort2, order2 } = get().filter;
    get().setFilter(cycleTableSort(
      { sort, order, sort2, order2 },
      column,
      DEFAULT_SORT,
      "desc",
    ));
  },

  setFilter(patch) {
    cancelPending();
    const filter = { ...get().filter, ...patch };
    if ("folder" in patch) writeSessionFolder(filter.folder);
    set({
      filter,
    });
    filterTimer = setTimeout(() => {
      filterTimer = null;
      void get().refresh();
    }, FILTER_DEBOUNCE_MS);
  },

  resetFilter() {
    cancelPending();
    writeSessionFolder("");
    set({
      filter: { ...DEFAULT_FILTER },
    });
    void get().refresh();
  },

  async refreshFolders() {
    try {
      const folders = await api.folders();
      const filter = get().filter;
      // 「其他」里已经没有歌了：退回全部曲目，别留在空哨兵筛选上。
      if (isOutsideFolder(filter.folder) && folders.outside <= 0) {
        set({ folders, filter: { ...filter, folder: "" } });
        void get().refresh();
        return;
      }
      set({ folders });
    } catch {
      // 没配曲库目录时后端会给 400；文件夹面板自己会显示空态，不用弹错
    }
  },

  async refreshUndo() {
    try {
      set({ undo: await api.folderUndoStatus() });
    } catch {
      // 旧后端没有撤回接口时保持默认不可用，不阻塞曲库加载。
    }
  },

  select(id, mode = "replace") {
    // 按 id 选中都发生在当前页里，页外暂存到这里就过期了
    set({ selectedTrack: null });
    if (id === null) {
      set({ selectedId: null, selectedIds: [], selectionMode: false });
      return;
    }
    const { selectedId, selectedIds, tracks } = get();
    if (mode === "toggle") {
      // Cmd/Ctrl 点：加进去或拿出来。锚点跟着最后动的那一条走。
      const has = selectedIds.includes(id);
      const next = has ? selectedIds.filter((item) => item !== id) : [...selectedIds, id];
      set({ selectedIds: next, selectedId: has ? (next[next.length - 1] ?? null) : id });
      return;
    }
    if (mode === "range" && selectedId !== null) {
      // Shift 点：按**当前显示顺序**取区间，不是按 id——用户看到的是排序后的表。
      const from = tracks.findIndex((track) => track.id === selectedId);
      const to = tracks.findIndex((track) => track.id === id);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        set({ selectedIds: tracks.slice(lo, hi + 1).map((track) => track.id), selectedId: id });
        return;
      }
    }
    set({ selectedId: id, selectedIds: [id] });
  },

  selectTrack(track) {
    set({ selectedId: track.id, selectedIds: [track.id], selectedTrack: track });
  },

  selectAll() {
    const { tracks } = get();
    set({
      selectedIds: tracks.map((track) => track.id),
      selectedId: get().selectedId ?? (tracks[0]?.id ?? null),
    });
  },

  setSelectionMode(on) {
    set({ selectionMode: on });
  },

  copyToClipboard(op) {
    const ids = get().selectedIds;
    if (ids.length > 0) set({ clipboard: { ids: [...ids], op } });
  },

  async paste(dest, op) {
    const clip = get().clipboard;
    if (!clip || !dest) return null;
    // 未显式指定时：剪切仍移动；普通粘贴复制一份真实本地文件。
    const used = op ?? resolveLibraryPasteOp({ clipboardOp: clip.op });
    const result = await get().applyFolderOp(clip.ids, dest, used);
    // 剪切、或 Option 强制移动：粘一次就清空；普通复制可连粘
    if (used === "move") set({ clipboard: null });
    return result;
  },

  async applyFolderOp(ids, dest, op) {
    const result = await api.applyFolderOp(ids, dest, op);
    set({ undo: result.undo, undoError: "" });
    await get().refresh();
    void get().refreshFolders();
    void get().refreshStats();
    // 移动后选中项还在（id 没变）；复制出来的是新 id，选中它们更符合预期
    if (op === "copy" && result.track_ids.length > 0) {
      set({ selectedIds: result.track_ids, selectedId: result.track_ids[0] });
    }
    return result;
  },

  async undoLast() {
    set({ undoError: "" });
    try {
      const result = await api.undoFolderOp();
      const affected = new Set(result.track_ids);
      const current = get();
      const isDelete = result.op === "delete";
      const restoredIds = isDelete && result.track_ids.length > 0 ? result.track_ids : null;
      set({
        undo: result.status,
        selectedIds:
          result.op === "copy"
            ? current.selectedIds.filter((id) => !affected.has(id))
            : restoredIds ?? current.selectedIds,
        selectedId:
          result.op === "copy"
            ? current.selectedId !== null && affected.has(current.selectedId)
              ? null
              : current.selectedId
            : restoredIds?.[0] ?? current.selectedId,
        selectedTrack:
          isDelete
            ? null
            : current.selectedTrack && affected.has(current.selectedTrack.id)
              ? null
              : current.selectedTrack,
      });
      await Promise.all([get().refresh(), get().refreshFolders(), get().refreshStats()]);
      if (restoredIds && restoredIds.length > 0) {
        const restoredTrack = get().tracks.find((track) => track.id === restoredIds[0]) ?? null;
        set({ selectedTrack: restoredTrack });
      }
      const failures = Object.values(result.errors);
      if (failures.length > 0) {
        set({ undoError: `已撤回 ${result.undone} 首，${failures.length} 首失败：${failures[0]}` });
      }
      return result;
    } catch (error) {
      set({ undoError: errorText(error) });
      void get().refreshUndo();
      throw error;
    }
  },

  clearUndoError() {
    set({ undoError: "" });
  },

  async startScan(paths, analyze = false) {
    const response = await api.scan(paths, analyze);
    set({ scan: { job_id: response.job_id, done: 0, total: response.found, current: "", phase: "walk" } });
    return response;
  },

  async startAnalyze(trackIds, force = false, priority = false, version = "v1", limit, folder = "") {
    const response = await api.analyze(trackIds, force, priority, version, limit, folder);
    if (priority) {
      // 插队分析（正在放的那首）不占用进度条：它只有一首，
      // 把工具栏那条几百首的进度覆盖掉会让人以为批量被重置了。
      // 记下来是因为它的进度事件照样会推过来，得在 handleEvent 里认出来丢掉。
      quietJobs.add(response.job_id);
    } else if (response.queued > 0) {
      // queued === 0 时**不能**建进度条：后端对空批次直接返回、一条事件都不发，
      // 一根 0/0 的进度条会永远挂在工具栏上收不回去。
      set({
        analyze: claimProgress(get().analyze, {
          job_id: response.job_id,
          done: 0,
          total: response.queued,
          current: "",
          track_id: null,
        }),
      });
    }
    return response;
  },

  async cancelAnalyze() {
    // 顺手摁灭自动补齐：不然停下来几秒后空闲探测又排一批，按钮等于没按
    set({ autoAnalyzeSuspended: true });
    // 空 job_id = 全停。**故意不传手里那个 job_id**：同一时刻常常有好几批在跑
    // （眼前这一屏一批、后台补齐一批），进度条只跟得住其中一批，
    // 只停它的话用户按了「停止」风扇还在转，那就是个假按钮。
    // 插队那批（正在放的那一首）后端压根没登记，全停也停不掉它——这是有意的。
    await api.cancelAnalyze("");
    set({ analyze: null });
  },

  setAutoAnalyzeSuspended(value) {
    set({ autoAnalyzeSuspended: value });
  },

  clearAnalyzeProgress() {
    set({ analyze: null });
  },

  async updateTrack(id, patch) {
    const track = await api.patchTrack(id, patch);
    set({
      tracks: get().tracks.map((item) => (item.id === id ? track : item)),
      selectedTrack: get().selectedTrack?.id === id ? track : get().selectedTrack,
    });
    return track;
  },

  async writeTags(id) {
    const track = await api.writeTags(id);
    set({
      tracks: get().tracks.map((item) => (item.id === id ? track : item)),
      selectedTrack: get().selectedTrack?.id === id ? track : get().selectedTrack,
    });
    return track;
  },

  async setCover(id, file) {
    const track = await api.setCover(id, file);
    set({
      tracks: get().tracks.map((item) => (item.id === id ? track : item)),
      selectedTrack: get().selectedTrack?.id === id ? track : get().selectedTrack,
    });
    return track;
  },

  async rereadTags(id) {
    const track = await api.rereadTags(id);
    set({
      tracks: get().tracks.map((item) => (item.id === id ? track : item)),
      selectedTrack: get().selectedTrack?.id === id ? track : get().selectedTrack,
    });
    return track;
  },

  async removeTrack(id, deleteFile = false) {
    await get().removeTracks([id], deleteFile ? "remove" : "keep");
  },

  async removeTracks(ids, file) {
    const result = await api.deleteTracks(ids, file);
    if (result.undo) {
      set({ undo: result.undo, undoError: "" });
    } else {
      // 兼容旧后端：至少把删除后的撤回状态重新拉一次，避免沿用过期栈。
      void get().refreshUndo();
    }
    // 失败的留在列表里：它们的库记录还在（后端删文件失败时连记录一起保留）
    const failed = new Set(Object.keys(result.errors).map(Number));
    const gone = new Set(ids.filter((id) => !failed.has(id)));
    if (gone.size > 0) {
      const {
        tracks: prevTracks,
        selectedId,
        selectedIds,
        selectedTrack,
        total,
      } = get();
      const nextTracks = prevTracks.filter((item) => !gone.has(item.id));
      let nextSelectedIds = selectedIds.filter((id) => !gone.has(id));
      let nextSelectedId =
        selectedId !== null && !gone.has(selectedId) ? selectedId : null;
      let nextSelectedTrack =
        selectedTrack !== null && !gone.has(selectedTrack.id) ? selectedTrack : null;

      // 锚点被删：落到原位置邻近的一首（同下标=下一首，删到末尾则上一首），
      // 选中不会飞走，详情栏也能继续钉在邻曲上。
      if (selectedId !== null && gone.has(selectedId)) {
        const focusIndex = prevTracks.findIndex((track) => track.id === selectedId);
        const neighbor =
          nextTracks.length === 0 || focusIndex < 0
            ? null
            : (nextTracks[Math.min(focusIndex, nextTracks.length - 1)] ?? null);
        nextSelectedId = neighbor?.id ?? null;
        nextSelectedIds = neighbor ? [neighbor.id] : [];
        nextSelectedTrack = neighbor;
      } else if (nextSelectedId === null && nextSelectedIds.length > 0) {
        nextSelectedId = nextSelectedIds[nextSelectedIds.length - 1] ?? null;
      }

      set({
        tracks: nextTracks,
        total: Math.max(0, total - gone.size),
        selectedId: nextSelectedId,
        selectedIds: nextSelectedIds,
        selectedTrack:
          nextSelectedId === null
            ? null
            : nextSelectedTrack?.id === nextSelectedId
              ? nextSelectedTrack
              : (nextTracks.find((track) => track.id === nextSelectedId) ?? null),
      });
      void get().refreshStats();
      void get().refreshFolders();
    }
    return result.errors;
  },

  async forgetFolder(path) {
    const result = await api.forgetFolder(path);
    const filter = get().filter;
    const folderGone =
      filter.folder === path ||
      filter.folder.startsWith(`${path}/`) ||
      filter.folder.startsWith(`${path}\\`);
    set({
      folders: result.tree,
      filter: folderGone ? { ...filter, folder: "" } : filter,
    });
    await Promise.all([get().refresh(), get().refreshStats()]);
    return result.removed;
  },

  handleEvent(event) {
    switch (event.type) {
      case "download.updated": {
        // 下载 / VJ 导出写进曲库后，曲目表会由紧随其后的 library.updated 回刷；
        // 文件夹树还要单独重算计数，否则磁盘和表里都已有成品，树上仍少一首。
        if (event.payload.state === "done" && event.payload.track_id != null) {
          void get().refreshFolders();
        }
        return;
      }
      case "scan.progress": {
        set({ scan: event.payload });
        if (event.payload.phase === "done") {
          void get().refresh();
          void get().refreshStats();
          void get().refreshFolders();
        }
        return;
      }
      case "analyze.progress": {
        const payload = event.payload;
        const finished = payload.total > 0 && payload.done >= payload.total;
        if (quietJobs.has(payload.job_id)) {
          // 插队那一首：不碰进度条。结果照样会随 library.updated 刷进列表。
          if (finished) quietJobs.delete(payload.job_id);
          return;
        }
        set({ analyze: claimProgress(get().analyze, payload) });
        if (finished) void get().refreshStats();
        return;
      }
      case "maintenance.progress": {
        const payload = event.payload;
        const others = get().maintenance.filter((item) => item.kind !== payload.kind);
        set({
          maintenance:
            payload.phase === "done" && !payload.error ? others : [...others, payload],
        });
        if (payload.kind === "folder_metadata" && payload.phase === "done") {
          void get().refreshFolders();
          continueDataUpgrade();
        }
        return;
      }
      case "library.updated": {
        // 分析是一条一条回推的，直接 refresh 会打出一串请求；
        // 借 setFilter 同一套防抖把连续事件合并成一次拉取。
        cancelPending();
        filterTimer = setTimeout(() => {
          filterTimer = null;
          void get().refresh();
          void get().refreshStats();
        }, FILTER_DEBOUNCE_MS);
        return;
      }
      default:
        return;
    }
  },
}));

/**
 * 有没有一批分析正在跑。工具栏的进度条和后台补齐的空闲判断共用这一条，
 * 两边各写一遍的话，改了判据就会一边显示"在跑"一边又去排新批次。
 * total === 0 只可能来自扫描顺带起的批（前端没有它的总数），按"在跑"算。
 */
export function selectAnalyzing(state: LibraryStore): boolean {
  const job = state.analyze;
  return job !== null && (job.total === 0 || job.done < job.total);
}

/** 当前选中的曲目。优先取当前页的（最新），页外回落到 selectTrack 暂存的对象。 */
export function selectSelectedTrack(state: LibraryStore): Track | null {
  if (state.selectedId === null) return null;
  const inPage = state.tracks.find((track) => track.id === state.selectedId);
  if (inPage) return inPage;
  return state.selectedTrack?.id === state.selectedId ? state.selectedTrack : null;
}
