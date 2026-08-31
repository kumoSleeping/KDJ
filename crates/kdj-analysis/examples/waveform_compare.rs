//! Offline A/B extractor for the waveform reconstruction experiment.
//!
//! This is an example target only. It does not participate in the Tauri application, waveform
//! cache, wire format, or frontend renderer. The current KDJ functions are called unchanged for
//! the baseline; the candidate implementation lives under `tools/waveform-lab` until approved.

#[path = "../../../tools/waveform-lab/algorithm.rs"]
mod algorithm;

use std::env;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use algorithm::{analyze_contour, ContourProfile, ContourWaveform};
use anyhow::{bail, Context, Result};
use kdj_analysis::decode::{decode_audio_native, resample_mono};
use kdj_analysis::waveform::{
    band_waveform, detail_waveform_buckets, release_overview_waveform, RELEASE_OVERVIEW_SR,
};
use kdj_core::models::Waveform;
use serde::Serialize;

const RELEASE_OVERVIEW_BUCKETS: usize = 4_096;
/// Match the real Performance rail rather than the research package's magnified 10-second crop.
const DETAIL_WINDOW_SECONDS: f64 = 30.0;

#[derive(Debug)]
struct Options {
    random_dir: PathBuf,
    output: PathBuf,
    count: usize,
    seed: u64,
    explicit_tracks: Vec<PathBuf>,
}

#[derive(Debug, Serialize)]
struct ComparisonPayload {
    schema: &'static str,
    generated_at_epoch_ms: u128,
    random_seed: u64,
    source_directory: String,
    candidate_contract: CandidateContract,
    tracks: Vec<TrackPayload>,
}

#[derive(Debug, Serialize)]
struct CandidateContract {
    integrated_into_app: bool,
    profiles_preserved: [&'static str; 2],
    geometry: &'static str,
    colour: &'static str,
    colour_evidence: &'static str,
}

#[derive(Debug, Serialize)]
struct TrackPayload {
    index: usize,
    path: String,
    display_name: String,
    duration: f64,
    sample_rate: u32,
    source_channels: usize,
    detail_window: DetailWindow,
    current: CurrentProfiles,
    candidate: CandidateProfiles,
    metrics: TrackMetrics,
}

#[derive(Debug, Serialize)]
struct DetailWindow {
    start_seconds: f64,
    end_seconds: f64,
    selection: &'static str,
}

#[derive(Debug, Serialize)]
struct CurrentProfiles {
    release_overview: Waveform,
    performance_detail: Waveform,
}

#[derive(Debug, Serialize)]
struct CandidateProfiles {
    release_overview: ContourWaveform,
    performance_detail: ContourWaveform,
}

#[derive(Debug, Serialize)]
struct TrackMetrics {
    current_detail_height_roughness: f64,
    candidate_detail_upper_roughness: f64,
    candidate_detail_lower_roughness: f64,
    current_detail_colour_variation: f64,
    candidate_detail_colour_variation: f64,
}

fn main() -> Result<()> {
    let options = parse_options()?;
    let selected = if options.explicit_tracks.is_empty() {
        choose_random_tracks(&options.random_dir, options.count, options.seed)?
    } else {
        options.explicit_tracks.clone()
    };
    if selected.len() < 2 {
        bail!("需要至少两首可解码歌曲，实际找到 {} 首", selected.len());
    }

    let mut tracks = Vec::with_capacity(selected.len());
    for (index, path) in selected.iter().enumerate() {
        eprintln!(
            "[{}/{}] decoding {}",
            index + 1,
            selected.len(),
            path.display()
        );
        tracks.push(analyze_track(index + 1, path)?);
    }

    if let Some(parent) = options.output.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建输出目录失败：{}", parent.display()))?;
    }
    let generated_at_epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let payload = ComparisonPayload {
        schema: "kdj-waveform-comparison-v1",
        generated_at_epoch_ms,
        random_seed: options.seed,
        source_directory: options.random_dir.to_string_lossy().into_owned(),
        candidate_contract: CandidateContract {
            integrated_into_app: false,
            profiles_preserved: ["release-overview", "performance-detail"],
            geometry: "signed min/max continuous contour; profile-specific peak/RMS envelope",
            colour: "current KDJ RGB analysis and display palettes; candidate detail/overview both use colour gamma 2.4",
            colour_evidence: "detail reuses band_waveform at gamma 2.4; overview remaps release_overview_waveform from gamma 6.0 to 2.4 without changing its spectral bands",
        },
        tracks,
    };
    let file = File::create(&options.output)
        .with_context(|| format!("创建输出失败：{}", options.output.display()))?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, &payload).context("序列化波形实验数据失败")?;
    writer.flush()?;

    println!("seed={}", options.seed);
    for track in &payload.tracks {
        println!(
            "track_{}={} detail={:.3}-{:.3}s",
            track.index,
            track.path,
            track.detail_window.start_seconds,
            track.detail_window.end_seconds
        );
    }
    println!("analysis={}", options.output.display());
    Ok(())
}

fn analyze_track(index: usize, path: &Path) -> Result<TrackPayload> {
    let decoded = decode_audio_native(path, None)
        .with_context(|| format!("解码真实歌曲失败：{}", path.display()))?;
    let duration = decoded
        .duration
        .unwrap_or(decoded.samples.len() as f64 / f64::from(decoded.sample_rate).max(1.0));
    let detail_buckets = detail_waveform_buckets(duration);

    // Baseline: call the exact current KDJ analysis paths. No candidate code is shared here.
    let current_detail = band_waveform(
        &decoded.samples,
        f64::from(decoded.sample_rate),
        detail_buckets,
    );
    let release_samples = if decoded.sample_rate == RELEASE_OVERVIEW_SR {
        decoded.samples.clone()
    } else {
        resample_mono(&decoded.samples, decoded.sample_rate, RELEASE_OVERVIEW_SR)
    };
    let current_release = fit_release_overview_columns(
        release_overview_waveform(
            &release_samples,
            f64::from(RELEASE_OVERVIEW_SR),
            RELEASE_OVERVIEW_BUCKETS,
        ),
        RELEASE_OVERVIEW_BUCKETS,
    );

    // Candidate: same two profile names and column budgets, independent data/geometry.
    let mut candidate_detail = analyze_contour(
        &decoded.samples,
        f64::from(decoded.sample_rate),
        detail_buckets,
        ContourProfile::Detail,
    );
    let mut candidate_release = analyze_contour(
        &decoded.samples,
        f64::from(decoded.sample_rate),
        RELEASE_OVERVIEW_BUCKETS,
        ContourProfile::Overview,
    );
    // v6 keeps the proven per-profile colour analysis. Detail stays at gamma 2.4; overview changes
    // only the existing release colour exponent from 6.0 to 2.4 before the same display palette.
    inherit_current_rgb(&mut candidate_detail, &current_detail);
    inherit_current_rgb(&mut candidate_release, &current_release);
    remap_release_colour_gamma(&mut candidate_release, 6.0, 2.4, 0.12);
    let (detail_start, detail_end) = choose_detail_window(&candidate_detail, duration);

    let metrics = TrackMetrics {
        current_detail_height_roughness: second_difference_roughness(
            &current_detail
                .amp
                .iter()
                .map(|value| f64::from(*value))
                .collect::<Vec<_>>(),
        ),
        candidate_detail_upper_roughness: second_difference_roughness(
            &candidate_detail
                .maximum
                .iter()
                .map(|value| f64::from(*value))
                .collect::<Vec<_>>(),
        ),
        candidate_detail_lower_roughness: second_difference_roughness(
            &candidate_detail
                .minimum
                .iter()
                .map(|value| -f64::from(*value))
                .collect::<Vec<_>>(),
        ),
        current_detail_colour_variation: colour_variation(
            &current_detail.r,
            &current_detail.g,
            &current_detail.b,
        ),
        candidate_detail_colour_variation: colour_variation(
            &candidate_detail.r,
            &candidate_detail.g,
            &candidate_detail.b,
        ),
    };

    Ok(TrackPayload {
        index,
        path: path.to_string_lossy().into_owned(),
        display_name: path
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        duration: (duration * 1000.0).round() / 1000.0,
        sample_rate: decoded.sample_rate,
        source_channels: decoded.channels,
        detail_window: DetailWindow {
            start_seconds: (detail_start * 1000.0).round() / 1000.0,
            end_seconds: (detail_end * 1000.0).round() / 1000.0,
            selection: "highest combined transient/energy contrast inside the central 90%",
        },
        current: CurrentProfiles {
            release_overview: current_release,
            performance_detail: current_detail,
        },
        candidate: CandidateProfiles {
            release_overview: candidate_release,
            performance_detail: candidate_detail,
        },
        metrics,
    })
}

fn inherit_current_rgb(candidate: &mut ContourWaveform, current: &Waveform) {
    let count = candidate.amp.len();
    candidate.r = resample_u8(&current.r, count);
    candidate.g = resample_u8(&current.g, count);
    candidate.b = resample_u8(&current.b, count);
}

fn remap_release_colour_gamma(
    candidate: &mut ContourWaveform,
    source_gamma: f64,
    target_gamma: f64,
    colour_floor: f64,
) {
    let exponent = target_gamma / source_gamma;
    for channel in [&mut candidate.r, &mut candidate.g, &mut candidate.b] {
        for value in channel.iter_mut() {
            let lifted = f64::from(*value) / 255.0;
            let normalized = ((lifted - colour_floor) / (1.0 - colour_floor)).clamp(0.0, 1.0);
            let remapped = colour_floor + (1.0 - colour_floor) * normalized.powf(exponent);
            *value = (remapped * 255.0).round() as u8;
        }
    }
}

fn resample_u8(source: &[u8], count: usize) -> Vec<u8> {
    if source.is_empty() || count == 0 {
        return vec![0; count];
    }
    if source.len() == count {
        return source.to_vec();
    }
    if source.len() == 1 || count == 1 {
        return vec![source[0]; count];
    }
    (0..count)
        .map(|index| {
            let position = index as f64 * (source.len() - 1) as f64 / (count - 1) as f64;
            let left = position.floor() as usize;
            let right = position.ceil().min((source.len() - 1) as f64) as usize;
            let mix = position - left as f64;
            (f64::from(source[left]) + (f64::from(source[right]) - f64::from(source[left])) * mix)
                .round() as u8
        })
        .collect()
}

fn parse_options() -> Result<Options> {
    let mut random_dir = PathBuf::from("/Users/kumo/Music/test");
    let mut output = PathBuf::from("artifacts/waveform-comparison/analysis.json");
    let mut count = 2usize;
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let mut explicit_tracks = Vec::new();
    let args: Vec<String> = env::args().skip(1).collect();
    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--random-dir" => {
                index += 1;
                random_dir = PathBuf::from(args.get(index).context("--random-dir 缺少路径")?);
            }
            "--output" => {
                index += 1;
                output = PathBuf::from(args.get(index).context("--output 缺少路径")?);
            }
            "--count" => {
                index += 1;
                count = args
                    .get(index)
                    .context("--count 缺少数量")?
                    .parse::<usize>()
                    .context("--count 不是有效整数")?
                    .max(2);
            }
            "--seed" => {
                index += 1;
                seed = args
                    .get(index)
                    .context("--seed 缺少数值")?
                    .parse::<u64>()
                    .context("--seed 不是有效整数")?;
            }
            "--track" => {
                index += 1;
                explicit_tracks.push(PathBuf::from(args.get(index).context("--track 缺少路径")?));
            }
            "--help" | "-h" => {
                println!(
                    "waveform_compare [--random-dir DIR] [--output FILE] [--count 2] [--seed N] [--track FILE --track FILE]"
                );
                std::process::exit(0);
            }
            unknown => bail!("未知参数：{unknown}"),
        }
        index += 1;
    }
    Ok(Options {
        random_dir,
        output,
        count: explicit_tracks.len().max(count),
        seed,
        explicit_tracks,
    })
}

fn choose_random_tracks(directory: &Path, count: usize, seed: u64) -> Result<Vec<PathBuf>> {
    let mut candidates = Vec::new();
    collect_audio_files(directory, &mut candidates)?;
    candidates.sort();
    if candidates.len() < count {
        bail!(
            "{} 中只有 {} 首可用音频，少于请求的 {} 首",
            directory.display(),
            candidates.len(),
            count
        );
    }
    let mut rng = XorShift64::new(seed);
    for cursor in (1..candidates.len()).rev() {
        let swap = rng.next_usize(cursor + 1);
        candidates.swap(cursor, swap);
    }
    candidates.truncate(count);
    Ok(candidates)
}

fn collect_audio_files(directory: &Path, output: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory)
        .with_context(|| format!("读取歌曲目录失败：{}", directory.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_audio_files(&path, output)?;
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            extension.as_str(),
            "mp3" | "flac" | "wav" | "m4a" | "aac" | "ogg"
        ) {
            output.push(path);
        }
    }
    Ok(())
}

fn choose_detail_window(wave: &ContourWaveform, duration: f64) -> (f64, f64) {
    if duration <= DETAIL_WINDOW_SECONDS || wave.amp.is_empty() {
        return (0.0, duration.max(0.0));
    }
    let count = wave.amp.len();
    let window = ((DETAIL_WINDOW_SECONDS / duration) * count as f64)
        .round()
        .clamp(1.0, count as f64) as usize;
    let search_start = ((duration * 0.05 / duration) * count as f64).round() as usize;
    let search_end = ((duration * 0.95 / duration) * count as f64).round() as usize;
    let mut prefix = vec![0.0f64; count + 1];
    for index in 0..count {
        let amplitude = f64::from(wave.amp[index]);
        let onset = f64::from(wave.transient[index]) / 255.0;
        let local_change = if index > 0 {
            (amplitude - f64::from(wave.amp[index - 1])).abs()
        } else {
            0.0
        };
        prefix[index + 1] = prefix[index] + amplitude * 0.36 + onset * 0.44 + local_change * 1.2;
    }
    let mut best_start = search_start.min(count.saturating_sub(window));
    let mut best_score = f64::NEG_INFINITY;
    let last_start = search_end
        .saturating_sub(window)
        .min(count.saturating_sub(window));
    for start in best_start..=last_start {
        let score = (prefix[start + window] - prefix[start]) / window as f64;
        if score > best_score {
            best_score = score;
            best_start = start;
        }
    }
    let start_seconds = best_start as f64 / count as f64 * duration;
    (
        start_seconds,
        (start_seconds + DETAIL_WINDOW_SECONDS).min(duration),
    )
}

fn second_difference_roughness(values: &[f64]) -> f64 {
    if values.len() < 3 {
        return 0.0;
    }
    values
        .windows(3)
        .map(|window| (window[2] - 2.0 * window[1] + window[0]).abs())
        .sum::<f64>()
        / (values.len() - 2) as f64
}

fn colour_variation(r: &[u8], g: &[u8], b: &[u8]) -> f64 {
    let count = r.len().min(g.len()).min(b.len());
    if count < 2 {
        return 0.0;
    }
    let total = (1..count)
        .map(|index| {
            let dr = f64::from(r[index]) - f64::from(r[index - 1]);
            let dg = f64::from(g[index]) - f64::from(g[index - 1]);
            let db = f64::from(b[index]) - f64::from(b[index - 1]);
            (dr * dr + dg * dg + db * db).sqrt() / (255.0 * 3.0f64.sqrt())
        })
        .sum::<f64>();
    total / (count - 1) as f64
}

fn fit_release_overview_columns(wave: Waveform, columns: usize) -> Waveform {
    let source_len = wave.amp.len();
    if source_len == columns
        || source_len == 0
        || wave.r.len() != source_len
        || wave.g.len() != source_len
        || wave.b.len() != source_len
    {
        return wave;
    }
    let mut amp = Vec::with_capacity(columns);
    let mut red = Vec::with_capacity(columns);
    let mut green = Vec::with_capacity(columns);
    let mut blue = Vec::with_capacity(columns);
    for target in 0..columns {
        let start = target as f64 * source_len as f64 / columns as f64;
        let end = (target + 1) as f64 * source_len as f64 / columns as f64;
        let first = start.floor() as usize;
        let last = (end.ceil() as usize).min(source_len);
        let mut peak = 0.0f32;
        let mut r = 0.0f64;
        let mut g = 0.0f64;
        let mut b = 0.0f64;
        let mut total_weight = 0.0f64;
        for source in first..last {
            let overlap = (end.min((source + 1) as f64) - start.max(source as f64)).max(0.0);
            if overlap <= 0.0 {
                continue;
            }
            let value = wave.amp[source].clamp(0.0, 1.0);
            peak = peak.max(value);
            let weight = overlap * (f64::from(value) + 0.001);
            r += f64::from(wave.r[source]) * weight;
            g += f64::from(wave.g[source]) * weight;
            b += f64::from(wave.b[source]) * weight;
            total_weight += weight;
        }
        let fallback = first.min(source_len - 1);
        amp.push(peak);
        red.push(if total_weight > 0.0 {
            (r / total_weight).round() as u8
        } else {
            wave.r[fallback]
        });
        green.push(if total_weight > 0.0 {
            (g / total_weight).round() as u8
        } else {
            wave.g[fallback]
        });
        blue.push(if total_weight > 0.0 {
            (b / total_weight).round() as u8
        } else {
            wave.b[fallback]
        });
    }
    Waveform {
        track_id: wave.track_id,
        duration: wave.duration,
        amp,
        r: red,
        g: green,
        b: blue,
        ..Default::default()
    }
}

struct XorShift64(u64);

impl XorShift64 {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    fn next(&mut self) -> u64 {
        let mut value = self.0;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.0 = value;
        value
    }

    fn next_usize(&mut self, upper_exclusive: usize) -> usize {
        (self.next() as usize) % upper_exclusive.max(1)
    }
}
