//! KDJ 可读写虚拟 U 盘。
//!
//! 镜像生命周期属于桌面壳，而不是 axum server：macOS 要调用 hdiutil，Windows
//! 要经 UAC 调用系统自带 DiskPart。server 只接收已验证的挂载点，继续复用真实
//! U 盘的 OneLibrary 导出与路径边界检查。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, Runtime};

const DEFAULT_VOLUME_NAME: &str = "KDJ";
const MIB_BYTES: u64 = 1_048_576;
#[cfg(any(target_os = "windows", test))]
const IMAGE_SIZE_BYTES: u64 = 1_073_741_824;
const DEFAULT_SIZE_MIB: u64 = 8 * 1024;
const MIN_SIZE_MIB: u64 = 1024;
const MAX_SIZE_MIB: u64 = 64 * 1024;
const GROWTH_RESERVE_BYTES: u64 = 256 * 1024 * 1024;
const MARKER_BODY: &str = "KDJ managed virtual disk v1\n";
#[cfg(any(target_os = "macos", test))]
static MACOS_VOLUME_ICON_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
#[cfg(any(target_os = "windows", test))]
const WINDOWS_VOLUME_ICON: &[u8] = include_bytes!("../icons/icon.ico");
#[cfg(any(target_os = "windows", test))]
const WINDOWS_AUTORUN: &[u8] = b"[Autorun]\r\nicon=KDJ.ico,0\r\n";

#[derive(Default)]
pub struct VirtualDiskManager {
    operation: Mutex<()>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualDiskStatus {
    pub supported: bool,
    pub exists: bool,
    pub mounted: bool,
    pub name: String,
    pub image_path: String,
    pub mount_path: String,
    pub file_system: String,
    pub partition_scheme: String,
    pub image_format: String,
    pub protocol: String,
    pub total_bytes: u64,
    pub configured_bytes: u64,
    pub available_bytes: u64,
    pub writable: bool,
    pub requires_elevation: bool,
}

impl VirtualDiskStatus {
    fn base(image: &Path) -> Self {
        let configured_bytes = configured_capacity_bytes(image);
        Self {
            supported: cfg!(any(target_os = "macos", target_os = "windows")),
            exists: image.is_file(),
            name: configured_volume_name(image),
            image_path: image.to_string_lossy().into_owned(),
            total_bytes: configured_bytes,
            configured_bytes,
            requires_elevation: cfg!(target_os = "windows"),
            ..Self::default()
        }
    }
}

fn capacity_sidecar(image: &Path) -> PathBuf {
    let extension = image
        .extension()
        .map(|value| format!("{}.capacity", value.to_string_lossy()))
        .unwrap_or_else(|| "capacity".into());
    image.with_extension(extension)
}

fn name_sidecar(image: &Path) -> PathBuf {
    let extension = image
        .extension()
        .map(|value| format!("{}.name", value.to_string_lossy()))
        .unwrap_or_else(|| "name".into());
    image.with_extension(extension)
}

fn configured_capacity_bytes(image: &Path) -> u64 {
    fs::read_to_string(capacity_sidecar(image))
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .or_else(|| {
            #[cfg(target_os = "macos")]
            {
                return fs::metadata(image).ok().map(|metadata| metadata.len());
            }
            #[cfg(not(target_os = "macos"))]
            {
                None
            }
        })
        .unwrap_or_default()
}

fn configured_volume_name(image: &Path) -> String {
    fs::read_to_string(name_sidecar(image))
        .ok()
        .and_then(|value| checked_volume_name(&value).ok())
        .unwrap_or_else(|| DEFAULT_VOLUME_NAME.to_owned())
}

fn remember_capacity(image: &Path, size_mib: u64) -> Result<(), String> {
    fs::write(
        capacity_sidecar(image),
        format!("{}\n", size_mib.saturating_mul(MIB_BYTES)),
    )
    .map_err(|err| format!("无法记录 KDJ 虚拟磁盘容量：{err}"))
}

fn remember_volume_name(image: &Path, volume_name: &str) -> Result<(), String> {
    fs::write(name_sidecar(image), format!("{volume_name}\n"))
        .map_err(|err| format!("无法记录虚拟磁盘名称：{err}"))
}

fn remember_disk_metadata(image: &Path, size_mib: u64, volume_name: &str) -> Result<(), String> {
    remember_capacity(image, size_mib)?;
    remember_volume_name(image, volume_name)
}

fn virtual_disk_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let extension = if cfg!(target_os = "macos") {
        "dmg"
    } else {
        "vhd"
    };
    app.path()
        .app_data_dir()
        .map(|dir| {
            dir.join("virtual-disks")
                .join(format!("{DEFAULT_VOLUME_NAME}.{extension}"))
        })
        .map_err(|err| format!("无法确定 KDJ 虚拟磁盘保存位置：{err}"))
}

fn command_error(action: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() {
        format!("{action}失败（退出码 {:?}）", output.status.code())
    } else {
        format!("{action}失败：{detail}")
    }
}

fn run_checked(command: &mut Command, action: &str) -> Result<Output, String> {
    let output = command
        .output()
        .map_err(|err| format!("无法启动系统磁盘工具来{action}：{err}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(command_error(action, &output))
    }
}

fn write_if_changed(path: &Path, contents: &[u8], label: &str) -> Result<(), String> {
    if fs::read(path).is_ok_and(|existing| existing == contents) {
        return Ok(());
    }
    fs::write(path, contents).map_err(|err| format!("无法写入{label}：{err}"))
}

#[cfg(any(target_os = "macos", test))]
fn write_macos_volume_icon(root: &Path) -> Result<(), String> {
    let configured = MACOS_VOLUME_ICON_PATH.get().cloned();
    let source = configured.unwrap_or_else(|| {
        // Tests and an unbundled dev executable still read the tracked icon from disk. The release
        // binary never embeds these bytes; setup records Contents/Resources/icon.icns below.
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("icon.icns")
    });
    let icon = fs::read(&source)
        .map_err(|err| format!("无法读取 KDJ 应用图标 {}：{err}", source.display()))?;
    write_if_changed(&root.join(".VolumeIcon.icns"), &icon, "macOS 虚拟盘图标")
}

/// Record the already-bundled application resource instead of embedding a second ICNS copy in
/// the executable. KDJ Labs is the only flavor that includes virtual-disk support.
pub fn configure_resources<R: Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if let Ok(resource_dir) = app.path().resource_dir() {
        let _ = MACOS_VOLUME_ICON_PATH.set(resource_dir.join("icon.icns"));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(any(target_os = "windows", test))]
fn write_windows_volume_icon(root: &Path) -> Result<(), String> {
    write_if_changed(
        &root.join("KDJ.ico"),
        WINDOWS_VOLUME_ICON,
        "Windows 虚拟盘图标",
    )?;
    write_if_changed(
        &root.join("autorun.inf"),
        WINDOWS_AUTORUN,
        "Windows 虚拟盘图标配置",
    )
}

#[cfg(target_os = "macos")]
fn macos_finder_info(root: &Path) -> [u8; 32] {
    let mut finder_info = [0u8; 32];
    let Ok(output) = Command::new("/usr/bin/xattr")
        .args(["-px", "com.apple.FinderInfo"])
        .arg(root)
        .output()
    else {
        return finder_info;
    };
    if !output.status.success() {
        return finder_info;
    }
    let hex: Vec<u8> = output
        .stdout
        .into_iter()
        .filter(|byte| byte.is_ascii_hexdigit())
        .collect();
    if hex.len() != 64 {
        return finder_info;
    }
    for (index, pair) in hex.chunks_exact(2).enumerate() {
        let Ok(text) = std::str::from_utf8(pair) else {
            return [0u8; 32];
        };
        let Ok(byte) = u8::from_str_radix(text, 16) else {
            return [0u8; 32];
        };
        finder_info[index] = byte;
    }
    finder_info
}

#[cfg(target_os = "macos")]
fn activate_macos_volume_icon(root: &Path) -> Result<(), String> {
    let mut finder_info = macos_finder_info(root);
    // FileInfo.flags 的 kHasCustomIcon = 0x0400，Finder 才会读取 .VolumeIcon.icns。
    finder_info[8] |= 0x04;
    let hex = finder_info
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    run_checked(
        Command::new("/usr/bin/xattr")
            .args(["-wx", "com.apple.FinderInfo", &hex])
            .arg(root),
        "启用 macOS 虚拟盘图标",
    )?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn hide_windows_branding_file(path: &Path) -> Result<(), String> {
    run_checked(
        Command::new("attrib.exe").args(["+h", "+s"]).arg(path),
        "隐藏 Windows 虚拟盘图标文件",
    )?;
    Ok(())
}

fn ensure_volume_branding(root: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        write_macos_volume_icon(root)?;
        activate_macos_volume_icon(root)?;
    }
    #[cfg(target_os = "windows")]
    {
        write_windows_volume_icon(root)?;
        hide_windows_branding_file(&root.join("KDJ.ico"))?;
        hide_windows_branding_file(&root.join("autorun.inf"))?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = root;
    Ok(())
}

fn ensure_volume_layout(status: &VirtualDiskStatus) -> Result<(), String> {
    if !status.mounted || status.mount_path.is_empty() {
        return Err("KDJ 镜像已连接，但系统没有返回可写挂载点".into());
    }
    if !status.file_system.eq_ignore_ascii_case("exfat") {
        return Err(format!(
            "KDJ 虚拟磁盘不是 ExFAT（当前为 {}），为避免误写已停止",
            if status.file_system.is_empty() {
                "未知格式"
            } else {
                &status.file_system
            }
        ));
    }
    if !status.partition_scheme.eq_ignore_ascii_case("mbr") {
        return Err(format!(
            "KDJ 虚拟磁盘不是 MBR/FDisk 分区（当前为 {}），为避免误写已停止",
            if status.partition_scheme.is_empty() {
                "未知分区"
            } else {
                &status.partition_scheme
            }
        ));
    }
    if !status.writable {
        return Err("KDJ 虚拟磁盘当前是只读的，无法建立 OneLibrary".into());
    }

    let root = Path::new(&status.mount_path);
    fs::create_dir_all(root.join("Music")).map_err(|err| format!("无法创建 KDJ/Music：{err}"))?;
    let marker = root.join(kdj_server::usb_library::VIRTUAL_DISK_MARKER);
    if !marker.is_file() {
        fs::write(&marker, MARKER_BODY)
            .map_err(|err| format!("无法写入 KDJ 虚拟磁盘标记：{err}"))?;
    }
    ensure_volume_branding(root)?;
    Ok(())
}

fn sync_server_mount(status: &VirtualDiskStatus) {
    let mount = status
        .mounted
        .then(|| PathBuf::from(&status.mount_path))
        .filter(|path| {
            path.join(kdj_server::usb_library::VIRTUAL_DISK_MARKER)
                .is_file()
        });
    kdj_server::usb_library::set_managed_virtual_disk_mount(mount);
}

fn status_impl(image: &Path) -> Result<VirtualDiskStatus, String> {
    #[cfg(target_os = "macos")]
    {
        return macos_status(image);
    }
    #[cfg(target_os = "windows")]
    {
        return windows_status(image);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(VirtualDiskStatus::base(image))
    }
}

fn checked_size_mib(size_mib: u64) -> Result<u64, String> {
    if (MIN_SIZE_MIB..=MAX_SIZE_MIB).contains(&size_mib) {
        Ok(size_mib)
    } else {
        Err("KDJ 虚拟磁盘容量必须在 1–64GB 之间".into())
    }
}

fn checked_volume_name(volume_name: &str) -> Result<String, String> {
    let volume_name = volume_name.trim();
    if volume_name.is_empty() {
        return Err("磁盘名称不能为空".into());
    }
    if volume_name.encode_utf16().count() > 11 {
        return Err("磁盘名称不能超过 11 个字符".into());
    }
    if volume_name.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '"' | '*' | '/' | ':' | '<' | '>' | '?' | '\\' | '|'
            )
    }) {
        return Err(r#"磁盘名称不能包含 " * / : < > ? \ | 或控制字符"#.into());
    }
    Ok(volume_name.to_owned())
}

fn mount_impl(image: &Path, size_mib: u64, volume_name: &str) -> Result<VirtualDiskStatus, String> {
    let size_mib = checked_size_mib(size_mib)?;
    let volume_name = checked_volume_name(volume_name)?;
    #[cfg(target_os = "macos")]
    {
        return macos_mount(image, size_mib, &volume_name);
    }
    #[cfg(target_os = "windows")]
    {
        return windows_mount(image, size_mib, &volume_name);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (image, size_mib, volume_name);
        Err("KDJ 虚拟磁盘目前只支持 macOS 和 Windows".into())
    }
}

fn eject_impl(image: &Path) -> Result<VirtualDiskStatus, String> {
    #[cfg(target_os = "macos")]
    {
        return macos_eject(image);
    }
    #[cfg(target_os = "windows")]
    {
        return windows_eject(image);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = image;
        Err("KDJ 虚拟磁盘目前只支持 macOS 和 Windows".into())
    }
}

async fn blocking_operation<R, F>(
    app: tauri::AppHandle<R>,
    work: F,
) -> Result<VirtualDiskStatus, String>
where
    R: Runtime,
    F: FnOnce(&Path) -> Result<VirtualDiskStatus, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<VirtualDiskManager>();
        let _guard = manager
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let image = virtual_disk_path(&app)?;
        let status = work(&image)?;
        sync_server_mount(&status);
        Ok(status)
    })
    .await
    .map_err(|err| format!("KDJ 虚拟磁盘任务异常结束：{err}"))?
}

#[tauri::command]
pub async fn virtual_disk_status(app: tauri::AppHandle) -> Result<VirtualDiskStatus, String> {
    blocking_operation(app, status_impl).await
}

#[tauri::command]
pub async fn virtual_disk_mount(
    app: tauri::AppHandle,
    size_mib: Option<u64>,
    volume_name: Option<String>,
) -> Result<VirtualDiskStatus, String> {
    let size_mib = size_mib.unwrap_or(DEFAULT_SIZE_MIB);
    let volume_name = volume_name.unwrap_or_else(|| DEFAULT_VOLUME_NAME.to_owned());
    blocking_operation(app, move |image| mount_impl(image, size_mib, &volume_name)).await
}

#[tauri::command]
pub async fn virtual_disk_eject(app: tauri::AppHandle) -> Result<VirtualDiskStatus, String> {
    blocking_operation(app, eject_impl).await
}

#[tauri::command]
pub async fn virtual_disk_ensure_capacity(
    app: tauri::AppHandle,
    required_bytes: u64,
) -> Result<VirtualDiskStatus, String> {
    blocking_operation(app, move |image| grow_impl(image, required_bytes)).await
}

#[tauri::command]
pub async fn virtual_disk_grow(
    app: tauri::AppHandle,
    size_mib: u64,
    volume_name: String,
) -> Result<VirtualDiskStatus, String> {
    blocking_operation(app, move |image| {
        grow_to_impl(image, size_mib, &volume_name)
    })
    .await
}

#[tauri::command]
pub async fn virtual_disk_delete(app: tauri::AppHandle) -> Result<VirtualDiskStatus, String> {
    blocking_operation(app, delete_impl).await
}

/// 启动时接回一张已经由 Finder/资源管理器加载的 KDJ 镜像。
pub fn sync_existing<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Ok(image) = virtual_disk_path(app) else {
        return;
    };
    match status_impl(&image) {
        Ok(status) => sync_server_mount(&status),
        Err(err) => tracing::warn!("检查已有 KDJ 虚拟磁盘失败：{err}"),
    }
}

/// 真正退出进程时尽力安全推出。失败（通常是文件仍被占用）时宁可保留挂载，
/// 也不使用强制推出破坏刚写完的 OneLibrary。
pub fn eject_on_exit<R: Runtime>(app: &tauri::AppHandle<R>) {
    let manager = app.state::<VirtualDiskManager>();
    let _guard = manager
        .operation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Ok(image) = virtual_disk_path(app) else {
        return;
    };
    match eject_impl(&image) {
        Ok(status) => sync_server_mount(&status),
        Err(err) => tracing::warn!("退出时未能安全推出 KDJ 虚拟磁盘：{err}"),
    }
}

fn remove_image_artifacts(image: &Path) {
    let _ = fs::remove_file(image);
    let _ = fs::remove_file(capacity_sidecar(image));
    let _ = fs::remove_file(name_sidecar(image));
}

fn restore_sidecars(sidecars: &[(PathBuf, Option<Vec<u8>>)]) {
    for (path, contents) in sidecars {
        if let Some(contents) = contents {
            let _ = fs::write(path, contents);
        } else {
            let _ = fs::remove_file(path);
        }
    }
}

fn remove_managed_image_files(image: &Path) -> Result<(), String> {
    if !image.is_file() {
        return Err("KDJ 虚拟磁盘尚未创建".into());
    }
    let sidecars = [capacity_sidecar(image), name_sidecar(image)].map(|path| {
        let contents = fs::read(&path).ok();
        (path, contents)
    });
    let extension = image.extension().unwrap_or_default().to_string_lossy();
    let parent = image
        .parent()
        .ok_or_else(|| "KDJ 镜像路径缺少父目录".to_string())?;
    let tombstone = parent.join(format!(".KDJ-delete-{}.{}", std::process::id(), extension));
    remove_image_artifacts(&tombstone);
    fs::rename(image, &tombstone).map_err(|err| format!("无法隔离待删除的 KDJ 镜像：{err}"))?;

    for (sidecar, _) in &sidecars {
        if sidecar.is_file() {
            if let Err(err) = fs::remove_file(sidecar) {
                restore_sidecars(&sidecars);
                let rollback = fs::rename(&tombstone, image);
                return Err(match rollback {
                    Ok(()) => format!("无法删除 KDJ 磁盘记录，镜像已恢复：{err}"),
                    Err(rollback) => {
                        format!("无法删除 KDJ 磁盘记录（{err}），且镜像恢复失败：{rollback}")
                    }
                });
            }
        }
    }

    if let Err(err) = fs::remove_file(&tombstone) {
        let rollback = fs::rename(&tombstone, image);
        if rollback.is_ok() {
            restore_sidecars(&sidecars);
            return Err(format!("无法彻底删除 KDJ 镜像，原镜像已恢复：{err}"));
        }
        return Err(format!(
            "无法彻底删除 KDJ 镜像（{err}），且待删除镜像无法恢复到原路径"
        ));
    }
    Ok(())
}

fn delete_impl(image: &Path) -> Result<VirtualDiskStatus, String> {
    if !status_impl(image)?.exists {
        return Err("KDJ 虚拟磁盘尚未创建".into());
    }
    // 即使状态里没有挂载点，也让平台实现清理半连接设备；推出失败绝不继续删文件。
    eject_impl(image)?;
    let detached = status_impl(image)?;
    if detached.mounted {
        return Err("KDJ 虚拟磁盘仍处于加载状态，已停止删除".into());
    }
    remove_managed_image_files(image)?;
    status_impl(image)
}

fn copy_volume_tree(source: &Path, destination: &Path) -> Result<(u64, u64), String> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    for entry in fs::read_dir(source).map_err(|err| format!("无法读取旧 KDJ 卷：{err}"))? {
        let entry = entry.map_err(|err| format!("无法读取旧 KDJ 卷目录项：{err}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|err| format!("无法读取 KDJ 文件类型：{err}"))?;
        if file_type.is_dir() {
            fs::create_dir_all(&destination_path)
                .map_err(|err| format!("无法创建新镜像目录：{err}"))?;
            let (child_files, child_bytes) = copy_volume_tree(&source_path, &destination_path)?;
            files += child_files;
            bytes += child_bytes;
        } else if file_type.is_file() {
            bytes += fs::copy(&source_path, &destination_path).map_err(|err| {
                format!(
                    "迁移 KDJ 数据失败：{} → {}：{err}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
            files += 1;
        }
    }
    Ok((files, bytes))
}

fn configured_size_mib(status: &VirtualDiskStatus) -> u64 {
    let bytes = status.configured_bytes.max(status.total_bytes);
    ((bytes + MIB_BYTES - 1) / MIB_BYTES).clamp(MIN_SIZE_MIB, MAX_SIZE_MIB)
}

fn display_size_gib(size_mib: u64) -> String {
    let value = size_mib as f64 / 1024.0;
    if size_mib % 1024 == 0 {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}

fn target_growth_mib(status: &VirtualDiskStatus, required_bytes: u64) -> Result<u64, String> {
    if required_bytes <= status.available_bytes {
        return Ok(0);
    }
    let used = status.total_bytes.saturating_sub(status.available_bytes);
    let needed = used
        .saturating_add(required_bytes)
        .saturating_add(GROWTH_RESERVE_BYTES);
    let mut size_mib = configured_size_mib(status);
    while size_mib.saturating_mul(MIB_BYTES) < needed && size_mib < MAX_SIZE_MIB {
        size_mib = size_mib.saturating_mul(2).min(MAX_SIZE_MIB);
    }
    if size_mib.saturating_mul(MIB_BYTES) < needed {
        return Err("这次导出需要的容量超过 KDJ 虚拟磁盘上限 64GB；请改用真实 U 盘".into());
    }
    Ok(size_mib)
}

fn validate_manual_change(
    current: &VirtualDiskStatus,
    target_mib: u64,
    volume_name: &str,
) -> Result<(), String> {
    let current_mib = configured_size_mib(current);
    if target_mib == current_mib && volume_name == current.name {
        return Err("容量和磁盘名称都没有变化".into());
    }
    let used_bytes = current.total_bytes.saturating_sub(current.available_bytes);
    let minimum_bytes = used_bytes.saturating_add(GROWTH_RESERVE_BYTES);
    if target_mib.saturating_mul(MIB_BYTES) < minimum_bytes {
        let minimum_mib = (minimum_bytes + MIB_BYTES - 1) / MIB_BYTES;
        return Err(format!(
            "当前数据至少需要 {}GB 的新容量",
            display_size_gib(minimum_mib)
        ));
    }
    Ok(())
}

fn grow_to_impl(
    image: &Path,
    target_mib: u64,
    volume_name: &str,
) -> Result<VirtualDiskStatus, String> {
    let target_mib = checked_size_mib(target_mib)?;
    let volume_name = checked_volume_name(volume_name)?;
    let current = status_impl(image)?;
    if !current.exists {
        return Err("KDJ 虚拟磁盘尚未创建".into());
    }
    if !current.mounted {
        return Err("请先加载 KDJ 虚拟磁盘再改变容量".into());
    }
    ensure_volume_layout(&current)?;
    validate_manual_change(&current, target_mib, &volume_name)?;
    replace_disk(image, current, target_mib, &volume_name)
}

/// ExFAT 无法通过 macOS 自带工具在 UDRW 里安全地原地改变容量。跨平台统一走“新建镜像
/// → 完整复制 → 验证 → 原子换名 → 重新挂载”；任何换名前的失败都不碰原镜像。
fn grow_impl(image: &Path, required_bytes: u64) -> Result<VirtualDiskStatus, String> {
    let current = status_impl(image)?;
    if !current.exists {
        return Err("KDJ 虚拟磁盘尚未创建".into());
    }
    if !current.mounted {
        return Err("请先加载 KDJ 虚拟磁盘再改变容量".into());
    }
    ensure_volume_layout(&current)?;
    let target_mib = target_growth_mib(&current, required_bytes)?;
    if target_mib == 0 {
        return Ok(current);
    }
    let volume_name = current.name.clone();
    replace_disk(image, current, target_mib, &volume_name)
}

fn replace_disk(
    image: &Path,
    current: VirtualDiskStatus,
    target_mib: u64,
    volume_name: &str,
) -> Result<VirtualDiskStatus, String> {
    let extension = image.extension().unwrap_or_default().to_string_lossy();
    let parent = image
        .parent()
        .ok_or_else(|| "KDJ 镜像路径缺少父目录".to_string())?;
    let temp_image = parent.join(format!(".KDJ-grow-{}.{}", std::process::id(), extension));
    let backup_image = parent.join(format!(
        ".KDJ-before-grow-{}.{}",
        std::process::id(),
        extension
    ));
    remove_image_artifacts(&temp_image);
    remove_image_artifacts(&backup_image);

    let temp_status = match mount_impl(&temp_image, target_mib, volume_name) {
        Ok(status) => status,
        Err(err) => {
            remove_image_artifacts(&temp_image);
            return Err(format!("无法创建新镜像，原磁盘未改动：{err}"));
        }
    };
    let copied = copy_volume_tree(
        Path::new(&current.mount_path),
        Path::new(&temp_status.mount_path),
    );
    if let Err(err) = copied {
        let _ = eject_impl(&temp_image);
        remove_image_artifacts(&temp_image);
        return Err(format!("{err}；原 KDJ 未改动"));
    }
    if let Err(err) = ensure_volume_layout(&temp_status) {
        let _ = eject_impl(&temp_image);
        remove_image_artifacts(&temp_image);
        return Err(format!("新镜像验证失败，原磁盘未改动：{err}"));
    }

    if let Err(err) = eject_impl(&temp_image) {
        return Err(format!("新镜像无法安全卸载，原磁盘未改动：{err}"));
    }
    if let Err(err) = eject_impl(image) {
        remove_image_artifacts(&temp_image);
        return Err(format!("原磁盘正被占用，无法改变容量：{err}"));
    }

    let current_mib = configured_size_mib(&current);
    let current_name = current.name.clone();
    if let Err(err) = fs::rename(image, &backup_image) {
        let _ = mount_impl(image, current_mib, &current_name);
        remove_image_artifacts(&temp_image);
        return Err(format!("无法为原 KDJ 建立回滚副本：{err}"));
    }
    if let Err(err) = fs::rename(&temp_image, image) {
        let _ = fs::rename(&backup_image, image);
        let _ = remember_disk_metadata(image, current_mib, &current_name);
        let _ = mount_impl(image, current_mib, &current_name);
        remove_image_artifacts(&temp_image);
        return Err(format!("无法启用新镜像，已恢复原磁盘：{err}"));
    }

    let switched = remember_disk_metadata(image, target_mib, volume_name)
        .and_then(|()| mount_impl(image, target_mib, volume_name));
    match switched {
        Ok(status) => {
            remove_image_artifacts(&backup_image);
            remove_image_artifacts(&temp_image);
            Ok(status)
        }
        Err(err) => {
            let _ = eject_impl(image);
            remove_image_artifacts(image);
            let rollback = fs::rename(&backup_image, image)
                .map_err(|rollback| format!("改变容量失败（{err}），回滚镜像也失败：{rollback}"));
            if let Err(rollback) = rollback {
                return Err(rollback);
            }
            let _ = remember_disk_metadata(image, current_mib, &current_name);
            mount_impl(image, current_mib, &current_name).map_err(|rollback| {
                format!("改变容量失败（{err}），原镜像已恢复但重新加载失败：{rollback}")
            })?;
            Err(format!("新镜像无法加载，已恢复原磁盘：{err}"))
        }
    }
}

// ---------------------------------------------------------------- macOS

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Default)]
struct MacAttachment {
    whole_device: String,
    mount_path: String,
    mbr: bool,
}

#[cfg(target_os = "macos")]
fn same_image_path(reported: &str, expected: &Path) -> bool {
    let reported = Path::new(reported);
    match (reported.canonicalize(), expected.canonicalize()) {
        (Ok(reported), Ok(expected)) => reported == expected,
        _ => reported == expected,
    }
}

#[cfg(target_os = "macos")]
fn macos_attachment(image: &Path) -> Result<Option<MacAttachment>, String> {
    let output = run_checked(
        Command::new("/usr/bin/hdiutil").args(["info", "-plist"]),
        "读取磁盘镜像状态",
    )?;
    let value = plist::Value::from_reader(std::io::Cursor::new(output.stdout))
        .map_err(|err| format!("无法解析 hdiutil 状态：{err}"))?;
    let images = value
        .as_dictionary()
        .and_then(|dict| dict.get("images"))
        .and_then(plist::Value::as_array)
        .cloned()
        .unwrap_or_default();

    for entry in images {
        let Some(dict) = entry.as_dictionary() else {
            continue;
        };
        let Some(reported) = dict.get("image-path").and_then(plist::Value::as_string) else {
            continue;
        };
        if !same_image_path(reported, image) {
            continue;
        }
        let mut attachment = MacAttachment::default();
        if let Some(entities) = dict.get("system-entities").and_then(plist::Value::as_array) {
            for entity in entities {
                let Some(entity) = entity.as_dictionary() else {
                    continue;
                };
                let hint = entity
                    .get("content-hint")
                    .and_then(plist::Value::as_string)
                    .unwrap_or_default();
                let device = entity
                    .get("dev-entry")
                    .and_then(plist::Value::as_string)
                    .unwrap_or_default();
                if hint == "FDisk_partition_scheme" {
                    attachment.mbr = true;
                    attachment.whole_device = device.to_owned();
                }
                if let Some(mount) = entity.get("mount-point").and_then(plist::Value::as_string) {
                    attachment.mount_path = mount.to_owned();
                }
            }
        }
        return Ok(Some(attachment));
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
fn plist_string(dict: &plist::Dictionary, key: &str) -> String {
    dict.get(key)
        .and_then(plist::Value::as_string)
        .unwrap_or_default()
        .to_owned()
}

#[cfg(target_os = "macos")]
fn plist_u64(dict: &plist::Dictionary, key: &str) -> u64 {
    dict.get(key)
        .and_then(|value| {
            value.as_unsigned_integer().or_else(|| {
                value
                    .as_signed_integer()
                    .and_then(|n| u64::try_from(n).ok())
            })
        })
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn macos_status(image: &Path) -> Result<VirtualDiskStatus, String> {
    let mut status = VirtualDiskStatus::base(image);
    status.image_format = "UDRW".into();
    status.partition_scheme = "MBR".into();
    status.protocol = "Disk Image".into();
    let Some(attachment) = macos_attachment(image)? else {
        return Ok(status);
    };
    if attachment.mount_path.is_empty() {
        return Ok(status);
    }

    let output = run_checked(
        Command::new("/usr/sbin/diskutil").args(["info", "-plist", attachment.mount_path.as_str()]),
        "检查 KDJ 挂载卷",
    )?;
    let value = plist::Value::from_reader(std::io::Cursor::new(output.stdout))
        .map_err(|err| format!("无法解析 diskutil info：{err}"))?;
    let dict = value
        .as_dictionary()
        .ok_or_else(|| "diskutil info 没有返回卷信息".to_string())?;
    let volume_name = plist_string(dict, "VolumeName");
    let protocol = plist_string(dict, "BusProtocol");
    if volume_name != status.name || protocol != "Disk Image" {
        return Err(format!(
            "镜像挂载结果不符合 KDJ 约定（卷名 {volume_name:?}，应为 {:?}；协议 {protocol:?}）",
            status.name
        ));
    }

    status.mounted = true;
    status.name = volume_name;
    status.mount_path = plist_string(dict, "MountPoint");
    status.file_system = plist_string(dict, "FilesystemUserVisibleName");
    if status.file_system.is_empty() {
        status.file_system = plist_string(dict, "FilesystemType");
    }
    status.partition_scheme = if attachment.mbr { "MBR" } else { "未知" }.into();
    status.protocol = protocol;
    status.total_bytes = plist_u64(dict, "VolumeSize").max(plist_u64(dict, "TotalSize"));
    status.available_bytes = plist_u64(dict, "FreeSpace");
    status.writable = dict
        .get("WritableVolume")
        .and_then(plist::Value::as_boolean)
        .or_else(|| dict.get("Writable").and_then(plist::Value::as_boolean))
        .unwrap_or(false);
    Ok(status)
}

#[cfg(target_os = "macos")]
fn macos_detach_attachment(attachment: &MacAttachment) -> Result<(), String> {
    if attachment.whole_device.is_empty() {
        return Err("hdiutil 没有返回 KDJ 镜像的整盘设备节点".into());
    }
    run_checked(
        Command::new("/usr/bin/hdiutil")
            .arg("detach")
            .arg(&attachment.whole_device),
        "安全推出 KDJ",
    )?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_mount(
    image: &Path,
    size_mib: u64,
    volume_name: &str,
) -> Result<VirtualDiskStatus, String> {
    if let Some(attachment) = macos_attachment(image)? {
        if !attachment.mount_path.is_empty() {
            let status = macos_status(image)?;
            ensure_volume_layout(&status)?;
            return Ok(status);
        }
        // 之前若被以 -nomount 连接，直接 attach 会报 already attached；先清掉半连接状态。
        macos_detach_attachment(&attachment)?;
    }

    if !image.is_file() {
        let parent = image
            .parent()
            .ok_or_else(|| "KDJ 镜像路径缺少父目录".to_string())?;
        fs::create_dir_all(parent).map_err(|err| format!("无法创建虚拟磁盘目录：{err}"))?;
        run_checked(
            Command::new("/usr/bin/hdiutil")
                .arg("create")
                .arg("-size")
                .arg(format!("{size_mib}m"))
                .args([
                    "-fs",
                    "ExFAT",
                    "-layout",
                    "MBRSPUD",
                    "-volname",
                    volume_name,
                    "-type",
                    "UDIF",
                ])
                .arg(image),
            "创建 KDJ 虚拟磁盘",
        )?;
        remember_disk_metadata(image, size_mib, volume_name)?;
    }

    // 故意不传 -nobrowse：Finder 与 djay/OneLibrary 都必须能发现这个卷。
    run_checked(
        Command::new("/usr/bin/hdiutil").arg("attach").arg(image),
        "加载 KDJ 虚拟磁盘",
    )?;
    for _ in 0..40 {
        let status = macos_status(image)?;
        if status.mounted {
            ensure_volume_layout(&status)?;
            return Ok(status);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err("KDJ 镜像已连接，但 4 秒内没有出现挂载卷".into())
}

#[cfg(target_os = "macos")]
fn macos_eject(image: &Path) -> Result<VirtualDiskStatus, String> {
    if let Some(attachment) = macos_attachment(image)? {
        macos_detach_attachment(&attachment)?;
    }
    let mut status = VirtualDiskStatus::base(image);
    status.image_format = "UDRW".into();
    status.partition_scheme = "MBR".into();
    status.protocol = "Disk Image".into();
    Ok(status)
}

// ---------------------------------------------------------------- Windows

#[cfg(any(target_os = "windows", test))]
fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "windows")]
fn powershell_encoded(script: &str) -> String {
    use base64::Engine as _;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str, action: &str) -> Result<Output, String> {
    run_checked(
        Command::new("powershell.exe").args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &powershell_encoded(script),
        ]),
        action,
    )
}

#[cfg(target_os = "windows")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WindowsVolumeInfo {
    mount_path: String,
    file_system: String,
    volume_name: String,
    partition_scheme: String,
    total_bytes: u64,
    available_bytes: u64,
    writable: bool,
}

#[cfg(target_os = "windows")]
fn windows_status(image: &Path) -> Result<VirtualDiskStatus, String> {
    let mut status = VirtualDiskStatus::base(image);
    status.image_format = "VHD".into();
    status.partition_scheme = "MBR".into();
    status.protocol = "Virtual Hard Disk".into();
    if status.total_bytes == 0 {
        status.total_bytes = IMAGE_SIZE_BYTES;
        status.configured_bytes = IMAGE_SIZE_BYTES;
    }
    if !image.is_file() {
        return Ok(status);
    }

    let image_literal = powershell_literal(&image.to_string_lossy());
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {{ $image = Get-DiskImage -ImagePath {image_literal} }} catch {{ exit 0 }}
if (-not $image.Attached) {{ exit 0 }}
$disk = $image | Get-Disk
$volume = $disk | Get-Partition | Get-Volume | Where-Object {{ $_.DriveLetter }} | Select-Object -First 1
if ($null -eq $volume) {{ exit 0 }}
[pscustomobject]@{{
  MountPath = ([string]$volume.DriveLetter + ':\')
  FileSystem = [string]$volume.FileSystem
  VolumeName = [string]$volume.FileSystemLabel
  PartitionScheme = [string]$disk.PartitionStyle
  TotalBytes = [uint64]$volume.Size
  AvailableBytes = [uint64]$volume.SizeRemaining
  Writable = -not [bool]$disk.IsReadOnly
}} | ConvertTo-Json -Compress
"#
    );
    let output = run_powershell(&script, "读取 Windows KDJ 虚拟磁盘状态")?;
    let json = String::from_utf8_lossy(&output.stdout)
        .trim_start_matches('\u{feff}')
        .trim()
        .to_owned();
    if json.is_empty() {
        return Ok(status);
    }
    let info: WindowsVolumeInfo = serde_json::from_str(&json)
        .map_err(|err| format!("无法解析 Windows 虚拟磁盘状态：{err}；原始输出：{json}"))?;
    if info.volume_name != status.name {
        return Err(format!(
            "VHD 已连接，但卷名是 {:?} 而不是 {:?}，为避免误写已停止",
            info.volume_name, status.name
        ));
    }
    status.mounted = true;
    status.name = info.volume_name;
    status.mount_path = info.mount_path;
    status.file_system = info.file_system;
    status.partition_scheme = info.partition_scheme;
    status.total_bytes = info.total_bytes;
    status.available_bytes = info.available_bytes;
    status.writable = info.writable;
    Ok(status)
}

#[cfg(target_os = "windows")]
fn write_diskpart_script(path: &Path, body: &str) -> Result<(), String> {
    let mut bytes = vec![0xff, 0xfe];
    bytes.extend(body.encode_utf16().flat_map(u16::to_le_bytes));
    fs::write(path, bytes).map_err(|err| format!("无法写入 DiskPart 临时脚本：{err}"))
}

#[cfg(target_os = "windows")]
fn run_elevated_diskpart(image: &Path, body: &str, action: &str) -> Result<(), String> {
    let parent = image
        .parent()
        .ok_or_else(|| "KDJ VHD 路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("无法创建虚拟磁盘目录：{err}"))?;
    let script_path = parent.join(format!(".kdj-diskpart-{}.txt", std::process::id()));
    write_diskpart_script(&script_path, body)?;

    let script_literal = powershell_literal(&script_path.to_string_lossy());
    let elevated = format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $diskpart = Join-Path $env:SystemRoot 'System32\diskpart.exe'
  $arguments = '/s "' + {script_literal} + '"'
  $process = Start-Process -FilePath $diskpart -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $process.ExitCode
}} catch {{
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1223
}}
"#
    );
    let result = run_powershell(&elevated, action).map(|_| ());
    let _ = fs::remove_file(&script_path);
    result.map_err(|err| {
        if err.contains("1223") || err.to_ascii_lowercase().contains("cancel") {
            format!("{action}需要管理员权限；用户取消了 Windows UAC 授权")
        } else {
            err
        }
    })
}

#[cfg(any(target_os = "windows", test))]
fn diskpart_create_script(image: &Path, size_mib: u64, volume_name: &str) -> String {
    format!(
        "create vdisk file=\"{}\" maximum={} type=expandable\r\n\
         select vdisk file=\"{}\"\r\n\
         attach vdisk\r\n\
         convert mbr\r\n\
         create partition primary\r\n\
         format fs=exfat label=\"{}\" quick\r\n\
         assign\r\n\
         exit\r\n",
        image.display(),
        size_mib,
        image.display(),
        volume_name
    )
}

#[cfg(any(target_os = "windows", test))]
fn diskpart_attach_script(image: &Path) -> String {
    format!(
        "select vdisk file=\"{}\"\r\nattach vdisk\r\nexit\r\n",
        image.display()
    )
}

#[cfg(any(target_os = "windows", test))]
fn diskpart_detach_script(image: &Path) -> String {
    format!(
        "select vdisk file=\"{}\"\r\ndetach vdisk\r\nexit\r\n",
        image.display()
    )
}

#[cfg(target_os = "windows")]
fn windows_mount(
    image: &Path,
    size_mib: u64,
    volume_name: &str,
) -> Result<VirtualDiskStatus, String> {
    let current = windows_status(image)?;
    if current.mounted {
        ensure_volume_layout(&current)?;
        return Ok(current);
    }
    let create = !image.is_file();
    let script = if create {
        diskpart_create_script(image, size_mib, volume_name)
    } else {
        diskpart_attach_script(image)
    };
    run_elevated_diskpart(
        image,
        &script,
        if create {
            "创建并加载 KDJ 虚拟磁盘"
        } else {
            "加载 KDJ 虚拟磁盘"
        },
    )?;
    if create {
        remember_disk_metadata(image, size_mib, volume_name)?;
    }

    for _ in 0..80 {
        let status = windows_status(image)?;
        if status.mounted {
            ensure_volume_layout(&status)?;
            return Ok(status);
        }
        std::thread::sleep(std::time::Duration::from_millis(125));
    }
    Err("Windows 已执行 DiskPart，但 10 秒内没有出现 KDJ 盘符".into())
}

#[cfg(target_os = "windows")]
fn windows_eject(image: &Path) -> Result<VirtualDiskStatus, String> {
    let current = windows_status(image)?;
    if current.mounted {
        run_elevated_diskpart(
            image,
            &diskpart_detach_script(image),
            "安全推出 KDJ 虚拟磁盘",
        )?;
    }
    windows_status(image)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_literals_escape_apostrophes_without_shell_interpolation() {
        assert_eq!(
            powershell_literal("C:\\Users\\O'Brien\\KDJ.vhd"),
            "'C:\\Users\\O''Brien\\KDJ.vhd'"
        );
    }

    #[test]
    fn diskpart_create_contract_is_selected_size_exfat_mbr() {
        let script = diskpart_create_script(Path::new("C:\\KDJ\\KDJ.vhd"), 8704, "DJ SET");
        assert!(script.contains("maximum=8704"));
        assert!(script.contains("convert mbr"));
        assert!(script.contains("format fs=exfat label=\"DJ SET\" quick"));
        assert!(!script.to_ascii_lowercase().contains("ntfs"));
    }

    #[test]
    fn growth_doubles_capacity_and_stops_at_sixty_four_gib() {
        let status = VirtualDiskStatus {
            mounted: true,
            total_bytes: 8 * IMAGE_SIZE_BYTES,
            available_bytes: 128 * 1024 * 1024,
            ..VirtualDiskStatus::default()
        };
        assert_eq!(
            target_growth_mib(&status, 512 * 1024 * 1024).unwrap(),
            16 * 1024
        );
        assert_eq!(target_growth_mib(&status, 64 * 1024 * 1024).unwrap(), 0);

        let full = VirtualDiskStatus {
            total_bytes: 64 * IMAGE_SIZE_BYTES,
            available_bytes: 0,
            ..VirtualDiskStatus::default()
        };
        assert!(target_growth_mib(&full, IMAGE_SIZE_BYTES).is_err());
    }

    #[test]
    fn manual_capacity_accepts_mib_precision_and_enforces_limits() {
        assert_eq!(checked_size_mib(8 * 1024 + 512).unwrap(), 8704);
        assert!(checked_size_mib(MIN_SIZE_MIB - 1).is_err());
        assert!(checked_size_mib(MAX_SIZE_MIB + 1).is_err());
        assert_eq!(display_size_gib(8704), "8.5");
    }

    #[test]
    fn manual_change_allows_safe_shrink_and_name_only_migration() {
        let status = VirtualDiskStatus {
            name: "KDJ".into(),
            total_bytes: 8 * IMAGE_SIZE_BYTES,
            configured_bytes: 8 * IMAGE_SIZE_BYTES,
            available_bytes: 6 * IMAGE_SIZE_BYTES,
            ..VirtualDiskStatus::default()
        };
        assert!(validate_manual_change(&status, 4 * 1024, "KDJ").is_ok());
        assert!(validate_manual_change(&status, 2 * 1024, "KDJ").is_err());
        assert!(validate_manual_change(&status, 8 * 1024, "DJ SET").is_ok());
        assert!(validate_manual_change(&status, 8 * 1024, "KDJ").is_err());
    }

    #[test]
    fn volume_name_contract_matches_exfat_and_diskpart_limits() {
        assert_eq!(checked_volume_name("  DJ SET  ").unwrap(), "DJ SET");
        assert_eq!(checked_volume_name("中文盘").unwrap(), "中文盘");
        assert!(checked_volume_name("").is_err());
        assert!(checked_volume_name("123456789012").is_err());
        assert!(checked_volume_name("DJ/SET").is_err());
    }

    #[test]
    fn volume_branding_uses_the_bundled_application_icons() {
        let root = std::env::temp_dir().join(format!("kdj-volume-branding-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        write_macos_volume_icon(&root).unwrap();
        write_windows_volume_icon(&root).unwrap();

        assert_eq!(
            fs::read(root.join(".VolumeIcon.icns")).unwrap(),
            fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/icon.icns")).unwrap()
        );
        assert_eq!(fs::read(root.join("KDJ.ico")).unwrap(), WINDOWS_VOLUME_ICON);
        assert_eq!(fs::read(root.join("autorun.inf")).unwrap(), WINDOWS_AUTORUN);
        assert!(!String::from_utf8_lossy(WINDOWS_AUTORUN).contains("open="));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn managed_delete_removes_only_the_image_and_capacity_record() {
        let root = std::env::temp_dir().join(format!("kdj-managed-delete-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let image = root.join("KDJ.dmg");
        let sibling = root.join("keep.txt");
        fs::write(&image, b"disk-image").unwrap();
        fs::write(capacity_sidecar(&image), b"8589934592\n").unwrap();
        fs::write(name_sidecar(&image), b"DJ SET\n").unwrap();
        fs::write(&sibling, b"keep").unwrap();

        remove_managed_image_files(&image).unwrap();

        assert!(!image.exists());
        assert!(!capacity_sidecar(&image).exists());
        assert!(!name_sidecar(&image).exists());
        assert_eq!(fs::read(&sibling).unwrap(), b"keep");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mount_validation_requires_the_onelibrary_disk_contract() {
        let root = std::env::temp_dir().join(format!("kdj-volume-layout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let status = VirtualDiskStatus {
            mounted: true,
            mount_path: root.to_string_lossy().into_owned(),
            file_system: "ExFAT".into(),
            partition_scheme: "MBR".into(),
            writable: true,
            ..VirtualDiskStatus::default()
        };
        ensure_volume_layout(&status).unwrap();
        assert!(root.join("Music").is_dir());
        assert!(root
            .join(kdj_server::usb_library::VIRTUAL_DISK_MARKER)
            .is_file());
        let _ = fs::remove_dir_all(root);
    }
}
