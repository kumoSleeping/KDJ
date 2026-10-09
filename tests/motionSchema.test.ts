import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
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
