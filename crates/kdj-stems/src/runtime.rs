//! Runtime identity for the default model-free separator.

#[derive(Clone, Debug)]
pub(crate) struct RuntimeInfo {
    pub runtime: String,
    pub provider: String,
}

impl RuntimeInfo {
    pub(crate) fn planned() -> Self {
        Self {
            runtime: "Classical DSP".into(),
            provider: "Rust FFT · Adobe-style Vocal Extractor + Median HPSS".into(),
        }
    }
}

/// Two Decks may decompose independent short chunks concurrently. The work is CPU-only and has no
/// device-global model queue, but keeping this bound at two avoids optional waveform scans taking
/// every core from the audio engine.
pub(crate) fn recommended_worker_count() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .clamp(1, 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classical_runtime_is_available_on_every_platform() {
        assert!((1..=2).contains(&recommended_worker_count()));
        let info = RuntimeInfo::planned();
        assert_eq!(info.runtime, "Classical DSP");
    }
}
