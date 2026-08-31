//! Measure the exact local compressed-audio seek used by the six-second Manager waveform.
//!
//! This is deliberately an offline audit executable. It never opens an audio device and cannot
//! enter the application runtime. Pass an audio path and optional source positions in seconds;
//! each run decodes the same fixed twelve-second, 48 kHz stereo scratch window used by a Deck.

use std::env;
use std::path::Path;
use std::time::Instant;

use anyhow::{Context, Result};
use kdj_player::{decode_file_scratch_window, SCRATCH_CACHE_WINDOW_SECONDS};

const OUTPUT_SAMPLE_RATE: u32 = 48_000;

fn main() -> Result<()> {
    let mut arguments = env::args();
    let _program = arguments.next();
    let path = arguments.next().context("缺少音频路径")?;
    let positions = {
        let parsed = arguments
            .map(|value| value.parse::<f64>().context("位置必须是秒数"))
            .collect::<Result<Vec<_>>>()?;
        if parsed.is_empty() {
            vec![0.0, 90.0, 180.0]
        } else {
            parsed
        }
    };
    let frame_limit = OUTPUT_SAMPLE_RATE as usize * SCRATCH_CACHE_WINDOW_SECONDS;
    for position in positions {
        let started = Instant::now();
        let decoded = decode_file_scratch_window(
            Path::new(&path),
            position,
            OUTPUT_SAMPLE_RATE,
            frame_limit,
            || false,
        )?;
        println!(
            "position={position:.3}s elapsed_ms={:.3} start_frame={} frames={}",
            started.elapsed().as_secs_f64() * 1_000.0,
            decoded.start_frame,
            decoded.frames.len(),
        );
    }
    Ok(())
}
