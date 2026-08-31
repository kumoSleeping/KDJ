/**
 * 本地后端客户端。所有网络访问都必须走这里，组件里不要出现裸 fetch。
 */

import { getBridge } from "./bridge";
import {
  describeApiActivity,
  finishApiActivity,
  type ApiActivityHint,
} from "./activityLog";
import type { YoutubeSabrBootstrap } from "./youtubeSabr";
import {
  decipherNativeYoutubeUrl,
  mintNativeYoutubeGvsPoToken,
  nativeYoutubePlayerConfig,
  transformNativeYoutubeN,
  YOUTUBE_HLS_USER_AGENT,
  YOUTUBE_NATIVE_PROOF_SUPPORTED,
} from "./youtubeNativePo";
import { appendClientPlaybackNonce } from "./youtubePlaybackUrl";
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
  StreamPlaylistTrackRemoveResponse,
  StreamCacheStats,
  StreamWaveformProgress,
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
  BrowserCatalog,
  CacheCategory,
  CacheOverview,
  ActivityLogCategory,
  ActivityLogOverview,
  ActivityLogSettings,
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

async function request<T>(
  path: string,
  init: RequestInit = {},
  activityHint?: ApiActivityHint,
): Promise<T> {
  const { baseUrl, authToken } = bridge();
  const activity = describeApiActivity(path, init, activityHint);
  const activityStarted = performance.now();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${authToken}`);
  if (activity) headers.set("X-KDJ-Activity-Recorded", "1");
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api${path}`, { ...init, headers });
  } catch (error) {
    finishApiActivity(activity, {
      status: 0,
      durationMs: performance.now() - activityStarted,
      ok: false,
      error: (error as Error).message,
    });
    throw new ApiError(`无法连接本地服务：${(error as Error).message}`, 0);
  }
  const text = await response.text();
  const data = text ? safeParse(text) : null;
  if (!response.ok) {
    const detail =
      (data && typeof data === "object" && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : "") || response.statusText;
    const message = detail || `HTTP ${response.status}`;
    finishApiActivity(activity, {
      status: response.status,
      durationMs: performance.now() - activityStarted,
      ok: false,
      error: message,
    });
    throw new ApiError(message, response.status, data);
  }
  finishApiActivity(activity, {
    status: response.status,
    durationMs: performance.now() - activityStarted,
    ok: true,
  });
  return data as T;
}

/** 和 request 共用同一套错误语义，但保留图片响应为 Blob。 */
async function requestWaveform(
  path: string,
  profile: WaveformProfile,
  signal?: AbortSignal,
): Promise<Waveform> {
  const { baseUrl, authToken } = bridge();
  const activity = describeApiActivity(path, { method: "GET" });
  const activityStarted = performance.now();
  const headers = new Headers({
    Accept: `${WAVEFORM_BINARY_MIME}, application/json;q=0.5`,
    Authorization: `Bearer ${authToken}`,
  });
  if (activity) headers.set("X-KDJ-Activity-Recorded", "1");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api${path}`, {
      cache: "no-store",
      signal,
      headers,
    });
  } catch (error) {
    // Superseded waveform work is expected during a Deck switch. Preserve AbortError so the
    // acquisition layer can keep it silent instead of presenting it as a server outage.
    if (signal?.aborted) throw error;
    finishApiActivity(activity, {
      status: 0,
      durationMs: performance.now() - activityStarted,
      ok: false,
      error: (error as Error).message,
    });
    throw new ApiError(`无法连接本地服务：${(error as Error).message}`, 0);
  }
  if (!response.ok) {
    const text = await response.text();
    const data = text ? safeParse(text) : null;
    const detail =
      (data && typeof data === "object" && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : "") || response.statusText;
    const message = detail || `HTTP ${response.status}`;
    finishApiActivity(activity, {
      status: response.status,
      durationMs: performance.now() - activityStarted,
      ok: false,
      error: message,
    });
    throw new ApiError(message, response.status, data);
  }
  try {
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
  } catch (error) {
    finishApiActivity(activity, {
      status: response.status,
      durationMs: performance.now() - activityStarted,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function requestBlob(
  path: string,
  init: RequestInit = {},
  activityHint?: ApiActivityHint,
): Promise<Blob> {
  const { baseUrl, authToken } = bridge();
  const activity = describeApiActivity(path, init, activityHint);
  const activityStarted = performance.now();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${authToken}`);
  if (activity) headers.set("X-KDJ-Activity-Recorded", "1");
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
    finishApiActivity(activity, {
      status: 0,
      durationMs: performance.now() - activityStarted,
      ok: false,
      error: (error as Error).message,
    });
    throw new ApiError(`无法连接本地服务：${(error as Error).message}`, 0);
  }
  if (!response.ok) {
    const text = await response.text();
    const data = text ? safeParse(text) : null;
    const detail =
      (data && typeof data === "object" && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : "") || response.statusText;
    const message = detail || `HTTP ${response.status}`;
    finishApiActivity(activity, {
      status: response.status,
      durationMs: performance.now() - activityStarted,
      ok: false,
      error: message,
    });
    throw new ApiError(message, response.status, data);
  }
  finishApiActivity(activity, {
    status: response.status,
    durationMs: performance.now() - activityStarted,
    ok: true,
  });
  return response.blob();
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** HTMLMediaElement/img 不能自定义 Authorization；GET 媒体 URL 使用独立的只读
 * media capability。它不能访问通用 GET 或任何控制/写接口。 */
function authenticatedGetUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.set("kdj_media_token", bridge().mediaToken);
  return url.toString();
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

interface YtmProtectedIdentity {
  visitor_data: string;
  data_sync_id: string;
  gvs_binding: "video_id" | "data_sync_id" | "visitor_data";
}

interface YoutubeHlsBegin extends YtmProtectedIdentity {
  preparation_id: string;
  n_challenge: string;
  player_url: string;
}

const playerScripts = new Map<string, Promise<string>>();

function loadYoutubePlayerScript(route: string, playerUrl: string): Promise<string> {
  const key = `${route}:${playerUrl}`;
  let pending = playerScripts.get(key);
  if (!pending) {
    pending = post<string>(route, { player_url: playerUrl }).catch((error) => {
      playerScripts.delete(key);
      throw error;
    });
    playerScripts.set(key, pending);
  }
  return pending;
}

async function exactYtmPlayerScript(
  requestedPlayerUrl: string,
  requestedJavascript: string,
  responsePlayerUrl: string,
): Promise<string> {
  if (responsePlayerUrl === requestedPlayerUrl) return requestedJavascript;
  return loadYoutubePlayerScript("/song/preview/ytm/player-script", responsePlayerUrl);
}

async function prepareYoutubeVideoPreview(bvid: string, maxHeight?: number): Promise<string> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(bvid)) throw new Error("YouTube 视频 ID 无效");
  const begun = await post<YoutubeHlsBegin>("/video/youtube/hls/begin", {
    bvid,
    user_agent: YOUTUBE_HLS_USER_AGENT,
    max_height: maxHeight,
  });
  if (!/^[A-Fa-f0-9]{64}$/.test(begun.preparation_id)) {
    throw new Error("YouTube HLS 准备标识无效");
  }
  const [gvsPoToken, nValue] = await Promise.all([
    mintNativeYoutubeGvsPoToken(youtubeGvsBindingValue(bvid, begun)),
    begun.n_challenge
      ? loadYoutubePlayerScript("/video/youtube/player-script", begun.player_url)
          .then((javascript) => transformNativeYoutubeN(
            begun.n_challenge,
            begun.player_url,
            javascript,
          ))
      : Promise.resolve(""),
  ]);
  const prepared = await post<{ path: string }>("/video/youtube/hls/complete", {
    preparation_id: begun.preparation_id,
    n_value: nValue,
    gvs_po_token: gvsPoToken,
  });
  if (!/^\/api\/video\/youtube\/hls\/[A-Fa-f0-9]{64}$/.test(prepared.path)) {
    throw new Error("YouTube HLS 播放地址无效");
  }
  return authenticatedGetUrl(new URL(prepared.path, bridge().baseUrl).toString());
}

function youtubeHlsTicket(rawUrl: string): string {
  const url = new URL(rawUrl);
  const base = new URL(bridge().baseUrl);
  const match = url.pathname.match(/^\/api\/video\/youtube\/hls\/([A-Fa-f0-9]{64})$/);
  if (url.origin !== base.origin || !match) throw new Error("YouTube HLS 本地票据无效");
  return match[1];
}

async function startYoutubeVideoPlayback(preparedUrl: string): Promise<string> {
  const sourceTicket = youtubeHlsTicket(preparedUrl);
  const session = await post<{ path: string }>(
    `/video/youtube/hls/${sourceTicket}/session`,
  );
  if (!/^\/api\/video\/youtube\/hls\/[A-Fa-f0-9]{64}$/.test(session.path)) {
    throw new Error("YouTube HLS 播放会话无效");
  }
  return authenticatedGetUrl(new URL(session.path, bridge().baseUrl).toString());
}

async function revokeYoutubeVideoPlayback(playbackUrl: string): Promise<void> {
  const ticket = youtubeHlsTicket(playbackUrl);
  const result = await post<{ revoked: boolean }>(`/video/youtube/hls/${ticket}/revoke`);
  if (!result.revoked) throw new Error("YouTube HLS 播放会话没有被撤销");
}

function youtubeGvsBindingValue(videoId: string, identity: YtmProtectedIdentity): string {
  const binding = identity.gvs_binding === "video_id"
    ? videoId
    : identity.gvs_binding === "data_sync_id"
      ? identity.data_sync_id
      : identity.visitor_data;
  if (!binding || binding.length > 4_096) throw new Error("YouTube GVS 绑定值不可用");
  return binding;
}

type PendingDownloadPreparation =
  | {
      kind: "audio";
      id: string;
      attempt: number;
      platform: Platform;
      source: SongSource;
      quality: Quality;
    }
  | {
      kind: "video";
      id: string;
      attempt: number;
      platform: Platform;
      request: VideoDownloadRequest;
    };

const YTM_GVS_RANGE_CHUNK_BYTES = 10 * 1024 * 1024;
const YTM_GVS_MAX_PROOFS = 64;

export function ytmGvsProofCount(rawUrl: string): number {
  const length = Number(new URL(rawUrl).searchParams.get("clen"));
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error("YouTube Music 播放流缺少有效媒体长度");
  }
  const count = Math.ceil(length / YTM_GVS_RANGE_CHUNK_BYTES);
  if (count > YTM_GVS_MAX_PROOFS) {
    throw new Error("YouTube Music 媒体过大，无法建立完整下载会话");
  }
  return count;
}

function ytmGvsStreamFingerprint(rawUrl: string): string {
  const url = new URL(rawUrl);
  return ["clen", "mime", "itag"]
    .map((key) => `${key}=${url.searchParams.get(key) ?? ""}`)
    .join("&");
}

async function resolveYtmProtectedStream(
  source: SongSource,
  quality?: Quality,
  knownIdentity?: YtmProtectedIdentity,
  forceFreshProof = false,
): Promise<{ poToken: string; poTokens: string[]; resolvedUrl: string; resolvedUrls: string[] }> {
  const videoId = source.payload?.video_id;
  if (source.platform !== "ytm" || typeof videoId !== "string") {
    throw new Error("YouTube Music 歌曲缺少视频 ID");
  }
  const identity = knownIdentity ?? await request<YtmProtectedIdentity>(
    "/song/preview/ytm/identity",
    { cache: "no-store" },
  );
  const binding = youtubeGvsBindingValue(videoId, identity);
  const playerUrl = await request<string>("/song/preview/ytm/player-url", {
    cache: "no-store",
  });
  const javascript = await loadYoutubePlayerScript(
    "/song/preview/ytm/player-script",
    playerUrl,
  );
  const playerConfig = await nativeYoutubePlayerConfig(playerUrl, javascript);
  const resolvePlayerStream = async (): Promise<string> => {
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
    const responseJavascript = await exactYtmPlayerScript(
      playerUrl,
      javascript,
      protectedPlayer.player_url,
    );
    return decipherNativeYoutubeUrl(
      protectedPlayer.signature_cipher,
      protectedPlayer.player_url,
      responseJavascript,
    );
  };
  const firstRawUrl = await resolvePlayerStream();
  const proofCount = ytmGvsProofCount(firstRawUrl);
  const fingerprint = ytmGvsStreamFingerprint(firstRawUrl);
  const poTokens: string[] = [];
  const resolvedUrls: string[] = [];
  for (let index = 0; index < proofCount; index += 1) {
    // 每个有界 GVS 请求都使用新的 Player URL、proof 和 cpn。只复用同一个
    // BotGuard minter；不能把一次签名上下文里的媒体 URL 横跨多个请求使用。
    const rawUrl = index === 0 ? firstRawUrl : await resolvePlayerStream();
    if (ytmGvsStreamFingerprint(rawUrl) !== fingerprint) {
      throw new Error("YouTube Music 分段授权返回了不同的音频流");
    }
    const poToken = await mintNativeYoutubeGvsPoToken(
      binding,
      forceFreshProof && index === 0,
    );
    const resolved = new URL(rawUrl);
    resolved.searchParams.set("pot", poToken);
    poTokens.push(poToken);
    resolvedUrls.push(appendClientPlaybackNonce(resolved.toString()));
  }
  return {
    poToken: poTokens[0],
    poTokens,
    resolvedUrl: resolvedUrls[0],
    resolvedUrls,
  };
}

async function resolveYtmSabrPlayback(
  source: SongSource,
  forceFreshProof = false,
): Promise<YoutubeSabrBootstrap> {
  const videoId = source.payload?.video_id;
  if (source.platform !== "ytm" || typeof videoId !== "string") {
    throw new Error("YouTube Music 歌曲缺少视频 ID");
  }
  const identity = await request<YtmProtectedIdentity>(
    "/song/preview/ytm/identity",
    { cache: "no-store" },
  );
  const gvsPoToken = await mintNativeYoutubeGvsPoToken(
    youtubeGvsBindingValue(videoId, identity),
    forceFreshProof,
  );
  const playerUrl = await request<string>("/song/preview/ytm/player-url", {
    cache: "no-store",
  });
  const javascript = await loadYoutubePlayerScript(
    "/song/preview/ytm/player-script",
    playerUrl,
  );
  const playerConfig = await nativeYoutubePlayerConfig(playerUrl, javascript);
  const player = await post<{
    player_url: string;
    sabr_url?: string;
    video_playback_ustreamer_config?: string;
    sabr_formats: unknown[];
    sabr_audio_itag: number;
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
    || !Number.isSafeInteger(player.sabr_audio_itag)
    || player.sabr_audio_itag <= 0
    || !Number.isSafeInteger(player.duration_ms)
    || player.duration_ms <= 0
  ) {
    throw new Error("YouTube Music Player 没有返回 SABR 音频会话");
  }
  const responseJavascript = await exactYtmPlayerScript(
    playerUrl,
    javascript,
    player.player_url,
  );
  return {
    serverAbrStreamingUrl: await decipherNativeYoutubeUrl(
      player.sabr_url,
      player.player_url,
      responseJavascript,
    ),
    videoPlaybackUstreamerConfig: player.video_playback_ustreamer_config,
    formats: player.sabr_formats,
    audioItag: player.sabr_audio_itag,
    durationMs: player.duration_ms,
    poToken: gvsPoToken,
  };
}

let ytmPlaybackPrewarm: Promise<void> | null = null;

async function prewarmYtmPlayback(): Promise<void> {
  if (!YOUTUBE_NATIVE_PROOF_SUPPORTED) return;
  if (ytmPlaybackPrewarm) return ytmPlaybackPrewarm;
  ytmPlaybackPrewarm = (async () => {
    const playerUrlPromise = request<string>("/song/preview/ytm/player-url", {
      cache: "no-store",
    });
    await Promise.all([
      request<YtmProtectedIdentity>("/song/preview/ytm/identity", { cache: "no-store" }),
      // Warm only the expensive BotGuard environment. A real video id here would cache/cross a
      // content context before either YouTube or YouTube Music has begun its signed playback.
      mintNativeYoutubeGvsPoToken("KDJ-proof-minter-prewarm-v1"),
      playerUrlPromise.then(async (playerUrl) => nativeYoutubePlayerConfig(
        playerUrl,
        await loadYoutubePlayerScript("/song/preview/ytm/player-script", playerUrl),
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
) => Promise<
  | { proofs: string[]; resolved_urls: string[] }
  | { youtube_hls_ticket: string }
>;

/** 平台挑战只在这个注册表里注入；下载 store、面板和按钮不再识别平台。 */
const downloadPreparationHandlers: Partial<Record<Platform, DownloadPreparationHandler>> = {
  ytm: async (item, context, forceFreshProof = false) => {
    if (item.kind !== "audio") throw new Error("YouTube Music 下载任务形状无效");
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
    );
    return { proofs: stream.poTokens, resolved_urls: stream.resolvedUrls };
  },
  youtube: async (item) => {
    if (item.kind !== "video") throw new Error("YouTube 视频下载任务形状无效");
    const videoId = item.request.bvid?.trim() || "";
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      throw new Error("YouTube 视频下载缺少有效视频 ID");
    }
    const preparedUrl = await prepareYoutubeVideoPreview(
      videoId,
      item.request.max_height,
    );
    return { youtube_hls_ticket: youtubeHlsTicket(preparedUrl) };
  },
};

const activeDownloadPreparations = new Map<string, Promise<void>>();

async function prepareDownloadItem(
  item: PendingDownloadPreparation,
  context: DownloadPreparationContext,
): Promise<void> {
  const preparationKey = `${item.id}:${item.attempt}`;
  const existing = activeDownloadPreparations.get(preparationKey);
  if (existing) return existing;
  const running = (async () => {
    let preparedYoutubeTicket = "";
    try {
      const handler = downloadPreparationHandlers[item.platform];
      if (!handler) throw new Error("平台 " + item.platform + " 没有注册下载准备适配器");
      let prepared = await handler(item, context);
      if ("youtube_hls_ticket" in prepared) {
        preparedYoutubeTicket = prepared.youtube_hls_ticket;
      }
      try {
        await post(`/downloads/${encodeURIComponent(item.id)}/prepared-source`, {
          ...prepared,
          attempt: item.attempt,
        });
      } catch (error) {
        const retryableYtmSession = item.platform === "ytm"
          && error instanceof ApiError
          && [401, 403, 502].includes(error.status);
        if (!retryableYtmSession) throw error;
        // 与其他下载的“重试”语义相同：整条受保护来源作废，重新取身份、Player URL
        // 和每一段 proof；绝不把部分旧会话与新会话拼在一起。
        prepared = await handler(item, context, true);
        await post(`/downloads/${encodeURIComponent(item.id)}/prepared-source`, {
          ...prepared,
          attempt: item.attempt,
        });
      }
    } catch (error) {
      if (preparedYoutubeTicket) {
        await post(`/video/youtube/hls/${preparedYoutubeTicket}/revoke`).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      await post(`/downloads/${encodeURIComponent(item.id)}/preparation-failed`, {
        attempt: item.attempt,
        error: message,
      }).catch(() => undefined);
      throw error;
    }
  })();
  activeDownloadPreparations.set(preparationKey, running);
  try {
    await running;
  } finally {
    if (activeDownloadPreparations.get(preparationKey) === running) {
      activeDownloadPreparations.delete(preparationKey);
    }
  }
}

async function preparePendingDownloads(onlyId?: string): Promise<void> {
  const pending = await request<PendingDownloadPreparation[]>("/downloads/preparations/pending", {
    cache: "no-store",
  });
  const selected = onlyId ? pending.filter((item) => item.id === onlyId) : pending;
  if (selected.length === 0) return;
  const context: DownloadPreparationContext = {};
  let firstError: unknown = null;
  // 原生 proof 按队列顺序串行；真正的媒体传输仍由后端按统一并发设置调度。
  for (const item of selected) {
    try {
      await prepareDownloadItem(item, context);
    } catch (error) {
      firstError ??= error;
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
  activityLogs: (category: ActivityLogCategory, limit = 160) =>
    request<ActivityLogOverview>(
      `/activity/logs?category=${encodeURIComponent(category)}&limit=${limit}`,
      { cache: "no-store" },
    ),
  activityLogSettings: () => request<ActivityLogSettings>("/activity/settings"),
  updateActivityLogSettings: (settings: ActivityLogSettings) =>
    request<ActivityLogSettings>("/activity/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  clearActivityLogs: () => request<void>("/activity/logs", { method: "DELETE" }),
  cacheOverview: () => request<CacheOverview>("/cache", { cache: "no-store" }),
  clearCacheCategory: (category: CacheCategory) =>
    request<CacheOverview>(`/cache/${category}`, { method: "DELETE" }),

  accounts: () => request<Account[]>("/accounts"),
  cachedAccounts: () => request<Account[]>("/accounts/cached"),
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
  cacheLibraryLyrics: (trackId: number, lyrics: LyricsResponse) =>
    request<LocalLyricsResponse>(`/library/lyrics/${trackId}`, {
      method: "PUT",
      body: JSON.stringify(lyrics),
    }),
  /**
   * 歌曲试听代理（使用设置中的试听音质，不下载）。整个 SongSource 发过去：
   * QQ 的 media_mid、SoundCloud 的 transcoding_url 都在 payload 里。
   */
  songPreview: async (source: SongSource, bypassCache = false) => {
    if (source.platform === "ytm") {
      const bootstrap = await resolveYtmSabrPlayback(source, bypassCache);
      const { createYoutubeSabrPreview } = await import("./youtubeSabr");
      return createYoutubeSabrPreview(source, bootstrap, bypassCache);
    }
    const result = await post<{ url: string; cached?: boolean; waveform_token?: string }>("/song/preview", {
      source,
      bypass_cache: bypassCache,
    });
    if (!result.url.startsWith("/")) return result;
    return { ...result, url: authenticatedGetUrl(bridge().baseUrl + result.url) };
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
    const started = await post<{ started: boolean; retried: number }>("/downloads/start");
    // worker 先按统一并发闸门进入 authorizing，外部准备才有资格开始。后续排到
    // 闸门的任务由 download.updated 事件触发，不会提前偷跑媒体传输。
    void preparePendingDownloads().catch(() => undefined);
    return started;
  },
  pauseDownloads: () => post<{ paused: number }>("/downloads/pause"),
  cancelDownload: (id: string) => post<DownloadTask>(`/downloads/${id}/cancel`),
  cancelAllDownloads: () => post<{ canceled: number }>("/downloads/cancel-all"),
  retryDownload: async (id: string) => {
    const task = await post<DownloadTask>(`/downloads/${id}/retry`);
    void preparePendingDownloads(id).catch(() => undefined);
    return task;
  },
  updateDownloadQuality: (id: string, quality: Quality) =>
    post<DownloadTask>(`/downloads/${id}/quality`, { quality }),
  updateDownloadHeight: (id: string, maxHeight: number) =>
    post<DownloadTask>(`/downloads/${id}/height`, { max_height: maxHeight }),
  /** 只移除一条已结束的队列记录，避免「清空」影响其他历史任务。 */
  removeDownload: (id: string) => request<{ removed: boolean }>(`/downloads/${id}`, { method: "DELETE" }),
  clearDownloads: () => post<{ removed: number }>("/downloads/clear"),

  videoResolve: (url: string, platform?: "bilibili" | "youtube") =>
    post<VideoInfo>("/video/resolve", { url, platform }),
  videoDownload: async (body: VideoDownloadRequest) => {
    const task = await post<DownloadTask>("/video/download", body);
    // 自动下载开启时 worker 会立即进入 authorizing；关闭时查询为空，不会准备。
    void preparePendingDownloads(task.id).catch(() => undefined);
    return task;
  },
  videoCalibrate: (trackId: number, bvid: string, page = 0) =>
    post<{ offset_ms: number; score: number }>("/video/calibrate", {
      track_id: trackId,
      bvid,
      page,
    }),
  prepareYoutubeVideoPreview: (bvid: string, maxHeight?: number) =>
    prepareYoutubeVideoPreview(bvid, maxHeight),
  startYoutubeVideoPlayback: (preparedUrl: string) =>
    startYoutubeVideoPlayback(preparedUrl),
  revokeYoutubeVideoPlayback: (playbackUrl: string) =>
    revokeYoutubeVideoPlayback(playbackUrl),
  /** 平台视频预览流；鉴权、防盗链与 Range 刷新由对应 VideoProvider 处理。 */
  videoPreviewUrl: (
    platform: "bilibili" | "youtube",
    bvid: string,
    page = 0,
    track: "muxed" | "video" | "audio" = "muxed",
  ) => {
    const { baseUrl } = bridge();
    const query = new URLSearchParams({ platform, bvid, page: String(page), track });
    return authenticatedGetUrl(`${baseUrl}/api/video/preview?${query}`);
  },

  tracks: (params: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return request<TrackPage>(`/library/tracks${suffix ? `?${suffix}` : ""}`);
  },
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
    version: "v1" | "v2" | "v3" = "v1",
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
    background = false,
    intent: "visible" | "player" | "prefetch" = "visible",
    requestId = 0,
    signal?: AbortSignal,
  ) =>
    requestWaveform(
      `/library/waveform/${id}?buckets=${buckets}&profile=${profile}&format=binary&intent=${intent}&request_id=${requestId}${background ? "&background=true" : ""}`,
      profile,
      signal,
    ),
  /** Advance a latest-wins waveform lane even when the requested track is already in JS memory. */
  waveformIntent: (
    id: number,
    intent: "player" | "prefetch",
    requestId: number,
  ) =>
    request<void>(
      `/library/waveform/${id}?profile=release-overview&intent=${intent}&request_id=${requestId}&intent_only=true`,
    ),
  harmonic: (id: number, tolerance = 12, limit = 60, folder = "") =>
    request<HarmonicMatch[]>(
      `/library/harmonic/${id}?bpm_tolerance=${tolerance}&limit=${limit}` +
        (folder ? `&folder=${encodeURIComponent(folder)}` : ""),
    ),
  /** 没有本地曲库 id 的临时曲目，直接用完整分析得到的 BPM/Camelot 匹配本地候选。 */
  harmonicProfile: (
    track: Pick<Track, "bpm" | "camelot">,
    tolerance = 12,
    limit = 60,
    folder = "",
  ) =>
    post<HarmonicMatch[]>("/library/harmonic", {
      bpm: track.bpm,
      camelot: track.camelot,
      bpm_tolerance: tolerance,
      limit,
      wide: true,
      folder,
    }),
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
  /** 真正请求平台服务器移除；成功响应前不改前端目录。 */
  removeStreamPlaylistTrack: (playlist: StreamPlaylist, source: SongSource) =>
    post<StreamPlaylistTrackRemoveResponse>("/stream/playlist/remove-track", {
      platform: playlist.platform,
      key: playlist.key,
      source,
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
    return authenticatedGetUrl(`${baseUrl}/api/library/audio/${id}`);
  },
  videoUrl: (id: number, compatible = false) => {
    const { baseUrl } = bridge();
    return authenticatedGetUrl(
      `${baseUrl}/api/library/video/${id}${compatible ? "?compat=true" : ""}`,
    );
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
    return authenticatedGetUrl(`${baseUrl}/api/library/cover/${id}${suffix}`);
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
    const { baseUrl, authToken } = bridge();
    const url = `${baseUrl.replace(/^http/, "ws")}/ws`;
    const socket = new WebSocket(url, ["kdj-v1", `kdj-auth.${authToken}`]);
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
