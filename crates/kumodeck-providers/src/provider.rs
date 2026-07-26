//! provider 抽象层。
//!
//! 四家平台的形状差得比想象中多：网易云/QQ 是"搜索 → 拿直链 → 下音频"，
//! B 站是"解析 → DASH 双流 → 混流成视频"，SoundCloud 干脆没有登录体系。
//! 所以这个 trait 的设计原则是**让能力差异显式化**（`Capabilities`），
//! 而不是逼着 B 站假装自己是音乐平台、再在实现里到处抛 "不支持"。
//!
//! 聚合排序（平台优先级、分档、跨平台去重）留在 trait **之上**——
//! provider 不知道别人的存在，加第五个平台不用改任何已有实现。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use kumodeck_core::models::{
    Account, Platform, Quality, QrSession, QrStateValue, ResolveResponse, SongSource,
};
use tokio_util::sync::CancellationToken;

/// provider 需要的全部外部配置，由上层从 `Settings` 组装后注入。
///
/// provider 不读全局配置、不落自己的 settings 文件——这样才好测试、好多实例。
#[derive(Debug, Clone)]
pub struct ProviderContext {
    pub data_dir: PathBuf,
    pub download_dir: PathBuf,
    pub filename_template: String,
    pub default_quality: Quality,
    pub netease_use_download_api: bool,
    pub soundcloud_enabled: bool,
    /// 视频单独的落盘目录。None = 跟随 download_dir。
    pub video_dir: Option<PathBuf>,
    pub video_format: String,
}

impl ProviderContext {
    /// 各平台登录态落盘目录。
    pub fn session_dir(&self) -> PathBuf {
        self.data_dir.join("sessions")
    }

    /// 按平台分子目录存放下载文件，顺手建目录。
    pub fn platform_dir(&self, platform: Platform) -> std::io::Result<PathBuf> {
        let target = self.download_dir.join(platform.download_dir_name());
        std::fs::create_dir_all(&target)?;
        Ok(target)
    }

    /// 视频落盘目录。和音频分开：视频动辄几百 MB，混进音乐目录会被曲库扫描一起扫走。
    pub fn video_output_dir(&self) -> std::io::Result<PathBuf> {
        let target = self.video_dir.clone().unwrap_or_else(|| self.download_dir.clone());
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
}

impl Capabilities {
    pub const MUSIC: Capabilities = Capabilities {
        supports_login: true,
        has_quality_tiers: true,
        is_video: false,
    };
    pub const VIDEO: Capabilities = Capabilities {
        supports_login: true,
        has_quality_tiers: false,
        is_video: true,
    };
    pub const ANONYMOUS_MUSIC: Capabilities = Capabilities {
        supports_login: false,
        has_quality_tiers: true,
        is_video: false,
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

    /// 解析歌曲/歌单链接。
    /// **不是本平台的链接返回 `Ok(None)`**，让上层继续问别的 provider。
    async fn resolve(&self, url: &str, limit: usize) -> Result<Option<ResolveResponse>>;

    /// 下载单曲，返回最终文件路径；失败返回 Err（不要返回空路径）。
    async fn download(&self, job: DownloadJob<'_>) -> Result<PathBuf>;
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

/// 用来把下载目录里已存在的同名文件先删掉（Python 版的 `if filepath.exists(): unlink()`）。
pub fn remove_existing(path: &Path) {
    let _ = std::fs::remove_file(path);
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
    fn platform_dirs_match_the_python_layout() {
        // 改这些名字等于把老用户已经下好的文件"搬家"
        assert_eq!(Platform::Wyy.download_dir_name(), "netease");
        assert_eq!(Platform::Qqm.download_dir_name(), "qqmusic");
        assert_eq!(Platform::Bilibili.download_dir_name(), "bilibili");
        assert_eq!(Platform::Soundcloud.download_dir_name(), "soundcloud");
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
