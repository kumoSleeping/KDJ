//! One recognition worker and one playback clock. Follow a verified local match;
//! search on a miss and publish the first verified rescue immediately. No second
//! acceptance gate, confirmation history, or periodic tempo audit.
use super::{
    clock_ms,
    diagnostics::{InputState, Level, ListenerState, ListenerStatus, ScanResult, Stage},
    document::Set,
    index::{self, PreparedSet},
    now_ms, LiveVj, Match, View,
};
use anyhow::{bail, Result};
use kdj_analysis::alignment::{
    LiveAlignment, LiveFeatures, LiveHint, FEATURE_MEMORY_BUDGET,
};
use std::{
    collections::VecDeque,
    fs,
    io::BufReader,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub(super) fn publish(app: &AppHandle, id: &str, edit: impl FnOnce(&mut View)) {
    app.state::<LiveVj>().update(id, edit);
}
pub(super) fn log(app: &AppHandle, session: &str, level: Level, stage: Stage, message: String) {
    app.state::<LiveVj>().log(session, level, stage, message);
}
struct FeatureCache(VecDeque<(PathBuf, Arc<LiveFeatures>)>);
impl FeatureCache {
    fn get(&mut self, path: &Path) -> Result<Arc<LiveFeatures>> {
        if let Some(i) = self.0.iter().position(|(p, _)| p == path) {
            let pair = self.0.remove(i).unwrap();
            let value = pair.1.clone();
            self.0.push_back(pair);
            return Ok(value);
        }
        let value = Arc::new(LiveFeatures::read_from(BufReader::new(fs::File::open(
            path,
        )?))?);
        while self.0.iter().map(|(_, f)| f.memory_bytes()).sum::<usize>() + value.memory_bytes()
            > FEATURE_MEMORY_BUDGET
        {
            if self.0.pop_front().is_none() {
                break;
            }
        }
        self.0.push_back((path.to_owned(), value.clone()));
        Ok(value)
    }
}
#[derive(Clone, Copy)]
struct Evidence {
    target: usize,
    recording: usize,
    position: f64,
    at: Instant,
    rate: f64,
    score: f64,
    margin: f64,
}
impl Evidence {
    fn now(&self) -> f64 {
        self.position + self.at.elapsed().as_secs_f64() * self.rate
    }
    fn same_position(&self, other: &Self) -> bool {
        self.recording == other.recording && (self.now() - other.now()).abs() < 0.15
    }
    fn discontinuity(&self, other: &Self) -> bool {
        // Keep sub-2.5s corrections on the visible decoder's live rate plan.
        // Acoustic agreement remains stricter; it must not define presentation cuts.
        self.recording != other.recording || (self.now() - other.now()).abs() >= 2.5
    }
    fn agrees(&self, other: &Self) -> bool {
        self.same_position(other) && (self.rate - other.rate).abs() < 0.06
    }
}
/// Tempo is a slope across observations, not the noisy slope of one second.
/// Never turn every acoustic grid refinement into a playbackRate write.
struct ClockEstimate {
    points: VecDeque<Evidence>,
    rate: f64,
    updated: Instant,
}
impl ClockEstimate {
    fn new(found: Evidence) -> Self {
        Self {
            points: VecDeque::new(),
            rate: (found.rate * 200.).round() / 200.,
            updated: found.at,
        }
    }
    fn observe(&mut self, found: Evidence) -> (f64, f64, f64) {
        if self.points.back().is_some_and(|old| !found.agrees(old)) {
            *self = Self::new(found);
        }
        self.points.push_back(found);
        while self.points.len() > 32
            || self
                .points
                .front()
                .is_some_and(|p| found.at.saturating_duration_since(p.at).as_secs_f64() > 3.)
        {
            self.points.pop_front();
        }
        let first = self.points.front().unwrap();
        let span = found.at.saturating_duration_since(first.at).as_secs_f64();
        if span < 1. || self.points.len() < 5 {
            return (found.position, self.rate, 0.);
        }
        let n = self.points.len() as f64;
        let mx = self
            .points
            .iter()
            .map(|p| p.at.saturating_duration_since(first.at).as_secs_f64())
            .sum::<f64>()
            / n;
        let my = self.points.iter().map(|p| p.position).sum::<f64>() / n;
        let mut xx = 0.;
        let mut xy = 0.;
        for p in &self.points {
            let x = p.at.saturating_duration_since(first.at).as_secs_f64() - mx;
            xx += x * x;
            xy += x * (p.position - my);
        }
        let slope = xy / xx.max(1e-9);
        let residual = (self
            .points
            .iter()
            .map(|p| {
                let x = p.at.saturating_duration_since(first.at).as_secs_f64();
                (p.position - my - slope * (x - mx)).powi(2)
            })
            .sum::<f64>()
            / n)
            .sqrt();
        if !(0.80..=1.25).contains(&slope) || residual > 0.04 {
            return (found.position, self.rate, 0.);
        }
        if found
            .at
            .saturating_duration_since(self.updated)
            .as_secs_f64()
            >= 0.5
            && (slope - self.rate).abs() >= 0.003
        {
            self.rate = (slope * 500.).round() / 500.;
            self.updated = found.at;
        }
        (
            my + slope * (span - mx),
            self.rate,
            (1. - residual / 0.04) * (span / 2.).min(1.),
        )
    }
}
fn record(
    set: &PreparedSet,
    target: usize,
    query: &LiveFeatures,
    at: Instant,
    result: &LiveAlignment,
    elapsed_ms: f64,
    scanned: &mut Vec<ScanResult>,
) -> Option<Evidence> {
    let block = &set.targets[target];
    let recording = &set.recordings[block.recording];
    tracing::debug!(target: "kdj_live_vj_probe", target, block_start = block.start,
        query_ms = query.duration_ms(), capture_clock_ms = clock_ms() - at.elapsed().as_secs_f64() * 1000.,
        offset = result.offset_seconds, rate = result.rate, score = result.score,
        weakest = result.weakest_score, runner_up = result.runner_up, support = result.retrieval_score,
        matched = result.matched, supported = result.supported, elapsed_ms, "verification");
    scanned.push(ScanResult {
        entry_id: recording.entry.id.clone(),
        title: recording.entry.title.clone(),
        block_start: block.start,
        elapsed_ms,
        matched: result.matched || result.supported,
        reason: format!(
            "{} · 位置 {:.3} s · 得分 {:.3} / 最弱窗 {:.3} / 次选 {:.3} · {:.3}×",
            if result.matched || result.supported {
                "定位通过"
            } else {
                &result.reason
            },
            block.start
                + recording.entry.audio_offset
                + LiveFeatures::origin_seconds()
                + result.offset_seconds
                + query.duration_ms() / 1000. * result.rate,
            result.score,
            result.weakest_score,
            result.runner_up,
            result.rate
        ),
    });
    // The acoustic matcher is the sole acceptance authority. A supported
    // short-window result is usable now, not a request for another confirmation.
    (result.matched || result.supported).then_some(Evidence {
        target,
        recording: block.recording,
        position: block.start
            + recording.entry.audio_offset
            + LiveFeatures::origin_seconds()
            + result.offset_seconds
            + query.duration_ms() / 1000. * result.rate,
        at,
        rate: result.rate,
        score: result.score,
        margin: result.score - result.runner_up,
    })
}
fn presentation(
    set: &PreparedSet,
    found: Evidence,
    rate_confidence: f64,
    lock_revision: u64,
) -> Match {
    let age = found.at.elapsed().as_secs_f64() * 1000.;
    Match {
        entry: set.recordings[found.recording].entry.clone(),
        position: found.position,
        observed_at_ms: now_ms() - age,
        clock_at_ms: clock_ms() - age,
        rate: found.rate,
        confidence: found.score,
        margin: found.margin,
        rate_confidence,
        lock_revision,
    }
}
pub fn run(
    app: AppHandle,
    session: String,
    set: Set,
    cache: PathBuf,
    cancel: Arc<AtomicBool>,
    prepare_only: bool,
    input: super::audio_input::Selection,
) {
    kdj_core::thread_qos::prefer_background();
    let result = (|| -> Result<()> {
        publish(&app, &session, |v| {
            let preparing = ListenerStatus {
                state: ListenerState::Preparing,
                ..Default::default()
            };
            v.rescue = Some(preparing.clone());
            v.tracking = Some(preparing);
        });
        let ready = index::prepare(&app, &session, &set, &cache, &cancel)?;
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        if prepare_only {
            publish(&app, &session, |v| v.phase = "prepared".into());
            return Ok(());
        }
        run_inner(&app, &session, &ready, &cancel, &input)
    })();
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    if let Err(error) = result {
        log(
            &app,
            &session,
            Level::Error,
            Stage::Session,
            format!("会话失败：{error:#}"),
        );
        publish(&app, &session, |v| {
            v.phase = "failed".into();
            v.error = format!("{error:#}");
            v.scanning = None;
        });
    }
}
fn run_inner(app: &AppHandle, session: &str, set: &PreparedSet, cancel: &AtomicBool, input: &super::audio_input::Selection) -> Result<()> {
    {
        if set.recordings.is_empty() {
            bail!("Set 没有素材")
        }
        kdj_core::thread_qos::prefer_live_audio();
        publish(app, session, |v| v.phase = "permission".into());
        let mut source = super::feature_input::Input::start(app, input)?;
        publish(app, session, |v| v.phase = "listening".into());
        log(
            app,
            session,
            Level::Info,
            Stage::Input,
            "声音输入已启动 · 短窗地标检索 / 增量特征 / 音频包时间戳".into(),
        );
        log(
            app,
            session,
            Level::Info,
            Stage::Scan,
            "监听就绪 · 550 ms 音频窗 / 命中即切 / 失锁时逐档检索".into(),
        );
        let mut generation = 0;
        let mut input_epoch = 0;
        let mut features = FeatureCache(VecDeque::new());
        let mut current: Option<Evidence> = None;
        let mut estimate: Option<ClockEstimate> = None;
        let mut lost = false;
        let mut scan = 0;
        // Resume the remaining tempo bins on fresh audio instead of blocking
        // one observation behind an exhaustive 19-rate search.
        let mut search_cursor = 0;
        let mut last_input_state = None;
        let mut lock_revision = 0;
        let mut rescue_status = ListenerStatus::default();
        let mut tracking_status = ListenerStatus::default();
        let mut source_checked = Instant::now();
        let mut last_rejection: Option<Instant> = None;
        let (mut last_notice, mut notices): (Option<Instant>, u32) = (None, 0);
        while !cancel.load(Ordering::Relaxed) {
            let tick = Instant::now();
            let polled = source.poll(cancel)?;
            let epoch = polled.epoch;
            if input_epoch != epoch {
                input_epoch = epoch; current = None; estimate = None; lost = false;
                generation = 0; search_cursor = 0; last_rejection = None;
            }
            if let Some(notice) = polled.notice {
                // At most one warning every 5 s so a flaky driver cannot flush the bounded
                // log; the gap counter keeps the exact total.
                notices += 1;
                if last_notice.is_none_or(|at| at.elapsed() >= Duration::from_secs(5)) {
                    let message = if notices > 1 { format!("{notice}（自上条记录起共 {notices} 次）") } else { notice };
                    log(app, session, Level::Warn, Stage::Input, message);
                    (last_notice, notices) = (Some(Instant::now()), 0);
                }
            }
            let feature_ms = polled.feature_ms;
            let packet = polled.observation;
            publish(app, session, |v| v.bluetooth = polled.bluetooth);
            let input = polled.status.unwrap_or_else(|| super::diagnostics::InputStatus {
                state: InputState::Waiting, source: "蓝牙".into(), sample_rate: 8000,
                channels: vec![], rms_dbfs: None, peak_dbfs: None, buffered_seconds: 0.,
                packet_age_ms: None, packets: 0, gaps: 0,
            });
            if last_input_state != Some(input.state) {
                log(
                    app,
                    session,
                    Level::Info,
                    Stage::Input,
                    format!(
                        "系统音频 · RMS {:.1} dBFS · 包 {} · 包龄 {:.1} ms · 断流 {} 次",
                        input.rms_dbfs.unwrap_or(-120.),
                        input.packets,
                        input.packet_age_ms.unwrap_or(0.),
                        input.gaps
                    ),
                );
                last_input_state = Some(input.state);
            }
            let audible = !matches!(
                input.state,
                InputState::Quiet | InputState::Stalled | InputState::Waiting
            );
            if !audible {
                let state = match input.state {
                    InputState::Stalled => ListenerState::Interrupted,
                    InputState::Waiting => ListenerState::Waiting,
                    _ => ListenerState::Quiet,
                };
                rescue_status.state = state;
                tracking_status.state = state;
            }
            publish(app, session, |v| {
                v.input = Some(input);
                v.rescue = Some(rescue_status.clone());
                v.tracking = Some(tracking_status.clone());
            });
            if current.is_some_and(|c| c.at.elapsed().as_secs_f64() > 2.) && !lost {
                lost = true;
                publish(app, session, |v| v.phase = "searching".into());
            }
            if source_checked.elapsed().as_secs() >= 5 {
                for r in &set.recordings {
                    if index::signature(Path::new(&r.entry.path))? != r.signature {
                        bail!("素材已变化，请重新预处理：{}", r.entry.title)
                    }
                }
                source_checked = Instant::now();
            }
            if let Some(observation) = packet {
                let next_generation = observation.generation;
                if next_generation != generation {
                    if next_generation & (1 << 63) != 0 { current = None; }
                    estimate = None;
                    lost = current.is_some();
                    generation = next_generation;
                    search_cursor = 0;
                    app.state::<LiveVj>()
                        .present(app, session, |v| v.candidate = None);
                }
                if audible {
                    let query = observation.query;
                    let at = observation.at;
                    let mut scanned = Vec::new();
                    let mut retrieval_ms = 0.;
                    let mut verify_ms = 0.;
                    let mut local = None;
                    let trackable = current.filter(|c| c.at.elapsed().as_secs_f64() < 2.);
                    if let Some(old) = trackable {
                        tracking_status.state = ListenerState::Verifying;
                        tracking_status.target =
                            Some(set.recordings[old.recording].entry.title.clone());
                        publish(app, session, |v| v.tracking = Some(tracking_status.clone()));
                        let block = &set.targets[old.target];
                        let predicted = old.position
                            + at.saturating_duration_since(old.at).as_secs_f64() * old.rate;
                        let started = Instant::now();
                        let reference = features.get(&block.path)?;
                        let result = kdj_analysis::alignment::track_live_prepared(
                            &query,
                            &reference,
                            LiveHint {
                                offset_seconds: predicted
                                    - query.duration_ms() / 1000. * old.rate
                                    - block.start
                                    - set.recordings[old.recording].entry.audio_offset
                                    - LiveFeatures::origin_seconds(),
                                rate: old.rate,
                            },
                            &|| cancel.load(Ordering::Relaxed),
                        )?;
                        verify_ms += started.elapsed().as_secs_f64() * 1000.;
                        local = record(
                            set,
                            old.target,
                            &query,
                            at,
                            &result,
                            verify_ms,
                            &mut scanned,
                        );
                    }
                    let tracking = local.is_some();
                    tracking_status = ListenerStatus {
                        state: if tracking {
                            ListenerState::Tracking
                        } else {
                            ListenerState::Searching
                        },
                        target: trackable.map(|c| set.recordings[c.recording].entry.title.clone()),
                        runs: tracking_status.runs + u64::from(trackable.is_some()),
                        elapsed_ms: verify_ms,
                        query_seconds: query.duration_ms() / 1000.,
                        position: local.map(|c| c.position),
                        rate: current.map(|c| c.rate),
                        error_ms: local
                            .zip(current)
                            .map(|(new, old)| (new.now() - old.now()) * 1000.),
                    };
                    scanned.clear();
                    let mut rescued = None;
                    let rescue_ran = !tracking;
                    if tracking {
                        search_cursor = 0;
                    }
                    if rescue_ran {
                        rescue_status.state = ListenerState::Retrieving;
                        rescue_status.target = None;
                        publish(app, session, |v| {
                            v.tracking = Some(tracking_status.clone());
                            v.rescue = Some(rescue_status.clone());
                        });
                        if !tracking && current.is_some() && !lost {
                            log(
                                app,
                                session,
                                Level::Info,
                                Stage::Decision,
                                "局部证据不足；救场复核，保留当前画面".into(),
                            );
                        }
                        // Known tempo first, then nearby bins, then the rest of
                        // 0.80–1.25×. Verify after EACH bin and stop on the first
                        // accepted result. Yield between bins after 125 ms so
                        // the next attempt uses fresh audio, not an old query.
                        let preferred = current.map_or(1., |c| c.rate);
                        let mut rates: [f64; 19] = std::array::from_fn(|i| 0.80 + i as f64 * 0.025);
                        rates.sort_by(|a, b| {
                            (a - preferred).abs().total_cmp(&(b - preferred).abs())
                        });
                        let search_started = Instant::now();
                        'search: for (step, rate) in std::iter::once(preferred)
                            .chain(rates)
                            .enumerate()
                            .skip(search_cursor)
                        {
                            search_cursor = step + 1;
                            if step > 0 && (rate - preferred).abs() < 0.001 {
                                continue;
                            }
                            let started = Instant::now();
                            let seeds = {
                                let mut index = set.index.lock().unwrap();
                                let canceled = || cancel.load(Ordering::Relaxed);
                                index.search_slice_at_rate(&query, rate, &canceled)?
                            };
                            retrieval_ms += started.elapsed().as_secs_f64() * 1000.;
                            tracing::debug!(target: "kdj_live_vj_probe", scan = scan + 1,
                            query_ms = query.duration_ms(), preferred = rate, seed_count = seeds.len(),
                            leading = ?seeds.first(), retrieval_ms, "retrieval");
                            let mut targets = Vec::new();
                            for seed in &seeds {
                                if !targets.contains(&seed.target) {
                                    targets.push(seed.target);
                                }
                            }
                            // Visit retrieved blocks in rank order; a verified
                            // match ends this rescue without checking more rivals.
                            for target in targets {
                                if cancel.load(Ordering::Relaxed) {
                                    return Ok(());
                                }
                                rescue_status.state = ListenerState::Verifying;
                                rescue_status.target = Some(
                                    set.recordings[set.targets[target].recording]
                                        .entry
                                        .title
                                        .clone(),
                                );
                                publish(app, session, |v| v.rescue = Some(rescue_status.clone()));
                                let selected: Vec<_> = seeds
                                    .iter()
                                    .filter(|s| s.target == target)
                                    .copied()
                                    .collect();
                                let started = Instant::now();
                                let reference = features.get(&set.targets[target].path)?;
                                let result = kdj_analysis::alignment::verify_live_prepared(
                                    &query,
                                    &reference,
                                    &selected,
                                    &|| cancel.load(Ordering::Relaxed),
                                )?;
                                let ms = started.elapsed().as_secs_f64() * 1000.;
                                verify_ms += ms;
                                rescued =
                                    record(set, target, &query, at, &result, ms, &mut scanned);
                                if rescued.is_some() {
                                    break 'search;
                                }
                            }
                            if search_started.elapsed() >= Duration::from_millis(125) {
                                break;
                            }
                        }
                    }
                    if rescued.is_some() || search_cursor >= 20 {
                        search_cursor = 0;
                    }
                    if rescue_ran
                        && rescued.is_none()
                        && !tracking
                        && last_rejection.is_none_or(|t| t.elapsed().as_secs_f64() >= 1.)
                    {
                        let reason = scanned
                            .first()
                            .map_or_else(|| "未召回地标候选".into(), |r| r.reason.clone());
                        log(app, session, Level::Info, Stage::Scan, format!(
                            "本轮未识别：{reason} · 查询 {:.0} ms / 检索 {:.1} ms / 校验 {:.1} ms / 证据龄 {:.1} ms",
                            query.duration_ms(), retrieval_ms, verify_ms, at.elapsed().as_secs_f64() * 1000.
                        ));
                        last_rejection = Some(Instant::now());
                    }
                    if rescue_ran {
                        rescue_status = ListenerStatus {
                            state: if rescued.is_some() {
                                ListenerState::Locked
                            } else {
                                ListenerState::Searching
                            },
                            target: rescued
                                .map(|c| set.recordings[c.recording].entry.title.clone()),
                            runs: rescue_status.runs + 1,
                            elapsed_ms: retrieval_ms + verify_ms - tracking_status.elapsed_ms,
                            query_seconds: query.duration_ms() / 1000.,
                            position: rescued.map(|c| c.position),
                            rate: rescued.map(|c| c.rate),
                            error_ms: None,
                        };
                    }
                    // Exactly one accepted observation updates the playback clock.
                    let chosen = local.or(rescued);
                    if let Some(mut chosen) = chosen {
                        let jumped = current.is_none_or(|old| chosen.discontinuity(&old));
                        if jumped {
                            lock_revision += 1;
                            estimate = Some(ClockEstimate::new(chosen));
                            tracking_status.state = ListenerState::Waiting;
                            tracking_status.position = None;
                            tracking_status.error_ms = None;
                        }
                        let clock = estimate.get_or_insert_with(|| ClockEstimate::new(chosen));
                        let old_rate = clock.rate;
                        let (position, rate, rate_confidence) = clock.observe(chosen);
                        chosen.position = position;
                        chosen.rate = rate;
                        tracking_status.rate = Some(rate);
                        if jumped || lost {
                            log(
                                app,
                                session,
                                Level::Info,
                                Stage::Decision,
                                format!(
                                    "救场定位：{} · {:.3} 秒 · {:.3}× · 本轮 {:.2} ms",
                                    set.recordings[chosen.recording].entry.title,
                                    chosen.now(),
                                    rate,
                                    tick.elapsed().as_secs_f64() * 1000.
                                ),
                            );
                        } else if (old_rate - rate).abs() >= 0.01 && rate_confidence >= 0.7 {
                            log(
                                app,
                                session,
                                Level::Info,
                                Stage::Decision,
                                format!("持续漂移 · 基准速度估计 {:.3}× → {:.3}×", old_rate, rate),
                            );
                        }
                        current = Some(chosen);
                        lost = false;
                        app.state::<LiveVj>().present(app, session, |v| {
                            if v.presentation_epoch != epoch { return; }
                            v.phase = "matched".into();
                            if jumped {
                                v.output = None;
                            }
                            v.candidate = None;
                            v.matched =
                                Some(presentation(set, chosen, rate_confidence, lock_revision));
                        });
                    } else {
                        lost = current.is_some();
                        app.state::<LiveVj>().present(app, session, |v| {
                            if v.presentation_epoch != epoch { return; }
                            v.candidate = None;
                            if lost {
                                v.phase = "searching".into();
                            }
                        });
                    }
                    scan += 1;
                    let elapsed = tick.elapsed().as_secs_f64() * 1000.;
                    tracing::debug!(target: "kdj_live_vj_probe", scan, tracking, accepted = current.is_some_and(|c| c.at == at),
                        rescue_ran, lock_revision, query_ms = query.duration_ms(), feature_ms, retrieval_ms, verify_ms, round_ms = elapsed,
                        data_age_ms = at.elapsed().as_secs_f64() * 1000., capture_clock_ms = clock_ms() - at.elapsed().as_secs_f64() * 1000.,
                        position = current.map(|c| c.position), rate = current.map(|c| c.rate), "round");

                    publish(app, session, |v| {
                        v.scan = scan;
                        v.scan_ms = elapsed;
                        if rescue_ran {
                            v.scanned = scanned;
                        }
                        v.rescue = Some(rescue_status.clone());
                        v.tracking = Some(tracking_status.clone());
                        v.scanning = None;
                        v.priority = current
                            .map(|c| vec![set.recordings[c.recording].entry.id.clone()])
                            .unwrap_or_default();
                    });
                }
            }
            // Capture never waits for recognition; no backlog of obsolete queries.
            let until = tick + Duration::from_millis(125);
            while Instant::now() < until && !cancel.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        Ok(())
    }
}
