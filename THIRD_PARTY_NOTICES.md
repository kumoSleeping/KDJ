# Third-party notices

KDJ is distributed under GPL-3.0-or-later. It includes and statically links the
following third-party component.

## Rubber Band Library 4.0.0

- Project: <https://breakfastquay.com/rubberband/>
- Source: <https://github.com/breakfastquay/rubberband>
- Copyright: 2007-2024 Particular Programs Ltd
- License: GPL-2.0-or-later
- Rubber Band Library: `crates/kdj-player/vendor/rubberband/`

## Spleeter4 FP16 ONNX

- Original Spleeter project and pre-trained 4-stem model: Deezer,
  <https://github.com/deezer/spleeter>.
- ONNX conversion and published artifacts:
  <https://github.com/madewith-bestpractice/spleeter-4stems-onnx> and
  <https://huggingface.co/Best-Practice/spleeter-4stems-onnx> (Apache-2.0).
- The conversion derives from `k2-fsa/sherpa-onnx` (Apache-2.0) and modifies its U-Net port to
  use the ELU activations required by Spleeter 4-stem.
- Deezer's JOSS paper states that Spleeter source and pre-trained models are MIT-distributed. The
  narrower repository wording and the unresolved weight-license question are recorded in
  `docs/stem-runtime.md` rather than silently treated as settled.
- KDJ downloads four pinned FP16 ONNX files at runtime and verifies each SHA-256. The model files
  are not committed to this repository.

## StemgenRT / HS-TasNet local seek layer

- Runtime integration reference: StemgenRT,
  <https://github.com/sweetspotsoundsystem/stemgen-rt>, commit
  `eaaba4fe8ed77a312ddaee34948bea34e0cbc30b` (MIT source license).
- HS-TasNet source reference: <https://github.com/lucidrains/HS-TasNet> (MIT source license).
- The pinned external-data ONNX pair and SHA-256 values are recorded in
  `research/stems/reference-lock.json`. KDJ does not commit, package, or offer that checkpoint from
  its model downloader because an artifact-specific training manifest and redistribution grant
  have not been archived. The runtime only discovers a user-supplied local copy.

## ByteDance MobileNet_Subbandtime two-stem FP32 ONNX

- Source implementation: ByteDance `music_source_separation`,
  <https://github.com/bytedance/music_source_separation>, commit
  `e64b858cd14c3cc974826c51390399eef623dd2a` (Apache-2.0).
- Official checkpoint record: Qiuqiang Kong, Yin Cao, Haohe Liu, Keunwoo Choi and Yuxuan Wang,
  “Music Source Separation PyTorch Checkpoints”, Zenodo record 5804160,
  <https://doi.org/10.5281/zenodo.5804160> (CC-BY-4.0).
- KDJ exports the official accompaniment checkpoint to a fixed three-second FP32 ONNX graph. The
  graph is committed under `model-artifacts/bytedance-mobilenet-subbandtime/`; the runtime
  downloader verifies SHA-256 before activation. KDJ derives Vocals as `mixture - accompaniment`
  so neutral two-lane playback reconstructs the source exactly.

KDJ builds Rubber Band's official single-file compilation unit with its
built-in resampler. It uses the built-in FFT on non-Apple platforms and the
system Accelerate/vDSP FFT on Apple platforms.

Other Rust and npm dependencies retain their respective licenses. Their exact
versions are recorded in `Cargo.lock` and `package-lock.json`.
