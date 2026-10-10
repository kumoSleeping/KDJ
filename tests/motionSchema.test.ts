import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { reorderMoves } from "../src/lib/reorderMoves";
import {
  leaveAfterUnmount, MOTION_IN_MS, MOTION_MICRO_MS, MOTION_MICRO_OUT_MS, MOTION_OUT_MS, MOTION_REDUCED_MS,
  MOTION_STAGGER_TOTAL_MS,
} from "../src/lib/motion";

const css = fs.readFileSync(new URL("../src/motion.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const token = (name: string) => {
  const value = new RegExp(`--kd-motion-${name}:\\s*(\\d+)ms`).exec(css)?.[1];
  assert.ok(value, `--kd-motion-${name} is defined in ms`);
  return Number(value);
};

test("the script's durations are the stylesheet's tokens", () => {
  assert.equal(token("micro"), MOTION_MICRO_MS);
  assert.equal(token("micro-out"), MOTION_MICRO_OUT_MS);
  assert.equal(token("in"), MOTION_IN_MS);
  assert.equal(token("out"), MOTION_OUT_MS);
  assert.equal(token("reduced"), MOTION_REDUCED_MS);
});

test("a menu of any length has opened within the stagger budget", () => {
  const base = Number(/animation-delay:\s*calc\((\d+)ms/.exec(css)?.[1]);
  const steps = Math.max(...[...css.matchAll(/--kd-motion-i:\s*(\d+)/g)].map(match => Number(match[1])));
  const last = base + steps * token("stagger") + token("item");
  assert.ok(last <= MOTION_STAGGER_TOTAL_MS, `last item lands at ${last}ms`);
  assert.ok(MOTION_STAGGER_TOTAL_MS <= 220);
});

test("every keyframe block names both ends and moves only transform and opacity", () => {
  const blocks = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)];
  assert.ok(blocks.length >= 10);
  for (const [, name, body] of blocks) {
    assert.match(name, /^kd-motion-/, `${name} is namespaced`);
    assert.match(body, /\bfrom\s*\{/, `${name} has from`);
    assert.match(body, /\bto\s*\{/, `${name} has to`);
    for (const [, property] of body.matchAll(/([\w-]+)\s*:/g)) {
      assert.ok(["transform", "opacity", "clip-path"].includes(property), `${name} animates ${property}`);
    }
  }
});

test("a removed surface comes back as an inert picture and then goes; one that stays is left alone", async () => {
  const dom = new JSDOM('<div id="host"><div id="menu" data-kd-motion="unfold" style="position: fixed"><button id="item">A</button></div><p id="after"></p></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, getComputedStyle: dom.window.getComputedStyle });
  // JSDOM has no animation engine; the helper takes that as "do not animate".
  (dom.window.HTMLElement.prototype as unknown as { animate: unknown }).animate = () => ({});
  try {
    const host = document.getElementById("host")!;
    const menu = document.getElementById("menu")!;

    // StrictMode replays an effect's cleanup on an element that is not removed.
    leaveAfterUnmount(menu);
    await Promise.resolve();
    assert.equal(menu.hasAttribute("data-kd-leaving"), false);

    leaveAfterUnmount(menu);
    menu.remove();
    assert.equal(host.contains(menu), false);
    await Promise.resolve();
    assert.equal(menu.parentNode, host, "put back where it was");
    assert.equal(menu.nextElementSibling?.id, "after");
    assert.equal(menu.getAttribute("data-kd-leaving"), "true");
    assert.ok(menu.hasAttribute("inert"));
    assert.equal(menu.getAttribute("aria-hidden"), "true");
    assert.equal(menu.id, "", "ids are dropped: the owner may already have rendered the next one");
    assert.equal(menu.querySelector("[id]"), null);

    const ended = (animationName: unknown) =>
      menu.dispatchEvent(Object.assign(new dom.window.Event("animationend", { bubbles: true }), { animationName }));
    ended("kd-motion-unfold");
    assert.equal(menu.isConnected, true, "the late end of its arrival does not take the picture away");
    ended(getComputedStyle(menu).animationName);
    assert.equal(menu.isConnected, false, "gone when the leaving gesture has ended");

    // An element in the flow would hold its place open: it is not brought back.
    const inline = document.createElement("div");
    host.append(inline);
    leaveAfterUnmount(inline);
    inline.remove();
    await Promise.resolve();
    assert.equal(inline.isConnected, false);
  } finally { dom.window.close(); }
});

test("a reorder names the rows that changed places, by how many, and the one that travelled", () => {
  const moves = (before: string, after: string) => {
    const { places, lead } = reorderMoves(before.split(""), after.split(""));
    return { places: Object.fromEntries(places), lead };
  };
  // The fourth playlist was opened and goes to the front: it went up three, three went down one.
  assert.deepEqual(moves("abcde", "dabce"), { places: { d: 3, a: -1, b: -1, c: -1 }, lead: "d" });
  // The first one was opened again: nothing moves.
  assert.deepEqual(moves("abcde", "abcde"), { places: {}, lead: null });
  // Two were opened during the wait and resolve in one go; the one that went furthest leads.
  assert.deepEqual(moves("abcde", "ecabd"), { places: { e: 4, c: 1, a: -2, b: -2, d: -1 }, lead: "e" });
  // The second goes first: the two swap, the one that went up leads.
  assert.deepEqual(moves("ab", "ba"), { places: { b: 1, a: -1 }, lead: "b" });
  // A playlist that came or went shifts the rest without anyone having been moved.
  assert.deepEqual(moves("abc", "xabc"), { places: {}, lead: null });
  assert.deepEqual(moves("abcd", "acd"), { places: {}, lead: null });
  assert.deepEqual(moves("abcd", "xcabd"), { places: { c: 2, a: -1, b: -1 }, lead: "c" });
  assert.deepEqual(reorderMoves([], []), { places: new Map(), lead: null });
});

test("the sidebar's and the list's motion moves only transform, opacity and the clip, on the shared clock", () => {
  // The sidebar keeps its keyframes; the list's gesture is the shared one of motion.css, and its own sheet only has the Sakura98 tick.
  for (const [file, own] of [["../src/components/library/FolderTree.css", 4], ["../src/components/library/ListArrival.css", 1]] as const) {
    const sheet = fs.readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = [...sheet.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)];
    assert.ok(blocks.length >= own, `${file} has its keyframes`);
    for (const [, name, body] of blocks) {
      assert.match(body, /\bfrom\s*\{/, `${name} has from`);
      assert.match(body, /\bto\s*\{/, `${name} has to`);
      for (const [, property] of body.matchAll(/([\w-]+)\s*:/g)) {
        assert.ok(["transform", "opacity", "clip-path", "scale", "translate"].includes(property), `${name} moves ${property}`);
      }
    }
    // Durations come from the tokens: no literal milliseconds on an animation of these sheets,
    // except the stagger steps and the stepped Sakura98 ticks.
    for (const [, value] of sheet.matchAll(/animation(?:-duration)?:\s*([^;]+);/g)) {
      for (const [, ms] of value.matchAll(/(?<![\w-])(\d+)ms/g)) assert.ok(Number(ms) <= 120, `literal ${ms}ms in "${value.trim()}"`);
    }
  }
});

test("a presented list is one gesture: the search results and the local list take it from the schema", () => {
  const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const results = read("../src/components/download/ResultTable.css");
  const local = read("../src/components/library/ListArrival.css");
  for (const [name, sheet] of [["the search results", results], ["the local list", local]] as const) {
    assert.match(sheet, /animation:\s*kd-motion-list-rise\s+var\(--kd-motion-list-row\)\s+var\(--kd-ease-list\)/, `${name}: rows rise on the shared clock`);
    assert.match(sheet, /animation:\s*kd-motion-list-cover\s+var\(--kd-motion-list-cover\)\s+var\(--kd-ease-list-cover\)/, `${name}: covers follow`);
    assert.match(sheet, /var\(--kd-motion-list-cover-after\)/, `${name}: a cover is a beat behind its row`);
    assert.doesNotMatch(sheet, /@keyframes\s+kd-(?:result|list)-(?:rise|cover)(?![\w-])/, `${name} has no copy of the keyframes`);
  }
  for (const name of ["rise", "drop", "cover"]) assert.match(css, new RegExp(`@keyframes\\s+kd-motion-list-${name}\\b`));
  // The beats the results write out row by row are the lead and the step the local list computes with.
  const lead = token("list-lead"), step = token("list-step");
  // The results mark each row with its step (resultArrival.ts): data-reveal="0" is the first row.
  const beats = [...results.matchAll(/\[data-reveal="(\d+)"\]\s*\{\s*--kd-reveal-at:\s*(\d+)ms/g)].map((match) => [Number(match[1]) + 1, Number(match[2])]);
  assert.equal(beats.length, 14);
  for (const [row, at] of beats) assert.equal(at, lead + (row - 1) * step, `row ${row} of the results starts on the shared beat`);
  // Rows past the cascade: a frame after the last staggered one, in both lists.
  assert.equal(Number(/--kd-reveal-at:\s*(\d+)ms/.exec(results)?.[1]), lead + 13 * step + 16);
  assert.match(local, /var\(--kd-motion-list-lead\) \+ var\(--kd-arrive-i, 0\) \* var\(--kd-motion-list-step\) \+ 16ms/);
});
