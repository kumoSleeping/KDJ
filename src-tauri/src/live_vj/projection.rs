//! Persistent operator-selected standby asset; native projection lifetime is
//! independent of recognition and Bluetooth. No arbitrary-directory media scope.
use super::{
    document::{Document, Standby},
    LiveVj,
};
use tauri::{Emitter, Manager};
pub(super) fn broadcast(app: &tauri::AppHandle) {
    let live = app.state::<LiveVj>();
    let snapshot = {
        let mut view = live.view.lock().unwrap();
        view.revision += 1;
        view.clock_ms = super::clock_ms();
        view.clone()
    };
    if let Err(error) = app.emit_to("live-vj-output", "live-vj-presentation", snapshot) {
        tracing::warn!(%error,"投放通知失败，使用轮询");
    }
}
pub(super) fn load(app: &tauri::AppHandle) -> Result<Option<Standby>, String> {
    let live = app.state::<LiveVj>();
    let bridge = app.state::<super::Bridge>();
    let asset = live.with_store(&bridge.config.data_dir, |s| Ok(s.doc.standby.clone()))?;
    if let Some(asset) = &asset {
        app.asset_protocol_scope()
            .allow_file(&asset.path)
            .map_err(|e| e.to_string())?;
    }
    Ok(asset)
}
#[tauri::command]
pub async fn live_vj_standby(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    revision: u64,
    clear: bool,
) -> Result<Document, String> {
    super::main_window(&window)?;
    let asset = if clear {
        None
    } else {
        use tauri_plugin_dialog::DialogExt;
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .add_filter(
                "图片或视频",
                &[
                    "png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "mov", "m4v", "webm",
                ],
            )
            .pick_file(move |picked| {
                let _ = tx.send(picked);
            });
        let Some(picked) = rx.await.map_err(|e| e.to_string())? else {
            let live = app.state::<LiveVj>();
            return live.with_store(&app.state::<super::Bridge>().config.data_dir, |s| {
                Ok(s.doc.clone())
            });
        };
        let path = picked
            .into_path()
            .map_err(|e| e.to_string())?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err("请选择有效的图片或视频文件".into());
        }
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let kind = if ["png", "jpg", "jpeg", "webp", "gif", "bmp"].contains(&extension.as_str()) {
            "image"
        } else if ["mp4", "mov", "m4v", "webm"].contains(&extension.as_str()) {
            "video"
        } else {
            return Err("默认投放文件类型不支持".into());
        };
        if kind == "image" && metadata.len() > 64 * 1024 * 1024 {
            return Err("默认投放图片不能超过 64 MB".into());
        }
        Some(Standby::new(
            path.to_string_lossy().into_owned(),
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            kind.into(),
        ))
    };
    let live = app.state::<LiveVj>();
    let _gate = live.gate.lock().await;
    if let Some(asset) = &asset {
        app.asset_protocol_scope()
            .allow_file(&asset.path)
            .map_err(|e| e.to_string())?;
    }
    let document = live.with_store(&app.state::<super::Bridge>().config.data_dir, |store| {
        anyhow::ensure!(
            store.doc.revision == revision,
            "投放配置已更新，请刷新后重试"
        );
        let mut next = store.doc.clone();
        if let (Some(old), Some(new)) = (&mut next.standby, &asset) {
            old.path = new.path.clone();
            old.name = new.name.clone();
            old.kind = new.kind.clone();
        } else {
            next.standby = asset.clone();
        }
        store.commit(next)
    })?;
    {
        let mut view = live.view.lock().unwrap();
        view.standby = asset;
        view.projection_error.clear();
    }
    broadcast(&app);
    Ok(document)
}
#[tauri::command]
pub async fn live_vj_projection_open(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    output: String,
) -> Result<(), String> {
    super::main_window(&window)?;
    let live = app.state::<LiveVj>();
    let _gate = live.gate.lock().await;
    let standby = load(&app)?;
    {
        let mut view = live.view.lock().unwrap();
        view.standby = standby;
        view.projection_open = true;
        view.projection_error.clear();
    }
    broadcast(&app);
    if let Err(error) = super::open_output(&app, &output) {
        live.view.lock().unwrap().projection_open = false;
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub async fn live_vj_projection_close(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !["main", "live-vj-output"].contains(&window.label()) {
        return Err("窗口无权关闭投放".into());
    }
    let live = app.state::<LiveVj>();
    let _gate = live.gate.lock().await;
    super::stop_session(&app).await?;
    live.view.lock().unwrap().projection_open = false;
    super::hide_output(&app)
}
#[tauri::command]
pub fn live_vj_projection_error(
    window: tauri::WebviewWindow,
    live: tauri::State<LiveVj>,
    error: String,
) -> Result<(), String> {
    if window.label() != "live-vj-output" {
        return Err("窗口无权报告投放错误".into());
    }
    live.view.lock().unwrap().projection_error = error.chars().take(1000).collect();
    Ok(())
}
