use super::*;
use std::io::Write;
use zip::write::SimpleFileOptions;

fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
    let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
    for (name, bytes) in files {
        zip.start_file(
            *name,
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

fn pair(root: &Path) {
    fs::create_dir_all(root).unwrap();
    for name in [FFMPEG_NAME, FFPROBE_NAME] {
        fs::write(root.join(name), b"invalid executable").unwrap();
    }
}

#[test]
fn imports_compressed_zip_and_preserves_licenses_and_dlls() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("ffmpeg.zip");
    write_zip(
        &source,
        &[
            (&format!("ffmpeg-build/bin/{FFMPEG_NAME}"), b"ffmpeg"),
            (&format!("ffmpeg-build/bin/{FFPROBE_NAME}"), b"ffprobe"),
            ("ffmpeg-build/bin/avcodec.dll", b"dll"),
            ("ffmpeg-build/LICENSE", b"license"),
            ("ffmpeg-build/doc/README.txt", b"source attribution"),
        ],
    );
    let target = temp.path().join("output");
    extract_zip(&source, &target).unwrap();
    assert_eq!(find_bin(&target).unwrap(), target.join("ffmpeg-build/bin"));
    assert_eq!(
        fs::read(target.join("ffmpeg-build/LICENSE")).unwrap(),
        b"license"
    );
    assert!(target.join("ffmpeg-build/bin/avcodec.dll").is_file());
    assert!(target.join("ffmpeg-build/doc/README.txt").is_file());
    assert!(source.is_file());
}

#[test]
fn rejects_traversal_windows_paths_symlinks_and_corrupt_archives() {
    let temp = tempfile::tempdir().unwrap();
    let zip_path = temp.path().join("bad.zip");
    for name in [
        "../escaped",
        "/absolute",
        "C:/windows/file",
        "bin\\..\\escaped",
        "bin/file:stream",
        "bin/NUL.exe",
        "bin/COM1",
        "bin/file.",
    ] {
        write_zip(&zip_path, &[(name, b"bad")]);
        assert!(
            extract_zip(&zip_path, &temp.path().join("output")).is_err(),
            "{name}"
        );
        assert!(!temp.path().join("escaped").exists());
    }
    let mut zip = zip::ZipWriter::new(File::create(&zip_path).unwrap());
    zip.add_symlink("link", "../outside", SimpleFileOptions::default())
        .unwrap();
    zip.finish().unwrap();
    assert!(extract_zip(&zip_path, &temp.path().join("output")).is_err());
    fs::write(&zip_path, b"not a zip").unwrap();
    assert!(extract_zip(&zip_path, &temp.path().join("output")).is_err());
}

#[test]
fn locates_bin_package_or_wrapper_and_rejects_ambiguous_and_incomplete_packages() {
    let temp = tempfile::tempdir().unwrap();
    let bin = temp.path().join("release/bin");
    pair(&bin);
    for root in [&bin, &temp.path().join("release"), temp.path()] {
        assert_eq!(find_bin(root).unwrap(), bin);
    }
    pair(&temp.path().join("other/bin"));
    assert!(find_bin(temp.path())
        .unwrap_err()
        .to_string()
        .contains("多套"));
    fs::remove_file(bin.join(FFPROBE_NAME)).unwrap();
    assert!(find_bin(&bin).is_err());
}

#[tokio::test]
async fn failed_import_preserves_current_install_and_cleans_staging() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("managed");
    let current = root.join("install-old/bin");
    pair(&current);
    let manager = Manager::new(root.clone());
    // Manager startup cleans unreferenced generations; create the committed one now.
    pair(&current);
    manager.activate(&current.join(FFMPEG_NAME)).unwrap();
    let invalid = temp.path().join("invalid/bin");
    pair(&invalid);
    assert!(manager
        .install(InstallSource::Folder(invalid.clone()))
        .await
        .is_err());
    assert_eq!(
        *manager.selected.read().unwrap(),
        Some(current.join(FFMPEG_NAME))
    );
    assert_eq!(
        fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().unwrap().is_dir())
            .count(),
        1
    );
    assert!(invalid.join(FFMPEG_NAME).exists());
    let reloaded = Manager::new(root);
    assert_eq!(
        *reloaded.selected.read().unwrap(),
        Some(current.join(FFMPEG_NAME))
    );
}

#[test]
fn activation_persists_selection_and_retains_old_generation_until_restart() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("managed");
    let manager = Manager::new(root.clone());
    let first = root.join("install-first/bin");
    let second = root.join("install-second/bin");
    pair(&first);
    manager.activate(&first.join(FFMPEG_NAME)).unwrap();
    pair(&second);
    manager.activate(&second.join(FFMPEG_NAME)).unwrap();
    assert!(first.is_dir());
    let reloaded = Manager::new(root.clone());
    assert_eq!(
        *reloaded.selected.read().unwrap(),
        Some(second.join(FFMPEG_NAME))
    );
    assert!(!first.exists());
    assert!(second.is_dir());
    fs::write(
        root.join("current.json"),
        r#"{"binary":"../outside/ffmpeg.exe"}"#,
    )
    .unwrap();
    assert!(Manager::new(root).selected.read().unwrap().is_none());
}

#[cfg(unix)]
#[test]
fn folder_import_rejects_symlinks_and_keeps_source_intact() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    pair(&source);
    std::os::unix::fs::symlink("/etc", source.join("outside")).unwrap();
    assert!(copy_package(&source, &temp.path().join("copy"), 0, &mut 0, &mut 0).is_err());
    assert!(source.join(FFMPEG_NAME).exists());
}

#[test]
fn merges_two_tool_zips_without_overwriting_package_licenses() {
    let temp = tempfile::tempdir().unwrap();
    let ffmpeg = temp.path().join("ffmpeg.zip");
    let ffprobe = temp.path().join("ffprobe.zip");
    write_zip(
        &ffmpeg,
        &[(FFMPEG_NAME, b"ffmpeg"), ("LICENSE", b"first license")],
    );
    write_zip(
        &ffprobe,
        &[(FFPROBE_NAME, b"ffprobe"), ("LICENSE", b"second license")],
    );
    let output = temp.path().join("output");
    packages::unpack_archives(&[ffmpeg.clone(), ffprobe.clone()], &output).unwrap();
    assert_eq!(find_bin(&output).unwrap(), output.join("bin"));
    assert_eq!(
        fs::read(output.join("archive-0/LICENSE")).unwrap(),
        b"first license"
    );
    assert_eq!(
        fs::read(output.join("archive-1/LICENSE")).unwrap(),
        b"second license"
    );
    assert!(ffmpeg.exists() && ffprobe.exists());
    assert!(
        packages::unpack_archives(&[ffmpeg.clone(), ffmpeg], &temp.path().join("duplicate"))
            .is_err()
    );
}

#[test]
fn importing_loose_tools_does_not_copy_unrelated_downloads() {
    let temp = tempfile::tempdir().unwrap();
    let downloads = temp.path().join("Downloads");
    pair(&downloads);
    fs::write(downloads.join("private-document.pdf"), b"unrelated").unwrap();
    fs::write(downloads.join("README.txt"), b"attribution").unwrap();
    let target = temp.path().join("package");
    fs::create_dir(&target).unwrap();
    packages::import_folder(&downloads, &target).unwrap();
    assert!(has_pair(&target));
    assert!(target.join("README.txt").exists());
    assert!(!target.join("private-document.pdf").exists());
    assert!(downloads.join("private-document.pdf").exists());
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "downloads signed macOS tools and runs a real encode in a temporary directory"]
async fn mac_download_install_and_export_smoke() {
    let temp = tempfile::tempdir().unwrap();
    let manager = Manager::new(temp.path().join("tools"));
    let install = manager.install(InstallSource::Download);
    tokio::pin!(install);
    loop {
        tokio::select! {
            result = &mut install => { result.unwrap(); break; }
            _ = tokio::time::sleep(Duration::from_secs(10)) => {
                let p = manager.progress.lock().unwrap();
                eprintln!("{} {:?}: {} bytes", p.phase, p.component, p.downloaded);
            }
        }
    }
    let binary = manager.selected.read().unwrap().clone().unwrap();
    let output = temp.path().join("smoke.mp4");
    let result = tokio::process::Command::new(&binary)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=64x64:r=25:d=0.4",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.4",
            "-vf",
            "scale=96:64,format=yuv420p",
            "-af",
            "atempo=1.1,apad",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-t",
            "0.4",
        ])
        .arg(&output)
        .output()
        .await
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let probe = tokio::process::Command::new(binary.with_file_name(FFPROBE_NAME))
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "json",
        ])
        .arg(output)
        .output()
        .await
        .unwrap();
    assert!(probe.status.success());
    let text = String::from_utf8(probe.stdout).unwrap();
    assert!(text.contains("h264") && text.contains("aac"), "{text}");
    assert!(binary
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("kdj-ffmpeg-license.txt")
        .is_file());
    eprintln!(
        "Native macOS download, checksums, signatures, activation and H.264/AAC export passed"
    );
}
