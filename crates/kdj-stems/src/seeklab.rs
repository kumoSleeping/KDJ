//! SeekLab —— 随机跳转 Stem 实验（类 Neural Mix 调度架构研究，仅限本地实验）。
//!
//! 验证链路：音频文件 → PCM 随机读取 → 可变上下文窗口 → 模型推理 → Stem 输出。
//! 两级模型：
//! - HS-TasNet（StemgenRT 导出的流式波形模型，动态窗口）承担"跳转后即时输出"层；
//! - Spleeter4 FP16（固定 11.96s 大窗 U-Net）承担"后台完整上下文精修"层与质量基准。
//!
//! 调度思想来自 Algoriddim 专利 US10887033B1（部分填充缓冲即时分解、随后质量递增）
//! 与 US11740862B1（中间数据/缓存加速），仅用于理解，不作商业发布。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::audio::StereoRegionDecoder;
use crate::dsp::{
    pack_spleeter_input, unpack_spleeter_output, MODEL_INPUT_ELEMENTS, MODEL_OUTPUT_ELEMENTS,
    SPLEETER_BINS, SPLEETER_FRAMES,
};
use crate::model::FOUR_MODEL_FILES;
use crate::{SAMPLE_RATE, SEGMENT_CONTEXT_SAMPLES, SEGMENT_CORE_SAMPLES, SEGMENT_SAMPLES};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
use ort::{session::Session, value::Tensor};

pub const LAB_LANES: [&str; 4] = ["drums", "bass", "other", "vocals"];
/// HS-TasNet 流式块：每次输出 512 个新采样（≈11.61ms），两侧各 1024 采样上下文。
pub const HSTASNET_HOP: usize = 512;
pub const HSTASNET_CONTEXT: usize = 1_024;
pub const HSTASNET_STEP: usize = HSTASNET_CONTEXT + HSTASNET_HOP + HSTASNET_CONTEXT;
/// StemgenRT 插件的输入归一化目标（-12 dB RMS），与其 Constants.h 一致。
const HSTASNET_TARGET_RMS: f32 = 0.251;
const HSTASNET_MAX_GAIN: f32 = 100.0;
const HSTASNET_MIN_RMS: f32 = 0.000_251;
/// StemgenRT Constants.h 声明的模型输出平面顺序：0=drums 1=bass 2=vocals 3=other。
/// 校准阶段会与 Spleeter4 基准做 SNR 匹配验证；不一致时以实测为准并写入报告。
const HSTASNET_PRIOR_MAPPING: [usize; 4] = [0, 1, 3, 2];
/// FP16 U-Net 热图溢出时的降增益重试序列（与生产 onnx.rs 相同策略）。
const FP16_RETRY_GAINS: [f32; 3] = [1.0, 0.25, 0.0625];

const SNR_EPSILON: f64 = 1e-12;

/// HS-TasNet（StemgenRT 导出模型，1D 卷积 + LSTM、动态输入长度）在 ORT 1.22 CoreML EP
/// 上创建 session 时直接段错误（macOS 26.5 实测），与 StemgenRT 作者“该模型不适合 GPU”
/// 的说明一致。因此本实验强制 HS-TasNet 走 CPU，CoreML 崩溃作为结论记录。
pub const HSTASNET_COREML_STATUS: &str =
    "coreml-ep-segfault-at-session-creation (ort 1.22, macOS 26.5); forced to CPU";

fn hstasnet_backend(backend: LabBackend) -> LabBackend {
    let _ = backend;
    LabBackend::Cpu
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum LabBackend {
    Cpu,
    CoreMlGpu,
    CoreMlAll,
}

impl LabBackend {
    pub fn label(self) -> &'static str {
        match self {
            Self::Cpu => "onnxruntime-cpu",
            Self::CoreMlGpu => "coreml-cpu+gpu",
            Self::CoreMlAll => "coreml-all(ane)",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabModelInfo {
    pub id: &'static str,
    pub role: &'static str,
    pub path: Option<String>,
    pub ready: bool,
    pub note: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabCatalog {
    pub sample_rate: u32,
    pub spleeter_tile_seconds: f64,
    pub spleeter_core_seconds: f64,
    pub hstasnet_hop_ms: f64,
    pub hstasnet: LabModelInfo,
    pub spleeter4: LabModelInfo,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct SeekTrialOptions {
    /// 即时层重复次数（取 min/mean）。
    pub instant_repeats: Option<usize>,
    /// 流式跟随步数（每步 512 新采样）。
    pub stream_steps: Option<usize>,
    /// HS-TasNet 过去上下文扫描（采样）。
    pub hstasnet_contexts: Option<Vec<usize>>,
    /// Spleeter4 过去上下文扫描（采样）。
    pub spleeter_contexts: Option<Vec<usize>>,
    /// 收集试听音频（original / instant / refined，裁剪到 core 区域）。
    pub collect_audio: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabStageReport {
    pub stage: String,
    pub model: String,
    pub backend: String,
    pub context_seconds: f64,
    pub wall_ms: f64,
    pub wall_mean_ms: f64,
    pub wall_p95_ms: Option<f64>,
    pub audio_seconds: f64,
    pub rtf: f64,
    pub cpu_ratio: f64,
    pub first_output_ms: Option<f64>,
    pub snr_db: Option<[f64; 4]>,
    pub snr_reference: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabSchedule {
    pub first_output_ms: f64,
    /// 本会话首个 Spleeter tile 的耗时（含冷启动尾项）。
    pub first_tile_wall_ms: f64,
    pub stream_hop_ms: f64,
    pub stream_step_mean_ms: f64,
    pub stream_step_p95_ms: f64,
    pub refined_tile_wall_ms: f64,
    pub refined_core_seconds: f64,
    /// 精修结果落地时，core 区域还剩多少毫秒未被播放到（正值=可干净替换）。
    pub replace_margin_ms: f64,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekTrialReport {
    pub source: String,
    pub seek_seconds: f64,
    pub backend: String,
    pub stem_mapping: [usize; 4],
    pub mapping_confidence_db: [f64; 4],
    pub stages: Vec<LabStageReport>,
    pub schedule: LabSchedule,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabAudio {
    pub seconds: f64,
    pub original: Vec<[f32; 2]>,
    pub instant: [Vec<[f32; 2]>; 4],
    pub refined: [Vec<[f32; 2]>; 4],
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekTrialOutcome {
    pub report: SeekTrialReport,
    pub audio: Option<LabAudio>,
}

/// 解码后的整轨 PCM（44.1kHz 立体声），供多次随机跳转复用。
pub struct LabPcm {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl LabPcm {
    pub fn decode(source: &Path) -> Result<Self> {
        let mut decoder = StereoRegionDecoder::open(source)?;
        let decoded = decoder.read_samples(None)?;
        let frames = decoded.left.len().min(decoded.right.len());
        Ok(Self {
            left: decoded.left[..frames].to_vec(),
            right: decoded.right[..frames].to_vec(),
        })
    }

    pub fn frames(&self) -> usize {
        self.left.len().min(self.right.len())
    }

    pub fn duration_seconds(&self) -> f64 {
        self.frames() as f64 / SAMPLE_RATE as f64
    }

    /// 取 [start, start+frames) 区间；越界补零（专利中的"参考数据/静音填充"）。
    fn window(&self, start: isize, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut left = vec![0.0f32; frames];
        let mut right = vec![0.0f32; frames];
        for index in 0..frames {
            let position = start + index as isize;
            if position >= 0 && (position as usize) < self.frames() {
                left[index] = self.left[position as usize];
                right[index] = self.right[position as usize];
            }
        }
        (left, right)
    }
}

/// 单个 backend 下两个模型的 session 集合（懒加载，跨多次跳转复用）。
pub struct SeekLab {
    backend: LabBackend,
    spleeter_dir: PathBuf,
    hstasnet_dir: PathBuf,
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
    spleeter: Option<Vec<Session>>,
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
    hstasnet: Option<Session>,
}

impl SeekLab {
    pub fn new(backend: LabBackend, spleeter_dir: &Path, hstasnet_dir: &Path) -> Self {
        Self {
            backend,
            spleeter_dir: spleeter_dir.to_path_buf(),
            hstasnet_dir: hstasnet_dir.to_path_buf(),
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
            spleeter: None,
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
            hstasnet: None,
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
    fn spleeter_sessions(&mut self) -> Result<&mut Vec<Session>> {
        if self.spleeter.is_none() {
            let mut sessions = Vec::with_capacity(FOUR_MODEL_FILES.len());
            for file in FOUR_MODEL_FILES {
                let path = self.spleeter_dir.join(file.filename);
                if !path.is_file() {
                    bail!("Spleeter4 模型文件不存在：{}", path.display());
                }
                sessions.push(build_session(&path, self.backend, true).with_context(|| {
                    format!("加载 Spleeter4 {} ({})", file.stem, self.backend.label())
                })?);
            }
            // 预热，避免首个 tile 计入初始化成本。
            let warm = vec![0.0f32; MODEL_INPUT_ELEMENTS];
            let mut engine = SpleeterRun {
                sessions: &mut sessions,
            };
            let _ = engine.run_tile(&warm)?;
            self.spleeter = Some(sessions);
        }
        Ok(self.spleeter.as_mut().expect("spleeter sessions loaded"))
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
    fn hstasnet_session(&mut self) -> Result<&mut Session> {
        if self.hstasnet.is_none() {
            let path = self.hstasnet_dir.join("model.onnx");
            if !path.is_file() {
                bail!("HS-TasNet (StemgenRT) 模型不存在：{}", path.display());
            }
            let backend = hstasnet_backend(self.backend);
            let mut session = build_session(&path, backend, false)
                .with_context(|| format!("加载 HS-TasNet ({})", backend.label()))?;
            let _ = hstasnet_infer(
                &mut session,
                &[0.0f32; HSTASNET_STEP],
                &[0.0f32; HSTASNET_STEP],
            )?;
            self.hstasnet = Some(session);
        }
        Ok(self.hstasnet.as_mut().expect("hstasnet session loaded"))
    }

    /// 执行一次完整的随机跳转实验。
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
    pub fn run_trial(
        &mut self,
        pcm: &LabPcm,
        seek_frame: usize,
        options: &SeekTrialOptions,
    ) -> Result<SeekTrialOutcome> {
        let instant_repeats = options.instant_repeats.unwrap_or(5).max(1);
        let stream_steps = options.stream_steps.unwrap_or(32).max(1);
        let hstasnet_contexts = options
            .hstasnet_contexts
            .clone()
            .unwrap_or_else(|| vec![0, 22_050, 88_200, 529_200]);
        let spleeter_contexts = options
            .spleeter_contexts
            .clone()
            .unwrap_or_else(|| vec![0, 22_050, 88_200, SEGMENT_CONTEXT_SAMPLES]);
        let seek_seconds = seek_frame as f64 / SAMPLE_RATE as f64;
        let backend = self.backend.label().to_string();
        let hstasnet_backend = hstasnet_backend(self.backend);
        let hstasnet_label = if hstasnet_backend == self.backend {
            backend.clone()
        } else {
            format!(
                "{} (HS-TasNet 强制CPU: CoreML崩溃)",
                hstasnet_backend.label()
            )
        };
        let mut stages = Vec::new();

        // ---- 基准层：Spleeter4 完整上下文（"最终质量"参考） ----
        let mut spleeter_walls: Vec<Duration> = Vec::new();
        let (reference, _ref_wall) = {
            let tile = build_spleeter_tile(pcm, seek_frame, SEGMENT_CONTEXT_SAMPLES);
            let meter = CpuMeter::start();
            let stems = self.spleeter_separate(&tile.0, &tile.1)?;
            let (wall, cpu) = meter.finish();
            spleeter_walls.push(wall);
            stages.push(stage_report(
                "reference",
                "spleeter4-fp16",
                &backend,
                SEGMENT_CONTEXT_SAMPLES as f64 / SAMPLE_RATE as f64,
                &[wall],
                SEGMENT_CORE_SAMPLES as f64 / SAMPLE_RATE as f64,
                cpu,
                None,
                None,
                None,
            ));
            (stems, wall)
        };
        let reference_core = extract_core(&reference, SEGMENT_CONTEXT_SAMPLES);

        // ---- Spleeter4 上下文扫描：质量随上下文收敛的曲线 ----
        for &past in &spleeter_contexts {
            if past == SEGMENT_CONTEXT_SAMPLES {
                continue; // 完整上下文就是基准本身
            }
            let tile = build_spleeter_tile(pcm, seek_frame, past);
            let meter = CpuMeter::start();
            let stems = self.spleeter_separate(&tile.0, &tile.1)?;
            let (wall, cpu) = meter.finish();
            spleeter_walls.push(wall);
            let core = extract_core(&stems, SEGMENT_CONTEXT_SAMPLES);
            let snr = snr_per_stem(&reference_core, &core);
            stages.push(stage_report(
                "spleeter-context",
                "spleeter4-fp16",
                &backend,
                past as f64 / SAMPLE_RATE as f64,
                &[wall],
                SEGMENT_CORE_SAMPLES as f64 / SAMPLE_RATE as f64,
                cpu,
                None,
                Some(snr),
                Some("spleeter4-full".into()),
            ));
        }

        // ---- 即时层：HS-TasNet 最小窗口（跳转后第一次可听输出） ----
        let mut instant_walls = Vec::with_capacity(instant_repeats);
        let mut instant_cpu = 0.0f64;
        for _ in 0..instant_repeats {
            let (left, right) = pcm.window(
                seek_frame as isize - HSTASNET_CONTEXT as isize,
                HSTASNET_STEP,
            );
            let meter = CpuMeter::start();
            let _ = self.hstasnet_separate(&left, &right)?;
            let (wall, cpu) = meter.finish();
            instant_walls.push(wall);
            instant_cpu = cpu;
        }
        let first_output_ms = instant_walls
            .iter()
            .map(Duration::as_secs_f64)
            .fold(f64::INFINITY, f64::min)
            * 1_000.0;
        stages.push(stage_report(
            "instant",
            "hs-tasnet-stemgenrt",
            &hstasnet_label,
            HSTASNET_CONTEXT as f64 / SAMPLE_RATE as f64,
            &instant_walls,
            HSTASNET_STEP as f64 / SAMPLE_RATE as f64,
            instant_cpu,
            Some(first_output_ms),
            None,
            None,
        ));

        // ---- 流式跟随：HS-TasNet 512 采样步进持续推理（播放跟随能力） ----
        let mut stream_walls = Vec::with_capacity(stream_steps);
        let mut stream_cpu = 0.0f64;
        for step in 0..stream_steps {
            let chunk_start = seek_frame + step * HSTASNET_HOP;
            let (left, right) = pcm.window(
                chunk_start as isize - HSTASNET_CONTEXT as isize,
                HSTASNET_STEP,
            );
            let meter = CpuMeter::start();
            let _ = self.hstasnet_separate(&left, &right)?;
            let (wall, cpu) = meter.finish();
            stream_walls.push(wall);
            stream_cpu = cpu;
        }
        stages.push(stage_report(
            "stream",
            "hs-tasnet-stemgenrt",
            &hstasnet_label,
            HSTASNET_CONTEXT as f64 / SAMPLE_RATE as f64,
            &stream_walls,
            HSTASNET_HOP as f64 / SAMPLE_RATE as f64,
            stream_cpu,
            None,
            None,
            None,
        ));

        // ---- HS-TasNet 窗口扫描：上下文 → 延迟/质量曲线 ----
        let mut window_outputs: Vec<(usize, [Vec<[f32; 2]>; 4])> = Vec::new();
        for &past in &hstasnet_contexts {
            let future = SEGMENT_CORE_SAMPLES + HSTASNET_HOP;
            let frames = past + future;
            let (left, right) = pcm.window(seek_frame as isize - past as isize, frames);
            let meter = CpuMeter::start();
            let separated = self.hstasnet_separate(&left, &right)?;
            let (wall, cpu) = meter.finish();
            let core = extract_core(&separated, past);
            window_outputs.push((past, core.clone()));
            let snr = snr_per_stem(&reference_core, &core);
            stages.push(stage_report(
                "hstasnet-window",
                "hs-tasnet-stemgenrt",
                &hstasnet_label,
                past as f64 / SAMPLE_RATE as f64,
                &[wall],
                SEGMENT_CORE_SAMPLES as f64 / SAMPLE_RATE as f64,
                cpu,
                None,
                Some(snr),
                Some("spleeter4-full".into()),
            ));
        }

        // 自我收敛：各窗口 vs 最大窗口输出（模型自身质量上限）。
        if let Some((_, largest)) = window_outputs.last() {
            let largest = largest.clone();
            for (past, core) in &window_outputs[..window_outputs.len().saturating_sub(1)] {
                let snr = snr_per_stem(&largest, core);
                stages.push(stage_report(
                    "hstasnet-self",
                    "hs-tasnet-stemgenrt",
                    &hstasnet_label,
                    *past as f64 / SAMPLE_RATE as f64,
                    &[Duration::ZERO],
                    SEGMENT_CORE_SAMPLES as f64 / SAMPLE_RATE as f64,
                    0.0,
                    None,
                    Some(snr),
                    Some("hstasnet-largest".into()),
                ));
            }
        }

        // ---- 输出平面 → KDJ lane 映射校准（用 0.5s 或最小非零窗口输出） ----
        let calibrate_index = window_outputs
            .iter()
            .position(|(past, _)| *past >= 22_050)
            .unwrap_or(0);
        let (mapping, mapping_confidence) =
            calibrate_mapping(&reference_core, &window_outputs[calibrate_index].1);

        // ---- 调度结论：类 Neural Mix 时间线 ----
        // 首个 tile 含会话首次真实推理的初始化尾项；稳态成本取所有同形状 tile 的最小值。
        let first_tile_wall_ms = spleeter_walls
            .first()
            .map(Duration::as_secs_f64)
            .unwrap_or(0.0)
            * 1_000.0;
        let refined_wall_ms = spleeter_walls
            .iter()
            .map(Duration::as_secs_f64)
            .fold(f64::INFINITY, f64::min)
            * 1_000.0;
        let stream_mean = mean_secs(&stream_walls) * 1_000.0;
        let stream_p95 = percentile_secs(&stream_walls, 0.95) * 1_000.0;
        let core_seconds = SEGMENT_CORE_SAMPLES as f64 / SAMPLE_RATE as f64;
        let replace_margin_ms = first_output_ms + core_seconds * 1_000.0 - refined_wall_ms;
        let mut notes = Vec::new();
        let hop_ms = HSTASNET_HOP as f64 / SAMPLE_RATE as f64 * 1_000.0;
        if stream_p95 <= hop_ms {
            notes.push(format!(
                "流式跟随可行：p95 {stream_p95:.2}ms ≤ hop {hop_ms:.2}ms"
            ));
        } else {
            notes.push(format!(
                "流式跟随吃紧：p95 {stream_p95:.2}ms > hop {hop_ms:.2}ms，需降载或更大缓冲"
            ));
        }
        if replace_margin_ms > 0.0 {
            notes.push(format!(
                "精修 tile 在 core 播完前 {:.0}ms 落地，可无感替换未播放部分",
                replace_margin_ms
            ));
        } else {
            notes.push(format!(
                "精修 tile 落地时已越过 core 末尾 {:.0}ms，只能替换部分未来区域",
                -replace_margin_ms
            ));
        }

        let audio = options.collect_audio.then(|| {
            let instant_source = window_outputs
                .iter()
                .find(|(past, _)| *past >= 22_050)
                .map(|(_, core)| core.clone())
                .unwrap_or_else(|| window_outputs[0].1.clone());
            let mut original = vec![[0.0f32; 2]; SEGMENT_CORE_SAMPLES];
            for (index, frame) in original.iter_mut().enumerate() {
                let position = seek_frame + index;
                if position < pcm.frames() {
                    *frame = [pcm.left[position], pcm.right[position]];
                }
            }
            LabAudio {
                seconds: core_seconds,
                original,
                instant: remap_stems(instant_source, mapping),
                refined: reference_core.clone(),
            }
        });

        Ok(SeekTrialOutcome {
            report: SeekTrialReport {
                source: String::new(),
                seek_seconds,
                backend,
                stem_mapping: mapping,
                mapping_confidence_db: mapping_confidence,
                stages,
                schedule: LabSchedule {
                    first_output_ms,
                    first_tile_wall_ms,
                    stream_hop_ms: hop_ms,
                    stream_step_mean_ms: stream_mean,
                    stream_step_p95_ms: stream_p95,
                    refined_tile_wall_ms: refined_wall_ms,
                    refined_core_seconds: core_seconds,
                    replace_margin_ms,
                    notes,
                },
            },
            audio,
        })
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
    fn spleeter_separate(&mut self, left: &[f32], right: &[f32]) -> Result<[Vec<[f32; 2]>; 4]> {
        let packed = pack_spleeter_input(left, right)?;
        let sessions = self.spleeter_sessions()?;
        let mut run = SpleeterRun { sessions };
        let output = run.run_tile(&packed.values)?;
        unpack_spleeter_output(&output, &packed)
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
    fn hstasnet_separate(&mut self, left: &[f32], right: &[f32]) -> Result<[Vec<[f32; 2]>; 4]> {
        if left.len() != right.len() {
            bail!("HS-TasNet 输入左右声道长度不一致");
        }
        let session = self.hstasnet_session()?;
        hstasnet_infer(session, left, right)
    }
}

/// Spleeter4 一组 session 的顺序执行（4 个独立 U-Net，FP16 溢出重试）。
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
struct SpleeterRun<'a> {
    sessions: &'a mut Vec<Session>,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
impl SpleeterRun<'_> {
    fn run_tile(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        for (attempt, gain) in FP16_RETRY_GAINS.iter().copied().enumerate() {
            let attempt_input: Vec<f32> = if gain == 1.0 {
                input.to_vec()
            } else {
                input.iter().map(|value| value * gain).collect()
            };
            let mut combined = vec![0.0f32; MODEL_OUTPUT_ELEMENTS];
            let mut failed = false;
            for (slot, session) in self.sessions.iter_mut().enumerate() {
                let tensor = ort_result(
                    Tensor::from_array((
                        [2_usize, 1, SPLEETER_FRAMES, SPLEETER_BINS],
                        attempt_input.clone(),
                    )),
                    "创建 Spleeter 输入 tensor",
                )?;
                let outputs = ort_result(
                    session.run(ort::inputs!["x" => tensor]),
                    "ONNX Runtime 执行 Spleeter",
                )?;
                let output = outputs
                    .get("y")
                    .or_else(|| (outputs.len() > 0).then(|| &outputs[0]))
                    .context("Spleeter 缺少 y 输出")?;
                let (shape, data) = ort_result(
                    output.try_extract_tensor::<f32>(),
                    "读取 Spleeter 输出 tensor",
                )?;
                let expected = [2_i64, 1, SPLEETER_FRAMES as i64, SPLEETER_BINS as i64];
                if &**shape != expected.as_slice() || data.len() != MODEL_INPUT_ELEMENTS {
                    bail!(
                        "Spleeter 输出 shape {:?} 不符合契约 {:?}",
                        &**shape,
                        expected
                    );
                }
                if data.iter().any(|value| !value.is_finite()) {
                    failed = true;
                    break;
                }
                combined[slot * MODEL_INPUT_ELEMENTS..(slot + 1) * MODEL_INPUT_ELEMENTS]
                    .copy_from_slice(data);
            }
            if !failed {
                if attempt > 0 {
                    tracing::warn!(
                        attempt = attempt + 1,
                        gain,
                        "SeekLab Spleeter FP16 重试成功"
                    );
                }
                return Ok(combined);
            }
        }
        bail!(
            "Spleeter 输出含非有限数值（已重试 {} 次）",
            FP16_RETRY_GAINS.len()
        )
    }
}

/// HS-TasNet（StemgenRT 导出）单次推理：波形进波形出，输入长度按 512 对齐。
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
fn hstasnet_infer(
    session: &mut Session,
    left: &[f32],
    right: &[f32],
) -> Result<[Vec<[f32; 2]>; 4]> {
    let frames = left.len();
    let padded = frames.div_ceil(HSTASNET_HOP) * HSTASNET_HOP;
    let mut input = vec![0.0f32; padded * 2];
    input[..frames].copy_from_slice(left);
    input[padded..padded + frames].copy_from_slice(right);
    // StemgenRT 输入归一化：目标 -12dB RMS，限制最大增益，输出按比例还原。
    let rms = (input[..frames]
        .iter()
        .chain(&input[padded..padded + frames])
        .map(|value| value * value)
        .sum::<f32>()
        / (frames.max(1) * 2) as f32)
        .sqrt();
    let gain = if rms >= HSTASNET_MIN_RMS {
        (HSTASNET_TARGET_RMS / rms).min(HSTASNET_MAX_GAIN)
    } else {
        1.0
    };
    if gain != 1.0 {
        for value in &mut input {
            *value *= gain;
        }
    }
    let tensor = ort_result(
        Tensor::from_array(([1_usize, 2, padded], input)),
        "创建 HS-TasNet 输入 tensor",
    )?;
    let outputs = ort_result(
        session.run(ort::inputs!["audio" => tensor]),
        "ONNX Runtime 执行 HS-TasNet",
    )?;
    let output = outputs
        .get("separated")
        .or_else(|| (outputs.len() > 0).then(|| &outputs[0]))
        .context("HS-TasNet 缺少 separated 输出")?;
    let (shape, data) = ort_result(
        output.try_extract_tensor::<f32>(),
        "读取 HS-TasNet 输出 tensor",
    )?;
    if shape.len() != 4 || shape[0] != 1 || shape[1] != 4 || shape[2] != 2 {
        bail!("HS-TasNet 输出 shape {:?} 不符合 [1,4,2,M]", &**shape);
    }
    let out_frames = shape[3] as usize;
    if data.iter().any(|value| !value.is_finite()) {
        bail!("HS-TasNet 输出含非有限数值");
    }
    let usable = out_frames.min(frames);
    let mut stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|_| vec![[0.0, 0.0]; usable]);
    let inv_gain = if gain != 0.0 { 1.0 / gain } else { 1.0 };
    for stem in 0..4 {
        for channel in 0..2 {
            let plane = (stem * 2 + channel) * out_frames;
            for index in 0..usable {
                stems[stem][index][channel] = data[plane + index] * inv_gain;
            }
        }
    }
    Ok(stems)
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
fn build_session(path: &Path, backend: LabBackend, static_shapes: bool) -> Result<Session> {
    let builder = ort_result(Session::builder(), "创建 session builder")?;
    let mut builder = match backend {
        LabBackend::Cpu => ort_result(
            builder.with_intra_threads(cpu_threads()),
            "配置 CPU intra-op 线程",
        )
        .and_then(|builder| ort_result(builder.with_inter_threads(1), "配置 CPU inter-op 线程"))?,
        #[cfg(target_os = "macos")]
        LabBackend::CoreMlGpu | LabBackend::CoreMlAll => {
            let units = if backend == LabBackend::CoreMlGpu {
                ort::ep::coreml::ComputeUnits::CPUAndGPU
            } else {
                ort::ep::coreml::ComputeUnits::All
            };
            let provider = ort::ep::CoreML::default()
                .with_static_input_shapes(static_shapes)
                .with_compute_units(units)
                .build();
            let builder = ort_result(
                builder.with_execution_providers([provider]),
                "注册 CoreML execution provider",
            )?;
            ort_result(builder.with_intra_threads(1), "配置 CoreML 线程")?
        }
        #[cfg(not(target_os = "macos"))]
        LabBackend::CoreMlGpu | LabBackend::CoreMlAll => {
            bail!("CoreML backend 仅支持 macOS")
        }
    };
    ort_result(
        builder.commit_from_file(path),
        &format!("加载模型 {}", path.display()),
    )
}

fn cpu_threads() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| (parallelism.get() / 2).clamp(2, 4))
        .unwrap_or(2)
}

fn ort_result<T, E: std::fmt::Display>(
    result: std::result::Result<T, E>,
    action: &str,
) -> Result<T> {
    result.map_err(|error| anyhow::anyhow!("{action}: {error}"))
}

/// 构造一个 Spleeter tile：[前导上下文 | core | 尾部上下文]，前导上下文只保留
/// 末尾 `past_real` 采样的真实音频，更早部分补零（模拟跳转后尚未积累上下文）。
fn build_spleeter_tile(pcm: &LabPcm, seek_frame: usize, past_real: usize) -> (Vec<f32>, Vec<f32>) {
    let tile_start = seek_frame as isize - SEGMENT_CONTEXT_SAMPLES as isize;
    let (mut left, mut right) = pcm.window(tile_start, SEGMENT_SAMPLES);
    let zero_before = SEGMENT_CONTEXT_SAMPLES.saturating_sub(past_real);
    for index in 0..zero_before.min(SEGMENT_SAMPLES) {
        left[index] = 0.0;
        right[index] = 0.0;
    }
    (left, right)
}

fn extract_core(stems: &[Vec<[f32; 2]>; 4], offset: usize) -> [Vec<[f32; 2]>; 4] {
    std::array::from_fn(|stem| {
        let available = stems[stem].len().saturating_sub(offset);
        let take = available.min(SEGMENT_CORE_SAMPLES);
        let mut core = vec![[0.0f32; 2]; take];
        core.copy_from_slice(&stems[stem][offset..offset + take]);
        core
    })
}

fn snr_db(reference: &[Vec<[f32; 2]>], estimate: &[Vec<[f32; 2]>]) -> f64 {
    let mut signal = 0.0f64;
    let mut noise = 0.0f64;
    for (reference, estimate) in reference.iter().zip(estimate.iter()) {
        for (reference, estimate) in reference.iter().zip(estimate.iter()) {
            signal += f64::from(reference[0]) * f64::from(reference[0]);
            signal += f64::from(reference[1]) * f64::from(reference[1]);
            let left = f64::from(estimate[0] - reference[0]);
            let right = f64::from(estimate[1] - reference[1]);
            noise += left * left + right * right;
        }
    }
    10.0 * ((signal + SNR_EPSILON) / (noise + SNR_EPSILON)).log10()
}

fn snr_per_stem(reference: &[Vec<[f32; 2]>; 4], estimate: &[Vec<[f32; 2]>; 4]) -> [f64; 4] {
    std::array::from_fn(|stem| snr_db(&reference[stem..stem + 1], &estimate[stem..stem + 1]))
}

/// 全排列暴力匹配：HS-TasNet 输出平面 → KDJ lane（drums/bass/other/vocals）。
/// 返回 (plane→lane 映射, 每个平面的最佳 SNR)。
fn calibrate_mapping(
    reference: &[Vec<[f32; 2]>; 4],
    estimate: &[Vec<[f32; 2]>; 4],
) -> ([usize; 4], [f64; 4]) {
    let mut matrix = [[0.0f64; 4]; 4];
    for plane in 0..4 {
        for lane in 0..4 {
            matrix[plane][lane] = snr_db(&reference[lane..lane + 1], &estimate[plane..plane + 1]);
        }
    }
    let mut best_mapping = HSTASNET_PRIOR_MAPPING;
    let mut best_score = f64::NEG_INFINITY;
    for permutation in permutations() {
        let score: f64 = (0..4).map(|plane| matrix[plane][permutation[plane]]).sum();
        if score > best_score {
            best_score = score;
            best_mapping = permutation;
        }
    }
    let confidence = std::array::from_fn(|plane| matrix[plane][best_mapping[plane]]);
    (best_mapping, confidence)
}

fn permutations() -> Vec<[usize; 4]> {
    let mut result = Vec::with_capacity(24);
    for a in 0..4 {
        for b in 0..4 {
            if b == a {
                continue;
            }
            for c in 0..4 {
                if c == a || c == b {
                    continue;
                }
                for d in 0..4 {
                    if d == a || d == b || d == c {
                        continue;
                    }
                    result.push([a, b, c, d]);
                }
            }
        }
    }
    result
}

fn remap_stems(stems: [Vec<[f32; 2]>; 4], mapping: [usize; 4]) -> [Vec<[f32; 2]>; 4] {
    let mut remapped: [Vec<[f32; 2]>; 4] = std::array::from_fn(|_| Vec::new());
    for (plane, lane) in mapping.iter().enumerate() {
        remapped[*lane] = stems[plane].clone();
    }
    remapped
}

#[allow(clippy::too_many_arguments)]
fn stage_report(
    stage: &str,
    model: &str,
    backend: &str,
    context_seconds: f64,
    walls: &[Duration],
    audio_seconds: f64,
    cpu_ratio: f64,
    first_output_ms: Option<f64>,
    snr_db: Option<[f64; 4]>,
    snr_reference: Option<String>,
) -> LabStageReport {
    let wall_ms = walls
        .iter()
        .map(Duration::as_secs_f64)
        .fold(f64::INFINITY, f64::min)
        * 1_000.0;
    let wall_mean_ms = mean_secs(walls) * 1_000.0;
    LabStageReport {
        stage: stage.into(),
        model: model.into(),
        backend: backend.into(),
        context_seconds,
        wall_ms,
        wall_mean_ms,
        wall_p95_ms: (walls.len() > 4).then(|| percentile_secs(walls, 0.95) * 1_000.0),
        audio_seconds,
        rtf: if audio_seconds > 0.0 {
            wall_mean_ms / 1_000.0 / audio_seconds
        } else {
            0.0
        },
        cpu_ratio,
        first_output_ms,
        snr_db,
        snr_reference,
    }
}

fn mean_secs(walls: &[Duration]) -> f64 {
    if walls.is_empty() {
        return 0.0;
    }
    walls.iter().map(Duration::as_secs_f64).sum::<f64>() / walls.len() as f64
}

fn percentile_secs(walls: &[Duration], percentile: f64) -> f64 {
    if walls.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f64> = walls.iter().map(Duration::as_secs_f64).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let index = ((sorted.len() - 1) as f64 * percentile).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

struct CpuMeter {
    wall: Instant,
    cpu: Duration,
}

impl CpuMeter {
    fn start() -> Self {
        Self {
            wall: Instant::now(),
            cpu: process_cpu_time(),
        }
    }

    fn finish(self) -> (Duration, f64) {
        let wall = self.wall.elapsed();
        let cpu = process_cpu_time().saturating_sub(self.cpu);
        let ratio = if wall.is_zero() {
            0.0
        } else {
            cpu.as_secs_f64() / wall.as_secs_f64()
        };
        (wall, ratio)
    }
}

#[cfg(unix)]
fn process_cpu_time() -> Duration {
    // SAFETY: getrusage(RUSAGE_SELF) 始终可安全调用，rusage 已零初始化。
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
            return Duration::ZERO;
        }
        Duration::new(
            usage.ru_utime.tv_sec as u64,
            (usage.ru_utime.tv_usec as u32) * 1_000,
        ) + Duration::new(
            usage.ru_stime.tv_sec as u64,
            (usage.ru_stime.tv_usec as u32) * 1_000,
        )
    }
}

#[cfg(not(unix))]
fn process_cpu_time() -> Duration {
    Duration::ZERO
}

// ---------- 诊断探针（example/coreml_probe 使用） ----------

#[doc(hidden)]
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
pub fn probe_build_session(path: &Path, backend: LabBackend, static_shapes: bool) -> Result<()> {
    let mut session = build_session(path, backend, static_shapes)?;
    eprintln!("[probe] session created, running warm inference");
    let file = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if file == "model.onnx" {
        let _ = hstasnet_infer(
            &mut session,
            &[0.0f32; HSTASNET_STEP],
            &[0.0f32; HSTASNET_STEP],
        )?;
    } else {
        let tensor = ort_result(
            Tensor::from_array((
                [2_usize, 1, SPLEETER_FRAMES, SPLEETER_BINS],
                vec![0.0f32; MODEL_INPUT_ELEMENTS],
            )),
            "probe tensor",
        )?;
        let _ = ort_result(session.run(ort::inputs!["x" => tensor]), "probe run")?;
    }
    eprintln!("[probe] warm inference done");
    Ok(())
}

// ---------- 模型目录解析 ----------

pub fn lab_catalog() -> LabCatalog {
    let hstasnet = hstasnet_model_dir();
    let spleeter = spleeter_model_dir();
    LabCatalog {
        sample_rate: SAMPLE_RATE,
        spleeter_tile_seconds: SEGMENT_SAMPLES as f64 / SAMPLE_RATE as f64,
        spleeter_core_seconds: SEGMENT_CORE_SAMPLES as f64 / SAMPLE_RATE as f64,
        hstasnet_hop_ms: HSTASNET_HOP as f64 / SAMPLE_RATE as f64 * 1_000.0,
        hstasnet: LabModelInfo {
            id: "hs-tasnet-stemgenrt",
            role: "即时层（流式波形模型，动态窗口）",
            ready: hstasnet
                .as_ref()
                .map(|dir| dir.join("model.onnx").is_file())
                .unwrap_or(false),
            path: hstasnet.map(|dir| dir.display().to_string()),
            note: format!(
                "StemgenRT 导出的 HS-TasNet 系权重（MIT），512 采样步进；{HSTASNET_COREML_STATUS}"
            ),
        },
        spleeter4: LabModelInfo {
            id: "spleeter4-fp16",
            role: "精修层与质量基准（固定 11.96s 大窗）",
            ready: spleeter
                .as_ref()
                .map(|dir| {
                    FOUR_MODEL_FILES
                        .iter()
                        .all(|file| dir.join(file.filename).is_file())
                })
                .unwrap_or(false),
            path: spleeter.map(|dir| dir.display().to_string()),
            note: "Best-Practice 4×U-Net FP16，生产 Deck 同款".into(),
        },
    }
}

pub fn spleeter_model_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("KDJ_SPLEETER4_MODEL_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    app_data_model_dir("Best-Practice-87c5b6d", "spleeter4-fp16-onnx")
}

pub fn hstasnet_model_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("KDJ_SEEKLAB_HSTASNET_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    app_data_model_dir("eaaba4f", "")
}

#[cfg(target_os = "macos")]
fn app_data_model_dir(version: &str, directory: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let base = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("com.kdj.app")
        .join("data")
        .join("stems")
        .join("models")
        .join(version);
    let candidate = if directory.is_empty() {
        base
    } else {
        base.join(directory)
    };
    candidate.is_dir().then_some(candidate)
}

#[cfg(not(target_os = "macos"))]
fn app_data_model_dir(_version: &str, _directory: &str) -> Option<PathBuf> {
    None
}

// ---------- 试听 WAV（float32 立体声，与 stem-debug 同一格式） ----------

pub fn write_lab_float_wav(path: &Path, frames: &[[f32; 2]]) -> Result<()> {
    use std::io::Write;
    let data_bytes = (frames.len() * 2 * 4) as u32;
    let mut writer = std::io::BufWriter::new(
        std::fs::File::create(path)
            .with_context(|| format!("创建 SeekLab WAV 失败：{}", path.display()))?,
    );
    writer.write_all(b"RIFF")?;
    writer.write_all(&36_u32.saturating_add(data_bytes).to_le_bytes())?;
    writer.write_all(b"WAVEfmt ")?;
    writer.write_all(&16_u32.to_le_bytes())?;
    writer.write_all(&3_u16.to_le_bytes())?; // IEEE float
    writer.write_all(&2_u16.to_le_bytes())?;
    writer.write_all(&SAMPLE_RATE.to_le_bytes())?;
    writer.write_all(&(SAMPLE_RATE * 2 * 4).to_le_bytes())?;
    writer.write_all(&8_u16.to_le_bytes())?;
    writer.write_all(&32_u16.to_le_bytes())?;
    writer.write_all(b"data")?;
    writer.write_all(&data_bytes.to_le_bytes())?;
    for frame in frames {
        writer.write_all(&frame[0].to_le_bytes())?;
        writer.write_all(&frame[1].to_le_bytes())?;
    }
    writer.flush()?;
    Ok(())
}
