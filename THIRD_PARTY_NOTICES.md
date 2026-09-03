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

## glib 0.18.5 security backport

- Project: <https://github.com/gtk-rs/gtk-rs-core>
- Crate: `glib`
- License: MIT
- Vendored source: `vendor/glib-0.18.5/`
- Local patch note: `vendor/glib-0.18.5/KDJ-PATCH.md`

KDJ vendors the crates.io 0.18.5 source required by its Tauri/GTK3 dependency
chain and backports upstream's mutable output-pointer fix for
`VariantStrIter::impl_get` (`RUSTSEC-2024-0429`). The two-line safety fix matches
the implementation in upstream glib 0.20 and later; all other vendored source
retains the published 0.18.5 code and MIT terms.

## drag-rs 2.1.1

- Project: <https://github.com/crabnebula-dev/drag-rs>
- Crate: `drag`
- License: MIT OR Apache-2.0

KDJ uses drag-rs on Windows and macOS to expose existing local-library files to
the operating system's native drag-and-drop session. Dragging out is copy-only,
so an external drop cannot move a source file out of the indexed library.

## objc2 macOS framework bindings

- Project: <https://github.com/madsmtm/objc2>
- Crates: `objc2` 0.6.4; `objc2-app-kit`, `objc2-foundation`, and
  `objc2-web-kit` 0.3.2
- License: MIT (`objc2`, `objc2-foundation`); Zlib OR Apache-2.0 OR MIT
  (the other listed framework binding crates)

KDJ statically links these Rust bindings for native clipboard handling and its
isolated WKWebView integrations. The Apple framework implementations are
supplied by macOS; KDJ does not vendor or redistribute their binaries.

## BgUtils 4.0.3

- Project: <https://github.com/LuanRT/BgUtils>
- npm package: `bgutils-js`
- License: MIT

On macOS, KDJ runs BgUtils' BotGuard client only in a non-persistent hidden
native WKWebView. The view has a fixed YouTube origin and user agent, but no
imported cookies, Tauri IPC bridge, application storage or media URL. Its
restrictive CSP permits only the anonymous YouTube challenge, Google's
allowlisted interpreter and GenerateIT request. The minter is warmed and reused
for content-bound tokens inside that isolated realm. Linux/Windows reuse the
same local proof IIFE only for player s/n transforms inside a bare Deno/V8
isolate; BotGuard minting on those platforms uses rustypipe-botguard instead.

## rustypipe-botguard 0.1.2

- Project: <https://codeberg.org/ThetaDev/rustypipe-botguard>
- Crate: `rustypipe-botguard`
- License: MIT

On Linux and Windows, KDJ statically links rustypipe-botguard to mint YouTube
WebPO tokens inside an embedded Deno/V8 realm (JSDOM-style browser shim). This
keeps BotGuard out of the main Tauri renderer (SEC-005) without a Node/Python
sidecar. The library is based on the same BgUtils reverse-engineering lineage.

## GoogleVideo 4.1.1

- Project: <https://github.com/LuanRT/GoogleVideo>
- Reference revision: 58f92b7
- npm package: googlevideo
- License: MIT

KDJ uses GoogleVideo's SABR/UMP client for protected YTM audio. SABR requests
are passed through a validation-only Rust loopback proxy; decoded fMP4 bytes are
written into KDJ's bounded growing spool so the native player, cache and
downloader share one media session. The dependency is loaded only for YTM audio;
the production chunk is 84,509 bytes before compression (20,112 bytes gzip),
and ordinary YouTube video uses the system HLS stack instead.

## hls-transmux 0.2.1

- Project: <https://github.com/Logosww/hls-transmux>
- Crate: `hls-transmux`
- License: MIT

KDJ uses the crate's pure-Rust MPEG-TS/CMAF to fragmented-MP4 path for normal
YouTube video downloads. Its optional FFmpeg finalization feature is disabled;
KDJ streams one protected HLS segment at a time and does not decode or re-encode
the H.264/AAC tracks.

## Metrolist / InnerTubeX

- Project: <https://github.com/MetrolistGroup/Metrolist>
- Extractor: <https://github.com/MetrolistGroup/innertubex>
- Reference revisions: Metrolist `152f97f`; InnerTubeX `342158b`
- License: GPL-3.0

KDJ ports Metrolist's cookie-session identity capture, fixed BotGuard
Create/GenerateIT RPC contract, dedicated matching-origin/user-agent WebView
boundary, and minter lifecycle. Current InnerTubeX was also
used as a behavioral reference for keeping player-request and GVS PO-token
policies separate, attaching CPN to direct media URLs, and carrying a coherent
client/header/range contract. No InnerTubeX source is vendored.

## YouTube.js 17.2.0

- Project: <https://github.com/LuanRT/YouTube.js>
- npm package: `youtubei.js`
- License: MIT

KDJ's narrow player-script extractor is adapted from YouTube.js and only
extracts the current sig/n transform plus signature timestamp. Extracted
programs run only in KDJ's isolated native YouTube-origin WKWebView, not the
privileged renderer. The wrapper omits YouTube.js's general InnerTube client,
parser registry, protobufs, OAuth and cache; no Node/Python sidecar is used.

## yt-dlp WebPO behavior reference

- Project: <https://github.com/yt-dlp/yt-dlp>
- Reference revision: `66f4976`
- License: Unlicense

KDJ's WebPO content-binding selection follows yt-dlp's distinction between
Visitor Data, authenticated Data Sync ID, and the
`html5_generate_content_po_token` video-bound experiment. It also follows the
current player-script `n` transformation before attaching the GVS proof to the
official HLS path. yt-dlp is not bundled or executed by KDJ.

## PipePipeExtractor playback research reference

- Project: <https://github.com/InfinityLoop1308/PipePipeExtractor>
- Reference revision: `760225a`
- License: GPL-3.0

PipePipeExtractor was reviewed for its recoverable SABR session and segmented
media model. No PipePipeExtractor source is copied, bundled, or linked by KDJ.

## Android runtime exclusions

The current Android build uses KDJ's model-free Rust stem-separation path. It
does not package ExecuTorch, SoLoader/NativeLoader, fbjni, an ExecuTorch Vulkan
AAR, or an SCNet `.pte` model. These components were removed from the Android
post-init and packaging path before release and are therefore not distributed
as third-party runtime components of KDJ.

Other Rust and npm dependencies retain their respective licenses. Their exact
versions are recorded in `Cargo.lock` and `package-lock.json`.
