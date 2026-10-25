use tauri::Manager;

const EDITOR_WINDOWS: &[&str] = &["visualizer-studio", "preferences"];

/// Each tool owns a separate window. Hiding preserves edits and running sessions.
pub fn show_editor_window(app: &tauri::AppHandle, kind: &str) -> Result<(), String> {
    ensure_editor_window(app, kind, false)
}

fn ensure_editor_window(
    app: &tauri::AppHandle,
    kind: &str,
    background: bool,
) -> Result<(), String> {
    let (title, width, height, min_width, min_height) = match kind {
        "visualizer-studio" => ("歌曲可视化", 960.0, 740.0, 720.0, 520.0),
        "preferences" => ("偏好设置", 720.0, 600.0, 620.0, 460.0),
        _ => return Err("不支持的工具窗口".into()),
    };
    if let Some(editor) = app.get_webview_window(kind) {
        if background {
            return Ok(());
        }
        editor.show().map_err(|e| e.to_string())?;
        editor.unminimize().map_err(|e| e.to_string())?;
        return editor.set_focus().map_err(|e| e.to_string());
    }
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        kind,
        tauri::WebviewUrl::App(format!("index.html?window={kind}").into()),
    )
    .title(title)
    .inner_size(width, height)
    .min_inner_size(min_width, min_height)
    .maximizable(kind != "preferences")
    .visible(!background)
    .focused(!background)
    // The visualizer window renders the export queue's frames while never shown; throttled
    // like a hidden page its exports stall and fail (the main window has this in tauri.conf.json).
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .center();
    // Editor tools use the same single-row chrome as the main window; preferences
    // keeps its native title bar until it has its own in-page chrome.
    #[cfg(target_os = "macos")]
    let builder = if kind == "preferences" {
        builder
    } else {
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(14.0, 18.0))
            .accept_first_mouse(true)
    };
    #[cfg(not(target_os = "macos"))]
    let builder = if kind == "preferences" {
        builder
    } else {
        builder.decorations(false)
    };
    let editor = builder.build().map_err(|e| e.to_string())?;
    let handle = editor.clone();
    editor.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(error) = handle.hide() {
                tracing::warn!(%error, "cannot hide tool window");
            }
        }
    });
    if background {
        Ok(())
    } else {
        editor.set_focus().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn open_kvj_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    kind: String,
    background: Option<bool>,
) -> Result<(), String> {
    if window.label() != "main" && !EDITOR_WINDOWS.contains(&window.label()) {
        return Err("仅应用窗口可以打开编辑工具".into());
    }
    ensure_editor_window(&app, &kind, background.unwrap_or(false))
}
