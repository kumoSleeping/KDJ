/** 左侧真实文件夹的稳定 DOM 标记；不要拿 title 当数据接口。 */
export const FOLDER_DROP_PATH_ATTR = "data-kd-folder-drop-path";
/** OneLibrary playlist 落点；值是协议数据库里的 playlist id。 */
export const PLAYLIST_DROP_ID_ATTR = "data-kd-playlist-drop-id";
/** 与 playlist id 配对的挂载根目录。 */
export const PLAYLIST_DROP_DEVICE_ATTR = "data-kd-playlist-drop-device";
/** 当前曲目表也能接搜索结果；值就是这张表正在看的目标文件夹。 */
export const SEARCH_DROP_PATH_ATTR = "data-kd-search-drop-path";
/** 「全部曲目」落点：只接搜索下载，落到默认下载文件夹。 */
export const SEARCH_DEFAULT_DOWNLOAD_DROP_ATTR = "data-kd-search-default-download-drop";
/** searchDropPathAt 在命中「全部曲目」时返回的哨兵；入队前再解析成 settings.download_dir。 */
export const SEARCH_DEFAULT_DOWNLOAD_SENTINEL = "__kd_default_download__";
/** 下载队列的稳定落点标记，供 WKWebView 丢失原生 drop 时由 dragend 坐标兜底。 */
export const SEARCH_QUEUE_DROP_ATTR = "data-kd-search-queue-drop";

/**
 * 原生 drop 在 WKWebView 里偶尔不送达，但 dragend 仍带着松手坐标。
 * 用坐标重新命中文件夹，让 dragend 能作为最后一道可靠兜底。
 */
export function folderDropElementAt(clientX: number, clientY: number): HTMLElement | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  return document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>(`[${FOLDER_DROP_PATH_ATTR}]`) ?? null;
}

export function folderDropPathAt(clientX: number, clientY: number): string {
  return folderDropElementAt(clientX, clientY)?.getAttribute(FOLDER_DROP_PATH_ATTR)?.trim() ?? "";
}

export function playlistDropElementAt(clientX: number, clientY: number): HTMLElement | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  return document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>(`[${PLAYLIST_DROP_ID_ATTR}]`) ?? null;
}

export interface PlaylistDropLocation {
  devicePath: string;
  playlistId: number;
}

/** 从稳定 DOM 属性读取 OneLibrary 落点；拖动结束坐标兜底和原生 drop 共用。 */
export function playlistDropLocation(
  element: Pick<HTMLElement, "getAttribute"> | null,
): PlaylistDropLocation | null {
  if (!element) return null;
  const devicePath = element.getAttribute(PLAYLIST_DROP_DEVICE_ATTR)?.trim() ?? "";
  const playlistId = Number(element.getAttribute(PLAYLIST_DROP_ID_ATTR));
  if (!devicePath || !Number.isInteger(playlistId) || playlistId <= 0) return null;
  return { devicePath, playlistId };
}

export function playlistDropAt(clientX: number, clientY: number): PlaylistDropLocation | null {
  return playlistDropLocation(playlistDropElementAt(clientX, clientY));
}

/**
 * 搜索结果可落在文件夹树，也可落在当前曲目表。
 *
 * WKWebView 丢失原生 drop 时，dragend 兜底必须同时认识这两个区域；旧实现只认
 * 文件夹树，所以拖到截图里的左侧曲目表会被当成「松在空白处」，请求根本没入队。
 */
export function searchQueueDropElementAt(clientX: number, clientY: number): HTMLElement | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  return document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>(`[${SEARCH_QUEUE_DROP_ATTR}]`) ?? null;
}

export function searchQueueDropAt(clientX: number, clientY: number): boolean {
  return Boolean(searchQueueDropElementAt(clientX, clientY));
}

export function searchDropElementAt(clientX: number, clientY: number): HTMLElement | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const hit = document.elementFromPoint(clientX, clientY);
  return (
    hit?.closest<HTMLElement>(
      `[${SEARCH_DEFAULT_DOWNLOAD_DROP_ATTR}], [${SEARCH_DROP_PATH_ATTR}]`,
    ) ?? folderDropElementAt(clientX, clientY)
  );
}

export function searchDropPathAt(clientX: number, clientY: number): string {
  const target = searchDropElementAt(clientX, clientY);
  if (!target) return "";
  if (target.hasAttribute(SEARCH_DEFAULT_DOWNLOAD_DROP_ATTR)) {
    return SEARCH_DEFAULT_DOWNLOAD_SENTINEL;
  }
  return (
    target.getAttribute(SEARCH_DROP_PATH_ATTR)?.trim()
    || target.getAttribute(FOLDER_DROP_PATH_ATTR)?.trim()
    || ""
  );
}
