//! 后台下好的更新包：暂存在缓存目录，下次启动时、主窗口露面之前装上。
//!
//! 下载和安装分两步，是为了不打断正在用的人：自动下载只把签过名的包放进
//! `<app_cache_dir>/update/`，用户可以在设置里立即重启更新，不点也没关系，下次启动
//! 时自己装。不在退出时装：Windows 的 NSIS 安装器在更新模式下装完会把应用重新拉起来，
//! 刚退出的应用又会自己弹出来。
//!
//! 包只认它下载时对应的那一次发布（版本和签名都要和清单里的一样），装之前用内嵌公钥
//! 重新验签；任何一项对不上就删掉，前端下次检查时重新下。

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};

const META: &str = "staged.json";
const PACKAGE: &str = "package.bin";
/// 启动时为装暂存包问一次清单，最多等这么久；离线就照常启动，包留着下次再装。
const LAUNCH_CHECK_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Serialize, Deserialize)]
struct StagedMeta {
    version: String,
    signature: String,
}

/// 下载和安装一次只做一件：手动「立即重启更新」会等后台那次下载完，接着用它。
#[derive(Default)]
pub struct UpdateLock(pub tokio::sync::Mutex<()>);

fn dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|dir| dir.join("update"))
}

fn read_meta(app: &tauri::AppHandle) -> Option<StagedMeta> {
    let text = std::fs::read_to_string(dir(app)?.join(META)).ok()?;
    serde_json::from_str(&text).ok()
}

fn pubkey(app: &tauri::AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()
        .map(str::to_owned)
}

fn base64_text(value: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(value).ok()?;
    String::from_utf8(bytes).ok()
}

/// 和 tauri-plugin-updater 下载时的校验一样：minisign，公钥和签名都是 base64 包着的文本。
fn verified(app: &tauri::AppHandle, bytes: &[u8], signature: &str) -> bool {
    let check = || -> Option<()> {
        let key = minisign_verify::PublicKey::decode(&base64_text(&pubkey(app)?)?).ok()?;
        let signature = minisign_verify::Signature::decode(&base64_text(signature)?).ok()?;
        key.verify(bytes, &signature, true).ok()
    };
    check().is_some()
}

/// 这次发布的暂存包，验过签；没有或对不上是 `None`。
pub fn read(app: &tauri::AppHandle, update: &Update) -> Option<Vec<u8>> {
    let meta = read_meta(app)?;
    if meta.version != update.version || meta.signature != update.signature {
        return None;
    }
    let bytes = std::fs::read(dir(app)?.join(PACKAGE)).ok()?;
    verified(app, &bytes, &update.signature).then_some(bytes)
}

/// 先写包再写说明：说明在，包就是完整的。
pub fn write(app: &tauri::AppHandle, update: &Update, bytes: &[u8]) -> Result<(), String> {
    let dir = dir(app).ok_or("拿不到缓存目录，无法暂存更新包")?;
    clear(app);
    std::fs::create_dir_all(&dir).map_err(|err| format!("暂存更新包失败：{err}"))?;
    std::fs::write(dir.join(PACKAGE), bytes).map_err(|err| format!("暂存更新包失败：{err}"))?;
    let meta = StagedMeta {
        version: update.version.clone(),
        signature: update.signature.clone(),
    };
    let text = serde_json::to_string(&meta).map_err(|err| err.to_string())?;
    std::fs::write(dir.join(META), text).map_err(|err| format!("暂存更新包失败：{err}"))
}

pub fn clear(app: &tauri::AppHandle) {
    if let Some(dir) = dir(app) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// 启动时（setup 里、主窗口显示之前）装上次暂存的包。装上就重启进新版本
/// （Windows 由安装器结束进程并重新拉起）；其余情况照常启动。
pub fn install_at_launch(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(meta) = read_meta(app) else { return };
    let current = app.package_info().version.clone();
    let staged_is_newer = semver::Version::parse(&meta.version)
        .is_ok_and(|staged| crate::release_version::is_newer(&current, &staged));
    if !staged_is_newer {
        // 已经装上了（Windows 的安装器在我们删之前就结束了进程），或者是旧包。
        clear(app);
        return;
    }
    let update = tauri::async_runtime::block_on(async {
        let updater = app.updater_builder().timeout(LAUNCH_CHECK_TIMEOUT).build().ok()?;
        updater.check().await.ok().flatten()
    });
    let Some(update) = update else {
        tracing::info!(version = meta.version, "启动时查不到更新清单，暂存的更新包留到下次启动");
        return;
    };
    let Some(bytes) = read(app, &update) else {
        // 之后又发了新版，或包坏了：删掉，前端检查时下最新的。
        tracing::info!(staged = meta.version, latest = update.version, "暂存的更新包不是这次发布的，删掉");
        clear(app);
        return;
    };
    tracing::info!(version = update.version, "安装上次暂存的更新包");
    match update.install(&bytes) {
        Ok(()) => {
            clear(app);
            app.restart();
        }
        Err(err) => {
            tracing::warn!("安装暂存的更新包失败，照常启动：{err}");
            clear(app);
        }
    }
}
