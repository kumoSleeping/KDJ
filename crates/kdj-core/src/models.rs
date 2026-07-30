//! 前后端契约。字段名必须和 `src/types.ts` 一一对应。
//!
//! 这是从 `sidecar/kdj/models.py` 直译过来的，**不要**在这里"顺手改进"
//! 字段名或可空性——前端 5792 行 TSX 是照着旧契约写的，改一个字段就要全量回归。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// ---------------------------------------------------------------- 枚举

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Wyy,
    Qqm,
    Soundcloud,
    Bilibili,
    Local,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Wyy => "wyy",
            Platform::Qqm => "qqm",
            Platform::Soundcloud => "soundcloud",
            Platform::Bilibili => "bilibili",
            Platform::Local => "local",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "wyy" => Some(Platform::Wyy),
            "qqm" => Some(Platform::Qqm),
            "soundcloud" => Some(Platform::Soundcloud),
            "bilibili" => Some(Platform::Bilibili),
            "local" => Some(Platform::Local),
            _ => None,
        }
    }

    /// 下载落盘的历史子目录名（曾用于按平台分文件夹）。
    /// 新下载已改为直接落在下载根目录；保留此方法只是避免旧路径语义被误改。
    pub fn download_dir_name(self) -> &'static str {
        match self {
            Platform::Wyy => "netease",
            Platform::Qqm => "qqmusic",
            Platform::Soundcloud => "soundcloud",
            Platform::Bilibili => "bilibili",
            Platform::Local => "local",
        }
    }
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Quality {
    #[serde(rename = "flac")]
    Flac,
    #[serde(rename = "320")]
    Q320,
    #[serde(rename = "128")]
    Q128,
}

/// 音质降级梯度：从请求音质一路往下退（flac → 320 → 128）。
pub const QUALITY_ORDER: [Quality; 3] = [Quality::Flac, Quality::Q320, Quality::Q128];

impl Quality {
    pub fn as_str(self) -> &'static str {
        match self {
            Quality::Flac => "flac",
            Quality::Q320 => "320",
            Quality::Q128 => "128",
        }
    }

    /// 宽松解析。未知值一律退回 flac —— 和 Python 版 `normalize_quality_start` 一致。
    pub fn normalize(value: Option<&str>) -> Quality {
        let key = value.unwrap_or("").trim().to_ascii_lowercase().replace('-', "_");
        match key.as_str() {
            "max" | "lossless" | "hires" | "sq" | "flac" => Quality::Flac,
            "320" | "320k" | "exhigh" | "mp3_320" => Quality::Q320,
            "128" | "128k" | "standard" | "mp3_128" => Quality::Q128,
            _ => Quality::Flac,
        }
    }

    pub fn gradient(self) -> &'static [Quality] {
        match self {
            Quality::Flac => &QUALITY_ORDER[0..],
            Quality::Q320 => &QUALITY_ORDER[1..],
            Quality::Q128 => &QUALITY_ORDER[2..],
        }
    }
}

impl Default for Quality {
    fn default() -> Self {
        Quality::Flac
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Queued,
    Running,
    /// 媒体字节已拉完，正在由 FFmpeg 合并/转码，或移动、入库。
    Processing,
    Done,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountState {
    Missing,
    Valid,
    Expired,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QrStateValue {
    Waiting,
    Scanned,
    Done,
    Expired,
    Refused,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoFormat {
    Mp4,
    Mkv,
    Mov,
}

impl VideoFormat {
    pub fn ext(self) -> &'static str {
        match self {
            VideoFormat::Mp4 => "mp4",
            VideoFormat::Mkv => "mkv",
            VideoFormat::Mov => "mov",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    System,
}

// ---------------------------------------------------------------- 基础

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Health {
    pub ok: bool,
    pub version: String,
    pub ffmpeg: bool,
    pub data_dir: String,
    pub download_dir: String,
    /// 新增：安卓上前端要据此隐藏"多根曲库目录/文件夹拖拽"这些桌面专属入口。
    /// 老前端不认识这个字段会直接忽略，不破坏契约。
    #[serde(default)]
    pub platform: String,
}

// ---------------------------------------------------------------- 账号

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub platform: Platform,
    pub label: String,
    pub state: AccountState,
    #[serde(default)]
    pub nickname: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub detail: String,
    /// false = 该平台没有扫码登录，前端不显示登录按钮。
    #[serde(default = "default_true")]
    pub supports_login: bool,
}

impl Account {
    pub fn new(platform: Platform, label: &str, state: AccountState, detail: &str) -> Self {
        Account {
            platform,
            label: label.to_string(),
            state,
            nickname: String::new(),
            avatar: String::new(),
            detail: detail.to_string(),
            supports_login: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QrSession {
    pub platform: Platform,
    pub session_id: String,
    /// `data:image/png;base64,...`
    pub image: String,
    #[serde(default)]
    pub url: String,
    #[serde(default = "default_qr_ttl")]
    pub expires_in: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QrState {
    pub session_id: String,
    pub state: QrStateValue,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub account: Option<Account>,
}

// ---------------------------------------------------------------- 歌词

/// 某平台上一首歌的歌词正文（LRC）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricText {
    pub lrc: String,
    #[serde(default)]
    pub translated_lrc: String,
    /// 罗马音 / 音译 LRC（网易云 romalrc、QQ roma）。
    #[serde(default)]
    pub romaji_lrc: String,
}

/// 按曲名/艺人自动搜歌词后的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricsResponse {
    pub lrc: String,
    #[serde(default)]
    pub translated_lrc: String,
    #[serde(default)]
    pub romaji_lrc: String,
    pub platform: Platform,
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    /// 候选与请求元数据的匹配分（0..1）。
    #[serde(default)]
    pub score: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LyricsRequest {
    pub title: String,
    #[serde(default)]
    pub artist: String,
    pub duration: Option<f64>,
    /// 下载时记下的来源平台；有的话优先直取，不必再搜。
    #[serde(default)]
    pub platform: Option<Platform>,
    #[serde(default)]
    pub key: String,
    /// 启用的搜词引擎（顺序=同分偏好）。空则默认网易云 → QQ。
    #[serde(default)]
    pub engines: Vec<Platform>,
    /// 显示来源：`follow`（跟随曲库）/ `wyy` / `qqm`。
    #[serde(default)]
    pub prefer: String,
}

// ---------------------------------------------------------------- 搜索

/// 一首歌在某个平台上的具体来源。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongSource {
    pub platform: Platform,
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub max_quality: Option<Quality>,
    #[serde(default)]
    pub vip: bool,
    /// 回传给下载接口的原始数据。要经 HTTP 往返，所以只能放 JSON 安全值。
    #[serde(default)]
    pub payload: Map<String, Value>,
}

impl SongSource {
    pub fn artist_text(&self) -> String {
        if self.artists.is_empty() {
            "Unknown".to_string()
        } else {
            self.artists.join(", ")
        }
    }

    pub fn payload_str(&self, key: &str) -> String {
        self.payload
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    }
}

/// 混合搜索聚合出来的一首歌（跨平台去重后的结果）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergedGroup {
    pub group_id: String,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub sources: Vec<SongSource>,
    #[serde(default)]
    pub best_source_index: usize,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub in_library: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default = "default_platforms")]
    pub platforms: Vec<Platform>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default = "default_true")]
    pub merge: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SearchResponse {
    pub query: String,
    pub groups: Vec<MergedGroup>,
    pub per_platform: std::collections::BTreeMap<String, Vec<SongSource>>,
    pub errors: std::collections::BTreeMap<String, String>,
    pub elapsed_ms: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResolveRequest {
    pub url: String,
    #[serde(default = "default_resolve_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResolveKind {
    Song,
    Playlist,
    Album,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveResponse {
    pub kind: ResolveKind,
    pub platform: Platform,
    pub title: String,
    #[serde(default)]
    pub sources: Vec<SongSource>,
}

// ---------------------------------------------------------------- 批量投喂

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IntakeKind {
    Search,
    Song,
    Playlist,
    Album,
    Unknown,
    Error,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IntakeRequest {
    pub text: String,
    #[serde(default = "default_platforms")]
    pub platforms: Vec<Platform>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default = "default_true")]
    pub merge: bool,
    #[serde(default = "default_max_entries")]
    pub max_entries: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct IntakeItem {
    /// 拆出来的原始文本（链接或关键词）
    pub entry: String,
    pub kind: IntakeKind,
    pub platform: Option<Platform>,
    pub title: String,
    pub groups: Vec<MergedGroup>,
    pub errors: std::collections::BTreeMap<String, String>,
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct IntakeResponse {
    pub items: Vec<IntakeItem>,
    /// 超出 max_entries 被丢掉的条数
    pub skipped: usize,
    pub elapsed_ms: f64,
}

// ---------------------------------------------------------------- 下载

#[derive(Debug, Clone, Deserialize)]
pub struct DownloadRequest {
    pub sources: Vec<SongSource>,
    #[serde(default)]
    pub quality: Option<Quality>,
    /// None = 跟随设置
    #[serde(default)]
    pub analyze: Option<bool>,
    /// 下载完成后挪进这个曲库文件夹（绝对路径）。空 = 留在默认下载目录。
    #[serde(default)]
    pub dest_dir: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Audio,
    Video,
    /// 本地曲库按顺序拼成 VJ 片子；走同一条下载队列统一调度 / 取消 / 清理。
    VjExport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: String,
    pub kind: TaskKind,
    pub platform: Platform,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub quality: String,
    pub state: TaskState,
    /// 0..1
    pub progress: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: f64,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub track_id: Option<i64>,
    /// 入队时指定的目标曲库文件夹；前端用来在对应文件夹列表里画「待下载」行。
    #[serde(default)]
    pub dest_dir: String,
    /// 搜索结果带来的封面 URL；刷新页面后左表待下载行还要能画出缩略图。
    #[serde(default)]
    pub cover: String,
    pub created_at: f64,
    pub updated_at: f64,
}

// ---------------------------------------------------------------- 视频

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoPage {
    pub index: usize,
    pub title: String,
    pub duration: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoStreamOption {
    pub quality_id: i64,
    pub label: String,
    pub height: i64,
    #[serde(default)]
    pub codec: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub bvid: String,
    pub title: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub duration: i64,
    #[serde(default)]
    pub pages: Vec<VideoPage>,
    #[serde(default)]
    pub options: Vec<VideoStreamOption>,
    #[serde(default)]
    pub logged_in: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct VideoDownloadRequest {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub bvid: String,
    #[serde(default)]
    pub page_index: usize,
    #[serde(default = "default_video_height")]
    pub max_height: i64,
    #[serde(default)]
    pub audio_only: bool,
    #[serde(default)]
    pub transcode: bool,
    /// 成品相对原片的起点偏移（毫秒）。正数掐掉开头这么长，负数在开头
    /// 补同样长的黑场/静音——预览面板里对着唱盘校出来的那个值。
    /// 0（默认）= 原样，走 copy 快路径；非零会强制重编码（见 ffmpeg.rs）。
    #[serde(default)]
    pub offset_ms: i64,
    /// 下载完成后挪进这个曲库文件夹。空 = 留在默认视频目录。
    #[serde(default)]
    pub dest_dir: String,
    /// 搜索结果里的标题/UP 主/封面。有则入队立刻用，别等 B 站二次解析，刷新也不丢。
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub cover: String,
}

/// 「按顺序导出 VJ」入队请求。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct VjExportRequest {
    /// 源文件夹（曲库内绝对路径）；展示用，也作后续写回参考。
    #[serde(default)]
    pub folder: String,
    /// 本次导出顺序（曲目 id）。
    #[serde(default)]
    pub track_ids: Vec<i64>,
    #[serde(default = "default_true")]
    pub use_in_out_points: bool,
    #[serde(default)]
    pub snap_nearest_beat: bool,
    #[serde(default)]
    pub snap_whole_bar: bool,
    /// 固定秒数的淡入淡出；和 `fade_bars` 二选一，后者优先。
    #[serde(default)]
    pub fade_seconds: f64,
    /// 淡入淡出按几小节走。每次衔接都以上一首的 BPM 换算，未分析时按 120 BPM。
    #[serde(default)]
    pub fade_bars: u8,
    /// `1080p` / `720p` / `480p`
    #[serde(default = "default_vj_quality")]
    pub quality: String,
    #[serde(default = "default_true")]
    pub keep_audio: bool,
    #[serde(default = "default_true")]
    pub unify_gain: bool,
}

// ---------------------------------------------------------------- 曲库

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub filename: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub genre: String,
    #[serde(default)]
    pub year: String,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub bitrate: Option<i64>,
    #[serde(default)]
    pub samplerate: Option<i64>,
    #[serde(default)]
    pub channels: Option<i64>,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub bpm_confidence: Option<f64>,
    #[serde(default)]
    pub first_beat: Option<f64>,
    #[serde(default)]
    pub music_key: String,
    #[serde(default)]
    pub camelot: String,
    #[serde(default)]
    pub open_key: String,
    #[serde(default)]
    pub key_confidence: Option<f64>,
    #[serde(default)]
    pub energy: Option<i64>,
    #[serde(default)]
    pub rms_db: Option<f64>,
    #[serde(default)]
    pub peak_db: Option<f64>,
    #[serde(default)]
    pub rating: i64,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub cue_ms: Option<i64>,
    /// 结束点（毫秒）。与 cue_ms 成对，供导出裁切等使用。
    #[serde(default)]
    pub end_ms: Option<i64>,
    #[serde(default = "default_local")]
    pub source_platform: String,
    #[serde(default)]
    pub source_key: String,
    #[serde(default)]
    pub analyzed_at: Option<String>,
    #[serde(default)]
    pub added_at: String,
    #[serde(default)]
    pub modified_at: String,
    #[serde(default)]
    pub analysis_error: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 所在目录（= path 的父目录）。前端文件夹树按它归位。
    #[serde(default)]
    pub folder: String,
    /// ""=普通文件，"hardlink"/"symlink"=和别处共用同一份数据
    #[serde(default)]
    pub link: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TrackPage {
    pub items: Vec<Track>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct TrackPatch {
    pub rating: Option<i64>,
    pub color: Option<String>,
    pub comment: Option<String>,
    pub cue_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    /// 自由文本而不是数字：文件里存的可能是 "2021" 也可能是 "2021-05-17"，
    /// 解析成 i64 会把后者截断，写回去就把日期弄丢了。
    pub year: Option<String>,
    pub tags: Option<Vec<String>>,
}

/// PATCH 曲目的响应。
///
/// `#[serde(flatten)]` 让 JSON 形状仍然是一个 Track，只是**可能**多一个
/// `tag_write_error`——契约上只加可选字段，旧前端拿到它照样能当 Track 用。
///
/// 为什么要单开一个字段：写回文件标签是"尽力而为"的（文件只读、被 DJ 软件
/// 占着都很常见），失败不该让整次保存回滚。数据库那边已经存好了，
/// 只有文件没跟上——这件事必须说出来，不然用户会以为文件里也改好了。
#[derive(Debug, Clone, Serialize)]
pub struct TrackPatchResult {
    #[serde(flatten)]
    pub track: Track,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_write_error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ScanRequest {
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default = "default_true")]
    pub recursive: bool,
    #[serde(default)]
    pub analyze: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanResponse {
    pub job_id: String,
    pub found: usize,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AnalyzeRequest {
    #[serde(default)]
    pub track_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub force: bool,
    /// 走插队通道，给"正在放的这首"用
    #[serde(default)]
    pub priority: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyzeResponse {
    pub job_id: String,
    pub queued: usize,
}

/// 和声关系。加关系必须同步改 `RELATION_LABELS` 和 `src/types.ts`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarmonicRelation {
    Same,
    EnergyUp,
    EnergyDown,
    Relative,
    EnergyBoost,
    TwoStep,
    Diagonal,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarmonicMatch {
    pub track: Track,
    pub relation: HarmonicRelation,
    pub relation_label: String,
    pub bpm_delta: f64,
    pub tempo_ratio: f64,
    pub score: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct FolderNode {
    pub path: String,
    pub name: String,
    pub parent: String,
    /// 该目录下直接躺着的曲目数
    pub track_count: i64,
    /// 含所有子目录的曲目数
    pub total_count: i64,
    /// 这一层目录里实际躺着几个音频文件。> track_count 说明还没扫进曲库
    pub file_count: i64,
    /// 含子目录的未入库文件数
    pub pending_count: i64,
    pub children: Vec<FolderNode>,
    pub is_root: bool,
    /// 目录里有可用的 .kdj/manifest.json（兼容旧 .kdj.json），false = 按名字排
    pub managed: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct FolderTree {
    pub roots: Vec<FolderNode>,
    /// 落在所有曲库根目录之外的曲目数
    pub outside: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileOp {
    Move,
    Link,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FolderOpRequest {
    #[serde(default)]
    pub track_ids: Vec<i64>,
    pub dest: String,
    #[serde(default = "default_file_op")]
    pub op: FileOp,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderOpResult {
    /// move：被改了路径的曲目 id；link：新建出来的曲目 id
    pub track_ids: Vec<i64>,
    pub op: FileOp,
    /// 实际用的链接方式统计，例如 {"hardlink": 3, "copy": 1}
    pub methods: std::collections::BTreeMap<String, i64>,
    pub errors: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FolderCreateRequest {
    pub parent: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FolderRenameRequest {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FolderDeleteRequest {
    pub path: String,
}

/// 从软件里移出某文件夹：摘掉库记录 / 曲库根登记，不删磁盘内容。
#[derive(Debug, Clone, Deserialize)]
pub struct FolderForgetRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderForgetResult {
    /// 从库里摘掉的曲目数（文件仍在磁盘上）。
    pub removed: usize,
    pub tree: FolderTree,
}

/// 把 path 这个文件夹整个搬进 dest_parent。
#[derive(Debug, Clone, Deserialize)]
pub struct FolderMoveRequest {
    pub path: String,
    pub dest_parent: String,
}

/// 把 path 下的子目录顺序改成 names 给的顺序，落进 path/.kdj/manifest.json。
#[derive(Debug, Clone, Deserialize)]
pub struct FolderOrderRequest {
    pub path: String,
    #[serde(default)]
    pub names: Vec<String>,
}

/// 给 path 及其子目录补上 .kdj/manifest.json。省略 path = 所有曲库根。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FolderInitRequest {
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct LibraryStats {
    pub total: i64,
    pub analyzed: i64,
    pub total_duration: f64,
    pub total_size: i64,
    /// 已分析曲目的全库中位数。前端用它把响度显示成相对 100%，不拿当前分页假算。
    pub energy_median: Option<f64>,
    pub rms_db_median: Option<f64>,
    pub peak_db_median: Option<f64>,
    pub by_camelot: std::collections::BTreeMap<String, i64>,
    pub by_bpm_bucket: std::collections::BTreeMap<String, i64>,
    pub by_platform: std::collections::BTreeMap<String, i64>,
}

/// 波形：每列一个幅度 + RGB 三条频段能量。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Waveform {
    pub track_id: i64,
    pub duration: f64,
    pub amp: Vec<f32>,
    pub r: Vec<u8>,
    pub g: Vec<u8>,
    pub b: Vec<u8>,
}

// ---------------------------------------------------------------- serde 默认值

fn default_true() -> bool {
    true
}
fn default_limit() -> usize {
    20
}
fn default_resolve_limit() -> usize {
    500
}
fn default_max_entries() -> usize {
    50
}
fn default_qr_ttl() -> u32 {
    180
}
fn default_video_height() -> i64 {
    1080
}
fn default_vj_quality() -> String {
    "1080p".into()
}
fn default_local() -> String {
    "local".to_string()
}
fn default_file_op() -> FileOp {
    FileOp::Move
}
fn default_platforms() -> Vec<Platform> {
    vec![Platform::Wyy, Platform::Qqm]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_roundtrips_through_the_wire_names() {
        // 前端发来的就是这些字面量，改了就是契约破坏
        for name in ["wyy", "qqm", "soundcloud", "bilibili", "local"] {
            let parsed: Platform = serde_json::from_str(&format!("\"{name}\"")).unwrap();
            assert_eq!(serde_json::to_string(&parsed).unwrap(), format!("\"{name}\""));
            assert_eq!(parsed.as_str(), name);
        }
    }

    #[test]
    fn quality_serializes_as_bare_strings_not_numbers() {
        assert_eq!(serde_json::to_string(&Quality::Q320).unwrap(), "\"320\"");
        assert_eq!(serde_json::to_string(&Quality::Flac).unwrap(), "\"flac\"");
    }

    #[test]
    fn quality_gradient_matches_python_downgrade_order() {
        assert_eq!(Quality::Flac.gradient(), &[Quality::Flac, Quality::Q320, Quality::Q128]);
        assert_eq!(Quality::Q320.gradient(), &[Quality::Q320, Quality::Q128]);
        assert_eq!(Quality::Q128.gradient(), &[Quality::Q128]);
    }

    #[test]
    fn unknown_quality_falls_back_to_flac() {
        assert_eq!(Quality::normalize(Some("hires")), Quality::Flac);
        assert_eq!(Quality::normalize(Some("MP3-320")), Quality::Q320);
        assert_eq!(Quality::normalize(None), Quality::Flac);
    }

    #[test]
    fn nullable_fields_serialize_as_null_not_missing() {
        // 前端写的是 `duration: number | null`，字段消失会让 TS 侧 undefined
        let source = SongSource {
            platform: Platform::Wyy,
            key: "1".into(),
            title: "t".into(),
            artists: vec![],
            album: String::new(),
            duration: None,
            cover: String::new(),
            max_quality: None,
            vip: false,
            payload: Map::new(),
        };
        let json = serde_json::to_value(&source).unwrap();
        assert!(json.get("duration").unwrap().is_null());
        assert!(json.get("max_quality").unwrap().is_null());
    }

    #[test]
    fn harmonic_relation_uses_snake_case_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&HarmonicRelation::EnergyUp).unwrap(),
            "\"energy_up\""
        );
    }
}
