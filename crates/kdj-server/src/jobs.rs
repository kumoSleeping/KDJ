//! 后台任务：扫描、分析。都会往事件总线上发进度。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use kdj_analysis::engine::analyze_file;
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
fn scan_done_event(
    job_id: &str,
    done: usize,
    total: usize,
    error: Option<String>,
) -> serde_json::Value {
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
pub fn spawn_scan(
    state: Arc<AppState>,
    paths: Vec<String>,
    recursive: bool,
    analyze: bool,
) -> String {
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

        let result = kdj_library::scan::scan_paths(&state.library, &paths, recursive, &progress);
        let report = match result {
            Ok(report) => report,
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

        let total = report.track_ids.len();
        // 根目录读不了（权限被拒/挂载断开）不能静默：扫出 0 首和文件夹真空
        // 在界面上长得一模一样。终局事件的 error 字段就是干这个的。
        let error = if report.unreadable_roots.is_empty() {
            None
        } else {
            Some(unreadable_roots_message(
                &report.unreadable_roots,
                total == 0,
            ))
        };
        hub.publish("scan.progress", &scan_done_event(&job, total, total, error));
        hub.publish_library_updated(&report.track_ids);

        // 扫描可能比用户点「暂停自动分析」早开始许久。这里重新读设置，
        // 才不会在暂停后仍把刚导入的一整批曲目塞进分析队列。
        if analyze && state.config.to_settings().auto_analyze && !report.track_ids.is_empty() {
            match state
                .library
                .pending_analysis_ids(Some(&report.track_ids), false)
            {
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

/// 终局事件里"根目录读不了"的措辞。全灭和部分可读分开说：
/// 全灭是导入失败，部分是提醒（其余已经入库）。
fn unreadable_roots_message(roots: &[String], all_failed: bool) -> String {
    let first = roots.first().map(String::as_str).unwrap_or_default();
    let list = if roots.len() > 1 {
        format!("{first} 等 {} 个文件夹", roots.len())
    } else {
        first.to_string()
    };
    if all_failed {
        #[cfg(target_os = "android")]
        {
            format!("没有权限读取所选文件夹（{list}）。请到 系统设置 → 应用 → KDJ → 权限 中允许媒体权限后重试")
        }
        #[cfg(target_os = "macos")]
        {
            format!("没有权限读取所选文件夹（{list}）。请在 系统设置 → 隐私与安全性 → 文件与文件夹 中允许 KDJ 后重试")
        }
        #[cfg(not(any(target_os = "android", target_os = "macos")))]
        {
            format!("无法读取所选文件夹（{list}）：没有访问权限，或文件夹已断开")
        }
    } else {
        format!("部分文件夹无法读取：{list}（其余内容已导入）")
    }
}

#[derive(Default)]
pub struct MaintenanceRegistry {
    folder_metadata: std::sync::Mutex<Option<String>>,
    waveform: std::sync::Mutex<Option<String>>,
}

impl MaintenanceRegistry {
    fn claim(slot: &std::sync::Mutex<Option<String>>, proposed: String) -> (String, bool) {
        let mut active = slot.lock().expect("maintenance registry");
        if let Some(existing) = active.as_ref() {
            return (existing.clone(), false);
        }
        *active = Some(proposed.clone());
        (proposed, true)
    }

    fn finish(slot: &std::sync::Mutex<Option<String>>, job_id: &str) {
        let mut active = slot.lock().expect("maintenance registry");
        if active.as_deref() == Some(job_id) {
            *active = None;
        }
    }

    fn claim_folder(&self, proposed: String) -> (String, bool) {
        Self::claim(&self.folder_metadata, proposed)
    }

    fn finish_folder(&self, job_id: &str) {
        Self::finish(&self.folder_metadata, job_id);
    }

    fn claim_waveform(&self, proposed: String) -> (String, bool) {
        Self::claim(&self.waveform, proposed)
    }

    fn finish_waveform(&self, job_id: &str) {
        Self::finish(&self.waveform, job_id);
    }
}

/// 把旧 `.kdj.json` 升级到每层目录自己的 `.kdj/manifest.json`。
///
/// 由前端在 WebSocket 连好之后显式启动，所以进度不会丢在“还没人订阅”的窗口里。
/// 单个只读目录失败只记在最终 error，其他目录继续迁；任何失败路径都保留旧文件。
pub fn spawn_folder_manifest_upgrade(state: Arc<AppState>) -> String {
    let (job_id, claimed) = state.maintenance.claim_folder(new_job_id());
    if !claimed {
        return job_id;
    }
    let job = job_id.clone();
    let roots = kdj_library::folders::resolve_roots(&state.config.to_settings().library_dirs);
    tokio::task::spawn_blocking(move || {
        let hub = state.hub.clone();
        if roots.is_empty() {
            hub.publish(
                "maintenance.progress",
                &json!({
                    "job_id": job, "kind": "folder_metadata", "done": 0, "total": 0,
                    "current": "", "phase": "done", "error": null
                }),
            );
            state.maintenance.finish_folder(&job);
            return;
        }

        let mut completed = 0;
        let mut directory_total = 0;
        let report = kdj_library::folders::upgrade_manifests(&roots, |done, total, current| {
            completed = done;
            directory_total = total;
            hub.publish(
                "maintenance.progress",
                &json!({
                    "job_id": job, "kind": "folder_metadata", "done": done, "total": total,
                    "current": current.to_string_lossy(), "phase": "migrate", "error": null
                }),
            );
        });
        let error = if report.failed == 0 {
            None
        } else {
            let preview = report
                .errors
                .iter()
                .take(3)
                .map(|(path, reason)| format!("{}：{}", path, reason))
                .collect::<Vec<_>>()
                .join("；");
            Some(format!("{} 个文件夹升级失败。{}", report.failed, preview))
        };
        hub.publish(
            "maintenance.progress",
            &json!({
                "job_id": job, "kind": "folder_metadata",
                "done": completed, "total": directory_total, "current": "",
                "phase": "done", "error": error,
                "changed": report.changed, "failed": report.failed
            }),
        );
        tracing::info!(
            "文件夹元数据升级结束：更新 {}，失败 {}",
            report.changed,
            report.failed
        );
        state.maintenance.finish_folder(&job);
    });
    job_id
}

/// 给旧曲库补齐固定 640 列波形。缓存命中只读一份小 `.kdwave`；缺失时单线程逐首算，
/// 不抢播放器的交互优先权。错误集中留在活动栏，坏文件不会让整批中断。
pub fn spawn_waveform_backfill(state: Arc<AppState>) -> String {
    let (job_id, claimed) = state.maintenance.claim_waveform(new_job_id());
    if !claimed {
        return job_id;
    }
    let job = job_id.clone();
    tokio::spawn(async move {
        let hub = state.hub.clone();
        let candidates = match state.library.waveform_candidates(
            crate::waveform::CANONICAL_WAVEFORM_PROFILE,
            crate::waveform::CANONICAL_WAVEFORM_REVISION,
        ) {
            Ok(items) => items,
            Err(err) => {
                hub.publish(
                    "maintenance.progress",
                    &json!({
                        "job_id": job, "kind": "waveform", "done": 0, "total": 0,
                        "current": "", "phase": "done", "error": format!("读取波形待办失败：{err:#}")
                    }),
                );
                state.maintenance.finish_waveform(&job);
                return;
            }
        };
        let total = candidates.len();
        let cache_dir = state.config.data_dir.join("waveform");
        let mut errors: Vec<String> = Vec::new();
        hub.publish(
            "maintenance.progress",
            &json!({
                "job_id": job, "kind": "waveform", "done": 0, "total": total,
                "current": "", "phase": "prepare", "error": null
            }),
        );
        for (index, (track_id, raw_path)) in candidates.into_iter().enumerate() {
            let path = std::path::PathBuf::from(&raw_path);
            let current = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or(raw_path);
            if !path.is_file() {
                let message = "文件不存在";
                let _ = state.library.record_waveform_asset(
                    track_id,
                    crate::waveform::CANONICAL_WAVEFORM_PROFILE,
                    crate::waveform::CANONICAL_WAVEFORM_REVISION,
                    0,
                    Some(message),
                );
                errors.push(format!("{current}：{message}"));
            } else if let Err(err) = state
                .waveforms
                .prepare_default(track_id, path, cache_dir.clone())
                .await
            {
                errors.push(format!("{current}：{err:#}"));
            }
            hub.publish(
                "maintenance.progress",
                &json!({
                    "job_id": job, "kind": "waveform", "done": index + 1, "total": total,
                    "current": current, "phase": "prepare", "error": null
                }),
            );
        }
        let error = if errors.is_empty() {
            None
        } else {
            Some(format!(
                "{} 首波形准备失败。{}",
                errors.len(),
                errors
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("；")
            ))
        };
        hub.publish(
            "maintenance.progress",
            &json!({
                "job_id": job, "kind": "waveform", "done": total, "total": total,
                "current": "", "phase": "done", "error": error, "failed": errors.len()
            }),
        );
        tracing::info!("波形补齐结束：共 {total} 首，失败 {}", errors.len());
        state.maintenance.finish_waveform(&job);
    });
    job_id
}

/// 分析会顺序读完整媒体再做 FFT。Windows 上很多曲库位于 USB 盘，且低配机器的
/// Defender/索引器会同时读新文件；单 worker 避免两条整轨读取互相寻道和抢闪存。
/// 其它平台保留两个 worker，仍受下面的进程级总闸门约束。
#[cfg(target_os = "windows")]
const ANALYSIS_WORKERS: usize = 1;
#[cfg(not(target_os = "windows"))]
const ANALYSIS_WORKERS: usize = 2;

/// 全局分析并发闸门。
///
/// `ANALYSIS_WORKERS` 原来只限**一个批次内**的线程数：3 个下载同时完成
/// 加上后台补齐，就是 4 个批次 × 2 线程 = 8 条分析线程同时在跑，
/// 正是上面注释想避免的场面（实测「停止」一次取消掉 3 个批次）。
/// v0.1.0 的做法是所有非插队批次共用一个小线程池；这里等价地
/// 用平台对应数量的 permit：**每首歌**取一次 permit，批次之间自然交错，
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

/// 波形预热也属于后台 FFT 工作，必须和 BPM 分析共用这两个额度；否则“分析 2 条”
/// 之外再偷偷跑一条波形，原本的全局上限就失效了。交互波形不走这里。
pub(crate) fn acquire_background_analysis_permit() -> impl Drop {
    ANALYSIS_GATE.acquire()
}

/// 交互路径（波形）占用时 > 0。分析线程在**歌与歌之间**看到它就让路，
/// 不会去抢分析闸门（抢闸门会把自己堵在当前那两首的长解码后面）。
static INTERACTIVE_YIELD: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 标记「交互优先」：后台分析暂停接下一首，正在解的那一两首跑完即可。
pub fn yield_analysis_permits() -> AnalysisYield {
    INTERACTIVE_YIELD.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    AnalysisYield
}

/// 见 [`yield_analysis_permits`]。
pub struct AnalysisYield;

impl Drop for AnalysisYield {
    fn drop(&mut self) {
        INTERACTIVE_YIELD.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

fn wait_if_interactive_yield(cancel: &CancellationToken) {
    while INTERACTIVE_YIELD.load(std::sync::atomic::Ordering::Acquire) > 0 {
        if cancel.is_cancelled() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

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
#[derive(Clone, Copy, PartialEq, Eq)]
enum AnalysisWriteTarget {
    V1,
    BpmKeyV2,
}

pub fn spawn_analysis(state: Arc<AppState>, track_ids: Vec<i64>, priority: bool) -> String {
    spawn_analysis_target(state, track_ids, priority, AnalysisWriteTarget::V1)
}

/// 起一批只写 BPM/Key v2 的重分析任务。v1 数据由存储层按字段成功情况逐步退役。
pub fn spawn_bpm_key_analysis_v2(state: Arc<AppState>, track_ids: Vec<i64>) -> String {
    spawn_analysis_target(state, track_ids, false, AnalysisWriteTarget::BpmKeyV2)
}

fn spawn_analysis_target(
    state: Arc<AppState>,
    track_ids: Vec<i64>,
    priority: bool,
    target: AnalysisWriteTarget,
) -> String {
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
                        // 每首歌之间查一次。查在循环顶上而不是分析中途：
                        // 解码/FFT 是一整块 CPU 活，切进去只能靠杀线程
                        if cancel.is_cancelled() {
                            break;
                        }
                        // 播放条在算波形时让路：必须在拿闸门**之前**等，
                        // 否则两个 worker 占着 permit 睡大觉，波形还是抢不到 CPU。
                        // 插队分析（正在播的那首）不让。
                        if !priority {
                            wait_if_interactive_yield(&cancel);
                            if cancel.is_cancelled() {
                                break;
                            }
                        }
                        let _permit = (!priority).then(|| ANALYSIS_GATE.acquire());
                        if cancel.is_cancelled() {
                            break;
                        }
                        let Ok(Some(track)) = state.library.get(track_id) else {
                            continue;
                        };
                        let path = std::path::PathBuf::from(&track.path);
                        let result = analyze_file(&path, duration_limit);
                        let saved = match target {
                            AnalysisWriteTarget::V1 => {
                                state.library.save_analysis(track_id, &result)
                            }
                            AnalysisWriteTarget::BpmKeyV2 => {
                                state.library.save_bpm_key_analysis_v2(track_id, &result)
                            }
                        };
                        if let Err(err) = saved {
                            tracing::warn!("保存分析结果失败 {track_id}：{err:#}");
                            continue;
                        }
                        if target == AnalysisWriteTarget::V1 && write_tags {
                            if kdj_providers::tags::write_analysis_tags(
                                &path,
                                result.bpm,
                                &result.camelot,
                                &result.key,
                                result.energy,
                                // 备注是用户自己的话，comment 的组法在 tags 层：
                                // "8A - Energy 7 - 备注"，备注必须原样保留在最后
                                &track.comment,
                            )
                            .is_ok()
                            {
                                // 标签写入会改变 mtime；先同步曲库快照，后面的波形缓存
                                // 才会用最终时间戳命名，拖到 OneLibrary 时可以直接复用。
                                let _ = state.library.sync_file_stat(track_id);
                            }
                        }
                        // 固定单 worker 预热默认波形。必须排在标签写入之后，否则缓存
                        // 会绑定旧 mtime，下一步便携导出就找不到刚分析好的波形。
                        if target == AnalysisWriteTarget::V1 {
                            state.waveforms.enqueue_default(
                                track_id,
                                path.clone(),
                                state.config.data_dir.join("waveform"),
                                false,
                            );
                        }
                        updated.lock().unwrap().push(track_id);

                        let current = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                        hub.publish(
                            "analyze.progress",
                            &json!({
                                "job_id": job, "done": current, "total": total,
                                "current": track.filename, "track_id": track_id,
                                "version": if target == AnalysisWriteTarget::V1 {
                                    "v1"
                                } else {
                                    "v2"
                                }
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
        let version = if target == AnalysisWriteTarget::V1 {
            "v1"
        } else {
            "v2"
        };
        tracing::info!("分析批次 {job}（{version}）结束：{} 首", ids.len());
    });
    job_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maintenance_jobs_are_singleflight_per_kind() {
        let registry = MaintenanceRegistry::default();
        assert_eq!(
            registry.claim_folder("folder-a".into()),
            ("folder-a".into(), true)
        );
        assert_eq!(
            registry.claim_folder("folder-b".into()),
            ("folder-a".into(), false)
        );
        assert_eq!(
            registry.claim_waveform("wave-a".into()),
            ("wave-a".into(), true)
        );
        registry.finish_folder("wrong-id");
        assert_eq!(
            registry.claim_folder("folder-c".into()),
            ("folder-a".into(), false)
        );
        registry.finish_folder("folder-a");
        assert_eq!(
            registry.claim_folder("folder-c".into()),
            ("folder-c".into(), true)
        );
    }

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

        assert!(
            peak.load(Ordering::SeqCst) <= 2,
            "峰值 {}",
            peak.load(Ordering::SeqCst)
        );
        // 全部归还之后额度要回到满值，不然闸门会越用越窄
        assert_eq!(*gate.permits.lock().unwrap(), 2);
    }
}
