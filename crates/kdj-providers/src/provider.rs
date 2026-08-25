//! provider 抽象层。
//!
//! 各平台的形状差得比想象中多：网易云/QQ 是"搜索 → 拿直链 → 下音频"，
//! B 站/YouTube 是视频流，YTM 是音乐 InnerTube，SoundCloud 另走 OAuth。
//! 所以这个 trait 的设计原则是**让能力差异显式化**（`Capabilities`），
//! 而不是逼着 B 站假装自己是音乐平台、再在实现里到处抛 "不支持"。
//!
//! 聚合排序（平台优先级、分档、跨平台去重）留在 trait **之上**——
//! provider 不知道别人的存在，加第五个平台不用改任何已有实现。

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::Result;
use async_trait::async_trait;
use kdj_core::models::{
    Account, CollectionResolveResponse, CollectionResult, LyricText, Platform, QrSession,
    QrStateValue, Quality, ResolveResponse, SearchKind, SongSource, StreamPlaylist,
    StreamPlaylistResponse,
};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// 下载过程中会读到的可变设置。放进 `Arc<RwLock<_>>`，所有 provider 的
/// `ProviderContext` clone 共享同一份——改设置不用重建 provider，也不会继续
/// 往启动时的旧目录里灌文件（用户以为「下到 A，结果歌在 B / 列表里消失」）。
#[derive(Debug, Clone)]
pub struct ProviderLiveSettings {
    pub download_dir: PathBuf,
    pub filename_template: String,
    pub default_quality: Quality,
    pub netease_use_download_api: bool,
    pub soundcloud_enabled: bool,
    pub soundcloud_client_id: String,
    pub soundcloud_client_secret: String,
    /// YouTube Music 是否在「下载源」里开启。
    pub ytm_enabled: bool,
    /// 普通 YouTube 视频是否在「下载源」里开启；与 YTM 独立控制。
    pub youtube_enabled: bool,
    /// 视频单独的落盘目录。None = 跟随 download_dir。
    pub video_dir: Option<PathBuf>,
    pub video_format: String,
}

/// provider 需要的全部外部配置，由上层从 `Settings` 组装后注入。
///
/// provider 不读全局配置、不落自己的 settings 文件——这样才好测试、好多实例。
#[derive(Debug, Clone)]
pub struct ProviderContext {
    pub data_dir: PathBuf,
    live: Arc<RwLock<ProviderLiveSettings>>,
}

impl ProviderContext {
    pub fn new(data_dir: PathBuf, live: ProviderLiveSettings) -> Self {
        Self {
            data_dir,
            live: Arc::new(RwLock::new(live)),
        }
    }

    /// 刷新所有共享这份 context 的 provider 看到的下载目录 / 模板等。
    pub fn apply_live(&self, live: ProviderLiveSettings) {
        *self
            .live
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = live;
    }

    fn live(&self) -> std::sync::RwLockReadGuard<'_, ProviderLiveSettings> {
        self.live
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn download_dir(&self) -> PathBuf {
        self.live().download_dir.clone()
    }

    pub fn filename_template(&self) -> String {
        self.live().filename_template.clone()
    }

    pub fn default_quality(&self) -> Quality {
        self.live().default_quality
    }

    pub fn netease_use_download_api(&self) -> bool {
        self.live().netease_use_download_api
    }

    pub fn soundcloud_enabled(&self) -> bool {
        self.live().soundcloud_enabled
    }

    pub fn soundcloud_client_id(&self) -> String {
        self.live().soundcloud_client_id.clone()
    }

    pub fn soundcloud_client_secret(&self) -> String {
        self.live().soundcloud_client_secret.clone()
    }

    pub fn ytm_enabled(&self) -> bool {
        self.live().ytm_enabled
    }

    pub fn youtube_enabled(&self) -> bool {
        self.live().youtube_enabled
    }

    pub fn video_format(&self) -> String {
        self.live().video_format.clone()
    }

    /// 各平台登录态落盘目录。
    pub fn session_dir(&self) -> PathBuf {
        self.data_dir.join("sessions")
    }

    /// 下载落盘目录。直接用设置里的下载根目录，不再按平台分子目录。
    pub fn platform_dir(&self, _platform: Platform) -> std::io::Result<PathBuf> {
        let target = self.download_dir();
        std::fs::create_dir_all(&target)?;
        Ok(target)
    }

    /// 视频落盘目录。和音频分开：视频动辄几百 MB，混进音乐目录会被曲库扫描一起扫走。
    pub fn video_output_dir(&self) -> std::io::Result<PathBuf> {
        let live = self.live();
        let target = live
            .video_dir
            .clone()
            .unwrap_or_else(|| live.download_dir.clone());
        drop(live);
        std::fs::create_dir_all(&target)?;
        Ok(target)
    }

    pub fn session_file(&self, name: &str) -> PathBuf {
        self.session_dir().join(name)
    }
}

/// provider 的能力声明。前端据此决定显示什么按钮——
/// 硬编码平台名单迟早和后端漂移，所以让 provider 自己说。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    /// 有没有扫码登录
    pub supports_login: bool,
    /// 有没有"音质档"概念（B 站没有）
    pub has_quality_tiers: bool,
    /// 下载产物是视频而不是音频
    pub is_video: bool,
    /// provider 真正实现的搜索维度；前端筛选器和后端门禁都读这里。
    pub search_kinds: &'static [SearchKind],
}

pub const SONG_SEARCH_KINDS: &[SearchKind] = &[SearchKind::Song];

impl Capabilities {
    pub const MUSIC: Capabilities = Capabilities {
        supports_login: true,
        has_quality_tiers: true,
        is_video: false,
        search_kinds: SONG_SEARCH_KINDS,
    };
    pub const VIDEO: Capabilities = Capabilities {
        supports_login: true,
        has_quality_tiers: false,
        is_video: true,
        search_kinds: SONG_SEARCH_KINDS,
    };
    pub const ANONYMOUS_MUSIC: Capabilities = Capabilities {
        supports_login: false,
        has_quality_tiers: true,
        is_video: false,
        search_kinds: SONG_SEARCH_KINDS,
    };
}

/// 下载进度回调：(已下载字节, 总字节；总字节未知时为 0)。
pub type ProgressSink = Arc<dyn Fn(u64, u64) + Send + Sync>;

pub fn noop_progress() -> ProgressSink {
    Arc::new(|_, _| {})
}

/// 一次下载请求的全部输入。
///
/// 比 Python 版的四个位置参数好扩展：以后要加"限速""指定输出目录"都不用改 trait 签名。
pub struct DownloadJob<'a> {
    pub source: &'a SongSource,
    /// 请求音质。provider 内部自行按 `Quality::gradient()` 降级。
    pub quality: Quality,
    pub cancel: CancellationToken,
    pub progress: ProgressSink,
}

impl<'a> DownloadJob<'a> {
    pub fn new(source: &'a SongSource, quality: Quality) -> Self {
        DownloadJob {
            source,
            quality,
            cancel: CancellationToken::new(),
            progress: noop_progress(),
        }
    }

    pub fn with_cancel(mut self, cancel: CancellationToken) -> Self {
        self.cancel = cancel;
        self
    }

    pub fn with_progress(mut self, progress: ProgressSink) -> Self {
        self.progress = progress;
        self
    }

    /// 取消检查点。下载循环里每写一块就该调一次。
    pub fn check_canceled(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            anyhow::bail!("下载已取消");
        }
        Ok(())
    }

    pub fn report(&self, downloaded: u64, total: u64) {
        (self.progress)(downloaded, total);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectedPreviewCipher {
    pub signature_cipher: String,
    pub player_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectedPreviewIdentity {
    pub visitor_data: String,
    pub data_sync_id: String,
}

#[async_trait]
pub trait MusicProvider: Send + Sync {
    fn platform(&self) -> Platform;
    fn label(&self) -> &str;
    fn capabilities(&self) -> Capabilities;

    /// 当前登录态。**不要返回 Err**——网络问题一律降级成 `state = unknown`，
    /// 否则前端每次抖动都会把"已登录"闪成"未登录"。
    async fn account(&self) -> Account;

    /// 新建扫码会话。
    async fn create_qr(&self) -> Result<QrSession>;

    /// **非阻塞**地查一次扫码状态。
    async fn poll_qr(&self, session_id: &str) -> Result<(QrStateValue, String)>;

    /// 清空本地登录态。
    async fn logout(&self) -> Result<()>;

    async fn search(&self, keyword: &str, limit: usize) -> Result<Vec<SongSource>>;

    /// 搜索歌单/艺术家/专辑集合。默认不支持，避免把集合 ID 伪装成歌曲 ID。
    async fn search_collections(
        &self,
        _keyword: &str,
        _kind: SearchKind,
        _limit: usize,
    ) -> Result<Vec<CollectionResult>> {
        Ok(Vec::new())
    }

    /// 展开一个歌单/艺术家/专辑集合为真实歌曲来源。
    async fn resolve_collection(
        &self,
        _kind: SearchKind,
        _key: &str,
        _limit: usize,
    ) -> Result<Option<CollectionResolveResponse>> {
        Ok(None)
    }

    /// 登录后可见的平台歌单；没有账号或平台不支持时返回空列表。
    async fn stream_playlists(&self) -> Result<Vec<StreamPlaylist>> {
        Ok(Vec::new())
    }

    /// 读取平台歌单中的真实歌曲来源。
    async fn stream_playlist_tracks(
        &self,
        _key: &str,
        _limit: usize,
    ) -> Result<Option<StreamPlaylistResponse>> {
        Ok(None)
    }

    /// 解析歌曲/歌单链接。
    /// **不是本平台的链接返回 `Ok(None)`**，让上层继续问别的 provider。
    async fn resolve(&self, url: &str, limit: usize) -> Result<Option<ResolveResponse>>;

    /// 下载单曲，返回最终文件路径；失败返回 Err（不要返回空路径）。
    async fn download(&self, job: DownloadJob<'_>) -> Result<PathBuf>;

    /// 试听直链：**最低码率**档的播放地址，给搜索结果里「不下载先听听」用。
    ///
    /// 约定：`Ok(None)` = 这家平台没有试听的形状（B 站的预览走 `/api/video/preview`）；
    /// 拿不到地址（版权/会员）返回 Err 并把原因写清楚。
    /// 地址会直接交给前端的 `<audio src>`，所以必须是浏览器裸 GET 就能放的直链。
    async fn preview_url(&self, source: &SongSource) -> Result<Option<String>> {
        let _ = source;
        Ok(None)
    }

    /// 按播放音质请求试听流。默认平台只有一档或沿用旧的最低码率实现。
    async fn preview_url_at_quality(
        &self,
        source: &SongSource,
        _quality: Quality,
    ) -> Result<Option<String>> {
        self.preview_url(source).await
    }

    /// 需要 WebView 执行当前网页签名器的平台，先返回受保护的 cipher 与脚本地址。
    async fn protected_preview_cipher(
        &self,
        _source: &SongSource,
        _quality: Quality,
        _po_token: &str,
        _identity: &ProtectedPreviewIdentity,
    ) -> Result<Option<ProtectedPreviewCipher>> {
        Ok(None)
    }

    /// 读取上一步返回的受信任播放器脚本；默认平台不支持。
    async fn protected_preview_player_script(&self, _player_url: &str) -> Result<Option<String>> {
        Ok(None)
    }

    /// 从已登录 YouTube Music 页面读取与 Cookie 同一会话的 Visitor/DataSync。
    async fn protected_preview_identity(&self) -> Result<Option<ProtectedPreviewIdentity>> {
        Ok(None)
    }

    /// 固定 YouTube BotGuard Create/GenerateIT RPC；不接受任意 URL。
    async fn protected_preview_botguard(
        &self,
        _operation: &str,
        _payload: &Value,
    ) -> Result<Option<Value>> {
        Ok(None)
    }

    /// 按平台歌曲 id / mid 取 LRC。没有歌词能力的平台默认 `Ok(None)`。
    async fn lyric(&self, key: &str) -> Result<Option<LyricText>> {
        let _ = key;
        Ok(None)
    }
}

/// 没有登录体系的 provider 可以直接复用这几个默认实现。
pub mod no_login {
    use super::*;

    pub fn create_qr(label: &str) -> Result<QrSession> {
        anyhow::bail!("{label} 不需要扫码登录")
    }

    pub fn poll_qr(label: &str) -> (QrStateValue, String) {
        (QrStateValue::Error, format!("{label} 不需要扫码登录"))
    }
}

/// 把二维码内容画成 PNG 并转成 `data:image/png;base64,...`。
///
/// 替掉 Python 版的 segno + PIL 组合（这两个包一共 14MB）。平台自己给的二维码图
/// 往往只有一两百像素，直接塞进前端会糊到扫不出来，所以能拿到链接时一律自己重画。
pub fn qr_data_url_from_text(text: &str) -> Result<String> {
    use base64::Engine as _;
    use image::ImageEncoder as _;
    use qrcode::QrCode;

    let code = QrCode::new(text.as_bytes())?;
    let image = code
        .render::<image::Luma<u8>>()
        .min_dimensions(420, 420)
        .quiet_zone(true)
        .build();
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut std::io::Cursor::new(&mut png))
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::L8,
        )
        .map_err(|err| anyhow::anyhow!("二维码编码失败：{err}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    ))
}

/// 二维码图片的最小边长。低于这个尺寸手机基本扫不动。
const QR_MIN_SIZE: u32 = 420;

/// 平台直接给了 PNG 字节（QQ 音乐的 ptqrshow）时用这个。
///
/// **必须放大**：ptqrshow 回的原图只有一百多像素，原样塞进前端 `<img>` 会被
/// 浏览器插值成糊边，扫不出来。整数倍最近邻放大保持码块边缘锐利——
/// 这正是 Python 版拉进 14MB Pillow 只为做的那件事。
pub fn qr_data_url_from_png(data: &[u8]) -> String {
    use base64::Engine as _;
    let payload = upscale_qr(data).unwrap_or_else(|| data.to_vec());
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&payload)
    )
}

fn upscale_qr(data: &[u8]) -> Option<Vec<u8>> {
    use image::ImageEncoder as _;

    let decoded = image::load_from_memory(data).ok()?.to_rgb8();
    let longest = decoded.width().max(decoded.height()).max(1);
    if longest >= QR_MIN_SIZE {
        return None;
    }
    // 向上取整的整数倍，避免非整数缩放把码块切出灰边
    let scale = QR_MIN_SIZE.div_ceil(longest).max(1);
    let scaled = image::imageops::resize(
        &decoded,
        decoded.width() * scale,
        decoded.height() * scale,
        image::imageops::FilterType::Nearest,
    );
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut std::io::Cursor::new(&mut png))
        .write_image(
            scaled.as_raw(),
            scaled.width(),
            scaled.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(png)
}

/// 同名时加 ` (2)`、` (3)`……，不覆盖已有文件。
pub fn unique_download_path(directory: &Path, filename: &str) -> PathBuf {
    let target = directory.join(filename);
    if !target.exists() {
        return target;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let suffix = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for index in 2..10_000 {
        let candidate = directory.join(format!("{stem} ({index}){suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem} ({})", uuid_lite()))
}

fn uuid_lite() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
}

/// 取一个字符串字段，**空串等同于缺失**。
///
/// Python 版的归一化到处是 `str(data.get("a") or data.get("b") or "Unknown")` 这种
/// 真值链：`""` 是假值，会继续往后退。直译成 `get(..).and_then(as_str)` 时
/// `Some("")` 是"有值"，退化链就断在第一个空串上——搜索结果里标题/mid 偶尔就是空串，
/// 于是曲目标题变成空白、key 变成空字符串（后续下载必然失败）。
pub fn str_field<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
}

/// `data.get("a") or data.get("b")` 的字段级真值链：跳过 null / 0 / 空串 / 空数组 / 空对象。
///
/// 直译成 `get("a").or_else(|| get("b"))` 是错的——`Some(Null)` 会让链条停在第一个键上。
/// 网易云的 `ar`/`artists`、`dt`/`duration` 两组别名就是这么错位的。
pub fn first_truthy<'a>(
    value: &'a serde_json::Value,
    keys: &[&str],
) -> Option<&'a serde_json::Value> {
    keys.iter()
        .map(|key| value.get(*key))
        .find(|found| is_truthy(*found))
        .flatten()
}

/// `int(data.get("x") or 0)` 的宽松整数读取。
///
/// 直译成 `as_i64()` 会漏掉两种真实回包：接口偶尔把码率/文件大小写成**字符串**
/// （`"999000"`），也偶尔写成浮点（`999000.0`）。Python 的 `int(...)` 两种都吃，
/// `as_i64()` 两种都返回 None → 退化成 0，于是"无损"被判成"没有音质信息"。
pub fn loose_int(value: Option<&serde_json::Value>) -> i64 {
    match value {
        Some(serde_json::Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|v| v as i64))
            .unwrap_or(0),
        // Python 的 `int("999000")` 成立、`int("abc")` 抛异常被兜成 0
        Some(serde_json::Value::String(text)) => text.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

/// `limit` 的归一化：Python 那边一律是 `max(1, int(limit or 20))`——
/// **0 是假值，会退回默认条数**，而不是被夹成 1。
///
/// 直译成 `limit.max(1)` 时 `{"limit": 0}` 会只返回 1 条结果，
/// 前端看到的是"搜索几乎没结果"，很难联想到是 limit 被夹坏了。
pub fn effective_limit(limit: usize, default: usize) -> usize {
    if limit == 0 {
        default
    } else {
        limit
    }
}

/// 歌单/专辑类解析的「完整列出」语义：请求方不传上限（0）时一直检索到
/// 完整列出，而不是回落到搜索用的默认页大小；显式传了正数仍尊重调用方。
pub fn full_listing(limit: usize) -> usize {
    if limit == 0 {
        usize::MAX
    } else {
        limit
    }
}

/// Python `if song.get("sq"):` 的真值判断：`null` / `0` / `""` / `[]` / `{}` 全是假。
pub fn is_truthy(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(flag)) => *flag,
        Some(serde_json::Value::Number(number)) => number.as_f64().is_some_and(|v| v != 0.0),
        Some(serde_json::Value::String(text)) => !text.is_empty(),
        Some(serde_json::Value::Array(list)) => !list.is_empty(),
        Some(serde_json::Value::Object(map)) => !map.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_png_is_large_enough_to_scan() {
        let url = "https://music.163.com/login?codekey=abcdef0123456789";
        let data_url = qr_data_url_from_text(url).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));

        use base64::Engine as _;
        let png = base64::engine::general_purpose::STANDARD
            .decode(data_url.trim_start_matches("data:image/png;base64,"))
            .unwrap();
        let decoded = image::load_from_memory(&png).unwrap();
        // 平台原图只有一两百像素，糊到扫不出来是真实反馈过的问题
        assert!(decoded.width() >= 420, "宽 {}", decoded.width());
        assert!(decoded.height() >= 420, "高 {}", decoded.height());
    }

    #[test]
    fn platform_png_is_upscaled_to_a_scannable_size() {
        use base64::Engine as _;
        use image::ImageEncoder as _;

        // 模拟 ptqrshow 回的小图：120x120
        let small = image::RgbImage::from_fn(120, 120, |x, y| {
            if (x / 4 + y / 4) % 2 == 0 {
                image::Rgb([0, 0, 0])
            } else {
                image::Rgb([255, 255, 255])
            }
        });
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut std::io::Cursor::new(&mut png))
            .write_image(small.as_raw(), 120, 120, image::ExtendedColorType::Rgb8)
            .unwrap();

        let data_url = qr_data_url_from_png(&png);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data_url.trim_start_matches("data:image/png;base64,"))
            .unwrap();
        let image = image::load_from_memory(&decoded).unwrap();
        assert!(image.width() >= QR_MIN_SIZE, "宽 {}", image.width());
        // 整数倍放大：120 * 4 = 480
        assert_eq!(image.width() % 120, 0, "必须是整数倍，否则码块会有灰边");
    }

    #[test]
    fn already_large_png_is_passed_through_untouched() {
        use image::ImageEncoder as _;
        let big = image::RgbImage::new(600, 600);
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut std::io::Cursor::new(&mut png))
            .write_image(big.as_raw(), 600, 600, image::ExtendedColorType::Rgb8)
            .unwrap();
        assert!(upscale_qr(&png).is_none(), "够大就不要重编码");
    }

    #[test]
    fn platform_dir_is_flat_download_root() {
        let root = std::env::temp_dir().join(format!(
            "kdj-platform-dir-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let ctx = ProviderContext::new(
            root.join("data"),
            ProviderLiveSettings {
                download_dir: root.join("dl"),
                filename_template: "{title} - {artist}".into(),
                default_quality: Quality::Flac,
                netease_use_download_api: false,
                soundcloud_enabled: false,
                soundcloud_client_id: String::new(),
                soundcloud_client_secret: String::new(),
                ytm_enabled: false,
                youtube_enabled: false,
                video_dir: None,
                video_format: "mp4".into(),
            },
        );
        let target = ctx.platform_dir(Platform::Wyy).unwrap();
        assert_eq!(target, root.join("dl"));
        assert!(target.is_dir());
        assert!(!target.join("netease").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unique_download_path_adds_suffix_on_collision() {
        let root = std::env::temp_dir().join(format!(
            "kdj-unique-dl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let first = unique_download_path(&root, "song.mp3");
        assert_eq!(first.file_name().unwrap(), "song.mp3");
        std::fs::write(&first, b"a").unwrap();
        let second = unique_download_path(&root, "song.mp3");
        assert_eq!(second.file_name().unwrap(), "song (2).mp3");
        std::fs::write(&second, b"b").unwrap();
        let third = unique_download_path(&root, "song.mp3");
        assert_eq!(third.file_name().unwrap(), "song (3).mp3");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn download_dir_names_stay_stable_for_legacy_paths() {
        // 历史子目录名仍保留在枚举上，避免误改把老用户文件路径语义弄乱
        assert_eq!(Platform::Wyy.download_dir_name(), "netease");
        assert_eq!(Platform::Qqm.download_dir_name(), "qqmusic");
        assert_eq!(Platform::Bilibili.download_dir_name(), "bilibili");
        assert_eq!(Platform::Soundcloud.download_dir_name(), "soundcloud");
        assert_eq!(Platform::Ytm.download_dir_name(), "youtubemusic");
        assert_eq!(Platform::Youtube.download_dir_name(), "youtube");
    }

    #[test]
    fn empty_strings_count_as_missing_like_pythons_or_chain() {
        let value = serde_json::json!({"name": "", "title": "备用", "n": 0});
        assert_eq!(str_field(&value, "name"), None, "空串要继续往后退");
        assert_eq!(
            str_field(&value, "name").or_else(|| str_field(&value, "title")),
            Some("备用")
        );
        assert_eq!(str_field(&value, "nope"), None);
        assert_eq!(str_field(&value, "n"), None, "非字符串也算缺失");
    }

    #[test]
    fn truthiness_matches_python() {
        use serde_json::json;
        assert!(!is_truthy(None));
        assert!(!is_truthy(Some(&json!(null))));
        assert!(!is_truthy(Some(&json!(0))));
        assert!(!is_truthy(Some(&json!(""))));
        assert!(!is_truthy(Some(&json!([]))));
        // 网易云偶尔回空对象占位，Python 那边是假值
        assert!(!is_truthy(Some(&json!({}))));
        assert!(is_truthy(Some(&json!({"br": 999000}))));
        assert!(is_truthy(Some(&json!(1))));
    }

    #[test]
    fn loose_int_reads_the_shapes_python_accepted() {
        use serde_json::json;
        assert_eq!(loose_int(Some(&json!(999000))), 999_000);
        // 接口偶尔把码率/文件大小写成字符串或浮点，Python 的 int() 两种都吃
        assert_eq!(loose_int(Some(&json!("999000"))), 999_000);
        assert_eq!(loose_int(Some(&json!(999000.0))), 999_000);
        assert_eq!(loose_int(Some(&json!("abc"))), 0);
        assert_eq!(loose_int(Some(&json!(null))), 0);
        assert_eq!(loose_int(None), 0);
    }

    #[test]
    fn limit_zero_falls_back_to_the_python_default_not_to_one() {
        // Python 是 `max(1, int(limit or 20))`：0 是假值，退回默认条数
        assert_eq!(effective_limit(0, 20), 20);
        assert_eq!(effective_limit(0, 500), 500);
        assert_eq!(effective_limit(5, 20), 5);
        assert_eq!(effective_limit(1, 20), 1);
        assert_eq!(full_listing(0), usize::MAX, "0 = 完整列出");
        assert_eq!(full_listing(30), 30, "显式上限仍然尊重调用方");
    }

    #[test]
    fn cancel_token_short_circuits_the_job() {
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
            payload: Default::default(),
        };
        let token = CancellationToken::new();
        let job = DownloadJob::new(&source, Quality::Flac).with_cancel(token.clone());
        assert!(job.check_canceled().is_ok());
        token.cancel();
        assert!(job.check_canceled().is_err());
    }
}
