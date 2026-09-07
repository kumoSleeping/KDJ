import assert from "node:assert/strict";
import test from "node:test";
import { formatBarCount, spacedRulerBeats, spacedRulerLabels, selectedBarCount } from "../src/lib/workstationRuler";
import type { WorkshopBeatGrid, WorkshopLayer } from "../src/types/workshop";

test("ruler labels and lines stay separated across zoom levels and long bar numbers", () => {
  const beats = Array.from({ length: 4000 }, (_, i) => ({ time: i * 500, source: i * 500, bar: 1000 + Math.floor(i / 4), downbeat: i % 4 === 0 }));
  for (const width of [0, 80, 320, 1800]) {
    for (const end of [4000, 40000, 2000000]) {
      const lines = spacedRulerBeats(beats, 0, end, width);
      for (let i = 1; i < lines.length; i++) assert.ok((lines[i].time - lines[i - 1].time) / end * width >= 12);
      const labels = spacedRulerLabels(lines.filter(b => b.downbeat).map(b => ({time: b.time, label: String(b.bar)})), 0, end, width);
      for (let i = 1; i < labels.length; i++) assert.ok(labels[i].left - labels[i - 1].left >= labels[i - 1].label.length * 7 + 20);
      assert.ok(labels.every(b => b.left + b.label.length * 7 + 6 <= width));
    }
  }
  assert.equal(spacedRulerBeats(beats, 0, 4000, 1000).length, 8, "zoom restores subdivisions");
  assert.ok(spacedRulerBeats(beats, 0, 2000000, 1000).every(b => b.downbeat), "overview retains only sparse bars");
});

test("tempo and bar labels share one collision-free row", () => {
  const tempos = [{time: 0, label: "202.99 BPM"}, {time: 1900, label: "120.00 → 180.00 BPM"}];
  const bars = Array.from({length: 20}, (_, i) => ({time: i * 250, label: String(135 + i)}));
  for (const width of [80, 320, 800, 1600]) {
    for (const start of [0, 100, 1700]) {
      const tempoLabels = spacedRulerLabels(tempos.map(t => ({...t, time: Math.max(start, t.time)})), start, 5000, width);
      const barLabels = spacedRulerLabels(bars, start, 5000, width, tempoLabels);
      const all = [...tempoLabels, ...barLabels].sort((a, b) => a.left - b.left);
      for (let i = 1; i < all.length; i++)
        assert.ok(all[i].left >= all[i - 1].left + all[i - 1].label.length * 7 + 20);
      if (width >= 320) assert.ok(tempoLabels.length, "BPM has priority over nearby bar numbers");
    }
  }
});

test("selected bars follow tempo changes, speed, partial beats and disjoint edits", () => {
  const grid: WorkshopBeatGrid = {
    analysis_revision: "v4", source_signature: "s", locked: false, beats_per_bar: 4,
    beats: [0, .5, 1, 1.5, 2, 3, 4, 5, 6], downbeats: [0, 2, 6], downbeat_confidence: 1,
    segments: [
      {start_seconds: 0, end_seconds: 2, bpm: 120, confidence: 1},
      {start_seconds: 2, end_seconds: 6, bpm: 60, confidence: 1},
    ],
  };
  // Counting only needs timing and speed; other clip properties are not read.
  const layer = { clips: [{start_ms: 1000, source_in_ms: 0, source_out_ms: 6000,
    speed: {preset: "constant", start: 2, middle: 2, end: 2, domain_start_ms: 0, domain_end_ms: 6000}}] } as WorkshopLayer;
  assert.equal(selectedBarCount(layer, grid, [[1000, 4000]]), 2);
  assert.equal(selectedBarCount(layer, grid, [[1000, 1250]]), .25);
  assert.equal(selectedBarCount(layer, grid, [[1000, 1125]]), .125);
  assert.equal(selectedBarCount(layer, grid, [[0, 1250], [3000, 4000]]), .75, "empty time is excluded");
  assert.equal(selectedBarCount(layer, grid, [[1000, 2000], [1500, 4000]]), 2, "overlapping ranges are counted once");
  assert.equal(formatBarCount(.25), "1/4");
  assert.equal(formatBarCount(1.125), "1 + 1/8");
  assert.equal(formatBarCount(2), "2");
  assert.equal(formatBarCount(.12345), "≈0.123");
});
