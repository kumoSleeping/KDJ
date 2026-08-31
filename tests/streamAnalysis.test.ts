import assert from "node:assert/strict";
import test from "node:test";
import {
  recordStreamAnalysisProgress,
  streamAnalysisPollDelay,
  streamAnalysisSnapshot,
  trackWithStreamAnalysis,
} from "../src/lib/streamAnalysis";
import {
  subscribeStreamCue,
  trackWithStreamCue,
  updateStreamCue,
} from "../src/lib/streamCue";
import {
  recordStreamCacheProgress,
  streamCacheProgressSnapshot,
} from "../src/lib/streamCacheProgress";
import { beatGridMarkers } from "../src/lib/performanceCues";
import type { StreamAnalysisResult, StreamWaveformProgress, Track } from "../src/types";

const emptyProgress = {
  enabled: true,
  waveform: null,
  covered_seconds: 0,
  revision: 0,
  complete: false,
  active: true,
} satisfies StreamWaveformProgress;

test("cache retry keeps polling while terminal failure releases the lease", () => {
  assert.equal(streamAnalysisPollDelay({
    ...emptyProgress,
    active: false,
    cache_status: "retrying",
    waveform_status: "partial",
  }, false, 750, 3_000), 750);
  assert.equal(streamAnalysisPollDelay({
    ...emptyProgress,
    active: false,
    cache_status: "failed",
    waveform_status: "partial",
  }, false, 750, 3_000), null);
  assert.equal(streamAnalysisPollDelay({
    ...emptyProgress,
    complete: true,
    active: false,
    cache_status: "ready",
    waveform_status: "failed",
  }, false, 750, 3_000), null);
});

test("old waveform progress keeps the compatible polling policy", () => {
  assert.equal(streamAnalysisPollDelay(emptyProgress, false, 750, 3_000), 750);
  assert.equal(streamAnalysisPollDelay({
    ...emptyProgress,
    active: false,
  }, false, 750, 3_000), 3_000);
  assert.equal(streamAnalysisPollDelay({
    ...emptyProgress,
    complete: true,
    active: false,
  }, false, 750, 3_000), null);
});

test("failed cache snapshots clear ghost bytes but retain partial waveform state", () => {
  const trackId = -98_761;
  recordStreamCacheProgress(trackId, {
    ...emptyProgress,
    cached_bytes: 2 * 1024 * 1024,
    total_bytes: 20 * 1024 * 1024,
    cache_status: "retrying",
    waveform_status: "partial",
  });
  assert.equal(streamCacheProgressSnapshot(trackId).cacheStatus, "retrying");

  recordStreamCacheProgress(trackId, {
    ...emptyProgress,
    active: false,
    cached_bytes: 0,
    total_bytes: 20 * 1024 * 1024,
    cache_status: "failed",
    cache_error: "range failed",
    waveform_status: "partial",
  });
  const failed = streamCacheProgressSnapshot(trackId);
  assert.equal(failed.cachedBytes, 0);
  assert.equal(failed.cacheStatus, "failed");
  assert.equal(failed.waveformStatus, "partial");
});

const result = {
  duration: 180,
  bpm: 128,
  bpm_raw: 128,
  bpm_confidence: 0.91,
  first_beat: 0.125,
  beat_times: [0.125],
  key: "A minor",
  key_short: "Am",
  camelot: "8A",
  open_key: "1m",
  key_confidence: 0.82,
  chroma: [],
  rms_db: -8.4,
  peak_db: -0.7,
  crest_db: 7.7,
  energy: 8,
  errors: [],
} satisfies StreamAnalysisResult;

test("stream analysis progresses from waiting to a retained ready snapshot", () => {
  const trackId = -98_765;
  assert.equal(streamAnalysisSnapshot(trackId).phase, "idle");

  recordStreamAnalysisProgress(trackId, {
    ...emptyProgress,
    analysis_status: "waiting",
    analysis: null,
    analysis_error: "",
  });
  assert.equal(streamAnalysisSnapshot(trackId).phase, "waiting");

  recordStreamAnalysisProgress(trackId, {
    ...emptyProgress,
    complete: true,
    active: false,
    analysis_status: "ready",
    analysis: result,
    analysis_error: "",
  });
  const ready = streamAnalysisSnapshot(trackId);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.result?.bpm, 128);
  assert.equal(ready.result?.camelot, "8A");
  assert.ok(ready.completedAt);
});

test("ready stream analysis becomes the Performance Deck BPM/key grid", () => {
  const trackId = -98_763;
  recordStreamAnalysisProgress(trackId, {
    ...emptyProgress,
    complete: true,
    active: false,
    analysis_status: "ready",
    analysis: result,
    analysis_error: "",
  });
  const track = {
    id: trackId,
    duration: 180,
    bpm: null,
    bpm_confidence: null,
    first_beat: null,
    music_key: "",
    camelot: "",
    open_key: "",
    key_confidence: null,
    energy: null,
    rms_db: null,
    peak_db: null,
    analyzed_at: null,
    analysis_error: "",
  } as Track;

  const analyzed = trackWithStreamAnalysis(track);
  assert.equal(analyzed.bpm, 128);
  assert.equal(analyzed.first_beat, 0.125);
  assert.equal(analyzed.camelot, "8A");
  assert.equal(analyzed.energy, 8);
  assert.ok(analyzed.analyzed_at);
  const markers = beatGridMarkers(
    analyzed.duration ?? 0,
    analyzed.bpm,
    analyzed.first_beat,
    0,
    8,
    analyzed.bpm_confidence,
  );
  assert.ok(markers.length > 4, "stream metadata drives the shared beat/bar renderer");
  assert.equal(markers[0]?.beat, 1);
  assert.equal(markers[4]?.bar, 2);
});

test("old backends without analysis fields do not erase a stream result", () => {
  const trackId = -98_764;
  recordStreamAnalysisProgress(trackId, {
    ...emptyProgress,
    complete: true,
    active: false,
    analysis_status: "ready",
    analysis: result,
    analysis_error: "",
  });
  recordStreamAnalysisProgress(trackId, emptyProgress);
  assert.equal(streamAnalysisSnapshot(trackId).phase, "ready");
});

test("stream cue points are session metadata and notify the mounted player", () => {
  const track = {
    id: -98_762,
    cue_ms: null,
    end_ms: null,
  } as Track;
  let notifications = 0;
  const unsubscribe = subscribeStreamCue(track.id, () => {
    notifications += 1;
  });

  updateStreamCue(track, { cue_ms: 12_500 });
  const withStart = trackWithStreamCue(track);
  assert.equal(withStart.cue_ms, 12_500);
  assert.equal(withStart.end_ms, null);

  updateStreamCue(withStart, { end_ms: 150_000 });
  const complete = trackWithStreamCue(track);
  assert.equal(complete.cue_ms, 12_500);
  assert.equal(complete.end_ms, 150_000);
  assert.equal(notifications, 2);
  unsubscribe();
});
