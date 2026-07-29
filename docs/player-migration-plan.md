# Unified player migration

## Goal

Move playback ownership out of React and expose one typed player contract to the UI and the Tauri backend. Mobile playback must survive WebView suspension; existing desktop DJ behavior must not disappear during migration.

## Runtime boundary

```text
PlayerBar / media sync / shortcuts
              |
       UnifiedPlayer contract
        /                 \
DesktopDjAdapter       MobileNativeAdapter
(existing Web Audio)   Android Media3 / iOS AVPlayer
```

The contract owns source metadata, play/pause, seek, rate, volume, progress, duration, ended and error state. React renders state and does not decide which platform engine performs an operation.

The contract exposes two execution modes without splitting UI state:

- `continuous`: OS-native buffered playback for reliable foreground/background listening.
- `realtime-dj`: prewarmed dual-deck output for cueing, scrubbing and sample-clock handoff.

Media3/AVPlayer alone are not accepted as the DJ execution engine because an encoded-stream seek can rebuild buffers and create an audible hole.

## Stages

1. **Boundary and mobile reliability**
   - Add the typed unified-player contract.
   - Register native mobile playback through a Tauri plugin.
   - Android: Media3 `ExoPlayer` in `MediaSessionService`, foreground media notification, audio focus and wake mode.
   - iOS: `AVPlayer`, playback `AVAudioSession`, Now Playing and remote commands.
   - Keep the existing desktop DJ engine behind the desktop adapter.
   - Disable Web Audio/whole-track PCM preparation on mobile.

2. **PlayerBar ownership cleanup**
   - Move source, transport, seek and state synchronization from `PlayerBar` into the contract.
   - Keep DJ-only transition decisions in the DJ adapter until the native/Rust engine has equivalents.

3. **Shared Rust DSP engine**
   - Build the lock-free transport/mixer boundary in `crates/kdj-player`; only fixed-size commands may enter the audio callback.
   - Reuse Symphonia and Rubato for decoding/resampling.
   - Add an owned real-time output/mixer boundary (AAudio/CoreAudio/WASAPI/PipeWire through the narrowest maintained backend).
   - Keep both decks prewarmed; cue/seek prepares the target deck and switches on the sample clock instead of stopping the audible deck first.
   - Port double-deck faders and effects incrementally with focused mixer unit tests.
   - Connect the Rust engine to Android/iOS lifecycle shells through JNI/FFI only after parity is demonstrated.

4. **Retire Web Audio playback ownership**
   - Switch desktop to the shared Rust engine.
   - Switch mobile foreground DJ mode after parity and interruption tests.
   - Remove the old playback path only when no active caller remains.

## Acceptance gates

- Android playback remains continuous with screen locked and app backgrounded.
- Lock-screen/notification play and pause update the UI after resume.
- Basic load/play/pause/seek/rate/volume/end/error behavior remains available.
- Existing desktop DJ transitions remain available during stages 1–3.
- Drag preview updates within one rendered frame (target <= 16 ms at 60 Hz).
- A warm play/pause operation targets <= 20 ms command-to-audible response.
- A prepared cue/seek targets <= 20 ms command-to-audible target; compressed cold seeks are measured separately and must use shadow-deck handoff so the outgoing sound does not drop while decoding.
- Basic timing checks use the native audio callback clock; a React state update is not counted as audio response.
- `npm run typecheck`, `npm run tauri:web:build`, relevant Cargo checks and an Android release build pass.
- Current Android universal APK baseline: approximately 16 MiB. Target: no more than 20 MiB and preferably no more than +3 MiB. Dependency trimming is required if either budget is exceeded.
