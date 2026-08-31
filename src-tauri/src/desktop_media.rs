//! Desktop system media-session adapter.
//!
//! Souvlaki maps this one contract to MPNowPlaying/MPRemoteCommandCenter on macOS,
//! SMTC on Windows and MPRIS on Linux. Playback remains owned by `kdj-playback`.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use kdj_playback::{PlaybackCommand, PlaybackCoordinator, PlaybackPhase, PlaybackSnapshot};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use tauri::{AppHandle, Emitter, Manager};

pub const REMOTE_EVENT: &str = "desktop-media-control";
const DEFAULT_SEEK_SECONDS: f64 = 10.0;

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
}

pub struct DesktopMediaSession {
    state: Arc<Mutex<SessionState>>,
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
        Ok(Self {
            state: Arc::new(Mutex::new(SessionState {
                controls,
                metadata: MetadataKey::default(),
                cached_cover_url: None,
            })),
        })
    }

    pub fn update(&self, snapshot: &PlaybackSnapshot) {
        let mut state = self
            .state
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
                if needs_cache {
                    cache_metadata = Some(metadata);
                }
            }
        }

        let progress = MediaPosition(Duration::from_secs_f64(finite_nonnegative(
            snapshot.current_time,
        )));
        let playback = if snapshot.track_id.is_none()
            || matches!(
                snapshot.phase,
                PlaybackPhase::Idle | PlaybackPhase::Ended | PlaybackPhase::Error
            ) {
            MediaPlayback::Stopped
        } else if snapshot.is_playing {
            MediaPlayback::Playing {
                progress: Some(progress),
            }
        } else {
            MediaPlayback::Paused {
                progress: Some(progress),
            }
        };
        if let Err(error) = state.controls.set_playback(playback) {
            tracing::warn!("更新系统媒体播放状态失败：{error}");
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
            cache_artwork(Arc::clone(&self.state), metadata);
        }
    }
}

impl Clone for DesktopMediaSession {
    fn clone(&self) -> Self {
        Self {
            state: Arc::clone(&self.state),
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
                    if let Err(error) =
                        set_metadata(&mut state.controls, &current, Some(local_url.as_str()))
                    {
                        tracing::warn!("更新系统媒体封面失败：{error}");
                    } else {
                        state.cached_cover_url = Some(local_url.clone());
                        tracing::debug!("系统媒体封面已更新：{local_url}");
                    }
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
    source_url
        .split_once("/api/")
        .map(|(_, resource)| resource)
        .unwrap_or(source_url)
        .hash(&mut hasher);
    let cache_dir = std::env::temp_dir().join("kdj-media-artwork");
    fs::create_dir_all(&cache_dir).map_err(|error| format!("创建封面缓存目录失败：{error}"))?;

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
    let path = cache_dir.join(format!(
        "{}-{:016x}.{extension}",
        track_id.unwrap_or_default(),
        hasher.finish()
    ));
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
