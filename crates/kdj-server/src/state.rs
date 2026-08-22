//! 进程内共享状态：配置、曲库、provider 集合、事件总线。

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use kdj_core::models::{FolderUndoOp, FolderUndoStatus, Platform, Quality, SongSource};
use kdj_core::{AppConfig, EventHub};
use kdj_library::service::DeletedTrack;
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

const MAX_FOLDER_UNDO_BATCHES: usize = 50;
const MAX_SONG_PREVIEW_TICKETS: usize = 256;
const SONG_PREVIEW_TICKET_TTL: Duration = Duration::from_secs(2 * 60 * 60);

/// 本地试听代理票据必须保留原始来源与音质：平台 CDN 的直链通常是短期链接，
/// GET 遇到鉴权/过期状态时需要按同一请求重新解析一次，而不是让用户重新点歌。
#[derive(Debug, Clone)]
pub struct SongPreviewTicket {
    pub source: SongSource,
    pub quality: Quality,
    /// 稳定缓存键；即使当前命中本地，也保留来源信息供损坏时回源。
    pub cache_key: Option<String>,
    pub cached: bool,
    pub url: String,
    pub last_used_at: Instant,
}

#[derive(Debug)]
pub struct SongPreviewTickets {
    entries: HashMap<String, SongPreviewTicket>,
    max_entries: usize,
    ttl: Duration,
}

impl Default for SongPreviewTickets {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            max_entries: MAX_SONG_PREVIEW_TICKETS,
            ttl: SONG_PREVIEW_TICKET_TTL,
        }
    }
}

impl SongPreviewTickets {
    pub fn insert(&mut self, token: String, ticket: SongPreviewTicket) {
        self.insert_at(token, ticket);
    }

    /// 每次媒体 GET 都续租；Range seek 也会自然触发一次续租。
    pub fn get_and_touch(&mut self, token: &str) -> Option<SongPreviewTicket> {
        self.get_and_touch_at(token, Instant::now())
    }

    /// 上游短链刷新成功后原地更新票据，浏览器持有的本地 URL 不变。
    pub fn update_url(&mut self, token: &str, url: String) -> bool {
        self.update_url_at(token, url, Instant::now())
    }

    fn insert_at(&mut self, token: String, ticket: SongPreviewTicket) {
        let now = ticket.last_used_at;
        self.prune_expired_at(now);
        // 替换同 token 不应误淘汰另一张票据。
        self.entries.remove(&token);
        while self.entries.len() >= self.max_entries.max(1) {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, ticket)| ticket.last_used_at)
                .map(|(token, _)| token.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.entries.insert(token, ticket);
    }

    fn get_and_touch_at(&mut self, token: &str, now: Instant) -> Option<SongPreviewTicket> {
        let expired = self
            .entries
            .get(token)
            .map(|ticket| now.saturating_duration_since(ticket.last_used_at) >= self.ttl)
            .unwrap_or(false);
        if expired {
            self.entries.remove(token);
            return None;
        }
        let ticket = self.entries.get_mut(token)?;
        ticket.last_used_at = now;
        Some(ticket.clone())
    }

    fn update_url_at(&mut self, token: &str, url: String, now: Instant) -> bool {
        let expired = self
            .entries
            .get(token)
            .map(|ticket| now.saturating_duration_since(ticket.last_used_at) >= self.ttl)
            .unwrap_or(false);
        if expired {
            self.entries.remove(token);
            return false;
        }
        let Some(ticket) = self.entries.get_mut(token) else {
            return false;
        };
        ticket.url = url;
        ticket.cached = false;
        ticket.last_used_at = now;
        true
    }

    fn prune_expired_at(&mut self, now: Instant) {
        let ttl = self.ttl;
        self.entries
            .retain(|_, ticket| now.saturating_duration_since(ticket.last_used_at) < ttl);
    }

    #[cfg(test)]
    fn with_limits(max_entries: usize, ttl: Duration) -> Self {
        Self {
            entries: HashMap::new(),
            max_entries,
            ttl,
        }
    }
}

/// 一条成功的曲目文件操作，保存撤回所需的路径和曲目身份。
#[derive(Debug, Clone)]
pub struct FolderUndoItem {
    pub op: FolderUndoOp,
    pub track_id: i64,
    /// Move 时是原路径；Copy 时只用于说明来源；Delete 时是被删除前的原路径。
    pub source: PathBuf,
    /// Move/Copy 的目标路径；Delete 不使用。
    pub target: PathBuf,
    /// Copy 新建的曲目记录；Move/Delete 为 None。
    pub created_track_id: Option<i64>,
    pub source_platform: String,
    pub source_key: String,
    /// Delete 时保留完整曲目和回收站定位；其它操作为 None。
    pub deleted: Option<DeletedTrack>,
}

#[derive(Debug, Clone)]
pub struct FolderUndoBatch {
    pub op: FolderUndoOp,
    pub items: Vec<FolderUndoItem>,
}

#[derive(Debug, Clone)]
pub struct OneLibrarySyncSnapshot {
    pub rating: i64,
    pub cover_version: String,
    pub update_count: i32,
}

pub struct AppState {
    pub config: Arc<AppConfig>,
    pub hub: EventHub,
    pub library: Arc<LibraryService>,
    providers: BTreeMap<Platform, Arc<dyn MusicProvider>>,
    /// B 站的视频接口不在 `MusicProvider` trait 上（那是音乐管线的形状），
    /// 单独留一份具体类型的引用给 `/api/video/*` 用。
    pub bilibili: Arc<BilibiliProvider>,
    /// SoundCloud OAuth 回调需要访问具体 provider 的短期 PKCE 会话。
    pub soundcloud: Arc<SoundCloudProvider>,
    /// 所有 provider 共享的 live 设置句柄；`PUT /api/settings` 后刷这份即可。
    provider_ctx: ProviderContext,
    /// 在线歌曲试听的短期代理票据：浏览器只拿本地 URL，不直接碰各平台 CDN。
    pub song_previews: Mutex<SongPreviewTickets>,
    /// 在线音频的旁路磁盘缓存；共享 generation 用于关闭/清理时取消在途写入。
    pub stream_cache: crate::stream_cache::StreamCache,
    /// 复用在线缓存临时文件的渐进波形；只在前端实际请求时才开始解码。
    pub stream_waveforms: crate::stream_waveform::StreamWaveformCoordinator,
    /// 正在跑的分析批次，供「停止分析」用。挂在这里而不是做成模块级 static：
    /// static 会被同进程里的多个 AppState（测试、将来的多实例）串在一起。
    pub analysis: crate::jobs::AnalysisRegistry,
    /// 波形单飞：同一首歌的并发请求共享一次解码。
    pub waveforms: Arc<crate::waveform::WaveformCoordinator>,
    /// The fixed classical Redress STEM coordinator owns background separation; it never enters playback
    /// or audio callback threads.
    pub stems: kdj_stems::StemCoordinator,
    /// 文件夹与波形升级各自只允许一个实例；前端重连/HMR 不会重复开整库任务。
    pub maintenance: crate::jobs::MaintenanceRegistry,
    /// 串行化曲目文件操作，避免撤回与复制/移动/删除同时改同一路径。
    pub folder_operations: Mutex<()>,
    /// 最近成功的曲目复制/移动/删除批次；进程重启后故意清空，避免误改用户后来变动的文件。
    pub folder_undo: Mutex<VecDeque<FolderUndoBatch>>,
    /// 已观察到的外置曲目状态，用来区分“本轮 djay 改了”与普通三秒轮询。
    pub one_library_sync: Mutex<HashMap<String, OneLibrarySyncSnapshot>>,
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
        providers.insert(Platform::Soundcloud, soundcloud.clone());
        providers.insert(Platform::Bilibili, bilibili.clone());

        let waveforms = crate::waveform::WaveformCoordinator::new(library.clone());
        let stems = kdj_stems::StemCoordinator::new(&config.data_dir);
        let stream_cache = crate::stream_cache::StreamCache::default();
        stream_cache.set_enabled(config.to_settings().stream_cache_enabled);
        Ok(Arc::new(AppState {
            config,
            hub: EventHub::default(),
            library,
            providers,
            bilibili,
            soundcloud,
            provider_ctx: ctx,
            song_previews: Mutex::new(SongPreviewTickets::default()),
            stream_cache,
            stream_waveforms: Default::default(),
            analysis: Default::default(),
            waveforms,
            stems,
            maintenance: Default::default(),
            folder_operations: Mutex::new(()),
            folder_undo: Mutex::new(VecDeque::new()),
            one_library_sync: Mutex::new(HashMap::new()),
        }))
    }

    pub fn folder_undo_status(&self) -> FolderUndoStatus {
        let stack = self.folder_undo.lock().unwrap();
        folder_undo_status(&stack)
    }

    pub fn push_folder_undo(&self, batch: FolderUndoBatch) -> FolderUndoStatus {
        let mut stack = self.folder_undo.lock().unwrap();
        if stack.len() >= MAX_FOLDER_UNDO_BATCHES {
            stack.pop_front();
        }
        stack.push_back(batch);
        folder_undo_status(&stack)
    }

    pub fn clear_folder_undo(&self) {
        self.folder_undo.lock().unwrap().clear();
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

fn folder_undo_status(stack: &VecDeque<FolderUndoBatch>) -> FolderUndoStatus {
    stack
        .back()
        .map(|batch| FolderUndoStatus {
            available: !batch.items.is_empty(),
            op: Some(batch.op),
            count: batch.items.len(),
        })
        .unwrap_or_default()
}

fn provider_live_settings(config: &AppConfig) -> ProviderLiveSettings {
    let settings = config.to_settings();
    ProviderLiveSettings {
        download_dir: config.download_dir(),
        filename_template: settings.filename_template,
        default_quality: settings.default_quality,
        netease_use_download_api: settings.netease_use_download_api,
        soundcloud_enabled: settings.soundcloud_enabled,
        // SoundCloud 把所有 OAuth client 都视作 confidential；应用凭据不是用户偏好，
        // 不能写进 settings.json，更不能跟着 GET /api/settings 回到 WebView。
        // 开发/打包环境负责注入，正式发布则应由 KDJ 的 OAuth broker 托管 secret。
        soundcloud_client_id: std::env::var("KDJ_SOUNDCLOUD_CLIENT_ID").unwrap_or_default(),
        soundcloud_client_secret: std::env::var("KDJ_SOUNDCLOUD_CLIENT_SECRET").unwrap_or_default(),
        video_dir: Some(config.video_dir()),
        video_format: settings.video_format.ext().to_string(),
    }
}

fn provider_context(config: &AppConfig) -> ProviderContext {
    ProviderContext::new(config.data_dir.clone(), provider_live_settings(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(key: &str) -> SongSource {
        SongSource {
            platform: Platform::Wyy,
            key: key.to_string(),
            title: key.to_string(),
            artists: vec!["artist".to_string()],
            album: String::new(),
            duration: Some(180.0),
            cover: String::new(),
            max_quality: Some(Quality::Q320),
            vip: false,
            payload: Default::default(),
        }
    }

    fn ticket(key: &str, at: Instant) -> SongPreviewTicket {
        SongPreviewTicket {
            source: source(key),
            quality: Quality::Q320,
            cache_key: None,
            cached: false,
            url: format!("https://cdn.example/{key}"),
            last_used_at: at,
        }
    }

    #[test]
    fn preview_ticket_get_renews_the_lease() {
        let base = Instant::now();
        let mut tickets = SongPreviewTickets::with_limits(4, Duration::from_secs(10));
        tickets.insert_at("a".into(), ticket("a", base));

        let renewed = tickets
            .get_and_touch_at("a", base + Duration::from_secs(8))
            .expect("ticket should still be alive");
        assert_eq!(renewed.last_used_at, base + Duration::from_secs(8));
        assert!(tickets
            .get_and_touch_at("a", base + Duration::from_secs(17))
            .is_some());
    }

    #[test]
    fn expired_preview_ticket_is_removed() {
        let base = Instant::now();
        let mut tickets = SongPreviewTickets::with_limits(4, Duration::from_secs(10));
        tickets.insert_at("a".into(), ticket("a", base));

        assert!(tickets
            .get_and_touch_at("a", base + Duration::from_secs(10))
            .is_none());
        assert!(!tickets.entries.contains_key("a"));
    }

    #[test]
    fn preview_ticket_cache_evicts_the_least_recently_used() {
        let base = Instant::now();
        let mut tickets = SongPreviewTickets::with_limits(2, Duration::from_secs(60));
        tickets.insert_at("a".into(), ticket("a", base));
        tickets.insert_at("b".into(), ticket("b", base + Duration::from_secs(1)));
        tickets
            .get_and_touch_at("a", base + Duration::from_secs(2))
            .unwrap();
        tickets.insert_at("c".into(), ticket("c", base + Duration::from_secs(3)));

        assert!(tickets.entries.contains_key("a"));
        assert!(!tickets.entries.contains_key("b"));
        assert!(tickets.entries.contains_key("c"));
    }

    #[test]
    fn refreshed_url_keeps_source_and_quality() {
        let base = Instant::now();
        let mut tickets = SongPreviewTickets::with_limits(2, Duration::from_secs(60));
        tickets.insert_at("a".into(), ticket("a", base));

        assert!(tickets.update_url_at(
            "a",
            "https://cdn.example/refreshed".into(),
            base + Duration::from_secs(1),
        ));
        let refreshed = tickets.entries.get("a").unwrap();
        assert_eq!(refreshed.source.key, "a");
        assert_eq!(refreshed.quality, Quality::Q320);
        assert_eq!(refreshed.url, "https://cdn.example/refreshed");
        assert!(!refreshed.cached);
    }
}
