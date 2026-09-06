import assert from "node:assert/strict";
import test from "node:test";
import type { CompositionProject } from "../src/types/workshop";
import type { WorkshopPositionAnalysis } from "../src/types/workshop";
test("workshop selection, split, deletion, undo, layer order and autosave share one project", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    url: "http://localhost",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (dom.window as unknown as Window).kdj = {} as import("../src/types").KdjBridge;
  dom.window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => true;
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  dom.window.HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  const { createElement, act } = await import("react"),
    { createRoot } = await import("react-dom/client"),
    { CompositionWorkshop } =
      await import("../src/components/composition/CompositionWorkshop"),
    { useWorkshopStore } = await import("../src/stores/workshopStore"),
    { api } = await import("../src/lib/api");
  const { initBridge } = await import("../src/lib/bridge");
  await initBridge();
  const p: CompositionProject = {
    id: "p",
    revision: 0,
    name: "测试作品",
    sources: [
      {
        id: "s",
        track_id: 1,
        path: "/source.mp4",
        title: "动画",
        duration_ms: 10000,
        video: true,
        audio: true,
        width: 160,
        height: 90,
        fps: 25,
        signature: "",
      },
    ],
    layers: [
      {
        id: "l",
        source_id: "s",
        clips: [
          {
            id: "c",
            source_id: "s",
            start_ms: 0,
            source_in_ms: 0,
            source_out_ms: 10000,
            speed: {
              preset: "constant",
              start: 1,
              middle: 1,
              end: 1,
              domain_start_ms: 0,
              domain_end_ms: 10000,
            },
            picture: { x: 0.5, y: 0.5, scale: 1, opacity: 1 },
            sound: { muted: false, gain: 1, manual: false },
            fades: {
              offset_ms: 0,
              span_ms: 10000,
              video_in_ms: 0,
              video_out_ms: 0,
              audio_in_ms: 0,
              audio_out_ms: 0,
              linear: false,
            },
          },
        ],
      },
    ],
    canvas: { width: 160, height: 90, fps: 25, initialized: true },
    output: {
      name: "成品",
      directory: "/tmp",
      in_ms: 0,
      out_ms: null,
      quality: 20,
      acceleration: "software",
    },
    migrated_from: null,
  };
  let server = structuredClone(p),
    revision = 0,
    saves = 0;
  const additional: CompositionProject[] = [];
  api.workshop = async () => ({
    session: "ui",
    revision,
    projects: [server, ...additional],
    jobs: [],
  });
  api.editWorkshop = async (id, base, edit) => {
    assert.equal(id, "p");
    assert.equal(base, server.revision);
    server = { ...server, ...structuredClone(edit), revision: base + 1 };
    revision++;
    saves++;
    return api.workshop();
  };
  const auditionRequests: (string | undefined)[] = [];
  api.previewWorkshop = async (_id, _revision, audition) => { auditionRequests.push(audition); return ({
    ticket: "ticket",
    revision: server.revision,
  }); };
  api.releaseWorkshop = async () => ({});
  api.videoUrl = () => "/source.mp4";
  api.workshopVideoUrl = (ticket, clip, part) => `/preview/${ticket}/${clip}/${part}.mp4`;
  api.coverUrl = () => "";
  api.workshopFrameUrl = (_project, source, ms) => `/frame/${source}/${ms}`;
  api.workshopPositions = async () => ({
    session: "ui",
    project_id: "p",
    revision: server.revision,
    items: [],
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(createElement(CompositionWorkshop));
  });
  assert.equal(document.querySelectorAll(".vj-track-row").length, 0, "collapsed tasks do not mount media decoders");
  assert.equal(document.querySelector('.vj-task-summary'), null, "tasks default to one row");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="展开详情 测试作品"]')!.click());
  assert.ok(document.querySelector('.vj-task-summary'), "details can expand without editing");
  assert.equal(document.querySelector('.vj-task-editor'), null);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="展开详情 测试作品"]')!.click());
  assert.equal(document.querySelector('.vj-task-summary'), null);

  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="展开编辑 测试作品"]')!.click();
    await useWorkshopStore.getState().flush();
  });
  assert.equal(
    document.querySelector('[aria-label="添加素材"]'),
    null,
    "sources come from the library",
  );
  assert.equal(
    document.querySelector("[data-window-control]"),
    null,
    "the workshop uses the shared side panel",
  );
  assert.equal(document.querySelectorAll(".vj-track-row").length, 1);
  assert.equal(document.querySelector(".vj-inspector"), null);
  const click = async (label: string) =>
    act(async () => {
      const button = document.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      );
      assert.ok(button, label);
      button.click();
      await useWorkshopStore.getState().flush();
    });
  assert.equal(document.querySelector(".vj-task-export-meta"), null, "task heading does not repeat filename or output settings");
  await act(async () => useWorkshopStore.getState().select("c"));
  const pictureValue = (label: string) => document.querySelector<HTMLInputElement>(`.vj-picture-tools input[aria-label="${label}"]`)!;
  const setPictureValue = async (label: string, value: string) => {
    await act(async () => {
      const input = pictureValue(label);
      input.focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => { pictureValue(label).blur(); await useWorkshopStore.getState().flush(); });
  };
  assert.equal(document.querySelector('[aria-label="沿用到新素材"]')?.getAttribute("aria-pressed"), "true");
  await setPictureValue("大小", "55");
  assert.equal(server.layers[0].clips[0].picture.scale, .55);
  assert.deepEqual(server.canvas.import_picture, {x:.5, y:.5, scale:.55, opacity:1});
  await click("沿用到新素材");
  await setPictureValue("透明度", "65");
  assert.equal(server.layers[0].clips[0].picture.opacity, .65);
  assert.equal(server.canvas.import_picture, null, "disabled inheritance leaves new imports at their original layout");
  await click("沿用到新素材");
  assert.deepEqual(server.canvas.import_picture, {x:.5, y:.5, scale:.55, opacity:.65});
  await setPictureValue("大小", "201");
  assert.equal(pictureValue("大小").value, "55", "invalid values revert without changing the layout");
  for (let i = 0; i < 4; i++) await click("撤销");
  assert.deepEqual(server.layers[0].clips[0].picture, p.layers[0].clips[0].picture);
  assert.equal(server.canvas.import_picture, undefined, "undo restores both the clip and import preferences");
  const applyPositions = useWorkshopStore.getState().applyPositions;
  const appliedPositions: string[][] = [];
  await act(async () => useWorkshopStore.setState({
    positions: {p: {session: "ui", project_id: "p", revision: 0, items: [{
      id: "analysis", layer_id: "l", phase: "ready", progress: 1, reference_id: "music", reference_title: "配乐", reason: "", applied: null,
      presets: [{id: "longest", label: "最大匹配 · 保留完整", placements: []}],
    }]}},
    applyPositions: async (...args) => { appliedPositions.push(args); },
  }));
  const positionChoice = document.querySelector<HTMLButtonElement>('.vj-track-label .vj-position-choice-actions button')!;
  assert.ok(positionChoice, "position choices live with the visibility and source controls in the track label");
  await act(async () => positionChoice.click());
  assert.deepEqual(appliedPositions, [["l", "analysis", "longest"]]);
  const controlApi = api.controlWorkshopPositions;
  const controls: [string, boolean, string | undefined][] = [];
  const currentRevision = useWorkshopStore.getState().projects[0].revision;
  const analysis = { ...useWorkshopStore.getState().positions.p.items[0], phase: "analyzing" as const, progress: .3, presets: [] };
  const result = {session: "ui", project_id: "p", revision: currentRevision, items: [analysis]};
  api.controlWorkshopPositions = async (project, stopped, layer) => {
    controls.push([project, stopped, layer]);
    return {...result, items: [{...analysis, id: stopped ? analysis.id : "restarted", phase: stopped ? "stopped" : "analyzing", progress: stopped ? 1 : 0, reason: stopped ? "已停止" : ""}]};
  };
  await act(async () => useWorkshopStore.setState({positions: {p: result}}));
  assert.ok(document.querySelector('.vj-analysis-progress button'), "stop is next to the individual progress bar");
  await click("停止 动画 的自动分析");
  assert.deepEqual(controls.pop(), ["p", true, "l"]);
  assert.equal(document.querySelector('.vj-analysis-progress progress'), null);
  await act(async () => useWorkshopStore.getState().acceptPositions(result));
  assert.equal(useWorkshopStore.getState().positions.p.items[0].phase, "stopped", "late progress cannot undo a stop");
  await click("重新分析 动画");
  assert.deepEqual(controls.pop(), ["p", false, "l"]);
  await click("停止全部素材的自动分析");
  assert.deepEqual(controls.pop(), ["p", true, undefined]);
  api.controlWorkshopPositions = controlApi;
  await act(async () => useWorkshopStore.setState({applyPositions, positions: {}}));
  const timeline = document.querySelector(".vj-timeline")!;
  assert.equal(document.querySelector(".vj-timeline-overview")?.parentElement?.className, "vj-timeline-scale", "global overview shares the time readout row");
  assert.equal(document.querySelector(".vj-sources"), null, "materials are not duplicated above the timeline");
  assert.equal(document.querySelector(".vj-main"), null, "there is no reserved inline preview region");
  assert.equal(document.querySelector(".vj-preview"), null, "opening an editor does not start video decoders");
  await click("打开作品预览小窗");
  assert.equal(document.querySelector(".vj-floating-preview")?.parentElement, document.body, "preview escapes the clipping side panel");
  assert.equal(document.querySelector('[aria-label="调整轨道和素材区高度"]'), null);
  assert.ok(
    document.querySelectorAll(".vj-filmstrip img").length > 1,
    "video uses source frames across the strip",
  );
  const pointer = async (node: Element, type: string, x: number) =>
    act(async () => {
      node.dispatchEvent(
        new dom.window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
        }),
      );
      await useWorkshopStore.getState().flush();
    });
  const ruler = document.querySelector(".vj-ruler-rail")!;
  await pointer(ruler, "pointerdown", 100);
  const firstTime = useWorkshopStore.getState().position;
  await pointer(ruler, "pointermove", 200);
  assert.ok(
    useWorkshopStore.getState().position > firstTime,
    "dragging the ruler seeks continuously",
  );
  await pointer(ruler, "pointerup", 220);
  assert.equal(useWorkshopStore.getState().scrubbing, false);
  const scroll = document.querySelector(".vj-timeline-scroll")!;
  const zoomWidth = () => parseFloat(document.querySelector<HTMLElement>(".vj-ruler-rail")!.style.width);
  const fittedWidth = zoomWidth();
  assert.equal(document.querySelector('[aria-label="时间轴缩放"]'),null,"zoom slider is removed");
  assert.equal(document.querySelector('[title="适合窗口"]'),null,"fit and zoom buttons are removed");
  await act(async () =>
    scroll.dispatchEvent(
      new dom.window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -200,
        shiftKey: true,
        clientX: 350,
      }),
    ),
  );
  assert.ok(zoomWidth() > fittedWidth, "Shift+wheel zooms the rail");
  let overview = document.querySelector<HTMLElement>('[aria-label="时间轴全局位置"]')!;
  assert.ok(overview,"zoom overflow exposes the global navigator");
  const playheadBeforeOverview = useWorkshopStore.getState().position;
  const draftBeforeOverview = structuredClone(useWorkshopStore.getState().draft);
  await pointer(overview,"pointerdown",0);
  await pointer(overview,"pointermove",10000);
  await pointer(overview,"pointerup",10000);
  assert.equal(Math.round(scroll.scrollLeft),Number(overview.getAttribute("aria-valuemax")),"navigator drag clamps at the end");
  await act(async () => overview.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Home",bubbles:true,cancelable:true})));
  assert.equal(scroll.scrollLeft,0);
  await act(async () => overview.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true})));
  assert.ok(scroll.scrollLeft > 0,"navigator arrows scroll rather than nudge clips");
  assert.equal(useWorkshopStore.getState().position,playheadBeforeOverview,"navigator does not seek playback");
  assert.deepEqual(useWorkshopStore.getState().draft,draftBeforeOverview);
  await act(async () => scroll.dispatchEvent(new dom.window.WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:100000,shiftKey:true,clientX:350})));
  assert.equal(document.querySelector('[aria-label="时间轴全局位置"]'),null,"fitted content does not show an unnecessary scrollbar");
  assert.equal(scroll.scrollLeft,0,"zooming to fit resets the old horizontal offset");
  await act(async () => scroll.dispatchEvent(new dom.window.WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:-200,shiftKey:true,clientX:350})));
  overview = document.querySelector<HTMLElement>('[aria-label="时间轴全局位置"]')!;
  assert.ok(overview);
  const zoomBeforeScroll = zoomWidth();
  await act(async () => scroll.dispatchEvent(new dom.window.WheelEvent("wheel", {bubbles:true,cancelable:true,clientX:20,deltaY:80})));
  assert.equal(scroll.scrollTop,80,"wheel over the names scrolls tracks vertically");
  assert.equal(zoomWidth(),zoomBeforeScroll,"name-area scrolling never zooms the timeline");
  await act(async () => scroll.dispatchEvent(new dom.window.WheelEvent("wheel", {bubbles:true,cancelable:true,clientX:350,deltaX:120})));
  assert.ok(scroll.scrollLeft >= 120,"horizontal gesture pans the timeline");
  const wheelInput = (init: WheelEventInit) => {
    const event = new dom.window.WheelEvent("wheel", {bubbles:true,cancelable:true,clientX:350,...init});
    scroll.dispatchEvent(event);
    assert.ok(event.defaultPrevented, "timeline owns scrolling and prevents whole-page zoom");
  };
  const panLeft = scroll.scrollLeft;
  await act(async () => wheelInput({deltaX:12,deltaY:40}));
  assert.equal(scroll.scrollLeft,panLeft+12,"diagonal two-finger motion retains the horizontal component");
  assert.equal(scroll.scrollTop,120,"wheel over clips scrolls vertically");
  assert.equal(zoomWidth(),zoomBeforeScroll,"ordinary scrolling never changes zoom");
  await act(async () => wheelInput({deltaX:-12,deltaY:-40,clientX:20}));
  assert.equal(scroll.scrollLeft,panLeft,"two-finger horizontal motion also works over material names");
  assert.equal(scroll.scrollTop,80);
  await act(async () => wheelInput({deltaY:2,deltaMode:1,altKey:true}));
  assert.equal(scroll.scrollLeft,panLeft+40,"Option/Alt+wheel pans by normalized line units");
  assert.equal(scroll.scrollTop,80);
  Object.defineProperty(scroll,"clientHeight",{configurable:true,value:180});
  await act(async () => wheelInput({deltaY:1,deltaMode:2}));
  assert.equal(scroll.scrollTop,260,"page-mode wheel uses the viewport height");
  await act(async () => wheelInput({deltaY:-2,deltaMode:1}));
  assert.equal(scroll.scrollTop,220,"line-mode wheel uses line units");
  const beforeBurst = zoomWidth();
  const anchorTime = (scroll.scrollLeft+142) / beforeBurst;
  await act(async () => {
    wheelInput({deltaY:-20,shiftKey:true});
    wheelInput({deltaY:-20,shiftKey:true});
    wheelInput({deltaX:-20,shiftKey:true});
  });
  assert.ok(Math.abs(zoomWidth()/beforeBurst-Math.exp(.18))<1e-9,"rapid Shift wheel samples accumulate, including OS-remapped deltaX");
  assert.ok(Math.abs((scroll.scrollLeft+142)/zoomWidth()-anchorTime)<1e-9,"zoom keeps the time under the pointer fixed");
  const beforeCtrl = zoomWidth();
  await act(async () => wheelInput({deltaY:-10,ctrlKey:true,clientX:20}));
  assert.ok(zoomWidth()>beforeCtrl,"WebView2 pinch zoom works over material names too");
  const gesture = async (type: string, scale?: number) => act(async () => {
    const event = new dom.window.Event(type,{bubbles:true,cancelable:true});
    Object.assign(event,{scale,clientX:350});
    scroll.dispatchEvent(event);
    assert.ok(event.defaultPrevented,"WebKit gesture never zooms the whole app");
  });
  const beforePinch = zoomWidth();
  await gesture("gesturestart",1);
  await gesture("gesturechange",1.5);
  assert.ok(Math.abs(zoomWidth()/beforePinch-1.5)<1e-9,"Mac spread enlarges the timeline");
  await act(async () => wheelInput({deltaY:-10,ctrlKey:true}));
  assert.ok(Math.abs(zoomWidth()/beforePinch-1.5)<1e-9,"wheel samples cannot duplicate an active WebKit pinch");
  await gesture("gesturechange",1.2);
  assert.ok(Math.abs(zoomWidth()/beforePinch-1.2)<1e-9,"WebKit scale is cumulative from gesturestart");
  await gesture("gestureend",.8);
  assert.ok(Math.abs(zoomWidth()/beforePinch-.8)<1e-9,"pinching inward and the final gesture sample shrink the timeline");
  await gesture("gesturestart",1);
  await gesture("gestureend");
  const beforeResume = scroll.scrollLeft;
  await act(async () => wheelInput({deltaX:10}));
  assert.equal(scroll.scrollLeft,beforeResume+10,"panning resumes after gestureend without a scale");
  assert.equal(useWorkshopStore.getState().position,playheadBeforeOverview,"scroll and zoom never seek playback");
  assert.deepEqual(useWorkshopStore.getState().draft,draftBeforeOverview,"scroll and zoom never edit material positions");
  const globalPreview = document.querySelector<HTMLElement>('[aria-label="全局预览位置"]')!;
  globalPreview.getBoundingClientRect = () => ({left:0,top:0,right:600,bottom:18,width:600,height:18,x:0,y:0,toJSON(){}});
  await pointer(globalPreview,"pointerdown",300);
  assert.equal(useWorkshopStore.getState().position,5000,"global preview click seeks to the corresponding project time");
  assert.equal(useWorkshopStore.getState().scrubbing,true);
  await pointer(globalPreview,"pointermove",450);
  assert.ok(useWorkshopStore.getState().position > 7000,"global preview supports continuous scrubbing");
  await pointer(globalPreview,"pointerup",450);
  assert.equal(useWorkshopStore.getState().scrubbing,false,"global seek commits when released");
  assert.deepEqual(useWorkshopStore.getState().draft,draftBeforeOverview,"global controls never edit clips");
  const beforeHide = structuredClone(useWorkshopStore.getState().draft);
  const saveBeforeHide = saves;
  await click("隐藏轨道画面：动画");
  assert.equal(document.querySelectorAll('.vj-preview video').length,0,"hidden track releases preview decoders");
  assert.deepEqual(useWorkshopStore.getState().draft,beforeHide,"temporary visibility preserves sound and export parameters");
  assert.equal(saves,saveBeforeHide);
  await click("显示轨道画面：动画");
  assert.ok(document.querySelector('.vj-preview video'));
  const editor = document.querySelector<HTMLElement>('[aria-label="VJ 剪辑工坊"]')!;
  assert.equal(document.querySelector('[aria-label="调整预览和轨道高度"]'), null);
  const floating = document.querySelector<HTMLElement>(".vj-floating-preview")!;
  await act(async () => useWorkshopStore.getState().select("c"));
  const beforeWindowDrag = structuredClone(useWorkshopStore.getState().draft);
  const windowDragSaves = saves;
  const floatingLeft = parseFloat(floating.style.left);
  assert.equal(floating.querySelector('.vj-picture-selection'), null, "window movement is the default even with a selected clip");
  await pointer(floating.querySelector('.vj-picture-hit')!, "pointerdown", 200);
  assert.equal(useWorkshopStore.getState().gesture, null, "dragging the window never starts the edit gesture that pauses playback");
  await pointer(floating, "pointermove", 140);
  await pointer(floating, "pointerup", 140);
  assert.equal(parseFloat(floating.style.left), floatingLeft - 60, "dragging the video picture moves the whole preview window");
  assert.deepEqual(useWorkshopStore.getState().draft, beforeWindowDrag);
  assert.equal(saves, windowDragSaves, "window movement does not rebuild or save the composition");
  await click("调整画面");
  assert.ok(floating.querySelector('.vj-picture-selection'), "explicit picture editing retains layer controls");
  await click("调整画面");
  const floatingWidth = parseFloat(floating.style.width);
  const resize = floating.querySelector('[aria-label="调整预览小窗大小"]')!;
  await pointer(resize, "pointerdown", 100);
  await pointer(resize, "pointermove", 140);
  await pointer(resize, "pointerup", 140);
  assert.equal(parseFloat(floating.style.width), floatingWidth + 40);
  assert.equal(floating.querySelectorAll('.kd-pip-resize').length, 8, "all edges and corners resize the window");
  const resizeAt = async (edge: string, dx: number, dy: number, finish = "pointerup") => {
    const handle = floating.querySelector(`[data-edge="${edge}"]`)!;
    for (const [type, x, y] of [["pointerdown", 100, 100], ["pointermove", 100+dx, 100+dy], [finish, 100+dx, 100+dy]] as const) {
      await act(async () => handle.dispatchEvent(new dom.window.MouseEvent(type, {bubbles:true, button:0, clientX:x, clientY:y})));
    }
  };
  let widthBefore = parseFloat(floating.style.width);
  await resizeAt("se", 0, 18);
  assert.equal(parseFloat(floating.style.width), widthBefore + 32, "vertical corner drags also resize, preserving the canvas ratio");
  widthBefore = parseFloat(floating.style.width);
  const rightBefore = parseFloat(floating.style.left) + widthBefore;
  await resizeAt("w", 24, 0);
  assert.equal(parseFloat(floating.style.width), widthBefore - 24);
  assert.equal(parseFloat(floating.style.left) + parseFloat(floating.style.width), rightBefore, "left edge keeps the opposite edge anchored");
  const beforeCanceledResize = floating.style.cssText;
  await resizeAt("n", 0, -18, "pointercancel");
  assert.equal(floating.style.cssText, beforeCanceledResize, "canceling a resize restores the window");
  assert.deepEqual(useWorkshopStore.getState().draft, beforeWindowDrag);
  assert.equal(saves, windowDragSaves, "resizing the window never edits or saves the composition");
  const floatScrub = floating.querySelector<HTMLElement>('[role="slider"]')!;
  floatScrub.getBoundingClientRect = () => ({left:0,top:0,right:300,bottom:4,width:300,height:4,x:0,y:0,toJSON(){}});
  await pointer(floatScrub, "pointerdown", 120);
  assert.equal(useWorkshopStore.getState().scrubbing, true, "floating scrub defers audible seeks during the gesture");
  await pointer(floatScrub, "pointermove", 150);
  await pointer(floatScrub, "pointerup", 150);
  assert.equal(useWorkshopStore.getState().scrubbing, false, "floating scrub releases ownership after commit");
  const beforePreviewClose = structuredClone(useWorkshopStore.getState().draft);
  await click("关闭作品预览小窗");
  assert.equal(document.querySelector('.vj-floating-preview'), null);
  assert.deepEqual(useWorkshopStore.getState().draft, beforePreviewClose, "closing the preview does not edit the composition");
  const trim = document.querySelector('[aria-label="调整片段入点"]')!;
  const savedPosition = useWorkshopStore.getState().position;
  await act(async () =>
    trim.dispatchEvent(
      new dom.window.MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 10,
      }),
    ),
  );
  assert.ok(document.querySelector('.vj-floating-preview .kd-pip-float-chrome'), "trimming automatically opens the shared floating preview");
  assert.equal(document.querySelector('.vj-floating-preview header'), null, "preview has no separate header strip");
  assert.deepEqual(useWorkshopStore.getState().trimPreview, {
    clipId: "c",
    edge: "in",
  });
  await act(async () =>
    trim.dispatchEvent(
      new dom.window.MouseEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 60,
      }),
    ),
  );
  assert.ok(
    useWorkshopStore.getState().draft!.layers[0].clips[0].source_in_ms > 0,
  );
  assert.equal(
    useWorkshopStore.getState().position,
    savedPosition,
    "trim inspection does not move the composition clock",
  );
  await pointer(trim, "pointerup", 60);
  assert.equal(useWorkshopStore.getState().trimPreview, null);
  await click("撤销");
  saves = 0;
  await act(async () => {
    useWorkshopStore.getState().select("c");
    useWorkshopStore.getState().seek(4000);
  });
  await act(async () => document.querySelector('[data-clip-id="c"]')!.dispatchEvent(new dom.window.MouseEvent("contextmenu", {bubbles:true, clientX:100,clientY:100})));
  assert.ok(document.querySelector('[aria-label="片段操作菜单"]'));
  assert.match(document.querySelector('.vj-clip-menu')!.textContent!, /画面.*声音.*变速/);
  assert.doesNotMatch(document.querySelector('.vj-clip-menu')!.textContent!, /快慢快|慢快慢|淡入/);
  await act(async () => document.querySelector('.vj-clip-menu')!.dispatchEvent(new dom.window.KeyboardEvent("keydown", {key:"Escape",bubbles:true})));
  assert.equal(document.querySelector('.vj-clip-menu'), null);
  const openClipMenu = async (id = "c") => act(async () => {
    document.querySelector(`[data-clip-id="${id}"]`)!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
  });
  await openClipMenu();
  await pointer(document.querySelector('.vj-clip-menu summary')!, "pointerdown", 100);
  assert.ok(document.querySelector('.vj-clip-menu'), "interacting inside the menu keeps it open");
  const outsideClip = document.querySelector('[data-clip-id="c"]')!;
  await pointer(outsideClip, "pointerdown", 100);
  assert.equal(document.querySelector('.vj-clip-menu'), null, "outside clip gestures dismiss the menu even when they stop propagation");
  await pointer(outsideClip, "pointerup", 100);
  await openClipMenu();
  const scaleInput = document.querySelector<HTMLInputElement>('.vj-clip-menu input[aria-label="大小"]')!;
  await act(async () => { scaleInput.focus(); scaleInput.value = "75"; });
  await pointer(document.body, "pointerdown", 100);
  assert.equal(document.querySelector('.vj-clip-menu'), null);
  assert.equal(useWorkshopStore.getState().draft!.layers[0].clips[0].picture.scale, .75, "outside dismissal commits the focused value");
  assert.equal(server.canvas.import_picture?.scale, .75, "right-click edits also update the saved import layout");
  assert.equal(pictureValue("大小").value, "75", "toolbar follows the selected clip's context edits");
  await click("撤销");
  await act(async () => {
    useWorkshopStore.getState().edit(p => {
      p.layers[0].clips[0].picture = {x:.2, y:.8, scale:1.7, opacity:.6};
      return p;
    });
  });
  const beforePictureReset = structuredClone(useWorkshopStore.getState().draft!.layers[0].clips[0]);
  await act(async () => document.querySelector('.vj-picture-hit[data-clip-id="c"]')!.dispatchEvent(new dom.window.MouseEvent("contextmenu", {bubbles:true, clientX:100, clientY:100})));
  await act(async () => {
    Array.from(document.querySelectorAll<HTMLButtonElement>('.vj-clip-menu button')).find(b => b.textContent === "还原原始比例")!.click();
    await useWorkshopStore.getState().flush();
  });
  assert.equal(document.querySelector('.vj-clip-menu'), null);
  assert.deepEqual(useWorkshopStore.getState().draft!.layers[0].clips[0], {
    ...beforePictureReset, picture:{x:.5, y:.5, scale:1, opacity:.6},
  }, "preview context action restores centered source aspect without changing timing, speed or opacity");
  await click("撤销");
  assert.deepEqual(useWorkshopStore.getState().draft!.layers[0].clips[0], beforePictureReset, "picture reset is one undo step");
  await click("撤销");
  await openClipMenu();
  await act(async () => {
    Array.from(document.querySelectorAll<HTMLButtonElement>('.vj-clip-menu button')).find(b => b.textContent === "删除片段")!.click();
    await useWorkshopStore.getState().flush();
  });
  assert.equal(document.querySelectorAll('.vj-clip').length, 0, "context menu deletes the chosen clip");
  assert.equal(document.querySelector('.vj-clip-menu'), null);
  await click("撤销");
  assert.equal(document.querySelectorAll('.vj-clip').length, 1, "context menu deletion is undoable");
  const fadeHandle = document.querySelector('[aria-label="调整画面淡入"]')!;
  await pointer(fadeHandle, "pointerdown", 20);
  await pointer(fadeHandle, "pointermove", 55);
  await pointer(fadeHandle, "pointerup", 55);
  assert.ok(useWorkshopStore.getState().draft!.layers[0].clips[0].fades.video_in_ms > 0, "dragging curve control changes fade duration");
  assert.ok(document.querySelector('[aria-label="画面淡化曲线"] path'));
  await click("撤销");
  saves = 0;
  await click("剪断选中片段");
  assert.equal(document.querySelectorAll(".vj-clip").length, 2);
  assert.equal(saves, 1);
  await openClipMenu();
  await act(async () => {
    Array.from(document.querySelectorAll<HTMLButtonElement>('.vj-clip-menu button')).find(b => b.textContent === "删除并闭合本行空隙")!.click();
    await useWorkshopStore.getState().flush();
  });
  assert.equal(document.querySelectorAll('.vj-clip').length, 1);
  assert.equal(useWorkshopStore.getState().draft!.layers[0].clips[0].start_ms, 0, "context ripple deletion closes the gap on this row");
  await click("撤销");
  assert.equal(document.querySelectorAll('.vj-clip').length, 2);
  const shortcut = async (target: Element, options: KeyboardEventInit) => {
    const event = new dom.window.KeyboardEvent("keydown",{bubbles:true,cancelable:true,...options});
    await act(async () => { target.dispatchEvent(event); await useWorkshopStore.getState().flush(); });
    return event.defaultPrevented;
  };
  await act(async () => editor.dispatchEvent(new dom.window.MouseEvent("pointerdown",{bubbles:true})));
  assert.equal(await shortcut(document.body,{key:"z",ctrlKey:true}),true);
  assert.equal(document.querySelectorAll(".vj-clip").length,1,"Ctrl Z works after drag focus returns to body");
  await shortcut(document.body,{key:"z",ctrlKey:true,shiftKey:true});
  assert.equal(document.querySelectorAll(".vj-clip").length,2);
  const textInput = document.querySelector<HTMLInputElement>('[aria-label="导出名称"]')!;
  assert.equal(await shortcut(textInput,{key:"z",ctrlKey:true}),false,"text fields keep native text undo");
  await act(async () => document.body.dispatchEvent(new dom.window.MouseEvent("pointerdown",{bubbles:true})));
  assert.equal(await shortcut(document.body,{key:"z",ctrlKey:true}),false,"library interaction releases workshop shortcut ownership");
  assert.equal(document.querySelectorAll(".vj-clip").length,2);
  const second = useWorkshopStore.getState().draft!.layers[0].clips[1];
  await act(async () => useWorkshopStore.getState().select(second.id));
  await click("删除片段");
  assert.equal(document.querySelectorAll(".vj-clip").length, 1);
  await click("撤销");
  assert.equal(document.querySelectorAll(".vj-clip").length, 2);
  await click("重做");
  assert.equal(document.querySelectorAll(".vj-clip").length, 1);
  await act(async () => useWorkshopStore.getState().select("c"));
  await click("复制片段");
  assert.equal(document.querySelectorAll(".vj-track-row").length, 2);
  const before = saves;
  await act(async () => {
    const state = useWorkshopStore.getState();
    state.begin();
    for (let n = 1; n <= 6; n++) {
      const next = structuredClone(state.draft!);
      next.layers[0].clips[0].picture.x = n / 10;
      state.transient(next);
    }
    state.commit();
    await state.flush();
  });
  assert.equal(saves, before + 1, "a drag is persisted once");
  const local = useWorkshopStore.getState().draft!;
  await act(async () =>
    useWorkshopStore.getState().accept({
      session: "ui",
      revision: revision - 1,
      projects: [p],
      jobs: [],
    }),
  );
  assert.equal(useWorkshopStore.getState().draft!.revision, local.revision);
  additional.push({...structuredClone(server), id:"second", name:"任务 2"});
  revision++;
  await act(async () => useWorkshopStore.getState().accept(await api.workshop()));
  assert.equal(document.querySelectorAll('.vj-task-entry').length, 1, "expanded editing hides other task cards");
  assert.equal(document.querySelectorAll('.vj-task-summary').length, 0, "expanded task minimizes the overview to leave room for the bottom tracks");
  await click("展开编辑 测试作品");
  assert.equal(document.querySelectorAll('.vj-task-entry').length, 2);
  await click("展开编辑 任务 2");
  assert.equal(useWorkshopStore.getState().activeId, "second");
  assert.equal(document.querySelectorAll('.vj-task-entry[data-expanded="true"]').length, 1);
  assert.equal(document.querySelectorAll('.vj-task-editor').length, 1, "only the expanded task owns a preview");
  await click("展开编辑 任务 2");
  assert.equal(document.querySelectorAll('.vj-task-editor').length, 0, "collapse releases the editor and its decoders");
  const snapshotBeforeSingleExport = api.workshop;
  let singleProgress = .31;
  api.exportWorkshop = async id => {
    assert.equal(id, "second");
    revision++;
    api.workshop = async () => ({...await snapshotBeforeSingleExport(), jobs:[{id:"single",project_id:id,revision:server.revision,phase:"rendering",progress:singleProgress,error:"",path:"",track_id:null}]});
    return api.workshop();
  };
  await click("展开编辑 任务 2");
  await act(async () => {
    document.querySelector<HTMLButtonElement>('.vj-task-editor .vj-header > .vj-primary')!.click();
    await useWorkshopStore.getState().flush();
  });
  await click("展开编辑 任务 2");
  assert.match(document.querySelector('.vj-task-heading-progress')!.textContent!, /导出中.*31\.0%/);
  assert.ok(document.querySelector('[aria-label="取消这项导出"]'), "single export can be canceled outside its editor");
  assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="删除任务 任务 2"]')!.disabled,true);
  singleProgress = .63;
  revision++;
  await act(async () => useWorkshopStore.getState().handleEvent({type:"workshop.updated",payload:await api.workshop()}));
  assert.equal(document.querySelector<HTMLProgressElement>('[aria-label="任务 2 导出进度"]')!.value,.63,"collapsed task receives live export progress");
  api.workshop = snapshotBeforeSingleExport;
  revision++;
  await act(async () => useWorkshopStore.getState().accept(await api.workshop()));
  const exported: string[] = [];
  api.exportWorkshop = async (id) => { exported.push(id); return api.workshop(); };
  await act(async () => {
    [...document.querySelectorAll('button')].find(b => b.textContent === "全部导出")!.click();
    await new Promise(resolve => setTimeout(resolve,0));
    await useWorkshopStore.getState().flush();
  });
  assert.equal(document.querySelector('[aria-label="全部导出"][role="dialog"]'),null,"batch export starts inline without a dialog");
  assert.deepEqual(exported, ["p", "second"], "batch export retains each independent task");
  const originalSnapshot = api.workshop;
  let exportJobs = [{id:"cancel-one", project_id:"p", revision:server.revision, phase:"rendering", progress:.51, detail:"准备视频 1/6", error:"", path:"", track_id:null}];
  api.workshop = async () => ({...await originalSnapshot(), jobs:exportJobs});
  const canceled: string[] = [];
  api.cancelWorkshopExport = async id => {
    canceled.push(id); exportJobs = exportJobs.map(j => j.id === id ? {...j, phase:"canceled"} : j);
    revision++; return api.workshop();
  };
  revision++;
  await act(async () => useWorkshopStore.getState().accept(await api.workshop()));
  assert.ok(document.querySelector('[aria-label="取消这项导出"]'), "collapsed task exposes cancellation next to progress");
  await click("取消这项导出");
  assert.deepEqual(canceled, ["cancel-one"]);
  assert.equal(document.querySelectorAll('.vj-task-editor').length, 0, "cancel does not expand task");
  assert.ok(!document.body.textContent!.includes("已取消"));
  assert.ok(!document.body.textContent!.includes("准备视频 1/6"), "canceled progress details are cleared from view");
  const originalActive = useWorkshopStore.getState().activeId;
  useWorkshopStore.setState({activeId:"second"});
  exported.length = 0;
  await click(`导出任务 ${server.name}`);
  await act(async () => { await useWorkshopStore.getState().flush(); });
  assert.deepEqual(exported, ["p"], "row export targets the canceled project without changing selection");
  assert.equal(useWorkshopStore.getState().activeId,"second");
  useWorkshopStore.setState({activeId:originalActive});
  const cancelApi = api.cancelWorkshopExport;
  api.cancelWorkshopExport = async id => { await cancelApi(id); throw new Error("Load failed"); };
  await act(async () => { await useWorkshopStore.getState().cancelExport("cancel-one"); });
  assert.equal(useWorkshopStore.getState().error,"", "confirmed cancellation suppresses a lost response error");
  api.cancelWorkshopExport = cancelApi;
  let submitted!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => { submitted = r; });
  const hold = new Promise<void>(r => { release = r; });
  exported.length = 0;
  api.exportWorkshop = async id => {
    exported.push(id); submitted(); await hold;
    exportJobs.push({id:"late-job", project_id:id, revision:server.revision, phase:"queued", progress:0, detail:"", error:"", path:"", track_id:null});
    revision++; return api.workshop();
  };
  await act(async () => {
    const submitting = useWorkshopStore.getState().exportAll();
    await waiting;
    await useWorkshopStore.getState().cancelAllExports();
    release(); await submitting;
  });
  assert.deepEqual(exported, ["p"], "cancel all prevents remaining tasks being submitted");
  assert.ok(canceled.includes("late-job"), "cancel all also cancels an in-flight submission receipt");
  api.workshop = originalSnapshot;
  await act(async () => {
    await useWorkshopStore.getState().selectProject("p");
    api.intakeWorkshop = async () => {
      const imported = await api.workshop();
      server = structuredClone(server);
      server.revision++;
      server.layers[0].clips[0].start_ms += 1234;
      revision++;
      useWorkshopStore.getState().handleEvent({type:"workshop.updated", payload:await api.workshop()});
      return {snapshot:imported,before:structuredClone(server),project_id:server.id,errors:[]};
    };
    await useWorkshopStore.getState().add([1]);
  });
  assert.equal(useWorkshopStore.getState().draft!.revision, server.revision,
    "an automatic match arriving before the import response remains visible");
  assert.equal(useWorkshopStore.getState().draft!.layers[0].clips[0].start_ms,
    server.layers[0].clips[0].start_ms);
  const { WorkshopAddMenu } = await import("../src/components/composition/WorkshopAddMenu");
  const added: string[] = [];
  api.intakeWorkshop = async input => { added.push(input.project_id!); const snapshot=await api.workshop(); return {snapshot,before: snapshot.projects.find(p => p.id === input.project_id)!,project_id:input.project_id,errors:[]}; };
  api.createWorkshop = async () => {
    additional.push({...structuredClone(server), id:"new", name:"任务 3", layers:[]});
    revision++; return api.workshop();
  };
  await act(async () => root.render(createElement(WorkshopAddMenu, { ids:() => [1], close:() => {} })));
  await act(async () => {
    [...document.querySelectorAll('button')].find(b => b.textContent === "任务 2")!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await useWorkshopStore.getState().flush();
  });
  assert.deepEqual(added, ["second"], "context menu routes to the chosen task");
  await act(async () => {
    [...document.querySelectorAll('button')].find(b => b.textContent === "添加到新任务")!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await useWorkshopStore.getState().flush();
  });
  assert.deepEqual(added, ["second", "new"]);
  assert.equal(useWorkshopStore.getState().expandedId, "new");
  const deletedTasks: string[] = [];
  api.deleteWorkshop = async (id, base) => {
    const index = additional.findIndex(project => project.id === id);
    assert.ok(index >= 0);
    assert.equal(base, additional[index].revision);
    deletedTasks.push(id);
    additional.splice(index, 1);
    revision++;
    return api.workshop();
  };
  await act(async () => root.render(createElement(CompositionWorkshop)));
  await click("删除任务 任务 3");
  assert.deepEqual(deletedTasks,["new"]);
  assert.equal(document.querySelector('.vj-task-editor'),null,"deleting the expanded task unmounts its preview");
  assert.equal(useWorkshopStore.getState().activeId,"p");
  await click("删除任务 任务 2");
  assert.deepEqual(deletedTasks,["new","second"],"collapsed deletion targets that row, not the active project");
  assert.equal(useWorkshopStore.getState().activeId,"p");
  assert.equal(useWorkshopStore.getState().draft!.sources.length,server.sources.length,"deleting another task preserves active source references");
  await act(async () => useWorkshopStore.getState().refresh());
  assert.equal(document.querySelectorAll('.vj-task-entry').length,1,"refresh does not restore removed tasks");
  const { WorkshopTaskSummary } = await import("../src/components/composition/WorkshopTaskSummary");
  const summary = structuredClone(p);
  summary.sources.push({...summary.sources[0], id:"music", video:false, title:"配乐"});
  summary.layers.unshift({id:"music-layer", source_id:"music", clips:[{
    ...structuredClone(p.layers[0].clips[0]), id:"music-clip", source_id:"music",
    start_ms:2000,
  }]});
  await act(async () => root.render(createElement(WorkshopTaskSummary, {project: summary})));
  assert.ok(document.querySelector('[aria-label="双素材详情"]'));
  assert.deepEqual([...document.querySelectorAll('.vj-task-media-title')].map(n => n.textContent), ["动画", "配乐"], "pair keeps the video at left regardless of layer ordering");
  assert.match(document.body.textContent!, /2 路混音/);
  assert.match(document.body.textContent!, /Offset \+2\.000 s/);
  assert.equal(document.querySelectorAll('video,audio').length, 0, "task overview never mounts a playback decoder");
  const section = {...structuredClone(summary.layers[1].clips[0]), id:"cut", start_ms:12000, source_in_ms:5000};
  summary.layers[1].clips.push(section);
  summary.layers.push({...structuredClone(summary.layers[1]), id:"third"});
  await act(async () => root.render(createElement(WorkshopTaskSummary, {project: structuredClone(summary)})));
  assert.ok(document.querySelector('[aria-label="素材混合详情"]'));
  assert.equal(document.querySelectorAll('.vj-task-mini-track').length, 3);
  assert.match(document.body.textContent!, /分段 Offset \+0\.000 s \/ \+7\.000 s/);
  const { useWorkshopPlayback } = await import("../src/lib/workshopPlayback");
  const { WorkshopTimeline } = await import("../src/components/composition/WorkshopTimeline");
  function AuditionTimeline() { return createElement(WorkshopTimeline, {playback:useWorkshopPlayback()}); }
  const beforeAudition = structuredClone(summary), savesBeforeAudition = saves;
  await act(async () => {
    useWorkshopStore.setState({activeId:"p", draft:summary, position:4321});
    root.render(createElement(AuditionTimeline));
  });
  await click("关闭音乐试听：配乐");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); });
  assert.equal(document.querySelector('.vj-layer-audio')?.getAttribute('aria-pressed'), 'false');
  assert.equal(auditionRequests.at(-1), 'music-layer', "audio switch requests a separate preview mix");
  assert.equal(useWorkshopStore.getState().position, 4321, "audition keeps the alignment playhead");
  assert.deepEqual(useWorkshopStore.getState().draft, beforeAudition, "audition leaves cuts, fades and export sound unchanged");
  assert.equal(saves, savesBeforeAudition, "audition never writes a project revision");
  await click("恢复音乐试听：配乐");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); });
  assert.equal(document.querySelector('.vj-layer-audio')?.getAttribute('aria-pressed'), 'true');
  assert.equal(auditionRequests.at(-1), undefined, "second click prepares the saved mix without rebuilding video");
  assert.equal(useWorkshopStore.getState().position, 4321);
  const { WorkshopPreview } = await import("../src/components/composition/WorkshopPreview");
  const { StrictMode } = await import("react");
  await act(async () => {
    useWorkshopStore.setState({activeId:"p", draft:structuredClone(p), position:0});
    root.render(createElement(StrictMode, null, createElement(WorkshopPreview, {playback:{
      ticket:null, playing:false, loading:false, error:"", trackId:null,
      toggle() {}, seek() {}, stop() {}, beginScrub() {}, endScrub() {}, time:() => 0,
    }})));
  });
  const mountedVideo = document.querySelector('video')!;
  assert.equal(mountedVideo.getAttribute('src'), '/source.mp4', "StrictMode cleanup/replay restores the unloaded source");
  assert.equal(document.querySelector('.vj-preview canvas'), null, "preview uses native video compositing without a per-frame canvas copy");
  const previewPlayback = {
    ticket:"retry-ticket", playing:false, loading:false, error:"", trackId:null,
    toggle() {}, seek() {}, stop() {}, beginScrub() {}, endScrub() {}, time:() => 0,
  };
  await act(async () => {
    const draft = structuredClone(p);
    draft.layers[0].clips[0].speed.start = 0.98;
    draft.layers[0].clips[0].speed.domain_end_ms = 40000;
    draft.layers[0].clips[0].source_out_ms = 40000;
    draft.sources[0].duration_ms = 40000;
    useWorkshopStore.setState({draft});
    root.render(createElement(WorkshopPreview, {playback:previewPlayback}));
  });
  const continuousVideo = document.querySelector('video')!;
  await act(async () => { continuousVideo.dispatchEvent(new dom.window.Event('loadedmetadata')); });
  assert.equal(continuousVideo.dataset.proxy, 'false');
  assert.equal(continuousVideo.getAttribute('src'), '/source.mp4');
  assert.equal(continuousVideo.playbackRate, 0.98);
  for (const position of [7990, 8010, 16010, 24010]) {
    await act(async () => { useWorkshopStore.setState({position}); });
    assert.equal(document.querySelector('video'), continuousVideo,
      'constant speed keeps one decoder across every former 8-second chunk boundary');
  }
  await act(async () => {
    const draft = structuredClone(p);
    draft.layers[0].clips[0].speed.preset = 'pulse';
    draft.layers[0].clips[0].speed.start = 0.98;
    useWorkshopStore.setState({draft, position:0});
  });
  const failingVideo = document.querySelector('video')!;
  assert.equal(failingVideo.dataset.proxy, 'true', 'speed curves retain the retimed preview path');
  let retries = 0;
  failingVideo.load = () => { retries++; };
  for (const delay of [420, 820]) {
    await act(async () => {
      failingVideo.dispatchEvent(new dom.window.Event('error'));
      await new Promise(resolve => setTimeout(resolve, delay));
    });
  }
  assert.equal(retries, 2, "failed chunks reload with bounded automatic retries");
  assert.equal(document.querySelector('.vj-error'), null, "transient failures do not leave an error banner");
  await act(async () => { failingVideo.dispatchEvent(new dom.window.Event('error')); });
  assert.match(document.querySelector('.vj-error')!.textContent!, /无法预览/);
  await act(async () => { failingVideo.dispatchEvent(new dom.window.Event('loadeddata')); });
  assert.equal(document.querySelector('.vj-error'), null, "a recovered chunk clears its own error");
  await act(async () => { failingVideo.dispatchEvent(new dom.window.Event('error')); });
  await act(async () => { document.querySelector<HTMLButtonElement>('.vj-error button')!.click(); });
  assert.notEqual(document.querySelector('video'), failingVideo, "manual retry starts a fresh decoder");
  assert.equal(document.querySelector('.vj-error'), null, "manual retry removes the old failure");
  const pendingVideo = document.querySelector('video')!;
  let pendingLoads = 0;
  pendingVideo.load = () => { pendingLoads++; };
  await act(async () => {
    pendingVideo.dispatchEvent(new dom.window.Event('error'));
    useWorkshopStore.setState({position:9000});
  });
  const loadsAfterCleanup = pendingLoads;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  assert.equal(pendingLoads, loadsAfterCleanup, "leaving a chunk cancels its pending retry");
  const { runtimePlayer } = await import("../src/lib/unifiedPlayer");
  const player = runtimePlayer();
  const originals = {state:player.state, subscribe:player.subscribe, pause:player.pause, play:player.play, seek:player.seek, replaceAudio:player.replaceAudio};
  let state = {...player.state()}, notify = () => {}, pauses = 0, resumes = 0;
  const audioSeeks: number[] = [], audioReplacements: number[] = [];
  player.replaceAudio = async () => { audioReplacements.push(state.currentTime); return state; };
  player.state = () => state;
  player.subscribe = listener => { notify = () => listener(state, state); return () => { notify = () => {}; }; };
  player.pause = async () => { pauses++; state = {...state, playing:false, status:"paused"}; notify(); };
  player.play = async () => { resumes++; state = {...state, playing:true, status:"playing"}; notify(); };
  player.seek = async seconds => { audioSeeks.push(seconds); state = {...state, currentTime:seconds}; notify(); };
  api.track = async () => ({id:1, title:"动画", path:"/source.mp4", format:"mp4"} as import("../src/types").Track);
  api.workshopAudioUrl = () => "/preview.wav";
  const previewStarts: (number | undefined)[] = [];
  const played = (event: Event) => {
    const req = (event as CustomEvent<import("../src/lib/playTrack").PlayRequest>).detail;
    previewStarts.push(req.position);
    state = {...state, trackId:req.track.id, playing:true, buffering:false, status:"playing"}; notify();
  };
  window.addEventListener("kd:play", played);
  let transport!: ReturnType<typeof useWorkshopPlayback>;
  function TransportProbe() { transport = useWorkshopPlayback(); return null; }
  await act(async () => {
    useWorkshopStore.setState({activeId:"p", draft:structuredClone(p), saving:0, gesture:null, position:0});
    root.render(createElement(TransportProbe));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  assert.equal(mountedVideo.getAttribute('src'), null, "closing preview unloads its media source");
  await act(async () => { transport.toggle(); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => {
    useWorkshopStore.setState({scrubbing:true}); transport.beginScrub();
    for (let i = 0; i < 100; i++) transport.seek(i * 50);
  });
  assert.equal(pauses, 1, "a scrub pauses audio once");
  assert.equal(audioSeeks.length, 0, "pointer moves do not repeatedly rebuild native audio");
  await act(async () => {
    useWorkshopStore.setState({scrubbing:false}); transport.endScrub();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.deepEqual(audioSeeks, [4.95], "release commits only the latest pointer position");
  assert.equal(resumes, 1, "playing audio resumes after the final seek");
  await act(async () => {
    useWorkshopStore.setState({scrubbing:true}); transport.beginScrub(); transport.seek(2000);
    useWorkshopStore.setState({scrubbing:false}); transport.endScrub(); transport.stop();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(resumes, 1, "a stop invalidates a pending scrub resume");
  await act(async () => { transport.toggle(); });
  state = {...state, currentTime:2};
  transport.time();
  state = {...state, currentTime:4.321};
  const startsBeforeAudio = previewStarts.length, pausesBeforeAudio = pauses, stableTicket = transport.ticket;
  await act(async () => { useWorkshopStore.getState().toggleAudioLayer("l"); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); });
  assert.equal(audioReplacements.at(-1), 4.321, "sound switches on the live clock");
  assert.equal(previewStarts.length, startsBeforeAudio, "switching audio never replays the video");
  assert.equal(pauses, pausesBeforeAudio);
  assert.equal(transport.ticket, stableTicket);
  assert.equal(transport.playing, true, "audition keeps an active transport playing");
  await act(async () => { useWorkshopStore.getState().toggleAudioLayer("l"); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); });
  assert.equal(audioReplacements.length, 2, "restoring the cached mix also replaces only audio");
  assert.equal(transport.playing, true);
  await act(async () => root.unmount());
  window.removeEventListener("kd:play", played);
  Object.assign(player, originals);
  const { makeCompositionPreviewTrack, publishStreamTrack } =
    await import("../src/lib/streamTrack");
  localStorage.setItem("kd-active-stream-track", "previous online song");
  localStorage.setItem("kd-active-stream-playback", "previous clock");
  const preview = makeCompositionPreviewTrack(
    { id: 1 } as import("../src/types").Track,
    "预览",
    "http://localhost/ephemeral",
    10,
  );
  publishStreamTrack(preview);
  assert.equal(
    localStorage.getItem("kd-active-stream-track"),
    null,
    "an ephemeral composition must not restore an older online song",
  );
  assert.equal(localStorage.getItem("kd-active-stream-playback"), null);
  const completedProject = structuredClone(p);
  const completeJob = {id:"completed", project_id:p.id, revision:p.revision, phase:"complete", progress:1, error:"", path:"/finished.mp4", track_id:42};
  useWorkshopStore.setState({activeId:p.id, expandedId:p.id, draft:structuredClone(p), gesture:null, saving:0});
  const snapshotRevision = useWorkshopStore.getState().revision + 1;
  const completedSnapshot = {session:useWorkshopStore.getState().session, revision:snapshotRevision, projects:[completedProject], jobs:[completeJob]};
  useWorkshopStore.getState().accept(completedSnapshot);
  assert.equal(useWorkshopStore.getState().projects.length,1,"successful export retains the editable project");
  assert.equal(useWorkshopStore.getState().jobs.length,1,"completed export remains available for status");
  assert.equal(useWorkshopStore.getState().expandedId,p.id,"export completion keeps the editor open");
  assert.deepEqual(useWorkshopStore.getState().draft,completedProject,"all clip edits survive export");
  useWorkshopStore.getState().accept({...completedSnapshot,revision:snapshotRevision+1});
  assert.equal(useWorkshopStore.getState().projects.length,1,"refresh retains completed projects");
  const newer = {...structuredClone(p),revision:p.revision+1};
  useWorkshopStore.getState().accept({...completedSnapshot,revision:snapshotRevision+2,projects:[newer]});
  assert.equal(useWorkshopStore.getState().projects.length,1,"exporting an older revision preserves newer edits");
  useWorkshopStore.setState({draft:structuredClone(p),activeId:p.id});
  useWorkshopStore.getState().accept({...completedSnapshot,revision:snapshotRevision+3,jobs:[{...completeJob,phase:"import_failed"}]});
  assert.equal(useWorkshopStore.getState().projects.length,1,"failed import remains available for retry");
  useWorkshopStore.getState().accept({...completedSnapshot,revision:snapshotRevision+4,projects:[],jobs:[]});
  assert.equal(useWorkshopStore.getState().projects.length,0,"explicit deletion still removes the project");
  assert.equal(useWorkshopStore.getState().expandedId,null);
  dom.window.close();
});

test("BPM prerequisite precedes two explicit matching choices with independent actions", async () => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkshopPositionChoices } = await import("../src/components/composition/WorkshopPositionChoices");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const selected: string[] = [];
  const analysis: WorkshopPositionAnalysis = {
    id: "a", layer_id: "l", phase: "ready", progress: 1, reference_id: "music",
    reference_title: "参考音乐", reason: "", applied: "speed-longest",
    presets: [
      { id: "speed-longest", label: "最大匹配 · 保留完整", prerequisite: "BPM 适配 98.50% 后", placements: [] },
      { id: "speed-sections", label: "裁切匹配段", prerequisite: "BPM 适配 98.50% 后", placements: [] },
    ],
  };
  const render = (saving: boolean, current = analysis) => act(async () => {
    root.render(createElement(WorkshopPositionChoices, { analysis: current, sourceTitle: "视频", saving,
      onApply: (id: string) => selected.push(id) }));
  });
  try {
    await render(false);
    assert.equal(host.querySelectorAll('[role="group"]').length, 1);
    assert.ok(host.textContent!.startsWith("BPM 适配 98.50% 后"));
    const buttons = [...host.querySelectorAll("button")];
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
    assert.ok(buttons[0].title.includes("保留完整视频"));
    assert.ok(buttons[1].title.includes("裁掉其余内容"));
    await act(async () => { buttons[0].click(); buttons[1].click(); });
    assert.deepEqual(selected, ["speed-longest", "speed-sections"]);
    await render(true);
    assert.ok([...host.querySelectorAll("button")].every(b => b.disabled));
    const placements = [0, 20000, 40000].map(start_ms => ({
      clip_id: "clip", source_in_ms: 10000, source_out_ms: 20000, start_ms, speed_multiplier: 1.05,
    }));
    await render(false, { ...analysis, applied: null, presets: [{
      id: "fuzzy-speed-sections", label: "分段匹配", prerequisite: "按音乐编排 · 分段变速适配", placements,
    }] });
    const assembled = host.querySelectorAll("button");
    assert.equal(assembled.length, 1, "all remix cuts belong to one action");
    assert.equal(assembled[0].textContent, "分段匹配 · 3 段");
    assert.ok(assembled[0].title.includes("一次应用全部匹配片段"));
    await act(async () => assembled[0].click());
    assert.equal(selected.at(-1), "fuzzy-speed-sections");
    await render(false, { ...analysis, presets: [] });
    assert.equal(host.textContent, "");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("workshop drop routes native files and claimed internal tracks once at the captured target", async () => {
  const {JSDOM}=await import("jsdom");
  const dom=new JSDOM("<!doctype html><body><div id='drop-root'></div></body>",{url:"http://localhost"});
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,CustomEvent:dom.window.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true});
  const {createElement,act}=await import("react");const {createRoot}=await import("react-dom/client");
  const {useWorkshopDrop,dropWorkshopTracks,workshopDropTargetAt}=await import("../src/lib/workshopDrop");
  const {announceTrackDrag}=await import("../src/lib/trackDrag");
  const {useWorkshopStore}=await import("../src/stores/workshopStore");
  let native: ((e:import("../src/types/workshop").WorkshopNativeDrop)=>void)|undefined;
  const {getBridge}=await import("../src/lib/bridge");
  const savedListener=getBridge().onMediaDrop;
  getBridge().onMediaDrop=async handler=>{native=handler;return ()=>{native=undefined;};};
  const calls: Array<{ids:number[];paths:string[];at?:number;target?:string|null}>=[];
  const {useLibraryStore}=await import("../src/stores/libraryStore");
  const originalScan=useLibraryStore.getState().startScan;
  const scans:string[][]=[];
  useLibraryStore.setState({startScan:async paths=>{scans.push(paths);return {job_id:"scan",found:0};}});
  const original=useWorkshopStore.getState().intake;
  useWorkshopStore.setState({activeId:"p",position:640,intake:async(ids,paths,at,target)=>{calls.push({ids,paths,at,target});}});
  function Target(){useWorkshopDrop();return createElement("div",{"data-vj-drop":""},createElement("section",{"data-vj-project":"second"},createElement("div",{"data-vj-time-scale":"0.02",id:"rail"})));}
  const root=createRoot(document.getElementById("drop-root")!);
  await act(async()=>root.render(createElement(Target)));
  const rail=document.getElementById("rail")!;
  rail.getBoundingClientRect=()=>({left:100,top:0,width:200,height:30,right:300,bottom:30,x:100,y:0,toJSON(){}});
  document.elementFromPoint=()=>rail;
  assert.equal(workshopDropTargetAt(150,10)?.project,"second");
  assert.equal(workshopDropTargetAt(150,10)?.at,2500);
  await act(async()=>{announceTrackDrag([11,12]);dropWorkshopTracks(150,10);dropWorkshopTracks(150,10);});
  assert.equal(calls.length,1);assert.deepEqual(calls[0],{ids:[11,12],paths:[],at:2500,target:"second"});
  await act(async()=>{
    native!({id:1,phase:"enter",x:150,y:10,paths:["/tmp/a.gif"]});
    useWorkshopStore.setState({activeId:"another",position:9000});
    native!({id:1,phase:"drop",x:150,y:10,paths:["/tmp/a.gif"],folders:["/Users/kumo/Downloads/nested"]});
    native!({id:1,phase:"drop",x:150,y:10,paths:["/tmp/a.gif"],folders:["/Users/kumo/Downloads/nested"]});
  });
  assert.equal(calls.length,2);assert.deepEqual(calls[1],{ids:[],paths:["/tmp/a.gif"],at:2500,target:"second"});
  assert.deepEqual(scans, [], "mixed Finder drop on VJ never scans directories");
  document.elementFromPoint=()=>document.body;
  await act(async()=>{
    native!({id:2,phase:"enter",x:5,y:5,paths:[]});
    native!({id:2,phase:"drop",x:5,y:5,paths:["/Users/kumo/Downloads/picture.png"],folders:[]});
  });
  assert.deepEqual(scans, [], "standalone file never expands to Downloads or all roots");
  await act(async()=>{
    native!({id:3,phase:"enter",x:5,y:5,paths:[]});
    native!({id:3,phase:"drop",x:5,y:5,paths:[],folders:["/music"]});
    native!({id:3,phase:"drop",x:5,y:5,paths:[],folders:["/music"]});
  });
  assert.deepEqual(scans, [["/music"]], "explicit folder drop is imported once");
  useLibraryStore.setState({startScan:originalScan});
  document.elementFromPoint=()=>rail.closest("section");
  assert.equal(workshopDropTargetAt(150,10)?.at,9000);
  await act(async()=>root.unmount());getBridge().onMediaDrop=savedListener;useWorkshopStore.setState({intake:original});dom.window.close();
});
