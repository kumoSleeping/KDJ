use super::*;

pub(super) struct DownloadSpec {
    pub url: String,
    pub publisher: &'static str,
    pub source_page: &'static str,
    pub component: &'static str,
    pub resolve_redirect: bool,
}

pub(super) fn download_specs(platform: &str, arch: &str) -> Result<Vec<DownloadSpec>> {
    match (platform, arch) {
        ("windows", "x86_64") => Ok(vec![DownloadSpec {
            url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip".into(),
            publisher: "Gyan Doshi",
            source_page: "https://www.gyan.dev/ffmpeg/builds/",
            component: "FFmpeg / ffprobe",
            resolve_redirect: true,
        }]),
        ("macos", "x86_64" | "aarch64") => {
            let arch = if arch == "aarch64" { "arm64" } else { "amd64" };
            Ok(["ffmpeg", "ffprobe"].map(|name| DownloadSpec {
                url: format!("https://ffmpeg.martin-riedl.de/redirect/latest/macos/{arch}/release/{name}.zip"),
                publisher: "Martin Riedl", source_page: "https://ffmpeg.martin-riedl.de/", component: name, resolve_redirect: true,
            }).into())
        }
        _ => bail!("此设备请导入适合系统架构的 FFmpeg ZIP 或文件夹"),
    }
}

pub(super) fn unpack_archives(paths: &[PathBuf], target: &Path) -> Result<()> {
    ensure!(
        !paths.is_empty() && paths.len() <= 2,
        "请选择一套工具包，最多两个 ZIP"
    );
    if paths.len() == 1 {
        extract_zip(&paths[0], target)?;
        return Ok(());
    }
    // Separate package roots avoid overwriting identically named licenses/README.
    let bin = target.join("bin");
    fs::create_dir_all(&bin)?;
    for (index, path) in paths.iter().enumerate() {
        extract_zip(path, &target.join(format!("archive-{index}")))?;
    }
    for name in [FFMPEG_NAME, FFPROBE_NAME] {
        let mut found = Vec::new();
        find_tool(target, name, 0, &mut found)?;
        ensure!(
            found.len() == 1,
            "ZIP 中缺少或包含多份 {name}，请同时选择一套 FFmpeg 和 ffprobe"
        );
        fs::rename(&found[0], bin.join(name))?;
    }
    Ok(())
}

fn find_tool(root: &Path, name: &str, depth: usize, found: &mut Vec<PathBuf>) -> Result<()> {
    if depth > 4 {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            find_tool(&entry.path(), name, depth + 1, found)?;
        } else if kind.is_file() && entry.file_name() == name {
            found.push(entry.path());
        }
    }
    Ok(())
}

pub(super) fn import_folder(source: &Path, target: &Path) -> Result<()> {
    let bin = find_bin(source)?;
    // System package-manager directories are not portable tool packages. They are
    // discovered automatically and must never be recursively copied into KDJ.
    for name in [FFMPEG_NAME, FFPROBE_NAME] {
        ensure!(
            !fs::symlink_metadata(bin.join(name))?
                .file_type()
                .is_symlink(),
            "请选择独立的工具包；Homebrew 等系统安装会由 KDJ 自动识别"
        );
    }
    if bin
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
    {
        return copy_package(
            bin.parent().context("无效的工具目录")?,
            target,
            0,
            &mut 0,
            &mut 0,
        );
    }
    // A user may have extracted the two binaries directly into Downloads. Import
    // only the tools, companion libraries, and license/docs, never unrelated files.
    let mut bytes = 0;
    let mut count = 0;
    for entry in fs::read_dir(&bin)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let docs = [
            "license",
            "copying",
            "copyright",
            "notice",
            "readme",
            "doc",
            "licenses",
        ]
        .iter()
        .any(|prefix| {
            name == *prefix
                || name.starts_with(&format!("{prefix}."))
                || name.starts_with(&format!("{prefix}-"))
        });
        let relevant = name == FFMPEG_NAME
            || name == FFPROBE_NAME
            || name.ends_with(".dll")
            || name.ends_with(".dylib")
            || docs;
        if !relevant {
            continue;
        }
        let kind = entry.file_type()?;
        ensure!(!kind.is_symlink(), "工具文件夹不支持符号链接");
        if kind.is_dir() {
            copy_package(
                &entry.path(),
                &target.join(entry.file_name()),
                1,
                &mut count,
                &mut bytes,
            )?;
        } else if kind.is_file() {
            let size = entry.metadata()?.len();
            ensure!(size <= MAX_UNPACKED - bytes, "工具文件夹超过大小限制");
            bytes += size;
            let mut input = File::open(entry.path())?;
            let mut output = File::options()
                .write(true)
                .create_new(true)
                .open(target.join(entry.file_name()))?;
            let copied = std::io::copy(&mut (&mut input).take(size + 1), &mut output)?;
            ensure!(copied == size, "复制时源文件发生变化，请重试");
        }
    }
    Ok(())
}

pub(super) async fn prepare_binary(path: &Path, automatic: bool) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut header = [0u8; 1032];
        let len = File::open(path)?.read(&mut header)?;
        let cpu = if cfg!(target_arch = "aarch64") {
            0x0100000c
        } else {
            0x01000007
        };
        ensure!(
            macho_supports_cpu(&header[..len], cpu),
            "{} 不适合当前 Mac，请选择对应芯片的 macOS 构建",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
        // New files do not inherit executable bits or quarantine xattrs from the
        // user's Downloads directory. Only these two explicitly selected tools run.
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
        if automatic {
            let result = run_metadata(
                "/usr/bin/codesign",
                &["--verify", "--strict", &path.to_string_lossy()],
            )
            .await?;
            ensure!(
                result.status.success(),
                "下载的媒体工具签名校验失败，请重试"
            );
        }
    }
    #[cfg(windows)]
    {
        use std::io::{Seek, SeekFrom};
        let mut file = File::open(path)?;
        let mut dos = [0u8; 64];
        file.read_exact(&mut dos).context("工具文件不完整，请重新下载 ZIP")?;
        ensure!(&dos[..2] == b"MZ", "请选择 Windows 版 FFmpeg 工具包，不是源码或其他系统的构建");
        let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
        ensure!(offset >= 64 && offset + 24 <= file.metadata()?.len(), "Windows 工具文件头损坏，请重新下载 ZIP");
        file.seek(SeekFrom::Start(offset))?;
        let mut pe = [0u8; 24];
        file.read_exact(&mut pe)?;
        ensure!(&pe[..4] == b"PE\0\0", "不是有效的 Windows 工具，请重新下载 ZIP");
        let machine = u16::from_le_bytes([pe[4], pe[5]]);
        let compatible = match std::env::consts::ARCH {
            "x86_64" => matches!(machine, 0x8664 | 0x014c),
            // Windows on ARM can run x64/x86 tools; the runtime check below
            // remains authoritative for the OS version's emulation support.
            "aarch64" => matches!(machine, 0xaa64 | 0x8664 | 0x014c),
            "x86" => machine == 0x014c,
            _ => false,
        };
        ensure!(compatible, "工具架构不兼容当前 Windows（{}），请选择对应架构的工具包", std::env::consts::ARCH);
        let characteristics = u16::from_le_bytes([pe[22], pe[23]]);
        ensure!(characteristics & 0x0002 != 0 && characteristics & 0x2000 == 0, "请选择包含 ffmpeg.exe 和 ffprobe.exe 的可执行工具包");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (path, automatic);
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn macho_supports_cpu(header: &[u8], cpu: u32) -> bool {
    if header.len() < 8 {
        return false;
    }
    let read = |offset: usize, little: bool| {
        let bytes: [u8; 4] = header[offset..offset + 4].try_into().unwrap();
        if little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        }
    };
    match &header[..4] {
        [0xcf, 0xfa, 0xed, 0xfe] => read(4, true) == cpu,
        [0xfe, 0xed, 0xfa, 0xcf] => read(4, false) == cpu,
        magic @ ([0xca, 0xfe, 0xba, 0xbe]
        | [0xca, 0xfe, 0xba, 0xbf]
        | [0xbe, 0xba, 0xfe, 0xca]
        | [0xbf, 0xba, 0xfe, 0xca]) => {
            let little = magic[3] == 0xca;
            let stride = if magic[3] == 0xbf || magic[0] == 0xbf {
                32
            } else {
                20
            };
            let count = read(4, little) as usize;
            count <= 32
                && header.len() >= 8 + count * stride
                && (0..count).any(|i| read(8 + i * stride, little) == cpu)
        }
        _ => false,
    }
}

async fn run_metadata(
    binary: impl AsRef<std::ffi::OsStr>,
    args: &[&str],
) -> Result<std::process::Output> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .context("读取媒体工具信息超时")?
        .context("无法读取媒体工具信息")
}

pub(super) async fn save_license(binary: &Path, package: &Path) -> Result<()> {
    let output = run_metadata(binary, &["-L"]).await?;
    ensure!(output.status.success(), "无法读取 FFmpeg 许可信息");
    let mut bytes = output.stdout;
    bytes.extend(output.stderr);
    fs::write(package.join("kdj-ffmpeg-license.txt"), bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_native_downloads_for_both_mac_architectures() {
        for (arch, expected) in [("aarch64", "arm64"), ("x86_64", "amd64")] {
            let specs = download_specs("macos", arch).unwrap();
            assert_eq!(specs.len(), 2);
            assert!(specs
                .iter()
                .all(|s| s.url.contains(&format!("/macos/{expected}/release/"))));
            assert!(specs[0].url.ends_with("/ffmpeg.zip"));
            assert!(specs[1].url.ends_with("/ffprobe.zip"));
        }
        assert_eq!(download_specs("windows", "x86_64").unwrap().len(), 1);
        assert!(download_specs("windows", "aarch64").is_err());
    }
    #[test]
    fn rejects_wrong_architecture_before_launching_and_accepts_universal_macho() {
        let arm = [0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1];
        assert!(macho_supports_cpu(&arm, 0x0100000c));
        assert!(!macho_supports_cpu(&arm, 0x01000007));
        assert!(!macho_supports_cpu(b"MZ invalid windows exe", 0x0100000c));
        let mut fat = vec![0; 48];
        fat[..8].copy_from_slice(&[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
        fat[8..12].copy_from_slice(&0x01000007u32.to_be_bytes());
        fat[28..32].copy_from_slice(&0x0100000cu32.to_be_bytes());
        assert!(macho_supports_cpu(&fat, 0x01000007));
        assert!(macho_supports_cpu(&fat, 0x0100000c));
        assert!(!macho_supports_cpu(&fat[..20], 0x0100000c));
    }
}
