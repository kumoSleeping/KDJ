//! 下载队列：并发控制、进度上报、取消。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use kumodeck_core::models::{
    DownloadTask, Platform, Quality, SongSource, TaskKind, TaskState, VideoDownloadRequest,
};
use kumodeck_core::EventHub;
use kumodeck_providers::{DownloadJob, MusicProvider};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn new_id() -> String {
    format!("{:016x}", rand::random::<u64>())
}

struct Entry {
    task: DownloadTask,
    cancel: CancellationToken,
}

pub struct DownloadManager {
    hub: EventHub,
    entries: Mutex<BTreeMap<String, Entry>>,
    /// 并发闸门。设置里的 `concurrent_downloads` 变了要重建。
    permits: Mutex<Arc<Semaphore>>,
}

impl DownloadManager {
    pub fn new(hub: EventHub, concurrency: u32) -> Self {
        DownloadManager {
            hub,
            entries: Mutex::new(BTreeMap::new()),
            permits: Mutex::new(Arc::new(Semaphore::new(concurrency.max(1) as usize))),
        }
    }

    pub fn set_concurrency(&self, concurrency: u32) {
        *self.permits.lock().unwrap() = Arc::new(Semaphore::new(concurrency.max(1) as usize));
    }

    /// 按创建时间升序列出，前端队列面板要的就是这个顺序。
    pub fn list(&self) -> Vec<DownloadTask> {
        let entries = self.entries.lock().unwrap();
        let mut tasks: Vec<DownloadTask> = entries.values().map(|entry| entry.task.clone()).collect();
        tasks.sort_by(|a, b| a.created_at.total_cmp(&b.created_at));
        tasks
    }

    pub fn get(&self, id: &str) -> Option<DownloadTask> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .map(|entry| entry.task.clone())
    }

    fn insert(&self, task: DownloadTask, cancel: CancellationToken) {
        self.entries
            .lock()
            .unwrap()
            .insert(task.id.clone(), Entry { task: task.clone(), cancel });
        self.hub.publish("download.updated", &task);
    }

    fn update(&self, id: &str, mutate: impl FnOnce(&mut DownloadTask)) -> Option<DownloadTask> {
        let updated = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id)?;
            mutate(&mut entry.task);
            entry.task.updated_at = now_secs();
            entry.task.clone()
        };
        self.hub.publish("download.updated", &updated);
        Some(updated)
    }

    pub fn cancel(&self, id: &str) -> Option<DownloadTask> {
        {
            let entries = self.entries.lock().unwrap();
            let entry = entries.get(id)?;
            // 已经结束的任务不再改状态，否则"完成"会被点成"已取消"
            if matches!(entry.task.state, TaskState::Done | TaskState::Failed) {
                return Some(entry.task.clone());
            }
            entry.cancel.cancel();
        }
        self.update(id, |task| {
            task.state = TaskState::Canceled;
            task.error = "已取消".into();
        })
    }

    /// 清掉所有已结束的任务，返回清掉几条。
    pub fn clear_finished(&self) -> usize {
        let removed = {
            let mut entries = self.entries.lock().unwrap();
            let before = entries.len();
            entries.retain(|_, entry| {
                !matches!(
                    entry.task.state,
                    TaskState::Done | TaskState::Failed | TaskState::Canceled
                )
            });
            before - entries.len()
        };
        self.hub.publish("download.list", &self.list());
        removed
    }
}

/// 建一条音频下载任务并在后台跑。
pub fn enqueue_audio(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    source: SongSource,
    quality: Quality,
    analyze: bool,
) -> DownloadTask {
    let task = DownloadTask {
        id: new_id(),
        kind: TaskKind::Audio,
        platform: source.platform,
        title: source.title.clone(),
        artist: source.artist_text(),
        quality: quality.as_str().to_string(),
        state: TaskState::Queued,
        progress: 0.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        speed_bps: 0.0,
        path: String::new(),
        error: String::new(),
        track_id: None,
        created_at: now_secs(),
        updated_at: now_secs(),
    };
    let cancel = CancellationToken::new();
    manager.insert(task.clone(), cancel.clone());

    let id = task.id.clone();
    tokio::spawn(async move {
        run_audio(state, manager, id, source, quality, analyze, cancel).await;
    });
    task
}

#[allow(clippy::too_many_arguments)]
async fn run_audio(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    id: String,
    source: SongSource,
    quality: Quality,
    analyze: bool,
    cancel: CancellationToken,
) {
    let permits = manager.permits.lock().unwrap().clone();
    let Ok(_permit) = permits.acquire_owned().await else {
        return;
    };
    if cancel.is_cancelled() {
        return;
    }
    let Some(provider) = state.provider(source.platform).cloned() else {
        manager.update(&id, |task| {
            task.state = TaskState::Failed;
            task.error = "平台不可用".into();
        });
        return;
    };

    manager.update(&id, |task| task.state = TaskState::Running);

    // 进度回调跨线程：闭包捕获 Arc 后在 provider 的下载循环里被调用
    let progress_manager = manager.clone();
    let progress_id = id.clone();
    let started = std::time::Instant::now();
    let progress = Arc::new(move |downloaded: u64, total: u64| {
        progress_manager.update(&progress_id, |task| {
            task.downloaded_bytes = downloaded;
            task.total_bytes = total;
            task.progress = if total > 0 {
                (downloaded as f64 / total as f64).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let elapsed = started.elapsed().as_secs_f64();
            task.speed_bps = if elapsed > 0.0 {
                downloaded as f64 / elapsed
            } else {
                0.0
            };
        });
    });

    let job = DownloadJob::new(&source, quality)
        .with_cancel(cancel.clone())
        .with_progress(progress);
    let result = provider.download(job).await;

    match result {
        Ok(path) => {
            // 下载完立刻入库，并把来源信息带上，这样曲库里能看出这首是从哪来的
            let track_id = state
                .library
                .upsert_file(&path, source.platform.as_str(), &source.key)
                .ok();
            manager.update(&id, |task| {
                task.state = TaskState::Done;
                task.progress = 1.0;
                task.path = path.to_string_lossy().into_owned();
                task.track_id = track_id;
            });
            if let Some(track_id) = track_id {
                state.hub.publish_library_updated(&[track_id]);
                if analyze {
                    crate::jobs::spawn_analysis(state.clone(), vec![track_id], false);
                }
            }
        }
        Err(err) if cancel.is_cancelled() => {
            tracing::debug!("下载取消：{err:#}");
            manager.update(&id, |task| {
                task.state = TaskState::Canceled;
                task.error = "已取消".into();
            });
        }
        Err(err) => {
            manager.update(&id, |task| {
                task.state = TaskState::Failed;
                task.error = format!("{err:#}");
            });
        }
    }
}

/// 建一条视频下载任务。
pub fn enqueue_video(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    req: VideoDownloadRequest,
    title: String,
) -> DownloadTask {
    let task = DownloadTask {
        id: new_id(),
        kind: TaskKind::Video,
        platform: Platform::Bilibili,
        title,
        artist: String::new(),
        quality: format!("{}P", req.max_height),
        state: TaskState::Queued,
        progress: 0.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        speed_bps: 0.0,
        path: String::new(),
        error: String::new(),
        track_id: None,
        created_at: now_secs(),
        updated_at: now_secs(),
    };
    let cancel = CancellationToken::new();
    manager.insert(task.clone(), cancel.clone());

    let id = task.id.clone();
    tokio::spawn(async move {
        let permits = manager.permits.lock().unwrap().clone();
        let Ok(_permit) = permits.acquire_owned().await else {
            return;
        };
        manager.update(&id, |task| task.state = TaskState::Running);

        let progress_manager = manager.clone();
        let progress_id = id.clone();
        let started = std::time::Instant::now();
        let progress: kumodeck_providers::ProgressSink =
            Arc::new(move |downloaded: u64, total: u64| {
                progress_manager.update(&progress_id, |task| {
                    task.downloaded_bytes = downloaded;
                    task.total_bytes = total;
                    task.progress = if total > 0 {
                        (downloaded as f64 / total as f64).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let elapsed = started.elapsed().as_secs_f64();
                    task.speed_bps = if elapsed > 0.0 {
                        downloaded as f64 / elapsed
                    } else {
                        0.0
                    };
                });
            });

        match state
            .bilibili
            .download_video(&req, &cancel, &progress)
            .await
        {
            Ok(path) => {
                // 只要音轨时产物是音频，进曲库；完整视频不进（会把曲库搅乱）
                let track_id = if req.audio_only {
                    state.library.upsert_file(&path, "bilibili", &req.bvid).ok()
                } else {
                    None
                };
                manager.update(&id, |task| {
                    task.state = TaskState::Done;
                    task.progress = 1.0;
                    task.path = path.to_string_lossy().into_owned();
                    task.track_id = track_id;
                });
                if let Some(track_id) = track_id {
                    state.hub.publish_library_updated(&[track_id]);
                }
            }
            Err(err) if cancel.is_cancelled() => {
                tracing::debug!("视频下载取消：{err:#}");
                manager.update(&id, |task| {
                    task.state = TaskState::Canceled;
                    task.error = "已取消".into();
                });
            }
            Err(err) => {
                manager.update(&id, |task| {
                    task.state = TaskState::Failed;
                    task.error = format!("{err:#}");
                });
            }
        }
    });
    task
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_task(id: &str, state: TaskState, created_at: f64) -> DownloadTask {
        DownloadTask {
            id: id.into(),
            kind: TaskKind::Audio,
            platform: Platform::Wyy,
            title: "t".into(),
            artist: String::new(),
            quality: "flac".into(),
            state,
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: 0,
            speed_bps: 0.0,
            path: String::new(),
            error: String::new(),
            track_id: None,
            created_at,
            updated_at: created_at,
        }
    }

    #[test]
    fn tasks_are_listed_in_creation_order() {
        let manager = DownloadManager::new(EventHub::default(), 3);
        manager.insert(sample_task("b", TaskState::Queued, 200.0), CancellationToken::new());
        manager.insert(sample_task("a", TaskState::Queued, 100.0), CancellationToken::new());
        let ids: Vec<String> = manager.list().into_iter().map(|task| task.id).collect();
        assert_eq!(ids, vec!["a", "b"], "队列面板按入队时间排，不是按 id");
    }

    #[test]
    fn cancelling_a_finished_task_does_not_rewrite_it() {
        let manager = DownloadManager::new(EventHub::default(), 3);
        manager.insert(sample_task("x", TaskState::Done, 1.0), CancellationToken::new());
        let task = manager.cancel("x").unwrap();
        assert_eq!(task.state, TaskState::Done, "完成的任务不该被点成已取消");
    }

    #[test]
    fn cancelling_a_running_task_marks_it_and_fires_the_token() {
        let manager = DownloadManager::new(EventHub::default(), 3);
        let cancel = CancellationToken::new();
        manager.insert(sample_task("x", TaskState::Running, 1.0), cancel.clone());
        let task = manager.cancel("x").unwrap();
        assert_eq!(task.state, TaskState::Canceled);
        assert!(cancel.is_cancelled(), "下载循环要靠这个 token 停下来");
    }

    #[test]
    fn clear_only_removes_finished_tasks() {
        let manager = DownloadManager::new(EventHub::default(), 3);
        manager.insert(sample_task("done", TaskState::Done, 1.0), CancellationToken::new());
        manager.insert(sample_task("failed", TaskState::Failed, 2.0), CancellationToken::new());
        manager.insert(sample_task("canceled", TaskState::Canceled, 3.0), CancellationToken::new());
        manager.insert(sample_task("running", TaskState::Running, 4.0), CancellationToken::new());
        manager.insert(sample_task("queued", TaskState::Queued, 5.0), CancellationToken::new());

        assert_eq!(manager.clear_finished(), 3);
        let ids: Vec<String> = manager.list().into_iter().map(|task| task.id).collect();
        assert_eq!(ids, vec!["running", "queued"], "正在跑和排队的不能被清掉");
    }

    #[test]
    fn progress_updates_compute_a_fraction() {
        let manager = DownloadManager::new(EventHub::default(), 3);
        manager.insert(sample_task("x", TaskState::Running, 1.0), CancellationToken::new());
        let task = manager
            .update("x", |task| {
                task.downloaded_bytes = 50;
                task.total_bytes = 200;
                task.progress = 50.0 / 200.0;
            })
            .unwrap();
        assert!((task.progress - 0.25).abs() < 1e-9);
    }

    #[test]
    fn unknown_ids_are_reported_rather_than_panicking() {
        let manager = DownloadManager::new(EventHub::default(), 3);
        assert!(manager.cancel("nope").is_none());
        assert!(manager.get("nope").is_none());
    }
}
