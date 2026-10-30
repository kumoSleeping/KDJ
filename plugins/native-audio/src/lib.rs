use serde::Serialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.nativeaudio";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_audio);

/// Android 侧 PluginHandle 包装，供应用层把 coordinator snapshot 推给 Kotlin。
#[cfg(target_os = "android")]
pub struct NativeAudio<R: Runtime>(PluginHandle<R>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPlaybackSnapshotArgs {
    pub sequence: u64,
    pub phase: String,
    pub track_id: Option<i64>,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork_url: Option<String>,
    pub current_time: f64,
    pub duration: f64,
    pub desired_playing: bool,
    pub is_playing: bool,
    pub buffering: bool,
    pub rate: f32,
    pub volume: f32,
    pub error: String,
}

/// What [`NativeAudio::web_login`] opens and waits for.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebLoginArgs {
    /// The login page, https only.
    pub url: String,
    /// The login is done once any of these cookies is set for one of `cookie_urls`.
    pub done_cookies: Vec<String>,
    /// The addresses whose cookies are handed back.
    pub cookie_urls: Vec<String>,
    /// Replaces the WebView's user agent; by default it is the phone's own without "; wv".
    pub user_agent: Option<String>,
    pub third_party_cookies: bool,
}

#[cfg(target_os = "android")]
impl<R: Runtime> NativeAudio<R> {
    /// Internal transport only; deliberately absent from native-audio:default permissions.
    pub fn youtube_proof(&self, operation: &str, javascript: &str) -> Result<String, String> {
        #[derive(serde::Deserialize)]
        struct Reply {
            value: String,
        }
        #[derive(Serialize)]
        struct Request<'a> {
            operation: &'a str,
            javascript: &'a str,
        }
        self.0
            .run_mobile_plugin::<Reply>("youtubeProof", Request { operation, javascript })
            .map(|reply| reply.value)
            .map_err(|error| format!("YouTube proof: {error}"))
    }

    /// Opens a platform's login page (WebLoginActivity) and waits for the user. `Ok(None)` when
    /// they leave it; otherwise the `Cookie` value of each of `args.cookie_urls`, in that order.
    /// Internal transport only; deliberately absent from native-audio:default permissions.
    pub fn web_login(&self, args: &WebLoginArgs) -> Result<Option<Vec<String>>, String> {
        #[derive(serde::Deserialize)]
        struct Reply {
            cancelled: bool,
            #[serde(default)]
            cookies: Vec<String>,
        }
        self.0
            .run_mobile_plugin::<Reply>("webLogin", args)
            .map(|reply| (!reply.cancelled).then_some(reply.cookies))
            .map_err(|error| error.to_string())
    }

    pub fn apply_playback_snapshot(&self, args: &ApplyPlaybackSnapshotArgs) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<()>("applyPlaybackSnapshot", args)
            .map_err(|error| format!("applyPlaybackSnapshot: {error}"))
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native-audio")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "NativeAudioPlugin")?;
                app.manage(NativeAudio(handle));
            }
            #[cfg(target_os = "ios")]
            {
                let _ = api.register_ios_plugin(init_plugin_native_audio)?;
                let _ = app;
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}
