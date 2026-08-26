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

KDJ runs BgUtils' BotGuard client in the existing browser runtime and sends the
Create/GenerateIT requests from that same runtime. This keeps interpreter
signals and the HTTP user agent coherent. The minter is warmed in the
background and reused for track-bound tokens.

## GoogleVideo 4.1.1

- Project: <https://github.com/LuanRT/GoogleVideo>
- Reference revision: 58f92b7
- npm package: googlevideo
- License: MIT

KDJ uses GoogleVideo's SABR/UMP client for protected YTM audio. SABR requests
are passed through a validation-only Rust loopback proxy; decoded fMP4 bytes are
written into KDJ's bounded growing spool so the native player, cache and
downloader share one media session. The separate real-network probe proves the
same chain independently of the application integration.

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
extracts the current sig/n transform plus signature timestamp. It runs in the
existing frontend runtime; no Node sidecar or separate runtime process is used.

## yt-dlp WebPO behavior reference

- Project: <https://github.com/yt-dlp/yt-dlp>
- Reference revision: `66f4976`
- License: Unlicense

KDJ's WebPO content-binding selection follows yt-dlp's distinction between
Visitor Data, authenticated Data Sync ID, and the
`html5_generate_content_po_token` video-bound experiment. yt-dlp is not
bundled or executed by KDJ. KDJ also follows the ordinary HTTP downloader's
single selected-media GET boundary: the protected response is spooled once and
local playback seeks/download finalization reuse those bytes instead of
reopening the WebPO capability for every Range.

## PipePipeExtractor playback research reference

- Project: <https://github.com/InfinityLoop1308/PipePipeExtractor>
- Reference revision: `760225a`
- License: GPL-3.0

PipePipeExtractor was reviewed for its recoverable SABR session and segmented
media model. No PipePipeExtractor source is copied, bundled, or linked by KDJ.

Other Rust and npm dependencies retain their respective licenses. Their exact
versions are recorded in `Cargo.lock` and `package-lock.json`.
