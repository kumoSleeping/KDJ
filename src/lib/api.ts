/**
 * 本地后端客户端。所有网络访问都必须走这里，组件里不要出现裸 fetch。
 */

import { getBridge } from "./bridge";
import { createYoutubeSabrPreview, type YoutubeSabrBootstrap } from "./youtubeSabr";
import {
  decodeWaveformBinary,
  isWaveformBinaryContentType,
  WAVEFORM_BINARY_MIME,
  type WaveformProfile,
} from "./waveformBinary";
import type {
  Account,
  AnalyzeResponseLike,
  CollectionResolveResponse,
  SearchCapabilities,
  DownloadRequest,
  DownloadTask,
  DuplicateAnalysisResult,
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
  TrackStemStatus,
  LyricsRequest,
  LyricsResponse,
  LocalLyricsResponse,
  Platform,
  Quality,
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
  BrowserCatalog,
  Waveform,
  WsEvent,
} from "../types";

// 壳可能是 Tauri / Electron / 浏览器预览，由 bridge.ts 运行时探测。
// 保持同步取用：audioUrl / coverUrl / WebSocket 这些调用点不能改成 async。
const bridge = () => getBridge();

async function browserYoutubeBotguard(
  operation: "Create" | "GenerateIT",
  payload: unknown[],
): Promise<unknown> {
  const response = await fetch("https://www.youtube.com/api/jnn/v1/" + operation, {
    method: "POST",
    headers: {
      "Content-Type": "application/json+protobuf",
      "X-Goog-Api-Key": "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw",
      "X-User-Agent": "grpc-web-javascript/0.1",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("YouTube BotGuard 返回 HTTP " + response.status);
  return response.json();
}

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
async function requestWaveform(path: string, profile: WaveformProfile): Promise<Waveform> {
  const { baseUrl } = bridge();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api${path}`, {
      cache: "no-store",
      headers: { Accept: `${WAVEFORM_BINARY_MIME}, application/json;q=0.5` },
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
  if (isWaveformBinaryContentType(response.headers.get("Content-Type"))) {
    return decodeWaveformBinary(await response.arrayBuffer(), profile);
  }
  // Compatibility with a Rust server that predates binary negotiation: it ignores `format` and
  // returns the old JSON shape, so frontend HMR does not require an immediate backend restart.
  const text = await response.text();
  const data = text ? safeParse(text) : null;
  if (!data || typeof data !== "object") {
    throw new ApiError("波形响应格式无效", response.status, data);
  }
  return data as Waveform;
}

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

interface YtmProtectedIdentity {
  visitor_data: string;
  data_sync_id: string;
  gvs_binding: "video_id" | "data_sync_id" | "visitor_data";
}

function alternateYtmGvsBinding(identity: YtmProtectedIdentity): YtmProtectedIdentity["gvs_binding"] {
  if (identity.gvs_binding === "video_id") {
    return identity.data_sync_id ? "data_sync_id" : "visitor_data";
  }
  return "video_id";
}

interface PendingDownloadPreparation {
  id: string;
  platform: Platform;
  source: SongSource;
  quality: Quality;
}

async function resolveYtmProtectedStream(
  source: SongSource,
  quality?: Quality,
  knownIdentity?: YtmProtectedIdentity,
  forceFreshProof = false,
  alternateBinding = false,
): Promise<{ poToken: string; poTokens: string[]; resolvedUrl: string; resolvedUrls: string[] }> {
  const videoId = source.payload?.video_id;
  if (source.platform !== "ytm" || typeof videoId !== "string") {
    throw new Error("YouTube Music 歌曲缺少视频 ID");
  }
  const {
    decipherYoutubeWebStream,
    youtubeWebPlayerConfig,
    youtubeWebPoSession,
  } = await import("./youtubePoToken");
  const identity = knownIdentity ?? await request<YtmProtectedIdentity>(
    "/song/preview/ytm/identity",
    { cache: "no-store" },
  );
  const gvsBinding = alternateBinding ? alternateYtmGvsBinding(identity) : identity.gvs_binding;
  const proof = await youtubeWebPoSession(
    videoId,
    identity.visitor_data,
    identity.data_sync_id,
    gvsBinding,
    browserYoutubeBotguard,
    forceFreshProof,
  );
  const playerUrl = await request<string>("/song/preview/ytm/player-url", {
    cache: "no-store",
  });
  const loadPlayerScript = (url: string) => post<string>(
    "/song/preview/ytm/player-script",
    { player_url: url },
  );
  const playerConfig = await youtubeWebPlayerConfig(playerUrl, loadPlayerScript);
  const resolvedUrls: string[] = [];
  for (let index = 0; index < proof.gvsPoTokens.length; index += 1) {
    const protectedPlayer = await post<{
      signature_cipher: string;
      player_url: string;
    }>("/song/preview/ytm/player", {
      source,
      quality,
      po_token: undefined,
      visitor_data: identity.visitor_data,
      data_sync_id: identity.data_sync_id,
      player_url: playerUrl,
      signature_timestamp: playerConfig.signatureTimestamp,
    });
    resolvedUrls.push(await decipherYoutubeWebStream(
      protectedPlayer.signature_cipher,
      protectedPlayer.player_url,
      proof.gvsPoTokens[index],
      loadPlayerScript,
    ));
  }
  return {
    poToken: proof.gvsPoToken,
    poTokens: proof.gvsPoTokens,
    resolvedUrl: resolvedUrls[0],
    resolvedUrls,
  };
}

async function resolveYtmSabrPlayback(
  source: SongSource,
  forceFreshProof = false,
  alternateBinding = false,
): Promise<YoutubeSabrBootstrap> {
  const videoId = source.payload?.video_id;
  if (source.platform !== "ytm" || typeof videoId !== "string") {
    throw new Error("YouTube Music 歌曲缺少视频 ID");
  }
  const {
    decipherYoutubeWebUrl,
    youtubeWebPlayerConfig,
    youtubeWebPoSession,
  } = await import("./youtubePoToken");
  const identity = await request<YtmProtectedIdentity>(
    "/song/preview/ytm/identity",
    { cache: "no-store" },
  );
  const gvsBinding = alternateBinding ? alternateYtmGvsBinding(identity) : identity.gvs_binding;
  const proof = await youtubeWebPoSession(
    videoId,
    identity.visitor_data,
    identity.data_sync_id,
    gvsBinding,
    browserYoutubeBotguard,
    forceFreshProof,
  );
  const playerUrl = await request<string>("/song/preview/ytm/player-url", {
    cache: "no-store",
  });
  const loadPlayerScript = (url: string) => post<string>(
    "/song/preview/ytm/player-script",
    { player_url: url },
  );
  const playerConfig = await youtubeWebPlayerConfig(playerUrl, loadPlayerScript);
  const player = await post<{
    player_url: string;
    sabr_url?: string;
    video_playback_ustreamer_config?: string;
    sabr_formats: unknown[];
    duration_ms: number;
  }>("/song/preview/ytm/player", {
    source,
    po_token: undefined,
    visitor_data: identity.visitor_data,
    data_sync_id: identity.data_sync_id,
    player_url: playerUrl,
    signature_timestamp: playerConfig.signatureTimestamp,
  });
  if (
    !player.sabr_url
    || !player.video_playback_ustreamer_config
    || !Array.isArray(player.sabr_formats)
    || player.sabr_formats.length === 0
    || !Number.isSafeInteger(player.duration_ms)
    || player.duration_ms <= 0
  ) {
    throw new Error("YouTube Music Player 没有返回 SABR 音频会话");
  }
  return {
    serverAbrStreamingUrl: await decipherYoutubeWebUrl(
      player.sabr_url,
      player.player_url,
      loadPlayerScript,
    ),
    videoPlaybackUstreamerConfig: player.video_playback_ustreamer_config,
    formats: player.sabr_formats,
    durationMs: player.duration_ms,
    poToken: proof.gvsPoToken,
  };
}

let ytmPlaybackPrewarm: Promise<void> | null = null;

async function prewarmYtmPlayback(): Promise<void> {
  if (ytmPlaybackPrewarm) return ytmPlaybackPrewarm;
  ytmPlaybackPrewarm = (async () => {
    const {
      prewarmYoutubeWebPoMinter,
      youtubeWebPlayerConfig,
    } = await import("./youtubePoToken");
    const playerUrlPromise = request<string>("/song/preview/ytm/player-url", {
      cache: "no-store",
    });
    await Promise.all([
      request<YtmProtectedIdentity>("/song/preview/ytm/identity", { cache: "no-store" }),
      prewarmYoutubeWebPoMinter(browserYoutubeBotguard),
      playerUrlPromise.then((playerUrl) => youtubeWebPlayerConfig(
        playerUrl,
        (url) => post<string>("/song/preview/ytm/player-script", { player_url: url }),
      )),
    ]);
  })().catch((error) => {
    ytmPlaybackPrewarm = null;
    throw error;
  });
  return ytmPlaybackPrewarm;
}

interface DownloadPreparationContext {
  ytmIdentity?: YtmProtectedIdentity;
}

type DownloadPreparationHandler = (
  item: PendingDownloadPreparation,
  context: DownloadPreparationContext,
  forceFreshProof?: boolean,
  alternateBinding?: boolean,
) => Promise<{ proof: string; resolvedUrl: string }>;

/** 平台挑战只在这个注册表里注入；下载 store、面板和按钮不再识别平台。 */
const downloadPreparationHandlers: Partial<Record<Platform, DownloadPreparationHandler>> = {
  ytm: async (item, context, forceFreshProof = false, alternateBinding = false) => {
    if (forceFreshProof) context.ytmIdentity = undefined;
    context.ytmIdentity ??= await request<YtmProtectedIdentity>(
      "/song/preview/ytm/identity",
      { cache: "no-store" },
    );
    const stream = await resolveYtmProtectedStream(
      item.source,
      item.quality,
      context.ytmIdentity,
      forceFreshProof,
      alternateBinding,
    );
    return { proof: stream.poToken, resolvedUrl: stream.resolvedUrl };
  },
};

async function preparePendingDownloads(onlyId?: string): Promise<void> {
  const pending = await request<PendingDownloadPreparation[]>("/downloads/preparations/pending", {
    cache: "no-store",
  });
  const selected = onlyId ? pending.filter((item) => item.id === onlyId) : pending;
  if (selected.length === 0) return;
  const context: DownloadPreparationContext = {};
  let firstError: unknown = null;
  // 浏览器挑战按队列顺序串行；真正的媒体传输仍由后端按统一并发设置调度。
  for (const item of selected) {
    try {
      const handler = downloadPreparationHandlers[item.platform];
      if (!handler) throw new Error("平台 " + item.platform + " 没有注册下载准备适配器");
      let prepared = await handler(item, context);
      try {
        await post(`/downloads/${encodeURIComponent(item.id)}/prepared-source`, {
          proof: prepared.proof,
          resolved_url: prepared.resolvedUrl,
        });
      } catch (error) {
        const rejectedProof = error instanceof ApiError && (error.status === 401 || error.status === 403);
        if (item.platform !== "ytm" || !rejectedProof) throw error;
        prepared = await handler(item, context, true);
        try {
          await post(`/downloads/${encodeURIComponent(item.id)}/prepared-source`, {
            proof: prepared.proof,
            resolved_url: prepared.resolvedUrl,
          });
        } catch (freshError) {
          const freshRejected = freshError instanceof ApiError
            && (freshError.status === 401 || freshError.status === 403);
          if (!freshRejected) throw freshError;
          prepared = await handler(item, context, true, true);
          await post(`/downloads/${encodeURIComponent(item.id)}/prepared-source`, {
            proof: prepared.proof,
            resolved_url: prepared.resolvedUrl,
          });
        }
      }
    } catch (error) {
      firstError ??= error;
      const message = error instanceof Error ? error.message : String(error);
      await post(`/downloads/${encodeURIComponent(item.id)}/preparation-failed`, {
        error: message,
      }).catch(() => undefined);
    }
  }
  if (firstError) throw firstError;
}

export const api = {
  health: () => request<Health>("/health"),
  prewarmYtmPlayback,

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
  soundcloudBrowserCatalog: () =>
    request<BrowserCatalog>("/accounts/soundcloud/login/browsers"),
  soundcloudBrowserLogin: (browser: string, profile?: string) =>
    post<Account>("/accounts/soundcloud/login/browser", { browser, profile }),
  ytmBrowserCatalog: () =>
    request<BrowserCatalog>("/accounts/ytm/login/browsers"),
  ytmBrowserLogin: (browser: string, profile?: string) =>
    post<Account>("/accounts/ytm/login/browser", { browser, profile }),
  ytmHeadersLogin: (headers: string) =>
    post<Account>("/accounts/ytm/login/headers", { headers }),
  youtubeBrowserCatalog: () =>
    request<BrowserCatalog>("/accounts/youtube/login/browsers"),
  youtubeBrowserLogin: (browser: string, profile?: string) =>
    post<Account>("/accounts/youtube/login/browser", { browser, profile }),
  youtubeHeadersLogin: (headers: string) =>
    post<Account>("/accounts/youtube/login/headers", { headers }),

  search: (body: SearchRequest) => post<SearchResponse>("/search", body),
  searchCapabilities: () => request<SearchCapabilities>("/search/capabilities"),
  /** limit = 0 表示不截断：歌单/专辑类解析一直检索到完整列出。 */
  resolveCollection: (collection: CollectionResult, limit = 0) =>
    post<CollectionResolveResponse>("/search/collection", {
      platform: collection.platform,
      kind: collection.kind,
      key: collection.key,
      limit,
    }),
  /** 按曲名/艺人自动搜歌词（网易云 / QQ / YouTube Music）；有来源 key 时优先直取。 */
  lyrics: (body: LyricsRequest) => post<LyricsResponse>("/lyrics", body),
  libraryLyrics: (trackId: number) => request<LocalLyricsResponse>(`/library/lyrics/${trackId}`),
  /**
   * 歌曲试听代理（使用设置中的试听音质，不下载）。整个 SongSource 发过去：
   * QQ 的 media_mid、SoundCloud 的 transcoding_url 都在 payload 里。
   */
  songPreview: async (source: SongSource, bypassCache = false) => {
    // Normal path: cached selected binding -> fresh selected binding -> fresh alternate binding.
    // An explicit cache-bypass already starts fresh, so it only needs selected -> alternate.
    const attempts = source.platform === "ytm" ? (bypassCache ? 2 : 3) : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (source.platform === "ytm") {
          const bootstrap = await resolveYtmSabrPlayback(
            source,
            bypassCache || attempt > 0,
            bypassCache ? attempt > 0 : attempt > 1,
          );
          return await createYoutubeSabrPreview(source, bootstrap, bypassCache);
        }
        let poToken: string | undefined;
        let poTokens: string[] | undefined;
        let resolvedUrl: string | undefined;
        let resolvedUrls: string[] | undefined;
        const result = await post<{ url: string; cached?: boolean; waveform_token?: string }>("/song/preview", {
          source,
          bypass_cache: bypassCache,
          po_token: poToken,
          po_tokens: poTokens,
          resolved_url: resolvedUrl,
          resolved_urls: resolvedUrls,
        });
        if (!result.url.startsWith("/")) return result;
        return { ...result, url: bridge().baseUrl + result.url };
      } catch (error) {
        const rejectedProof = error instanceof ApiError && (error.status === 401 || error.status === 403);
        if (source.platform !== "ytm" || !rejectedProof || attempt + 1 >= attempts) throw error;
        // The next iteration drops both the WebPO token cache and its attestation minter.
      }
    }
    throw new ApiError("YouTube Music 没有返回可播放地址", 502);
  },
  /** token 只由 songPreview 返回；服务端据此查当前会话，绝不让前端传缓存路径/key。 */
  songPreviewWaveform: (token: string) =>
    request<StreamWaveformProgress>(`/song/preview/${encodeURIComponent(token)}/waveform`, {
      cache: "no-store",
    }),
  streamCacheStats: () => request<StreamCacheStats>("/song/cache"),
  clearStreamCache: () =>
    request<StreamCacheStats>("/song/cache", { method: "DELETE" }),
  resolve: (url: string, limit = 0) => post<ResolveResponse>("/resolve", { url, limit }),
  intake: (body: IntakeRequest) => post<IntakeResponse>("/intake", body),

  downloads: () => request<DownloadTask[]>("/downloads"),
  enqueue: (body: DownloadRequest) => post<DownloadTask[]>("/downloads", body),
  preparePendingDownloads: (onlyId?: string) => preparePendingDownloads(onlyId),
  startDownloads: async () => {
    // 某条外部挑战失败已经写回该任务；不能因此挡住同批普通平台任务开始。
    await preparePendingDownloads().catch(() => undefined);
    return post<{ started: boolean; retried: number }>("/downloads/start");
  },
  cancelDownload: (id: string) => post<DownloadTask>(`/downloads/${id}/cancel`),
  cancelAllDownloads: () => post<{ canceled: number }>("/downloads/cancel-all"),
  retryDownload: async (id: string) => {
    await preparePendingDownloads(id);
    return post<DownloadTask>(`/downloads/${id}/retry`);
  },
  /** 只移除一条已结束的队列记录，避免「清空」影响其他历史任务。 */
  removeDownload: (id: string) => request<{ removed: boolean }>(`/downloads/${id}`, { method: "DELETE" }),
  clearDownloads: () => post<{ removed: number }>("/downloads/clear"),

  videoResolve: (url: string, platform?: "bilibili" | "youtube") =>
    post<VideoInfo>("/video/resolve", { url, platform }),
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
  cancelScan: (jobId = "") =>
    post<{ canceled: number }>(
      `/library/scan/cancel${jobId ? `?job_id=${encodeURIComponent(jobId)}` : ""}`,
    ),
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
  waveform: (
    id: number,
    buckets = 640,
    profile: WaveformProfile = "current",
  ) =>
    requestWaveform(
      `/library/waveform/${id}?buckets=${buckets}&profile=${profile}&format=binary`,
      profile,
    ),
  stemRuntimeStatus: () => request<StemRuntimeStatus>("/stems/runtime"),
  resetStemRuntime: () => post<StemRuntimeStatus>("/stems/runtime/reset", {}),
  trackStemStatus: (id: number) => request<TrackStemStatus>(`/tracks/${id}/stems`),
  oneLibraryWaveform: (
    devicePath: string,
    contentId: number,
    playbackId: number,
    buckets = 640,
    profile: WaveformProfile = "current",
  ) => {
    const query = new URLSearchParams({
      device_path: devicePath,
      content_id: String(contentId),
      playback_id: String(playbackId),
      buckets: String(buckets),
      profile,
      format: "binary",
    });
    return requestWaveform(`/library/onelibrary/waveform?${query}`, profile);
  },
  harmonic: (id: number, tolerance = 12, limit = 60, folder = "") =>
    request<HarmonicMatch[]>(
      `/library/harmonic/${id}?bpm_tolerance=${tolerance}&limit=${limit}` +
        (folder ? `&folder=${encodeURIComponent(folder)}` : ""),
    ),
  stats: () => request<LibraryStats>("/library/stats"),
  /** 检查更新走后端：CSP/证书链三个壳一条路，见 routes.rs::update_check。 */
  checkUpdate: () => request<UpdateInfo>("/update/check"),

  streamPlaylists: (platform: Exclude<Platform, "local">) =>
    request<StreamPlaylist[]>(`/stream/playlists/${platform}`),
  streamPlaylist: (playlist: StreamPlaylist, limit = 0) =>
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
  mergeFolders: (paths: string[], destParent: string, name: string) =>
    post<{ tree: FolderTree; target: string }>("/library/folders/merge", {
      paths,
      dest_parent: destParent,
      name,
    }),
  orderFolder: (path: string, names: string[]) =>
    post<FolderTree>("/library/folders/order", { path, names }),
  folderUndoStatus: () => request<FolderUndoStatus>("/library/folders/undo"),
  undoFolderOp: () => post<FolderUndoResponse>("/library/folders/undo"),
  applyFolderOp: (trackIds: number[], dest: string, op: FileOp) =>
    post<FolderOpResult>("/library/folders/apply", { track_ids: trackIds, dest, op }),
  analyzeDuplicates: (request: {
    all: boolean;
    folders: string[];
    include_subfolders: boolean;
  }) => post<DuplicateAnalysisResult>("/library/duplicates/analyze", request),

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
