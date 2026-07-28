//! 进程内共享状态：配置、曲库、provider 集合、事件总线。

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Result;
use kdj_core::models::Platform;
use kdj_core::{AppConfig, EventHub};
use kdj_library::{Database, LibraryService};
use kdj_providers::bilibili::BilibiliProvider;
use kdj_providers::netease::NeteaseProvider;
use kdj_providers::qqmusic::QqMusicProvider;
use kdj_providers::soundcloud::SoundCloudProvider;
use kdj_providers::{MusicProvider, ProviderContext, ProviderLiveSettings};

/// 账号页和搜索页的平台顺序。`local` 不是真的 provider，不在这里。
pub const PLATFORMS: [Platform; 4] = [
    Platform::Wyy,
    Platform::Qqm,
    Platform::Soundcloud,
    Platform::Bilibili,
];

pub struct AppState {
    pub config: Arc<AppConfig>,
    pub hub: EventHub,
    pub library: Arc<LibraryService>,
    providers: BTreeMap<Platform, Arc<dyn MusicProvider>>,
    /// B 站的视频接口不在 `MusicProvider` trait 上（那是音乐管线的形状），
    /// 单独留一份具体类型的引用给 `/api/video/*` 用。
    pub bilibili: Arc<BilibiliProvider>,
    /// 所有 provider 共享的 live 设置句柄；`PUT /api/settings` 后刷这份即可。
    provider_ctx: ProviderContext,
    /// 在线歌曲试听的短期代理票据：浏览器只拿本地 URL，不直接碰各平台 CDN。
    pub song_previews: Mutex<HashMap<String, (String, Instant)>>,
    /// 正在跑的分析批次，供「停止分析」用。挂在这里而不是做成模块级 static：
    /// static 会被同进程里的多个 AppState（测试、将来的多实例）串在一起。
    pub analysis: crate::jobs::AnalysisRegistry,
    /// 波形单飞：同一首歌的并发请求共享一次解码。
    pub waveforms: Arc<crate::waveform::WaveformCoordinator>,
}

impl AppState {
    pub fn new(config: Arc<AppConfig>) -> Result<Arc<Self>> {
        let database = Database::open(&config.db_path())?;
        let library = Arc::new(LibraryService::new(database));

        let ctx = provider_context(&config);
        let netease = Arc::new(NeteaseProvider::new(ctx.clone())?);
        let qqmusic = Arc::new(QqMusicProvider::new(ctx.clone())?);
        let soundcloud = Arc::new(SoundCloudProvider::new(ctx.clone())?);
        let bilibili = Arc::new(BilibiliProvider::new(ctx.clone())?);

        let mut providers: BTreeMap<Platform, Arc<dyn MusicProvider>> = BTreeMap::new();
        providers.insert(Platform::Wyy, netease);
        providers.insert(Platform::Qqm, qqmusic);
        providers.insert(Platform::Soundcloud, soundcloud);
        providers.insert(Platform::Bilibili, bilibili.clone());

        Ok(Arc::new(AppState {
            config,
            hub: EventHub::default(),
            library,
            providers,
            bilibili,
            provider_ctx: ctx,
            song_previews: Mutex::new(HashMap::new()),
            analysis: Default::default(),
            waveforms: Arc::new(crate::waveform::WaveformCoordinator::new()),
        }))
    }

    pub fn provider(&self, platform: Platform) -> Option<&Arc<dyn MusicProvider>> {
        self.providers.get(&platform)
    }

    /// 把当前 settings 刷进所有 provider 共享的 live 配置。
    pub fn sync_provider_context(&self) {
        self.provider_ctx
            .apply_live(provider_live_settings(&self.config));
    }

    /// provider 的上下文是按当前设置现算的（新开一份，不共享 live）。
    pub fn context(&self) -> ProviderContext {
        provider_context(&self.config)
    }
}

fn provider_live_settings(config: &AppConfig) -> ProviderLiveSettings {
    let settings = config.to_settings();
    ProviderLiveSettings {
        download_dir: config.download_dir(),
        filename_template: settings.filename_template,
        default_quality: settings.default_quality,
        netease_use_download_api: settings.netease_use_download_api,
        soundcloud_enabled: settings.soundcloud_enabled,
        video_dir: Some(config.video_dir()),
        video_format: settings.video_format.ext().to_string(),
    }
}

fn provider_context(config: &AppConfig) -> ProviderContext {
    ProviderContext::new(config.data_dir.clone(), provider_live_settings(config))
}
