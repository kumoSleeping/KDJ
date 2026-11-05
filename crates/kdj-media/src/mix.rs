//! The sample loops of a project's sound mix (kdj-server's workshop render.rs): 16-bit PCM in and
//! out, a clip added at one gain, and the limiter. They run over every frame of every chunk again
//! at each sound edit, so they live here, where the build optimises them also in development
//! (Cargo.toml), and take plain slices: nothing generic is compiled in the caller's crate.

/// Little-endian 16-bit samples as floats in -1..1, into `out` (as many as both hold).
pub fn s16le_to_f32(bytes: &[u8], out: &mut [f32]) {
    let n = (bytes.len() / 2).min(out.len());
    for i in 0..n {
        out[i] = i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]) as f32 / 32768.;
    }
}

/// Floats as little-endian 16-bit samples, clamped to full scale and rounded.
pub fn f32_to_s16le(samples: &[f32]) -> Vec<u8> {
    let mut out = vec![0u8; samples.len() * 2];
    for (i, s) in samples.iter().enumerate() {
        let v = (s.clamp(-1., 1.) * 32767.).round() as i16;
        let [a, b] = v.to_le_bytes();
        out[i * 2] = a;
        out[i * 2 + 1] = b;
    }
    out
}

/// Stereo frames `sound[from..to]` times `gain`, added into `mix` from its frame `at + from`.
pub fn add_scaled(mix: &mut [f32], at: usize, sound: &[f32], from: usize, to: usize, gain: f32) {
    for n in from..to {
        let o = (at + n) * 2;
        mix[o] += sound[n * 2] * gain;
        mix[o + 1] += sound[n * 2 + 1] * gain;
    }
}

/// Keeps stereo `mix` under full scale: the gain drops at once to what the loudest frame of the
/// next `ahead` frames needs and comes back by `release` a frame. A mix that never reaches full
/// scale is left as it is (the gain would stay 1). The loudest frame ahead is a sliding maximum,
/// a queue of the frames that can still be it.
pub fn limit(mix: &mut [f32], ahead: usize, release: f32) {
    let frames = mix.len() / 2;
    let mut peaks = vec![0f32; frames];
    let mut over = false;
    for n in 0..frames {
        let p = mix[n * 2].abs().max(mix[n * 2 + 1].abs());
        over |= p > 1.;
        peaks[n] = p;
    }
    if !over {
        return;
    }
    let mut loudest = vec![0f32; frames];
    let mut queue = std::collections::VecDeque::<usize>::with_capacity(ahead + 1);
    for n in (0..frames).rev() {
        while queue.back().is_some_and(|&m| peaks[m] <= peaks[n]) {
            queue.pop_back();
        }
        queue.push_back(n);
        while queue.front().is_some_and(|&m| m >= n + ahead) {
            queue.pop_front();
        }
        loudest[n] = peaks[queue[0]];
    }
    let mut gain = 1f32;
    for n in 0..frames {
        let target = if loudest[n] > 1. { 1. / loudest[n] } else { 1. };
        gain = if target < gain { target } else { (gain + release).min(target) };
        mix[n * 2] = (mix[n * 2] * gain).clamp(-1., 1.);
        mix[n * 2 + 1] = (mix[n * 2 + 1] * gain).clamp(-1., 1.);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_go_through_sixteen_bits_and_back() {
        let bytes = f32_to_s16le(&[0., 0.5, -0.5, 1.5, -1.5]);
        let mut back = [9f32; 5];
        s16le_to_f32(&bytes, &mut back);
        assert_eq!(back, [0., 16384. / 32768., -16384. / 32768., 32767. / 32768., -32767. / 32768.]);
    }

    #[test]
    fn a_scaled_run_lands_where_it_is_put() {
        let mut mix = vec![0f32; 8];
        add_scaled(&mut mix, 1, &[1., 2., 3., 4., 5., 6.], 1, 3, 0.5);
        assert_eq!(mix, [0., 0., 0., 0., 1.5, 2., 2.5, 3.]);
    }
}
