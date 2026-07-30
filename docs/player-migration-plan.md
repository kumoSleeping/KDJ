# Unified player migration

## Goal

Playback state and final PCM output must not belong to React or a desktop WebView. The UI sends typed commands and renders authoritative state. macOS, Windows and Linux use the same Rust decoder, DSP, Deck state machine and callback clock; platform code is limited to the CPAL device backend.

## Current status

The desktop-native vertical slice is now wired and is the default for local library tracks in a Tauri desktop build.

```text
PlayerBar / media sync / shortcuts
              |
       UnifiedPlayer contract
       /          |           \
DesktopNative   MobileNative   BrowserPreview
Tauri + Rust    Media3/AVPlayer Web Audio (dev/stream preview)
       |
DesktopPlayerHandle
       |
kdj-player: Symphonia -> prepared Deck bank -> realtime DSP -> CPAL
```

Implemented boundaries:

- `src/lib/unifiedPlayer.ts` owns the desktop-native, mobile-native and browser-preview adapters.
- `src-tauri/src/desktop_player.rs` runs one control actor. Tauri handlers send requests; they do not own player state.
- Decode and offline tempo preparation run on cancellable workers with per-Deck source revisions.
- `crates/kdj-player` owns dynamic prepared sources, a bounded command queue, reverse source-retirement acknowledgements and final device output.
- The audio callback receives fixed-size commands and stable PCM addresses. It does not allocate, lock, decode, perform IO, call Tauri or drop PCM.
- Desktop seek changes a prepared frame cursor. Repeated scrub commands are drained at one callback boundary, so the last target wins without rebuilding a compressed decoder.
- DJ handoff, equal-power gain, EQ/filter transitions, vocal cut and delay/tone effects run from the callback clock.
- BPM sync uses offline WSOLA. The realtime callback reads the prepared PCM at rate 1; it does not use sample stepping that would change pitch.
- CPAL output supports native `f32`, `i16` and `u16` devices.

The browser adapter remains for `npm` web development and temporary online streams. It is not the official local desktop playback engine. Android/iOS continue to use their system media engines for lifecycle and lock-screen playback; realtime mobile DJ remains out of scope until the Rust core is connected through the mobile shells.

The macOS incident that forced this migration is recorded in `docs/player-webkit-seek.md`.

## Ownership and lifetime rules

### Control actor

`DesktopPlayerHandle` owns a channel to one `PlayerActor`. The actor owns:

- the CPAL stream and `DynamicPlayer` controller;
- current/prepared Deck metadata;
- source and seek revisions;
- desired transport state while a decode is pending;
- state emission and device-error handling;
- shutdown ordering.

A newer load/prepare stores a new atomic Deck revision. Stale decode and WSOLA workers stop early; a completion that still arrives cannot install PCM or overwrite UI state.

### Prepared source bank

The control side retains each `Arc<DecodedTrack>`. It sends only an internal source ID and stable address through the ordered SPSC command queue. When the callback replaces a source, it sends the retired ID back on a second SPSC queue. Only the control side releases the `Arc`.

If the retirement queue is ever full, reclamation is delayed until shutdown instead of freeing memory on the realtime thread. Shutdown drops the device stream before the source registry.

Each prepared track is limited to 128 MiB, keeping two active Decks within the previous 256 MiB budget.

### Time mapping

WSOLA changes PCM duration while preserving pitch. UI time remains the original musical timeline:

```text
prepared_frame = logical_seconds * sample_rate / tempo_rate
logical_seconds = prepared_frame * tempo_rate / sample_rate
```

Cue points, waveform seeks and state events use logical seconds. The callback uses prepared frames.

## Platform policy

- **macOS:** CPAL/CoreAudio; WKWebView does not decode or output local library audio.
- **Windows:** the same engine through CPAL/WASAPI. `windows` and `windows-core` are pinned to the matching 0.61 line because CPAL 0.18's broad independent ranges otherwise resolve an invalid COM type combination.
- **Linux:** the same engine through the available CPAL host. Distribution audio-device packaging remains a platform build concern, not a separate player implementation.
- **Android/iOS:** system-native continuous playback remains active. Do not route a second Web Audio output alongside it.
- **Browser development:** Web Audio preview only. Browser behavior is not accepted as evidence for formal desktop audio timing.

## Remaining cleanup

1. Move the remaining browser-only `djEngine` orchestration out of `PlayerBar` into a dedicated browser-preview adapter module. Local Tauri playback already bypasses it, but the component still imports it for web development and online streams.
2. Add Windows and Linux runtime device tests in their native CI runners. The Windows `kdj-player` target currently type-checks from macOS; full `kdj-app` cross-check requires a Windows C toolchain for `ring`.
3. Measure command-to-audible latency with a loopback/device harness on each desktop OS. Unit tests prove callback ordering, not physical device latency.
4. Decide whether mobile realtime DJ is worth the JNI/FFI and interruption-policy cost. Do not duplicate the DSP in Kotlin or Swift.

## Acceptance gates

- Local desktop load/play/pause/seek/volume/end/error use the Rust owner.
- Prepared seek and handoff are committed on a callback boundary without a silent frame.
- Rapid seek/load/prepare adopts only the newest revision.
- Warm transport and prepared seek target <= 20 ms command-to-audible latency.
- BPM synchronization preserves pitch and maps the UI timeline back to the original track.
- Current DJ transition choices have native DSP equivalents; unsupported options must fail visibly rather than silently degrade.
- Device errors are emitted as player state and a later initialize can open a new default output.
- `npm run typecheck`, `npm run tauri:web:build`, `cargo test -p kdj-player`, `cargo test -p kdj-app --lib`, relevant target checks and `git diff --check` pass.
- Backend/config changes receive a full Tauri cold restart before validation.
