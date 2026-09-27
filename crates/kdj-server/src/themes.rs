//! 主题包：`data_dir/themes/<id>/` 下由用户自己放进去的文件夹。
//! 清单内容的校验在前端 `src/lib/themePack.ts`，这里只列目录、原样发文件。
//!
//! 文件路由把 media token 放在路径段里而不是 query：主题 CSS 里的相对 `url()`
//! （字体、边框图、光标）要能直接解析到同一前缀下。

use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::services::ServeFile;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const MAX_MANIFEST: u64 = 64 * 1024;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/themes", get(list))
        .route("/api/themes/files/{token}/{dir}/{*path}", get(file))
}

/// 与前端 `THEME_ID` 同一套字符集；目录名即主题 id。
pub fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && !id.starts_with('-')
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn safe_relative(path: &FsPath) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)))
}

fn read_manifest(dir: &FsPath) -> Result<Value, String> {
    let path = dir.join("theme.json");
    let size = std::fs::metadata(&path).map_err(|_| "缺少 theme.json".to_owned())?.len();
    if size > MAX_MANIFEST {
        return Err("theme.json 过大".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("无法读取 theme.json：{e}"))?;
    // Windows 的记事本等编辑器会存成带 BOM 的 UTF-8，serde_json 不认
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("theme.json 不是有效的 JSON：{e}"))
}

fn scan(root: &FsPath) -> std::io::Result<Vec<Value>> {
    std::fs::create_dir_all(root)?;
    let mut themes = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if !valid_id(&name) || !entry.path().is_dir() {
            continue;
        }
        themes.push(match read_manifest(&entry.path()) {
            Ok(manifest) => json!({ "dir": name, "manifest": manifest, "error": null }),
            Err(error) => json!({ "dir": name, "manifest": null, "error": error }),
        });
    }
    themes.sort_by(|a, b| a["dir"].as_str().cmp(&b["dir"].as_str()));
    Ok(themes)
}

fn themes_dir(state: &AppState) -> PathBuf {
    state.config.data_dir.join("themes")
}

async fn list(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let root = themes_dir(&state);
    let dir = root.to_string_lossy().into_owned();
    let themes = tokio::task::spawn_blocking(move || scan(&root))
        .await
        .map_err(anyhow::Error::from)?
        .map_err(anyhow::Error::from)?;
    Ok(Json(json!({ "dir": dir, "themes": themes })))
}

/// 主题目录内的普通文件；任何越出 `themes/<id>/` 的写法都拒绝。
/// 先按字面校验，再解析符号链接后确认仍在主题目录里：别人分享的主题包里
/// 可以带一个指向 `~/.ssh` 的链接，字面上它是合法的相对路径。
fn resolve(root: &FsPath, dir: &str, path: &str) -> Option<PathBuf> {
    if !valid_id(dir) || !safe_relative(FsPath::new(path)) {
        return None;
    }
    let pack = root.join(dir).canonicalize().ok()?;
    let target = pack.join(path).canonicalize().ok()?;
    (target.starts_with(&pack) && target.is_file()).then_some(target)
}

async fn file(
    State(state): State<Arc<AppState>>,
    Path((_token, dir, path)): Path<(String, String, String)>,
    request: Request,
) -> ApiResult<Response> {
    let target = resolve(&themes_dir(&state), &dir, &path)
        .ok_or_else(|| ApiError::not_found("主题文件不存在"))?;
    let response = ServeFile::new(target)
        .try_call(request)
        .await
        .map_err(anyhow::Error::from)?;
    Ok(response.map(Body::new))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("kdj-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    #[test]
    fn ids_and_paths_cannot_escape_the_theme_folder() {
        let base = scratch("theme-paths");
        let root = &base.join("themes");
        std::fs::create_dir_all(root.join("sketch/fonts")).unwrap();
        std::fs::create_dir_all(root.join("pixel")).unwrap();
        std::fs::write(root.join("sketch/fonts/a.ttf"), b"font").unwrap();
        std::fs::write(root.join("sketch/theme.css"), b"css").unwrap();
        std::fs::write(root.join("pixel/theme.css"), b"css").unwrap();
        std::fs::write(base.join("secret"), b"secret").unwrap();
        assert_eq!(
            resolve(root, "sketch", "fonts/a.ttf"),
            Some(root.join("sketch/fonts/a.ttf"))
        );
        // 目录、不存在的文件都不是可发的文件
        assert_eq!(resolve(root, "sketch", "fonts"), None);
        assert_eq!(resolve(root, "sketch", "missing.css"), None);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("secret"), root.join("sketch/link.txt")).unwrap();
            std::os::unix::fs::symlink(&base, root.join("sketch/up")).unwrap();
            std::os::unix::fs::symlink(root.join("sketch/theme.css"), root.join("sketch/alias.css")).unwrap();
            assert_eq!(resolve(root, "sketch", "link.txt"), None);
            assert_eq!(resolve(root, "sketch", "up/secret"), None);
            // 包内的链接仍然可用
            assert_eq!(resolve(root, "sketch", "alias.css"), Some(root.join("sketch/theme.css")));
        }
        for (dir, path) in [
            ("..", "theme.css"),
            ("sketch", "../pixel/theme.css"),
            ("sketch", "/etc/passwd"),
            ("sketch", "a/../../x"),
            ("sketch", ""),
            ("Sketch", "theme.css"),
            ("a/b", "theme.css"),
            ("-x", "theme.css"),
            ("", "theme.css"),
        ] {
            assert_eq!(resolve(root, dir, path), None, "{dir} / {path}");
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scan_lists_folders_and_reports_broken_manifests() {
        let root = std::env::temp_dir().join(format!("kdj-themes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (dir, manifest) in [("ok", Some("\u{feff}{\"id\":\"ok\"}")), ("broken", Some("{")), ("empty", None)] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            if let Some(text) = manifest {
                std::fs::write(root.join(dir).join("theme.json"), text).unwrap();
            }
        }
        std::fs::create_dir_all(root.join("Not Valid")).unwrap();
        std::fs::write(root.join("loose.zip"), b"x").unwrap();

        let themes = scan(&root).unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        let dirs: Vec<_> = themes.iter().map(|t| t["dir"].as_str().unwrap()).collect();
        assert_eq!(dirs, ["broken", "empty", "ok"]);
        assert!(themes[0]["error"].is_string() && themes[1]["error"].is_string());
        assert_eq!(themes[2]["manifest"]["id"], "ok");
    }
}
