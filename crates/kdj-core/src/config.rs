//! 运行期配置：`Settings` 是前后端契约的一部分，`AppConfig` 是它加上进程级参数。
//!
//! settings.json 落在 data_dir 下。读写规则原样沿用 Python 版：
//! - 读：缺字段用默认值补齐；**单个字段值非法只丢弃这个字段**，不能让整份配置作废。
//! - 写：先写 `.tmp` 再 rename 原子替换——直接覆写时进程被 kill 会留下半截 JSON。

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::{Quality, Theme, VideoFormat};

pub const SETTINGS_FILENAME: &str = "settings.json";
pub const DB_FILENAME: &str = "kdj.db";

/// settings.json 里出现过的所有字段名。field-by-field 降级解析要用。
const SETTINGS_FIELDS: &[&str] = &[
    "download_dir",
    "library_dirs",
    "default_quality",
    "filename_template",
    "concurrent_downloads",
    "auto_analyze",
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
    "auto_start_downloads",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub download_dir: String,
    #[serde(default)]
    pub library_dirs: Vec<String>,
    #[serde(default)]
    pub default_quality: Quality,
    #[serde(default = "default_filename_template")]
    pub filename_template: String,
    #[serde(default = "default_concurrent")]
    pub concurrent_downloads: u32,
    #[serde(default = "yes")]
    pub auto_analyze: bool,
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
    /// 视频单独一个下载目录：视频动辄几百 MB，混进音乐目录会把曲库扫描搅乱。
    #[serde(default = "default_video_dir")]
    pub video_download_dir: String,
    #[serde(default = "default_video_format")]
    pub video_format: VideoFormat,
    /// 平台按钮的显示顺序 = 下载来源优先级（前端拖动排序后存这里）
    #[serde(default = "default_platform_priority")]
    pub platform_priority: Vec<String>,
    /// 入队后是否立刻开始下载。DJ 常常先攒一批再统一下，默认攒着。
    #[serde(default)]
    pub auto_start_downloads: bool,
}

impl Settings {
    pub fn with_download_dir(dir: &Path) -> Self {
        Settings {
            download_dir: dir.to_string_lossy().into_owned(),
            library_dirs: Vec::new(),
            default_quality: Quality::Flac,
            filename_template: default_filename_template(),
            concurrent_downloads: default_concurrent(),
            auto_analyze: true,
            write_tags_after_analyze: false,
            analysis_duration: default_analysis_duration(),
            theme: default_theme(),
            soundcloud_enabled: false,
            netease_use_download_api: false,
            video_max_height: default_video_height(),
            video_transcode: false,
            video_download_dir: default_video_dir(),
            video_format: default_video_format(),
            platform_priority: default_platform_priority(),
            auto_start_downloads: false,
        }
    }
}

fn yes() -> bool {
    true
}
fn default_filename_template() -> String {
    "{title} - {artist}".to_string()
}
fn default_concurrent() -> u32 {
    3
}
fn default_analysis_duration() -> f64 {
    240.0
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
        "bilibili".to_string(),
    ]
}
fn default_video_dir() -> String {
    default_download_root().to_string_lossy().into_owned()
}

/// 系统的「下载」目录。Windows / Linux 上这个目录可能被本地化或挪过位置
/// （XDG、注册表），必须问系统而不是拼死 `~/Downloads`；问不到才退回去。
pub fn system_download_dir() -> PathBuf {
    directories::UserDirs::new()
        .and_then(|dirs| dirs.download_dir().map(Path::to_path_buf))
        .unwrap_or_else(|| home_dir().join("Downloads"))
}

/// 全新安装的默认下载落点：系统「下载」目录下的 KDJ 子目录。
/// 直接落在下载根目录会和浏览器下载互相淹没。
/// 用户在设置里改过之后走 settings.json 里存的那份（见 `AppConfig::create`）。
pub fn default_download_root() -> PathBuf {
    system_download_dir().join("KDJ")
}

pub fn home_dir() -> PathBuf {
    directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
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

    /// 视频下载目录。留空 = 跟随音频下载目录（老配置升上来就是这种情况）。
    pub fn video_dir(&self) -> PathBuf {
        let guard = self.inner.read().unwrap();
        let raw = guard.settings.video_download_dir.trim();
        if raw.is_empty() {
            guard.download_dir.clone()
        } else {
            expand_user(raw)
        }
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
    pub fn apply_settings(&self, settings: Settings) -> Settings {
        {
            let mut guard = self.inner.write().unwrap();
            guard.download_dir = expand_user(&settings.download_dir);
            guard.settings = settings;
        }
        self.ensure_dirs();
        self.save();
        self.to_settings()
    }

    /// 从 settings.json 覆盖当前值；文件不存在 / 损坏时保持默认值。
    pub fn load(&self) {
        let path = self.settings_path();
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
            Err(err) => {
                tracing::warn!("settings.json 读取失败，使用默认设置：{err}");
                return;
            }
        };
        let raw: Value = match serde_json::from_str(&text) {
            Ok(Value::Object(map)) => Value::Object(map),
            Ok(_) => {
                tracing::warn!("settings.json 不是对象，忽略");
                return;
            }
            Err(err) => {
                tracing::warn!("settings.json 解析失败，使用默认设置：{err}");
                return;
            }
        };

        let base = serde_json::to_value(self.to_settings()).expect("Settings 一定可序列化");
        let merged = merge_settings(&base, &raw);
        let settings: Settings = match serde_json::from_value(merged) {
            Ok(settings) => settings,
            Err(_) => merge_field_by_field(&base, &raw),
        };

        let mut guard = self.inner.write().unwrap();
        guard.download_dir = expand_user(&settings.download_dir);
        guard.settings = settings;
    }

    pub fn save(&self) {
        let settings = self.to_settings();
        let path = self.settings_path();
        let tmp = path.with_extension("json.tmp");
        let body = match serde_json::to_string_pretty(&settings) {
            Ok(body) => body,
            Err(err) => {
                tracing::warn!("settings.json 序列化失败：{err}");
                return;
            }
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // 先写 .tmp 再 rename：直接覆写时进程被 kill 会留下半截 JSON。
        if let Err(err) = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &path)) {
            tracing::warn!("settings.json 写入失败：{err}");
            let _ = std::fs::remove_file(&tmp);
        }
    }
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
            let Some(value) = raw.get(*name) else { continue };
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
    }

    #[test]
    fn one_bad_field_does_not_wipe_the_rest() {
        // 用户手改坏了 default_quality，其余设置必须原样保留
        let dir = scratch("badfield");
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            data.join(SETTINGS_FILENAME),
            r#"{"default_quality":"ultra-hd-9000","concurrent_downloads":7,"auto_analyze":false}"#,
        )
        .unwrap();

        let config = AppConfig::create(data, dir.join("dl"), 0);
        let settings = config.to_settings();
        assert_eq!(settings.default_quality, Quality::Flac, "非法字段回落默认值");
        assert_eq!(settings.concurrent_downloads, 7, "合法字段必须留下");
        assert!(!settings.auto_analyze, "合法字段必须留下");
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = scratch("roundtrip");
        let config = AppConfig::create(dir.join("data"), dir.join("dl"), 0);
        let mut settings = config.to_settings();
        settings.filename_template = "{artist} - {title}".into();
        settings.platform_priority = vec!["bilibili".into(), "wyy".into()];
        config.apply_settings(settings.clone());

        let reopened = AppConfig::create(dir.join("data"), dir.join("dl"), 0);
        assert_eq!(reopened.to_settings(), settings);
    }

    #[test]
    fn cli_download_dir_does_not_override_saved_one() {
        // 命令行给的只是默认值，用户改过就以 settings.json 为准
        let dir = scratch("dldir");
        let config = AppConfig::create(dir.join("data"), dir.join("first"), 0);
        let mut settings = config.to_settings();
        settings.download_dir = dir.join("chosen").to_string_lossy().into_owned();
        config.apply_settings(settings);

        let reopened = AppConfig::create(dir.join("data"), dir.join("second"), 0);
        assert_eq!(reopened.download_dir(), dir.join("chosen"));
    }

    #[test]
    fn empty_video_dir_follows_download_dir() {
        let dir = scratch("videodir");
        let config = AppConfig::create(dir.join("data"), dir.join("dl"), 0);
        let mut settings = config.to_settings();
        settings.video_download_dir = "  ".into();
        config.apply_settings(settings);
        assert_eq!(config.video_dir(), config.download_dir());
    }
}
