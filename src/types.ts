/**
 * 前后端契约（Rust 侧对应 crates/kdj-core/src/models.rs）。
 * 改这里必须同步改 models.rs 和 docs/00-architecture.md。
 */

export type Platform = "wyy" | "qqm" | "soundcloud" | "ytm" | "youtube" | "bilibili" | "local";
export type Quality = "flac" | "320" | "128";
export type SearchKind = "song" | "playlist" | "artist" | "album" | "radio";
export type TaskState =
  | "queued"
  | "running"
  | "processing"
  | "paused"
  | "done"
  | "failed"
  | "canceled";
export type TaskPhase =
  | "waiting"
  | "authorizing"
  | "resolving"
  | "downloading"
  | "post_processing"
  | "relocating"
  | "importing"
  | "completed";
export type AccountState = "missing" | "valid" | "expired" | "unknown";
export type QrStateValue = "waiting" | "scanned" | "done" | "expired" | "refused" | "error";

export interface Health {
  ok: boolean;
  version: string;
  ffmpeg: boolean;
  data_dir: string;
  download_dir: string;
  /**
   * 后端跑在哪个系统上（std::env::consts::OS："macos"/"windows"/"linux"/"android"…）。
   * 删除曲目能不能走系统回收站看它——文件在后端那台机器上，问它才作数。
   * 可选：Python sidecar（开发用）的 health 没有这个键。
   */
  platform?: string;
}

/** 删除曲目时怎么处置文件：只删记录 / 移到系统回收站 / 直接删掉。 */
export type FileDisposalMode = "keep" | "trash" | "remove";

export type VideoFormat = "mp4" | "mkv" | "mov";
export type KeyNotation = "camelot" | "traditional";
/** 播放控制面板双极滤波器的共振档位；后端将其映射为稳定的 DSP Q。 */
export type FilterResonance = "low" | "medium" | "high";
export type AutoAnalysisMode = "light" | "full" | "paused";
export type OnlineVideoPlayer = "platform" | "kdj";

export interface Settings {
  download_dir: string;
  library_dirs: string[];
  default_quality: Quality;
  /** 在线流媒体播放请求的起始音质，与下载音质分开。 */
  stream_quality: Quality;
  /** 播放时把完整在线音频流缓存到下载目录下的 .kdj。 */
  stream_cache_enabled: boolean;
  /** 视频在线播放的画质上限，与视频下载画质分开。 */
  video_playback_max_height: number;
  /** 在线 YouTube 预览窗口；本地文件不受影响。 */
  youtube_preview_player: OnlineVideoPlayer;
  /** 在线 B 站预览窗口；本地文件不受影响。 */
  bilibili_preview_player: OnlineVideoPlayer;
  filename_template: string;
  concurrent_downloads: number;
  auto_analyze: boolean;
  /** 自动曲库分析的资源档位；全力仍是有余量的后台策略。 */
  auto_analysis_mode: AutoAnalysisMode;
  /** 旧版兼容字段；下载完成后现在始终缓存可用歌词。 */
  download_lyrics: boolean;
  write_tags_after_analyze: boolean;
  analysis_duration: number;
  theme: "light" | "dark" | "system";
  soundcloud_enabled: boolean;
  netease_use_download_api: boolean;
  video_max_height: number;
  video_transcode: boolean;
  /** 旧版兼容字段；音频与视频现在统一使用 download_dir。 */
  video_download_dir: string;
  video_format: VideoFormat;
  /** 平台按钮显示顺序 = 下载来源优先级（拖动排序的结果）。 */
  platform_priority: string[];
  /** 搜索时勾选的来源平台（点选结果；与排序独立）。 */
  search_platforms: string[];
  /**
   * 设置里开启的下载/搜索源。未开启的在搜索条灰掉。
   * 全新安装默认只有网易云与 QQ；旧配置会按以前勾选情况迁移。
   */
  enabled_platforms: string[];
  /** 入队后是否立刻开始下载；关着就攒在队列里等这个开关拨开。 */
  auto_start_downloads: boolean;
  /** 播放条使用分析波形；关掉时显示常规进度条。 */
  player_waveform: boolean;
  /** Performance 双极滤波器的共振强度。 */
  filter_resonance: FilterResonance;
  /** 曲目列表里的调性表示。 */
  key_notation: KeyNotation;
  /**
   * 只读派生字段（后端 GET/PUT /api/settings 附带）：全新安装的默认下载落点
   * ——系统「下载」目录 + KDJ。「保存到」菜单里的「系统下载」项用它。
   * PUT 回去会被后端忽略，不持久化。
   */
  default_download_dir?: string;
}

export interface StreamCacheStats {
  enabled: boolean;
  path: string;
  files: number;
  bytes: number;
  partial_files: number;
  partial_bytes: number;
  active_writes: number;
}

export type CacheCategory = "media" | "waveform" | "lyrics" | "basic" | "logs";

export interface CacheCategoryStats {
  files: number;
  bytes: number;
  items: number;
  active: number;
  deletable: boolean;
  estimated: boolean;
}

export interface CacheOverview {
  media: CacheCategoryStats;
  waveform: CacheCategoryStats;
  lyrics: CacheCategoryStats;
  basic: CacheCategoryStats;
  logs: CacheCategoryStats;
  other: CacheCategoryStats;
}

export type ActivityLogCategory = "network" | "analysis" | "user";
export type ActivityLogLevel = "info" | "warn" | "error";

export interface ActivityLogEntry {
  id: number;
  timestamp: string;
  category: ActivityLogCategory;
  level: ActivityLogLevel;
  action: string;
  detail?: string;
  target?: string;
  status?: number;
  duration_ms?: number;
  count: number;
}

export interface ActivityLogOverview {
  entries: ActivityLogEntry[];
  network_last_minute: number;
  network_last_hour: number;
  excessive: boolean;
  dropped: number;
}

export interface ActivityLogSettings {
  /** 0 = 不按日期清理；仍受后端总容量安全上限保护。 */
  retention_days: 0 | 1 | 7 | 14 | 30 | 90;
}

export interface Account {
  platform: Platform;
  label: string;
  state: AccountState;
  /** 仅用于本机私人目录缓存隔离的稳定平台账号键，不是登录凭证。 */
  account_key?: string;
  nickname: string;
  avatar: string;
  detail: string;
  /** false = 该平台当前没有可用登录方式，前端不要显示登录入口。 */
  supports_login: boolean;
  /** qr = 扫码，oauth = OAuth，browser = 导入桌面浏览器会话。 */
  login_method?: "qr" | "oauth" | "browser";
  /** anonymous / browser_session / oauth / ytm_oauth：UI 据此展示真实的凭证能力。 */
  credential_kind?: "anonymous" | "browser_session" | "oauth" | "ytm_oauth" | string;
}

export interface BrowserProfile {
  id: string;
  label: string;
  requires_elevation: boolean;
}

export interface BrowserOption {
  id: string;
  label: string;
  profiles: BrowserProfile[];
}

export interface BrowserCatalog {
  supported: boolean;
  platform: string;
  browsers: BrowserOption[];
}

/** 同一登录会话下的一张可选二维码（QQ 音乐会同时给 QQ 音乐 / QQ 两张）。 */
export interface QrVariant {
  id: string;
  label: string;
  image: string;
}

export interface QrSession {
  platform: Platform;
  session_id: string;
  image: string;
  url: string;
  expires_in: number;
  /** 多通道登录时的全部二维码；空/缺省 = 只用 image。 */
  variants?: QrVariant[];
}

export interface QrState {
  session_id: string;
  state: QrStateValue;
  message: string;
  account: Account | null;
}

export interface SoundCloudOAuthStart {
  state: string;
  authorization_url: string;
  expires_in: number;
}

export interface SoundCloudOAuthStatus {
  state: string;
  status: "pending" | "done" | "error" | string;
  message: string;
}

export interface SoundCloudOAuthCallback {
  state: string;
  code: string;
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

export interface LyricsRequest {
  title: string;
  artist?: string;
  duration?: number | null;
  platform?: Platform | null;
  key?: string;
  /** 启用的搜词引擎（顺序=同分偏好）。 */
  engines?: Platform[];
  /** follow | wyy | qqm | ytm */
  prefer?: string;
}

export interface LyricsResponse {
  lrc: string;
  /** 网易云 YRC 逐字时间轴；缺失/空串表示只有行级 LRC。 */
  word_lrc?: string;
  translated_lrc: string;
  romaji_lrc?: string;
  platform: Platform;
  key: string;
  title: string;
  artist: string;
  score: number;
}

export interface LocalLyricsResponse {
  lrc: string;
  /** 网易云 YRC 逐字时间轴；旧缓存没有时为空。 */
  word_lrc?: string;
  translated_lrc: string;
  romaji_lrc: string;
  /** 歌词实际匹配来源，不会改变本地音频自己的来源身份。 */
  platform?: Platform | null;
  key?: string;
  title?: string;
  artist?: string;
  score?: number;
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
}

export interface CollectionResult {
  /** 集合 ID，不是歌曲 ID，必须先展开才能进入下载队列。 */
  kind: Exclude<SearchKind, "song">;
  platform: Platform;
  key: string;
  title: string;
  subtitle: string;
  cover: string;
  count: number;
}

export type SearchCapabilities = Record<string, SearchKind[]>;

export interface SearchRequest {
  query: string;
  platforms: Platform[];
  limit: number;
  merge: boolean;
  kind?: SearchKind;
}

export interface SearchResponse {
  query: string;
  groups: MergedGroup[];
  collections: CollectionResult[];
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

export interface CollectionResolveResponse {
  kind: Exclude<SearchKind, "song">;
  platform: Platform;
  title: string;
  sources: SongSource[];
}

export type IntakeKind =
  | "search"
  | "song"
  | "playlist"
  | "artist"
  | "album"
  | "radio"
  | "unknown"
  | "error";

export interface IntakeRequest {
  text: string;
  platforms: Platform[];
  limit: number;
  merge: boolean;
  max_entries?: number;
  kind?: SearchKind;
}

export interface IntakeItem {
  /** 拆出来的原始文本（链接或关键词）。 */
  entry: string;
  kind: IntakeKind;
  platform: Platform | null;
  title: string;
  groups: MergedGroup[];
  collections: CollectionResult[];
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
  /** 下载完成后挪进这个曲库文件夹；空 = 默认下载目录。 */
  dest_dir?: string;
  /** 忽略全局自动下载，留在队列中等待显式开始。 */
  hold?: boolean;
}

export type DownloadTaskKind = "audio" | "video";

export interface DownloadTask {
  id: string;
  kind: DownloadTaskKind;
  platform: Platform;
  /** 平台公开来源编号；旧后端或旧队列记录可能缺失。 */
  source_key?: string;
  title: string;
  artist: string;
  quality: string;
  state: TaskState;
  /** 与平台无关的执行阶段；UI 不再根据 ytm/qqm/wyy 猜测状态。 */
  phase: TaskPhase;
  progress: number;
  downloaded_bytes: number;
  total_bytes: number;
  speed_bps: number;
  path: string;
  error: string;
  track_id: number | null;
  /** 入队时指定的目标文件夹；前端用来在对应列表画「待下载」行。 */
  dest_dir?: string;
  /** 入队时冻结的实际成品目录；默认下载也必须明确展示。 */
  output_dir?: string;
  /** 仅前端：搜索结果带来的封面 URL，占位行用来避免只剩 BV 号。 */
  cover?: string;
  /** B 站视频当前下载的分 P；旧队列记录或其它平台可能没有。 */
  video_page?: {
    /** 从 0 起。 */
    index: number;
    /** 解析前可能为 0。 */
    count: number;
    title: string;
  } | null;
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
  platform: "bilibili" | "youtube";
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
  platform?: "bilibili" | "youtube";
  url?: string;
  bvid?: string;
  page_index?: number;
  /** 已解析分 P 的展示提示；后端仍会用平台元数据核准。 */
  page_count?: number;
  page_title?: string;
  max_height?: number;
  audio_only?: boolean;
  transcode?: boolean;
  /** 成品起点偏移（毫秒）：正=掐头，负=开头补黑场/静音。见 models.rs。 */
  offset_ms?: number;
  /** 下载完成后挪进这个曲库文件夹；空 = 默认视频目录。 */
  dest_dir?: string;
  /** 搜索结果展示信息：入队立刻用，刷新后仍能从任务列表还原。 */
  title?: string;
  artist?: string;
  cover?: string;
}

export interface StreamPlaylist {
  platform: Exclude<Platform, "local">;
  key: string;
  title: string;
  cover: string;
  count: number;
  is_favorite: boolean;
  /** favorite / created / collected；旧后端缺字段时按未知处理。 */
  origin?: "favorite" | "created" | "collected" | string;
}

export interface StreamPlaylistResponse {
  platform: Exclude<Platform, "local">;
  key: string;
  title: string;
  sources: SongSource[];
}

export interface StreamPlaylistTrackRemoveResponse {
  platform: Exclude<Platform, "local">;
  key: string;
  source_key: string;
  removed: boolean;
}

/** 曲目表长期持有的轻量标量投影；完整拍点、Cue、标签和备注按需读取 Track。 */
export interface TrackSummary {
  id: number;
  path: string;
  filename: string;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
  format: string;
  size: number;
  bpm: number | null;
  bpm_v2?: boolean;
  bpm_v3?: boolean;
  music_key: string;
  camelot: string;
  open_key: string;
  energy: number | null;
  rms_db: number | null;
  peak_db: number | null;
  rating: number;
  source_platform: string;
  source_key: string;
  analyzed_at: string | null;
  /** 文件系统创建时间（Unix 秒）；不支持时由后端回退到修改时间。 */
  file_created_at: number | null;
  added_at: string;
  modified_at: string;
  folder: string;
}

export interface Track extends TrackSummary {
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
  /** 当前展示的 BPM 来自现行 V2 分析结果；旧后端缺字段时按 false。 */
  bpm_v2?: boolean;
  /** 当前展示的 BPM 来自现行 V3 分析结果；旧后端缺字段时按 false。 */
  bpm_v3?: boolean;
  bpm_confidence: number | null;
  first_beat: number | null;
  beat_origin?: number | null;
  /** Raw detected beat markers when the current analyzer exposes them. */
  beat_times?: number[];
  /** Musically classified downbeats; absent/empty means bar semantics are not trustworthy. */
  downbeats?: number[];
  downbeat_confidence?: number | null;
  downbeat_origin?: number | null;
  beat_grid_revision?: string;
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
  /** 结束点（毫秒），与 cue_ms 成对。 */
  end_ms: number | null;
  /** Hot Cue / Memory Cue / Loop。外置曲库读取，本地曲目可在演出准备面编辑。 */
  cue_points?: CuePoint[];
  /** 本地 Cue 是否由 KDJ 显式管理；true 时导出会把清空也同步到目标曲库。 */
  cue_points_managed?: boolean;
  source_platform: string;
  source_key: string;
  analyzed_at: string | null;
  file_created_at: number | null;
  added_at: string;
  modified_at: string;
  analysis_error: string;
  tags: string[];
  /** 所在目录（path 的父目录）。文件夹树按它归位。 */
  folder: string;
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
  /** 目录里有可用的 .kdj/manifest.json（兼容旧 .kdj.json）；false = 按名字排。 */
  managed: boolean;
}

export interface FolderTree {
  roots: FolderNode[];
  /** 落在所有曲库根目录之外的曲目数。 */
  outside: number;
}

export interface DuplicateCandidate {
  track: Track;
  quality_score: number;
  quality_label: string;
}

export interface DuplicateGroup {
  group_id: string;
  confidence: "high" | "possible";
  reason: string;
  keep_id: number;
  candidates: DuplicateCandidate[];
}

export interface DuplicateAnalysisResult {
  all: boolean;
  folders: string[];
  include_subfolders: boolean;
  scanned: number;
  /** 数据库仍有记录、但原路径已经不存在的曲目。 */
  missing_tracks: Track[];
  /** 整个曲库根离线时只警告，不允许按“失效记录”释放。 */
  offline_roots: string[];
  groups: DuplicateGroup[];
}

/** 从软件移出文件夹：摘库记录，不删磁盘。 */
export interface FolderForgetResult {
  removed: number;
  tree: FolderTree;
}

export type FileOp = "move" | "copy";
export type FolderUndoOp = "move" | "copy" | "delete";

export interface FolderUndoStatus {
  available: boolean;
  op: FolderUndoOp | null;
  count: number;
}

export interface FolderOpResult {
  /** move：被改了路径的曲目；copy：新建出来的曲目。 */
  track_ids: number[];
  op: FileOp;
  /** 实际用的方式统计，如 {"copy": 1}。 */
  methods: Record<string, number>;
  errors: Record<string, string>;
  /** 操作完成后的最近一次可撤回状态。 */
  undo: FolderUndoStatus;
}

export interface FolderUndoResponse {
  undone: number;
  track_ids: number[];
  op: FolderUndoOp;
  status: FolderUndoStatus;
  errors: Record<string, string>;
}

export interface TrackPage {
  items: TrackSummary[];
  total: number;
  offset: number;
  limit: number;
}

/** 来自 DJ 曲库标准的只读 Cue；没有 hot_cue 编号时是 Memory Cue。 */
export interface CuePoint {
  id: number;
  hot_cue: number | null;
  start_ms: number;
  /** 有效值表示 Loop 的结束位置；普通 Cue 为 null。 */
  end_ms: number | null;
  color_index: number | null;
  color: string;
  comment: string;
  active_loop: boolean;
}

export interface TrackPatch {
  /** Manual analyzer correction; changes the library BPM without changing current playback tempo. */
  bpm?: number;
  rating?: number;
  color?: string;
  comment?: string;
  cue_ms?: number;
  end_ms?: number;
  /** 整体替换演出 Cue；空数组表示用户显式清空。 */
  cue_points?: CuePoint[];
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  /** 自由文本：文件里可能是 "2021"，也可能是 "2021-05-17"，当数字会把日期截掉。 */
  year?: string;
  tags?: string[];
}

/**
 * PATCH 的返回：就是一条 Track，可能多带一个 `tag_write_error`。
 *
 * 标题/艺人这些字段除了进数据库还要写回文件标签（DJ 软件只认文件里那份），
 * 而文件可能只读或者正被占用。那种情况下数据库改动是保住了的，
 * 只有文件没跟上——必须说出来，不然用户会以为拖进 Rekordbox 也是新的。
 */
export interface TrackPatchResult extends Track {
  tag_write_error?: string;
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
  /** Optional bounded source-time ownership. Arrays represent only this interval, not the song. */
  source_start?: number;
  source_end?: number;
  /** 每一列的 0..1 幅度；v2 二进制由 signed min/max 原地重建。 */
  amp: number[] | Float32Array;
  /** 兼容上下包络；正式 detail 为对称硬柱。旧来源省略时渲染器退回 ±amp。 */
  minimum?: number[] | Float32Array;
  maximum?: number[] | Float32Array;
  /** 每列 0..255 的颜色坐标：低频瞬态 / 中频周期谐波 / 高频瞬态与原频带证据融合。 */
  r: number[] | Uint8Array;
  g: number[] | Uint8Array;
  b: number[] | Uint8Array;
  /** 非 STEM 鼓击核心柱置信度；下采样时用于保留命中柱，而不是额外涂色。 */
  transient?: number[] | Uint8Array;
  /** 渐进生成波形中已经真实分析的列；省略表示所有列均已完成。 */
  known?: boolean[] | Uint8Array;
}

/** 在线缓存已实际解码出的前缀波形。`covered_seconds` 只覆盖从 0 开始的真实 PCM；
 * 前端必须把它投影到整曲的同一段，不能拉伸成完整曲目。 */
export interface StreamWaveformProgress {
  /** 后端支持当前 token 的会话波形；不表示用户开启了持久磁盘缓存。 */
  enabled: boolean;
  waveform: Waveform | null;
  covered_seconds: number;
  revision: number;
  /** 同一份播放代理/持久缓存已经真实落盘的媒体字节。 */
  cached_bytes?: number;
  /** 上游声明的整轨字节数；未知时为 0。 */
  total_bytes?: number;
  complete: boolean;
  active: boolean;
  /** 新后端把媒体缓存和波形解码拆成独立状态；省略时沿用旧 active/complete。 */
  cache_status?: "waiting" | "caching" | "retrying" | "ready" | "failed";
  cache_error?: string;
  waveform_status?: "waiting" | "analyzing" | "partial" | "ready" | "failed";
  waveform_error?: string;
  /** 完整音频分析；旧后端缺字段时前端按尚未提供处理。 */
  analysis_status?: "waiting" | "analyzing" | "ready" | "failed";
  analysis?: StreamAnalysisResult | null;
  analysis_error?: string;
}

/** 在线曲只在完整媒体已由播放器/缓存落盘后返回这份临时分析，不写入曲库。 */
export interface StreamAnalysisResult {
  duration: number;
  bpm: number | null;
  bpm_raw: number | null;
  bpm_confidence: number | null;
  first_beat: number | null;
  beat_times: number[];
  beat_origin?: number | null;
  downbeat_origin?: number | null;
  downbeats?: number[];
  downbeat_confidence?: number | null;
  key: string;
  key_short: string;
  camelot: string;
  open_key: string;
  key_confidence: number | null;
  chroma: number[];
  rms_db: number | null;
  peak_db: number | null;
  crest_db: number | null;
  energy: number | null;
  errors: string[];
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
  /** 当前算法修订已生成 BPM/Key v2 的曲目数。 */
  bpm_key_v2_analyzed?: number;
  /** 仍需由后台渐进回填 BPM/Key v2 的曲目数。 */
  bpm_key_v2_pending?: number;
  bpm_key_v2_revision?: string;
  /** 当前算法修订已生成 BPM/Key v3 的曲目数。 */
  bpm_key_v3_analyzed?: number;
  /** 仍需由后台渐进回填 BPM/Key v3 的曲目数。 */
  bpm_key_v3_pending?: number;
  bpm_key_v3_revision?: string;
  total_duration: number;
  total_size: number;
  /** 旧后端可能不返回；前端缺失时退回原始 1–10 能量。 */
  energy_median?: number | null;
  rms_db_median?: number | null;
  peak_db_median?: number | null;
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
  /**
   * 导入失败的原因，只出现在 `phase === "done"` 的那一条上（成功时是 null）。
   * 中途的进度事件不带这个键——所以是可选的。
   *
   * 存在的理由：`POST /library/scan` 是"起个后台任务"，它的 Promise 早就 resolve 了，
   * 真正的失败发生在之后。没有这个字段的话，失败在界面上和"扫出来 0 首"长得一模一样。
   */
  error?: string | null;
  /** 用户主动取消；旧后端不返回，所以保持可选。 */
  cancelled?: boolean;
}

export interface AnalyzeProgress {
  job_id: string;
  done: number;
  total: number;
  current: string;
  track_id: number | null;
  /** 用户停止了这批分析；旧后端没有该字段，所以保持可选。 */
  cancelled?: boolean;
}

export interface MaintenanceProgress {
  job_id: string;
  kind: "folder_metadata" | "waveform";
  done: number;
  total: number;
  current: string;
  phase: "migrate" | "prepare" | "done";
  error: string | null;
  changed?: number;
  failed?: number;
}

/**
 * 后端仍然会推 `{"type":"toast"}`（EventHub::publish_toast 还在），
 * 但前端已经没有浮层通知了，这条分支故意不在联合类型里：
 * 收到就当没这回事，各 store 的 switch 落到 default 直接忽略。
 */
export type WsEvent =
  | { type: "download.updated"; payload: DownloadTask }
  | { type: "download.list"; payload: DownloadTask[] }
  | { type: "scan.progress"; payload: ScanProgress }
  | { type: "analyze.progress"; payload: AnalyzeProgress }
  | { type: "maintenance.progress"; payload: MaintenanceProgress }
  | { type: "library.updated"; payload: { track_ids: number[] } }
  | { type: "library.folders.updated"; payload: Record<string, never> }
  | { type: "account.changed"; payload: Account };

/* ---------------------------------------------------------------- preload */

/** `saveLoginQr` 的返回：本机落盘路径 + 落在下载还是相册。 */
export interface SavedLoginQr {
  /** 打开用：桌面是真实文件路径；安卓是 content URI。 */
  path: string;
  /** 给用户看的路径（安卓 MediaStore 时有；没有就退化成 path）。 */
  displayPath?: string;
  /** downloads = 系统下载目录；pictures = 图片/相册目录 */
  location: "downloads" | "pictures" | string;
}

export type CliInstallState =
  | "missing"
  | "current"
  | "outdated"
  | "broken"
  | "conflict"
  | "unsupported";

export interface CliInstallStatus {
  state: CliInstallState;
  currentVersion: string;
  installedVersion: string | null;
  installPath: string;
  /** 可直接交给 AI 使用的完整命令入口，不依赖当前进程是否刷新 PATH。 */
  invocation: string;
}

export interface KdjBridge {
  baseUrl: string;
  /** 每次进程启动重新生成；只用于认证本机 HTTP/WS，不得写入日志或持久化到前端。 */
  authToken: string;
  /** 仅能读取显式媒体端点，不能访问设置、账号或其它控制 API。 */
  mediaToken: string;
  platform: NodeJS.Platform | string;
  /** macOS / Windows 桌面壳里的 CLI 入口检测与用户触发安装。 */
  cliInstallStatus?: () => Promise<CliInstallStatus>;
  installCli?: () => Promise<CliInstallStatus>;
  /**
   * macOS 系统 WebKit 的独立 WebPO 运行器。远程 BotGuard 只在无 Tauri IPC、
   * 非持久的 YouTube-origin WebView 中执行；其它平台不伪装第二条实现。
   */
  mintYoutubeGvsPoToken?: (options: {
    bundle: string;
    binding: string;
    forceFresh: boolean;
    userAgent: string;
  }) => Promise<string>;
  runYoutubePlayer?: (options: {
    bundle: string;
    playerUrl: string;
    javascript: string;
    operation: "config" | "decipher" | "transform_n";
    value: string;
  }) => Promise<string>;
  /**
   * macOS 上与主 renderer 权限完全分离的官方 YouTube 播放子视图。页面本身没有
   * Tauri IPC；这里只暴露固定视频编号、几何位置和播放器动作。
   */
  youtubeEmbed?: {
    prewarm: () => Promise<void>;
    open: (options: {
      videoId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }) => Promise<void>;
    setBounds: (options: {
      videoId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }) => Promise<void>;
    status: (videoId: string) => Promise<{
      ready: boolean;
      playing: boolean;
      buffering: boolean;
      ended: boolean;
      position: number;
      duration: number;
      hasError: boolean;
    }>;
    control: (
      videoId: string,
      action: "play" | "pause" | "mute" | "unmute" | "seek" | "volume",
      value?: number,
    ) => Promise<void>;
    close: (videoId: string) => Promise<void>;
  };
  /** 与主 renderer 权限分离的 B站官方播放器子视图。 */
  bilibiliEmbed?: {
    open: (options: {
      bvid: string;
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }) => Promise<void>;
    setBounds: (options: {
      bvid: string;
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }) => Promise<void>;
    status: (bvid: string, page: number) => Promise<{
      ready: boolean;
      playing: boolean;
      buffering: boolean;
      ended: boolean;
      position: number;
      duration: number;
      hasError: boolean;
    }>;
    control: (
      bvid: string,
      page: number,
      action: "play" | "pause" | "mute" | "unmute" | "seek" | "volume",
      value?: number,
    ) => Promise<void>;
    close: (bvid: string, page: number) => Promise<void>;
  };
  openPath: (path: string) => Promise<void>;
  revealPath: (path: string) => Promise<void>;
  /** 从曲库启动 Finder / Explorer / Android 的真文件拖动；iOS/浏览器不提供。 */
  startFileDrag?: (options: {
    paths: string[];
    label: string;
    /** 128×128 PNG 的纯 Base64；桌面系统把它用作原生拖拽预览。 */
    dragImage?: string;
  }) => Promise<void>;
  /** 把公开 URL 作为系统链接拖到浏览器、聊天或其他接收链接的应用。 */
  startLinkDrag?: (options: {
    url: string;
    label: string;
    /** 普通文本接收方拿到的内容；URL 接收方始终拿到 url。 */
    text?: string;
    dragImage?: string;
    /** “更多信息”模式才把封面作为 RTFD 附件并入同一个图文载荷。 */
    includeArtwork?: boolean;
  }) => Promise<void>;
  /** macOS：把真实 PNG 附件与分享文字写入同一个原生富文本剪贴板项目。 */
  writeShareClipboard?: (options: { text: string; png: string }) => Promise<void>;
  /** 把登录二维码 PNG 写到下载（桌面）或相册（手机），返回本机路径。 */
  saveLoginQr: (options: {
    platform: string;
    label: string;
    image: string;
  }) => Promise<SavedLoginQr>;
  pickFolder: () => Promise<string | null>;
  pickFolders: () => Promise<string[]>;
  /** 安卓：媒体读取权限（READ_MEDIA_AUDIO）是否已授予；桌面恒为 true。 */
  mediaPermissionGranted: () => Promise<boolean>;
  /** 用系统浏览器开外链（Release 页等）。 */
  openExternal?: (url: string) => Promise<void>;
  /** 桌面独立 OAuth 窗口；同进程拦截回调，开发态无需注册 kdj://。 */
  openSoundcloudOAuth?: (url: string) => Promise<void>;
  /** 桌面：在一次性 soundcloud.com WebView 中登录，不读取外部浏览器数据。 */
  openSoundcloudWebLogin?: () => Promise<void>;
  /** 桌面：在一次性 music.youtube.com WebView 中登录，Cookie 只留在 Rust。 */
  openYtmWebLogin?: () => Promise<void>;
  /**
   * 桌面直接问 Tauri Updater 的清单；只有当前安装格式真的存在签名更新包时
   * 才会返回 newer=true。移动端/浏览器没有它，继续走 GitHub Release API。
   */
  checkUpdate?: null | (() => Promise<UpdateInfo>);
  /**
   * 桌面独有的一键更新：下载 + 校验 + 原地替换 + 重启，全程由
   * tauri-plugin-updater 托管。非桌面壳是 null/缺席——调用方按平台
   * 各给各的操作（安卓开 Release 页下 APK，浏览器开发布页）。
   */
  applyUpdate?: null | ((onProgress?: (progress: UpdateProgress) => void) => Promise<void>);
  windowControl: (action: "minimize" | "maximize" | "close" | "drag") => void;
  /** 同步原生窗口底色，避免 macOS 拖窗时露出与页面主题不符的底层。 */
  setWindowBackground: (theme: "dark" | "light") => void;
  /**
   * 悬浮歌词开关与样式。桌面是独立透明置顶窗口；Android 是原生
   * `TYPE_APPLICATION_OVERLAY` 浮层。浏览器与 iOS 没有该能力（iOS 沙盒不允许）。
   */
  desktopLyrics?: null | ((options: {
    visible: boolean;
    position: "top" | "bottom";
    locked: boolean;
    /** 字号倍率；原生侧按此调整悬浮窗高度，避免放大后被裁切。 */
    fontScale?: number;
    /** 只有切换顶部/底部或重新打开时吸附；锁定切换不能抹掉自由拖动位置。 */
    reposition: boolean;
    x?: number | null;
    y?: number | null;
    /** 主行已唱部分颜色 `#RRGGBB`；桌面 / Android 悬浮歌词逐字高亮共用。 */
    accent?: string;
    accentEnd?: string;
    accentMode?: "black" | "white" | "gray" | "solid" | "gradient";
    secondaryAccent?: string;
    secondaryAccentEnd?: string;
    secondaryMode?: "black" | "white" | "gray" | "solid" | "gradient" | "follow";
    /** 未唱部分；前端在 follow 时会先把副行解析成具体色再下发。 */
    dim?: string;
    dimEnd?: string;
    dimMode?: "black" | "white" | "gray" | "solid" | "gradient";
    stroke?: string;
    strokeEnd?: string;
    strokeMode?: "black" | "white" | "gray" | "solid" | "gradient" | "none";
    opacity?: number;
  }) => Promise<void>);
  /**
   * 把整首歌的歌词时间轴交给原生侧，只在换歌或切附加层时调用。
   *
   * 只有 Android 有：那边浮层是原生 View，本地曲目由 Rust coordinator 镜像
   * 驱动；WebView 一进后台就会被冻结，靠 JS 定时器推歌词会卡住。浏览器试听
   * 另走下面的限频时钟镜像。桌面的歌词窗口是另一个 WebView，自己订阅 store，
   * 不需要这条通道。
   */
  lyricsTimeline?: null | ((payload: {
    trackId: number | null;
    duration: number;
    /** 搜词中 / 没有歌词时的兜底文案。 */
    placeholder: string;
    lines: {
      time: number;
      endTime?: number;
      text: string;
      secondary?: string;
      words?: { start: number; end: number; text: string }[];
    }[];
  }) => Promise<void>);
  /**
   * Android 浏览器试听的时钟镜像。流媒体临时曲目用负 ID，不能误进本地 Rust
   * coordinator；原生浮层据此在两次限频更新之间外推歌词位置。
   */
  lyricsPlaybackClock?: null | ((payload: {
    /** 负数 = 在线试听；null 清除上一首的浏览器时钟。 */
    trackId: number | null;
    position: number;
    duration: number;
    playing: boolean;
    rate: number;
  }) => Promise<void>);
  /**
   * 「显示在其他应用上层」权限。只有 Android 有：这是用户必须去系统设置里
   * 手动授予的敏感权限，拿不到就挂不上浮层。
   */
  overlayPermission?: null | {
    check: () => Promise<boolean>;
    /** 拉起系统设置页；返回时的授权结果由调用方轮询 check 确认。 */
    request: () => Promise<void>;
    /** 浮层被拖动后的新垂直偏移。 */
    onMoved: (handler: (y: number) => void) => Promise<() => void>;
  };
  onSidecarLog: (cb: (line: string) => void) => () => void;
}

/** `/api/update/check` 或桌面 Tauri updater check 的统一返回。 */
export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  url: string;
  name: string;
  published_at: string;
  /** Release notes；旧后端或没有 notes 的清单可以省略。 */
  notes?: string;
}

/** Rust 更新任务的可轮询进度。 */
export interface UpdateProgress {
  stage: "idle" | "checking" | "downloading" | "installing" | "restarting" | "failed";
  downloaded: number;
  total: number | null;
  message: string;
}

declare global {
  interface Window {
    kdj: KdjBridge;
  }
}
