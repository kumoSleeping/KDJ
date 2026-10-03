# KDJ cpal 0.18.1 WASAPI capture patch

This directory is the crates.io source for `cpal 0.18.1` (sha256
`5f77b11176c37874be37e8d691c946e31b2b8c357abce9526f6a99eb469e1028`, the checksum
that `Cargo.lock` recorded before the patch). The crate's own `Cargo.lock` is left
out by its `.gitignore`; nothing else is removed. The only code change is in
`src/host/wasapi/stream.rs` (`run_input`, `process_input` and two constants and one
helper below it). To see it: `git diff` this directory against the first commit
that imported it, or `diff -r` against the extracted `.crate`.

## Why vendored

cpal 0.18.1 calls `IAudioCaptureClient::GetBuffer` with a flags pointer but never
reads the flags:

- `AUDCLNT_BUFFERFLAGS_SILENT` packets were handed to the data callback as audio,
  although the engine buffer content is undefined for them.
- `AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY` and `AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR`
  were dropped, so a consumer could not know the capture was no longer continuous.

cpal 0.18.2 reports capture discontinuities as `ErrorKind::Xrun` (upstream PRs
RustAudio/cpal#1268 and #1281) but still ignores `SILENT` (open PR #1379 at the time
of writing) and `TIMESTAMP_ERROR`, and it pins `windows`/`windows-core` 0.62. Tauri
2.11 requires the 0.61 line (see `crates/kdj-player/Cargo.toml`), so upgrading is
not possible yet.

## What changed

1. `SILENT`: `run_input` allocates one buffer the size of the endpoint buffer when
   the capture thread starts, filled with the sample format's equilibrium value
   (`0x80` for `U8`, zero otherwise). A silent packet is delivered from that buffer
   with the same length; the engine buffer is not read. There is no allocation per
   packet (the buffer only grows if WASAPI ever reports a packet larger than the
   endpoint buffer).
2. `DATA_DISCONTINUITY`: reported as
   `Error::with_message(ErrorKind::Xrun, "WASAPI capture: AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY ...")`.
   As upstream does since #1281, the flag is ignored on the first `GetBuffer` after
   `Start` (device position 0), where Windows documents it as undefined.
3. `TIMESTAMP_ERROR`: reported as
   `Error::with_message(ErrorKind::Xrun, "WASAPI capture: AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR ...")`.

Both notices go through the existing error callback, on the capture thread, before
the flagged packet's data callback, and the stream keeps running. `emit_error` (not
`try_emit_error`) is used so a notice is never lost: on WASAPI every caller of the
error callback runs on this same capture thread, so the lock is never contended.

## Why the error callback and `ErrorKind::Xrun`

- It is the channel upstream chose for the same discontinuity in 0.18.2, so KDJ's
  consumer keeps working unchanged after an upgrade (only the timestamp notice and
  the silent-packet fix would be lost, and must be rechecked then).
- `ErrorKind` has no timestamp variant and is `#[non_exhaustive]`; adding a variant
  or a field to `InputCallbackInfo` would change cpal's public API and make the fork
  harder to drop. `Xrun` is documented as a glitch that does not end the stream,
  which is exactly what both flags mean for a consumer that stitches packets by time.
- The two cases are told apart by the message. KDJ only relies on the substring
  `AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR`: such a packet is placed right after the
  previous one instead of at its unreliable capture time (and dropped only when there
  is no timeline to continue); every other `Xrun` invalidates KDJ's evidence window.
  See `Ring::backend_error` in `src-tauri/src/live_vj/audio_input.rs`, whose unit test
  also checks that this file still contains the message.

## Maintenance

- `cargo audit` skips path sources, so RustSec advisories for `cpal 0.18.x` no longer
  fail CI while this copy is vendored. Check them by hand before each release.
- The patch only applies while `src-tauri/Cargo.toml` and
  `crates/kdj-player/Cargo.toml` pin `cpal = "=0.18.1"`. If that pin changes, Cargo
  only warns that the patch is unused, and the silent-packet and timestamp fixes are
  silently lost; port them or drop this directory in the same change.

Upstream: https://github.com/RustAudio/cpal
License: Apache-2.0 (see `LICENSE` in this directory)
