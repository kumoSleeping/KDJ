# SCNet Tran near-realtime feasibility

This note covers the selected `SCNet Tran ONNX 2.75s` candidate in the isolated Stem workstation.
It does **not** replace the current Deck Stem path. The measurements below were taken on the KDJ
development target: Apple M2 MacBook Air, 8 CPU cores (4 performance + 4 efficiency), 16 GB RAM,
ONNX Runtime CPU execution provider, four intra-op threads per session.

## Artifact and signal contract

- External file: `scnet-tran/scnet-tran-core-2.75s-v1.onnx`
- File size: 47,200,340 bytes (45.01 MiB)
- SHA-256: `e2c6e2807e1deb937150c2c2d21db57b597388a67460706242e6f23a2d8f9c56`
- Input: one 2.75-second stereo window, converted by KDJ to a normalized 4096-point rectangular
  STFT tensor.
- Output: actual Drums / Bass / Other / Vocals complex spectra, converted back to stereo PCM.
- Window length: 121,275 samples. The quality path uses 50% overlap, so a completed inference
  advances the usable output timeline by about 60,637 samples (1.375 seconds), not 2.75 seconds.
- Weight redistribution remains blocked until the checkpoint license and training-data terms are
  established. The artifact stays outside the repository and Tauri package.

## Measured CPU throughput

| Run | Audio represented | Wall/analysis time | Per-track RTF | ORT behavior | Result |
| --- | ---: | ---: | ---: | --- | --- |
| GUI single track | 30.0 s | 19.36 s | 0.645x | 23 chunks, 17.88 s total, 844 ms P95 | faster than playback |
| Direct single process | 20.0 s | 14.77 s | 0.738x | 16 chunks, 13.56 s total, 1,075 ms P95 | faster than playback |
| Two sessions in parallel | 20.0 s each | 25.71 s wall | 1.256x / 1.269x | 1,940 / 1,986 ms P95 | both fall behind playback |

For the parallel run, “40 seconds of aggregate source audio in 25.71 seconds” is not a successful
dual-Deck realtime result. Both Deck clocks advance simultaneously, so each must finish its own
20 seconds in no more than 20 seconds. They took about 25.1–25.4 seconds. A finite startup buffer
therefore drains during sustained dual playback.

A load-only probe created one ORT session in 227 ms and reached 150,487,040 bytes maximum resident
size (143.5 MiB). Actual inference is much heavier: the direct single-process render reached
2,317,549,568 bytes maximum resident and a 2.33 GB peak memory footprint. The two-session run
reached 3,895,607,296 bytes maximum resident and a 4.65 GB peak footprint. These inference peaks
include ORT execution workspaces and render buffers, not merely the 45 MiB weight file or loaded
session. Two sessions also kept all eight M2 CPU cores busy. The numbers are debug-build,
CPU-provider measurements and should be re-run for a release build and any future Core ML or
quantized export, but they rule out claiming the current artifact is a lightweight dual-Deck
realtime model.

## Float cache size

One stereo float32 lane costs `44,100 × 2 × 4 = 352,800` bytes per second. Four SCNet lanes cost
1,411,200 bytes/s (1.346 MiB/s):

| Material retained | Four Stem lanes | Debug export with original |
| --- | ---: | ---: |
| 10 seconds | 13.46 MiB | 16.82 MiB |
| 30 seconds | 40.37 MiB | 50.47 MiB |
| 1 minute | 80.75 MiB | 100.94 MiB |
| 3 minutes | 242.25 MiB | 302.81 MiB |
| 5 minutes | 403.75 MiB | 504.68 MiB |
| 1 hour | 4.73 GiB | 5.91 GiB |

The workstation intentionally writes five float WAVs so ORG and the four-lane sum can be audited.
A product cache does not need another original copy: the library already owns the source file. A
bounded 10-second four-Stem rolling buffer is about 13.46 MiB per Deck; a 30-second buffer is about
40.37 MiB per Deck. PCM16 would halve disk use, while lossless compression would vary with the
separated material and should be benchmarked before choosing a persistent cache format.

## Product boundary

The current artifact is suitable for a single-Deck, delayed near-realtime experience:

1. Start one 2.75-second analysis window and expose audio after roughly 0.8–1.1 seconds of CPU work.
2. Continue 50%-overlapped windows in the background and retain at least 10 seconds of separated
   PCM ahead of the playhead.
3. Treat a seek outside that buffer as a new roughly one-second preparation, not an instantaneous
   realtime operation.
4. Give a playing Deck priority. A second Deck may use a previously generated cache, but the
   current two-session CPU path must not promise indefinite simultaneous generation.

Sustained dual generation needs at least one further change and a fresh benchmark: a lower-overlap
quality mode, a dynamically batched export, quantization, Core ML/GPU execution, or pre-analysis of
one track. The selected candidate is not wired into Deck playback until that product behavior is
separately approved.
