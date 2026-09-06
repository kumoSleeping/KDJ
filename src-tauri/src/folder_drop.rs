use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{DragDropEvent, Emitter, Manager, Webview, WebviewEvent, Window, WindowEvent};

#[derive(Clone, Serialize)]
struct FolderDrop {
    paths: Vec<String>,
    error: Option<String>,
}

fn collect_folders(paths: Vec<PathBuf>) -> FolderDrop {
    let mut seen = HashSet::new();
    let mut folders = Vec::new();
    let mut errors = Vec::new();
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {
                folders.push(path.to_string_lossy().into_owned());
            }
            Ok(_) => {} // 图片、曲目等普通文件保留给各自的拖放入口。
            Err(error) => errors.push(format!("{}：{error}", path.display())),
        }
    }
    FolderDrop {
        paths: folders,
        error: (!errors.is_empty()).then(|| errors.join("；")),
    }
}

fn collect_media_files(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .iter()
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    kdj_providers::workshop_images::is_image_extension(ext)
                        || kdj_providers::tags::is_media_extension(ext)
                })
                && path.is_file()
                && seen.insert((*path).clone())
        })
        .cloned()
        .collect()
}

/// Wry 0.55: AppKit draggingLocation and GTK drag-motion use logical points.
/// Only WebView2 reports device pixels. Tauri labels all of them PhysicalPosition
/// without converting; dividing AppKit coordinates again misses the VJ hit target.
fn client_position(x: f64, y: f64, scale: f64, physical: bool) -> (f64, f64) {
    let divisor = if physical && scale.is_finite() && scale > 0. {
        scale
    } else {
        1.
    };
    (x / divisor, y / divisor)
}

/// One native event owns a drop. The frontend chooses VJ or the library once;
/// emitting a second folder event used to scan mixed Finder selections as well.
pub(super) fn handle_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::DragDrop(drop) = event {
        handle_drop(
            window.label(),
            window.app_handle(),
            window.scale_factor().unwrap_or(1.),
            drop,
        );
    }
}

pub(super) fn handle_webview_event(webview: &Webview, event: &WebviewEvent) {
    if let WebviewEvent::DragDrop(drop) = event {
        handle_drop(
            webview.label(),
            webview.app_handle(),
            webview.window().scale_factor().unwrap_or(1.),
            drop,
        );
    }
}

fn handle_drop(label: &str, app: &tauri::AppHandle, scale: f64, drop: &DragDropEvent) {
    if label != "main" {
        return;
    }
    static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    if matches!(drop, DragDropEvent::Enter { .. }) {
        EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    let id = EPOCH.load(std::sync::atomic::Ordering::Relaxed);
    let (phase, position, paths) = match drop {
        DragDropEvent::Enter { position, paths } => ("enter", Some(*position), paths.clone()),
        DragDropEvent::Over { position } => ("over", Some(*position), vec![]),
        DragDropEvent::Drop { position, paths } => ("drop", Some(*position), paths.clone()),
        DragDropEvent::Leave => ("leave", None, vec![]),
        _ => return,
    };
    let app = app.clone();
    let (x, y) = position
        .map(|p| client_position(p.x as f64, p.y as f64, scale, cfg!(target_os = "windows")))
        .unwrap_or((0., 0.));
    if phase != "drop" {
        let _ = app.emit_to(
            "main",
            "kdj:media-drop",
            serde_json::json!({"id":id,"phase":phase,"x":x,"y":y,"paths":paths}),
        );
        return;
    }
    static LAST_DROP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);
    if LAST_DROP.swap(id, std::sync::atomic::Ordering::Relaxed) == id {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let folders = collect_folders(paths.clone());
        let bridge = app.state::<super::Bridge>();
        let files = collect_media_files(&paths);
        bridge.activity_log.record_level(
            kdj_server::activity_log::ActivityCategory::User,
            kdj_server::activity_log::ActivityLevel::Info,
            "原生文件拖入",
            format!(
                "#{id} ({x:.0}, {y:.0}) 收到 {} 项，媒体 {} 项，目录 {} 项，读取错误 {}",
                paths.len(),
                files.len(),
                folders.paths.len(),
                folders.error.is_some()
            ),
        );
        for path in &files {
            bridge.grant_picked_path(path);
        }
        for path in &folders.paths {
            bridge.grant_picked_path(std::path::Path::new(path));
        }
        let _ = app.emit_to(
            "main",
            "kdj:media-drop",
            serde_json::json!({
                "id":id,"phase":phase,"x":x,"y":y,"paths":files,
                "folders":folders.paths,"error":folders.error
            }),
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retina_logical_drop_coordinates_are_not_scaled_twice() {
        assert_eq!(client_position(1100., 600., 2., false), (1100., 600.));
        assert_eq!(client_position(2200., 1200., 2., true), (1100., 600.));
        assert_eq!(client_position(1100., 600., 1., true), (1100., 600.));
    }

    #[test]
    fn folders_are_preserved_and_files_duplicates_and_missing_paths_are_handled() {
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let fixture = Fixture(std::env::temp_dir().join(format!(
            "kdj-folder-drop-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        )));
        let first = fixture.0.join("音乐 空格 # %");
        let second = fixture.0.join("empty");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let file = first.join("cover.png");
        std::fs::write(&file, b"image").unwrap();
        let archive = first.join("archive.zip");
        std::fs::write(&archive, b"zip").unwrap();
        let misleading_directory = first.join("folder.png");
        std::fs::create_dir_all(&misleading_directory).unwrap();
        assert_eq!(
            collect_media_files(&[file.clone(), file.clone(), archive, misleading_directory]),
            vec![file.clone()]
        );
        let missing = fixture.0.join("missing");
        let result = collect_folders(vec![
            first.clone(),
            file.clone(),
            second.clone(),
            first.clone(),
            missing,
        ]);
        assert_eq!(
            result.paths,
            vec![first.to_string_lossy(), second.to_string_lossy()]
        );
        assert!(result.error.unwrap().contains("missing"));
        let files_only = collect_folders(vec![file]);
        assert!(files_only.paths.is_empty());
        assert!(files_only.error.is_none());
        assert!(collect_folders(Vec::new()).paths.is_empty());
    }
}
