# Native STEM runtime

KDJ production STEM has one model: ByteDance MobileNet_Subbandtime two-stem FP32. There is no
global model selector. The model is prepared only when a Deck's compact STEM button in the EQ
panel is pressed; each Deck can be returned to the original mix independently. Decode, scheduling,
waveform publication and mixing remain in Rust + ONNX Runtime.

## Production artifact

The source implementation is ByteDance
[music_source_separation](https://github.com/bytedance/music_source_separation) at commit
e64b858cd14c3cc974826c51390399eef623dd2a (Apache-2.0). The selected MUSDB18 accompaniment
checkpoint is published in Zenodo record 5804160 (https://doi.org/10.5281/zenodo.5804160)
(CC-BY-4.0). Vocals is the exact residual mixture - accompaniment, which keeps neutral
two-lane reconstruction exact.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| bytedance-mobilenet-subbandtime-accompaniment-3s-fp32.onnx | 6,414,644 | 999ba99f306f09c9a35a18fe0007b53f8ad2c3cb5bb9d638128bf7257cd8e991 |

The model is downloaded into the versioned ByteDance directory, verified atomically, and can be
provided offline through KDJ_BYTEDANCE_MOBILENET_MODEL_DIR. No other model artifact is part of
the production catalog or downloader. Legacy none, four, two, and two_int8 settings are
normalized to the fixed ByteDance mode; they cannot reactivate a retired runtime.

## Tensor and lane contract

The graph accepts and returns float32 channel-major waveforms:

    input:  [1, 2, 132300]
    output: [1, 2, 132300]
    sample rate: 44100 Hz

The direct model output occupies KDJ's Instrumental/Other lane. Drums and Bass remain exact zero
lanes for the stable four-slot cache contract. Vocals is the residual. The fixed three-second
window retains the middle 1.5 seconds after 750 ms of context on both edges. Adjacent tiles use a
100 ms successor handoff to avoid boundary clicks.

Inference never runs in the audio callback. The background pool prioritizes audible tiles over
look-ahead and display fill; macOS uses the safe ONNX Runtime CPU path, while supported Windows and
Android builds may use DirectML or NNAPI according to the compute preference.

## UI and lifecycle

- The top STEM model switch is removed.
- The main mixer keeps only channel GAIN, HIGH/MID/LOW/FILTER and LEVEL. VOCALS no longer occupies
  an EQ knob; each Deck's third 3 FX slot defaults to the disabled VOCAL effect.
- Enabling VOCAL keeps the original source audible until the neutral separated reconstruction is
  ready, then its MIX slider controls VOCALS gain from mute to unity. The lower STEM strip remains
  the explicit separated-lane control; there is no Instrumental/Other reduction knob.
- Performance always renders the original waveform. VOCALS is the only optional separated rail;
  Instrumental/Other, Drums and Bass remain audio internals and are not published as waveforms.
- The scrolling Performance rails use the bounded three-screen canvas and compositor transform;
  sparse native clock samples retarget a projected runway instead of redrawing at display rate.
- A STEM button press downloads/prepares the fixed model when needed, mounts that Deck's live
  separator, or switches back to the original mix when already enabled.
- Unloading a Deck releases its display lease and cancels pending background work. Switching the
  compute preference retires the existing pool before the replacement can be created.

## License and attribution

The ByteDance source is Apache-2.0 and the selected checkpoint is CC-BY-4.0. KDJ is non-commercial;
attribution and checkpoint terms remain recorded in THIRD_PARTY_NOTICES.md. The model file is
downloaded at runtime and is not packaged into the application.
