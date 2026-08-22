/**
 * 本地后端客户端。所有网络访问都必须走这里，组件里不要出现裸 fetch。
 */

import { getBridge } from "./bridge";
import type {
  Account,
  AnalyzeResponseLike,
  CollectionResolveResponse,
  SearchCapabilities,
  DownloadRequest,
  DownloadTask,
  FileOp,
  FileDisposalMode,
  FolderForgetResult,
  FolderOpResult,
  FolderTree,
  FolderUndoResponse,
  FolderUndoStatus,
  HarmonicMatch,
  Health,
  IntakeRequest,
  IntakeResponse,
  LibraryStats,
  OneLibraryCapacityPlan,
  OneLibraryImportResult,
  OneLibraryPlaylist,
  OneLibraryTrack,
  PlaylistExportResult,
  RemovableDevice,
  UpdateInfo,
  QrSession,
  QrState,
  SoundCloudOAuthStart,
  SoundCloudOAuthStatus,
  SoundCloudOAuthCallback,
  ResolveResponse,
  CollectionResult,
  ScanResponseLike,
  StreamPlaylist,
  StreamPlaylistResponse,
  StreamCacheStats,
  StreamWaveformProgress,
  StemRuntimeStatus,
  StemName,
  LiveStemWaveformDelta,
  TrackStemStatus,
  LyricsRequest,
  LyricsResponse,
  LocalLyricsResponse,
  Platform,
  SearchRequest,
  SearchResponse,
  Settings,
  SongSource,
  Track,
  TrackPage,
  TrackPatch,
  TrackPatchResult,
  VideoDownloadRequest,
  VideoInfo,
  VjExportRequest,
  Waveform,
  WsEvent,
} from "../types";

// 壳可能是 Tauri / Electron / 浏览器预览，由 bridge.ts 运行时探测。
// 保持同步取用：audioUrl / coverUrl / WebSocket 这些调用点不能改成 async。
const bridge = () => getBridge();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { baseUrl } = bridge();
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api${path}`, { ...init, headers });
  } catch (error) {
    throw new ApiError(`无法连接本地服务：${(error as Error).message}`, 0);
  }
  const text = await response.text();
  const data = text ? safeParse(text) : null;
  if (!response.ok) {
    const detail =
      (data && typeof data === "object" && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : "") || response.statusText;
    throw new ApiError(detail || `HTTP ${response.status}`, response.status, data);
  }
  return data as T;
}

/** 和 request 共用同一套错误语义，但保留图片响应为 Blob。 */
async function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const { baseUrl } = bridge();
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch (error) {
    throw new ApiError(`无法连接本地服务：${(error as Error).message}`, 0);
  }
  if (!response.ok) {
    const text = await response.text();
    const data = text ? safeParse(text) : null;
    const detail =
      (data && typeof data === "object" && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : "") || response.statusText;
    throw new ApiError(detail || `HTTP ${response.status}`, response.status, data);
  }
  return response.blob();
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  health: () => request<Health>("/health"),

  getSettings: () => request<Settings>("/settings"),
  putSettings: (settings: Settings) =>
    request<Settings>("/settings", { method: "PUT", body: JSON.stringify(settings) }),

  accounts: () => request<Account[]>("/accounts"),
  loginQr: (platform: string) => post<QrSession>(`/accounts/${platform}/login/qr`),
  loginQrState: (platform: string, sessionId: string) =>
    request<QrState>(`/accounts/${platform}/login/qr/${sessionId}`),
  logout: (platform: string) => post<Account>(`/accounts/${platform}/logout`),
  soundcloudOAuthStart: () => request<SoundCloudOAuthStart>("/accounts/soundcloud/login/oauth"),
  soundcloudOAuthStatus: (state: string) =>
    request<SoundCloudOAuthStatus>(`/accounts/soundcloud/login/oauth/${encodeURIComponent(state)}`),
  soundcloudOAuthCallback: (body: SoundCloudOAuthCallback) =>
    post<Account>("/accounts/soundcloud/login/oauth/callback", body),

  search: (body: SearchRequest) => post<SearchResponse>("/search", body),
  searchCapabilities: () => request<SearchCapabilities>("/search/capabilities"),
  resolveCollection: (collection: CollectionResult, limit = 500) =>
    post<CollectionResolveResponse>("/search/collection", {
      platform: collection.platform,
      kind: collection.kind,
      key: collection.key,
      limit,
    }),
  /** 按曲名/艺人自动搜歌词（网易云 + QQ）；有来源 key 时优先直取。 */
  lyrics: (body: LyricsRequest) => post<LyricsResponse>("/lyrics", body),
  libraryLyrics: (trackId: number) => request<LocalLyricsResponse>(`/library/lyrics/${trackId}`),
  /**
   * 歌曲试听代理（使用设置中的试听音质，不下载）。整个 SongSource 发过去：
   * QQ 的 media_mid、SoundCloud 的 transcoding_url 都在 payload 里。
   */
  songPreview: async (source: SongSource, bypassCache = false) => {
    const result = await post<{ url: string; cached?: boolean; waveform_token?: string }>("/song/preview", {
      source,
      bypass_cache: bypassCache,
    });
    if (!result.url.startsWith("/")) return result;
    return { ...result, url: `${bridge().baseUrl}${result.url}` };
  },
  /** token 只由 songPreview 返回；服务端据此查当前会话，绝不让前端传缓存路径/key。 */
  songPreviewWaveform: (token: string) =>
    request<StreamWaveformProgress>(`/song/preview/${encodeURIComponent(token)}/waveform`, {
      cache: "no-store",
    }),
  streamCacheStats: () => request<StreamCacheStats>("/song/cache"),
  clearStreamCache: () =>
    request<StreamCacheStats>("/song/cache", { method: "DELETE" }),
  resolve: (url: string, limit = 500) => post<ResolveResponse>("/resolve", { url, limit }),
  intake: (body: IntakeRequest) => post<IntakeResponse>("/intake", body),

  downloads: () => request<DownloadTask[]>("/downloads"),
  enqueue: (body: DownloadRequest) => post<DownloadTask[]>("/downloads", body),
  startDownloads: () => post<{ started: boolean; retried: number }>("/downloads/start"),
  cancelDownload: (id: string) => post<DownloadTask>(`/downloads/${id}/cancel`),
  retryDownload: (id: string) => post<DownloadTask>(`/downloads/${id}/retry`),
  /** 只移除一条已结束的队列记录，避免「清空」影响其他历史任务。 */
  removeDownload: (id: string) => request<{ removed: boolean }>(`/downloads/${id}`, { method: "DELETE" }),
  clearDownloads: () => post<{ removed: number }>("/downloads/clear"),

  videoResolve: (url: string) => post<VideoInfo>("/video/resolve", { url }),
  videoDownload: (body: VideoDownloadRequest) => post<DownloadTask>("/video/download", body),
  /** 按顺序导出 VJ：由下载队列统一调度、显示进度并支持取消。 */
  vjExport: (body: VjExportRequest) => post<DownloadTask>("/vj/export", body),
  videoCalibrate: (trackId: number, bvid: string, page = 0) =>
    post<{ offset_ms: number; score: number }>("/video/calibrate", {
      track_id: trackId,
      bvid,
      page,
    }),
  /**
   * 视频预览流（后端代理 B 站 CDN，见 routes.rs::video_preview）。
   * 后端代理 B 站防盗链；本机 API 开放，无需额外令牌。
   */
  videoPreviewUrl: (bvid: string, page = 0) => {
    const { baseUrl } = bridge();
    return `${baseUrl}/api/video/preview?bvid=${encodeURIComponent(bvid)}&page=${page}`;
  },

  tracks: (params: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return request<TrackPage>(`/library/tracks${suffix ? `?${suffix}` : ""}`);
  },
  removableDevices: () => request<RemovableDevice[]>("/library/devices"),
  authorizeRemovableDevice: (path: string) =>
    post<RemovableDevice>("/library/devices/authorize", { path }),
  oneLibraryPlaylists: (devicePath: string) => {
    const query = new URLSearchParams({ device_path: devicePath });
    return request<OneLibraryPlaylist[]>(`/library/onelibrary/playlists?${query}`);
  },
  oneLibraryPlaylistTracks: (devicePath: string, id: number) => {
    const query = new URLSearchParams({ device_path: devicePath });
    return request<OneLibraryTrack[]>(`/library/onelibrary/playlists/${id}/tracks?${query}`);
  },
  reorderOneLibraryPlaylistTracks: (devicePath: string, id: number, contentIds: number[]) =>
    request<OneLibraryTrack[]>(`/library/onelibrary/playlists/${id}/tracks`, {
      method: "PUT",
      body: JSON.stringify({ device_path: devicePath, content_ids: contentIds }),
    }),
  removeOneLibraryPlaylistTracks: (devicePath: string, id: number, contentIds: number[]) =>
    post<OneLibraryTrack[]>(`/library/onelibrary/playlists/${id}/tracks/remove`, {
      device_path: devicePath,
      content_ids: contentIds,
    }),
  copyOneLibraryPlaylistTracks: (
    sourceDevicePath: string,
    sourcePlaylistId: number,
    targetDevicePath: string,
    targetPlaylistId: number,
    contentIds: number[],
  ) =>
    post<OneLibraryTrack[]>("/library/onelibrary/tracks/copy", {
      source_device_path: sourceDevicePath,
      source_playlist_id: sourcePlaylistId,
      target_device_path: targetDevicePath,
      target_playlist_id: targetPlaylistId,
      content_ids: contentIds,
    }),
  setOneLibraryRating: (devicePath: string, contentId: number, rating: number) =>
    request<{ ok: boolean }>(`/library/onelibrary/tracks/${contentId}/rating`, {
      method: "PATCH",
      body: JSON.stringify({ device_path: devicePath, rating }),
    }),
  createOneLibraryPlaylist: (
    devicePath: string,
    name: string,
    parentId: number | null = null,
    folder = false,
  ) =>
    post<OneLibraryPlaylist>("/library/onelibrary/playlists", {
      device_path: devicePath,
      name,
      parent_id: parentId,
      folder,
    }),
  renameOneLibraryPlaylist: (devicePath: string, id: number, name: string) =>
    request<{ ok: boolean }>(`/library/onelibrary/playlists/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ device_path: devicePath, name }),
    }),
  moveOneLibraryPlaylist: (
    devicePath: string,
    id: number,
    parentId: number,
    sequence: number | null,
  ) =>
    post<OneLibraryPlaylist[]>(`/library/onelibrary/playlists/${id}/move`, {
      device_path: devicePath,
      parent_id: parentId,
      sequence,
    }),
  deleteOneLibraryPlaylist: (devicePath: string, id: number) =>
    request<{ ok: boolean }>(`/library/onelibrary/playlists/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ device_path: devicePath }),
    }),
  addOneLibraryPlaylistTracks: (devicePath: string, id: number, trackIds: number[]) =>
    post<PlaylistExportResult>(`/library/onelibrary/playlists/${id}/tracks/add`, {
      device_path: devicePath,
      track_ids: trackIds,
    }),
  oneLibraryCapacity: (devicePath: string, trackIds: number[]) =>
    post<OneLibraryCapacityPlan>("/library/onelibrary/capacity", {
      device_path: devicePath,
      track_ids: trackIds,
    }),
  importOneLibraryTracks: (
    devicePath: string,
    playlistId: number,
    contentIds: number[],
    dest: string,
  ) =>
    post<OneLibraryImportResult>("/library/onelibrary/import", {
      device_path: devicePath,
      playlist_id: playlistId,
      content_ids: contentIds,
      dest,
    }),
  oneLibraryCoverBlob: (devicePath: string, contentId: number) =>
    requestBlob(
      `/library/onelibrary/cover?device_path=${encodeURIComponent(devicePath)}&content_id=${contentId}`,
    ),
  setOneLibraryCover: (devicePath: string, contentId: number, file: Blob) =>
    request<{ ok: boolean }>(
      `/library/onelibrary/cover?device_path=${encodeURIComponent(devicePath)}&content_id=${contentId}`,
      {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      },
    ),
  track: (id: number) => request<Track>(`/library/tracks/${id}`),
  patchTrack: (id: number, patch: TrackPatch) =>
    request<TrackPatchResult>(`/library/tracks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  /**
   * 换封面：请求体就是图片二进制。
   *
   * Content-Type 必须自己填上——`request` 只在没写的时候补 application/json，
   * 让它补的话后端拿到的是一坨声称是 JSON 的 JPEG。
   */
  setCover: (id: number, file: Blob) =>
    request<Track>(`/library/cover/${id}`, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    }),
  /** 读取另一首曲目的封面，供详情栏的“复用封面”拖放使用。 */
  coverBlob: (id: number) => requestBlob(`/library/cover/${id}`),
  /** 通过本地服务代理网易云 / QQ 封面，绕过 Tauri WebView 的跨域限制。 */
  onlineCover: (platform: Extract<Platform, "wyy" | "qqm">, url: string) =>
    requestBlob("/search/cover", {
      method: "POST",
      body: JSON.stringify({ platform, url }),
    }),
  /**
   * 按文件里现存的标签刷新库里那条记录。
   *
   * 增量扫描按 mtime 跳过，所以"文件里有、库里空着"的记录（早年入库时读标签失败的）
   * 靠再扫一遍是永远好不了的，只能显式重读一次。
   */
  rereadTags: (id: number) => post<Track>(`/library/tracks/${id}/reread-tags`),
  deleteTrack: (id: number, deleteFile = false) =>
    request<{ ok: boolean; undo?: FolderUndoStatus }>(
      `/library/tracks/${id}?delete_file=${deleteFile}`,
      { method: "DELETE" },
    ),
  /**
   * 批量删除。file 决定文件本体的去向（keep/trash/remove）。
   * `errors` 按 track id 报没删成的原因（比如进不了回收站），
   * 那些曲目连库记录都原样留着——半删的状态比报错更难收拾。
   */
  deleteTracks: (ids: number[], file: FileDisposalMode) =>
    post<{
      removed: number;
      errors: Record<string, string>;
      /** 删除成功后最近一次可撤回状态；旧后端可能不返回。 */
      undo?: FolderUndoStatus;
    }>("/library/tracks/delete", {
      track_ids: ids,
      file,
    }),
  scan: (paths: string[], analyze = false) =>
    post<ScanResponseLike>("/library/scan", { paths, recursive: true, analyze }),
  analyze: (
    trackIds: number[] | null,
    force = false,
    priority = false,
    version: "v1" | "v2" = "v1",
    limit?: number,
    folder = "",
  ) =>
    post<AnalyzeResponseLike>("/library/analyze", {
      track_ids: trackIds,
      force,
      priority,
      version,
      ...(limit === undefined ? {} : { limit }),
      ...(folder ? { folder } : {}),
    }),
  cancelAnalyze: (jobId = "") =>
    post<{ canceled: number; remaining: number }>(
      `/library/analyze/cancel${jobId ? `?job_id=${encodeURIComponent(jobId)}` : ""}`,
    ),
  writeTags: (id: number) => post<Track>(`/library/tracks/${id}/write-tags`),
  waveform: (id: number, buckets = 640) =>
    request<Waveform>(`/library/waveform/${id}?buckets=${buckets}`),
  stemRuntimeStatus: () => request<StemRuntimeStatus>("/stems/runtime"),
  resetStemRuntime: () => post<StemRuntimeStatus>("/stems/runtime/reset", {}),
  trackStemStatus: (
    id: number,
    position?: number,
    playing = false,
  ) =>
    request<TrackStemStatus>(
      `/tracks/${id}/stems?${
        position === undefined || !Number.isFinite(position)
          ? ""
          : `position=${Math.max(0, position)}&playing=${playing ? "true" : "false"}`
      }`,
    ),
  separateTrackStems: (
    id: number,
    position = 0,
    options: {
      duration?: number;
      deck?: 0 | 1;
      playing?: boolean;
    },
  ) =>
    post<TrackStemStatus>(`/tracks/${id}/stems`, {
      position: Number.isFinite(position) ? Math.max(0, position) : 0,
      duration: Number.isFinite(options?.duration) ? Math.max(0, options?.duration ?? 0) : 0,
      deck: options?.deck === 1 ? 1 : 0,
      playing: options?.playing === true,
    }),
  releaseTrackStems: (id: number) =>
    request<{ released: boolean }>(`/tracks/${id}/stems`, { method: "DELETE" }),
  stemWaveform: (id: number, stem: StemName, buckets = 640) =>
    request<Waveform>(`/tracks/${id}/stems/waveform/${stem}?buckets=${buckets}`),
  /**
   * Live performance lanes poll this small append-only payload. Do not use `stemWaveform` here:
   * a 24k-column response × four lanes every 200ms starves WebKit's compositor.
   */
  stemWaveformDelta: (id: number, buckets: number, after = 0, epoch: number | null = null) =>
    request<LiveStemWaveformDelta>(
      `/tracks/${id}/stems/waveform?buckets=${buckets}&after=${Math.max(0, after)}${
        epoch === null ? "" : `&epoch=${Math.max(0, epoch)}`
      }`,
      { cache: "no-store" },
    ),
  oneLibraryWaveform: (
    devicePath: string,
    contentId: number,
    playbackId: number,
    buckets = 640,
  ) => {
    const query = new URLSearchParams({
      device_path: devicePath,
      content_id: String(contentId),
      playback_id: String(playbackId),
      buckets: String(buckets),
    });
    return request<Waveform>(`/library/onelibrary/waveform?${query}`);
  },
  harmonic: (id: number, tolerance = 12, limit = 60, folder = "") =>
    request<HarmonicMatch[]>(
      `/library/harmonic/${id}?bpm_tolerance=${tolerance}&limit=${limit}` +
        (folder ? `&folder=${encodeURIComponent(folder)}` : ""),
    ),
  stats: () => request<LibraryStats>("/library/stats"),
  /** 检查更新走后端：CSP/证书链三个壳一条路，见 routes.rs::update_check。 */
  checkUpdate: () => request<UpdateInfo>("/update/check"),

  streamPlaylists: (platform: Exclude<Platform, "local" | "bilibili">) =>
    request<StreamPlaylist[]>(`/stream/playlists/${platform}`),
  streamPlaylist: (playlist: StreamPlaylist, limit = 500) =>
    post<StreamPlaylistResponse>("/stream/playlist", {
      platform: playlist.platform,
      key: playlist.key,
      limit,
    }),

  folders: () => request<FolderTree>("/library/folders"),
  createFolder: (parent: string, name: string) =>
    post<FolderTree>("/library/folders/create", { parent, name }),
  renameFolder: (path: string, name: string) =>
    post<FolderTree>("/library/folders/rename", { path, name }),
  deleteFolder: (path: string) => post<FolderTree>("/library/folders/delete", { path }),
  /** 从软件移出文件夹：摘掉库记录 / 曲库根登记，磁盘文件不动。 */
  forgetFolder: (path: string) => post<FolderForgetResult>("/library/folders/forget", { path }),
  initFolders: (path = "") => post<FolderTree>("/library/folders/init", { path }),
  upgradeFolders: () => post<{ job_id: string }>("/library/folders/upgrade", {}),
  upgradeWaveforms: () => post<{ job_id: string }>("/library/waveforms/upgrade", {}),
  moveFolder: (path: string, destParent: string) =>
    post<FolderTree>("/library/folders/move", { path, dest_parent: destParent }),
  orderFolder: (path: string, names: string[]) =>
    post<FolderTree>("/library/folders/order", { path, names }),
  folderUndoStatus: () => request<FolderUndoStatus>("/library/folders/undo"),
  undoFolderOp: () => post<FolderUndoResponse>("/library/folders/undo"),
  applyFolderOp: (trackIds: number[], dest: string, op: FileOp) =>
    post<FolderOpResult>("/library/folders/apply", { track_ids: trackIds, dest, op }),

  audioUrl: (id: number) => {
    const { baseUrl } = bridge();
    return `${baseUrl}/api/library/audio/${id}`;
  },
  videoUrl: (id: number, compatible = false) => {
    const { baseUrl } = bridge();
    return `${baseUrl}/api/library/video/${id}${compatible ? "?compat=true" : ""}`;
  },
  /**
   * `version` 是 cache-buster，不是后端认识的参数。
   *
   * 封面响应带 `Cache-Control: max-age`，换过封面之后 URL 不变的话
   * 浏览器会一直拿缓存里那张旧图，用户看到的就是"换封面没反应"。
   */
  coverUrl: (id: number, version?: number | string) => {
    const { baseUrl } = bridge();
    const suffix = version === undefined || version === "" ? "" : `?v=${encodeURIComponent(version)}`;
    return `${baseUrl}/api/library/cover/${id}${suffix}`;
  },
  oneLibraryCoverUrl: (devicePath: string, contentId: number, version?: number | string) => {
    const { baseUrl } = bridge();
    const query = new URLSearchParams({
      device_path: devicePath,
      content_id: String(contentId),
    });
    if (version !== undefined && version !== "") query.set("v", String(version));
    return `${baseUrl}/api/library/onelibrary/cover?${query}`;
  },
};

/* ---------------------------------------------------------------- WebSocket */

type Listener = (event: WsEvent) => void;

class EventStream {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.ensure();
    return () => {
      this.listeners.delete(listener);
    };
  }

  private ensure(): void {
    if (this.socket || this.stopped) return;
    const { baseUrl } = bridge();
    const url = `${baseUrl.replace(/^http/, "ws")}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
    };
    socket.onmessage = (message) => {
      let event: WsEvent;
      try {
        event = JSON.parse(message.data as string) as WsEvent;
      } catch {
        return;
      }
      for (const listener of this.listeners) listener(event);
    };
    socket.onclose = () => {
      this.socket = null;
      this.scheduleReconnect();
    };
    socket.onerror = () => socket.close();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(500 * 2 ** this.retry, 8000);
    this.retry += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.ensure();
    }, delay);
  }
}

export const events = new EventStream();
