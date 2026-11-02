//! Sound played faster or slower at its own pitch: WSOLA (waveform-similarity overlap-add), the
//! method FFmpeg's `atempo` uses. Windows of the source are laid half a window apart in the
//! output; each is taken where the source matches the previous window's natural continuation
//! best, within a few milliseconds of where the speed puts it.

/// Window length in frames (about 43 ms at 48 kHz); windows overlap by half.
const WINDOW: usize = 2048;
const HOP: usize = WINDOW / 2;
/// How far a window may move from where the speed puts it (about 11 ms at 48 kHz).
const SEEK: isize = 512;
/// Coarse search step, then every frame around the best coarse match.
const COARSE: usize = 8;
/// Every n-th frame is compared: the match is about the waveform's shape, not its detail.
const STRIDE: usize = 4;

/// `frames` output frames from `input` (interleaved, `channels` per frame), the output frame `o`
/// standing for the input frame `position(o)`. Input outside `input` is silence. With a position
/// that advances one input frame per output frame the input comes back unchanged.
pub fn stretch(input: &[f32], channels: usize, frames: usize, position: &dyn Fn(f64) -> f64) -> Vec<f32> {
    let channels = channels.max(1);
    let len = input.len() / channels;
    let mono: Vec<f32> = input.chunks_exact(channels).map(|frame| frame.iter().sum::<f32>() / channels as f32).collect();
    let at = |i: isize| if i >= 0 && (i as usize) < len { mono[i as usize] } else { 0. };
    // Periodic Hann: two windows half a window apart add up to exactly one.
    let window: Vec<f32> = (0..WINDOW).map(|n| 0.5 - 0.5 * (std::f64::consts::TAU * n as f64 / WINDOW as f64).cos() as f32).collect();
    let score = |target: isize, candidate: isize| {
        let (mut dot, mut energy) = (0f32, 1e-9f32);
        for n in (0..WINDOW as isize).step_by(STRIDE) {
            let x = at(candidate + n);
            dot += at(target + n) * x;
            energy += x * x;
        }
        dot / energy.sqrt()
    };
    let best = |target: isize, nominal: isize| {
        let mut chosen = (f32::MIN, nominal);
        for delta in (-SEEK..=SEEK).step_by(COARSE) {
            let s = score(target, nominal + delta);
            if s > chosen.0 {
                chosen = (s, nominal + delta);
            }
        }
        let coarse = chosen.1;
        for candidate in coarse - COARSE as isize + 1..coarse + COARSE as isize {
            if (candidate - nominal).abs() <= SEEK {
                let s = score(target, candidate);
                if s > chosen.0 {
                    chosen = (s, candidate);
                }
            }
        }
        chosen.1
    };
    let mut out = vec![0f32; frames * channels];
    let mut previous: Option<isize> = None;
    // The first window starts half a window early, so the first output frames are covered by
    // two windows like every other.
    let mut start = -(HOP as isize);
    while start < frames as isize {
        let nominal = position(start as f64).round() as isize;
        let chosen = match previous {
            // Where the previous window's source goes on is what this window should sound like.
            Some(p) => best(p + HOP as isize, nominal),
            None => nominal,
        };
        for (n, w) in window.iter().enumerate() {
            let o = start + n as isize;
            let i = chosen + n as isize;
            if o < 0 || o as usize >= frames || i < 0 || i as usize >= len {
                continue;
            }
            let (o, i) = (o as usize * channels, i as usize * channels);
            for ch in 0..channels {
                out[o + ch] += input[i + ch] * w;
            }
        }
        previous = Some(chosen);
        start += HOP as isize;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(frames: usize, hz: f64) -> Vec<f32> {
        (0..frames).flat_map(|n| {
            let s = (std::f64::consts::TAU * hz * n as f64 / 48_000.).sin() as f32 * 0.5;
            [s, s]
        }).collect()
    }

    /// Upward zero crossings per second of the left channel.
    fn pitch(samples: &[f32]) -> f64 {
        let left: Vec<f32> = samples.iter().step_by(2).copied().collect();
        let crossings = left.windows(2).filter(|w| w[0] < 0. && w[1] >= 0.).count();
        crossings as f64 * 48_000. / left.len() as f64
    }

    #[test]
    fn at_its_own_speed_the_sound_comes_back_unchanged() {
        let input = sine(48_000, 440.);
        let out = stretch(&input, 2, 48_000, &|o| o);
        let worst = input.iter().zip(&out).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(worst < 1e-4, "{worst}");
    }

    #[test]
    fn slower_and_faster_keep_the_pitch_and_the_level() {
        let input = sine(96_000, 440.);
        for rate in [0.5, 0.9, 1.25, 2.] {
            let frames = 40_000;
            let out = stretch(&input, 2, frames, &|o| o * rate);
            let body = &out[4096..(frames - 4096) * 2];
            assert!((pitch(body) - 440.).abs() < 6., "rate {rate}: {}", pitch(body));
            let peak = body.iter().fold(0f32, |m, s| m.max(s.abs()));
            assert!((peak - 0.5).abs() < 0.08, "rate {rate}: peak {peak}");
        }
    }
}
