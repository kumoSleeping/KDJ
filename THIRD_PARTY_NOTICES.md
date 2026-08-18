# Third-party notices

KDJ is distributed under GPL-3.0-or-later. It includes and statically links the
following third-party component.

## Rubber Band Library 4.0.0

- Project: <https://breakfastquay.com/rubberband/>
- Source: <https://github.com/breakfastquay/rubberband>
- Copyright: 2007-2024 Particular Programs Ltd
- License: GPL-2.0-or-later
- Rubber Band Library: `crates/kdj-player/vendor/rubberband/`

## SCNet Small

- SCNet source and architecture: <https://github.com/starrytong/SCNet> (MIT).
- Training/deployment checkpoint distributed by ZFTurbo:
  <https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/tag/v.1.0.6>.
- Native deployment export: <https://github.com/demixr/scnet-executorch> (MIT), release `v0.1.2`.
- KDJ downloads the platform model at runtime and verifies its complete SHA-256; it is not
  committed to this repository. Exact hashes and the tensor-equivalence record are in
  `docs/stem-runtime.md` and `research/stems/reference-lock.json`.

KDJ builds Rubber Band's official single-file compilation unit with its
built-in resampler. It uses the built-in FFT on non-Apple platforms and the
system Accelerate/vDSP FFT on Apple platforms.

Other Rust and npm dependencies retain their respective licenses. Their exact
versions are recorded in `Cargo.lock` and `package-lock.json`.
