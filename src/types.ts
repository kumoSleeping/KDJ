/**
 * 前后端契约（对应 sidecar/kumodeck/models.py）。
 * 改这里必须同步改 models.py 和 docs/00-architecture.md。
 */

export type Platform = "wyy" | "qqm" | "soundcloud" | "bilibili" | "local";
export type Quality = "flac" | "320" | "128";
export type TaskState = "queued" | "running" | "done" | "failed" | "canceled";
export type AccountState = "missing" | "valid" | "expired" | "unknown";
export type QrStateValue = "waiting" | "scanned" | "done" | "expired" | "refused" | "error";

export interface Health {
  ok: boolean;
  version: string;
  ffmpeg: boolean;
  data_dir: string;
  download_dir: string;
}

export interface Settings {
  download_dir: string;
  library_dirs: string[];
  default_quality: Quality;
  filename_template: string;
  concurrent_downloads: number;
  auto_analyze: boolean;
  write_tags_after_analyze: boolean;
  analysis_duration: number;
  theme: "light" | "dark" | "system";
  soundcloud_enabled: boolean;
  netease_use_download_api: boolean;
  video_max_height: number;
  video_transcode: boolean;
  /** 视频单独的下载目录，和音乐分开。 */
  video_download_dir: string;
  video_format: VideoFormat;
  /** 平台按钮显示顺序 = 下载来源优先级（拖动排序的结果）。 */
  platform_priority: string[];
  /** 入队后是否立刻开始下载；关着就攒在队列里等这个开关拨开。 */
  auto_start_downloads: boolean;
}

export type VideoFormat = "mp4" | "mkv" | "mov";

export interface Account {
  platform: Platform;
  label: string;
  state: AccountState;
  nickname: string;
  avatar: string;
  detail: string;
  /** false = 该平台没有扫码登录（SoundCloud 走 yt-dlp），前端不要显示登录按钮。 */
  supports_login: boolean;
}

export interface QrSession {
  platform: Platform;
  session_id: string;
  image: string;
  url: string;
  expires_in: number;
}

export interface QrState {
  session_id: string;
  state: QrStateValue;
  message: string;
  account: Account | null;
}

export interface SongSource {
  platform: Platform;
  key: string;
  title: string;
  artists: string[];
  album: string;
  duration: number | null;
  cover: string;
  max_quality: Quality | null;
  vip: boolean;
  payload: Record<string, unknown>;
}

export interface MergedGroup {
  group_id: string;
  title: string;
  artists: string[];
  album: string;
  duration: number | null;
  cover: string;
  sources: SongSource[];
  best_source_index: number;
  score: number;
  in_library: boolean;
}

export interface SearchRequest {
  query: string;
  platforms: Platform[];
  limit: number;
  merge: boolean;
}

export interface SearchResponse {
  query: string;
  groups: MergedGroup[];
  per_platform: Record<string, SongSource[]>;
  errors: Record<string, string>;
  elapsed_ms: number;
}

export interface ResolveResponse {
  kind: "song" | "playlist" | "album" | "unknown";
  platform: Platform;
  title: string;
  sources: SongSource[];
}

export type IntakeKind = "search" | "song" | "playlist" | "album" | "unknown" | "error";

export interface IntakeRequest {
  text: string;
  platforms: Platform[];
  limit: number;
  merge: boolean;
  max_entries?: number;
}

export interface IntakeItem {
  /** 拆出来的原始文本（链接或关键词）。 */
  entry: string;
  kind: IntakeKind;
  platform: Platform | null;
  title: string;
  groups: MergedGroup[];
  errors: Record<string, string>;
  error: string;
}

export interface IntakeResponse {
  items: IntakeItem[];
  /** 超过 max_entries 被丢掉的条数。 */
  skipped: number;
  elapsed_ms: number;
}

export interface DownloadRequest {
  sources: SongSource[];
  quality?: Quality | null;
  analyze?: boolean | null;
}

export interface DownloadTask {
  id: string;
  kind: "audio" | "video";
  platform: Platform;
  title: string;
  artist: string;
  quality: string;
  state: TaskState;
  progress: number;
  downloaded_bytes: number;
  total_bytes: number;
  speed_bps: number;
  path: string;
  error: string;
  track_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface VideoPage {
  index: number;
  title: string;
  duration: number;
}

export interface VideoStreamOption {
  quality_id: number;
  label: string;
  height: number;
  codec: string;
}

export interface VideoInfo {
  bvid: string;
  title: string;
  author: string;
  cover: string;
  duration: number;
  pages: VideoPage[];
  options: VideoStreamOption[];
  logged_in: boolean;
}

export interface VideoDownloadRequest {
  url?: string;
  bvid?: string;
  page_index?: number;
  max_height?: number;
  audio_only?: boolean;
  transcode?: boolean;
}

export interface Track {
  id: number;
  path: string;
  filename: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: string;
  duration: number | null;
  bitrate: number | null;
  samplerate: number | null;
  channels: number | null;
  format: string;
  size: number;
  bpm: number | null;
  bpm_confidence: number | null;
  first_beat: number | null;
  music_key: string;
  camelot: string;
  open_key: string;
  key_confidence: number | null;
  energy: number | null;
  rms_db: number | null;
  peak_db: number | null;
  rating: number;
  color: string;
  comment: string;
  cue_ms: number | null;
  source_platform: string;
  source_key: string;
  analyzed_at: string | null;
  added_at: string;
  modified_at: string;
  analysis_error: string;
  tags: string[];
  /** 所在目录（path 的父目录）。文件夹树按它归位。 */
  folder: string;
  /** ""=普通文件；"hardlink"/"symlink"=和别处共用同一份数据。 */
  link: string;
}

export interface FolderNode {
  path: string;
  name: string;
  parent: string;
  /** 直接躺在这个目录下的曲目数。 */
  track_count: number;
  /** 含所有子目录的曲目数。 */
  total_count: number;
  /** 这一层目录里实际躺着几个音频文件。> track_count = 还没扫进曲库。 */
  file_count: number;
  /** 含子目录的未入库文件数。 */
  pending_count: number;
  children: FolderNode[];
  is_root: boolean;
  /** 目录里有 .kumodeck.json（顺序已受管）；false = 还没初始化，按名字排。 */
  managed: boolean;
}

export interface FolderTree {
  roots: FolderNode[];
  /** 落在所有曲库根目录之外的曲目数。 */
  outside: number;
}

export type FileOp = "move" | "link";

export interface FolderOpResult {
  /** move：被改了路径的曲目；link：新建出来的曲目。 */
  track_ids: number[];
  op: FileOp;
  /** 实际用的方式统计，如 {"hardlink": 3, "copy": 1}。 */
  methods: Record<string, number>;
  errors: Record<string, string>;
}

export interface TrackPage {
  items: Track[];
  total: number;
  offset: number;
  limit: number;
}

export interface TrackPatch {
  rating?: number;
  color?: string;
  comment?: string;
  cue_ms?: number;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  tags?: string[];
}

export interface ScanResponseLike {
  job_id: string;
  found: number;
}

export interface AnalyzeResponseLike {
  job_id: string;
  queued: number;
}

export interface Waveform {
  track_id: number;
  duration: number;
  /** 每一列的 0..1 幅度（柱子高度），等分整轨。 */
  amp: number[];
  /** 每一列的颜色，0..255，长度和 amp 相同。红=低频/鼓、绿=中频/人声、蓝=高频/镲。 */
  r: number[];
  g: number[];
  b: number[];
}

export interface HarmonicMatch {
  track: Track;
  relation:
    | "same"
    | "energy_up"
    | "energy_down"
    | "relative"
    | "energy_boost"
    | "two_step"
    | "diagonal";
  relation_label: string;
  bpm_delta: number;
  tempo_ratio: number;
  score: number;
}

export interface LibraryStats {
  total: number;
  analyzed: number;
  total_duration: number;
  total_size: number;
  by_camelot: Record<string, number>;
  by_bpm_bucket: Record<string, number>;
  by_platform: Record<string, number>;
}

/* ---------------------------------------------------------------- WS 事件 */

export interface ScanProgress {
  job_id: string;
  done: number;
  total: number;
  current: string;
  phase: "walk" | "tag" | "done";
}

export interface AnalyzeProgress {
  job_id: string;
  done: number;
  total: number;
  current: string;
  track_id: number | null;
}

export interface ToastPayload {
  level: "info" | "warn" | "error";
  text: string;
}

export type WsEvent =
  | { type: "download.updated"; payload: DownloadTask }
  | { type: "download.list"; payload: DownloadTask[] }
  | { type: "scan.progress"; payload: ScanProgress }
  | { type: "analyze.progress"; payload: AnalyzeProgress }
  | { type: "library.updated"; payload: { track_ids: number[] } }
  | { type: "account.changed"; payload: Account }
  | { type: "toast"; payload: ToastPayload };

/* ---------------------------------------------------------------- preload */

export interface KumoDeckBridge {
  baseUrl: string;
  token: string;
  platform: NodeJS.Platform | string;
  openPath: (path: string) => Promise<void>;
  revealPath: (path: string) => Promise<void>;
  pickFolder: () => Promise<string | null>;
  pickFolders: () => Promise<string[]>;
  windowControl: (action: "minimize" | "maximize" | "close") => void;
  onSidecarLog: (cb: (line: string) => void) => () => void;
}

declare global {
  interface Window {
    kumodeck: KumoDeckBridge;
  }
}
