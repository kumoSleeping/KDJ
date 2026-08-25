# Classical realtime STEM runtime

KDJ production STEM is a model-free, CPU-only, two-track separator. It produces `Vocals` and
`Instrumental`; the stable four-slot playback contract keeps Drums and Bass at zero, stores
Instrumental in Other, and stores the centre estimate in Vocals. No model selection, weight
download, accelerator setting, or whole-track analysis exists in the product path.

The current production stage is **Test B: Redress soft spatial masking**. Performance's existing
Vocal FX slot is the user control: enabling it mounts the classical stream, and its MIX control
changes the vocal lane gain in the realtime mixer. There is no separate analysis button or lab
panel. STEM does not generate waveform assets, display scans, HTTP waveform payloads, or extra
Canvas rails. Original audio remains audible until the short classical buffer is ready.

## Signal contract

- Input/output: 44.1 kHz stereo float PCM.
- STFT: 2048 samples, periodic Hann, 512-sample hop.
- Algorithmic look-ahead: 1024 samples = 23.22 ms.
- Product tile: 8192 samples = 2048 past context + 4096 audible core + 2048 future context.
- Seek: increment the stream epoch, discard queued old tiles, and start a fresh short tile at the
  requested PCM position. No history outside the tile is required.
- Output identity: `Vocals + Instrumental` reconstructs each input channel within floating-point
  overlap-add tolerance.

The implementation uses the workspace's existing `rustfft`; this change adds no runtime package.

## Algorithm provenance

Test B follows Ruairí de Fréin, “Reformulating the Binary Masking Approach of Adress as Soft
Masking”, *Electronics* 9(9), 1373 (2020), DOI
[10.3390/electronics9091373](https://doi.org/10.3390/electronics9091373). The underlying ADRess
construction is D. Barry, B. Lawlor and E. Coyle, “Sound Source Separation: Azimuth
Discrimination and Resynthesis”, DAFx-04, Naples (2004).

For every STFT bin KDJ implements the paper's sequence:

1. Construct both halves of the frequency-azimuth plane for 101 gains `g = 0..1`:
   `A1 = |L - gR|`, `A2 = |R - gL|` (Redress equations 8–10).
2. Precompute three pan-pot azimuth trajectories from the same equations: left `(1, 0.35)`,
   centre `(1, 1)`, and right `(0.35, 1)`. This is the trajectory matrix H from equations 22–24.
3. Solve `min(W >= 0) ||A - WH||²` using 100 Lee-Seung multiplicative updates
   `W <- W * (A H^T) / (W H H^T)` as specified after equation 25. `H H^T` is precomputed.
4. Group the centre column of W as Vocal and the left/right columns as Instrumental.

The paper reconstructs each learned source magnitude with mixture phase. KDJ makes one explicitly
documented DJ-product adaptation after the NQP: centre magnitude divided by all three learned
magnitudes becomes a continuous soft ratio mask, a one-bin triangular frequency smoother reduces
isolated holes, and the exact complementary mask is applied to both original complex stereo
channels. This preserves stereo and guarantees neutral two-track reconstruction; it is not presented
as an unmodified paper result. No binary mask is used.

## Stage boundary

The repository also provides Test A, classical `(L + R) / 2` centre extraction with exact residual,
only as a baseline. This stage intentionally stops after Test B. The following are not implemented
yet:

- Test C: realtime vocal F0 tracker and harmonic soft probability.
- Test D: bounded Online REPET-SIM repetition probability.
- Test E: generalized Wiener refinement beyond the current complementary ratio mask.
- RPCA/Gammatone-WRPCA: offline comparison only; never a required realtime path.

Centre kick, snare and bass can therefore still leak into Vocals. Wide, doubled or reverberant
vocals can leak into Instrumental. Listening acceptance must not be inferred from synthetic tests.

## Reproducible A/B tool

```bash
cargo run --release -p kdj-stems --example classical_stem_lab -- INPUT OUTPUT_DIR
```

The tool writes:

- `OUTPUT_DIR/test-a/{vocals,instrumental}.wav`
- `OUTPUT_DIR/test-b/{vocals,instrumental}.wav`
- `OUTPUT_DIR/metrics.json`

Metrics include wall time, realtime factor, macOS process CPU ratio, algorithmic latency, first
tile time, seek-reset first tile time, and estimated working memory.
