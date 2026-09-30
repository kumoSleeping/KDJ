//! 主题包：`data_dir/themes/<id>/` 下手动放置或从 GitHub 按需安装的文件夹。
//! 清单内容的校验在前端 `src/lib/themePack.ts`，这里只列目录、原样发文件。
//!
//! 文件路由把 media token 放在路径段里而不是 query：主题 CSS 里的相对 `url()`
//! （字体、边框图、光标）要能直接解析到同一前缀下。

use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::response::Response;
use axum::routing::{get, post};
use futures_util::{stream, StreamExt, TryStreamExt};
use sha2::{Digest, Sha256};
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::services::ServeFile;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const MAX_MANIFEST: u64 = 64 * 1024;
const OFFICIAL_SOURCE: &str = "https://raw.githubusercontent.com/kumoSleeping/KDJ/main/themes/official";
const OFFICIAL_THEMES: &[(&str, &str)] = &[("sakulaptop98", "Sakura98")];
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/themes", get(list))
        .route("/api/themes/official/{id}", post(install))
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
    serde_json::from_str(&text).map_err(|e| format!("theme.json 不是有效的 JSON：{e}"))
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
    let official: Vec<_> = OFFICIAL_THEMES.iter()
        .map(|(id, name)| json!({ "id": id, "name": name })).collect();
    Ok(Json(json!({ "dir": dir, "themes": themes, "official": official })))
}

/// Only fixed GitHub origins, bounded responses and manifest-listed static assets.
async fn download(client: &reqwest::Client, url: &str, limit: usize) -> anyhow::Result<Vec<u8>> {
    let mut response = client.get(url).send().await?.error_for_status()?;
    anyhow::ensure!(response.content_length().unwrap_or(0) <= limit as u64, "主题文件过大");
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(bytes.len() + chunk.len() <= limit, "主题文件过大");
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn install(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    if !OFFICIAL_THEMES.iter().any(|(known, _)| *known == id) {
        return Err(ApiError::bad_request("未知的官方主题"));
    }
    let _guard = INSTALL_LOCK.lock().await;
    let result = install_official(&themes_dir(&state), &id).await;
    result.map_err(|error| ApiError::bad_request(format!("主题安装失败：{error:#}")))?;
    Ok(Json(json!({ "id": id })))
}

async fn install_official(root: &FsPath, id: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let base = format!("{OFFICIAL_SOURCE}/{id}");
    let bytes = download(&client, &format!("{base}/theme.json"), MAX_MANIFEST as usize).await?;
    let manifest: Value = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(manifest["kdj"] == 1 && manifest["id"] == id, "主题清单版本或 id 无效");
    anyhow::ensure!(manifest["name"].as_str().is_some_and(|s| !s.trim().is_empty()), "主题名称无效");
    anyhow::ensure!(manifest.get("js").is_none(), "官方主题不允许执行脚本");
    let modes = manifest["modes"].as_array().ok_or_else(|| anyhow::anyhow!("缺少主题模式"))?;
    anyhow::ensure!(!modes.is_empty(), "缺少主题模式");
    for mode in modes {
        let mode = mode.as_str().unwrap_or("");
        let color = manifest["window"][mode].as_str().unwrap_or("");
        anyhow::ensure!(["light", "dark"].contains(&mode)
            && color.len() == 7 && color.starts_with('#')
            && color[1..].bytes().all(|b| b.is_ascii_hexdigit()), "主题模式或窗口颜色无效");
    }
    let files = manifest["files"].as_object().ok_or_else(|| anyhow::anyhow!("缺少主题文件清单"))?;
    anyhow::ensure!(!files.is_empty() && files.len() <= 128, "主题文件数量无效");
    for key in ["css", "svg"] {
        if key == "svg" && manifest.get(key).is_none() { continue; }
        anyhow::ensure!(manifest[key].as_str().is_some_and(|path| files.contains_key(path)), "缺少 {key} 文件");
    }
    for (path, hash) in files {
        anyhow::ensure!(path != "theme.json" && path.len() <= 240
            && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
            && path.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_/ .".contains(&b))
            && safe_relative(FsPath::new(path)), "无效的主题资源路径");
        let extension = FsPath::new(path).extension().and_then(|s| s.to_str()).unwrap_or("");
        anyhow::ensure!(["css", "svg", "png", "jpg", "webp", "woff2", "txt", "md"].contains(&extension), "不支持的主题资源类型");
        anyhow::ensure!(hash.as_str().is_some_and(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())), "无效的资源摘要");
    }
    tokio::fs::create_dir_all(root).await?;
    // Same filesystem: publish only after every file verifies; cancellation cleans staging.
    let stage = tempfile::Builder::new().prefix(".install-").tempdir_in(root)?;
    let stage_path = stage.path();
    let total = std::sync::atomic::AtomicUsize::new(0);
    let downloaded: Vec<usize> = stream::iter(files.clone().into_iter().map(|(path, hash)| {
        let client = &client;
        let base = &base;
        let total = &total;
        async move {
            let data = download(client, &format!("{base}/{path}"), 2 * 1024 * 1024).await?;
            anyhow::ensure!(format!("{:x}", Sha256::digest(&data)) == hash.as_str().unwrap(), "资源校验失败：{path}，请重试");
            anyhow::ensure!(total.fetch_add(data.len(), std::sync::atomic::Ordering::Relaxed)
                + data.len() <= 16 * 1024 * 1024, "主题包过大");
            let target = stage_path.join(&path);
            tokio::fs::create_dir_all(target.parent().unwrap()).await?;
            tokio::fs::write(target, &data).await?;
            Ok::<_, anyhow::Error>(data.len())
        }
    })).buffer_unordered(6).try_collect().await?;
    anyhow::ensure!(downloaded.iter().sum::<usize>() <= 16 * 1024 * 1024, "主题包过大");
    tokio::fs::write(stage.path().join("theme.json"), bytes).await?;
    let target = root.join(id);
    let backup = root.join(format!(".backup-{id}-{}", rand::random::<u64>()));
    // No await between the two renames: cancellation must not strand an existing pack.
    let existed = target.symlink_metadata().is_ok();
    if existed { std::fs::rename(&target, &backup)?; }
    if let Err(error) = std::fs::rename(stage.path(), &target) {
        if existed { std::fs::rename(&backup, &target)?; }
        return Err(error.into());
    }
    // Preserve the previous folder (including custom files); never delete user assets.
    Ok(())
}

/// 主题目录内的文件路径；任何越出 `themes/<id>/` 的写法都拒绝。
fn resolve(root: &FsPath, dir: &str, path: &str) -> Option<PathBuf> {
    (valid_id(dir) && safe_relative(FsPath::new(path))).then(|| root.join(dir).join(path))
}

async fn file(
    State(state): State<Arc<AppState>>,
    Path((_token, dir, path)): Path<(String, String, String)>,
    request: Request,
) -> ApiResult<Response> {
    let target = resolve(&themes_dir(&state), &dir, &path)
        .ok_or_else(|| ApiError::bad_request("无效的主题文件路径"))?;
    let response = ServeFile::new(target)
        .try_call(request)
        .await
        .map_err(anyhow::Error::from)?;
    Ok(response.map(Body::new))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_paths_cannot_escape_the_theme_folder() {
        let root = FsPath::new("/data/themes");
        assert_eq!(
            resolve(root, "sketch", "fonts/a.ttf"),
            Some(PathBuf::from("/data/themes/sketch/fonts/a.ttf"))
        );
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
    }

    #[test]
    fn scan_lists_folders_and_reports_broken_manifests() {
        let root = std::env::temp_dir().join(format!("kdj-themes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (dir, manifest) in [("ok", Some(r#"{"id":"ok"}"#)), ("broken", Some("{")), ("empty", None)] {
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
