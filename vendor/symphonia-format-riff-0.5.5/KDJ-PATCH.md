# KDJ symphonia-format-riff 0.5.5 AIFF sound length

This directory is the unmodified crates.io source for `symphonia-format-riff 0.5.5` (the crate's
own `Cargo.lock` left out), except for `src/aiff/chunks.rs`, `SoundChunk::parse`.

An AIFF `SSND` chunk starts with two 32-bit fields, `offset` and `blockSize`, before the samples.
0.5.5 reads both and then takes the whole chunk length as the sound's, so the sound ends 8 bytes
past the chunk: the track states two frames more (16-bit stereo) and the decoder reads the next
chunk's header as audio — the `ID3 ` chunk Apple Music and most taggers put after the sound,
which made a click at the end of every tagged AIFF. The patch subtracts the 8 bytes.

KDJ turned symphonia's `aiff` feature on at the same time (kdj-player, kdj-analysis, kdj-media,
kdj-stems); before that no AIFF played at all. Drop this directory and the `[patch.crates-io]`
entry once an upstream release reads the chunk's length this way.

Upstream: https://github.com/pdeljanov/Symphonia (symphonia-format-riff)
License: MPL-2.0
