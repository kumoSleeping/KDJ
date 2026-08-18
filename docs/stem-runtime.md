# Native STEM runtime

KDJ's normal Performance path uses **SCNet Small**, not StemgenRT/HS-TasNet. It does not launch
Python, Electron, or a sidecar. Decode, 4096-point normalized STFT/iSTFT, fixed-tile scheduling,
waveform publication, ring buffering, transport generations and the four-lane mixer stay native.

## Locked model

The selected training checkpoint is ZFTurbo `v.1.0.6`
`scnet_checkpoint_musdb18.ckpt`:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| SCNet Small checkpoint | 42,434,986 | `1bc0d1abb20bfdf966dcd07637bafd03e4bc13653d09ef18bc9b3e342eafe2aa` |
| matching config | 1,739 | `19103def86d549701f824804fc5f3d244e8e8ccd4032da6ee9d5b4f2a5f2da16` |

Normal macOS playback downloads the reproducible native Core ML export from
`demixr/scnet-executorch` `v0.1.2`:

| Deployment artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `scnet_coreml.mlpackage.zip` | 34,543,230 | `d15357c0abc901defb76282178966b0c41cc3e7b9ad34a8a0fd4598b11043c2f` |

The exporter source is locked at `89f043bb939eb8726e9875d05e480b2a007fabc0`. The original SCNet
Google Drive checkpoint used by that exporter and ZFTurbo's release checkpoint have different
container hashes, but an explicit comparison found the same 372 tensor keys, shapes and values;
maximum tensor difference is exactly zero. The deployment model therefore uses the requested
ZFTurbo weights rather than a name-compatible substitute.

The old 201 MiB StemgenRT ONNX may remain in an existing data directory for research/history, but
its version directory and marker are no longer selected by `StemCoordinator`. It cannot make the
normal model endpoint report `ready`.

## Signal and scheduling contract

The fixed deployment input represents 343,980 samples (7.8 seconds) at 44.1 kHz:

- 85,995 samples of left context;
- 171,990 samples (3.9 seconds) of retained, context-safe PCM;
- 85,995 samples of right context.

Rust pads the fixed waveform to 345,088 samples and creates `[1, 4, 2049, 338]` normalized complex
spectra in `L.real / L.imag / R.real / R.imag` order. Core ML returns
`[1, 4, 4, 2049, 338]` in `Drums / Bass / Other / Vocals` order. Rust denormalizes and performs
iSTFT. Adjacent requests advance by 171,990 samples and use a 100 ms smooth linear partition at
the handoff; unlike equal-power blending, phase-aligned SCNet estimates stay at unity gain.

Inference never runs in the audio callback. One process-wide immutable model owner serializes
fixed tiles; Deck A/B keep independent decode cursors, epochs, output rings and seek generations.
Audible work overtakes look-ahead, which overtakes optional waveform fill. A completed tile is
published once and shared by playback and the four waveform lanes.

## Cache miss and Seek

SCNet is non-causal. KDJ therefore never treats a cache miss as a 512-sample realtime hop:

1. Loading a local track mounts low-priority preparation around the current 12-second viewport.
2. Enabling STEM while ORG is playing leaves ORG audible while the context tile is generated.
3. After at least 250 ms of separated PCM is buffered, the coordinator aligns the prepared stream
   to the advancing Deck clock and replaces ORG at an audio block boundary.
4. A Seek/Hot Cue outside prepared PCM invalidates the old Deck generation, lands on ORG, and
   repeats the same background preparation. A completed stale tile cannot publish into the new
   ring.
5. The other physical Deck is never torn down by this Deck's request, failure or underrun.

This is a quality-first delayed cache path. It does not claim `<30 ms` cache-miss Hot Cue latency.

## Waveforms

Waveform amplitudes use one shared scale across all four stems in a completed tile. A weak leaked
residual therefore stays weak instead of being independently normalized to full height. Colour is
still calculated from each stem's own PCM spectrum, not from a fixed source label.

## Platform selection

| Platform | Artifact | Runtime |
| --- | --- | --- |
| macOS | `scnet_coreml.mlpackage` | native Core ML, CPU + Apple GPU |
| Windows | `scnet_cpu.onnx` | ONNX Runtime, DirectML then CPU fallback |
| Android/iOS | not enabled by this desktop change | existing mobile work remains separately gated |

`GET /stems/model` reports the actual runtime/provider, model load, first/last/P95 tile time,
processed tiles, tiles beyond the 3.9-second budget, output gaps and the latest runtime error.

## Isolated workstation

The Settings STEM debug workstation remains separate. It is compiled only with the explicit
`stem-debug-onnx` Cargo feature and can then evaluate external research artifacts from
`KDJ_STEM_DEBUG_MODEL_DIR`; normal Tauri builds neither link ORT nor select those candidates.
