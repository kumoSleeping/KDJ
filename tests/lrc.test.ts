import assert from "node:assert/strict";
import test from "node:test";
import { activeLrcIndex, parseLrc } from "../src/lib/lrc";

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
