# Third-party notices

KDJ is distributed under GPL-3.0-or-later. It includes and statically links the
following third-party component.

## Rubber Band Library 4.0.0

- Project: <https://breakfastquay.com/rubberband/>
- Source: <https://github.com/breakfastquay/rubberband>
- Copyright: 2007-2024 Particular Programs Ltd
- License: GPL-2.0-or-later
- Rubber Band Library: `crates/kdj-player/vendor/rubberband/`

KDJ builds Rubber Band's official single-file compilation unit with its
built-in resampler. It uses the built-in FFT on non-Apple platforms and the
system Accelerate/vDSP FFT on Apple platforms.

## Freeverb delay tunings

- Project: <https://github.com/sinshu/freeverb>
- DSP reference: <https://ccrma.stanford.edu/~jos/pasp/Freeverb.html>
- Author: Jezar at Dreampoint
- License: Public domain
- Adapted implementation: `crates/kdj-player/src/manual_fx.rs`

KDJ's compact Schroeder/Moorer reverb uses a reduced set of Freeverb's
public-domain comb/allpass delay tunings. The realtime Rust implementation is
KDJ-specific and does not vendor a Freeverb library.

## rookie 0.5.6

- Project: <https://github.com/thewh1teagle/rookie>
- License: MIT
- Vendored source: `vendor/rookie/`
- Local dependency note: `vendor/rookie/KDJ-VENDORING.md`

KDJ uses rookie only after the user selects a detected desktop browser Profile,
and filters the result to `youtube.com` cookies. Local patches align rookie's
rusqlite line with KDJ's existing SQLite/SQLCipher link and add profile-aware
discovery; profile filesystem paths remain inside the Rust process.

## rusty_ytdl 0.7.4

- Project: <https://github.com/Mithronn/rusty_ytdl>
- License: MIT OR Apache-2.0

KDJ uses rusty_ytdl's Rust API for ordinary YouTube search, playlist expansion,
and stream metadata. It does not invoke a Python/Node sidecar.

## BgUtils 4.0.3

- Project: <https://github.com/LuanRT/BgUtils>
- npm package: `bgutils-js`
- License: MIT

KDJ uses BgUtils' BotGuard client in the Tauri WebView to execute the fixed
YouTube BotGuard challenge returned through the local Rust backend.

## Metrolist

- Project: <https://github.com/MetrolistGroup/Metrolist>
- Reference revision: `b880e2b6bf8d01c36dbb8aae477768e6f0f69167`
- License: GPL-3.0

KDJ ports Metrolist's cookie-session identity capture, fixed BotGuard
Create/GenerateIT RPC contract, minter lifecycle, and dual WebPO binding order
(session/Visitor token for the player request, then video token for GVS). The
implementation remains in KDJ's Rust + Tauri architecture.

## YouTube.js 17.2.0

- Project: <https://github.com/LuanRT/YouTube.js>
- npm package: `youtubei.js`
- License: MIT

KDJ uses YouTube.js in the Tauri WebView only to extract and execute the current
player signature transform. Authenticated player and media requests remain in
the local Rust backend; no Node sidecar or separate runtime process is used.

Other Rust and npm dependencies retain their respective licenses. Their exact
versions are recorded in `Cargo.lock` and `package-lock.json`.
