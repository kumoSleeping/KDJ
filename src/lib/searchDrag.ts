/**
 * 搜索结果（音/视频）拖进队列或文件夹。
 *
 * 和 trackDrag 同一套坑：WKWebView 在 dragover 时常只肯报 text/plain，
 * 自定义 application/x-* 读不出来。所以 MIME + text/plain + 进程内登记三路并用。
 */

import { api } from "./api";
import {
  SEARCH_DEFAULT_DOWNLOAD_SENTINEL,
  searchDropElementAt,
  searchDropPathAt,
  searchQueueDropElementAt,
} from "./folderDrop";
import { withDownloadDisplay } from "./downloadDisplay";
import { rememberVideoEnqueue } from "./queueTaskDraft";
import { useAppStore } from "../stores/appStore";
import { useDownloadStore } from "../stores/downloadStore";
import { useLibraryStore } from "../stores/libraryStore";
import type { OneLibraryTarget, SongSource, VideoDownloadRequest } from "../types";

export { isSparseDownloadTitle, withDownloadDisplay } from "./downloadDisplay";

export const SEARCH_DOWNLOAD_DND_TYPE = "application/x-kdj-download-sources";
export const VIDEO_DOWNLOAD_DND_TYPE = "application/x-kdj-video-download";
export const SEARCH_DRAG_STATE_EVENT = "kd:search-drag-state";
const SEARCH_DRAG_END_GRACE_MS = 1800;

const SEARCH_TEXT_PREFIX = "kdj-download-sources:";
const VIDEO_TEXT_PREFIX = "kdj-video-download:";

/** 拖视频时顺带带上的展示信息（不下发给下载 API）。 */
export interface VideoDragDisplay {
  title?: string;
  artist?: string;
  cover?: string;
}

type VideoDragWire = {
  request: VideoDownloadRequest;
} & VideoDragDisplay;

export type ActiveSearchDrag =
  | { kind: "audio"; sources: SongSource[] }
  | ({ kind: "video"; request: VideoDownloadRequest } & VideoDragDisplay);

let active: ActiveSearchDrag | null = null;
let dragEpoch = 0;
/** dragend 坐标兜底与迟到的原生 drop 之间的一次性闩锁。 */
let dropClaimed = false;

function emitSearchDragState(isActive: boolean): void {
  window.dispatchEvent(
    new CustomEvent(SEARCH_DRAG_STATE_EVENT, { detail: { active: isActive } }),
  );
}

function announceSearchDrag(payload: ActiveSearchDrag | null): void {
  active = payload;
  if (payload) dropClaimed = false;
  emitSearchDragState(Boolean(payload));
}

export function activeSearchDrag(): ActiveSearchDrag | null {
  return active;
}

export function endSearchDrag(): void {
  // Chromium 是 drop → dragend，但 WKWebView 偶尔会先把 React 的 dragend
  // 回调送到 JS。立刻清空会让随后到达的文件夹 drop 既读不到自定义 MIME，
  // 也失去进程内兜底。实际 Tauri 里 dragend 与左栏 drop 有时会隔开不止一个
  // event loop（跨越横向滚动表格时最明显），所以保留一个短暂宽限期。
  // 若期间开始了新拖拽则不清它。
  const endingEpoch = dragEpoch;
  // 进程内载荷继续等迟到的 drop，但红色接收框在松手这一刻就应消失。
  emitSearchDragState(false);
  window.setTimeout(() => {
    if (dragEpoch === endingEpoch) active = null;
  }, SEARCH_DRAG_END_GRACE_MS);
}

/** drop 已经读取完载荷时立即收尾；与 dragend 的容错延迟分开。 */
export function finishSearchDrop(): void {
  dragEpoch += 1;
  announceSearchDrag(null);
}

/** dragend 坐标兜底专用；认领后，迟到的原生 drop 会读到 null。 */
export function claimActiveSearchDrag(): ActiveSearchDrag | null {
  if (dropClaimed || !active) return null;
  dropClaimed = true;
  const payload = active;
  finishSearchDrop();
  return payload;
}

/** dragover：是不是搜到的歌/视频在拖（兼容 WebKit 藏自定义 MIME）。 */
export function isSearchDownloadDrag(event: { dataTransfer: DataTransfer | null }): boolean {
  if (active) return true;
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
  return types.some((type) => {
    const lower = type.toLowerCase();
    return lower === SEARCH_DOWNLOAD_DND_TYPE || lower === VIDEO_DOWNLOAD_DND_TYPE;
  });
}

export function writeSearchSourcesDrag(dataTransfer: DataTransfer, sources: SongSource[]): void {
  const payload = JSON.stringify(sources);
  // 先登记进程内兜底、再写 WebKit 接受度最高的 text/plain。部分 WKWebView
  // 会拒绝自定义 MIME；它只能是增强项，不能让整次 dragstart 在这里抛断。
  dragEpoch += 1;
  announceSearchDrag({ kind: "audio", sources });
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData("text/plain", `${SEARCH_TEXT_PREFIX}${payload}`);
  try {
    dataTransfer.setData(SEARCH_DOWNLOAD_DND_TYPE, payload);
  } catch {
    // text/plain + active 足以走完整条拖放链路。
  }
}

export function writeVideoDownloadDrag(
  dataTransfer: DataTransfer,
  request: VideoDownloadRequest,
  display: VideoDragDisplay = {},
): void {
  const wire: VideoDragWire = {
    request,
    title: display.title?.trim() || undefined,
    artist: display.artist?.trim() || undefined,
    cover: display.cover?.trim() || undefined,
  };
  const payload = JSON.stringify(wire);
  dragEpoch += 1;
  announceSearchDrag({ kind: "video", request, ...display });
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData("text/plain", `${VIDEO_TEXT_PREFIX}${payload}`);
  try {
    dataTransfer.setData(VIDEO_DOWNLOAD_DND_TYPE, payload);
  } catch {
    // text/plain + active 足以走完整条拖放链路。
  }
}

/**
 * WKWebView 对普通 div 的 HTML5 draggable 支持不可靠，视频行改走指针拖动。
 * 超过 5px 才启动，松手时直接按坐标命中文件夹/队列，不依赖原生 drop。
 */
export function beginVideoPointerDrag(
  down: PointerEvent,
  request: VideoDownloadRequest,
  display: VideoDragDisplay,
  onError: (error: unknown) => void,
  onActivated?: () => void,
): () => void {
  if (down.pointerType !== "mouse" || down.button !== 0) return () => undefined;
  const target = down.target as HTMLElement | null;
  if (target?.closest("button, input, select, textarea, a, label")) return () => undefined;

  const { pointerId, clientX: startX, clientY: startY } = down;
  let dragging = false;
  let ghost: HTMLDivElement | null = null;
  const payload: Extract<ActiveSearchDrag, { kind: "video" }> = {
    kind: "video",
    request,
    title: display.title,
    artist: display.artist,
    cover: display.cover,
  };
  const clearTargets = () => {
    document
      .querySelectorAll<HTMLElement>("[data-kd-pointer-search-over]")
      .forEach((node) => node.removeAttribute("data-kd-pointer-search-over"));
  };
  const paintTarget = (x: number, y: number) => {
    clearTargets();
    const queue = searchQueueDropElementAt(x, y);
    if (queue) {
      queue.setAttribute("data-kd-pointer-search-over", "queue");
      return;
    }
    searchDropElementAt(x, y)?.setAttribute("data-kd-pointer-search-over", "folder");
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    clearTargets();
    ghost?.remove();
    ghost = null;
    delete document.body.dataset.kdSearchPointerDragging;
  };
  const activate = (x: number, y: number) => {
    dragging = true;
    onActivated?.();
    window.getSelection()?.removeAllRanges();
    dragEpoch += 1;
    announceSearchDrag(payload);
    document.body.dataset.kdSearchPointerDragging = "true";
    ghost = document.createElement("div");
    ghost.className = "kd-track-pointer-ghost";
    ghost.textContent = display.title?.trim() || request.bvid || "下载视频";
    document.body.appendChild(ghost);
    ghost.style.transform = `translate3d(${x + 12}px, ${y + 12}px, 0)`;
    paintTarget(x, y);
  };
  const onMove = (move: PointerEvent) => {
    if (move.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(move.clientX - startX, move.clientY - startY) < 5) return;
    move.preventDefault();
    if (!dragging) activate(move.clientX, move.clientY);
    ghost?.style.setProperty("transform", `translate3d(${move.clientX + 12}px, ${move.clientY + 12}px, 0)`);
    paintTarget(move.clientX, move.clientY);
  };
  const onUp = (up: PointerEvent) => {
    if (up.pointerId !== pointerId) return;
    const queue = searchQueueDropElementAt(up.clientX, up.clientY);
    const dest = searchDropPathAt(up.clientX, up.clientY);
    cleanup();
    if (!dragging) return;
    up.preventDefault();
    finishSearchDrop();
    const action = queue
      ? enqueueSearchQueuePayload(payload)
      : dest
        ? enqueueSearchPayload(payload, dest)
        : Promise.resolve();
    void action.catch(onError);
  };
  const onCancel = (cancel: PointerEvent) => {
    if (cancel.pointerId !== pointerId) return;
    cleanup();
    if (dragging) finishSearchDrop();
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  return cleanup;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 旧拖放只塞了 VideoDownloadRequest；新的外面包一层 request + 展示字段。 */
function parseVideoWire(raw: string): Extract<ActiveSearchDrag, { kind: "video" }> | null {
  const parsed = parseJson<VideoDragWire | VideoDownloadRequest>(raw);
  if (!parsed || typeof parsed !== "object") return null;
  if ("request" in parsed && parsed.request && typeof parsed.request === "object") {
    return {
      kind: "video",
      request: parsed.request,
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      artist: typeof parsed.artist === "string" ? parsed.artist : undefined,
      cover: typeof parsed.cover === "string" ? parsed.cover : undefined,
    };
  }
  // 兼容：整包就是下载请求
  if ("bvid" in parsed || "url" in parsed) {
    return { kind: "video", request: parsed as VideoDownloadRequest };
  }
  return null;
}

/** drop 时读出要入队的音源或视频请求。 */
export function readSearchDrop(dataTransfer: DataTransfer): ActiveSearchDrag | null {
  if (dropClaimed) return null;
  const videoRaw = dataTransfer.getData(VIDEO_DOWNLOAD_DND_TYPE);
  if (videoRaw) {
    const video = parseVideoWire(videoRaw);
    if (video) return video;
  }
  const plain = dataTransfer.getData("text/plain");
  if (plain.startsWith(VIDEO_TEXT_PREFIX)) {
    const video = parseVideoWire(plain.slice(VIDEO_TEXT_PREFIX.length));
    if (video) return video;
  }

  const audioRaw = dataTransfer.getData(SEARCH_DOWNLOAD_DND_TYPE);
  if (audioRaw) {
    const sources = parseJson<SongSource[]>(audioRaw);
    if (Array.isArray(sources)) return { kind: "audio", sources };
  }
  if (plain.startsWith(SEARCH_TEXT_PREFIX)) {
    const sources = parseJson<SongSource[]>(plain.slice(SEARCH_TEXT_PREFIX.length));
    if (Array.isArray(sources)) return { kind: "audio", sources };
  }

  return active;
}

/** 「全部曲目」哨兵 → settings.download_dir；其它路径原样返回。 */
export function resolveSearchDestDir(destDir: string): string {
  const dest = destDir.trim();
  if (!dest) throw new Error("先打开一个文件夹，再拖进来");
  if (dest === SEARCH_DEFAULT_DOWNLOAD_SENTINEL) {
    const dir = useAppStore.getState().settings?.download_dir?.trim() || "";
    if (!dir) throw new Error("还没有设置默认下载文件夹");
    return dir;
  }
  return dest;
}

/**
 * 搜到的音/视频拖进某个曲库文件夹：入队、右栏切队列、左表出现待下载行。
 * 侧边栏文件夹和中间左半「当前打开的文件夹」共用。
 * destDir 也可以是「全部曲目」哨兵，会落到默认下载文件夹。
 */
export async function enqueueSearchDrop(
  event: { dataTransfer: DataTransfer },
  destDir: string,
): Promise<void> {
  const dest = resolveSearchDestDir(destDir);

  const payload = readSearchDrop(event.dataTransfer);
  const alreadyClaimed = dropClaimed;
  finishSearchDrop();
  if (!payload) {
    // dragend 坐标兜底已经消费成功；这是 WKWebView 随后补送的旧 drop，不报假错。
    if (alreadyClaimed) return;
    throw new Error("拖动的数据读不出来，请再拖一次");
  }

  await enqueueSearchPayload(payload, dest);
}

/** 搜索载荷直接加入普通下载队列（不指定目标文件夹）。 */
export async function enqueueSearchQueuePayload(payload: ActiveSearchDrag): Promise<void> {
  const downloads = useDownloadStore.getState();
  if (payload.kind === "video") {
    const task = await api.videoDownload({
      ...payload.request,
      title: payload.title,
      artist: payload.artist,
      cover: payload.cover,
    });
    rememberVideoEnqueue(task.id, {
      ...payload.request,
      title: payload.title,
      artist: payload.artist,
      cover: payload.cover,
    });
    downloads.mergeTasks([
      withDownloadDisplay(task, {
        title: payload.title,
        artist: payload.artist,
        cover: payload.cover,
      }),
    ]);
    return;
  }
  if (payload.sources.length === 0) throw new Error("没有可下载的在线来源");
  const quality = useAppStore.getState().settings?.default_quality ?? null;
  await downloads.enqueue(payload.sources, { quality });
}

/** 在线歌曲直接下载到当前设备 OneLibrary 列表；成品先进入本地曲库，再由持久化补写器复制到设备。 */
export async function enqueueSearchOneLibraryPayload(
  payload: ActiveSearchDrag,
  target: OneLibraryTarget,
): Promise<void> {
  if (payload.kind !== "audio" || payload.sources.length === 0) {
    throw new Error("OneLibrary 列表当前只接受在线歌曲下载");
  }
  useAppStore.getState().openQueuePanel();
  const quality = useAppStore.getState().settings?.default_quality ?? null;
  await useDownloadStore.getState().enqueue(payload.sources, {
    quality,
    one_library_target: target,
  });
}

/** 原生 drop 路径：读出拖动载荷后转入与 dragend 坐标兜底相同的入队函数。 */
export async function enqueueSearchOneLibraryDrop(
  event: { dataTransfer: DataTransfer },
  target: OneLibraryTarget,
): Promise<void> {
  const payload = readSearchDrop(event.dataTransfer);
  const alreadyClaimed = dropClaimed;
  finishSearchDrop();
  if (!payload) {
    if (alreadyClaimed) return;
    throw new Error("拖动的数据读不出来，请再拖一次");
  }
  await enqueueSearchOneLibraryPayload(payload, target);
}

/** 已经由 dragend 兜底认领的搜索载荷，直接送进指定文件夹。 */
export async function enqueueSearchPayload(
  payload: ActiveSearchDrag,
  destDir: string,
): Promise<void> {
  const dest = resolveSearchDestDir(destDir);
  if (payload.kind === "audio" && payload.sources.length === 0) {
    throw new Error("没有可下载的在线来源");
  }

  // 搜索结果拖进文件夹只会创建本地下载任务，不写入任何流媒体曲库记录。
  // 先切 UI：左表对准这个文件夹，右栏打开下载队列。入队请求可以稍后再回来。
  const lib = useLibraryStore.getState();
  lib.setFilter({ folder: dest, sort: "custom" });
  useAppStore.getState().openQueuePanel();

  const downloads = useDownloadStore.getState();
  if (payload.kind === "video") {
    const title =
      payload.title?.trim() ||
      payload.request.bvid?.trim() ||
      payload.request.url?.trim() ||
      "视频";
    const artist = payload.artist?.trim() || "";
    const cover = payload.cover?.trim() || "";
    const optimisticId = `local:${crypto.randomUUID()}`;
    downloads.mergeTasks([
      {
        id: optimisticId,
        kind: "video",
        platform: "bilibili",
        title,
        artist,
        quality: payload.request.audio_only ? "audio" : `${payload.request.max_height ?? 1080}p`,
        state: "queued",
        progress: 0,
        downloaded_bytes: 0,
        total_bytes: 0,
        speed_bps: 0,
        path: "",
        error: "",
        track_id: null,
        dest_dir: dest,
        cover: cover || undefined,
        created_at: Date.now() / 1000,
        updated_at: Date.now() / 1000,
      },
    ]);
    try {
      const request = {
        ...payload.request,
        dest_dir: dest,
        title,
        artist,
        cover: cover || undefined,
      };
      const task = await api.videoDownload(request);
      rememberVideoEnqueue(task.id, request);
      downloads.removeLocal(optimisticId);
      downloads.mergeTasks([
        withDownloadDisplay(task, { title, artist, cover, dest_dir: dest }),
      ]);
    } catch (error) {
      downloads.removeLocal(optimisticId);
      throw error;
    }
    return;
  }

  const quality = useAppStore.getState().settings?.default_quality ?? null;
  const now = Date.now() / 1000;
  const optimistic = payload.sources.map((source, index) => ({
    id: `local:${crypto.randomUUID()}:${index}`,
    kind: "audio" as const,
    platform: source.platform,
    title: source.title || "未命名",
    artist: source.artists?.filter(Boolean).join(", ") || "",
    quality: String(quality ?? ""),
    state: "queued" as const,
    progress: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    speed_bps: 0,
    path: "",
    error: "",
    track_id: null,
    dest_dir: dest,
    cover: source.cover?.trim() || undefined,
    created_at: now,
    updated_at: now,
  }));
  downloads.mergeTasks(optimistic);
  try {
    const tasks = await downloads.enqueue(payload.sources, { quality, dest_dir: dest });
    for (const task of optimistic) downloads.removeLocal(task.id);
    // 服务端任务不带封面；按入队顺序把搜索结果封面盖回去。
    downloads.mergeTasks(
      tasks.map((task, index) =>
        withDownloadDisplay(task, {
          title: payload.sources[index]?.title,
          artist: payload.sources[index]?.artists?.filter(Boolean).join(", "),
          cover: payload.sources[index]?.cover,
          dest_dir: dest,
        }),
      ),
    );
  } catch (error) {
    for (const task of optimistic) downloads.removeLocal(task.id);
    throw error;
  }
}
