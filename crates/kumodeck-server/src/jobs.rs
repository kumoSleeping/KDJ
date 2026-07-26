//! 后台任务：扫描、分析。都会往事件总线上发进度。

use std::sync::Arc;

use kumodeck_analysis::engine::analyze_file;
use serde_json::json;

use crate::state::AppState;

fn new_job_id() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// 起一次扫描。立刻返回 job_id，实际工作在后台线程里跑。
pub fn spawn_scan(state: Arc<AppState>, paths: Vec<String>, recursive: bool, analyze: bool) -> String {
    let job_id = new_job_id();
    let job = job_id.clone();
    // 扫描是阻塞 IO，放 blocking 线程池，别占着 async 执行器
    tokio::task::spawn_blocking(move || {
        let hub = state.hub.clone();
        let progress = {
            let hub = hub.clone();
            let job = job.clone();
            move |done: usize, total: usize, current: &str| {
                hub.publish(
                    "scan.progress",
                    &json!({
                        "job_id": job, "done": done, "total": total,
                        "current": current, "phase": "tag"
                    }),
                );
            }
        };

        let result = kumodeck_library::scan::scan_paths(&state.library, &paths, recursive, &progress);
        let track_ids = match result {
            Ok(ids) => ids,
            Err(err) => {
                tracing::error!("扫描失败：{err:#}");
                hub.publish_toast("error", &format!("扫描失败：{err:#}"));
                hub.publish(
                    "scan.progress",
                    &json!({"job_id": job, "done": 0, "total": 0, "current": "", "phase": "done"}),
                );
                return;
            }
        };

        let total = track_ids.len();
        hub.publish(
            "scan.progress",
            &json!({"job_id": job, "done": total, "total": total, "current": "", "phase": "done"}),
        );
        hub.publish_library_updated(&track_ids);
        hub.publish_toast("info", &format!("扫描完成，共 {total} 首"));

        if analyze && !track_ids.is_empty() {
            match state.library.pending_analysis_ids(Some(&track_ids), false) {
                Ok(pending) => {
                    spawn_analysis(state.clone(), pending, false);
                }
                Err(err) => tracing::warn!("取待分析队列失败：{err:#}"),
            }
        }
    });
    job_id
}

/// 分析是 CPU 密集的（解码 + FFT），worker 开多了会把机器压满，
/// 表现是 UI 掉帧、下载速度也跟着掉。固定 2 个。
const ANALYSIS_WORKERS: usize = 2;

/// 起一批分析。返回 job_id。
pub fn spawn_analysis(state: Arc<AppState>, track_ids: Vec<i64>, write_tags: bool) -> String {
    let job_id = new_job_id();
    if track_ids.is_empty() {
        return job_id;
    }
    let job = job_id.clone();
    let duration_limit = state.config.to_settings().analysis_duration;

    tokio::task::spawn_blocking(move || {
        let hub = state.hub.clone();
        let total = track_ids.len();
        let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let updated: Arc<std::sync::Mutex<Vec<i64>>> = Default::default();

        // 手工分块而不是拉 rayon：只有这一处需要并行，一个依赖不值得
        let chunks: Vec<Vec<i64>> = track_ids
            .chunks(track_ids.len().div_ceil(ANALYSIS_WORKERS).max(1))
            .map(<[i64]>::to_vec)
            .collect();

        std::thread::scope(|scope| {
            for chunk in chunks {
                let state = state.clone();
                let hub = hub.clone();
                let job = job.clone();
                let done = done.clone();
                let updated = updated.clone();
                scope.spawn(move || {
                    for track_id in chunk {
                        let Ok(Some(track)) = state.library.get(track_id) else {
                            continue;
                        };
                        let path = std::path::PathBuf::from(&track.path);
                        let result = analyze_file(&path, duration_limit);
                        if let Err(err) = state.library.save_analysis(track_id, &result) {
                            tracing::warn!("保存分析结果失败 {track_id}：{err:#}");
                            continue;
                        }
                        if write_tags {
                            let _ = kumodeck_providers::tags::write_analysis_tags(
                                &path,
                                result.bpm,
                                &result.camelot,
                                &result.key,
                                result.energy,
                            );
                        }
                        updated.lock().unwrap().push(track_id);

                        let current = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                        hub.publish(
                            "analyze.progress",
                            &json!({
                                "job_id": job, "done": current, "total": total,
                                "current": track.filename, "track_id": track_id
                            }),
                        );
                    }
                });
            }
        });

        let ids = updated.lock().unwrap().clone();
        hub.publish_library_updated(&ids);
        hub.publish(
            "analyze.progress",
            &json!({"job_id": job, "done": total, "total": total, "current": "", "track_id": null}),
        );
        hub.publish_toast("info", &format!("分析完成，共 {} 首", ids.len()));
    });
    job_id
}
