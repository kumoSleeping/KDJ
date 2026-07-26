/**
 * 曲库列表 + 筛选 + 选中 + 导入/分析进度。
 * 列表数据永远由 refresh() 从后端拉（筛选/排序都在 SQL 里做），前端不做二次过滤。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import type {
  AnalyzeProgress,
  AnalyzeResponseLike,
  FileOp,
  FolderOpResult,
  FolderTree,
  LibraryStats,
  ScanProgress,
  ScanResponseLike,
  Track,
  TrackPatch,
  WsEvent,
} from "../types";

/** "custom" = 文件夹清单里的手排顺序（拖动排序写进 .kumodeck.json）。 */
export type TrackSort =
  | "added_at" | "title" | "artist" | "album" | "bpm" | "camelot" | "energy" | "duration" | "custom";
export type SortOrder = "asc" | "desc";
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
}

export const DEFAULT_FILTER: LibraryFilter = {
  q: "",
  key: "",
  bpmMin: null,
  bpmMax: null,
  energyMin: null,
  analyzed: "all",
  folder: "",
  folderDeep: false,
  sort: "added_at",
  order: "desc",
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
  if (current && current.job_id !== next.job_id && current.done < current.total) return current;
  return next;
}

function toQuery(filter: LibraryFilter, offset: number): Record<string, string | number | undefined> {
  return {
    q: filter.q.trim(),
    key: filter.key,
    bpm_min: filter.bpmMin ?? undefined,
    bpm_max: filter.bpmMax ?? undefined,
    energy_min: filter.energyMin ?? undefined,
    analyzed: filter.analyzed === "all" ? undefined : String(filter.analyzed === "yes"),
    folder: filter.folder,
    folder_deep: filter.folder && filter.folderDeep ? "true" : undefined,
    sort: filter.sort,
    order: filter.order,
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
   * 页外选中的暂存：从「接下一首」点的歌大多不在当前这页 200 行里，
   * 只存 id 的话详情栏会因为在页里找不到而变空。带着整个对象选中就没这个洞。
   */
  selectedTrack: Track | null;
  clipboard: LibraryClipboard | null;
  folders: FolderTree | null;
  stats: LibraryStats | null;
  scan: ScanProgress | null;
  analyze: AnalyzeProgress | null;
  /**
   * 用户刚按过「停止」。自动化的那几条路径（选中即分析、后台补齐）看着它，
   * 否则几秒后空闲探测又排一批上来，那个按钮等于没按。
   * 重新点「分析」才解除。
   */
  autoAnalyzeSuspended: boolean;

  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  refreshStats(): Promise<void>;
  refreshFolders(): Promise<void>;
  setFilter(patch: Partial<LibraryFilter>): void;
  resetFilter(): void;
  select(id: number | null, mode?: SelectMode): void;
  /** 用完整对象选中（推荐列表这类"来源不在当前页"的入口用这个）。 */
  selectTrack(track: Track): void;
  selectAll(): void;
  copyToClipboard(op: FileOp): void;
  paste(dest: string): Promise<FolderOpResult | null>;
  applyFolderOp(ids: number[], dest: string, op: FileOp): Promise<FolderOpResult>;
  /**
   * 「添加文件夹」背后的一整套后台动作：把目录登记成曲库根、遍历入库、
   * （analyze 时）把新曲目排进分析队列。调用方只负责把目录交出去，
   * 不用再引导用户点第二个按钮。
   */
  startScan(paths: string[], analyze?: boolean): Promise<ScanResponseLike>;
  startAnalyze(trackIds: number[] | null, force?: boolean, priority?: boolean): Promise<AnalyzeResponseLike>;
  cancelAnalyze(): Promise<void>;
  setAutoAnalyzeSuspended(value: boolean): void;
  /**
   * 收掉进度条。跑完的那一批会先留在条上（让人看见"完了"），
   * 确认后面没有下一批接着跑之后才由空闲探测收走——
   * 一到 100% 就立刻消失的话，一批接一批跑时整条工具行会一灭一亮，列表跟着跳。
   */
  clearAnalyzeProgress(): void;
  updateTrack(id: number, patch: TrackPatch): Promise<Track>;
  writeTags(id: number): Promise<Track>;
  removeTrack(id: number, deleteFile?: boolean): Promise<void>;
  handleEvent(event: WsEvent): void;
}

export const useLibraryStore = create<LibraryStore>()((set, get) => ({
  tracks: [],
  total: 0,
  loading: false,
  loadingMore: false,
  error: "",
  filter: { ...DEFAULT_FILTER },
  selectedId: null,
  selectedIds: [],
  selectedTrack: null,
  clipboard: null,
  folders: null,
  stats: null,
  scan: null,
  analyze: null,
  autoAnalyzeSuspended: false,

  async refresh() {
    cancelPending();
    const seq = ++requestSeq;
    set({ loading: true });
    try {
      const page = await api.tracks(toQuery(get().filter, 0));
      if (seq !== requestSeq) return;
      // 故意不动 selectedId：分析进度会不停触发 refresh，
      // 一旦顺手清选中，用户看详情时会被反复踢出去。选中项落在页外时
      // selectSelectedTrack 自然返回 null，交给视图处理。
      set({ tracks: page.items, total: page.total, loading: false, error: "" });
    } catch (error) {
      if (seq !== requestSeq) return;
      set({ loading: false, error: errorText(error) });
    }
  },

  async loadMore() {
    const { tracks, total, loadingMore, loading } = get();
    if (loadingMore || loading || tracks.length >= total) return;
    const seq = requestSeq;
    set({ loadingMore: true });
    try {
      const page = await api.tracks(toQuery(get().filter, tracks.length));
      if (seq !== requestSeq) return; // 翻页途中筛选变了，这页作废
      const seen = new Set(get().tracks.map((item) => item.id));
      const merged = [...get().tracks, ...page.items.filter((item) => !seen.has(item.id))];
      set({ tracks: merged, total: page.total, loadingMore: false });
    } catch (error) {
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

  setFilter(patch) {
    cancelPending();
    set({ filter: { ...get().filter, ...patch } });
    filterTimer = setTimeout(() => {
      filterTimer = null;
      void get().refresh();
    }, FILTER_DEBOUNCE_MS);
  },

  resetFilter() {
    cancelPending();
    set({ filter: { ...DEFAULT_FILTER } });
    void get().refresh();
  },

  async refreshFolders() {
    try {
      set({ folders: await api.folders() });
    } catch {
      // 没配曲库目录时后端会给 400；文件夹面板自己会显示空态，不用弹错
    }
  },

  select(id, mode = "replace") {
    // 按 id 选中都发生在当前页里，页外暂存到这里就过期了
    set({ selectedTrack: null });
    if (id === null) {
      set({ selectedId: null, selectedIds: [] });
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

  copyToClipboard(op) {
    const ids = get().selectedIds;
    if (ids.length > 0) set({ clipboard: { ids: [...ids], op } });
  },

  async paste(dest) {
    const clip = get().clipboard;
    if (!clip || !dest) return null;
    const result = await get().applyFolderOp(clip.ids, dest, clip.op);
    // 剪切粘贴一次就用掉，复制的留着可以连粘几个文件夹
    if (clip.op === "move") set({ clipboard: null });
    return result;
  },

  async applyFolderOp(ids, dest, op) {
    const result = await api.applyFolderOp(ids, dest, op);
    await get().refresh();
    void get().refreshFolders();
    void get().refreshStats();
    // 移动后选中项还在（id 没变），链接出来的是新 id，选中它们更符合预期
    if (op === "link" && result.track_ids.length > 0) {
      set({ selectedIds: result.track_ids, selectedId: result.track_ids[0] });
    }
    return result;
  },

  async startScan(paths, analyze = false) {
    const response = await api.scan(paths, analyze);
    set({ scan: { job_id: response.job_id, done: 0, total: response.found, current: "", phase: "walk" } });
    return response;
  },

  async startAnalyze(trackIds, force = false, priority = false) {
    const response = await api.analyze(trackIds, force, priority);
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
    const job = get().analyze;
    // 顺手摁灭自动补齐：不然停下来几秒后空闲探测又排一批，按钮等于没按
    set({ autoAnalyzeSuspended: true });
    await api.cancelAnalyze(job?.job_id ?? "");
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

  async removeTrack(id, deleteFile = false) {
    await api.deleteTrack(id, deleteFile);
    set({
      tracks: get().tracks.filter((item) => item.id !== id),
      total: Math.max(0, get().total - 1),
      selectedId: get().selectedId === id ? null : get().selectedId,
      selectedIds: get().selectedIds.filter((item) => item !== id),
      selectedTrack: get().selectedTrack?.id === id ? null : get().selectedTrack,
    });
    void get().refreshStats();
    void get().refreshFolders();
  },

  handleEvent(event) {
    switch (event.type) {
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
