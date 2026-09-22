//! User-managed desktop media tools. Installation never changes the system PATH.
//! Stage and validate a complete package before atomically switching the manifest.
use std::{
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock, RwLock},
    time::Duration,
};

use anyhow::{bail, ensure, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

const FFMPEG_NAME: &str = if cfg!(windows) {
    "ffmpeg.exe"
} else {
    "ffmpeg"
};
const FFPROBE_NAME: &str = if cfg!(windows) {
    "ffprobe.exe"
} else {
    "ffprobe"
};

#[path = "managed_packages.rs"]
mod packages;
#[path = "managed_archives.rs"]
mod archives;
use archives::extract_archive;
use packages::{download_specs, import_folder, prepare_binary, unpack_archives};
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;
const MAX_UNPACKED: u64 = 1536 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
static MANAGER: OnceLock<Manager> = OnceLock::new();

#[derive(Clone, Default, Serialize)]
pub struct InstallProgress {
    pub phase: &'static str,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub component: Option<String>,
}

impl InstallProgress {
    fn busy(&self) -> bool {
        matches!(
            self.phase,
            "preparing" | "downloading" | "extracting" | "validating"
        )
    }
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    // Relative to the managed root; never load an arbitrary path from the manifest.
    binary: PathBuf,
}

struct Manager {
    root: PathBuf,
    selected: RwLock<Option<PathBuf>>,
    progress: Mutex<InstallProgress>,
}

pub enum InstallSource {
    Download,
    Archive(Vec<PathBuf>),
    Folder(PathBuf),
}

pub fn initialize(data_dir: &Path) {
    MANAGER.get_or_init(|| Manager::new(data_dir.join("tools").join("ffmpeg")));
}

pub fn selected_binary() -> Option<PathBuf> {
    MANAGER
        .get()
        .and_then(|m| m.selected.read().unwrap().clone())
}

pub fn progress() -> InstallProgress {
    MANAGER
        .get()
        .map(|m| m.progress.lock().unwrap().clone())
        .unwrap_or_else(|| InstallProgress {
            phase: "idle",
            ..Default::default()
        })
}

/// Called only after a native picker or the explicit install action.
pub fn start(source: InstallSource) -> Result<()> {
    ensure!(
        cfg!(any(windows, target_os = "macos")),
        "当前平台不支持此安装方式"
    );
    if matches!(source, InstallSource::Download) {
        download_specs(std::env::consts::OS, std::env::consts::ARCH)?;
    }
    let manager = MANAGER.get().context("媒体工具目录尚未初始化")?;
    {
        let mut progress = manager.progress.lock().unwrap();
        ensure!(!progress.busy(), "媒体工具正在安装");
        *progress = InstallProgress {
            phase: "preparing",
            ..Default::default()
        };
    }
    // The job survives closing the settings panel; status can be reattached later.
    tokio::spawn(async move {
        match manager.install(source).await {
            Ok(()) => manager.phase("done"),
            Err(error) => {
                *manager.progress.lock().unwrap() = InstallProgress {
                    phase: "failed",
                    error: Some(format!("{error:#}")),
                    ..Default::default()
                };
            }
        }
    });
    Ok(())
}

impl Manager {
    fn new(root: PathBuf) -> Self {
        let selected = fs::read(root.join("current.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
            .filter(|manifest| safe_relative(&manifest.binary))
            .map(|manifest| root.join(manifest.binary));
        // Old generations remain during the session so in-flight renders keep working.
        // Clean abandoned stages and previous generations on the next app startup.
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_name().to_string_lossy().starts_with("install-")
                    && !selected
                        .as_ref()
                        .is_some_and(|binary| binary.starts_with(&path))
                    && entry.file_type().is_ok_and(|kind| kind.is_dir())
                {
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
        Self {
            root,
            selected: RwLock::new(selected),
            progress: Mutex::new(InstallProgress {
                phase: "idle",
                ..Default::default()
            }),
        }
    }

    fn phase(&self, phase: &'static str) {
        *self.progress.lock().unwrap() = InstallProgress {
            phase,
            ..Default::default()
        };
    }

    async fn install(&self, source: InstallSource) -> Result<()> {
        fs::create_dir_all(&self.root).context("无法创建媒体工具目录")?;
        let stage = tempfile::Builder::new()
            .prefix("install-")
            .tempdir_in(&self.root)?;
        let package = stage.path().join("package");
        fs::create_dir(&package)?;
        let automatic = matches!(source, InstallSource::Download);
        let mut downloaded_archives = Vec::new();
        let source = match source {
            InstallSource::Download => {
                for (index, spec) in download_specs(std::env::consts::OS, std::env::consts::ARCH)?
                    .iter()
                    .enumerate()
                {
                    let archive = stage.path().join(format!("download-{index}.zip"));
                    self.download(&archive, spec)
                        .await
                        .with_context(|| format!("{} 安装失败（下载来源：{}）", spec.component, spec.publisher))?;
                    downloaded_archives.push(archive);
                }
                InstallSource::Archive(downloaded_archives.clone())
            }
            other => other,
        };
        self.phase("extracting");
        let package_clone = package.clone();
        let bin = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
            match source {
                InstallSource::Archive(paths) => unpack_archives(&paths, &package_clone)?,
                InstallSource::Folder(path) => import_folder(&path, &package_clone)?,
                InstallSource::Download => unreachable!(),
            }
            find_bin(&package_clone)
        })
        .await??;
        self.phase("validating");
        let mut versions = Vec::new();
        for (name, filename) in [("ffmpeg", FFMPEG_NAME), ("ffprobe", FFPROBE_NAME)] {
            let binary = bin.join(filename);
            prepare_binary(&binary, automatic).await?;
            let result = super::status::inspect(name, Some(binary)).await;
            versions.push(result.version.clone());
            ensure!(
                result.state == "ready",
                "{}",
                result.error.unwrap_or_else(|| format!("缺少 {filename}"))
            );
        }
        ensure!(
            versions[0] == versions[1],
            "FFmpeg 与 ffprobe 版本不一致，请导入同一版本的工具包"
        );
        packages::save_license(&bin.join(FFMPEG_NAME), &package).await?;
        // Remove only archives downloaded by this job; user imports are never removed.
        for archive in downloaded_archives {
            fs::remove_file(archive)?;
        }
        self.activate(&bin.join(FFMPEG_NAME))?;
        let _ = stage.keep();
        Ok(())
    }

    fn activate(&self, binary: &Path) -> Result<()> {
        let manifest = Manifest {
            binary: binary.strip_prefix(&self.root)?.to_path_buf(),
        };
        let mut temp = tempfile::NamedTempFile::new_in(&self.root)?;
        serde_json::to_writer(&mut temp, &manifest)?;
        temp.as_file().sync_all()?;
        temp.persist(self.root.join("current.json"))
            .context("无法保存媒体工具配置")?;
        *self.selected.write().unwrap() = Some(binary.to_path_buf());
        Ok(())
    }

    async fn download(&self, path: &Path, spec: &packages::DownloadSpec) -> Result<()> {
        kdj_core::ensure_rustls_ring();
        let client = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(15 * 60))
            .referer(false)
            .build()
            .context("无法初始化媒体工具下载客户端")?;
        // Some publishers redirect only ZIP endpoints, not checksum endpoints.
        // Resolve the concrete build with a headers-only GET (their route has no
        // HEAD handler), then use that exact version for both package and checksum.
        let download_url = if spec.resolve_redirect {
            download_request(&client, &spec.url, "解析安装包下载地址").await?.url().to_string()
        } else { spec.url.clone() };
        let checksum_url = format!("{download_url}.sha256");
        let response = download_request(&client, &checksum_url, "获取 SHA-256 校验文件").await?;
        let resolved_checksum_url = response.url().to_string();
        let mut checksum = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| download_error("读取 SHA-256 校验文件", &resolved_checksum_url, error))?;
            ensure!(checksum.len() + chunk.len() <= 4096, "下载校验信息过大");
            checksum.extend_from_slice(&chunk);
        }
        let checksum = String::from_utf8(checksum)?;
        let expected = checksum
            .split_whitespace()
            .next()
            .context("下载来源未提供校验值")?;
        ensure!(
            expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_hexdigit()),
            "下载校验信息无效"
        );
        let response = download_request(&client, &download_url, "下载 ZIP 安装包").await?;
        let resolved_url = response.url().to_string();
        let total = response.content_length();
        ensure!(
            total.is_none_or(|size| size <= MAX_DOWNLOAD),
            "下载包超过大小限制"
        );
        let mut file = tokio::fs::File::create(path).await?;
        let mut stream = response.bytes_stream();
        let mut hash = Sha256::new();
        let mut downloaded = 0;
        self.phase("downloading");
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| download_error("接收 ZIP 安装包", &resolved_url, error))?;
            downloaded += chunk.len() as u64;
            ensure!(downloaded <= MAX_DOWNLOAD, "下载包超过大小限制");
            hash.update(&chunk);
            file.write_all(&chunk).await?;
            *self.progress.lock().unwrap() = InstallProgress {
                phase: "downloading",
                downloaded,
                total,
                error: None,
                component: Some(spec.component.to_owned()),
            };
        }
        file.flush().await?;
        ensure!(
            hex::encode(hash.finalize()).eq_ignore_ascii_case(expected),
            "下载包校验失败，请重新安装"
        );
        fs::write(
            path.with_extension("origin.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "url": spec.url,
                "resolved_url": resolved_url,
                "sha256": expected.to_ascii_lowercase(),
                "publisher": spec.publisher,
                "source_and_license": spec.source_page
            }))?,
        )?;
        Ok(())
    }
}

async fn download_request(client: &reqwest::Client, url: &str, step: &str) -> Result<reqwest::Response> {
    client.get(url).send().await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| download_error(step, url, error))
}

fn download_error(step: &str, url: &str, error: reqwest::Error) -> anyhow::Error {
    let reason = if error.is_timeout() {
        "请求超时，请检查网络或代理后重试".to_owned()
    } else if let Some(status) = error.status() {
        format!("下载服务器返回 HTTP {status}")
    } else if error.is_redirect() {
        "下载地址重定向失败".to_owned()
    } else if error.is_connect() {
        "无法建立下载连接，请检查网络、代理及下方 DNS / TLS 错误详情".to_owned()
    } else if error.is_body() || error.is_decode() {
        "接收下载数据失败，可重试或手动下载后导入压缩包".to_owned()
    } else {
        "下载请求失败，请查看下方错误详情；也可手动下载后导入压缩包".to_owned()
    };
    let request_url = error.url().map(|value| value.as_str()).unwrap_or(url).to_owned();
    anyhow::Error::new(error).context(format!("\n{step}失败：{reason}\n请求地址：{request_url}\n错误详情"))
}

fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)))
}

fn safe_windows_name(name: &str) -> bool {
    if name.ends_with(['.', ' ']) || name.chars().any(|c| c < ' ' || "<>:\"\\|?*".contains(c)) {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) && !(stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn has_pair(path: &Path) -> bool {
    [FFMPEG_NAME, FFPROBE_NAME]
        .iter()
        .all(|name| path.join(name).is_file())
}

/// Accept bin, a package root, or nested extraction wrappers (up to four levels).
fn find_bin(root: &Path) -> Result<PathBuf> {
    if has_pair(root) {
        return Ok(root.to_path_buf());
    }
    if has_pair(&root.join("bin")) {
        return Ok(root.join("bin"));
    }
    let mut found = Vec::new();
    find_package_bins(root, 0, &mut 0, &mut found)?;
    found
        .pop()
        .context("缺少 FFmpeg 或 ffprobe，请选择完整的工具文件夹；分开的压缩包请同时选择")
}

fn find_package_bins(root: &Path, depth: usize, count: &mut usize, found: &mut Vec<PathBuf>) -> Result<()> {
    if depth >= 4 {
        return Ok(());
    }
    for entry in fs::read_dir(root).context("无法读取文件夹，请选择解压后的 FFmpeg 文件夹")? {
        let entry = entry?;
        *count += 1;
        ensure!(*count <= MAX_FILES, "文件数量过多，请直接选择解压后的 FFmpeg 文件夹");
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        if has_pair(&path) {
            found.push(path);
        } else {
            find_package_bins(&path, depth + 1, count, found)?;
        }
        ensure!(found.len() <= 1, "文件夹中有多套 FFmpeg，请直接选择其中一套的文件夹");
    }
    Ok(())
}

fn extract_zip(source: &Path, target: &Path) -> Result<()> {
    let file = File::open(source).context("无法打开 ZIP")?;
    ensure!(file.metadata()?.len() <= MAX_DOWNLOAD, "ZIP 超过大小限制");
    let mut zip =
        zip::ZipArchive::new(file).context("无法读取 ZIP，请选择 FFmpeg 的 ZIP 压缩包")?;
    ensure!(zip.len() <= MAX_FILES, "ZIP 文件数量过多");
    let mut total = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name();
        // Reject Windows drive paths, alternate data streams, and backslash traversal
        // even when validation is running on macOS/Linux.
        ensure!(!name.contains([':', '\\']), "ZIP 包含不安全的路径");
        let relative = entry.enclosed_name().context("ZIP 包含不安全的路径")?;
        ensure!(safe_relative(&relative), "ZIP 包含不安全的路径");
        ensure!(
            relative
                .components()
                .all(|part| part.as_os_str().to_str().is_some_and(safe_windows_name)),
            "ZIP 包含 Windows 不支持的文件名"
        );
        ensure!(
            entry
                .unix_mode()
                .is_none_or(|mode| mode & 0o170000 != 0o120000),
            "ZIP 不支持符号链接"
        );
        let path = target.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&path)?;
            continue;
        }
        ensure!(
            entry.size() <= MAX_UNPACKED - total,
            "解压后的工具包超过大小限制"
        );
        total += entry.size();
        fs::create_dir_all(path.parent().context("无效的 ZIP 路径")?)?;
        let expected = entry.size();
        let mut output = File::options().write(true).create_new(true).open(&path)?;
        let copied = std::io::copy(&mut (&mut entry).take(expected + 1), &mut output)?;
        ensure!(copied == expected, "ZIP 文件大小校验失败");
    }
    Ok(())
}

fn copy_package(
    source: &Path,
    target: &Path,
    depth: usize,
    count: &mut usize,
    bytes: &mut u64,
) -> Result<()> {
    ensure!(depth <= 12, "文件夹层级过深，请选择 FFmpeg 工具文件夹");
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        *count += 1;
        ensure!(
            *count <= MAX_FILES,
            "文件数量过多，请选择 FFmpeg 工具文件夹"
        );
        let kind = entry.file_type()?;
        ensure!(!kind.is_symlink(), "工具文件夹不支持符号链接");
        let dest = target.join(entry.file_name());
        if kind.is_dir() {
            copy_package(&entry.path(), &dest, depth + 1, count, bytes)?;
        } else if kind.is_file() {
            let mut input = File::open(entry.path())?;
            let size = input.metadata()?.len();
            ensure!(size <= MAX_UNPACKED - *bytes, "工具文件夹超过大小限制");
            *bytes += size;
            let mut output = File::options().write(true).create_new(true).open(dest)?;
            let copied = std::io::copy(&mut (&mut input).take(size + 1), &mut output)?;
            ensure!(copied == size, "复制时源文件发生变化，请重试");
        } else {
            bail!("工具文件夹包含不支持的文件");
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "managed_tests.rs"]
mod tests;
