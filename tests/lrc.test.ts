import assert from "node:assert/strict";
import test from "node:test";
import {
  activeLrcIndex,
  lineFillProgress,
  parseLrc,
  parseNeteaseWordLrc,
  projectLoopedPlaybackTime,
} from "../src/lib/lrc";

test("LRC positive offset makes QQ lyrics appear sooner", () => {
  const lines = parseLrc("[offset:+500]\n[00:01.00]第一句\n[00:02.250]第二句", {
    honorOffset: true,
  });
  assert.deepEqual(lines, [
    { time: 0.5, text: "第一句" },
    { time: 1.75, text: "第二句" },
  ]);
  assert.equal(activeLrcIndex(lines, 0.49), -1);
  assert.equal(activeLrcIndex(lines, 0.5), 0);
});

test("LRC negative offset delays the complete timeline", () => {
  const lines = parseLrc("[offset:-750]\n[00:01.00]延后显示", { honorOffset: true });
  assert.deepEqual(lines, [{ time: 1.75, text: "延后显示" }]);
});

test("LRC without an offset keeps its original timestamps", () => {
  const lines = parseLrc("[offset:0]\n[00:01.2][00:03.045]重复句");
  assert.deepEqual(lines, [
    { time: 1.2, text: "重复句" },
    { time: 3.045, text: "重复句" },
  ]);
});

test("other lyric sources keep the previous offset behavior", () => {
  const lines = parseLrc("[offset:+500]\n[00:01.00]不主动改动其它来源");
  assert.deepEqual(lines, [{ time: 1, text: "不主动改动其它来源" }]);
});

test("empty timestamps clear the previous visible line", () => {
  const lines = parseLrc(
    "[00:01.00]最后一句\n[00:02.50]\n[00:05.00]下一句",
  );
  assert.deepEqual(lines, [
    { time: 1, text: "最后一句", endTime: 2.5 },
    { time: 5, text: "下一句" },
  ]);
  assert.equal(activeLrcIndex(lines, 2.499), 0);
  assert.equal(activeLrcIndex(lines, 2.5), -1);
  assert.equal(activeLrcIndex(lines, 4.999), -1);
  assert.equal(activeLrcIndex(lines, 5), 1);
});

test("NetEase YRC exposes real word intervals and explicit line duration", () => {
  const lines = parseNeteaseWordLrc(
    '{"t":0,"c":[{"tx":"作词"}]}\n' +
      "[1000,1200](1000,400,0)你(1400,800,0)好",
  );
  assert.deepEqual(lines, [
    {
      time: 1,
      endTime: 2.2,
      text: "你好",
      words: [
        { start: 1, end: 1.4, text: "你" },
        { start: 1.4, end: 2.2, text: "好" },
      ],
    },
  ]);
  assert.equal(lineFillProgress(lines, 0, 1.2), 0.25);
  assert.equal(lineFillProgress(lines, 0, 1.8), 0.75);
  assert.equal(activeLrcIndex(lines, 2.2), -1);
});

test("line-only lyrics use timestamp boundaries instead of character-count timing", () => {
  const lines = parseLrc("[00:01.00]只有行级时间\n[00:05.00]");
  assert.equal(lineFillProgress(lines, 0, 0.999), 0);
  assert.equal(lineFillProgress(lines, 0, 1), 0);
  assert.equal(lineFillProgress(lines, 0, 3), 0.5);
  assert.equal(lineFillProgress(lines, 0, 5), 1);
});

test("karaoke projection wraps active loops and becomes linear immediately on loop off", () => {
  assert.ok(Math.abs(projectLoopedPlaybackTime(11.95, 0.1, 1, 8, 4) - 8.05) < 1e-12);
  assert.ok(Math.abs(projectLoopedPlaybackTime(10.03, 0.1, 1, 10, 0.04) - 10.01) < 1e-12);
  assert.ok(Math.abs(projectLoopedPlaybackTime(11.95, 0.1, 1, null, null) - 12.05) < 1e-12);
});
