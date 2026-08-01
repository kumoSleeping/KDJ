/**
 * 前后端契约（对应 sidecar/kdj/models.py）。
 * 改这里必须同步改 models.py 和 docs/00-architecture.md。
 */

export type Platform = "wyy" | "qqm" | "soundcloud" | "bilibili" | "local";
export type Quality = "flac" | "320" | "128";
export type TaskState = "queued" | "running" | "processing" | "done" | "failed" | "canceled";
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

/** 粘贴快捷键：链接进文件夹，或真复制一份文件。移动不在此列。 */
export type LibraryPasteMode = "link" | "copy";

export type VideoFormat = "mp4" | "mkv" | "mov";

export interface Settings {
  download_dir: string;
  library_dirs: string[];
  default_quality: Quality;
  filename_template: string;
  concurrent_downloads: number;
  auto_analyze: boolean;
  /** 下载完成后按来源 ID 保存 LRC 到曲库目录的 `.kdj/lyrics/`。 */
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
  /**
   * 曲库 Cmd/Ctrl+V（及不按 Option 的拖放）默认行为。
   * 移动始终走 Option/Alt+V、剪切，或右键「粘贴」。
   */
  library_paste: LibraryPasteMode;
  /**
   * 只读派生字段（后端 GET/PUT /api/settings 附带）：全新安装的默认下载落点
   * ——系统「下载」目录 + KDJ。「保存到」菜单里的「系统下载」项用它。
   * PUT 回去会被后端忽略，不持久化。
   */
  default_download_dir?: string;
}

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
  /** follow | wyy | qqm */
  prefer?: string;
}

export interface LyricsResponse {
  lrc: string;
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
  translated_lrc: string;
  romaji_lrc: string;
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
  /** 下载完成后挪进这个曲库文件夹；空 = 默认下载目录。 */
  dest_dir?: string;
}

export type DownloadTaskKind = "audio" | "video" | "vj_export";

export interface DownloadTask {
  id: string;
  kind: DownloadTaskKind;
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
  /** 入队时指定的目标文件夹；前端用来在对应列表画「待下载」行。 */
  dest_dir?: string;
  /** 仅前端：搜索结果带来的封面 URL，占位行用来避免只剩 BV 号。 */
  cover?: string;
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
  /** 成品起点偏移（毫秒）：正=掐头，负=开头补黑场/静音。见 models.rs。 */
  offset_ms?: number;
  /** 下载完成后挪进这个曲库文件夹；空 = 默认视频目录。 */
  dest_dir?: string;
  /** 搜索结果展示信息：入队立刻用，刷新后仍能从任务列表还原。 */
  title?: string;
  artist?: string;
  cover?: string;
}

/** 「按顺序导出 VJ」入队请求；与下载队列共用 DownloadTask。 */
export interface VjExportRequest {
  folder: string;
  track_ids: number[];
  use_in_out_points: boolean;
  snap_nearest_beat: boolean;
  snap_whole_bar: boolean;
  /** 固定秒数的淡入淡出；按小节时传 0。 */
  fade_seconds: number;
  /** 以上一首 BPM 换算的淡入淡出小节数；固定秒数时传 0。 */
  fade_bars: number;
  quality: "1080p" | "720p" | "480p";
  keep_audio: boolean;
  unify_gain: boolean;
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
  /** 结束点（毫秒），与 cue_ms 成对。 */
  end_ms: number | null;
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
  /** 目录里有可用的 .kdj/manifest.json（兼容旧 .kdj.json）；false = 按名字排。 */
  managed: boolean;
}

export interface FolderTree {
  roots: FolderNode[];
  /** 落在所有曲库根目录之外的曲目数。 */
  outside: number;
}

/** 从软件移出文件夹：摘库记录，不删磁盘。 */
export interface FolderForgetResult {
  removed: number;
  tree: FolderTree;
}

export type FileOp = "move" | "link" | "copy";

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
  end_ms?: number;
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
}

export interface AnalyzeProgress {
  job_id: string;
  done: number;
  total: number;
  current: string;
  track_id: number | null;
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

export interface KdjBridge {
  baseUrl: string;
  platform: NodeJS.Platform | string;
  openPath: (path: string) => Promise<void>;
  revealPath: (path: string) => Promise<void>;
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
   * 只有 Android 有：那边浮层是原生 View，时间轴必须由持有 ExoPlayer 的
   * 原生侧驱动——WebView 一进后台就会被冻结，靠 JS 定时器推歌词会卡住，
   * 而息屏/切走恰好是悬浮歌词唯一的使用场景。桌面的歌词窗口是另一个
   * WebView，自己订阅 store，不需要这条通道。
   */
  lyricsTimeline?: null | ((payload: {
    trackId: number | null;
    duration: number;
    /** 搜词中 / 没有歌词时的兜底文案。 */
    placeholder: string;
    lines: { time: number; text: string; secondary?: string }[];
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
