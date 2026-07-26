//! 后台任务：扫描、分析。都会往事件总线上发进度。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use kumodeck_analysis::engine::analyze_file;
use serde::Serialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

fn new_job_id() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// 导入结束时那一条 `scan.progress`（`phase = "done"`）。
///
/// 成功和失败共用一个构造点，是为了保证两边**形状一样**：前端只有这一条事件
/// 能知道这次导入的结局，失败时少一个键、成功时多一个键的话，它就只能靠
/// "有没有这个字段"去猜，而那正是最容易在下一次改动里悄悄错掉的判断。
///
/// `error` 恒定出现（成功是 `null`），所以新一轮的终局事件总能把上一次的错误盖掉。
fn scan_done_event(job_id: &str, done: usize, total: usize, error: Option<String>) -> serde_json::Value {
    json!({
        "job_id": job_id,
        "done": done,
        "total": total,
        "current": "",
        "phase": "done",
        "error": error,
    })
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
                tracing::error!("导入失败：{err:#}");
                // 失败原因必须**跟着终局事件一起走**。前端不再有浮层通知，
                // 只回一个 0/0 的 done 的话，用户看到的是进度条闪一下就没了、
                // 一首歌都没进来，而"为什么"全在他看不见的服务端日志里。
                hub.publish(
                    "scan.progress",
                    &scan_done_event(&job, 0, 0, Some(format!("{err:#}"))),
                );
                return;
            }
        };

        let total = track_ids.len();
        hub.publish("scan.progress", &scan_done_event(&job, total, total, None));
        hub.publish_library_updated(&track_ids);

        if analyze && !track_ids.is_empty() {
            match state.library.pending_analysis_ids(Some(&track_ids), false) {
                Ok(pending) => {
                    // 扫描顺带跑的批量分析是后台活，「停止分析」应该停得掉
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

/// 全局分析并发闸门。
///
/// `ANALYSIS_WORKERS` 原来只限**一个批次内**的线程数：3 个下载同时完成
/// 加上后台补齐，就是 4 个批次 × 2 线程 = 8 条分析线程同时在跑，
/// 正是上面注释想避免的场面（实测「停止」一次取消掉 3 个批次）。
/// v0.1.0 的做法是所有非插队批次共用一个 2-worker 线程池；这里等价地
/// 用一个 2 permit 的闸门：**每首歌**取一次 permit，批次之间自然交错，
/// 不会出现"先来的批次把闸门占到跑完"的饥饿。
///
/// 插队批次（`priority = true`，正在播放的那一首）**不走闸门**——
/// Python 版单独给它开池子也是同一个理由：它等的每一秒用户都盯着看。
struct AnalysisGate {
    permits: Mutex<usize>,
    cv: std::sync::Condvar,
}

/// 闸门的凭证。拿在手里代表占着一个并发额度，drop 即归还。
struct AnalysisPermit<'a>(&'a AnalysisGate);

impl AnalysisGate {
    const fn new(permits: usize) -> Self {
        AnalysisGate {
            permits: Mutex::new(permits),
            cv: std::sync::Condvar::new(),
        }
    }

    fn acquire(&self) -> AnalysisPermit<'_> {
        let mut permits = self.permits.lock().unwrap();
        while *permits == 0 {
            permits = self.cv.wait(permits).unwrap();
        }
        *permits -= 1;
        AnalysisPermit(self)
    }
}

impl Drop for AnalysisPermit<'_> {
    fn drop(&mut self) {
        *self.0.permits.lock().unwrap() += 1;
        self.0.cv.notify_one();
    }
}

static ANALYSIS_GATE: AnalysisGate = AnalysisGate::new(ANALYSIS_WORKERS);

// ---------------------------------------------------------------- 停止分析

/// 一个正在跑的分析批次。`done` 这个计数器和干活的线程是同一份，
/// 所以「还剩几首」随时读随时准，不用另外同步。
struct AnalysisJob {
    cancel: CancellationToken,
    total: usize,
    done: Arc<AtomicUsize>,
}

/// `POST /api/library/analyze/cancel` 的返回形状。
/// 字段名对齐 `src/lib/api.ts` 的 `cancelAnalyze`，不能改。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CancelReport {
    pub canceled: usize,
    pub remaining: usize,
}

/// 「停止分析」用的进程内注册表，一个实例挂在 `AppState` 上。
///
/// 取消是**协作式**的：只在每首歌开始之前看一眼 token。正在解码的那一首会跑完，
/// 因为分析一首要好几秒，中途硬掐会留下半写的数据库行——为了早停几秒不值得。
#[derive(Default)]
pub struct AnalysisRegistry {
    jobs: Mutex<BTreeMap<String, AnalysisJob>>,
}

impl AnalysisRegistry {
    /// 登记一个批次，拿回这个批次自己的 token。
    ///
    /// `priority = true` 的批次**故意不登记**：那是「正在播放的这一首」插的队，
    /// 用户点「停止分析」要停的是那批几百首的后台活，把正在放的这首一起掐了，
    /// 界面上就是"放着的歌永远出不来 BPM/调号"。Python 版 `queue_analysis`
    /// 也是同一条规则（插队任务不进 `current_analysis`）。
    fn register(
        &self,
        job_id: &str,
        total: usize,
        done: Arc<AtomicUsize>,
        priority: bool,
    ) -> CancellationToken {
        let cancel = CancellationToken::new();
        if priority {
            return cancel;
        }
        self.jobs.lock().unwrap().insert(
            job_id.to_string(),
            AnalysisJob {
                cancel: cancel.clone(),
                total,
                done,
            },
        );
        cancel
    }

    /// 批次跑完（或被取消后收尾完）注销，否则注册表会一直涨。
    fn unregister(&self, job_id: &str) {
        self.jobs.lock().unwrap().remove(job_id);
    }

    /// 取消。`job_id` 认不出来（空串、或者是前端手里那个已经跑完的旧 id）
    /// 一律按「取消全部」处理——这是照抄 Python 版的行为：
    /// 用户点的是「停止分析」，这时候回他一句「没找到任务」而分析还在跑，最糟。
    pub fn cancel(&self, job_id: &str) -> CancelReport {
        let jobs = self.jobs.lock().unwrap();
        let selected: Vec<&AnalysisJob> = match jobs.get(job_id) {
            Some(job) => vec![job],
            None => jobs.values().collect(),
        };

        let mut report = CancelReport {
            canceled: 0,
            remaining: 0,
        };
        for job in selected {
            job.cancel.cancel();
            report.canceled += 1;
            // 已经跑过的不算「剩下的」；done 理论上不会超过 total，饱和减法只是兜底
            report.remaining += job.total.saturating_sub(job.done.load(Ordering::Relaxed));
        }
        report
    }

    /// 当前在册的批次数。给测试和排查用。
    pub fn running(&self) -> usize {
        self.jobs.lock().unwrap().len()
    }
}

/// 起一批分析。返回 job_id。
///
/// `priority` = 「正在播放的这一首」插队，对应 `AnalyzeRequest.priority`。
/// 它只影响**能不能被「停止分析」掐掉**（见 `AnalysisRegistry::register`）；
/// 排队本身不用另开通道：每一批都是独立的 blocking 任务，插队的那一首
/// 不会排在几百首后面等着。
///
/// `write_tags_after_analyze` 在这里读、而不是让调用方传：Python 版是在
/// 每首歌分析完的那一刻读 `config.write_tags_after_analyze` 的，
/// 调用方各传各的必然漏——下载完成和扫描顺带的那两条路径就都传成了 false，
/// 结果是"设置里开了『分析后写回标签』，新下的歌却一个标签都没写"。
pub fn spawn_analysis(state: Arc<AppState>, track_ids: Vec<i64>, priority: bool) -> String {
    let job_id = new_job_id();
    if track_ids.is_empty() {
        return job_id;
    }
    let job = job_id.clone();
    let settings = state.config.to_settings();
    let duration_limit = settings.analysis_duration;
    let write_tags = settings.write_tags_after_analyze;

    let total = track_ids.len();
    let done = Arc::new(AtomicUsize::new(0));
    // 在起线程**之前**登记：否则 spawn_blocking 还排在队列里的这段时间，
    // 用户点停止会被告知"没有任务在跑"，而进度条已经显示出来了。
    let cancel = state
        .analysis
        .register(&job_id, total, done.clone(), priority);

    tokio::task::spawn_blocking(move || {
        let hub = state.hub.clone();
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
                let cancel = cancel.clone();
                scope.spawn(move || {
                    for track_id in chunk {
                        // 先排队拿全局额度，**拿到之后**再看取消：闸门里等了
                        // 半分钟才轮到的线程，看到的必须是最新的取消状态
                        let _permit = (!priority).then(|| ANALYSIS_GATE.acquire());
                        // 每首歌之间查一次。查在循环顶上而不是分析中途：
                        // 解码/FFT 是一整块 CPU 活，切进去只能靠杀线程
                        if cancel.is_cancelled() {
                            break;
                        }
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
                                // 备注是用户自己的话，comment 的组法在 tags 层：
                                // "8A - Energy 7 - 备注"，备注必须原样保留在最后
                                &track.comment,
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

        // 先注销再收尾：不然这一瞬间进来的取消请求会把一个已经结束的批次
        // 算进 canceled 里，前端就看到"停止了 1 个任务"但其实什么都没停。
        // 插队批次压根没登记过，跳过（注销一个不存在的键无害，但写清楚意图）
        if !priority {
            state.analysis.unregister(&job);
        }

        let ids = updated.lock().unwrap().clone();
        hub.publish_library_updated(&ids);
        // 取消也要发这条收尾事件，而且 done 直接顶到 total：
        // 停在半路的进度条前端不会自己收，会一直挂在那里
        hub.publish(
            "analyze.progress",
            &json!({"job_id": job, "done": total, "total": total, "current": "", "track_id": null}),
        );
        // 这里**不发**"分析完成"的提示。前端现在会在空闲时一批 20 首地自动补齐，
        // 一千多首的曲库要跑几十批；每批弹一句就是整夜刷屏。
        // 跑完的证据是列表里的 BPM/调号直接出现了，那比一条会飘走的提示更实在。
        tracing::info!("分析批次 {job} 结束：{} 首", ids.len());
    });
    job_id
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 登记一个批次，并把它的 done 计数器一并返回，方便测试里推进进度。
    fn register(
        registry: &AnalysisRegistry,
        job_id: &str,
        total: usize,
        done: usize,
    ) -> (CancellationToken, Arc<AtomicUsize>) {
        let counter = Arc::new(AtomicUsize::new(done));
        let cancel = registry.register(job_id, total, counter.clone(), false);
        (cancel, counter)
    }

    /// 插队批次（正在播放的那一首）。
    fn register_priority(registry: &AnalysisRegistry, job_id: &str) -> CancellationToken {
        registry.register(job_id, 1, Arc::new(AtomicUsize::new(0)), true)
    }

    #[test]
    fn cancelling_by_id_fires_the_token_and_counts_what_is_left() {
        let registry = AnalysisRegistry::default();
        let (cancel, _) = register(&registry, "job-a", 10, 3);

        let report = registry.cancel("job-a");
        assert_eq!(
            report,
            CancelReport {
                canceled: 1,
                remaining: 7
            }
        );
        assert!(cancel.is_cancelled(), "分析线程要靠这个 token 停下来");
    }

    #[test]
    fn remaining_tracks_the_live_counter() {
        let registry = AnalysisRegistry::default();
        let (_, done) = register(&registry, "job-a", 10, 0);
        // 分析线程边跑边加，取消时读到的必须是当下的值而不是登记时的快照
        done.store(9, Ordering::Relaxed);
        assert_eq!(registry.cancel("job-a").remaining, 1);
    }

    #[test]
    fn an_empty_job_id_cancels_every_running_batch() {
        let registry = AnalysisRegistry::default();
        let (a, _) = register(&registry, "job-a", 10, 4);
        let (b, _) = register(&registry, "job-b", 5, 5);

        let report = registry.cancel("");
        assert_eq!(
            report,
            CancelReport {
                canceled: 2,
                remaining: 6
            },
            "两批加起来还剩 6 首没处理"
        );
        assert!(a.is_cancelled() && b.is_cancelled());
    }

    #[test]
    fn an_unknown_job_id_also_cancels_everything() {
        // 照抄 Python 版：前端手里的 job_id 可能是上一批的，
        // 这时候用户点「停止」要的是"全停"，不是"什么也没做"
        let registry = AnalysisRegistry::default();
        let (a, _) = register(&registry, "job-a", 8, 0);

        let report = registry.cancel("已经跑完的旧 id");
        assert_eq!(report.canceled, 1);
        assert_eq!(report.remaining, 8);
        assert!(a.is_cancelled());
    }

    #[test]
    fn cancelling_with_nothing_running_is_a_no_op() {
        let registry = AnalysisRegistry::default();
        let empty = CancelReport {
            canceled: 0,
            remaining: 0,
        };
        assert_eq!(registry.cancel(""), empty);
        assert_eq!(registry.cancel("job-a"), empty);
    }

    #[test]
    fn a_finished_batch_is_no_longer_cancellable() {
        let registry = AnalysisRegistry::default();
        register(&registry, "job-a", 10, 10);
        assert_eq!(registry.running(), 1);

        registry.unregister("job-a");
        assert_eq!(registry.running(), 0, "跑完要注销，否则注册表只涨不减");
        assert_eq!(
            registry.cancel("job-a").canceled,
            0,
            "已结束的批次不能再被算成「停止了 1 个任务」"
        );
    }

    #[test]
    fn stopping_analysis_does_not_kill_the_track_that_is_playing() {
        // `AnalyzeRequest.priority` 走的是「正在放的这首插个队」，
        // 它和用户点的那颗「停止分析」不是一回事：把它一起掐了，
        // 界面上就是"放着的歌永远出不来 BPM/调号"。Python 版同样把插队任务
        // 排除在 current_analysis 之外。
        let registry = AnalysisRegistry::default();
        let (batch, _) = register(&registry, "job-batch", 500, 0);
        let now_playing = register_priority(&registry, "job-now");

        let report = registry.cancel("");
        assert_eq!(report.canceled, 1, "只停批量那一批");
        assert_eq!(report.remaining, 500);
        assert!(batch.is_cancelled());
        assert!(!now_playing.is_cancelled(), "插队分析不能被一起掐掉");
        assert_eq!(registry.running(), 1, "插队批次不占注册表");
    }

    #[test]
    fn a_priority_batch_cannot_be_cancelled_by_its_own_id_either() {
        // 没登记 = 按 id 也找不到；找不到会退化成"取消全部"，
        // 所以这里必须确认注册表里真的一个都没有，否则会误伤批量那一批
        let registry = AnalysisRegistry::default();
        let now_playing = register_priority(&registry, "job-now");
        assert_eq!(registry.cancel("job-now").canceled, 0);
        assert!(!now_playing.is_cancelled());
    }

    #[test]
    fn remaining_never_goes_negative() {
        // done > total 现实中不该出现，但真出现了也不能 panic（usize 会溢出）
        let registry = AnalysisRegistry::default();
        register(&registry, "job-a", 3, 5);
        assert_eq!(registry.cancel("job-a").remaining, 0);
    }

    #[test]
    fn a_failed_import_says_why_in_the_final_event() {
        // 浮层通知删掉之后，这是失败原因唯一的出路：只回 0/0 的话，
        // 用户看到的是"进度条闪了一下，一首都没进来"，和空目录一模一样
        let event = scan_done_event("job-x", 0, 0, Some("目录读不了：Permission denied".into()));
        assert_eq!(event["phase"], "done");
        assert_eq!(event["error"], "目录读不了：Permission denied");
    }

    #[test]
    fn a_successful_import_still_carries_the_error_key_as_null() {
        // 缺键和 null 在前端是两回事：缺键时它没法把上一次失败的提示盖掉，
        // 用户会看着一条早就过期的红字，怎么重试都不消失
        let event = scan_done_event("job-x", 7, 7, None);
        assert!(event.as_object().unwrap().contains_key("error"));
        assert!(event["error"].is_null());
        assert_eq!(event["done"], 7);
        assert_eq!(event["total"], 7);
    }

    #[test]
    fn the_gate_caps_concurrency_across_batches_not_within_one() {
        // 模拟 4 个批次同时开工：不管来了多少批，闸门里同时最多 2 个。
        // 用自建实例而不是那个 static，免得和真在跑的分析互相干扰。
        let gate = Arc::new(AnalysisGate::new(2));
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let handles: Vec<_> = (0..4)
            .map(|_| {
                let gate = gate.clone();
                let running = running.clone();
                let peak = peak.clone();
                std::thread::spawn(move || {
                    for _ in 0..3 {
                        let _permit = gate.acquire();
                        let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        running.fetch_sub(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        assert!(peak.load(Ordering::SeqCst) <= 2, "峰值 {}", peak.load(Ordering::SeqCst));
        // 全部归还之后额度要回到满值，不然闸门会越用越窄
        assert_eq!(*gate.permits.lock().unwrap(), 2);
    }
}
