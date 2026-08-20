# ByteDance MobileNet_Subbandtime production evaluation

## Decision

The top-level SCNet-Tran production option was replaced by ByteDance's two-stem
`MobileNet_Subbandtime`. Historical SCNet research documents and the isolated STEM debug lab remain
research references; they are not selectable production runtimes.

Reference checkout: `/Users/kumo/Frameworks/music_source_separation`, cloned from
<https://github.com/bytedance/music_source_separation> at
`e64b858cd14c3cc974826c51390399eef623dd2a`. Relevant contracts are in
`bytesep/models/mobilenet_subbandtime.py` (three-second-capable stereo waveform model, four-band
PQMF, 512-point STFT) and `bytesep/separator.py` (50% window advance, middle-half retention).

## Artifact selection

Both official Zenodo 5804160 checkpoints were exported to fixed three-second FP32 ONNX and run on
the same 44.1 kHz stereo KDJ probe:

| Target checkpoint | Official size | Published SDR | Four ORT CPU calls |
| --- | ---: | ---: | --- |
| vocals | 4,621,773 B | 7.2 dB | 93.23 / 95.55 / 79.59 / 81.61 ms |
| accompaniment | 4,621,773 B | 14.6 dB | 90.61 / 89.81 / 80.38 / 82.39 ms |

The independent target outputs summed to the original at -35.16 dB relative error on the probe.
Because accompaniment has the higher published target SDR at the same runtime cost, KDJ ships that
graph and derives Vocals as `mixture - accompaniment`. This also makes neutral lane reconstruction
exact rather than relying on two independently trained masks.

The selected ONNX is 6,414,644 bytes with SHA-256
`999ba99f306f09c9a35a18fe0007b53f8ad2c3cb5bb9d638128bf7257cd8e991`. The Rust production-pool
probe completed its first tile, including session load and warm-up, in 238.1 ms and verified exact
two-lane reconstruction within `1e-6`.

## Capability boundary

This model has strong background throughput on the measured M2 and a much smaller artifact than the
removed SCNet graph. It remains a non-causal three-second window model. It does **not** replace the
separately admitted 512-frame HS-TasNet low-latency seek layer and is not advertised as a hard
realtime guarantee. Full measurements are in
`research/stems/results/m2-bytedance-mobilenet-subbandtime-2026-08-20.json`.
