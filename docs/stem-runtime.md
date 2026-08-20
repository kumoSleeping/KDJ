# Native STEM runtime

STEM is off by default. The app-chrome selector chooses one locked ONNX set; loading a Deck while
the selector is `无` does not mount a scanner or model worker. Neither path launches Python,
Electron, or a sidecar. Decode, STFT/iSTFT, model scheduling, ratio masks, waveform publication,
ring buffering and mixing stay in Rust + ONNX Runtime.

| Mode | User lanes | Model files used for inference |
| --- | --- | --- |
| 无 | original mix only | none |
| Spleeter-4-FP16 | Drums / Bass / Other / Vocals | four FP16 U-Nets |
| ByteDance-MobileNet-2-FP32 | Instrumental / Vocals | one FP32 MobileNet_Subbandtime graph |

Retired settings values `two` and `two_int8` migrate to `mobile_net_two` when settings are loaded.

## Locked model sets

### Four-stem

The selected artifacts are the four ELU U-Nets published by
[`Best-Practice/spleeter-4stems-onnx`](https://huggingface.co/Best-Practice/spleeter-4stems-onnx),
pinned at Hugging Face revision `87c5b6d2874aeb8377b3dca27c9223aa252a6cdb`:

| Lane / artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `drums.fp16.onnx` | 19,714,140 | `7ae4002e5633634674f74dc3356d5875b0da894d59ce0f60e844bb8f9cb8aa92` |
| `bass.fp16.onnx` | 19,714,139 | `ba4c4949a27222492cca49859901a873b4b71461dc48c7c5a51f93d31eb11f55` |
| `other.fp16.onnx` | 19,714,140 | `3cc59116cb7195946ab9596d8ca25984d09c0f8a70db8cf85d063132f97bc61d` |
| `vocals.fp16.onnx` | 19,714,141 | `db47148ab1c52709ce694893f532c91abfe3edc4d46238939570e036a22878ca` |

The set is 78,856,560 bytes. Its cache identity is the SHA-256 of those exact files concatenated
in KDJ lane order (`Drums / Bass / Other / Vocals`):
`a9ef9575560b0d224dde174e886a09ee9b4e2b7fe537b040697446c5f8c8cf8f`.
Each file is self-contained; there is no external ONNX data sidecar.

The model manager downloads all four files into a staging directory, verifies every hash, then
atomically activates the complete directory. A partial set cannot make `GET /stems/model` report
`ready`. `KDJ_SPLEETER4_MODEL_DIR` can point to an already downloaded, hash-identical set for
offline development.

### ByteDance MobileNet_Subbandtime two-stem FP32

The source implementation is ByteDance
[`music_source_separation`](https://github.com/bytedance/music_source_separation) at commit
`e64b858cd14c3cc974826c51390399eef623dd2a` (Apache-2.0). The official MUSDB18 checkpoints are
Zenodo record [`5804160`](https://doi.org/10.5281/zenodo.5804160) (CC-BY-4.0). KDJ compared both
official 4,621,773-byte target checkpoints and selected accompaniment: the published SDR is
14.6 dB versus 7.2 dB for the vocals target, both had the same measured CPU cost, and on the KDJ
probe the independent estimates summed to the source within -35.16 dB relative error. Vocals is
therefore the exact residual `mixture - accompaniment`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `bytedance-mobilenet-subbandtime-accompaniment-3s-fp32.onnx` | 6,414,644 | `999ba99f306f09c9a35a18fe0007b53f8ad2c3cb5bb9d638128bf7257cd8e991` |

The graph accepts and returns float32 `(1, 2, 132300)` channel-major waveforms at 44.1 kHz. It
contains the official four-band PQMF and 512-point centred Hann STFT/iSTFT path; Rust does not
duplicate that transform. The direct output occupies Instrumental, Drums/Bass stay exact zero, and
the residual occupies Vocals. Offline development can set `KDJ_BYTEDANCE_MOBILENET_MODEL_DIR`.

## Tensor and signal contract

Every Spleeter U-Net has float32 I/O and internal FP16 weights:

```text
x: float32 [2, 1, 512, 1024]  channels / split / time / frequency
y: float32 [2, 1, 512, 1024]  one stem's magnitude estimate
```

Rust performs a 4096-point STFT at 44.1 kHz with hop 1024 and a **periodic Hann** window. The
fixed 527,360-sample input yields exactly 512 frames. Only bins `0..1024` enter the networks.

All networks in the selected mode must run for a tile. For each channel/time/frequency cell KDJ
computes the Spleeter soft ratio masks together:

```text
denominator = Σ estimate² + 1e-10
mask(stem)  = (estimate² + 1e-10 / active_lane_count) / denominator
```

The masks are applied to the original complex mixture, preserving its phase. The two-stem
Instrumental estimate occupies the realtime mixer's `Other` slot internally; Drums/Bass remain
exactly zero and are not shown. Bins 1024 through
2048 use each mask's per-frame mean (`average` extension), rather than dropping the band above
about 11 kHz. The active masks retain a unity partition, so summing neutral lanes reconstructs the
original mix instead of changing its level.

Decoded material above the FP16-safe operating level is attenuated only at the model-magnitude
boundary; reconstruction still uses the untouched mixture. If an internal FP16 activation still
produces a non-finite estimate, the complete FP16 tile retries at two lower model-only
gains before the live stream is allowed to fail. A recovered retry clears the transient scan
error instead of leaving that Deck permanently on ORG.

## Realtime tile adaptation

The Spleeter graphs keep their trained 512-frame input. KDJ does not shorten that tensor or
run whole-track `num_splits` batches. Each background call covers 11.96 seconds:

- 177,152 samples / 173 hops of left context;
- 173,056 samples / 169 hops (3.92 seconds) of retained PCM;
- 177,152 samples / 173 hops of right context.

Adjacent calls advance by the retained 169 hops. Only the context-safe centre enters playback;
the 100 ms linear handoff blends two estimates of the same source samples. The retained core stays
under the Deck's bounded four-second ring, while two look-ahead tiles keep the next eight seconds
on the accelerator so the playhead is not waiting on a single in-flight successor.

MobileNet uses its trained three-second window. Following ByteDance's reference separator, adjacent
windows overlap by 50%; KDJ discards 750 ms at each edge, retains the middle 1.5 seconds and keeps a
100 ms successor handoff tail. On the M2 isolated ORT CPU probe, steady three-second calls were
79.6–95.6 ms and the production pool's first tile including session load/warm-up was 238.1 ms. This
is ample background throughput, but it is not the separately admitted 512-frame HS-TasNet seek
layer and is not advertised as a hard realtime guarantee.

Inference never runs in the audio callback. Accelerator-capable non-macOS builds may use two
process-wide workers. macOS uses one shared FIFO worker for every ORT CPU model; one worker is
already fast enough for the measured two-Deck retained-core rate and avoids duplicated native
session arenas. Workers always dequeue mandatory audio before look-ahead and viewport fill. Audio
leases are not treated as queued work: after a short admission grace period, an otherwise idle
worker continues the visible scan even while both Decks are playing. This prevents the display
ticket from being permanently starved until a Deck stops. Eight-lane
Rubber Band is primed when the STEM stream is built, then
passthroughs at tempo 1.0 without `reset()` so the first TEMPO/SYNC move does not dump an unprimed
R3 session.
Queued/active model work and long server analysis now share the process-level policy and diagnostics
defined in [`work-scheduler.md`](work-scheduler.md); ORT sessions remain owned by this pool.

For a local Spleeter-4 Deck, an optional HS-TasNet seek layer keeps one CPU session per physical
Deck and preloads immutable 44.1 kHz stereo PCM for at most two tracks. The sessions exist to keep
Deck state independent; a process-wide admission token permits only one sustained 512-sample
instant stream. This is deliberate: the pinned M2 dual-session benchmark misses every 11.61 ms
deadline, so two simultaneous seeks cannot honestly be promised as two realtime separators.
When that layered path is available, the pool keeps one Spleeter refinement worker (still faster
than two Decks consume 3.92-second cores); while an instant stream is active, optional
look-ahead/fill yields.

Unknown STEM columns draw the original mix at low opacity until a separated block arrives, so a
playhead sitting on an unpublished tile is not a blank hole while the mix is still audible.

## Runtime ownership, switching, and unload

The process has one registered live inference pool. Model/status `GET` requests are observations
only; they cannot change the active runtime. The app sends an explicit runtime activation when the
top selector changes. A switch is serialized in this order:

1. cancel every display-scan generation and release its pool lease;
2. remove the old pool from the process registry and set its shutdown fence;
3. discard queued audio/look-ahead/fill jobs and clear the immutable tile/instant PCM LRUs;
4. join every Spleeter and HS-TasNet worker so its ORT sessions have actually dropped;
5. publish the new mode/compute preference, after which a Deck may create the replacement pool.

ORT does not expose safe cancellation for an inference already executing inside the native call.
The switch therefore waits for at most that current tile/hop, but workers never drain stale queued
tiles after shutdown and a second model is not loaded before the old sessions have left. Pool lease
guards carry a unique pool id, so a late guard from a retired generation cannot decrement or unload
a newer pool that happens to use the same path. Display tickets poll their scan generation and have
a ten-second failure fence; unmount/runtime cancellation therefore does not wait on an unbounded
channel receive, and an abandoned queued fill is cancelled before it can consume a later slot.

### Lifecycle/race log

Structured events use tracing target `kdj_stem_lifecycle` and correlate work by `pool_id`, physical
Deck, worker index, track id, stream revision and inference epoch. They cover runtime switch,
pool/lease creation and retirement, worker/session load and exit, PCM preload, job submission and
stale cancellation, and Deck source replacement. A five-second background sampler runs only while
a pool is active and logs process CPU, resident memory and physical footprint. It never runs in the
audio callback. macOS currently reports GPU telemetry as unavailable because production explicitly
uses ORT CPU and the crashing CoreML provider is disabled; the log says so instead of inventing a
GPU percentage.

## Cache miss and seek

Spleeter is non-causal. KDJ combines its delayed context-safe result with a seek-only causal layer;
neither model runs in the callback:

1. Loading a local track starts low-priority preparation around the current 30-second viewport.
2. Enabling Spleeter-4 STEM leaves ORG audible while the first context tile, whole-track random PCM
   cache and that physical Deck's HS session become ready. The PCM decode is a one-time background
   cost and is never repeated by an ordinary seek.
3. After at least 250 ms of refined PCM is buffered, the coordinator aligns the prepared stream to
   the advancing Deck clock and replaces ORG at an audio block boundary.
4. Seek/Hot Cue/SYNC on a warm Spleeter-4 Deck retargets the installed worker in place. Both the raw
   producer and Rubber Band worker acknowledge the new generation before target PCM is published.
   A cached Spleeter tile wins immediately; otherwise the admitted Deck emits context-safe
   HS-TasNet hops while the full Spleeter tile runs in parallel.
5. HS-TasNet output (`Drums/Bass/Vocals/Other`) is mapped once to KDJ lane order and hands off to
   Spleeter over 256 samples (5.8 ms). Only source samples not yet published in the new generation
   are refined.
6. If both Decks seek together, one obtains the instant token and the other folds original PCM
   equally into four temporary lanes until its FIFO refinement lands. The folded representation
   remains audible through non-unity eight-channel Rubber Band; per-lane controls are approximate
   during this explicit overload state. This keeps audio and transport continuous without claiming
   impossible dual-HS throughput. The other physical Deck is never torn down by its peer's request,
   failure or underrun.

Every seek first publishes a 250 ms target-position dry cushion. A warm, admitted HS hop has a
12 ms audio deadline; a late hop keeps dry PCM on the audible timeline instead of draining the
callback ring, while the non-preemptible call retains its admission token until that refinement
bridge ends. Spleeter-only modes retain their existing delayed shadow behavior.

## Platform selection

| Platform | Artifacts | Runtime |
| --- | --- | --- |
| macOS | selected FP16/FP32 set | ONNX Runtime CPU for `Auto`/`CPU`; in-process `GPU` unavailable |
| Windows | selected FP16/FP32 set | DirectML GPU for `GPU`; ONNX Runtime CPU for `CPU` |
| ARM64 Android | selected FP16/FP32 set | NNAPI GPU/NPU for `GPU`; ONNX Runtime CPU for `CPU` |
| iOS | none | not enabled |

The persisted device setting is `auto`, `gpu`, or `cpu`. On Windows and Android, `auto` tries the
platform accelerator and falls back to CPU if session creation or warm-up fails. `gpu` is strict:
failure leaves ORG audible and reports the error instead of silently changing device. `cpu` does
not register an accelerator execution provider.

On the tested macOS 26.5 / ORT stack, CoreML session creation/inference can terminate the process
with `EXC_BAD_ACCESS` before ORT returns an error; HS-TasNet independently crashes during session
creation. KDJ therefore never registers in-process CoreML there: `auto` is safe ORT CPU and explicit
`gpu` is a recoverable unavailable error. This also agrees with the M2 Spleeter-4 benchmark, where
CoreML CPU+GPU/ANE was slower than ORT CPU. Restoring macOS GPU safely requires an out-of-process
native model service so a provider crash cannot terminate the audio application.

`GET /stems/model` reports the actual runtime/provider, model load, first/last/P95 tile time,
processed tiles, tiles beyond the 3.92-second budget, output gaps and the latest runtime error. It
also reports instant model/session availability, PCM preload/cache reuse, first/last/P95 hop time,
late/failing instant hops and refinements deferred by the single-stream admission rule.

### Local HS-TasNet checkpoint boundary

The optional seek layer resolves `KDJ_HSTASNET_MODEL_DIR`, the compatibility variable
`KDJ_SEEKLAB_HSTASNET_DIR`, then `models/eaaba4f` beside the selected Spleeter model root. It
requires both `model.onnx` and `model.onnx.data` and always uses ORT CPU. CoreML is not attempted:
session creation for this graph crashes the tested ORT/CoreML combination.

The pinned hashes are in `research/stems/reference-lock.json`. Although the StemgenRT and
HS-TasNet source repositories are MIT, no artifact-specific training manifest or checkpoint
redistribution grant has been archived. KDJ therefore neither packages this 210 MB pair nor adds it
to the public model downloader. A missing local pair is a supported Spleeter fallback, not an
installation failure.

## License and attribution

The conversion repositories use Apache-2.0. The two-stem files are published by the sherpa-onnx
project; the four-stem port derives from it and adds the ELU activation required by Spleeter4.
The weights originate from Deezer Spleeter. Deezer's JOSS paper describes source and
pre-trained models as MIT-distributed, while the repository wording has a known unresolved
ambiguity about model weights. KDJ records that ambiguity rather than treating it as a current
non-commercial integration blocker. The files are downloaded at runtime and are not committed to
this repository. Attribution is also recorded in `THIRD_PARTY_NOTICES.md`.

## Isolated workstation

The Settings STEM debug workstation remains separate. The `stem-debug-onnx` Cargo feature still
gates its external research candidates; those candidates do not replace or satisfy either normal
Spleeter model installation.
