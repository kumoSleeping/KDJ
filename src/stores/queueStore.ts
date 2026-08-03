/**
 * 临时列表：KTV 式的点歌队列。
 *
 * 它是"接下来想放什么"的便签，不是歌单文件——只存曲目引用（id + 快照），
 * 不碰磁盘上的任何文件。播放会**消耗**它：排在队头的歌被自动续播/下一首
 * 挑走时就从队列里划掉，和 KTV 已点列表一个脾气。
 *
 * 快照随 id 一起存（localStorage）：重启后列表立刻能渲染，不用先打一轮
 * 请求；代价是 BPM 这类分析字段可能过期，所以 library.updated 事件会
 * 把最新的 Track 回填进来（见 libraryStore.handleEvent 的转发）。
 */

import { create } from "zustand";
import type { Track, WsEvent } from "../types";

const STORAGE_KEY = "kd-queue";

interface QueueStore {
  /** 队列顺序。队头 = 下一首要放的。 */
  ids: number[];
  /** id → 快照。渲染和 pickNext 都读它。 */
  byId: Record<number, Track>;

  /** 入队。front=true 插到队头（「下一首播放」的插队语义）。重复入队 = 挪位置。 */
  add(tracks: Track[], front?: boolean): void;
  /** 只替换下一首；保留它之后已经排好的曲目。 */
  replaceNext(track: Track, exceptId?: number): void;
  remove(ids: number[]): void;
  clear(): void;
  /** 弹出队头（跳过 exceptId，通常是正在放的这首）。播放消耗走这里。 */
  shift(exceptId?: number): Track | null;
  /** 按队列顺序取快照。缺快照的 id（理论上不存在）跳过。 */
  list(): Track[];
  handleEvent(event: WsEvent): void;
}

function load(): { ids: number[]; byId: Record<number, Track> } {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const { ids, byId } = raw as { ids?: unknown; byId?: unknown };
      if (Array.isArray(ids) && byId && typeof byId === "object") {
        // 在线试听 id 只在当前 WebView 内有效：直链和 SongSource 都不在
        // Track 快照里，重启后保留负 id 会把无效 URL 喂给原生播放器。
        const cleanIds = ids.filter((id): id is number => typeof id === "number" && id > 0);
        const cleanById: Record<number, Track> = {};
        for (const id of cleanIds) {
          const track = (byId as Record<number, Track>)[id];
          if (track) cleanById[id] = track;
        }
        return { ids: cleanIds, byId: cleanById };
      }
    }
  } catch {
    /* 存档坏了从空队列开始 */
  }
  return { ids: [], byId: {} };
}

function save(ids: number[], byId: Record<number, Track>): void {
  // 在线试听 id / 直链只在本次 WebView 存活；队列持久化只保留本地曲目，
  // 避免重启后把负 id 当成本地音频 URL 播放。
  const persistedIds = ids.filter((id) => id > 0);
  // 只留队列里还有的快照，别让退队的曲目在 localStorage 里越攒越多
  const kept: Record<number, Track> = {};
  for (const id of persistedIds) if (byId[id]) kept[id] = byId[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ids: persistedIds, byId: kept }));
}

export const useQueueStore = create<QueueStore>((set, get) => ({
  ...load(),

  add(tracks, front = false) {
    const { ids, byId } = get();
    const adding = tracks.map((track) => track.id);
    // 已在队里的先拿出来再放回去：重复"加入"的意图是挪位置，不是排两次
    const rest = ids.filter((id) => !adding.includes(id));
    const nextIds = front ? [...adding, ...rest] : [...rest, ...adding];
    const nextById = { ...byId };
    for (const track of tracks) nextById[track.id] = track;
    set({ ids: nextIds, byId: nextById });
    save(nextIds, nextById);
  },

  replaceNext(track, exceptId) {
    const { ids, byId } = get();
    // “下一首”是第一个不是当前曲目的队列项；当前曲若意外仍在队列里要原位保留。
    const oldNextIndex = ids.findIndex((id) => id !== exceptId);
    const oldNextId = oldNextIndex >= 0 ? ids[oldNextIndex] : null;
    const withoutNew = ids.filter((id) => id !== track.id);
    const insertionIndex =
      oldNextId === null
        ? withoutNew.length
        : Math.max(0, withoutNew.indexOf(oldNextId));
    const rest = oldNextId === null
      ? withoutNew
      : withoutNew.filter((id) => id !== oldNextId);
    const nextIds = [...rest.slice(0, insertionIndex), track.id, ...rest.slice(insertionIndex)];
    const nextById = { ...byId, [track.id]: track };
    set({ ids: nextIds, byId: nextById });
    save(nextIds, nextById);
  },

  remove(removeIds) {
    const gone = new Set(removeIds);
    const { ids, byId } = get();
    const nextIds = ids.filter((id) => !gone.has(id));
    set({ ids: nextIds });
    save(nextIds, byId);
  },

  clear() {
    set({ ids: [], byId: {} });
    save([], {});
  },

  shift(exceptId) {
    const { ids, byId } = get();
    for (const id of ids) {
      if (id === exceptId) continue;
      const track = byId[id];
      // 快照丢了（不该发生）就当它不在队里，继续往后找
      const nextIds = ids.filter((item) => item !== id);
      set({ ids: nextIds });
      save(nextIds, byId);
      if (track) return track;
    }
    return null;
  },

  list() {
    const { ids, byId } = get();
    return ids.map((id) => byId[id]).filter((track): track is Track => Boolean(track));
  },

  handleEvent(event) {
    // 分析结果出来了 / 标签改了：把队列里的旧快照换成新的。
    // 删除也走 library.updated，但删掉的 id 拉不到新数据，这里不动它——
    // 队列里留一条放不出来的歌，播放消耗时自然会跳过去。
    if (event.type !== "library.updated") return;
    void (async () => {
      const { ids } = get();
      const hit = event.payload.track_ids.filter((id) => ids.includes(id));
      if (hit.length === 0) return;
      const { api } = await import("../lib/api");
      const fresh = await Promise.allSettled(hit.map((id) => api.track(id)));
      const nextById = { ...get().byId };
      let changed = false;
      for (const result of fresh) {
        if (result.status === "fulfilled") {
          nextById[result.value.id] = result.value;
          changed = true;
        }
      }
      if (changed) {
        set({ byId: nextById });
        save(get().ids, nextById);
      }
    })();
  },
}));
