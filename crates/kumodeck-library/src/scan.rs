//! 目录扫描：遍历 → 过滤 → 增量入库。

use std::path::{Path, PathBuf};

use anyhow::Result;
use kumodeck_providers::tags::is_audio_extension;

use crate::service::{normalize_path, LibraryService};

/// 这些目录进去只有垃圾，还容易踩到几万个文件把扫描拖死。
const SKIP_DIR_NAMES: [&str; 12] = [
    ".trash",
    ".trashes",
    "$recycle.bin",
    "__macosx",
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "system volume information",
    ".spotlight-v100",
    ".fseventsd",
    ".documentrevisions-v100",
];

/// 进度回调：(已完成, 总数, 当前文件)
pub type ProgressFn<'a> = &'a (dyn Fn(usize, usize, &str) + Send + Sync);

fn skip_dir(name: &str) -> bool {
    let lowered = name.to_lowercase();
    SKIP_DIR_NAMES.contains(&lowered.as_str()) || (name.starts_with('.') && name != ".")
}

fn is_audio(name: &str) -> bool {
    // macOS 在非 HFS 卷（U 盘 / 网盘）上给每个文件配一个 `._xxx.mp3` 资源叉，
    // 后缀和正主一模一样，不排掉会得到一堆 4KB 的"损坏音频"
    if name.starts_with("._") || name.starts_with('.') {
        return false;
    }
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(is_audio_extension)
}

/// 把入参里的文件/目录展开成去重后的音频文件列表（已归一化路径）。
pub fn collect_files(paths: &[String], recursive: bool) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = Default::default();
    let mut add = |candidate: &Path, found: &mut Vec<String>| {
        let key = normalize_path(candidate);
        if seen.insert(key.clone()) {
            found.push(key);
        }
    };

    for raw in paths {
        let root = PathBuf::from(normalize_path(Path::new(raw)));
        if root.is_file() {
            let name = root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if is_audio(&name) {
                add(&root, &mut found);
            }
            continue;
        }
        if !root.is_dir() {
            continue;
        }

        if !recursive {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            let mut names: Vec<PathBuf> = entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_type().map(|k| k.is_file()).unwrap_or(false))
                .map(|entry| entry.path())
                .collect();
            names.sort();
            for path in names {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if is_audio(&name) {
                    add(&path, &mut found);
                }
            }
            continue;
        }

        // follow_links(false)：曲库里放一个指回上层的软链接会让遍历无限递归
        let walker = walkdir::WalkDir::new(&root)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            // 剪枝而不是过滤结果：进都不要进那些目录
            .filter_entry(|entry| {
                if entry.depth() == 0 || !entry.file_type().is_dir() {
                    return true;
                }
                !skip_dir(&entry.file_name().to_string_lossy())
            });
        for entry in walker.filter_map(|entry| entry.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            if is_audio(&entry.file_name().to_string_lossy()) {
                add(entry.path(), &mut found);
            }
        }
    }
    found
}

/// 扫描并入库，返回本次扫到的全部 track id（新增 + 更新 + 未变化）。
///
/// 返回值**包含未变化的曲目**，这样调用方可以直接拿它当"这批文件对应的曲目集合"
/// 去做后续的自动分析；要不要重分析由 `pending_analysis_ids` 决定。
pub fn scan_paths(
    service: &LibraryService,
    paths: &[String],
    recursive: bool,
    on_progress: ProgressFn<'_>,
) -> Result<Vec<i64>> {
    let files = collect_files(paths, recursive);
    let total = files.len();
    on_progress(0, total, "");
    if total == 0 {
        return Ok(Vec::new());
    }

    // 一次性拉出已入库文件的 mtime，逐个查库在几万首的曲库上会慢得离谱
    let index = service.file_index()?;
    let mut track_ids: Vec<i64> = Vec::with_capacity(total);

    for (done, file_path) in files.iter().enumerate() {
        if let Some((id, known_mtime)) = index.get(file_path) {
            let mtime = std::fs::metadata(file_path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64());
            // 增量扫描：文件没动过就不重读标签
            if mtime.is_some_and(|mtime| (known_mtime - mtime).abs() < 1e-6) {
                track_ids.push(*id);
                on_progress(done + 1, total, file_path);
                continue;
            }
        }
        // 单个文件坏掉（权限/正在写入/编码异常）不能让整次扫描中断
        match service.upsert_file(Path::new(file_path), "local", "") {
            Ok(id) => track_ids.push(id),
            Err(err) => tracing::debug!("跳过 {file_path}：{err}"),
        }
        on_progress(done + 1, total, file_path);
    }
    Ok(track_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kumodeck-scan-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn macos_resource_forks_are_not_treated_as_audio() {
        // 非 HFS 卷上每个文件都配一个 `._xxx.mp3`，后缀和正主一样
        assert!(is_audio("song.mp3"));
        assert!(!is_audio("._song.mp3"), "资源叉不是音频");
        assert!(!is_audio(".hidden.mp3"));
        assert!(!is_audio("notes.txt"));
    }

    #[test]
    fn noisy_directories_are_pruned() {
        assert!(skip_dir(".git"));
        assert!(skip_dir("node_modules"));
        assert!(skip_dir("$RECYCLE.BIN"), "大小写不敏感");
        assert!(skip_dir(".Trashes"));
        assert!(!skip_dir("温州"));
    }

    #[test]
    fn recursive_collection_finds_nested_audio_and_skips_junk() {
        let dir = scratch("collect");
        std::fs::create_dir_all(dir.join("set1")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/deep")).unwrap();
        std::fs::write(dir.join("a.mp3"), b"x").unwrap();
        std::fs::write(dir.join("set1/b.flac"), b"x").unwrap();
        std::fs::write(dir.join("set1/._b.flac"), b"x").unwrap();
        std::fs::write(dir.join("set1/notes.txt"), b"x").unwrap();
        std::fs::write(dir.join("node_modules/deep/c.mp3"), b"x").unwrap();

        let found = collect_files(&[dir.to_string_lossy().into_owned()], true);
        assert_eq!(found.len(), 2, "找到的是：{found:?}");
        assert!(found.iter().any(|p| p.ends_with("a.mp3")));
        assert!(found.iter().any(|p| p.ends_with("b.flac")));
        assert!(!found.iter().any(|p| p.contains("node_modules")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_recursive_collection_stays_at_the_top_level() {
        let dir = scratch("shallow");
        std::fs::create_dir_all(dir.join("set1")).unwrap();
        std::fs::write(dir.join("a.mp3"), b"x").unwrap();
        std::fs::write(dir.join("set1/b.mp3"), b"x").unwrap();

        let found = collect_files(&[dir.to_string_lossy().into_owned()], false);
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("a.mp3"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_inputs_are_collapsed() {
        let dir = scratch("dupe");
        std::fs::write(dir.join("a.mp3"), b"x").unwrap();
        let path = dir.to_string_lossy().into_owned();
        // 同一个目录传两次 + 再单独传一次文件
        let found = collect_files(
            &[
                path.clone(),
                path,
                dir.join("a.mp3").to_string_lossy().into_owned(),
            ],
            true,
        );
        assert_eq!(found.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_single_file_argument_is_accepted() {
        let dir = scratch("single");
        std::fs::write(dir.join("a.mp3"), b"x").unwrap();
        std::fs::write(dir.join("b.txt"), b"x").unwrap();
        let found = collect_files(
            &[
                dir.join("a.mp3").to_string_lossy().into_owned(),
                dir.join("b.txt").to_string_lossy().into_owned(),
            ],
            true,
        );
        assert_eq!(found.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_paths_are_ignored_rather_than_failing() {
        let found = collect_files(&["/definitely/not/here".to_string()], true);
        assert!(found.is_empty());
    }
}
