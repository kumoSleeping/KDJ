//! 运行期配置：`Settings` 是前后端契约的一部分，`AppConfig` 是它加上进程级参数。
//!
//! settings.json 落在 data_dir 下。读写规则原样沿用 Python 版：
//! - 读：缺字段用默认值补齐；**单个字段值非法只丢弃这个字段**，不能让整份配置作废。
//! - 写：先写 `.tmp` 再 rename 原子替换——直接覆写时进程被 kill 会留下半截 JSON。

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::{FilterResonance, KeyNotation, Quality, Theme, VideoFormat};

pub const SETTINGS_FILENAME: &str = "settings.json";
static SETTINGS_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const SETTINGS_MAX_BYTES: u64 = 1024 * 1024;
// 桌面版历史主库一直叫 kumodeck.db。改名会在同一 data_dir 静默创建一份空库，
// 随后的自动扫描看起来像“曲库少了一半”，同时旧库 1428 首完全不再更新。
// 数据文件名属于持久化契约，不跟 crate/package 的内部名称走。
pub const DB_FILENAME: &str = "kumodeck.db";

/// settings.json 里出现过的所有字段名。field-by-field 降级解析要用。
const SETTINGS_FIELDS: &[&str] = &[
    "download_dir",
    "library_dirs",
    "default_quality",
    "stream_quality",
    "stream_cache_enabled",
    "video_playback_max_height",
    "youtube_preview_player",
    "bilibili_preview_player",
    "filename_template",
    "concurrent_downloads",
    "auto_analyze",
    "auto_analysis_mode",
    "download_lyrics",
    "write_tags_after_analyze",
    "analysis_duration",
    "theme",
    "soundcloud_enabled",
    "netease_use_download_api",
    "video_max_height",
    "video_transcode",
    "video_download_dir",
    "video_format",
    "platform_priority",
    "search_platforms",
    "enabled_platforms",
    "auto_start_downloads",
    "player_waveform",
    "filter_resonance",
    "key_notation",
];

/// Automatic library analysis deliberately has no unbounded mode. `Full` means the fastest
/// resource-capped background policy; `Light` is the install default and trades throughput for a
/// responsive player and desktop; `Paused` admits only explicit/manual work.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoAnalysisMode {
    Full,
    #[default]
    Light,
    Paused,
}

impl AutoAnalysisMode {
    pub const fn enabled(self) -> bool {
        !matches!(self, Self::Paused)
    }
}

/// 在线视频的预览窗口。下载完成后的本地文件始终交给 KDJ 本地播放器。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnlineVideoPlayer {
    Platform,
    #[default]
    Kdj,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub download_dir: String,
    #[serde(default)]
    pub library_dirs: Vec<String>,
    #[serde(default)]
    pub default_quality: Quality,
    /// 在线流播放请求的起始音质；下载音质仍由 default_quality 控制。
    #[serde(default = "default_stream_quality")]
    pub stream_quality: Quality,
    /// 把实际播放完成的在线音频流缓存到下载目录的 `.kdj/stream-cache/`。
    #[serde(default)]
    pub stream_cache_enabled: bool,
    /// 视频在线播放的画质上限；下载画质仍由 video_max_height 控制。
    #[serde(default = "default_video_playback_height")]
    pub video_playback_max_height: i64,
    /// 在线 YouTube 预览默认使用内置播放器，可手动切到 YouTube 官方播放器。
    #[serde(default)]
    pub youtube_preview_player: OnlineVideoPlayer,
    /// 在线 B 站预览默认使用内置播放器，可手动切到哔哩哔哩官方播放器。
    #[serde(default)]
    pub bilibili_preview_player: OnlineVideoPlayer,
    #[serde(default = "default_filename_template")]
    pub filename_template: String,
    #[serde(default = "default_concurrent")]
    pub concurrent_downloads: u32,
    #[serde(default = "yes")]
    pub auto_analyze: bool,
    /// Resource policy for automatic BPM/key/library work. `auto_analyze` remains on the wire for
    /// old settings files and clients; both fields are normalised at the config boundary.
    #[serde(default)]
    pub auto_analysis_mode: AutoAnalysisMode,
    /// 旧版兼容字段；下载完成后现在始终缓存可用歌词。
    #[serde(default = "yes")]
    pub download_lyrics: bool,
    #[serde(default)]
    pub write_tags_after_analyze: bool,
    #[serde(default = "default_analysis_duration")]
    pub analysis_duration: f64,
    #[serde(default = "default_theme")]
    pub theme: Theme,
    #[serde(default)]
    pub soundcloud_enabled: bool,
    #[serde(default)]
    pub netease_use_download_api: bool,
    #[serde(default = "default_video_height")]
    pub video_max_height: i64,
    #[serde(default)]
    pub video_transcode: bool,
    /// 旧版视频目录字段，仅为兼容已有配置保留；下载统一使用 download_dir。
    #[serde(default = "default_video_dir")]
    pub video_download_dir: String,
    #[serde(default = "default_video_format")]
    pub video_format: VideoFormat,
    /// 平台按钮的显示顺序 = 下载来源优先级（前端拖动排序后存这里）
    #[serde(default = "default_platform_priority")]
    pub platform_priority: Vec<String>,
    /// 搜索时勾选的来源平台（前端点选后存这里；与排序独立）
    #[serde(default = "default_search_platforms")]
    pub search_platforms: Vec<String>,
    /// 设置里开启的下载/搜索源。未开启的在搜索条里灰掉，搜不到也下不了。
    /// 缺省字段见 `load()` 里的旧配置迁移；全新安装默认只有网易云 + QQ。
    #[serde(default = "default_enabled_platforms")]
    pub enabled_platforms: Vec<String>,
    /// 入队后是否立刻开始下载。DJ 常常先攒一批再统一下，默认攒着。
    #[serde(default)]
    pub auto_start_downloads: bool,
    /// 播放条默认展示分析波形；可切回传统进度条，给偏好简洁界面的用户。
    #[serde(default = "yes")]
    pub player_waveform: bool,
    /// Performance 双极滤波器的共振档位；缺省为高，旧版固定 Q=0.72 对应低档。
    #[serde(default)]
    pub filter_resonance: FilterResonance,
    /// 本地曲目列表与播放控制共用的调性显示方式；数据层始终保留两种表示。
    #[serde(default)]
    pub key_notation: KeyNotation,
}

impl Settings {
    pub fn with_download_dir(dir: &Path) -> Self {
        let download = dir.to_string_lossy().into_owned();
        Settings {
            download_dir: download.clone(),
            library_dirs: Vec::new(),
            default_quality: Quality::Flac,
            stream_quality: Quality::Q128,
            stream_cache_enabled: false,
            video_playback_max_height: default_video_playback_height(),
            youtube_preview_player: OnlineVideoPlayer::Kdj,
            bilibili_preview_player: OnlineVideoPlayer::Kdj,
            filename_template: default_filename_template(),
            concurrent_downloads: default_concurrent(),
            auto_analyze: true,
            auto_analysis_mode: AutoAnalysisMode::Light,
            download_lyrics: true,
            write_tags_after_analyze: false,
            analysis_duration: default_analysis_duration(),
            theme: default_theme(),
            soundcloud_enabled: false,
            netease_use_download_api: false,
            video_max_height: default_video_height(),
            video_transcode: false,
            // 与 download_dir 对齐，避免再走 default_video_dir()→directories（安卓会炸）
            video_download_dir: download,
            video_format: default_video_format(),
            platform_priority: default_platform_priority(),
            search_platforms: default_search_platforms(),
            enabled_platforms: default_enabled_platforms(),
            auto_start_downloads: false,
            player_waveform: true,
            filter_resonance: FilterResonance::High,
            key_notation: KeyNotation::Camelot,
        }
    }
}

fn yes() -> bool {
    true
}
fn default_stream_quality() -> Quality {
    Quality::Q128
}
fn default_video_playback_height() -> i64 {
    1080
}
fn default_filename_template() -> String {
    "{title} - {artist}".to_string()
}
fn default_concurrent() -> u32 {
    3
}
fn default_analysis_duration() -> f64 {
    90.0
}
fn default_theme() -> Theme {
    Theme::Light
}
fn default_video_height() -> i64 {
    1080
}
fn default_video_format() -> VideoFormat {
    VideoFormat::Mp4
}
fn default_platform_priority() -> Vec<String> {
    vec![
        "wyy".to_string(),
        "qqm".to_string(),
        "soundcloud".to_string(),
        "ytm".to_string(),
        "youtube".to_string(),
        "bilibili".to_string(),
        "local".to_string(),
    ]
}
fn default_search_platforms() -> Vec<String> {
    vec!["wyy".to_string(), "qqm".to_string()]
}

fn default_enabled_platforms() -> Vec<String> {
    vec!["wyy".to_string(), "qqm".to_string()]
}

/// 旧 settings.json 没有 `enabled_platforms` 时：按以前「能用的源」推断，避免升级后突然关掉 B 站。
fn migrate_enabled_platforms(settings: &mut Settings, raw: &Value) {
    if raw
        .as_object()
        .and_then(|map| map.get("enabled_platforms"))
        .is_some()
    {
        return;
    }
    let mut enabled = settings.search_platforms.clone();
    if enabled.is_empty() {
        enabled = vec!["wyy".to_string(), "qqm".to_string(), "bilibili".to_string()];
    }
    if settings.soundcloud_enabled && !enabled.iter().any(|id| id == "soundcloud") {
        enabled.push("soundcloud".to_string());
    }
    settings.enabled_platforms = enabled;
}

/// 与 SoundCloud 旧开关双向对齐：列表里有 soundcloud ↔ soundcloud_enabled。
fn sync_soundcloud_flag(settings: &mut Settings) {
    settings.soundcloud_enabled = settings
        .enabled_platforms
        .iter()
        .any(|id| id == "soundcloud");
}

fn migrate_auto_analysis_mode(settings: &mut Settings, raw: &Value) {
    let has_valid_mode = raw
        .as_object()
        .and_then(|map| map.get("auto_analysis_mode"))
        .and_then(Value::as_str)
        .is_some_and(|mode| matches!(mode, "light" | "full" | "paused"));
    if !has_valid_mode {
        settings.auto_analysis_mode = if settings.auto_analyze {
            AutoAnalysisMode::Light
        } else {
            AutoAnalysisMode::Paused
        };
    }
    settings.auto_analyze = settings.auto_analysis_mode.enabled();
}
fn default_video_dir() -> String {
    default_download_root().to_string_lossy().into_owned()
}

/// 系统的「下载」目录。Windows / Linux 上这个目录可能被本地化或挪过位置
/// （XDG、注册表），必须问系统而不是拼死 `~/Downloads`；问不到才退回去。
///
/// **安卓/iOS 不要走 `directories`**：部分链路会间接碰到尚未初始化的
/// `ndk-context`，直接 abort（真机 log：`android context was not initialized`）。
/// 移动端应由 Tauri PathResolver 给沙箱路径；这里只作最后兜底。
pub fn system_download_dir() -> PathBuf {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return home_dir().join("Download");
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        directories::UserDirs::new()
            .and_then(|dirs| dirs.download_dir().map(Path::to_path_buf))
            .unwrap_or_else(|| home_dir().join("Downloads"))
    }
}

/// 全新安装的默认下载落点：系统「下载」目录下的 KDJ 子目录。
/// 直接落在下载根目录会和浏览器下载互相淹没。
/// 用户在设置里改过之后走 settings.json 里存的那份（见 `AppConfig::create`）。
pub fn default_download_root() -> PathBuf {
    system_download_dir().join("KDJ")
}

pub fn home_dir() -> PathBuf {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // 优先环境变量；都没有就用相对路径，避免 directories/ndk。
        if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
            return PathBuf::from(home);
        }
        if let Some(dir) = std::env::var_os("ANDROID_DATA").filter(|h| !h.is_empty()) {
            return PathBuf::from(dir);
        }
        return PathBuf::from(".");
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        directories::UserDirs::new()
            .map(|dirs| dirs.home_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

/// `~` 展开。Python 版每个路径都过了 `Path.expanduser()`，这里补齐同样的行为。
pub fn expand_user(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" {
        return home_dir();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(trimmed)
}

/// 进程内唯一的一份配置。
///
/// 注意 `download_dir` 在这里是 PathBuf、在 `Settings` 里是 String，
/// 转换只发生在 `to_settings` / `apply_settings` 两个边界上。
#[derive(Debug)]
pub struct AppConfig {
    pub data_dir: PathBuf,
    pub host: String,
    /// 0 = 让 OS 分配空闲端口（Tauri 内嵌时的默认做法）
    pub port: u16,
    inner: RwLock<Inner>,
    /// 比 `inner` 的写锁覆盖得更宽：一次设置提交从比较、落盘到发布内存状态必须串行。
    /// 否则两个 PUT 会共同争抢临时文件，并且先返回的请求可能读到后一个请求的状态。
    settings_write: Mutex<()>,
}

#[derive(Debug)]
struct Inner {
    download_dir: PathBuf,
    settings: Settings,
}

impl AppConfig {
    /// 建配置：默认值 → 叠加 settings.json。
    ///
    /// 传进来的 `download_dir` 只是**默认值**：用户在设置界面改过之后
    /// settings.json 里的值优先，否则每次启动都会被覆盖回去。
    pub fn create(data_dir: PathBuf, download_dir: PathBuf, port: u16) -> Self {
        let data_dir = expand_user(&data_dir.to_string_lossy());
        let download_dir = expand_user(&download_dir.to_string_lossy());
        let config = AppConfig {
            data_dir,
            host: "127.0.0.1".to_string(),
            port,
            inner: RwLock::new(Inner {
                settings: Settings::with_download_dir(&download_dir),
                download_dir,
            }),
            settings_write: Mutex::new(()),
        };
        config.ensure_dirs();
        config.load();
        config.ensure_dirs();
        config
    }

    // ------------------------------------------------------------ 派生路径

    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join(SETTINGS_FILENAME)
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join(DB_FILENAME)
    }

    pub fn sessions_dir(&self) -> PathBuf {
        self.data_dir.join("sessions")
    }

    pub fn download_dir(&self) -> PathBuf {
        self.inner.read().unwrap().download_dir.clone()
    }

    /// 音频与视频统一落到同一个默认下载目录。
    pub fn video_dir(&self) -> PathBuf {
        self.download_dir()
    }

    pub fn to_settings(&self) -> Settings {
        let guard = self.inner.read().unwrap();
        let mut settings = guard.settings.clone();
        settings.download_dir = guard.download_dir.to_string_lossy().into_owned();
        settings
    }

    pub fn ensure_dirs(&self) {
        for path in [
            self.data_dir.clone(),
            self.sessions_dir(),
            self.download_dir(),
            self.video_dir(),
        ] {
            if let Err(err) = std::fs::create_dir_all(&path) {
                tracing::warn!("创建目录失败 {}：{err}", path.display());
            }
        }
    }

    // ------------------------------------------------------------ 读写

    /// 用一份完整 Settings 覆盖当前配置并落盘。
    ///
    /// 磁盘提交成功之前绝不发布到运行内存；调用方因此可以把 `Ok` 当作“重启后仍成立”
    /// 的承诺，而不是仅代表当前进程暂时改过。
    pub fn apply_settings(&self, settings: Settings) -> Result<Settings> {
        let _write = self
            .settings_write
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut next = settings;
        sync_soundcloud_flag(&mut next);
        let current = self.to_settings();
        // An older client only knows the boolean. Resolve impossible mixed states at the boundary:
        // false always means paused; true + paused means the legacy client is resuming in Light.
        if !next.auto_analyze {
            next.auto_analysis_mode = AutoAnalysisMode::Paused;
        } else if next.auto_analysis_mode == AutoAnalysisMode::Paused {
            next.auto_analysis_mode = AutoAnalysisMode::Light;
        }
        next.auto_analyze = next.auto_analysis_mode.enabled();
        // 对外返回和落盘都使用展开后的确定路径；相同 PUT 不应白写 settings.json。
        next.download_dir = expand_user(&next.download_dir)
            .to_string_lossy()
            .into_owned();
        if current == next {
            return Ok(current);
        }
        if current.download_dir != next.download_dir {
            verify_writable_directory(Path::new(&next.download_dir))?;
        }
        self.persist_settings(&next)?;
        {
            let mut guard = self.inner.write().unwrap();
            guard.download_dir = expand_user(&next.download_dir);
            guard.settings = next;
        }
        Ok(self.to_settings())
    }

    /// 从 settings.json 覆盖当前值；文件不存在 / 损坏时保持默认值。
    pub fn load(&self) {
        let path = self.settings_path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                tracing::warn!("settings.json 检查失败，使用默认设置：{error}");
                return;
            }
        };
        if !metadata.file_type().is_file()
            || metadata.len() == 0
            || metadata.len() > SETTINGS_MAX_BYTES
        {
            quarantine_invalid_settings(&path, "文件类型或大小无效");
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            if let Err(error) = fs::set_permissions(&path, fs::Permissions::from_mode(0o600)) {
                tracing::warn!("保护 settings.json 失败 {}：{error}", path.display());
            }
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
            Err(err) if err.kind() == std::io::ErrorKind::InvalidData => {
                quarantine_invalid_settings(&path, "文件不是 UTF-8");
                return;
            }
            Err(err) => {
                tracing::warn!("settings.json 读取失败，使用默认设置：{err}");
                return;
            }
        };
        let raw: Value = match serde_json::from_str(&text) {
            Ok(Value::Object(map)) => Value::Object(map),
            Ok(_) => {
                quarantine_invalid_settings(&path, "JSON 根不是对象");
                return;
            }
            Err(err) => {
                quarantine_invalid_settings(&path, &format!("JSON 解析失败：{err}"));
                return;
            }
        };

        let base = serde_json::to_value(self.to_settings()).expect("Settings 一定可序列化");
        let merged = merge_settings(&base, &raw);
        let mut settings: Settings = match serde_json::from_value(merged) {
            Ok(settings) => settings,
            Err(_) => merge_field_by_field(&base, &raw),
        };
        migrate_enabled_platforms(&mut settings, &raw);
        migrate_auto_analysis_mode(&mut settings, &raw);
        sync_soundcloud_flag(&mut settings);

        let mut guard = self.inner.write().unwrap();
        guard.download_dir = expand_user(&settings.download_dir);
        guard.settings = settings;
    }

    fn persist_settings(&self, settings: &Settings) -> Result<()> {
        let path = self.settings_path();
        let parent = path.parent().context("settings.json 缺少父目录")?;
        fs::create_dir_all(parent)
            .with_context(|| format!("创建设置目录失败：{}", parent.display()))?;
        let body = serde_json::to_vec_pretty(settings).context("序列化 settings.json 失败")?;
        let mut temporary = None;
        for _ in 0..32 {
            let sequence = SETTINGS_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let tmp = parent.join(format!(
                ".{SETTINGS_FILENAME}.tmp-{}-{sequence}",
                std::process::id()
            ));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            match options.open(&tmp) {
                Ok(file) => {
                    temporary = Some((tmp, file));
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("创建设置临时文件失败：{}", tmp.display()))
                }
            }
        }
        let (tmp, mut file) = temporary.context("无法为 settings.json 分配唯一临时文件")?;
        let write_result = (|| -> Result<()> {
            file.write_all(&body)
                .and_then(|_| file.write_all(b"\n"))
                .with_context(|| format!("写入设置临时文件失败：{}", tmp.display()))?;
            file.sync_all()
                .with_context(|| format!("同步设置临时文件失败：{}", tmp.display()))?;
            drop(file);
            commit_settings_temp(&tmp, &path)?;
            #[cfg(unix)]
            if let Ok(directory) = fs::File::open(parent) {
                if let Err(error) = directory.sync_all() {
                    // rename 已是提交点；此时再向调用方报失败会造成“磁盘新、内存旧”。
                    tracing::warn!("同步设置目录失败 {}：{error}", parent.display());
                }
            }
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        write_result
    }
}

fn quarantine_invalid_settings(path: &Path, reason: &str) {
    let Some(parent) = path.parent() else {
        tracing::warn!("settings.json 已损坏（{reason}），但没有可用父目录");
        return;
    };
    for _ in 0..32 {
        let sequence = SETTINGS_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let quarantine = parent.join(format!(
            "{SETTINGS_FILENAME}.corrupt-{}-{sequence}",
            std::process::id()
        ));
        if quarantine.exists() {
            continue;
        }
        match fs::rename(path, &quarantine) {
            Ok(()) => {
                tracing::warn!(
                    "settings.json 已损坏（{reason}），已隔离到 {}",
                    quarantine.display()
                );
                return;
            }
            Err(error) => {
                tracing::warn!(
                    "settings.json 已损坏（{reason}），隔离失败 {}：{error}",
                    path.display()
                );
                return;
            }
        }
    }
    tracing::warn!("settings.json 已损坏（{reason}），但无法分配隔离文件名");
}

#[cfg(not(windows))]
fn commit_settings_temp(tmp: &Path, path: &Path) -> Result<()> {
    fs::rename(tmp, path).with_context(|| format!("提交 settings.json 失败：{}", path.display()))
}

#[cfg(windows)]
fn commit_settings_temp(tmp: &Path, path: &Path) -> Result<()> {
    if !path.exists() {
        return fs::rename(tmp, path)
            .with_context(|| format!("提交 settings.json 失败：{}", path.display()));
    }
    let parent = path.parent().context("settings.json 缺少父目录")?;
    let sequence = SETTINGS_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let backup = parent.join(format!(
        ".{SETTINGS_FILENAME}.backup-{}-{sequence}",
        std::process::id()
    ));
    fs::rename(path, &backup)
        .with_context(|| format!("暂存旧 settings.json 失败：{}", path.display()))?;
    if let Err(commit_error) = fs::rename(tmp, path) {
        if let Err(restore_error) = fs::rename(&backup, path) {
            anyhow::bail!(
                "提交新 settings.json 失败：{commit_error}；恢复旧设置也失败：{restore_error}；旧设置保留在 {}",
                backup.display()
            );
        }
        return Err(commit_error)
            .with_context(|| format!("提交 settings.json 失败：{}", path.display()));
    }
    if let Err(error) = fs::remove_file(&backup) {
        tracing::warn!(
            "清理旧 settings.json 备份失败 {}：{error}",
            backup.display()
        );
    }
    Ok(())
}

/// 新下载目录在接受设置之前做一次真实的创建/写入探测。只探测“刚切换到”的目录，
/// 已配置但暂时离线的外置盘不会挡住主题等无关设置。
fn verify_writable_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("创建下载目录失败：{}", path.display()))?;
    let sequence = SETTINGS_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let probe = path.join(format!(
        ".kdj-write-probe-{}-{sequence}",
        std::process::id()
    ));
    let result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .and_then(|file| file.sync_all())
        .with_context(|| format!("下载目录不可写：{}", path.display()));
    let _ = fs::remove_file(&probe);
    result
}

/// 把 raw 里出现过的字段盖到 base 上（null 视为"没写"）。
fn merge_settings(base: &Value, raw: &Value) -> Value {
    let mut out = base.as_object().cloned().unwrap_or_default();
    if let Some(raw) = raw.as_object() {
        for name in SETTINGS_FIELDS {
            match raw.get(*name) {
                Some(value) if !value.is_null() => {
                    out.insert((*name).to_string(), value.clone());
                }
                _ => {}
            }
        }
    }
    Value::Object(out)
}

/// 整份校验失败时逐字段重试。
///
/// 老版本写进去的非法枚举值（比如已经下线的音质档）不应该把用户其他设置一起清空。
fn merge_field_by_field(base: &Value, raw: &Value) -> Settings {
    let mut current = base.as_object().cloned().unwrap_or_default();
    if let Some(raw) = raw.as_object() {
        for name in SETTINGS_FIELDS {
            let Some(value) = raw.get(*name) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            let mut probe = current.clone();
            probe.insert((*name).to_string(), value.clone());
            match serde_json::from_value::<Settings>(Value::Object(probe.clone())) {
                Ok(_) => current = probe,
                Err(err) => tracing::warn!("settings.json 字段 {name} 非法，已忽略：{err}"),
            }
        }
    }
    serde_json::from_value(Value::Object(current)).expect("base 一定是合法 Settings")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kdj-cfg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_keeps_defaults() {
        let dir = scratch("missing");
        let config = AppConfig::create(dir.join("data"), dir.join("dl"), 0);
        assert_eq!(config.to_settings().default_quality, Quality::Flac);
        assert_eq!(config.to_settings().concurrent_downloads, 3);
        assert_eq!(
            config.to_settings().auto_analysis_mode,
            AutoAnalysisMode::Light,
            "全新安装默认慢速让路"
        );
        assert_eq!(config.to_settings().filter_resonance, FilterResonance::High);
        assert_eq!(config.to_settings().key_notation, KeyNotation::Camelot);
        assert_eq!(
            config.to_settings().youtube_preview_player,
            OnlineVideoPlayer::Kdj
        );
        assert_eq!(
            config.to_settings().bilibili_preview_player,
            OnlineVideoPlayer::Kdj
        );
    }

    #[test]
    fn one_bad_field_does_not_wipe_the_rest() {
        // 用户手改坏了 default_quality，其余设置必须原样保留
        let dir = scratch("badfield");
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            data.join(SETTINGS_FILENAME),
            r#"{"default_quality":"ultra-hd-9000","filter_resonance":"unknown","concurrent_downloads":7,"auto_analyze":false}"#,
        )
        .unwrap();

        let config = AppConfig::create(data, dir.join("dl"), 0);
        let settings = config.to_settings();
        assert_eq!(
            settings.default_quality,
            Quality::Flac,
            "非法字段回落默认值"
        );
        assert_eq!(settings.filter_resonance, FilterResonance::High);
        assert_eq!(settings.concurrent_downloads, 7, "合法字段必须留下");
        assert!(!settings.auto_analyze, "合法字段必须留下");
        assert_eq!(settings.auto_analysis_mode, AutoAnalysisMode::Paused);
    }

    #[test]
    fn corrupt_settings_are_quarantined_instead_of_being_overwritten_later() {
        let dir = scratch("corrupt");
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let settings_path = data.join(SETTINGS_FILENAME);
        std::fs::write(&settings_path, b"{ definitely not json").unwrap();

        let config = AppConfig::create(data.clone(), dir.join("dl"), 0);

        assert_eq!(config.to_settings().default_quality, Quality::Flac);
        assert!(!settings_path.exists());
        assert!(std::fs::read_dir(&data)
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("settings.json.corrupt-")));
    }

    #[test]
    fn legacy_auto_analyze_true_migrates_to_light_mode() {
        let dir = scratch("legacy-analysis-mode");
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join(SETTINGS_FILENAME), r#"{"auto_analyze":true}"#).unwrap();

        let config = AppConfig::create(data, dir.join("dl"), 0);
        let settings = config.to_settings();
        assert!(settings.auto_analyze);
        assert_eq!(settings.auto_analysis_mode, AutoAnalysisMode::Light);
    }

    #[test]
    fn legacy_boolean_update_still_controls_the_new_mode() {
        let dir = scratch("legacy-analysis-update");
        let config = AppConfig::create(dir.join("data"), dir.join("dl"), 0);
        let mut settings = config.to_settings();
        settings.auto_analyze = false;

        let saved = config.apply_settings(settings).unwrap();
        assert!(!saved.auto_analyze);
        assert_eq!(saved.auto_analysis_mode, AutoAnalysisMode::Paused);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = scratch("roundtrip");
        let config = AppConfig::create(dir.join("data"), dir.join("dl"), 0);
        let mut settings = config.to_settings();
        settings.filename_template = "{artist} - {title}".into();
        settings.platform_priority = vec!["bilibili".into(), "wyy".into()];
        settings.stream_cache_enabled = true;
        settings.filter_resonance = FilterResonance::Medium;
        config.apply_settings(settings.clone()).unwrap();

        let reopened = AppConfig::create(dir.join("data"), dir.join("dl"), 0);
        assert_eq!(reopened.to_settings(), settings);
    }

    #[test]
    fn applying_identical_settings_does_not_rewrite_the_file() {
        let dir = scratch("no-rewrite");
        let config = AppConfig::create(dir.join("data"), dir.join("dl"), 0);
        let mut settings = config.to_settings();
        settings.auto_analyze = false;
        config.apply_settings(settings.clone()).unwrap();
        let path = config.settings_path();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));

        config.apply_settings(settings).unwrap();

        let after = std::fs::metadata(path).unwrap().modified().unwrap();
        assert_eq!(before, after, "完全相同的 PUT 不应触碰 settings.json");
    }

    #[test]
    fn cli_download_dir_does_not_override_saved_one() {
        // 命令行给的只是默认值，用户改过就以 settings.json 为准
        let dir = scratch("dldir");
        let config = AppConfig::create(dir.join("data"), dir.join("first"), 0);
        let mut settings = config.to_settings();
        settings.download_dir = dir.join("chosen").to_string_lossy().into_owned();
        config.apply_settings(settings).unwrap();

        let reopened = AppConfig::create(dir.join("data"), dir.join("second"), 0);
        assert_eq!(reopened.download_dir(), dir.join("chosen"));
    }

    #[test]
    fn empty_video_dir_follows_download_dir() {
        let dir = scratch("videodir");
        let config = AppConfig::create(dir.join("data"), dir.join("dl"), 0);
        let mut settings = config.to_settings();
        settings.video_download_dir = dir.join("legacy-video").to_string_lossy().into_owned();
        config.apply_settings(settings).unwrap();
        assert_eq!(config.video_dir(), config.download_dir());
    }

    #[test]
    fn failed_settings_commit_never_changes_runtime_state() {
        let dir = scratch("commit-failure");
        let config = AppConfig::create(dir.join("data"), dir.join("dl"), 0);
        let before = config.to_settings();
        std::fs::remove_dir_all(&config.data_dir).unwrap();
        std::fs::write(&config.data_dir, b"not a directory").unwrap();
        let mut next = before.clone();
        next.theme = Theme::Dark;

        let error = config.apply_settings(next).unwrap_err();

        assert!(error.to_string().contains("设置目录"));
        assert_eq!(config.to_settings(), before, "落盘失败不能污染当前进程状态");
    }

    #[test]
    fn concurrent_settings_commits_leave_one_complete_reloadable_file() {
        let dir = scratch("concurrent-commit");
        let config = std::sync::Arc::new(AppConfig::create(dir.join("data"), dir.join("dl"), 0));
        let mut workers = Vec::new();
        for index in 0..16 {
            let config = config.clone();
            workers.push(std::thread::spawn(move || {
                let mut next = config.to_settings();
                next.filename_template = format!("template-{index}");
                let saved = config.apply_settings(next).unwrap();
                assert_eq!(saved.filename_template, format!("template-{index}"));
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }

        let live = config.to_settings();
        let reopened = AppConfig::create(dir.join("data"), dir.join("fallback"), 0);
        assert_eq!(reopened.to_settings(), live);
        assert!(
            std::fs::read_dir(dir.join("data"))
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp-")),
            "成功提交后不能遗留设置临时文件"
        );
    }
}
