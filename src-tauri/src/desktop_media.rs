//! Desktop system media-session adapter.
//!
//! Souvlaki maps this one contract to MPNowPlaying/MPRemoteCommandCenter on macOS,
//! SMTC on Windows and MPRIS on Linux. Playback remains owned by `kdj-playback`.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use kdj_playback::{PlaybackCommand, PlaybackCoordinator, PlaybackPhase, PlaybackSnapshot};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use tauri::{AppHandle, Emitter, Manager};

pub const REMOTE_EVENT: &str = "desktop-media-control";
const DEFAULT_SEEK_SECONDS: f64 = 10.0;
/// Snapshots arrive every ~100 ms. MPNowPlaying and SMTC extrapolate elapsed time themselves,
/// so progress is only re-published on state/rate changes, seeks, and a low periodic refresh.
/// souvlaki's MPRIS answers `Position` polls with the last pushed value, so Linux keeps
/// publishing every snapshot.
const THROTTLE_PROGRESS: bool = !cfg!(target_os = "linux");
const PROGRESS_REFRESH_INTERVAL: Duration = Duration::from_secs(5);
/// A playing position this far from wall-clock extrapolation counts as a seek or stall.
const SEEK_TOLERANCE_SECONDS: f64 = 1.5;
const PAUSED_POSITION_TOLERANCE_SECONDS: f64 = 0.25;
const RATE_TOLERANCE: f64 = 0.001;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct MetadataKey {
    track_id: Option<i64>,
    title: String,
    artist: String,
    album: String,
    artwork_url: Option<String>,
    duration_millis: u64,
}

struct SessionState {
    controls: MediaControls,
    metadata: MetadataKey,
    /// Local `file://` cover already published for `metadata.artwork_url`.
    cached_cover_url: Option<String>,
    /// Last playback state handed to the OS; `None` forces the next snapshot to publish.
    playback: Option<PublishedPlayback>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlaybackState {
    Stopped,
    Paused,
    Playing,
}

#[derive(Clone, Copy, Debug)]
struct PublishedPlayback {
    state: PlaybackState,
    position: f64,
    rate: f64,
    at: Instant,
}

impl PublishedPlayback {
    fn from_snapshot(snapshot: &PlaybackSnapshot, at: Instant) -> Self {
        let state = if snapshot.track_id.is_none()
            || matches!(
                snapshot.phase,
                PlaybackPhase::Idle | PlaybackPhase::Ended | PlaybackPhase::Error
            ) {
            PlaybackState::Stopped
        } else if snapshot.is_playing {
            PlaybackState::Playing
        } else {
            PlaybackState::Paused
        };
        let rate = f64::from(snapshot.rate);
        Self {
            state,
            position: finite_nonnegative(snapshot.current_time),
            rate: if rate.is_finite() && rate > 0.0 {
                rate
            } else {
                1.0
            },
            at,
        }
    }

    /// Where the OS believes playback is at `now`, extrapolated from this publication.
    fn extrapolated(self, now: Instant) -> Self {
        let mut next = self;
        if self.state == PlaybackState::Playing {
            next.position += now.saturating_duration_since(self.at).as_secs_f64() * self.rate;
        }
        next.at = now;
        next
    }

    fn media_playback(&self) -> MediaPlayback {
        let progress = Some(MediaPosition(Duration::from_secs_f64(self.position)));
        match self.state {
            PlaybackState::Stopped => MediaPlayback::Stopped,
            PlaybackState::Playing => MediaPlayback::Playing { progress },
            PlaybackState::Paused => MediaPlayback::Paused { progress },
        }
    }
}

/// souvlaki's macOS `set_playback` copies the whole nowPlayingInfo (artwork included) into a
/// new dictionary, so the steady 100 ms snapshot stream must not become one OS call per tick.
fn needs_playback_publish(last: Option<&PublishedPlayback>, next: &PublishedPlayback) -> bool {
    let Some(last) = last else {
        return true;
    };
    if last.state != next.state {
        return true;
    }
    match next.state {
        PlaybackState::Stopped => false,
        PlaybackState::Paused => {
            (next.position - last.position).abs() > PAUSED_POSITION_TOLERANCE_SECONDS
        }
        PlaybackState::Playing => {
            if (next.rate - last.rate).abs() > RATE_TOLERANCE {
                return true;
            }
            let elapsed = next.at.saturating_duration_since(last.at);
            if elapsed >= PROGRESS_REFRESH_INTERVAL {
                return true;
            }
            let expected = last.position + elapsed.as_secs_f64() * last.rate;
            (next.position - expected).abs() > SEEK_TOLERANCE_SECONDS
        }
    }
}

fn publish_playback(state: &mut SessionState, next: PublishedPlayback) {
    if let Err(error) = state.controls.set_playback(next.media_playback()) {
        tracing::warn!("更新系统媒体播放状态失败：{error}");
        // Retry on the next snapshot.
        state.playback = None;
    } else {
        state.playback = Some(next);
    }
}

/// souvlaki's macOS backend creates autoreleased Foundation objects on the calling thread. The
/// media worker never exits, so without a pool they would only be released at process exit.
#[cfg(target_os = "macos")]
fn with_autorelease_pool<R>(body: impl FnOnce() -> R) -> R {
    objc2::rc::autoreleasepool(|_| body())
}

#[cfg(not(target_os = "macos"))]
fn with_autorelease_pool<R>(body: impl FnOnce() -> R) -> R {
    body()
}

#[derive(Clone)]
pub struct DesktopMediaSession {
    // This mailbox never shares a lock with OS media calls or artwork loading.
    pending: Arc<Mutex<Option<PlaybackSnapshot>>>,
    wake: SyncSender<()>,
}

impl DesktopMediaSession {
    pub fn spawn(
        app: AppHandle,
        coordinator: Arc<OnceLock<Weak<PlaybackCoordinator>>>,
    ) -> Result<Self, String> {
        let mut controls = MediaControls::new(platform_config(&app)?)
            .map_err(|error| format!("创建系统媒体控制失败：{error}"))?;
        let event_app = app.clone();
        controls
            .attach(move |event| {
                handle_remote_event(&event_app, coordinator.get().and_then(Weak::upgrade), event);
            })
            .map_err(|error| format!("注册系统媒体控制失败：{error}"))?;
        let state = Arc::new(Mutex::new(SessionState {
            controls,
            metadata: MetadataKey::default(),
            cached_cover_url: None,
            playback: None,
        }));
        let pending = Arc::new(Mutex::new(None));
        let worker_pending = Arc::clone(&pending);
        let (wake, receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("kdj-desktop-media".into())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    let snapshot = worker_pending
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .take();
                    if let Some(snapshot) = snapshot {
                        with_autorelease_pool(|| Self::push_snapshot(&state, &snapshot));
                    }
                }
            })
            .map_err(|error| format!("启动系统媒体镜像线程失败：{error}"))?;
        Ok(Self { pending, wake })
    }

    /// Publication is part of the coordinator's command-ACK path. SMTC/MPNowPlaying/MPRIS
    /// and cached-cover loading must never run there, including waiting on their state lock.
    /// Keep only the newest snapshot and one wakeup if the OS media service stalls.
    pub fn update(&self, snapshot: &PlaybackSnapshot) {
        *self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(snapshot.clone());
        let _ = self.wake.try_send(());
    }

    fn push_snapshot(session: &Arc<Mutex<SessionState>>, snapshot: &PlaybackSnapshot) {
        let mut state = session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let metadata = metadata_key(snapshot);
        let mut cache_metadata = None;
        if metadata != state.metadata {
            // MPNowPlaying/SMTC cannot fetch loopback HTTP artwork reliably. Keep any already
            // cached local cover across text/duration refreshes so souvlaki does not wipe it,
            // and only download when the artwork identity actually changes.
            if !same_artwork(&state.metadata, &metadata) {
                state.cached_cover_url = None;
            }
            let cover_url = state.cached_cover_url.clone();
            let needs_cache = metadata.artwork_url.is_some() && state.cached_cover_url.is_none();
            if let Err(error) = set_metadata(&mut state.controls, &metadata, cover_url.as_deref()) {
                tracing::warn!("更新系统媒体元数据失败：{error}");
            } else {
                state.metadata = metadata.clone();
                // souvlaki's macOS set_metadata replaces nowPlayingInfo without elapsed time.
                state.playback = None;
                if needs_cache {
                    cache_metadata = Some(metadata);
                }
            }
        }

        let next = PublishedPlayback::from_snapshot(snapshot, Instant::now());
        if !THROTTLE_PROGRESS || needs_playback_publish(state.playback.as_ref(), &next) {
            publish_playback(&mut state, next);
        }

        #[cfg(target_os = "linux")]
        if let Err(error) = state
            .controls
            .set_volume(f64::from(snapshot.volume.clamp(0.0, 1.0)))
        {
            tracing::warn!("更新 MPRIS 音量失败：{error}");
        }
        drop(state);

        if let Some(metadata) = cache_metadata {
            cache_artwork(Arc::clone(session), metadata);
        }
    }
}

fn handle_remote_event(
    app: &AppHandle,
    coordinator: Option<Arc<PlaybackCoordinator>>,
    event: MediaControlEvent,
) {
    // Play/pause must cross the same frontend policy boundary as the transport button. Local
    // tracks will come straight back through `playback_command`; online tracks are owned by the
    // Web Audio deck and apply their configured gain envelope there. Sending these commands
    // directly to the Rust coordinator used to control a stale local deck while an online track
    // was active, and it also bypassed the browser transport fade entirely.
    if let Some(action) = frontend_action(&event) {
        emit_frontend(app, action);
        return;
    }

    match event {
        MediaControlEvent::Raise => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        MediaControlEvent::Quit => crate::request_desktop_exit(app),
        MediaControlEvent::OpenUri(_) => {}
        event => {
            let Some(coordinator) = coordinator else {
                return;
            };
            if let Err(error) = submit_remote(&coordinator, event) {
                tracing::warn!("执行系统媒体命令失败：{error}");
            }
        }
    }
}

fn frontend_action(event: &MediaControlEvent) -> Option<&'static str> {
    match event {
        MediaControlEvent::Play => Some("play"),
        MediaControlEvent::Pause | MediaControlEvent::Stop => Some("pause"),
        MediaControlEvent::Toggle => Some("toggle"),
        MediaControlEvent::Next => Some("next"),
        MediaControlEvent::Previous => Some("previous"),
        _ => None,
    }
}

fn submit_remote(
    coordinator: &PlaybackCoordinator,
    event: MediaControlEvent,
) -> Result<(), String> {
    let command = match event {
        MediaControlEvent::SetPosition(position) => PlaybackCommand::Seek {
            position: position.0.as_secs_f64(),
        },
        MediaControlEvent::Seek(direction) => {
            relative_seek(coordinator, direction, DEFAULT_SEEK_SECONDS)?
        }
        MediaControlEvent::SeekBy(direction, amount) => {
            relative_seek(coordinator, direction, amount.as_secs_f64())?
        }
        MediaControlEvent::SetVolume(volume) => PlaybackCommand::SetVolume {
            volume: volume.clamp(0.0, 1.0) as f32,
        },
        _ => return Ok(()),
    };
    coordinator.submit_platform(command).map(|_| ())
}

fn relative_seek(
    coordinator: &PlaybackCoordinator,
    direction: SeekDirection,
    amount: f64,
) -> Result<PlaybackCommand, String> {
    let snapshot = coordinator.snapshot()?;
    let delta = match direction {
        SeekDirection::Forward => amount,
        SeekDirection::Backward => -amount,
    };
    let mut position = (snapshot.current_time + delta).max(0.0);
    if snapshot.duration > 0.0 {
        position = position.min(snapshot.duration);
    }
    Ok(PlaybackCommand::Seek { position })
}

fn emit_frontend(app: &AppHandle, action: &'static str) {
    if let Err(error) = app.emit(REMOTE_EVENT, action) {
        tracing::warn!("发送系统媒体命令失败：{error}");
    }
}

fn metadata_key(snapshot: &PlaybackSnapshot) -> MetadataKey {
    MetadataKey {
        track_id: snapshot.track_id,
        title: snapshot.title.clone(),
        artist: snapshot.artist.clone(),
        album: snapshot.album.clone(),
        artwork_url: snapshot.artwork_url.clone(),
        duration_millis: (finite_nonnegative(snapshot.duration) * 1_000.0).round() as u64,
    }
}

fn set_metadata(
    controls: &mut MediaControls,
    metadata: &MetadataKey,
    cover_url: Option<&str>,
) -> Result<(), souvlaki::Error> {
    controls.set_metadata(MediaMetadata {
        title: nonempty(&metadata.title),
        artist: nonempty(&metadata.artist),
        album: nonempty(&metadata.album),
        cover_url,
        duration: (metadata.duration_millis > 0)
            .then(|| Duration::from_millis(metadata.duration_millis)),
    })
}

fn cache_artwork(state: Arc<Mutex<SessionState>>, metadata: MetadataKey) {
    let Some(source_url) = metadata.artwork_url.clone() else {
        return;
    };
    let result = std::thread::Builder::new()
        .name(format!(
            "kdj-media-artwork-{}",
            metadata.track_id.unwrap_or_default()
        ))
        .spawn(
            move || match local_artwork_url(&source_url, metadata.track_id) {
                Ok(local_url) => {
                    let mut state = state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    // Duration/title can change while the download runs; only abandon if the
                    // artwork target itself moved on.
                    if !same_artwork(&state.metadata, &metadata) {
                        return;
                    }
                    if state.cached_cover_url.as_deref() == Some(local_url.as_str()) {
                        return;
                    }
                    let current = state.metadata.clone();
                    with_autorelease_pool(|| {
                        if let Err(error) =
                            set_metadata(&mut state.controls, &current, Some(local_url.as_str()))
                        {
                            tracing::warn!("更新系统媒体封面失败：{error}");
                        } else {
                            state.cached_cover_url = Some(local_url.clone());
                            tracing::debug!("系统媒体封面已更新：{local_url}");
                            // set_metadata dropped the elapsed time on macOS; restore it now
                            // instead of waiting for the next throttled progress refresh.
                            if let Some(last) = state.playback {
                                publish_playback(&mut state, last.extrapolated(Instant::now()));
                            }
                        }
                    });
                }
                Err(error) => tracing::warn!("缓存系统媒体封面失败：{error}"),
            },
        );
    if let Err(error) = result {
        tracing::warn!("启动系统媒体封面缓存失败：{error}");
    }
}

fn same_artwork(left: &MetadataKey, right: &MetadataKey) -> bool {
    left.track_id == right.track_id && left.artwork_url == right.artwork_url
}

fn local_artwork_url(source_url: &str, track_id: Option<i64>) -> Result<String, String> {
    if source_url.starts_with("file://") {
        return Ok(normalize_file_url(source_url));
    }
    if !source_url.starts_with("http://") && !source_url.starts_with("https://") {
        return Err("封面地址不是受支持的 HTTP/file URL".into());
    }

    let mut hasher = DefaultHasher::new();
    let resource = source_url
        .split_once("/api/")
        .map(|(_, resource)| resource)
        .unwrap_or(source_url);
    let (resource_path, query) = resource.split_once('?').unwrap_or((resource, ""));
    resource_path.hash(&mut hasher);
    // kdj_media_token 每次启动都会换，只用于请求鉴权，不能进缓存键；否则同一张封面每次启动都另存一份。
    query
        .split('&')
        .filter(|pair| !pair.starts_with("kdj_media_token="))
        .for_each(|pair| pair.hash(&mut hasher));
    let key = hasher.finish();
    let cache_dir = std::env::temp_dir().join("kdj-media-artwork");
    fs::create_dir_all(&cache_dir).map_err(|error| format!("创建封面缓存目录失败：{error}"))?;
    let cached_path = |extension: &str| {
        cache_dir.join(format!(
            "{}-{key:016x}.{extension}",
            track_id.unwrap_or_default()
        ))
    };
    // 命中缓存就不再发请求；扩展名来自上次响应的 Content-Type。
    if let Some(path) = ["jpg", "png", "webp", "gif"]
        .into_iter()
        .map(cached_path)
        .find(|path| path.is_file())
    {
        return Ok(file_url(&path));
    }

    kdj_core::ensure_rustls_ring();
    let response = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("创建封面下载客户端失败：{error}"))?
        .get(source_url)
        .send()
        // reqwest errors can include the complete request URL. Local artwork URLs carry a
        // media capability in their query string, so never surface the original error here.
        .map_err(|error| artwork_request_error(&error))?;
    if !response.status().is_success() {
        return Err(format!("下载封面失败：HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > 16 * 1024 * 1024)
    {
        return Err("封面超过 16MB".into());
    }
    let extension = image_extension(
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
    );
    let path = cached_path(extension);
    if !path.is_file() {
        let bytes = response
            .bytes()
            .map_err(|_| "读取封面响应失败".to_string())?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("封面超过 16MB".into());
        }
        let temporary = path.with_extension(format!("{extension}.tmp"));
        fs::write(&temporary, &bytes).map_err(|error| format!("写入封面缓存失败：{error}"))?;
        if let Err(error) = fs::rename(&temporary, &path) {
            if !path.is_file() {
                return Err(format!("提交封面缓存失败：{error}"));
            }
            let _ = fs::remove_file(temporary);
        }
    }
    Ok(file_url(&path))
}

fn artwork_request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "下载封面失败：请求超时".into()
    } else if error.is_connect() {
        "下载封面失败：无法连接封面服务".into()
    } else {
        "下载封面失败：请求未完成".into()
    }
}

fn image_extension(content_type: Option<&str>) -> &'static str {
    match content_type.unwrap_or_default().split(';').next() {
        Some("image/png") => "png",
        Some("image/webp") => "webp",
        Some("image/gif") => "gif",
        _ => "jpg",
    }
}

fn file_url(path: &Path) -> String {
    // On Windows, prefer file://C:\... over file:///C:/... — souvlaki trims only
    // "file://" then passes the rest to GetFileFromPathAsync, so a leading slash breaks SMTC.
    format!("file://{}", path.to_string_lossy())
}

fn normalize_file_url(url: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        let rest = url.trim_start_matches("file://");
        let path = rest.trim_start_matches('/').replace('/', "\\");
        format!("file://{path}")
    }
    #[cfg(not(target_os = "windows"))]
    {
        url.to_string()
    }
}

fn nonempty(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
}

fn finite_nonnegative(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn platform_config(_app: &AppHandle) -> Result<PlatformConfig<'static>, String> {
    #[cfg(target_os = "windows")]
    let hwnd = {
        let window = _app
            .get_webview_window("main")
            .ok_or_else(|| "找不到主窗口，无法注册 Windows SMTC".to_string())?;
        Some(
            window
                .hwnd()
                .map_err(|error| format!("读取主窗口 HWND 失败：{error}"))?
                .0 as *mut std::ffi::c_void,
        )
    };
    #[cfg(not(target_os = "windows"))]
    let hwnd = None;

    Ok(PlatformConfig {
        dbus_name: "io.github.kumosleeping.kdj",
        display_name: "KDJ",
        hwnd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;

    #[test]
    fn loopback_artwork_is_cached_as_a_file_url() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("监听测试端口");
        let address = listener.local_addr().expect("测试地址");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("接收封面请求");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\njpeg",
                )
                .expect("返回测试封面");
        });

        let url = local_artwork_url(
            &format!("http://{address}/api/library/cover/987654?v=test"),
            Some(987654),
        )
        .expect("缓存封面");
        server.join().expect("封面服务线程");

        assert!(url.starts_with("file://"));
        // Windows souvlaki workaround: file://C:\... ; Unix: file:///tmp/...
        let path = PathBuf::from(url.trim_start_matches("file://"));
        assert_eq!(fs::read(&path).expect("读取封面缓存"), b"jpeg");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn artwork_cache_ignores_the_media_token_and_skips_the_request_on_a_hit() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("监听测试端口");
        let address = listener.local_addr().expect("测试地址");
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&requests);
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\njpeg",
                );
            }
        });
        let cached_files = || -> Vec<PathBuf> {
            fs::read_dir(std::env::temp_dir().join("kdj-media-artwork"))
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.path())
                        .filter(|path| {
                            path.file_name()
                                .is_some_and(|name| name.to_string_lossy().starts_with("987655-"))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        cached_files().into_iter().for_each(|path| {
            let _ = fs::remove_file(path);
        });

        // 同一首歌：本次启动播两次，再换一次启动（新的 media token）。
        for token in ["first-launch", "first-launch", "second-launch"] {
            local_artwork_url(
                &format!(
                    "http://{address}/api/library/cover/987655?v=test&kdj_media_token={token}"
                ),
                Some(987655),
            )
            .expect("缓存封面");
        }
        let files = cached_files();
        files.iter().for_each(|path| {
            let _ = fs::remove_file(path);
        });
        assert_eq!(files.len(), 1, "{files:?}");
        assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn media_progress_publishes_only_on_state_rate_seek_or_refresh() {
        let start = Instant::now();
        let at = |seconds: f64| start + Duration::from_secs_f64(seconds);
        let playback = |state, position, rate, seconds| PublishedPlayback {
            state,
            position,
            rate,
            at: at(seconds),
        };
        use PlaybackState::{Paused, Playing, Stopped};

        let last = playback(Playing, 10.0, 1.0, 0.0);
        assert!(needs_playback_publish(None, &last));
        // Steady 100 ms ticks that track wall-clock stay quiet until the periodic refresh.
        for tick in 1..50 {
            let seconds = f64::from(tick) * 0.1;
            let next = playback(Playing, 10.0 + seconds, 1.0, seconds);
            assert!(!needs_playback_publish(Some(&last), &next), "tick {tick}");
        }
        assert!(needs_playback_publish(
            Some(&last),
            &playback(Playing, 15.0, 1.0, 5.0)
        ));
        // Seeks either way, and a stall the OS would keep extrapolating past.
        assert!(needs_playback_publish(
            Some(&last),
            &playback(Playing, 40.0, 1.0, 0.2)
        ));
        assert!(needs_playback_publish(
            Some(&last),
            &playback(Playing, 2.0, 1.0, 0.2)
        ));
        assert!(needs_playback_publish(
            Some(&last),
            &playback(Playing, 10.0, 1.0, 2.0)
        ));
        // Rate changes publish; steady playback at that rate is extrapolated with it.
        assert!(needs_playback_publish(
            Some(&last),
            &playback(Playing, 10.1, 1.25, 0.1)
        ));
        let fast = playback(Playing, 10.0, 2.0, 0.0);
        assert!(!needs_playback_publish(
            Some(&fast),
            &playback(Playing, 16.0, 2.0, 3.0)
        ));
        // State changes always publish.
        assert!(needs_playback_publish(
            Some(&last),
            &playback(Paused, 10.1, 1.0, 0.1)
        ));
        assert!(needs_playback_publish(
            Some(&last),
            &playback(Stopped, 0.0, 1.0, 0.1)
        ));
        // Paused only republishes when the position moved.
        let paused = playback(Paused, 30.0, 1.0, 0.0);
        assert!(!needs_playback_publish(
            Some(&paused),
            &playback(Paused, 30.0, 1.0, 60.0)
        ));
        assert!(needs_playback_publish(
            Some(&paused),
            &playback(Paused, 31.0, 1.0, 0.1)
        ));
        let stopped = playback(Stopped, 0.0, 1.0, 0.0);
        assert!(!needs_playback_publish(
            Some(&stopped),
            &playback(Stopped, 0.0, 1.0, 60.0)
        ));
    }

    #[test]
    fn media_progress_extrapolates_only_while_playing() {
        let start = Instant::now();
        let later = start + Duration::from_secs(4);
        let playing = PublishedPlayback {
            state: PlaybackState::Playing,
            position: 10.0,
            rate: 1.5,
            at: start,
        };
        let moved = playing.extrapolated(later);
        assert!((moved.position - 16.0).abs() < 1e-9);
        assert_eq!(moved.at, later);
        let paused = PublishedPlayback {
            state: PlaybackState::Paused,
            ..playing
        };
        assert!((paused.extrapolated(later).position - 10.0).abs() < 1e-9);
    }

    #[test]
    fn same_artwork_ignores_duration_and_text() {
        let base = MetadataKey {
            track_id: Some(1),
            title: "a".into(),
            artist: "b".into(),
            album: "c".into(),
            artwork_url: Some("http://127.0.0.1/cover".into()),
            duration_millis: 0,
        };
        let mut later = base.clone();
        later.title = "changed".into();
        later.duration_millis = 180_000;
        assert!(same_artwork(&base, &later));
        later.artwork_url = Some("http://127.0.0.1/other".into());
        assert!(!same_artwork(&base, &later));
    }

    #[test]
    fn artwork_errors_never_expose_the_media_capability() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("监听测试端口");
        let address = listener.local_addr().expect("测试地址");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("接收封面请求");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                .expect("返回测试错误");
        });

        let secret = "media-capability-must-not-be-logged";
        let error = local_artwork_url(
            &format!("http://{address}/api/library/cover/1?kdj_media_token={secret}"),
            Some(1),
        )
        .expect_err("404 应返回错误");
        server.join().expect("封面服务线程");

        assert!(error.contains("HTTP 404"));
        assert!(!error.contains(secret));
        assert!(!error.contains("kdj_media_token"));
    }

    #[test]
    fn transport_and_skip_commands_cross_the_frontend_owner_boundary() {
        assert_eq!(frontend_action(&MediaControlEvent::Play), Some("play"));
        assert_eq!(frontend_action(&MediaControlEvent::Pause), Some("pause"));
        assert_eq!(frontend_action(&MediaControlEvent::Stop), Some("pause"));
        assert_eq!(frontend_action(&MediaControlEvent::Toggle), Some("toggle"));
        assert_eq!(frontend_action(&MediaControlEvent::Next), Some("next"));
        assert_eq!(
            frontend_action(&MediaControlEvent::Previous),
            Some("previous")
        );
        assert_eq!(
            frontend_action(&MediaControlEvent::SetPosition(MediaPosition(
                Duration::from_secs(1)
            ))),
            None
        );
    }

    #[test]
    fn windows_artwork_file_url_is_souvlaki_compatible() {
        let path = PathBuf::from(if cfg!(windows) {
            r"C:\Users\test\AppData\Local\Temp\kdj-media-artwork\1.jpg"
        } else {
            "/tmp/kdj-media-artwork/1.jpg"
        });
        let url = file_url(&path);
        assert!(url.starts_with("file://"));
        let trimmed = url.trim_start_matches("file://");
        #[cfg(windows)]
        {
            assert!(
                !trimmed.starts_with('/'),
                "souvlaki must not see a leading slash"
            );
            assert!(trimmed.contains('\\') || trimmed.contains(':'));
        }
        #[cfg(not(windows))]
        {
            assert!(trimmed.starts_with('/'));
            assert_eq!(PathBuf::from(trimmed), path);
        }
    }
}
