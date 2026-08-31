# Playback v2 ownership and execution map

## Non-negotiable ownership

Local playback state no longer belongs to React, an `HTMLAudioElement`, or a Tauri command
handler. `kdj-playback::PlaybackCoordinator` is the sole writer of transport state. The frontend
submits intent and renders snapshots; platform adapters serialize commands, emit snapshots and
provide device/media-session integration.

```text
PlayerBar view
  -> DesktopNativePlayer command client
  -> Tauri playback_command (immediate CommandAck)
  -> kdj-playback PlaybackCoordinator actor
       -> bounded decode workers (generation fenced)
       -> kdj-player realtime command/source queues
       -> CPAL callback
  <- playback-state { sequence, phase, desiredPlaying, clock, ... }
```

Every accepted command and emitted state has a monotonic sequence. Invoke replies and Tauri events
may cross in transit; clients accept only the newest sequence. Decode/seek workers carry a per-Deck
revision and cannot install after replacement.

## State model

`PlaybackPhase` names the lifecycle instead of inferring it from unrelated booleans:

- `idle`: no source
- `loading`: target accepted; bounded read-ahead is filling
- `ready`: source installed but not running
- `playing` / `paused`: stable transport
- `seeking`: a shadow Deck is filling at the requested position
- `transitioning`: both Decks are driven by the callback clock
- `ended`: active stream reached EOF and drained
- `error`: actionable device/decode failure

`desiredPlaying` is the user's latest intent and drives the button. `isPlaying` is callback truth.
They are deliberately separate; collapsing them is what allowed a stale hardware snapshot to undo
a pause click.

## Source pipeline

Ordinary playback uses `StreamSource`, a fixed-size SPSC ring of stereo frames resampled on a
worker to the active output rate. Memory is bounded by read-ahead seconds, not track duration.
The callback is the only consumer and never allocates, locks, decodes or performs IO.

- Load prepares the inactive Deck while the old Deck remains valid.
- Local files and online previews use the same bounded PCM Deck. Online encoded bytes come only
  through the app's loopback proxy via a seekable HTTP Range adapter; provider/CDN credentials stay
  in `kdj-server`.
- Predicted/queued tracks pre-read into the inactive Deck without consuming frames.
- Seek creates a new generation at the target position and switches only after startup buffering.
- A later request invalidates the worker fence; its late result is ignored.
- Full decoded PCM remains available to specialist/offline paths, but is no longer a prerequisite
  for play, pause, ordinary skip or seek.
- Each installed Deck also owns two fixed 12-second raw-stereo scratch windows. A background
  seekable decoder fills the inactive window around the needle and atomically publishes it; reverse
  cache misses retain hand velocity and resume when data arrives. Release retargets the installed
  worker in place and crossfades only after matching media-time PCM reaches the callback.

Streaming pitch-preserving tempo conversion runs through the vendored Rubber Band 4 R3 engine on a
bounded worker between the decoder's four-second raw PCM ring and a 96 ms ordinary / 160 ms STEM
callback-facing ring. Every R3 state is short-window configured and primed once at construction;
unity PCM still bypasses processing, while the first non-unity fader packet no longer resets and
replans the engine. Tempo controls use a 16 ms latest-value lane and R3 samples them on bounded
512-frame source blocks. The callback still pops one hardware-rate PCM frame with no C++ call,
allocation, lock, decoder reset, or pitch-changing resample. Real-time start padding, output-delay
trimming, EOF drain and explicit seek reset are owned by the worker adapter.
The two physical Deck targets and background-analysis admission are coordinated by
[`work-scheduler.md`](work-scheduler.md). Dense MIDI/slider changes are latest-value coalesced, and
crossing the unity detent does not reset the already-primed R3 stream.

Each post-stretch ring packet also carries the source-frame advance represented by that rendered
PCM frame. The callback advances its published playhead from this value, not from the newest UI
target, so audio already queued at the previous rate cannot make Sync/beat-grid clocks jump ahead.
Explicit seek generations invalidate already-rendered packets. Auto Loop is not a seek: Rust
captures its in-point from the callback clock, the worker retains a bounded decoded-PCM history,
and one cached half-open region is read circularly while linear decode remains parked at loop-out.
The complete transport invariants and research references are documented in
[loop-transport.md](loop-transport.md).

Ordinary sources enter one two-channel R3 session. A live STEM source enters one eight-channel R3
session (Drums/Bass/Other/Vocals × left/right), so all lanes share the same stretch decisions and
remain phase/time coherent. STEM mute and gain ramps stay in the callback after stretching and do
not rebuild the processor. The short final ring keeps fader response bounded while the raw ring
retains disk/network jitter headroom.

## Platform boundary

Shared Rust owns commands, queue/prewarm, Deck lifecycle, decode, resampling, clocks and DSP.

- macOS/Windows/Linux: CPAL selects CoreAudio, WASAPI or the available Linux host. The Tauri
  adapter mirrors coordinator snapshots into MPNowPlaying/SMTC/MPRIS. Position, volume and
  play/pause commands use the coordinator; next/previous still cross the frontend once for its
  candidate-selection policy and return through the sequenced command lane. The toolbar, media
  keys and configured fade therefore share one transport path. Artwork is downloaded off the
  playback thread and exposed to all three system APIs as a local `file://` cache URL. Local and
  online tracks share this owner; system controls no longer choose between native and Web Audio
  clocks.
- Android: transport shares the desktop coordinator + CPAL/AAudio (`playback_*` commands).
  `android_media` mirrors snapshots into Kotlin (`applyPlaybackSnapshot`) for MediaSession,
  foreground service, audio focus and lyrics-overlay clock; remote keys return through JNI
  `NativeAudioBridge` → `submit_platform` (next/prev still emit `desktop-media-control`).
- iOS: the adapter owns AVAudioSession, Now Playing and remote-command policy (still AVPlayer until
  the same coordinator cut-over).

Mobile adapters may require AudioUnit/AAudio/Oboe bridges for final PCM. They must not duplicate the
coordinator state machine in Kotlin or Swift. Android currently reuses `CpalOutputFactory` (AAudio).

## Implementation order

1. Replace the decode-blocking desktop actor with the coordinator and sequenced contract.
2. Put ordinary load, prewarm and seek on bounded streaming Decks.
3. Route the Tauri desktop adapter and `DesktopNativePlayer` through one command endpoint.
4. Stop Web Audio from owning formal playback in a native shell; keep it only for the standalone browser-development adapter.
5. Move recommendation/ended policy into the Rust application service when the library service is
   exposed in-process, then delete the remaining PlayerBar policy continuations.
6. Implement Android/iOS output and media-session adapters against `PlaybackOutputFactory` without
   copying the coordinator.

Steps 1–4 are the first vertical slice. Steps 5–6 are explicit remaining boundaries, not silent
fallbacks to the old WebView owner.

## Frontend boundary

Desktop and Android playback—local files and online previews alike—must go through `UnifiedPlayer`'s
`DesktopNativePlayer`. Browser/Web Audio is only the standalone browser-development adapter. A
native decode/network failure is visible; it must not silently create a second WebView audio owner.

The remaining PlayerBar cleanup is policy migration: automatic recommendation selection and ended
handling still originate in shared UI code. They should move behind coordinator queue commands once
the Rust library-selection service is exposed directly to the application layer.

### Track/source normalization

Frontend surfaces must not implement local and provider-stream Decks as separate
feature branches. `src/lib/playbackTrack.ts` is the adapter boundary:

1. `PlaybackTrackRequest` normalizes a database id, an existing `Track`, or a provider
   `SongSource` into one `Track` identity.
2. `playbackSourceForTrack` performs lazy remote URL resolution and returns the same
   `UnifiedPlayerSource` used by every coordinator load.
3. `hydratePlaybackTrack` and `subscribePlaybackTrackMetadata` expose one BPM/key/downbeat
   contract. Whether the values came from the library DB or temporary stream analysis is hidden
   from Performance UI.

After a load, `deckTrackBinding.ts` binds Track metadata to the coordinator's physical A/B
`trackId`s. Retained rows, provider promises and React snapshots are candidates only; they can
never address a side whose physical identity differs. Continuous controls carry the expected
binding id and silently discard an obsolete generation rather than reporting a false Deck
mismatch during a load acknowledgement.

Waveform acquisition remains source-adapted, but the renderer consumes only the canonical
`Waveform` shape. Progressive coverage lives in `Waveform.known`; unknown columns stay empty and
do not create a stream-only centre rail. Canvas rendering, viewport motion, scratching, cue/loop
markers and beat-grid rendering are therefore shared by every source.
