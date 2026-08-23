# Playback v2 migration

The previous whole-track desktop migration plan is superseded. The active design and execution map
is [`playback-v2-architecture.md`](./playback-v2-architecture.md).

## Active slice

- `crates/kdj-playback` owns command ordering, state sequences, Deck lifecycle and worker revisions.
- `crates/kdj-player` owns the realtime renderer, bounded source queues, DSP and CPAL desktop output.
- `src-tauri/src/desktop_player.rs` is only the Tauri adapter.
- `src/lib/unifiedPlayer.ts` is the sequenced frontend command client.
- `PlayerBar` renders state and supplies policy inputs; it does not output local desktop audio.

Ordinary load, predicted-next prewarm and seek now use bounded streaming Decks. They no longer wait
for full-track PCM or offline time stretching. Local desktop playback has no WebView audio fallback.

## Remaining work

1. Move recommendation and ended policy from `PlayerBar` into a Rust application service once the
   in-process library service is exposed to the coordinator.
2. Implement Android/iOS `PlaybackOutputFactory` adapters and bind their media-session,
   interruption and background policies without duplicating the coordinator.

Pitch-preserving Tempo/BPM Sync is complete in the active slice: stereo and eight-channel STEM
streams use the vendored Rubber Band 4 R3 real-time engine outside the callback.

User-side runtime checks are intentionally left to the project owner for this change.
