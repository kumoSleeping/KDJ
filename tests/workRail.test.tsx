import assert from "node:assert/strict";
import test, { before } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, StrictMode, type ReactNode } from "react";
import type { FolderNode, FolderTree, IntakeItem, LibraryStats, MergedGroup, SongSource, StreamPlaylist } from "../src/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
dom.window.HTMLMediaElement.prototype.pause = () => {};
dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;

/**
 * JSDOM animates nothing, and then a turn is over within the commit that began it. This stands
 * in for the engine: an item marked `data-kd-turn` (or `data-kd-turn-shift`) has one animation
 * that ends when the test says so.
 */
const engine = {
  on: false,
  running: new Map<Element, { mark: string; done: boolean; end(): void; finished: Promise<void> }>(),
  async finish(mark: "in" | "out" | "shift") {
    await act(async () => {
      for (const [node, animation] of this.running) {
        if (animation.mark !== mark) continue;
        animation.end();
        // An arrival that has ended fills nothing: the element is free to arrive again later.
        if (mark !== "out") this.running.delete(node);
      }
      await Promise.resolve();
    });
  },
};
const markOf = (node: Element) => node.getAttribute("data-kd-turn") ?? (node.hasAttribute("data-kd-turn-shift") ? "shift" : null);
(dom.window.HTMLElement.prototype as unknown as { getAnimations(): unknown[] }).getAnimations = function (this: HTMLElement) {
  const mark = markOf(this);
  if (!engine.on || !mark) return [];
  let animation = engine.running.get(this);
  if (!animation || animation.mark !== mark) {
    let end = () => {};
    const finished = new Promise<void>((resolve) => { end = resolve; });
    const entry = { mark, done: false, end: () => { entry.done = true; end(); }, finished };
    animation = entry;
    engine.running.set(this, entry);
  }
  return [{ animationName: `kd-motion-turn-${mark}`, finished: animation.finished }];
};
// A layout of sorts: every item on the strip is ten pixels a character wide and follows the one before.
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetLeft", {
  get(this: HTMLElement) {
    let left = 0;
    for (const node of this.closest(".kd-activity")?.querySelectorAll("[data-rail-slot]:not([hidden])") ?? []) {
      if (node === this) break;
      left += (node.textContent ?? "").length * 10;
    }
    return left;
  },
});

// Loaded after the globals above exist.
let createRoot: typeof import("react-dom/client").createRoot;
let WorkRail: typeof import("../src/components/chrome/WorkRail").WorkRail;
before(async () => {
  ({ createRoot } = await import("react-dom/client"));
  ({ WorkRail } = await import("../src/components/chrome/WorkRail"));
});

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    async render(node: ReactNode) { await act(async () => { root.render(node); }); },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}
const slots = (host: Element) => [...host.querySelectorAll("[data-rail-slot]")].map((node) => {
  const mark = node.getAttribute("data-kd-turn");
  return `${node.textContent}${mark ? `:${mark}${(node as HTMLElement).style.getPropertyValue("--kd-turn-step")}` : ""}${node.hasAttribute("hidden") ? ":hidden" : ""}`;
});
const slot = (host: Element, text: string) =>
  [...host.querySelectorAll<HTMLElement>("[data-rail-slot]")].find((node) => node.textContent === text && node.getAttribute("data-kd-turn") !== "out");
const text = (key: string, value = key) => h("span", { key, className: "kd-activity-text" }, value);
const glyph = (key: string) => h("i", { key }, `(${key})`);
const rail = (glyphs: string[], texts: Array<string | [string, string]>, tools: string | null = "tools", extra: Record<string, unknown> = {}) =>
  h(WorkRail, {
    label: "rail",
    glyphs: glyphs.map(glyph),
    texts: texts.map((item) => (typeof item === "string" ? text(item) : text(item[0], item[1]))),
    trailing: tools ? h("button", { type: "button" }, tools) : undefined,
    ...extra,
  });

test("without an animation engine the strip simply shows what is wanted", async () => {
  engine.on = false;
  const view = mount();
  await view.render(rail(["g"], ["name:a", "count"]));
  assert.deepEqual(slots(view.host), ["(g)", "name:a", "count", "tools"]);
  await view.render(rail(["w"], ["progress"]));
  assert.deepEqual(slots(view.host), ["(w)", "progress", "tools"]);
  assert.equal(view.host.querySelector("[inert]"), null);
  await view.unmount();
});

test("a turn: the leaving items are inert pictures, the new ones wait for them, what stays is not touched", async () => {
  engine.on = true;
  const view = mount();
  await view.render(rail(["g"], ["name:a", "count:a"]));
  assert.deepEqual(slots(view.host), ["(g):in0", "name:a:in1", "count:a:in2", "tools:in3"], "a new strip is laid out item after item");
  await engine.finish("in");
  assert.deepEqual(slots(view.host), ["(g)", "name:a", "count:a", "tools"], "no mark stays on an item that has arrived");
  const strip = view.host.querySelector(".kd-activity")!;
  assert.equal(strip.getAttribute("aria-live"), "polite");
  const tools = slot(view.host, "tools")!;
  const glyphNode = slot(view.host, "(g)")!;
  assert.equal(slot(view.host, "name:a")!.getAttribute("data-yields"), "true", "running text gives way when the strip is short");
  assert.equal(tools.hasAttribute("data-yields"), false);

  // Another folder: the glyph and the tools are the same before and after.
  await view.render(rail(["g"], ["name:b", "count:b"]));
  assert.deepEqual(slots(view.host), ["(g)", "name:a:out1", "count:a:out0", "tools"], "last one first; name:b is not laid out yet");
  for (const leaving of view.host.querySelectorAll('[data-kd-turn="out"]')) {
    assert.ok(leaving.hasAttribute("inert"), "a picture takes no click and no focus");
    assert.equal(leaving.getAttribute("aria-hidden"), "true", "and is not announced by the live region");
  }
  assert.equal(slot(view.host, "tools"), tools, "the tools are the same element: a field in them keeps its text and focus");
  assert.equal(tools.hasAttribute("inert"), false);

  // The text area's content got narrower: the tools did not move, an item that stays behind it would glide.
  await engine.finish("out");
  assert.deepEqual(slots(view.host), ["(g)", "name:b:in0", "count:b:in1", "tools"]);
  assert.equal(slot(view.host, "(g)"), glyphNode);
  await engine.finish("in");
  assert.deepEqual(slots(view.host), ["(g)", "name:b", "count:b", "tools"]);

  // The same keys with other text are not a turn: the text changes where it stands.
  const count = slot(view.host, "count:b")!;
  await view.render(rail(["g"], ["name:b", ["count:b", "9 首"]]));
  assert.deepEqual(slots(view.host), ["(g)", "name:b", "9 首", "tools"]);
  assert.equal(slot(view.host, "9 首"), count);
  await view.unmount();
});

test("a second change in the middle of a turn joins it; a stage that was overtaken ends nothing", async () => {
  engine.on = true;
  const view = mount();
  await view.render(rail(["g"], ["name:a"]));
  await engine.finish("in");
  await view.render(rail(["g"], ["name:b"]));
  assert.deepEqual(slots(view.host), ["(g)", "name:a:out0", "tools"]);
  // Selection mode arrives before name:b was laid out, and takes the tools with it.
  await view.render(rail(["sel"], ["selection"], null));
  assert.deepEqual(slots(view.host), ["(g):out1", "name:a:out0", "tools:out0"]);
  await engine.finish("out");
  assert.deepEqual(slots(view.host), ["(sel):in0", "selection:in1"], "name:b never appeared");
  // Back before the arrival has ended: what was arriving leaves from where it is.
  await view.render(rail(["g"], ["name:b"]));
  assert.deepEqual(slots(view.host), ["(sel):out1", "selection:out0"]);
  await engine.finish("in");
  assert.deepEqual(slots(view.host), ["(sel):out1", "selection:out0"], "the end of the overtaken arrival does not clear the pictures");
  await engine.finish("out");
  assert.deepEqual(slots(view.host), ["(g):in0", "name:b:in1", "tools:in2"]);
  await engine.finish("in");
  assert.deepEqual(slots(view.host), ["(g)", "name:b", "tools"]);
  await view.unmount();
});

test("what stays closes up to its new place by a transform", async () => {
  engine.on = true;
  const view = mount();
  await view.render(rail(["g"], ["a long folder name", "mode"]));
  await engine.finish("in");
  await view.render(rail(["g"], ["short", "mode"]));
  const mode = slot(view.host, "mode")!;
  assert.equal(mode.offsetLeft, 210, "the picture still holds its place");
  assert.equal(mode.hasAttribute("data-kd-turn-shift"), false);
  // Measured before the picture is taken out, applied once the new name is in.
  await engine.finish("out");
  assert.equal(mode.offsetLeft, 80);
  assert.ok(mode.hasAttribute("data-kd-turn-shift"));
  assert.equal(mode.style.getPropertyValue("--kd-turn-shift"), "130px", "it starts where it stood");
  assert.equal(slot(view.host, "(g)")!.hasAttribute("data-kd-turn-shift"), false, "what did not move is left alone");
  await engine.finish("shift");
  assert.equal(mode.hasAttribute("data-kd-turn-shift"), false, "the mark is taken off when it has arrived");
  assert.equal(mode.style.getPropertyValue("--kd-turn-shift"), "");
  await view.unmount();
});

test("panes: the rail that is shown instead takes the strip over, whichever of the two comes first in the tree", async () => {
  engine.on = true;
  const view = mount();
  const local = (shown: boolean) => h("div", { className: "kd-workspace-pane" }, rail(["g"], ["全部曲目"], "library tools", { shown }));
  const online = (shown: boolean, mounted = true) => mounted
    ? h("div", { className: "kd-workspace-pane" },
        h(WorkRail, { label: "online", shown, glyphs: [glyph("mark")], texts: [text("title", "我喜欢的音乐")],
          actions: h("input", { "aria-label": "field", defaultValue: "" }) }))
    : null;
  const panes = (localShown: boolean, onlineShown: boolean, onlineMounted = true) =>
    h("div", null, local(localShown), online(onlineShown, onlineMounted));
  const [localRail, onlineRail] = [0, 1].map((index) => () => view.host.querySelectorAll<HTMLElement>(".kd-activity")[index]!);

  await view.render(panes(true, false, false));
  await engine.finish("in");
  assert.deepEqual(slots(localRail()), ["(g)", "全部曲目", "library tools"]);

  // The online pane is mounted and takes the place of the local one in one commit.
  await view.render(panes(false, true));
  assert.deepEqual(slots(onlineRail()), ["(g):out2", "全部曲目:out1", "library tools:out0"],
    "the local rail's items leave on the online rail; its own are not laid out yet");
  assert.ok([...onlineRail().querySelectorAll('[data-kd-turn="out"]')].every((node) => node.hasAttribute("inert")));
  await engine.finish("out");
  assert.deepEqual(slots(onlineRail()), ["(mark):in0", "我喜欢的音乐:in1", ":in2"]);
  await engine.finish("in");
  const field = onlineRail().querySelector("input")!;
  field.value = "typed";

  // Back: the local rail (earlier in the tree) takes over from the online one (later in the tree).
  await view.render(panes(true, false));
  assert.deepEqual(slots(localRail()), ["(mark):out2", "(g):hidden", "我喜欢的音乐:out1", "全部曲目:hidden", ":out0", "library tools:hidden"],
    "its own items stay mounted but wait off the strip");
  await engine.finish("out");
  assert.deepEqual(slots(localRail()), ["(g):in0", "全部曲目:in1", "library tools:in2"]);
  await engine.finish("in");

  // And forth again: the online rail was only hidden, so its field is the same element with its text.
  await view.render(panes(false, true));
  assert.equal(slots(onlineRail()).filter((item) => item.includes(":out")).length, 3);
  assert.equal(onlineRail().querySelector<HTMLInputElement>("input:not([inert] *)")!.value, "typed");
  assert.equal(onlineRail().querySelector("input:not([inert] *)"), field, "a rail that waited was not remounted");
  await engine.finish("out");
  await engine.finish("in");

  // The online pane is closed for good (unmounted) and the local one is shown again.
  await view.render(panes(true, false, false));
  assert.deepEqual(slots(localRail()).filter((item) => item.includes(":out")), ["(mark):out2", "我喜欢的音乐:out1", ":out0"]);
  await engine.finish("out");
  await engine.finish("in");
  assert.deepEqual(slots(localRail()), ["(g)", "全部曲目", "library tools"]);
  await view.unmount();
});

test("the hand-over survives StrictMode replaying the effects of the rail that is mounted", async () => {
  engine.on = true;
  const view = mount();
  const panes = (online: boolean) => h(StrictMode, null,
    h("div", { className: "kd-workspace-pane" }, rail(["g"], ["全部曲目"], "library tools", { shown: !online })),
    online && h("div", { className: "kd-workspace-pane" },
      h(WorkRail, { label: "online", glyphs: [glyph("search")], texts: [text("searching", "正在搜索")] })));
  await view.render(panes(false));
  await engine.finish("in");
  await view.render(panes(true));
  const online = view.host.querySelectorAll<HTMLElement>(".kd-activity")[1]!;
  assert.deepEqual(slots(online), ["(g):out2", "全部曲目:out1", "library tools:out0"]);
  await engine.finish("out");
  assert.deepEqual(slots(online), ["(search):in0", "正在搜索:in1"]);
  await engine.finish("in");
  await view.unmount();
});

test("two panes side by side keep their own strips; a rail that replaces another in the same pane takes over", async () => {
  engine.on = true;
  const view = mount();
  const side = (which: "online" | "temporary" | null) => h("div", null,
    h("div", { className: "kd-workspace-pane" }, rail(["g"], ["全部曲目"])),
    which && h("div", { className: "kd-workspace-pane" },
      which === "online"
        ? h(WorkRail, { key: "online", label: "online", glyphs: [glyph("mark")], texts: [text("title", "night drive")] })
        : h(WorkRail, { key: "temporary", label: "temporary", glyphs: [glyph("folder")], texts: [text("title", "Late Night Sets")] })));
  await view.render(side(null));
  await engine.finish("in");
  await view.render(side("online"));
  const [first, second] = [0, 1].map((index) => () => view.host.querySelectorAll<HTMLElement>(".kd-activity")[index]!);
  assert.deepEqual(slots(first()), ["(g)", "全部曲目", "tools"], "the local rail is still shown: nothing of it moves");
  assert.deepEqual(slots(second()), ["(mark):in0", "night drive:in1"], "the new pane's rail only lays out its own");
  await engine.finish("in");
  // A temporary folder replaces the results in the right-hand pane.
  await view.render(side("temporary"));
  assert.deepEqual(slots(second()), ["(mark):out1", "night drive:out0"]);
  assert.deepEqual(slots(first()), ["(g)", "全部曲目", "tools"]);
  await engine.finish("out");
  assert.deepEqual(slots(second()), ["(folder):in0", "Late Night Sets:in1"]);
  await engine.finish("in");
  // The right-hand pane is closed: nobody takes its strip.
  await view.render(side(null));
  assert.deepEqual(slots(first()), ["(g)", "全部曲目", "tools"]);
  await view.unmount();
});

const folder = (path: string, total: number, children: FolderNode[] = []): FolderNode => ({
  path, name: path.split("/").at(-1)!, parent: "", track_count: total, total_count: total, file_count: total,
  pending_count: 0, children, is_root: children.length > 0, managed: false,
});

test("the library rail names the list as the sidebar does", async () => {
  const { libraryRailView } = await import("../src/components/chrome/libraryRailView");
  const { OUTSIDE_FOLDER } = await import("../src/lib/outsideFolder");
  const tree: FolderTree = { roots: [folder("/music", 8, [folder("/music/sets", 3, [folder("/music/sets/2026", 2)])])], outside: 4 };
  assert.deepEqual(libraryRailView("", tree, 12), { key: "all", name: "全部曲目", count: 12, path: "" });
  assert.equal(libraryRailView("", tree, null).count, 12, "the tree's own sum until the statistics arrive");
  assert.equal(libraryRailView("", null, null).count, null);
  assert.deepEqual(libraryRailView(OUTSIDE_FOLDER, tree, 12), { key: "outside", name: "其他", count: 4, path: "" });
  assert.deepEqual(libraryRailView("/music/sets/2026", tree, 12),
    { key: "folder:/music/sets/2026", name: "2026", count: 2, path: "/music/sets/2026" });
  assert.equal(libraryRailView("/music/sets/", tree, 12).name, "sets", "a trailing separator is the same folder");
  // A folder the tree does not know yet (it is being scanned): its last segment, and no number.
  assert.deepEqual(libraryRailView("C:\\Music\\New Folder", tree, 12),
    { key: "folder:C:\\Music\\New Folder", name: "New Folder", count: null, path: "C:\\Music\\New Folder" });
  assert.notEqual(libraryRailView("/music", tree, 12).key, libraryRailView("/music/sets", tree, 12).key);
});

test("the library rail at rest names the list and nothing else; analysis brings its words and its control", async () => {
  engine.on = false;
  const { LibraryWorkRail } = await import("../src/components/chrome/LibraryWorkRail");
  const { useLibraryStore } = await import("../src/stores/libraryStore");
  const { useAppStore } = await import("../src/stores/appStore");
  const { OUTSIDE_FOLDER } = await import("../src/lib/outsideFolder");
  const library = (patch: Record<string, unknown>) => act(async () => { useLibraryStore.setState(patch as never); });
  const filter = (folderPath: string) => library({ filter: { ...useLibraryStore.getState().filter, folder: folderPath } });
  await library({
    folders: { roots: [folder("/music", 8, [folder("/music/Late Night Sets", 3)])], outside: 2 },
    stats: { total: 10, analyzed: 10 } as LibraryStats,
    scan: null, analyze: null, maintenance: [], autoAnalyzeSuspended: false,
  });
  await act(async () => { useAppStore.setState({ settings: { auto_analyze: true, auto_analysis_mode: "light" } as never }); });
  const view = mount();
  await view.render(h(LibraryWorkRail, { mode: "rail" }));
  const strip = () => view.host.querySelector<HTMLElement>(".kd-activity")!;
  const words = () => [...strip().querySelectorAll(".kd-activity-texts > [data-rail-slot]")].map((node) => node.textContent);
  const control = () => strip().querySelector<HTMLButtonElement>(".kd-activity-control");

  // Everything is analysed: the whole library by the sidebar's name, one glyph, no state words, no control.
  assert.deepEqual(words(), ["全部曲目", "10 首"]);
  assert.equal(strip().querySelectorAll(".kd-activity-glyphs > [data-rail-slot]").length, 1, "one leading glyph");
  assert.doesNotMatch(strip().textContent ?? "", /已全部分析|已分析|未分析|自动分析/);
  assert.equal(control(), null);

  await filter("/music/Late Night Sets");
  assert.deepEqual(words(), ["Late Night Sets", "3 首"]);
  assert.equal(strip().querySelector(".kd-collection-rail-title")!.getAttribute("title"), "/music/Late Night Sets");
  await filter(OUTSIDE_FOLDER);
  assert.deepEqual(words(), ["其他", "2 首"]);
  await filter("");

  // Tracks left but nothing running and not paused: still only the name.
  await library({ stats: { total: 10, analyzed: 6 } as LibraryStats });
  assert.deepEqual(words(), ["全部曲目", "10 首"]);
  assert.equal(control(), null);

  // A batch is running: its words replace the name, and the control is there.
  await library({ analyze: { job_id: "j", done: 3, total: 4, current: "a.wav", cancelled: false } });
  assert.deepEqual(words(), ["正在分析 3/4 首 · a.wav", "自动分析：轻量"]);
  assert.equal(control()!.getAttribute("aria-label"), "自动分析：轻量");
  await library({ analyze: null });
  assert.equal(control(), null);

  // Paused with tracks left: the name, and the way back.
  await library({ autoAnalyzeSuspended: true });
  assert.deepEqual(words(), ["全部曲目", "10 首", "自动分析：已暂停"]);
  // Paused with nothing left: only the name (the mode lives in the settings).
  await library({ stats: { total: 10, analyzed: 10 } as LibraryStats });
  assert.deepEqual(words(), ["全部曲目", "10 首"]);
  await library({ autoAnalyzeSuspended: false });

  // Selection mode is one of the rail's states and keeps its own item.
  await library({ selectionMode: true, selectedIds: [1, 2] });
  assert.match(strip().textContent ?? "", /已选 2/);
  assert.doesNotMatch(strip().textContent ?? "", /全部曲目/);
  await library({ selectionMode: false, selectedIds: [] });
  assert.deepEqual(words(), ["全部曲目", "10 首"]);
  await view.unmount();
});

const source = (platform: SongSource["platform"], key: string): SongSource =>
  ({ platform, key, title: key, artists: [], album: "", duration: null, cover: "", max_quality: null, vip: false, payload: {} });
const group = (id: string, ...platforms: SongSource["platform"][]): MergedGroup => ({
  group_id: id, title: id, artists: [], album: "", duration: null, cover: "",
  sources: platforms.map((platform) => source(platform, `${id}-${platform}`)), best_source_index: 0, score: 0,
});
const item = (patch: Partial<IntakeItem>): IntakeItem =>
  ({ entry: "night drive", kind: "search", platform: null, title: "", groups: [], collections: [], errors: {}, error: "", ...patch });

test("the online rail says which platform's which list it is, in every state", async () => {
  engine.on = false;
  const { SearchWorkRail } = await import("../src/components/chrome/SearchWorkRail");
  const noop = () => {};
  const base = {
    items: [] as IntakeItem[], collection: null as IntakeItem | null, canGoBack: false, onGoBack: noop,
    onDownloadCollection: noop, loading: false, selectionCount: 0, selecting: false, onSelectAll: noop,
    onClear: noop, onDone: noop, onAddToQueue: noop, queueError: "", onDismissQueueError: noop,
    chosenReady: false, onClose: noop,
  };
  const view = mount();
  const show = (patch: Partial<typeof base> & Record<string, unknown>) => view.render(h(SearchWorkRail, { ...base, ...patch }));
  const strip = () => view.host.querySelector<HTMLElement>(".kd-activity")!;
  const words = () => [...strip().querySelectorAll(".kd-activity-texts > [data-rail-slot]")].map((node) => node.textContent);
  const mark = () => strip().querySelector(".kd-collection-rail-platform");

  // A search that is on its way, and one that found nothing.
  await show({ loading: true });
  assert.deepEqual(words(), ["正在搜索"]);
  await show({});
  assert.deepEqual(words(), ["没有搜到可下载的结果"]);

  // Results of one search: what was asked, then how much each platform brought.
  const results = [item({ groups: [group("a", "wyy", "qqm"), group("b", "wyy")] })];
  await show({ items: results });
  assert.deepEqual(words(), ["night drive", "2", "1"]);
  assert.deepEqual([...strip().querySelectorAll(".kd-activity-plat")].map((node) => node.getAttribute("data-platform")), ["wyy", "qqm"]);
  assert.equal(strip().querySelector(".kd-collection-rail-download"), null);
  // A batch is named by its size.
  await show({ items: [...results, item({ entry: "paper moon", groups: [group("c", "qqm")] })] });
  assert.deepEqual(words().slice(0, 2), ["批量搜索", "2 项"]);

  // A collection opened from the results: the platform's mark, its title, its size, and its action.
  const opened = item({ entry: "wyy:playlist:42", kind: "playlist", platform: "wyy", title: "Night Sets", groups: [group("a", "wyy"), group("b", "wyy")] });
  await show({ items: [opened], collection: opened, canGoBack: true });
  assert.deepEqual(words(), ["Night Sets", "2 首", "全部下载"]);
  assert.equal(mark()!.getAttribute("data-platform"), "wyy");
  assert.ok(mark()!.getAttribute("aria-label"), "the mark is read out as the platform's name");
  assert.ok(strip().querySelector(".kd-collection-rail-back"));
  assert.equal(strip().querySelector(".kd-collection-rail-pagination"), null, "no pager");
  assert.doesNotMatch(strip().textContent ?? "", /\d+ \/ \d+/);

  // A favourites folder opened from the sidebar: named at once, while its tracks are on their way.
  const playlist: StreamPlaylist = { platform: "bilibili", key: "7", title: "默认收藏夹", cover: "", count: 120, is_favorite: true, origin: "favorite" };
  await show({ items: [], streamPlaylist: playlist, loading: true });
  assert.deepEqual(words(), ["默认收藏夹", "120 个视频"]);
  assert.equal(mark()!.getAttribute("data-platform"), "bilibili");
  const title = strip().querySelector(".kd-collection-rail-title")!.parentElement;
  // Loaded (the list holds the first 50 of 120): the same name item, the collection's total, and now the action.
  const loaded = item({ entry: "bilibili:playlist:7", kind: "playlist", platform: "bilibili", title: "默认收藏夹",
    groups: Array.from({ length: 50 }, (_, index) => group(`v${index}`, "bilibili")) });
  await show({ items: [loaded], collection: loaded, streamPlaylist: playlist });
  assert.deepEqual(words(), ["默认收藏夹", "120 个视频", "全部下载"]);
  assert.equal(strip().querySelector(".kd-collection-rail-title")!.parentElement, title, "the name did not turn when its tracks arrived");
  // It failed or is empty: still named, nothing to download.
  await show({ items: [], streamPlaylist: { ...playlist, count: 0 } });
  assert.deepEqual(words(), ["默认收藏夹", "0 个视频"]);
  assert.equal(strip().querySelector(".kd-collection-rail-download"), null);

  // One pasted video.
  await show({ video: { platform: "youtube", bvid: "x1", title: "A video", author: "", cover: "", duration: 1, pages: [], options: [], logged_in: false } });
  assert.deepEqual(words(), ["A video"]);
  assert.equal(mark()!.getAttribute("data-platform"), "youtube");

  // Selection takes the strip, with the same item as before.
  await show({ items: results, selecting: true, selectionCount: 2 });
  assert.match(strip().textContent ?? "", /已选 2/);
  assert.match(strip().textContent ?? "", /加入队列/);
  // The collapse key is always at the right-hand end.
  assert.ok(strip().querySelector('[data-action="dismiss-results"]'));
  await view.unmount();
});
