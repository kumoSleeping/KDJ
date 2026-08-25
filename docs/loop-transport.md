# Auto Loop transport

## Behaviour

KDJ exposes one Auto Loop action per physical Deck:

1. With no active loop, pressing LOOP samples loop-in from the native audio callback clock.
   Quantize off preserves that exact frame; Quantize on floors the same sample to the preceding
   analysed beat without involving a WebView playhead.
2. Loop-out is loop-in plus the selected beat duration, represented as the half-open interval
   [in, out).
3. Pressing LOOP while active exits. The current cycle reaches out and then resumes the untouched
   linear stream after out.
4. Changing the beat count while active preserves in and changes only out.
5. A later LOOP press captures a new in-point. Disabled loops are not silently reactivated.
6. Explicit seek, source replacement, or track load clears the source-scoped loop.

The frontend never sends a playhead position. Mouse and MIDI use the same ordered toggle command,
and the native snapshot is the only owner of the active state and waveform overlay.

## Audio path

Loop is not implemented as repeated media seek.

- Encoded-media decoders continue reading linearly into the bounded raw PCM ring.
- The pitch-preserving worker retains two seconds of recent timed PCM. This covers the difference
  between the callback needle and worker read-ahead when LOOP is pressed.
- The worker captures one exact decoded PCM region from in (inclusive) to out (exclusive).
- A loop is capped at 32 seconds and all active Deck loop reservoirs share one 96 MiB budget;
  unusually high-rate STEM combinations are rejected before any allocation.
- At out it reads that region circularly through the same Rubber Band session. EQ, Deck gain,
  effects, tempo and STEM lane state are not rebuilt.
- Linear PCM after out stays queued in the raw ring. LOOP off finishes the current cached cycle and
  resumes that queue, so no decoder seek, source replacement, or trip to track zero can occur.
- Every post-stretch packet carries an exact fractional source clock plus loop generation and wrap
  edge. Desired commands cannot relabel PCM from an older cached window. The callback publishes
  only the generation that has reached the DAC-facing ring, including wrap and stall counters.
- The stereo post-tempo ring is 48 ms and the STEM ring is 160 ms. Rubber Band control blocks are
  capped at 512 source frames, and an active window interrupts obsolete output only once that PCM
  reaches loop-out; valid first-cycle audio is never dropped early.
- A 64-frame maximum cyclic bridge smooths a discontinuous PCM seam without changing loop length
  or mutating the retained source cache.

LoopWindow is a small seqlock. Odd revisions mean a write is in progress; workers only accept a
stable even revision and its matching in/out snapshot.

## Why the previous design failed

The former path had four independent owners: a frontend saved window, a coordinator polling the
playhead, a decoder parked at out and asynchronously seeked to in, and callback-side FIFO filtering.
Each observed a different clock (UI snapshot, rendered FIFO, decoder look-ahead, or device output).
A wrap consequently flushed buffers and reset time stretching; races could expose stale look-ahead,
loop-in, or the beginning of the track. Latches and special zero-position repairs treated symptoms
without removing the multiple authorities.

## External references

- Mixxx LoopingControl: nextTrigger returns loop-out and loop-in in audio-frame coordinates.
  https://github.com/mixxxdj/mixxx/blob/main/src/engine/controls/loopingcontrol.cpp
- Mixxx engine player guide: ReadAheadManager splits reads at loop boundaries and CachingReader
  warms loop targets before the callback needs them.
  https://github.com/mixxxdj/mixxx/wiki/Developer-Guide-Engine-Player
- Mixxx looping design: seeking from the callback is too late; the reader must cache the known loop
  region in advance.
  https://github.com/mixxxdj/mixxx/wiki/looping
- Serato Auto Loop: create in near the playhead, calculate out from the selected length, same button
  deactivates, and selecting a new length changes the active endpoint.
  https://support.serato.com/hc/en-us/articles/226382007-Auto-Looping
- Web Audio AudioBufferSourceNode loopEnd: the rendering source returns to loopStart at loopEnd.
  https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/loopEnd

No third-party source code is copied into KDJ; these references define behaviour and architecture.
