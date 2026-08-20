use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;

#[derive(Clone, Copy)]
pub(crate) enum DebugWindow {
    Rectangular,
    Hann,
}

pub(crate) struct DebugSpectrum {
    pub(crate) bins: usize,
    pub(crate) frames: usize,
    pub(crate) values: Vec<Complex32>,
}

pub(crate) fn stft(
    signal: &[f32],
    n_fft: usize,
    hop: usize,
    window: DebugWindow,
    center: bool,
    normalized: bool,
) -> DebugSpectrum {
    let pad = if center { n_fft / 2 } else { 0 };
    let padded_len = signal.len().saturating_add(pad * 2);
    let frames = padded_len.saturating_sub(n_fft) / hop + 1;
    let bins = n_fft / 2 + 1;
    let window = window_values(n_fft, window);
    let scale = if normalized {
        1.0 / (n_fft as f32).sqrt()
    } else {
        1.0
    };
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut frame = vec![Complex32::default(); n_fft];
    let mut values = vec![Complex32::default(); bins * frames];
    for time in 0..frames {
        let start = time * hop;
        for index in 0..n_fft {
            let padded_index = start + index;
            let sample = if center {
                reflected_sample(signal, padded_index as isize - pad as isize)
            } else {
                signal.get(padded_index).copied().unwrap_or(0.0)
            };
            frame[index] = Complex32::new(sample * window[index], 0.0);
        }
        fft.process(&mut frame);
        for frequency in 0..bins {
            values[frequency * frames + time] = frame[frequency] * scale;
        }
    }
    DebugSpectrum {
        bins,
        frames,
        values,
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn istft(
    values: &[Complex32],
    bins: usize,
    frames: usize,
    n_fft: usize,
    hop: usize,
    window: DebugWindow,
    center: bool,
    normalized: bool,
    output_len: usize,
) -> Vec<f32> {
    let synthesis_len = n_fft + hop * frames.saturating_sub(1);
    let window = window_values(n_fft, window);
    let inverse_scale = if normalized {
        1.0 / (n_fft as f32).sqrt()
    } else {
        1.0 / n_fft as f32
    };
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_inverse(n_fft);
    let mut frame = vec![Complex32::default(); n_fft];
    let mut output = vec![0.0_f32; synthesis_len];
    let mut envelope = vec![0.0_f32; synthesis_len];
    for time in 0..frames {
        frame.fill(Complex32::default());
        for frequency in 0..bins.min(n_fft / 2 + 1) {
            frame[frequency] = values
                .get(frequency * frames + time)
                .copied()
                .unwrap_or_default();
        }
        for frequency in 1..n_fft / 2 {
            frame[n_fft - frequency] = frame[frequency].conj();
        }
        fft.process(&mut frame);
        let start = time * hop;
        for index in 0..n_fft {
            let weight = window[index];
            output[start + index] += frame[index].re * inverse_scale * weight;
            envelope[start + index] += weight * weight;
        }
    }
    for (sample, weight) in output.iter_mut().zip(envelope) {
        if weight > 1e-8 {
            *sample /= weight;
        } else {
            *sample = 0.0;
        }
    }
    let crop = if center { n_fft / 2 } else { 0 };
    (0..output_len)
        .map(|index| output.get(crop + index).copied().unwrap_or(0.0))
        .collect()
}

#[cfg(feature = "stem-debug-onnx")]
pub(crate) fn reflect_pad(signal: &[f32], pad: usize) -> Vec<f32> {
    (-(pad as isize)..signal.len() as isize + pad as isize)
        .map(|index| reflected_sample(signal, index))
        .collect()
}

fn reflected_sample(signal: &[f32], mut index: isize) -> f32 {
    if signal.is_empty() {
        return 0.0;
    }
    if signal.len() == 1 {
        return signal[0];
    }
    let upper = signal.len() as isize - 1;
    while index < 0 || index > upper {
        if index < 0 {
            index = -index;
        }
        if index > upper {
            index = upper * 2 - index;
        }
    }
    signal[index as usize]
}

fn window_values(len: usize, window: DebugWindow) -> Vec<f32> {
    match window {
        DebugWindow::Rectangular => vec![1.0; len],
        DebugWindow::Hann => (0..len)
            .map(|index| 0.5 * (1.0 - (std::f32::consts::TAU * index as f32 / len as f32).cos()))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centered_rectangular_stft_round_trips() {
        let input = (0..12_345)
            .map(|index| (index as f32 * 0.013).sin() * 0.7)
            .collect::<Vec<_>>();
        let spectrum = stft(&input, 4096, 1024, DebugWindow::Rectangular, true, true);
        let output = istft(
            &spectrum.values,
            spectrum.bins,
            spectrum.frames,
            4096,
            1024,
            DebugWindow::Rectangular,
            true,
            true,
            input.len(),
        );
        let peak = input
            .iter()
            .zip(output)
            .map(|(left, right)| (left - right).abs())
            .fold(0.0_f32, f32::max);
        assert!(peak < 2e-5, "peak={peak}");
    }

    #[test]
    fn uncentered_hann_stft_round_trips_interior() {
        let input = (0..131_072)
            .map(|index| (index as f32 * 0.021).sin() * 0.5)
            .collect::<Vec<_>>();
        let spectrum = stft(&input, 2048, 512, DebugWindow::Hann, false, false);
        let output = istft(
            &spectrum.values,
            spectrum.bins,
            spectrum.frames,
            2048,
            512,
            DebugWindow::Hann,
            false,
            false,
            input.len(),
        );
        let peak = input[2048..input.len() - 2048]
            .iter()
            .zip(&output[2048..output.len() - 2048])
            .map(|(left, right)| (left - right).abs())
            .fold(0.0_f32, f32::max);
        assert!(peak < 2e-5, "peak={peak}");
    }
}
