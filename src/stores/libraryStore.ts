/**
 * 曲库列表 + 筛选 + 选中 + 导入/分析进度。
 * 列表数据永远由 refresh() 从后端拉（筛选/排序都在 SQL 里做），前端不做二次过滤。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import { useQueueStore } from "./queueStore";
import type {
  AnalyzeProgress,
  AnalyzeResponseLike,
  FileDisposalMode,
  FileOp,
  FolderOpResult,
  FolderTree,
  LibraryStats,
  ScanProgress,
  ScanResponseLike,
  Track,
  TrackPatch,
  TrackPatchResult,
  WsEvent,
} from "../types";

/** "custom" = 文件夹清单里的手排顺序（拖动排序写进 .kdj.json）。 */
export type TrackSort =
  | "added_at" | "title" | "artist" | "album" | "bpm" | "camelot" | "energy" | "duration" | "custom";
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
  /**
   * 中列正显示「临时列表」（点歌队列，见 queueStore）而不是曲库查询结果。
   * 走同一个 tracks 字段而不是另开一条渲染路：选中、范围多选、详情联动
   * 全都吃 store.tracks，另开一条的话这些行为要重写一遍。
   */
  queueView: boolean;

  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  refreshStats(): Promise<void>;
  refreshFolders(): Promise<void>;
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
  /** 切换「临时列表」视图。开 = 中列显示点歌队列；点任何文件夹自动退出。 */
  setQueueView(on: boolean): void;
  removeTrack(id: number, deleteFile?: boolean): Promise<void>;
  /**
   * 批量删除（多选右键菜单走这条）。一次请求删整批：逐条打 N 个请求
   * 会推 N 条 WS 事件、触发 N 轮防抖刷新。
   * 返回后端的失败清单（track id → 原因）；没删成的那些行会留在列表里。
   */
  removeTracks(ids: number[], file: FileDisposalMode): Promise<Record<string, string>>;
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
  queueView: false,

  async refresh() {
    cancelPending();
    const seq = ++requestSeq;
    // 临时列表视图：tracks 就是队列的快照，按队列顺序，不打后端。
    // 队列一变（入队/播放消耗）由文件底部的订阅再拉着 refresh 跑一遍。
    if (get().queueView) {
      const items = useQueueStore.getState().list();
      const visible = new Set(items.map((item) => item.id));
      const selectedIds = get().selectedIds.filter((id) => visible.has(id));
      const selectedId = get().selectedId;
      const nextSelectedId = selectedId !== null && visible.has(selectedId)
        ? selectedId
        : (selectedIds[selectedIds.length - 1] ?? null);
      set({
        tracks: items,
        total: items.length,
        loading: false,
        error: "",
        selectedIds,
        selectedId: nextSelectedId,
        selectedTrack: nextSelectedId === null ? null : get().selectedTrack,
      });
      return;
    }
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

  setQueueView(on) {
    if (get().queueView === on) return;
    // 切视图时旧选区必须失效：否则空队列里按 Delete / Cmd+C，操作的会是
    // 刚才曲库页里那批已经看不见的曲目。
    set({
      queueView: on,
      selectedId: null,
      selectedIds: [],
      selectedTrack: null,
    });
    void get().refresh();
  },

  async loadMore() {
    const { tracks, total, loadingMore, loading, queueView } = get();
    if (queueView) return; // 队列一次全在页里，没有"更多"
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

  cycleSort(column) {
    const { sort, order, sort2, order2 } = get().filter;
    // `added_at` 是"没有显式排序"的意思（入库序），不算用户选的主键——
    // 不这么判的话，第一次点 BPM 会变成副键而不是主键，和用户的心智反着来
    const hasPrimary = sort !== DEFAULT_SORT;

    if (column === sort) {
      // 主键：asc → desc → 取消。一列只有两个有意义的方向，
      // 第三次点回原状正好就是"我不要按它排了"
      if (order === "asc") {
        get().setFilter({ order: "desc" });
      } else if (sort2) {
        // 取消主键时副键顶上来，而不是连它一起清掉
        get().setFilter({ sort: sort2, order: order2, sort2: null, order2: "asc" });
      } else {
        get().setFilter({ sort: DEFAULT_SORT, order: "desc", sort2: null });
      }
      return;
    }
    if (column === sort2) {
      // 副键：升为主键，原主键降为副键，各自的方向跟着走
      get().setFilter({ sort: sort2, order: order2, sort2: sort, order2: order });
      return;
    }
    // 没参与排序的列：已经有主键就当副键，否则自己当主键
    get().setFilter(
      hasPrimary ? { sort2: column, order2: "asc" } : { sort: column, order: "asc" },
    );
  },

  setFilter(patch) {
    cancelPending();
    // 动了筛选/排序/搜索 = 想看曲库查询结果了，临时列表视图自动让位
    const leavingQueue = get().queueView;
    set({
      filter: { ...get().filter, ...patch },
      queueView: false,
      ...(leavingQueue
        ? { selectedId: null, selectedIds: [], selectedTrack: null }
        : {}),
    });
    filterTimer = setTimeout(() => {
      filterTimer = null;
      void get().refresh();
    }, FILTER_DEBOUNCE_MS);
  },

  resetFilter() {
    cancelPending();
    const leavingQueue = get().queueView;
    set({
      filter: { ...DEFAULT_FILTER },
      queueView: false,
      ...(leavingQueue
        ? { selectedId: null, selectedIds: [], selectedTrack: null }
        : {}),
    });
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
    // 失败的留在列表里：它们的库记录还在（后端删文件失败时连记录一起保留）
    const failed = new Set(Object.keys(result.errors).map(Number));
    const gone = new Set(ids.filter((id) => !failed.has(id)));
    if (gone.size > 0) {
      set({
        tracks: get().tracks.filter((item) => !gone.has(item.id)),
        total: Math.max(0, get().total - gone.size),
        selectedId: gone.has(get().selectedId ?? -1) ? null : get().selectedId,
        selectedIds: get().selectedIds.filter((item) => !gone.has(item)),
        selectedTrack: gone.has(get().selectedTrack?.id ?? -1) ? null : get().selectedTrack,
      });
      void get().refreshStats();
      void get().refreshFolders();
    }
    return result.errors;
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

// 队列一动（入队/插队/播放消耗/清空），临时列表视图跟着重渲染。
// 订阅放在这儿而不是 queueStore 里：依赖只许 libraryStore → queueStore 单向走。
useQueueStore.subscribe(() => {
  const state = useLibraryStore.getState();
  if (state.queueView) void state.refresh();
});

/** 当前选中的曲目。优先取当前页的（最新），页外回落到 selectTrack 暂存的对象。 */
export function selectSelectedTrack(state: LibraryStore): Track | null {
  if (state.selectedId === null) return null;
  const inPage = state.tracks.find((track) => track.id === state.selectedId);
  if (inPage) return inPage;
  return state.selectedTrack?.id === state.selectedId ? state.selectedTrack : null;
}
