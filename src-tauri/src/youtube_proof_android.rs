//! Android owns a separate bound WebView service/profile; all script construction, proof/player
//! validation and result limits remain in youtube_proof.rs. No renderer-facing eval command.
use super::YoutubeProofState;
use tauri::Manager;
use tauri_plugin_native_audio::NativeAudio;

pub(super) struct ProofWindow(tauri::AppHandle);

async fn call(
    app: &tauri::AppHandle,
    operation: &'static str,
    javascript: String,
) -> Result<String, String> {
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        app.state::<NativeAudio<tauri::Wry>>().youtube_proof(operation, &javascript)
    })
    .await
    .map_err(|_| "YouTube proof 服务任务已退出".to_string())?
}

pub(super) async fn active_proof_window<'a>(
    app: &tauri::AppHandle,
    state: &'a YoutubeProofState,
) -> Result<(ProofWindow, tokio::sync::RwLockReadGuard<'a, ()>), String> {
    let exclusive = state.lifecycle.write().await;
    call(app, "ensure", String::new()).await?;
    Ok((ProofWindow(app.clone()), exclusive.downgrade()))
}

pub(super) async fn replace_failed_realm(
    app: &tauri::AppHandle,
    active: tokio::sync::RwLockReadGuard<'_, ()>,
    state: &YoutubeProofState,
) {
    drop(active);
    let _exclusive = state.lifecycle.write().await;
    let _ = call(app, "destroy", String::new()).await;
}

pub(super) async fn eval_with_callback(
    window: &ProofWindow,
    javascript: String,
) -> Result<String, String> {
    call(&window.0, "eval", javascript).await
}
