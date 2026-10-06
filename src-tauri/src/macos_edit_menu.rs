use tauri::{menu::{Menu, MenuItem}, Manager};

/// WKWebView's predefined Undo menu item targets its native text undo manager.
/// An editor with only application history cannot enable that item, so Cmd-Z
/// never reaches DOM keydown/beforeinput. Route menu accelerators through the
/// same cancelable shortcut path as Windows, then fall back to native text undo.
/// Select All also bypasses DOM keydown in WKWebView: let the list shortcut own
/// it outside text fields, while preserving native selection inside text fields.
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    for item in menu.items()? {
        let Some(edit) = item.as_submenu() else { continue; };
        if edit.text()? != "Edit" {
            if edit.items()?.iter().any(|item| item.as_predefined_menuitem().is_some_and(|item| item.text().is_ok_and(|text| text.starts_with("About ")))) {
                edit.insert(&MenuItem::with_id(app, "kdj-preferences", "偏好设置…", true, Some("Cmd+,"))?, 1)?;
            }
            continue;
        }
        edit.remove_at(0)?;
        edit.remove_at(0)?;
        edit.insert(&MenuItem::with_id(app, "kdj-undo", "Undo", true, Some("Cmd+Z"))?, 0)?;
        edit.insert(&MenuItem::with_id(app, "kdj-redo", "Redo", true, Some("Cmd+Shift+Z"))?, 1)?;
        for (index, item) in edit.items()?.iter().enumerate() {
            if let Some(predefined) = item.as_predefined_menuitem() {
                if predefined.text()? == "Select All" {
                    edit.remove_at(index)?;
                    edit.insert(&MenuItem::with_id(app, "kdj-select-all", "Select All", true, Some("Cmd+A"))?, index)?;
                    break;
                }
            }
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "kdj-preferences" {
            if let Err(error) = crate::kvj_window::show_editor_window(app, "preferences") {
                tracing::warn!(%error, "无法打开偏好设置");
            }
            return;
        }
        let (key, code, shift, command) = match event.id().as_ref() {
            "kdj-undo" => ("z", "KeyZ", false, "undo"),
            "kdj-redo" => ("z", "KeyZ", true, "redo"),
            "kdj-select-all" => ("a", "KeyA", false, "selectAll"),
            _ => return,
        };
        let Some(window) = app.webview_windows().into_values().find(|window| {
            ["main", "kvj", "visualizer-studio", "live-vj-control", "preferences"].contains(&window.label())
                && window.is_focused().unwrap_or(false)
        }) else { return; };
        let script = format!(r#"(() => {{
            const target = document.activeElement || document.body;
            const event = new KeyboardEvent('keydown', {{
                key: '{key}', code: '{code}', metaKey: true, shiftKey: {shift},
                bubbles: true, cancelable: true
            }});
            if (target.dispatchEvent(event)) document.execCommand('{command}');
        }})()"#);
        if let Err(error) = window.eval(&script) {
            tracing::warn!(%error, "无法分发编辑菜单命令");
        }
    });
    Ok(())
}
