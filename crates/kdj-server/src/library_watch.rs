//! 桌面曲库目录监听：外部复制、移动、改名或删除媒体文件后，自动对齐 SQLite 与文件夹树。
//!
//! 显式「添加文件夹」仍走带进度的 scan job；这里是安静的增量通道，不能用
//! scan.progress 抢掉用户眼前那一批任务的进度条。

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use kdj_library::service::{FileDisposal, LibraryService};
use kdj_providers::tags::is_media_extension;
use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;

use crate::state::AppState;

const ROOT_SYNC_INTERVAL: Duration = Duration::from_secs(2);
/// Finder 复制大文件会连续发 create/write。等最后一条静下来再读标签，不能把半截文件入库。
const EVENT_SETTLE_TIME: Duration = Duration::from_millis(900);
const EVENT_TICK: Duration = Duration::from_millis(200);

#[derive(Default)]
struct ReconcileReport {
    updated_ids: Vec<i64>,
    removed_ids: Vec<i64>,
    /// 只给真正的新记录自动分析；首轮补扫返回的全部既有 id 不能整库重新排队。
    analysis_ids: Vec<i64>,
    folder_changed: bool,
}

/// 监听器和 HTTP 服务同寿命；进程退出时 Tokio runtime 会一起收掉这个任务。
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        if let Err(error) = run(state).await {
            tracing::warn!("曲库目录自动重载已停止：{error:#}");
        }
    });
}

async fn run(state: Arc<AppState>) -> Result<()> {
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |result| {
        let _ = event_tx.send(result);
    })?;
    let mut watched = Vec::<PathBuf>::new();
    let mut initial_scan = Vec::<PathBuf>::new();
    sync_roots(&state, &mut watcher, &mut watched, &mut initial_scan, true);

    let mut pending = Vec::<Event>::new();
    let mut last_event = None::<Instant>;
    let mut root_sync = tokio::time::interval(ROOT_SYNC_INTERVAL);
    let mut tick = tokio::time::interval(EVENT_TICK);

    loop {
        tokio::select! {
            maybe_event = event_rx.recv() => {
                let Some(result) = maybe_event else { break; };
                match result {
                    Ok(event) if !matches!(event.kind, EventKind::Access(_)) => {
                        pending.push(event);
                        last_event = Some(Instant::now());
                    }
                    Ok(_) => {}
                    Err(error) => tracing::warn!("曲库目录监听事件失败：{error}"),
                }
            }
            _ = root_sync.tick() => {
                let before = watched.clone();
                // 运行中新增的根来自「添加文件夹」：那条路已经起了显式扫描，
                // watcher 这里只接管之后的变化，不能再把整棵树并发扫第二遍。
                sync_roots(
                    &state,
                    &mut watcher,
                    &mut watched,
                    &mut initial_scan,
                    false,
                );
                if before != watched {
                    state.hub.publish("library.folders.updated", &json!({}));
                }
            }
            _ = tick.tick() => {
                // 首轮补扫必须等前端 WebSocket 已订阅；否则数据库虽更新了，完成事件
                // 却发在订阅之前，首屏请求若恰好撞在扫描中间就会一直少歌。
                if state.hub.subscriber_count() > 0 && !initial_scan.is_empty() {
                    let roots = std::mem::take(&mut initial_scan);
                    pending.push(
                        roots
                            .into_iter()
                            .fold(Event::new(EventKind::Any), Event::add_path),
                    );
                    last_event = Some(Instant::now());
                }
                let settled = last_event
                    .is_some_and(|at| at.elapsed() >= EVENT_SETTLE_TIME);
                if !settled || pending.is_empty() {
                    continue;
                }
                last_event = None;
                let events = std::mem::take(&mut pending);
                let roots = current_roots(&state);
                if roots.is_empty() {
                    continue;
                }
                let reconcile_state = state.clone();
                let report = tokio::task::spawn_blocking(move || {
                    // 和应用内复制/移动/删除串行；否则 watcher 可能在 rename 与 relocate
                    // 中间看见半套状态，把刚搬好的记录当成外部删除。
                    let _operations = reconcile_state
                        .folder_operations
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    reconcile_batch(&reconcile_state.library, &roots, &events)
                }).await;
                match report {
                    Ok(Ok(report)) => publish_report(&state, report),
                    Ok(Err(error)) => tracing::warn!("曲库目录自动重载失败：{error:#}"),
                    Err(error) => tracing::warn!("曲库目录自动重载任务退出：{error}"),
                }
            }
        }
    }
    Ok(())
}

fn current_roots(state: &AppState) -> Vec<PathBuf> {
    kdj_library::folders::resolve_roots(&state.config.to_settings().library_dirs)
}

fn sync_roots(
    state: &AppState,
    watcher: &mut RecommendedWatcher,
    watched: &mut Vec<PathBuf>,
    initial_scan: &mut Vec<PathBuf>,
    scan_new_roots: bool,
) {
    let current = current_roots(state);
    for old in watched.clone() {
        if !current.contains(&old) {
            if let Err(error) = watcher.unwatch(&old) {
                tracing::debug!("停止监听 {} 失败：{error}", old.display());
            }
            watched.retain(|root| root != &old);
            initial_scan.retain(|root| root != &old);
        }
    }
    for root in current {
        if watched.contains(&root) {
            continue;
        }
        match watcher.watch(&root, RecursiveMode::Recursive) {
            Ok(()) => {
                tracing::info!("监听曲库目录：{}", root.display());
                watched.push(root.clone());
                if scan_new_roots && !initial_scan.contains(&root) {
                    initial_scan.push(root);
                }
            }
            Err(error) => tracing::warn!("无法监听曲库目录 {}：{error}", root.display()),
        }
    }
    watched.sort();
}

fn publish_report(state: &Arc<AppState>, mut report: ReconcileReport) {
    report.updated_ids.sort_unstable();
    report.updated_ids.dedup();
    report.removed_ids.sort_unstable();
    report.removed_ids.dedup();
    report.analysis_ids.sort_unstable();
    report.analysis_ids.dedup();

    let mut changed = report.updated_ids;
    changed.extend(report.removed_ids);
    changed.sort_unstable();
    changed.dedup();
    if !changed.is_empty() {
        state.hub.publish_library_updated(&changed);
    }
    if report.folder_changed {
        state.hub.publish("library.folders.updated", &json!({}));
    }

    if state.config.to_settings().auto_analyze && !report.analysis_ids.is_empty() {
        match state
            .library
            .pending_analysis_ids(Some(&report.analysis_ids), false)
        {
            Ok(ids) if !ids.is_empty() => {
                crate::jobs::spawn_analysis(state.clone(), ids, false);
            }
            Ok(_) => {}
            Err(error) => tracing::warn!("自动重载后取分析队列失败：{error:#}"),
        }
    }
}

fn is_media_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(is_media_extension)
}

fn is_internal_metadata(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, Component::Normal(name) if name == kdj_library::folders::METADATA_DIR_NAME)
    })
}

fn containing_root<'a>(path: &Path, roots: &'a [PathBuf]) -> Option<&'a PathBuf> {
    roots
        .iter()
        .find(|root| path == root.as_path() || path.starts_with(root))
}

fn safe_to_remove(path: &Path, roots: &[PathBuf]) -> bool {
    let Some(root) = containing_root(path, roots) else {
        return false;
    };
    // 拔盘/掉挂载时绝不能把整块盘的曲库记录清空。只有根仍在且可读，才把
    // 根下面某个消失的文件解释成用户真的删了它。
    path != root && root.is_dir() && std::fs::read_dir(root).is_ok()
}

fn rename_pair(event: &Event) -> Option<(&Path, &Path)> {
    if !matches!(
        event.kind,
        EventKind::Modify(ModifyKind::Name(RenameMode::Both))
    ) || event.paths.len() < 2
    {
        return None;
    }
    Some((&event.paths[0], &event.paths[1]))
}

fn destructive_event(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    )
}

fn reconcile_batch(
    library: &LibraryService,
    roots: &[PathBuf],
    events: &[Event],
) -> Result<ReconcileReport> {
    let mut report = ReconcileReport::default();
    let mut scan_paths = Vec::<PathBuf>::new();
    let mut handled_missing = HashSet::<PathBuf>::new();

    // 原生后端给出完整 rename 对时优先保住原 id、分析、评分和 Cue；退化平台即使只给
    // remove/create，下面仍能完成删旧入新，只是无法证明两端是同一首。
    for event in events {
        let Some((old, new)) = rename_pair(event) else {
            continue;
        };
        if is_internal_metadata(old) || is_internal_metadata(new) || !new.exists() {
            continue;
        }
        if containing_root(new, roots).is_none() {
            continue;
        }
        if is_media_path(new) {
            if let Some(track) = library.get_by_path(old)? {
                if library.get_by_path(new)?.is_none() {
                    library.relocate(track.id, new)?;
                    report.updated_ids.push(track.id);
                    handled_missing.insert(old.to_path_buf());
                }
            }
        } else if new.is_dir() && safe_to_remove(old, roots) {
            match library.rebase_paths(old, new) {
                Ok(ids) => {
                    report.updated_ids.extend(ids);
                    handled_missing.insert(old.to_path_buf());
                }
                // 目标下若已有同路径记录，放弃保 id，交给后面的幂等扫描/清理。
                Err(error) => tracing::debug!("外部目录改名无法直接续接记录：{error:#}"),
            }
        }
    }

    for event in events {
        for path in &event.paths {
            if is_internal_metadata(path) || containing_root(path, roots).is_none() {
                continue;
            }
            report.folder_changed = true;
            if path.is_dir() || (path.is_file() && is_media_path(path)) {
                scan_paths.push(path.clone());
                continue;
            }
            if path.exists()
                || !destructive_event(event)
                || handled_missing.contains(path)
                || !safe_to_remove(path, roots)
            {
                continue;
            }
            if is_media_path(path) {
                if let Some(track) = library.get_by_path(path)? {
                    if library.delete(track.id, FileDisposal::Keep)? {
                        report.removed_ids.push(track.id);
                    }
                }
            } else {
                report.removed_ids.extend(library.forget_under(path)?);
            }
        }
    }

    scan_paths.sort();
    scan_paths.dedup();
    if !scan_paths.is_empty() {
        let known_ids: HashSet<i64> = library
            .file_index()?
            .into_values()
            .map(|(id, _, _)| id)
            .collect();
        let raw: Vec<String> = scan_paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let scan = kdj_library::scan::scan_paths(library, &raw, true, &|_, _, _| {})?;
        for root in scan.unreadable_roots {
            tracing::warn!("自动重载时无法读取：{root}");
        }
        report.analysis_ids.extend(
            scan.track_ids
                .iter()
                .copied()
                .filter(|id| !known_ids.contains(id)),
        );
        report.updated_ids.extend(scan.track_ids);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, RemoveKind};

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "kdj-library-watch-{name}-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn library() -> LibraryService {
        LibraryService::new(kdj_library::Database::open_in_memory().unwrap())
    }

    #[test]
    fn an_external_create_is_imported_and_an_external_remove_is_forgotten() {
        let root = scratch("create-remove");
        let song = root.join("new.mp3");
        std::fs::write(&song, b"audio").unwrap();
        let library = library();

        let created = Event::new(EventKind::Create(CreateKind::File)).add_path(song.clone());
        let report = reconcile_batch(&library, std::slice::from_ref(&root), &[created]).unwrap();
        let id = library.get_by_path(&song).unwrap().unwrap().id;
        assert!(report.updated_ids.contains(&id));
        assert_eq!(report.analysis_ids, vec![id]);

        std::fs::remove_file(&song).unwrap();
        let removed = Event::new(EventKind::Remove(RemoveKind::File)).add_path(song.clone());
        let report = reconcile_batch(&library, std::slice::from_ref(&root), &[removed]).unwrap();
        assert_eq!(report.removed_ids, vec![id]);
        assert!(library.get(id).unwrap().is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_complete_rename_keeps_the_track_identity_and_metadata() {
        let root = scratch("rename");
        let old = root.join("before.mp3");
        let new = root.join("after.mp3");
        std::fs::write(&old, b"audio").unwrap();
        let library = library();
        let id = library.upsert_file(&old, "local", "").unwrap();
        std::fs::rename(&old, &new).unwrap();

        let renamed = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(old.clone())
            .add_path(new.clone());
        let report = reconcile_batch(&library, std::slice::from_ref(&root), &[renamed]).unwrap();
        assert!(report.updated_ids.contains(&id));
        assert!(library.get_by_path(&old).unwrap().is_none());
        assert_eq!(library.get_by_path(&new).unwrap().unwrap().id, id);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn losing_a_library_root_never_erases_its_database_records() {
        let root = scratch("unmount");
        let song = root.join("keep.mp3");
        std::fs::write(&song, b"audio").unwrap();
        let library = library();
        let id = library.upsert_file(&song, "local", "").unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        let removed = Event::new(EventKind::Remove(RemoveKind::Folder)).add_path(root.clone());
        let report = reconcile_batch(&library, std::slice::from_ref(&root), &[removed]).unwrap();
        assert!(report.removed_ids.is_empty());
        assert!(library.get(id).unwrap().is_some());
    }
}
