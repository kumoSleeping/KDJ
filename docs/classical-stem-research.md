# Classical STEM staged research plan

The acceptance question is deliberately narrow: can a model-free stereo algorithm provide useful
DJ vocal reduction with immediate seek recovery and ordinary-CPU realtime throughput? Modern AI
quality is not the target. Test A and Test B are implemented; later stages must be justified by an
audible improvement before being added to the product chain.

## Test order

| Test | Algorithm | Product status | Stop/go evidence |
| --- | --- | --- | --- |
| A | `(L+R)/2` centre extraction + exact residual | Research baseline | Establish leakage/artifact floor |
| B | Redress NQP spatial soft mask | Current product | User listening + metrics from the A/B tool |
| C | Redress + realtime F0 harmonic probability | Deferred | Must improve centred-vocal vs centred drums/bass cases |
| D | C + bounded Online REPET-SIM | Deferred | Must improve repeating EDM/loop accompaniment without seek warm-up |
| E | D + generalized Wiener refinement | Deferred | Must audibly reduce holes/phasiness within CPU budget |
| Offline | RPCA/Gammatone-WRPCA | Comparison only | Never blocks or ships in realtime playback |

## Test material

Use a small private set covering centred lead vocal, wide vocal, centre kick/bass, EDM, and
rock/live stereo. For every stage retain equal-length Vocal and Instrumental renders and record:

- wall time and realtime factor;
- process CPU ratio and estimated working memory;
- algorithmic latency and first tile time;
- first tile time after a midpoint seek/reset;
- audible musical noise, phasiness, spectral holes, vocal breakup, and centre-instrument leakage.

Do not report subjective quality as passed until the user listens at matched gains. Synthetic tests
only verify reconstruction, finiteness, seek determinism, and that Test B can beat Test A in a known
pan-pot mixture.

## 2026-08-22 M2 smoke result

Release-mode A/B used a generated 2.0 s stereo fixture: a centred 440 Hz component plus a 220 Hz
component panned with the same 1.0/0.35 ratio as the Redress trajectory test. This is a throughput
and wiring check, not a music-quality result.

| Stage | RTF | CPU ratio | Algorithm latency | First tile | Seek/reset first tile | Estimated work memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Center baseline | 0.0006 | 1.00 | 0 ms | 0.06 ms | 0.03 ms | 1.79 MiB |
| Redress soft mask | **0.436** | 0.99 | **23.22 ms** | **38.90 ms** | **39.69 ms** | 1.79 MiB |

The Tauri development runtime also completed real library waveform tiles with first block 56 ms,
P95 65 ms against a 92 ms tile budget, zero late tiles, and no model/runtime initialization. Dual
Decks use two bounded CPU workers. Listening acceptance remains with the user.

The final unsigned arm64 `KDJ.app` is 18,073,262 bytes. That is 17,453,680 bytes (49.13%) smaller
than the preceding neural-runtime workspace build. No new package was added; removing the neural
and retired optional beat-analysis paths removed 65 Cargo.lock package identities.

## Later-stage sources

- ADRess: Barry, Lawlor, Coyle, DAFx-04, “Sound Source Separation: Azimuth Discrimination and
  Resynthesis”.
- Redress: de Fréin 2020, DOI 10.3390/electronics9091373.
- REPET/REPET-SIM reference implementation: <https://github.com/zafarrafii/REPET-Python>. Only an
  online bounded-history adaptation is eligible for Test D.
- F0 candidates for Test C: YIN/pYIN, SWIPE, or McLeod Pitch Method. Selection requires a separate
  latency/CPU comparison; no tracker is preselected here.

No new dependency is introduced for Test A/B. A later external dependency is acceptable only when
its transitive package count, release binary delta, license, and measured CPU benefit are recorded.
