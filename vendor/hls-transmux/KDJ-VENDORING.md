# KDJ hls-transmux patch

- Upstream: https://github.com/Logosww/hls-transmux
- Crate: `hls-transmux` 0.2.1 from crates.io.
- Published crate SHA-256: `97b8968f54f1e3f6f2503ce1323d4a110019fe4527b208b9167f430f85130e35`.
- License: MIT; original `LICENSE`, README, sources and test fixture retained.
- The root Cargo patch selects this source without changing the pinned version.
  KDJ still uses `default-features = false`; no decoder, FFmpeg or extra HTTP
  client is introduced.

## Local changes

Removed extra blank lines at EOF in `tests/ffmpeg_finalize.rs` and
`tests/ts_fixture.rs` for the repository whitespace gate.

`mpeg_ts.rs` / `transmux.rs`: the first TS segment (including the first-segment
re-read on resume) must still initialize both video and AAC tracks. Subsequent
segments may have samples for only one initialized track. This handles muxed VOD
whose audio/video ends at slightly different times without discarding the tail,
adding fabricated samples, or treating an incomplete initial layout as valid.
Empty/PSI-only segments and malformed TS/PES still fail closed. fMP4 input is
unchanged.

`crates/kdj-providers/tests/youtube_sparse_ts.rs`: in-memory integration tests
(also run by the normal workspace test pass) derived from the upstream fixture keep
PAT/PMT and select video-only or audio-only payloads, shifting PES timestamps for
the tail. They assert MP4 sample counts, not just successful completion. Both
positive cases reproduce the old missing-stream errors before the patch.
Negative cases cover missing initial tracks, PSI-only tails, truncated TS,
empty input and invalid sync data. No downloaded user media or credentials are
stored in fixtures.

Validation from the KDJ root:

```sh
cargo test -p kdj-providers --test youtube_sparse_ts
cargo test -p hls-transmux --lib
```

Remove the patch when an audited upstream release supports sparse TS segments
with equivalent initialization and invalid-input checks; keep the regressions.
