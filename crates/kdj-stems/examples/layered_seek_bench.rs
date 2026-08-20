//! Product-path HS-TasNet admission/preload probe.
//!
//! This intentionally measures the one admitted instant lane. The second Deck must be rejected by
//! admission and use the dry/refinement bridge; running two sustained HS sessions would repeat the
//! already-established M2 overload rather than validate the production scheduler.

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use kdj_stems::seeklab::hstasnet_model_dir;
use kdj_stems::{try_acquire_instant_admission, InstantStemPool, INSTANT_HOP_FRAMES, SAMPLE_RATE};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    track: String,
    model: String,
    pcm_preload_ms: f64,
    workers_ready_ms: f64,
    second_deck_rejected: bool,
    first_hop_ms: f64,
    mean_hop_ms: f64,
    p95_hop_ms: f64,
    max_hop_ms: f64,
    deadline_misses: usize,
    hop_budget_ms: f64,
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let track = PathBuf::from(
        args.next()
            .context("usage: layered_seek_bench <track> [model-dir]")?,
    );
    let model = args
        .next()
        .map(PathBuf::from)
        .or_else(hstasnet_model_dir)
        .context("HS-TasNet model directory is unavailable")?;
    let pool = InstantStemPool::new(&model)?;

    let preload_started = Instant::now();
    let preparation = pool.prepare_track(&track)?;
    let prepared = preparation.wait(|| false)?;
    let pcm_preload_ms = preload_started.elapsed().as_secs_f64() * 1_000.0;

    let ready_started = Instant::now();
    pool.wait_ready(0, || false)?;
    pool.wait_ready(1, || false)?;
    let workers_ready_ms = ready_started.elapsed().as_secs_f64() * 1_000.0;

    let admission = try_acquire_instant_admission(0).context("Deck A admission unavailable")?;
    let second_deck_rejected = try_acquire_instant_admission(1).is_none();
    let epoch = Arc::new(AtomicU64::new(1));
    let start_frame = (30.0 * f64::from(SAMPLE_RATE)).round() as u64;
    let mut timings = Vec::with_capacity(100);
    for hop in 0..100u64 {
        let started = Instant::now();
        let ticket = pool.submit(
            0,
            Arc::clone(&prepared),
            start_frame + hop * INSTANT_HOP_FRAMES as u64,
            Arc::clone(&epoch),
            1,
        )?;
        loop {
            if ticket.try_wait()?.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_micros(100));
        }
        timings.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    drop(admission);

    let mut sorted = timings.clone();
    sorted.sort_by(f64::total_cmp);
    let budget = INSTANT_HOP_FRAMES as f64 / f64::from(SAMPLE_RATE) * 1_000.0;
    let output = Output {
        track: track.display().to_string(),
        model: model.display().to_string(),
        pcm_preload_ms,
        workers_ready_ms,
        second_deck_rejected,
        first_hop_ms: timings[0],
        mean_hop_ms: timings.iter().sum::<f64>() / timings.len() as f64,
        p95_hop_ms: sorted[((sorted.len() - 1) as f64 * 0.95).round() as usize],
        max_hop_ms: *sorted.last().unwrap_or(&0.0),
        deadline_misses: timings.iter().filter(|elapsed| **elapsed > budget).count(),
        hop_budget_ms: budget,
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}
