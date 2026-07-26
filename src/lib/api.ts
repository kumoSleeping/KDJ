/**
 * sidecar 客户端。所有网络访问都必须走这里，组件里不要出现裸 fetch。
 */

import type {
  Account,
  AnalyzeResponseLike,
  DownloadRequest,
  DownloadTask,
  FileOp,
  FolderOpResult,
  FolderTree,
  HarmonicMatch,
  Health,
  IntakeRequest,
  IntakeResponse,
  LibraryStats,
  QrSession,
  QrState,
  ResolveResponse,
  ScanResponseLike,
  SearchRequest,
  SearchResponse,
  Settings,
  Track,
  TrackPage,
  TrackPatch,
  VideoDownloadRequest,
  VideoInfo,
  Waveform,
  WsEvent,
} from "../types";

const bridge = () => window.kumodeck;

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
  const { baseUrl, token } = bridge();
  const headers = new Headers(init.headers);
  headers.set("X-KumoDeck-Token", token);
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

  search: (body: SearchRequest) => post<SearchResponse>("/search", body),
  resolve: (url: string, limit = 500) => post<ResolveResponse>("/resolve", { url, limit }),
  intake: (body: IntakeRequest) => post<IntakeResponse>("/intake", body),

  downloads: () => request<DownloadTask[]>("/downloads"),
  enqueue: (body: DownloadRequest) => post<DownloadTask[]>("/downloads", body),
  cancelDownload: (id: string) => post<DownloadTask>(`/downloads/${id}/cancel`),
  clearDownloads: () => post<{ removed: number }>("/downloads/clear"),

  videoResolve: (url: string) => post<VideoInfo>("/video/resolve", { url }),
  videoDownload: (body: VideoDownloadRequest) => post<DownloadTask>("/video/download", body),

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
    request<Track>(`/library/tracks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTrack: (id: number, deleteFile = false) =>
    request<{ ok: boolean }>(`/library/tracks/${id}?delete_file=${deleteFile}`, { method: "DELETE" }),
  scan: (paths: string[], analyze = false) =>
    post<ScanResponseLike>("/library/scan", { paths, recursive: true, analyze }),
  analyze: (trackIds: number[] | null, force = false, priority = false) =>
    post<AnalyzeResponseLike>("/library/analyze", { track_ids: trackIds, force, priority }),
  cancelAnalyze: (jobId = "") =>
    post<{ canceled: number; remaining: number }>(
      `/library/analyze/cancel${jobId ? `?job_id=${encodeURIComponent(jobId)}` : ""}`,
    ),
  writeTags: (id: number) => post<Track>(`/library/tracks/${id}/write-tags`),
  waveform: (id: number, buckets = 640) =>
    request<Waveform>(`/library/waveform/${id}?buckets=${buckets}`),
  harmonic: (id: number, tolerance = 12, limit = 60) =>
    request<HarmonicMatch[]>(`/library/harmonic/${id}?bpm_tolerance=${tolerance}&limit=${limit}`),
  stats: () => request<LibraryStats>("/library/stats"),

  folders: () => request<FolderTree>("/library/folders"),
  createFolder: (parent: string, name: string) =>
    post<FolderTree>("/library/folders/create", { parent, name }),
  renameFolder: (path: string, name: string) =>
    post<FolderTree>("/library/folders/rename", { path, name }),
  deleteFolder: (path: string) => post<FolderTree>("/library/folders/delete", { path }),
  initFolders: (path = "") => post<FolderTree>("/library/folders/init", { path }),
  moveFolder: (path: string, destParent: string) =>
    post<FolderTree>("/library/folders/move", { path, dest_parent: destParent }),
  orderFolder: (path: string, names: string[]) =>
    post<FolderTree>("/library/folders/order", { path, names }),
  applyFolderOp: (trackIds: number[], dest: string, op: FileOp) =>
    post<FolderOpResult>("/library/folders/apply", { track_ids: trackIds, dest, op }),

  audioUrl: (id: number) => {
    const { baseUrl, token } = bridge();
    return `${baseUrl}/api/library/audio/${id}?token=${encodeURIComponent(token)}`;
  },
  coverUrl: (id: number) => {
    const { baseUrl, token } = bridge();
    return `${baseUrl}/api/library/cover/${id}?token=${encodeURIComponent(token)}`;
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
    const { baseUrl, token } = bridge();
    const url = `${baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
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
