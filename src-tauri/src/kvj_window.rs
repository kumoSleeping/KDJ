use tauri::Manager;

/// One editor webview per application. Hiding preserves unsaved gestures and live sessions.
#[tauri::command]
pub async fn open_kvj_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅 KDJ 主窗口可以打开 KVJ".into());
    }
    if let Some(editor) = app.get_webview_window("kvj") {
        editor.show().map_err(|e| e.to_string())?;
        editor.unminimize().map_err(|e| e.to_string())?;
        return editor.set_focus().map_err(|e| e.to_string());
    }
    let editor = tauri::WebviewWindowBuilder::new(
        &app,
        "kvj",
        tauri::WebviewUrl::App("index.html?window=kvj".into()),
    )
    .title("KVJ")
    .inner_size(1280.0, 860.0)
    .min_inner_size(760.0, 540.0)
    .build()
    .map_err(|e| e.to_string())?;
    let handle = editor.clone();
    editor.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(error) = handle.hide() {
                tracing::warn!(%error, "cannot hide KVJ window");
            }
        }
    });
    editor.set_focus().map_err(|e| e.to_string())
}
