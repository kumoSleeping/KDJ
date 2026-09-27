import assert from "node:assert/strict";
import test from "node:test";
import { createWorkshopFolderAccess, workshopAccessDirectory } from "../src/lib/workshopFolderAccess";
import type { KdjBridge } from "../src/types";
import type { CompositionProject } from "../src/types/workshop";
import type { WorkshopPlayback } from "../src/lib/workshopPlayback";

const denied = (dir: string) => `素材访问被系统拒绝：${dir}/Screen Recording.MP4。请点击“授权文件夹”并选择 ${dir}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

test("folder authorization is deduplicated, serialized and never loops after cancellation", async () => {
  assert.equal(workshopAccessDirectory(denied("/Users/测试/My Downloads")), "/Users/测试/My Downloads");
  assert.equal(workshopAccessDirectory("素材已变化，请重新添加"), null);
  const request = createWorkshopFolderAccess(), first = deferred<string | null>();
  const opened: string[] = [];
  const picker: KdjBridge["pickFolder"] = async options => {
    opened.push(options!.defaultPath!);
    return opened.length === 1 ? first.promise : options!.defaultPath!;
  };
  const a = request("/a", picker), duplicate = request("/a", picker), b = request("/b", picker);
  assert.equal(a, duplicate);
  await Promise.resolve();
  assert.deepEqual(opened, ["/a"]);
  first.resolve(null);
  assert.deepEqual(await Promise.all([a, b]), [null, "/b"]);
  assert.equal(await request("/a", picker), null);
  assert.equal(await request("/b", picker), null, "ineffective grants must not loop either");
  assert.equal(await request("/a", picker, true), "/a");
  await assert.rejects(request("/failed", async () => { throw new Error("picker failed"); }));
  assert.equal(await request("/failed", picker), null);
  assert.equal(await request("/failed", picker, true), "/failed");
});

test("preview automatically prompts once in StrictMode, retries after selection and ignores stale grants", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createElement, StrictMode, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkshopPreview } = await import("../src/components/composition/WorkshopPreview");
  const { useWorkshopStore } = await import("../src/stores/workshopStore");
  const root = createRoot(document.getElementById("root")!);
  const p: CompositionProject = { id:"p", revision:0, name:"test", sources:[], layers:[], migrated_from:null,
    canvas:{width:160,height:90,fps:30,initialized:true},
    output:{name:"test",directory:"/output",in_ms:0,out_ms:null,quality:20,acceleration:"auto"} };
  let selection = deferred<string | null>(), prompts = 0, retries = 0;
  window.kdj = { pickFolder: async options => {
    prompts++;
    assert.equal(options?.title, "授权素材文件夹");
    assert.ok(options?.defaultPath?.startsWith("/ui-"));
    return selection.promise;
  } } as KdjBridge;
  const playback: WorkshopPlayback = { ticket:null, playing:false, loading:false, error:denied("/ui-downloads"),
    trackId:null, toggle() {}, seek() {}, beginScrub() {}, endScrub() {}, stop() {}, time:() => 0,
    retry() { retries++; } };
  const render = () => root.render(createElement(StrictMode, null, createElement(WorkshopPreview, { playback:{...playback} })));
  try {
    await act(async () => { useWorkshopStore.setState({activeId:p.id,draft:p}); render(); });
    assert.equal(prompts, 1);
    assert.equal(document.querySelector("button")?.disabled, true);
    await act(async () => { selection.resolve(null); });
    await act(async () => { render(); });
    assert.equal(prompts, 1);
    assert.equal(retries, 0);
    selection = deferred();
    await act(async () => { document.querySelector("button")!.click(); });
    assert.equal(prompts, 2);
    await act(async () => { selection.resolve("/ui-downloads"); });
    assert.equal(retries, 1);
    await act(async () => { render(); });
    assert.equal(prompts, 2);
    selection = deferred();
    await act(async () => { playback.error = denied("/ui-other"); render(); });
    assert.equal(prompts, 3);
    await act(async () => {
      playback.error = "";
      useWorkshopStore.setState({activeId:"other",draft:{...p,id:"other"}});
      render();
    });
    await act(async () => { selection.resolve("/ui-other"); });
    assert.equal(retries, 1, "a late grant cannot retry a different project");
    selection = deferred();
    await act(async () => { playback.error = denied("/ui-auto"); render(); });
    await act(async () => { selection.resolve("/ui-auto"); });
    assert.equal(retries, 2, "automatic authorization retries without a button click");
    selection = deferred();
    await act(async () => { playback.error = denied("/ui-unmounted"); render(); });
    await act(async () => { root.unmount(); selection.resolve("/ui-unmounted"); });
    assert.equal(retries, 2, "unmounted previews cannot retry");
  } finally { dom.window.close(); }
});
