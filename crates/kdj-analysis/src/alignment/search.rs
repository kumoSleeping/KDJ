//! FFT cross-correlation proposes offsets; it never decides acoustic acceptance.
use super::*;
use rustfft::{num_complex::Complex64, Fft};
use std::sync::Arc;

pub(super) struct EnvelopeSearch {
    reference_len: usize,
    query_len: usize,
    spectrum: Vec<Complex64>,
    sums: Vec<f64>,
    squares: Vec<f64>,
    forward: Arc<dyn Fft<f64>>,
    inverse: Arc<dyn Fft<f64>>,
}

fn centered(values: &[f32]) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let mean = values.iter().map(|&v| v as f64).sum::<f64>() / values.len().max(1) as f64;
    let values: Vec<_> = values.iter().map(|&v| v as f64 - mean).collect();
    let mut sums = vec![0.; values.len() + 1];
    let mut squares = sums.clone();
    for (i, &value) in values.iter().enumerate() {
        sums[i + 1] = sums[i] + value;
        squares[i + 1] = squares[i] + value * value;
    }
    (values, sums, squares)
}

impl EnvelopeSearch {
    /// A reference transform is reused for every equal-length video window.
    pub(super) fn new(reference: &[f32], query_len: usize) -> Self {
        let size = (reference.len() + query_len).max(1).next_power_of_two();
        let mut planner = FftPlanner::<f64>::new();
        let forward = planner.plan_fft_forward(size);
        let inverse = planner.plan_fft_inverse(size);
        let (values, sums, squares) = centered(reference);
        let mut spectrum = vec![Complex64::default(); size];
        for (output, value) in spectrum.iter_mut().zip(values) {
            output.re = value;
        }
        forward.process(&mut spectrum);
        Self {
            reference_len: reference.len(),
            query_len,
            spectrum,
            sums,
            squares,
            forward,
            inverse,
        }
    }

    /// Lag = reference position - query position, in 50 ms envelope frames.
    /// Prefix sums normalize each overlap independently, including negative lags.
    pub(super) fn scores(
        &self,
        query: &[f32],
        minimum_overlap: usize,
        canceled: &impl Fn() -> bool,
    ) -> Result<Vec<(i32, f64)>> {
        anyhow::ensure!(query.len() == self.query_len, "粗匹配窗口长度错误");
        if canceled() {
            bail!("匹配已取消")
        }
        if query.is_empty() || self.reference_len == 0 {
            return Ok(vec![]);
        }
        let (values, sums, squares) = centered(query);
        let size = self.spectrum.len();
        let mut product = vec![Complex64::default(); size];
        for (output, value) in product.iter_mut().zip(values.iter().rev()) {
            output.re = *value;
        }
        self.forward.process(&mut product);
        for (value, reference) in product.iter_mut().zip(&self.spectrum) {
            *value *= reference;
        }
        if canceled() {
            bail!("匹配已取消")
        }
        self.inverse.process(&mut product);
        let mut scores = Vec::new();
        for lag in -(query.len() as i32) + 1..self.reference_len as i32 {
            if lag % 1024 == 0 && canceled() {
                bail!("匹配已取消")
            }
            let (x, y, count) = overlap(query.len(), self.reference_len, lag);
            if count < minimum_overlap.max(2) {
                continue;
            }
            let n = count as f64;
            let sa = sums[x + count] - sums[x];
            let sb = self.sums[y + count] - self.sums[y];
            let aa = squares[x + count] - squares[x] - sa * sa / n;
            let bb = self.squares[y + count] - self.squares[y] - sb * sb / n;
            let dot = product[(query.len() as i32 - 1 + lag) as usize].re / size as f64;
            let denominator = (aa.max(0.) * bb.max(0.)).sqrt();
            let score = if denominator < 1e-9 {
                0.
            } else {
                ((dot - sa * sb / n) / denominator).clamp(-1., 1.)
            };
            scores.push((lag, score));
        }
        Ok(scores)
    }
}
