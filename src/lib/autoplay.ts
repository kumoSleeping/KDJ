/**
 * 自动续播：一首放完，从和声推荐里挑下一首接上。
 *
 * 为什么记"放过哪些"：推荐是按调性和 BPM 算的，同一首歌的最佳接续
 * 往往互相是对方的第一名（A 推 B、B 又推 A），不记的话两首歌能来回放一整晚。
 *
 * 为什么只记一次开机周期：DJ 的曲库是拿来反复听的，跨天还记着"放过了"
 * 只会让第二天打开软件时推荐池莫名其妙地空掉。放在内存里、关掉即忘，
 * 正好对应用户说的"以一次打开软件为周期"。
 */

import { api } from "./api";
import { useHarmonicScope } from "./harmonicScope";
import { isOutsideFolder } from "./outsideFolder";
import { usePlayMode } from "./playMode";
import { useLibraryStore } from "../stores/libraryStore";
import { useQueueStore } from "../stores/queueStore";
import {
  nextCandidateRoute,
  samePredictionPolicy,
  type PredictionPolicySnapshot,
} from "./nextCandidatePolicy";
import { isStreamTrack, streamNextTrack, streamTrackById } from "./streamTrack";
import type { HarmonicMatch, Track } from "../types";

/** 本次运行放过的曲目。刷新页面即清空——这是有意的，见文件头。 */
const played = new Set<number>();

/** 本次运行已经探过的封面；随机候选反复撞到同一首时不重复请求图片。 */
const coverAvailability = new Map<string, Promise<boolean>>();

async function hasCover(track: Track): Promise<boolean> {
  const key = `${track.id}:${track.modified_at}`;
  let pending = coverAvailability.get(key);
  if (!pending) {
    pending = fetch(api.coverUrl(track.id, track.modified_at))
      .then((response) => {
        void response.body?.cancel();
        return response.ok && (response.headers.get("content-type") ?? "").startsWith("image/");
      })
      .catch(() => false);
    coverAvailability.set(key, pending);
  }
  return pending;
}

/**
 * 播放历史栈，「上一首」按它回退。
 *
 * 为什么不能直接复用上面那个 Set：Set 只记得"放过没"，不记得**顺序**，
 * 而"上一首"要的恰恰是顺序。也不能拿曲库的当前排序当历史——
 * 用户可能是从推荐列表点进来的，那首歌在曲库排序里离得很远。
 *
 * 只记 id 不记整条 Track：曲目对象会被后台分析和 WS 事件换掉，
 * 存快照的话回退时拿到的是过期数据（BPM 还是空的）。
 */
const history: number[] = [];
/** 回退到哪一步了。-1 = 停在最新那首。 */
let cursor = -1;

export function markPlayed(trackId: number): void {
  played.add(trackId);
  // 回退途中又手动点了别的歌 → 从当前位置截断，新的一首接上去。
  // 不截断的话历史会分叉，再按"上一首"回到的是另一条时间线。
  if (cursor >= 0) history.length = cursor + 1;
  // 连着点同一首不该在历史里堆两条
  if (history[history.length - 1] !== trackId) history.push(trackId);
  cursor = -1;
}

/** 有没有可以回退的上一首。按钮的禁用态读它。 */
export function hasPrevious(): boolean {
  const at = cursor < 0 ? history.length - 1 : cursor;
  return at > 0;
}

/**
 * 上一首的 track id。返回 null = 已经在最开头。
 *
 * 只回 id，让调用方去 store 里取最新的 Track——见上面"只记 id"的理由。
 */
export function stepBack(): number | null {
  const at = cursor < 0 ? history.length - 1 : cursor;
  if (at <= 0) return null;
  cursor = at - 1;
  return history[cursor] ?? null;
}

export function hasPlayed(trackId: number): boolean {
  return played.has(trackId);
}

/** 只在测试和"重置续播"这种显式操作里用。 */
export function clearPlayHistory(): void {
  played.clear();
  history.length = 0;
  cursor = -1;
}

/**
 * 按 id 取回一条最新的 Track。
 *
 * 当前页里没有就去后端要——「上一首」回退到的那首很可能已经被翻页翻走了，
 * 只在当前页里找的话，翻两页之后上一首就点不动了。
 */
export async function trackById(id: number): Promise<Track | null> {
  const stream = streamTrackById(id);
  if (stream) return stream;
  const inPage = useLibraryStore.getState().tracks.find((track) => track.id === id);
  if (inPage) return inPage;
  try {
    return await api.track(id);
  } catch {
    // 曲目被删了 / 后端不通：安静放弃，按钮点了没反应好过弹一条错误
    return null;
  }
}

/**
 * 归一化曲名，用来判"是不是同一首歌的另一份"。
 *
 * 曲库里同一首歌常有好几份：`[VDJ] xxx`、`xxx (Remix)`、`xxx_master2`、
 * 一份 mp3 一份 flac。它们调号 BPM 几乎一样，和声推荐必然把它们排在最前面——
 * 结果就是"接下一首"接到了刚放完那首自己。
 *
 * 洗掉的东西和 vjKeywords.buildVjQuery 是同一套思路：方括号前缀、尾部括注、
 * 下划线、大小写、空白。剩下的核心名字一样就当同一首。
 */
function normalizeTitle(raw: string): string {
  return raw
    .replace(/^\s*[[【(（][^\]】)）]*[\]】)）]\s*/g, "")
    .replace(/\s*[([（【][^)\]）】]*[)\]）】]\s*$/g, "")
    .replace(/[_\-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 两条记录是不是同一首歌。
 *
 * 只比归一化后的**曲名**，不比艺人：同一首歌的不同版本里，艺人字段经常
 * 一份写了 remixer、一份是空的，比上去反而漏判。空名字一律当不同——
 * 两首都没名字的时候拿空串相等去判，会把整批未命名文件当成同一首。
 */
function sameSong(a: Track, b: Track): boolean {
  const left = normalizeTitle(a.title || a.filename);
  const right = normalizeTitle(b.title || b.filename);
  return left.length > 0 && left === right;
}

/** 曲目是否落在接歌范围指定的文件夹（含子目录）内。 */
function trackInFolderScope(track: Track, folder: string): boolean {
  const normalized = folder.trim().replace(/\/+$/, "");
  if (!normalized) return true;
  const trackFolder = track.folder?.trim() ?? "";
  if (!trackFolder) return false;
  return trackFolder === normalized || trackFolder.startsWith(`${normalized}/`);
}

/**
 * 右侧唱盘预告的候选还能不能兑现。
 *
 * 范围 / 模式一切，旧预告必须作废——否则 pickNext 会硬切到
 * 新文件夹之外的曲目，原生 handoff 也会因 Deck 没预热而失败。
 */
export interface PreferredCandidateGuard {
  generated: PredictionPolicySnapshot;
  current: PredictionPolicySnapshot;
}

export function preferredStillValid(
  preferred: Track,
  current: Track,
  guard: PreferredCandidateGuard | null = null,
): boolean {
  const { scope } = useHarmonicScope.getState();
  const { mode } = usePlayMode.getState();
  const rawFolder = scope === "folder" ? useLibraryStore.getState().filter.folder : "";
  const folder = isOutsideFolder(rawFolder) ? "" : rawFolder;

  if (guard && !samePredictionPolicy(guard.generated, guard.current)) return false;
  if (preferred.id === current.id) return mode === "one";

  if (scope === "queue") {
    const queued = useQueueStore
      .getState()
      .list()
      .find((candidate) => candidate.id !== current.id);
    return queued?.id === preferred.id;
  }

  if (scope === "folder" && folder && !trackInFolderScope(preferred, folder)) {
    return false;
  }

  return true;
}

/**
 * 挑下一首，按播放条上选的模式来（见 playMode.ts）。
 *
 * 范围（全库 / 当前文件夹）四种模式共用 harmonicScope 那一个开关——
 * **必须是同一个值**：用户把范围收到当前文件夹、结果自动续播还从全库里接，
 * 那是这个开关最难被发现的失效方式。
 *
 * `manual` = 用户自己按了「下一首」。区别只影响单曲循环：循环的是**自动**续播，
 * 人伸手按下一首就是想逃出这首歌，这时按招牌的调性接歌给他挑。
 */
export async function pickNext(
  current: Track,
  manual = false,
  preferred: Track | null = null,
  preferredGuard: PreferredCandidateGuard | null = null,
): Promise<Track | null> {
  const { mode } = usePlayMode.getState();
  const { scope } = useHarmonicScope.getState();
  const rawFolder = scope === "folder" ? useLibraryStore.getState().filter.folder : "";
  // 「其他」不是真实目录：顺序/随机走列表 API 哨兵；和声推荐暂扩到全库。
  const folder = isOutsideFolder(rawFolder) ? "" : rawFolder;
  const listFolder = rawFolder;

  // 点歌队列优先（KTV 语义）：排了歌就先放排的，什么模式都一样——
  // 队列是用户显式排的"接下来放这个"，意图比模式的通用规则强。
  // 播放即消耗：弹出去的那首从队列里划掉。
  const queued = useQueueStore.getState().shift(current.id);
  if (queued) return queued;
  // 范围收在「临时列表」且队列已经放空：安静停下，这正是这一档的意义
  if (scope === "queue") return null;

  const streamSuccessor = isStreamTrack(current) ? streamNextTrack(current) : null;
  const route = nextCandidateRoute(
    isStreamTrack(current),
    Boolean(streamSuccessor),
    mode,
    manual,
  );
  if (route === "repeat-current") return current;
  if (route === "stream-successor") return streamSuccessor;
  // previewNext 已经替右侧唱盘挑好一首时直接兑现预告。队列仍在它前面消费，
  // 所以用户临时插队后，显式点歌永远比旧预告优先。
  if (
    preferred &&
    preferred.id !== current.id &&
    !(mode === "one" && manual) &&
    preferredStillValid(preferred, current, preferredGuard)
  ) {
    return preferred;
  }
  // 在线试听没有曲库分析出来的 BPM / 调号，不能把负 id 交给 harmonic API。
  // 在线链耗尽后回到本地范围起点；本地 harmonic 暂时不可用时则按眼前排序兜底，
  // 不能因为一次推荐请求失败就把已经预热好的第二台 Deck 清成“等待下一首”。
  if (route === "local-start") return firstInOrder(listFolder);
  if (route === "order") return nextInOrder(current, listFolder);
  if (route === "shuffle") return randomPick(current, listFolder);
  return (await harmonicPick(current, folder)) ?? nextInOrder(current, listFolder);
}

/**
 * 只看「下一首会是谁」，不消费点歌队列。
 *
 * 播放条右侧唱盘会提前展示候选，因此不能直接复用 pickNext：pickNext 的队列
 * 语义是 KTV 式“取走队头”，只为画一张封面就调用会让歌还没播便从队列消失。
 * 随机模式在这里会真正抽一次；PlayerBar 会保留这个结果，并在实际续播时把它
 * 作为 preferred 交回 pickNext，保证唱盘上预告的和随后听到的是同一首。
 */
export async function previewNext(
  current: Track,
  manual = false,
  /**
   * 只用于"换一首候选"这类预览动作。它不改变播放历史，也绝不能影响
   * 点歌队列；队列仍然是明确指定的下一首，不能被随机按钮跳过。
   */
  excludeIds: ReadonlySet<number> = new Set(),
): Promise<Track | null> {
  const { mode } = usePlayMode.getState();
  const { scope } = useHarmonicScope.getState();
  const rawFolder = scope === "folder" ? useLibraryStore.getState().filter.folder : "";
  const folder = isOutsideFolder(rawFolder) ? "" : rawFolder;
  const listFolder = rawFolder;

  const queued = useQueueStore
    .getState()
    .list()
    .find((candidate) => candidate.id !== current.id);
  if (queued) return queued;
  if (scope === "queue") return null;

  const streamSuccessor = isStreamTrack(current) ? streamNextTrack(current) : null;
  const route = nextCandidateRoute(
    isStreamTrack(current),
    Boolean(streamSuccessor),
    mode,
    manual,
  );
  if (route === "repeat-current") return current;
  if (route === "stream-successor") return streamSuccessor;
  if (route === "local-start") return firstInOrder(listFolder);
  if (route === "order") return nextInOrder(current, listFolder);
  if (route === "shuffle") return randomPick(current, listFolder, excludeIds);
  return (await harmonicPick(current, folder)) ?? nextInOrder(current, listFolder);
}

/**
 * 调性接歌（默认模式）。
 *
 * 用和曲目详情栏里同一条推荐接口，所以"自动接的那首"和用户自己看到的
 * 推荐列表是同一套排序——不会出现"它给我接了一首列表里根本没有的歌"。
 *
 * 容差比详情栏默认的 12 收得更紧：手动挑歌时人可以自己判断能不能对上，
 * 自动接必须保守，接出一首对不上拍的比不接更糟。
 */
async function harmonicPick(current: Track, folder: string): Promise<Track | null> {
  let matches: HarmonicMatch[];
  try {
    matches = await api.harmonic(current.id, 8, 40, folder);
  } catch {
    // 交给调用方按当前列表顺序兜底；推荐失败不能弹错，也不能让下一台 Deck 为空。
    return null;
  }

  const fresh = matches.find(
    (match) =>
      match.track.id !== current.id &&
      !played.has(match.track.id) &&
      !sameSong(current, match.track),
  );
  // 不在这里回收已经播放的最佳匹配，否则小候选池会稳定 A↔B。调用方会改走
  // 当前排序的下一首，既保持“下一首”不空，也不会破坏本次运行的去重历史。
  return fresh?.track ?? null;
}

/**
 * 顺序播放：列表里当前这首的下一行，到头绕回第一首。
 *
 * 绕回而不是停下：这是个接歌工具，"顺序"要的是可预期的次序，
 * 不是"放完一遍就沉默"——半夜垫场时列表放完直接没声音是事故。
 *
 * 快路径直接读眼前这张列表（范围和当前视图一致时它就是答案，还带着
 * 用户此刻的全部筛选和排序）；人翻去了别的文件夹/搜索页时才去问后端。
 */
/** 在线曲目没有正数 id，顺序模式只能从当前范围的第一首本地曲目接起。 */
async function firstInOrder(folder: string): Promise<Track | null> {
  const { sort, order } = useLibraryStore.getState().filter;
  try {
    const page = await api.tracks({ folder, sort, order, limit: 1, offset: 0 });
    return page.items[0] ?? null;
  } catch {
    return null;
  }
}

async function nextInOrder(current: Track, folder: string): Promise<Track | null> {
  const state = useLibraryStore.getState();
  if (state.filter.folder === folder) {
    const index = state.tracks.findIndex((item) => item.id === current.id);
    if (index !== -1) {
      if (index + 1 < state.tracks.length) return state.tracks[index + 1];
      if (state.tracks.length < state.total) {
        // 正好放到已加载分页的末尾：把下一页拉进来接着放
        await state.loadMore();
        const after = useLibraryStore.getState().tracks;
        return after[index + 1] ?? after[0] ?? null;
      }
      const first = state.tracks[0];
      return first && first.id !== current.id ? first : null;
    }
  }

  // 当前视图对不上范围：按同一套排序去后端翻页找到这首，取它的下一首
  const { sort, order } = state.filter;
  try {
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const page = await api.tracks({ folder, sort, order, limit: pageSize, offset });
      const index = page.items.findIndex((item) => item.id === current.id);
      if (index !== -1) {
        if (index + 1 < page.items.length) return page.items[index + 1];
        if (offset + page.items.length < page.total) {
          const next = await api.tracks({ folder, sort, order, limit: 1, offset: offset + index + 1 });
          return next.items[0] ?? null;
        }
        const first = await api.tracks({ folder, sort, order, limit: 1, offset: 0 });
        return first.items[0] && first.items[0].id !== current.id ? first.items[0] : null;
      }
      // 整个范围都翻完了还没找到（比如正放的这首不属于这个文件夹）：
      // 没有"它的下一首"可言，从范围的第一首开始
      if (offset + pageSize >= page.total) {
        return page.items.find((item) => item.id !== current.id) ?? null;
      }
    }
  } catch {
    return null; // 和 harmonicPick 一个道理：安静停下
  }
}

/**
 * 随机播放：范围内随机挑一首。
 *
 * 不把整个范围拉下来再抽——问一次总数，随机一个 offset 只取一条。
 * 先试几次"没放过的"（不然小曲库里随机会反复撞同几首），并在这些随机
 * 候选中优先拿有封面的。点歌队列不走这里，所以用户明确指定的曲目绝不会
 * 因为没封面被算法擅自替换。全放过了再放宽到"不是当前这首"。
 */
async function randomPick(
  current: Track,
  folder: string,
  excludeIds: ReadonlySet<number> = new Set(),
): Promise<Track | null> {
  try {
    const probe = await api.tracks({ folder, limit: 1, offset: 0 });
    if (probe.total <= 1) return null;
    let fallback: Track | null = null;
    const fresh: Track[] = [];
    const seen = new Set<number>();
    for (let attempt = 0; attempt < 8 && fresh.length < 4; attempt++) {
      const offset = Math.floor(Math.random() * probe.total);
      const candidate = (await api.tracks({ folder, limit: 1, offset })).items[0];
      if (
        !candidate ||
        candidate.id === current.id ||
        excludeIds.has(candidate.id) ||
        seen.has(candidate.id)
      ) continue;
      seen.add(candidate.id);
      if (!played.has(candidate.id) && !sameSong(current, candidate)) fresh.push(candidate);
      fallback = candidate;
    }
    if (!fresh.length) return fallback;
    const withCover = await Promise.all(fresh.map(hasCover));
    return fresh[withCover.findIndex(Boolean)] ?? fresh[0];
  } catch {
    return null;
  }
}
