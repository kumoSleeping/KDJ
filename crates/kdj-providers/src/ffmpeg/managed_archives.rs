//! Local tool archives are extracted only into the manager's private staging directory.
use super::*;
use std::io::{Seek, SeekFrom};

pub(super) fn extract_archive(source: &Path, target: &Path) -> Result<()> {
    let mut file = File::open(source).context("无法打开媒体工具压缩包")?;
    ensure!(file.metadata()?.len() <= MAX_DOWNLOAD, "压缩包超过大小限制");
    let mut signature = [0; 6];
    file.read_exact(&mut signature).context("压缩包不完整")?;
    file.seek(SeekFrom::Start(0))?;
    if signature == [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] {
        extract_7z(file, target)
    } else if signature.starts_with(b"PK\x03\x04") || signature.starts_with(b"PK\x05\x06") {
        extract_zip(source, target)
    } else {
        bail!("不支持此压缩格式，请选择 FFmpeg 的 ZIP、7Z 或已解压的文件夹")
    }
}

fn entry_path(entry: &sevenz_rust2::ArchiveEntry) -> Result<PathBuf> {
    // 7-Zip normally stores '/', but other Windows writers can store '\\'.
    // Normalize separators before checking traversal, drive paths and ADS.
    let name = entry.name.replace('\\', "/");
    ensure!(
        !name.contains(':') && !name.starts_with('/'),
        "7Z 包含不安全的路径"
    );
    let path = PathBuf::from(&name);
    ensure!(safe_relative(&path), "7Z 包含不安全的路径");
    ensure!(
        name.trim_end_matches('/').split('/').all(safe_windows_name),
        "7Z 包含不安全的文件名"
    );
    ensure!(!entry.is_anti_item, "7Z 不支持删除标记");
    if entry.has_windows_attributes {
        let mode = (entry.windows_attributes >> 16) & 0o170000;
        ensure!(
            entry.windows_attributes & 0x400 == 0,
            "7Z 不支持重解析点或符号链接"
        );
        ensure!(
            mode == 0
                || mode
                    == if entry.is_directory {
                        0o040000
                    } else {
                        0o100000
                    },
            "7Z 不支持符号链接或特殊文件"
        );
    }
    Ok(path)
}

fn extract_7z(file: File, target: &Path) -> Result<()> {
    let mut archive = sevenz_rust2::ArchiveReader::new(file, sevenz_rust2::Password::empty())
        .context("无法读取 7Z 压缩包")?;
    archive.set_thread_count(1);
    ensure!(
        archive.archive().files.len() <= MAX_FILES,
        "7Z 文件数量过多"
    );
    let mut total = 0u64;
    // Validate all entries before writing any files. No library extraction helper
    // is used: we own path checks, create-new semantics and output byte limits.
    for entry in &archive.archive().files {
        entry_path(entry)?;
        ensure!(
            entry.size <= MAX_UNPACKED - total,
            "解压后的工具包超过大小限制"
        );
        total += entry.size;
    }
    let mut blocks_total = 0u64;
    for block in &archive.archive().blocks {
        let size = block.get_unpack_size();
        ensure!(
            size <= MAX_UNPACKED - blocks_total,
            "7Z 解压数据超过大小限制"
        );
        blocks_total += size;
        let mut dictionary_total = 0u64;
        for coder in &block.coders {
            let properties = coder.properties();
            let dictionary = match (coder.encoder_method_id(), properties) {
                ([0x21], [p, ..]) if *p <= 40 => {
                    if *p == 40 {
                        u64::from(u32::MAX)
                    } else {
                        (2 | u64::from(p & 1)) << (p / 2 + 11)
                    }
                }
                ([0x03, 0x01, 0x01] | [0x03, 0x04, 0x01], [_, a, b, c, d, ..]) => {
                    u64::from(u32::from_le_bytes([*a, *b, *c, *d]))
                }
                _ => 0,
            };
            dictionary_total += dictionary;
            ensure!(
                dictionary_total <= 256 * 1024 * 1024,
                "7Z 解压字典超过内存限制"
            );
        }
    }
    archive
        .for_each_entries(|entry, reader| {
            let mut extract = || -> Result<()> {
                let path = target.join(entry_path(entry)?);
                if entry.is_directory {
                    ensure!(entry.size == 0, "7Z 目录包含异常数据");
                    fs::create_dir_all(path)?;
                } else {
                    fs::create_dir_all(path.parent().context("无效的 7Z 路径")?)?;
                    let mut output = File::options().write(true).create_new(true).open(path)?;
                    let copied = std::io::copy(&mut reader.take(entry.size + 1), &mut output)?;
                    ensure!(copied == entry.size, "7Z 文件大小校验失败");
                }
                Ok(())
            };
            extract()
                .map(|()| true)
                .map_err(|error| sevenz_rust2::Error::Other(format!("{error:#}").into()))
        })
        .context("7Z 解压失败")
}
