import assert from "node:assert/strict";
import test from "node:test";
import type { CompositionProject, RhythmAnalysis } from "../src/types/workshop";

test("preview clip rail owns precise BPM, sparse bars and sample-accurate trim snapping", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<body><div id='workstation'></div></body>", {url: "http://localhost"});
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => true;
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({left: 0, width: 1000, top: 0, bottom: 100, right: 1000, height: 100, x: 0, y: 0, toJSON() {}});
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkshopTimeline } = await import("../src/components/composition/WorkshopTimeline");
  const { useWorkshopStore } = await import("../src/stores/workshopStore");
  const { useWorkshopRhythmStore } = await import("../src/stores/workshopRhythmStore");
  const { api } = await import("../src/lib/api");
  const { clearAllWaveformCaches } = await import("../src/lib/waveformCache");
  const { workshopCutTime, rhythmKey, workshopGrid, clipBeatTimes } = await import("../src/lib/workshopRhythm");
  const { splitClip, visibleFade } = await import("../src/lib/workshop");
  let server: CompositionProject = {
    id: "preview-ui", name: "Preview", revision: 0, migrated_from: null,
    sources: [{id: "source", track_id: 901, title: "Song", path: "/song.wav", duration_ms: 10000, audio: true, video: false, kind: "audio", width: 0, height: 0, fps: 0, signature: "preview-signature"}],
    layers: [{id: "audio", source_id: "source", clips: [{id: "clip", source_id: "source", start_ms: 0, source_in_ms: 0, source_out_ms: 10000,
      speed: {preset: "constant", start: 1, middle: 1, end: 1, domain_start_ms: 0, domain_end_ms: 10000},
      picture: {x: .5, y: .5, scale: 1, opacity: 1}, sound: {muted: false, gain: 1, manual: false},
      fades: {offset_ms: 0, span_ms: 10000, video_in_ms: 0, video_out_ms: 0, audio_in_ms: 0, audio_out_ms: 0, linear: false}}]}],
    canvas: {width: 1920, height: 1080, fps: 30, initialized: false},
    output: {name: "Song", directory: "/tmp", format: "wav", in_ms: 0, out_ms: null, quality: 20, acceleration: "software"},
  };
  const analysis: RhythmAnalysis = {revision: "v4", duration: 10, precise: false, bpm: 120, confidence: .9,
    beats: [...Array.from({length: 10}, (_, i) => .137 + i * .5), 5.137, 6.137, 7.137, 8.137, 9.137],
    downbeats: [.137, 2.137, 4.137, 7.137], downbeat_confidence: .9,
    segments: [{start_seconds: 0, end_seconds: 5.137, bpm: 120, confidence: .9}, {start_seconds: 5.137, end_seconds: 10, bpm: 60, confidence: .9}], coverage: [[0, 10]],
  };
  const original = {waveform: api.waveform, rhythm: api.rhythm, analyze: api.analyzeRhythm, edit: api.editWorkshop, workshop: api.workshop, frame: api.workshopFrameUrl};
  const analysisRequests: boolean[] = [];
  let waveformAttempts = 0;
  api.waveform = async (_id, _buckets, profile, background) => {
    assert.equal(profile, "release-overview", "only the canonical preview waveform is requested");
    assert.equal(background, false);
    if (++waveformAttempts === 1) throw new Error("播放已开始，整曲波形生成已延后");
    return {track_id: 901, duration: 10, amp: Array.from({length: _buckets!}, (_, i) => [.3, 1, .2, .5][i % 4]), r: Array(_buckets).fill(255), g: Array(_buckets).fill(0), b: Array(_buckets).fill(0)};
  };
  api.workshopFrameUrl = () => "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
  api.rhythm = async () => ({analysis: structuredClone(analysis), status: null});
  api.analyzeRhythm = async (_id, precise) => { analysisRequests.push(!!precise); analysis.precise = true; return {job_id: "job", queued: 1}; };
  api.workshop = async () => ({session: "preview-ui", revision: server.revision, projects: [server], jobs: []});
  api.editWorkshop = async (_id, _revision, edit) => {
    server = {...server, ...structuredClone(edit), revision: server.revision + 1};
    return api.workshop();
  };
  assert.equal(useWorkshopStore.getState().barSnap, true, "bar snapping defaults on");
  useWorkshopStore.setState({session: "preview-ui", revision: 0, projects: [server], jobs: [], activeId: server.id, draft: structuredClone(server), selectedId: "clip", position: 0, snap: false, barSnap: true, past: [], future: [], saving: 0, gesture: null, positions: {}});
  useWorkshopRhythmStore.setState({results: {}, errors: {}, requesting: {}});
  const seeks: number[] = [];
  const playback = {ticket: null, playing: false, loading: false, error: "", trackId: 901, time: () => 0, toggle() {}, seek: (ms: number) => {seeks.push(ms); useWorkshopStore.setState({position: ms});}, beginScrub() {}, endScrub() {}, stop() {}};
  const root = createRoot(document.getElementById("workstation")!);
  const button = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  const pointer = async (node: HTMLElement, type: string, x: number, altKey = false) => act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent(type, {bubbles: true, button: 0, clientX: x, altKey}));
    await useWorkshopStore.getState().flush();
  });
  const scale = () => Number(document.querySelector<HTMLElement>('.vj-track-rail')!.dataset.vjTimeScale);
  const undo = async () => act(async () => {useWorkshopStore.getState().undo(); await useWorkshopStore.getState().flush();});
  try {
    await act(async () => root.render(createElement(WorkshopTimeline, {playback})));
    assert.deepEqual(analysisRequests, [true], "coarse cached analysis is upgraded using full-track precise mode");
    assert.ok(document.querySelector('.vj-rhythm-ruler'), "bars are visible before preview loading");
    assert.equal(document.querySelector('.ws-detail,.ws-audio-editor,.ws-tempo-segments'), null, "no separate detail editor or BPM button list");
    assert.equal(waveformAttempts, 1);
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 650));});
    assert.equal(waveformAttempts, 2);
    const rects = [...document.querySelectorAll<SVGRectElement>('.vj-wave-strip rect')];
    assert.ok(rects.length);
    assert.ok(rects.every(r => Number(r.getAttribute('y')) >= 16 && Number(r.getAttribute('y')) + Number(r.getAttribute('height')) === 60), "half waveform reserves only top label space and reaches the bottom edge");
    assert.match(document.querySelector('.vj-rhythm-ruler')!.textContent!, /120\.00 BPM.*60\.00 BPM/);
    assert.equal(document.querySelectorAll('video,audio,canvas').length, 0, "clip preview does not mount a detail waveform or decoder");
    const results = useWorkshopRhythmStore.getState().results;
    assert.equal(workshopCutTime(server, "clip", 2100, results, true), 2137);
    assert.equal(workshopCutTime(server, "clip", 2100, results, false), 2100);
    for (const beat of [637, 1137, 1637]) {
      const time = workshopCutTime(server, "clip", beat - 37, results, true);
      assert.equal(time, beat, "all three quarter-bar lines are cut targets, not only downbeats");
      const pieces = splitClip(server, "clip", time).layers[0].clips;
      assert.equal(pieces[0].source_out_ms, beat);
      assert.equal(pieces[1].source_in_ms, beat, "quarter-bar cuts remain sample-contiguous");
    }
    assert.equal(workshopCutTime(server, "clip", 6100, results, true), 6137, "tempo changes use actual beat positions");
    assert.equal(workshopCutTime(server, "clip", -10, results, true), -10);
    assert.equal(workshopCutTime(server, "clip", 10010, results, true), 10010);
    const short = structuredClone(server);
    Object.assign(short.layers[0].clips[0], {start_ms: 400, source_in_ms: 400, source_out_ms: 900});
    assert.equal(workshopCutTime(short, "clip", 600, results, true), 637, "clips without an interior downbeat still snap to a quarter-bar line");
    assert.equal(workshopCutTime(server, "clip", 600, {}, true), 600, "missing analysis preserves free cutting");
    const cut = splitClip(server, "clip", workshopCutTime(server, "clip", 2100, results, true));
    assert.equal(cut.layers[0].clips[0].source_out_ms, cut.layers[0].clips[1].source_in_ms, "split boundaries remain sample-contiguous");
    await act(async () => useWorkshopStore.setState({draft: cut}));
    assert.equal(analysisRequests.length, 1, "split clips share their source analysis");
    assert.equal(waveformAttempts, 2, "split clips reuse the preview cache");
    await act(async () => useWorkshopStore.setState({draft: structuredClone(server)}));
    const handle = button("调整片段入点");
    await pointer(handle, "pointerdown", 0);
    await pointer(handle, "pointermove", 600 * scale());
    await pointer(handle, "pointerup", 600 * scale());
    assert.equal(server.layers[0].clips[0].source_in_ms, 637, "trim uses quarter-bar beat targets");
    await undo();
    await pointer(handle, "pointerdown", 0);
    await pointer(handle, "pointermove", 2100 * scale());
    await pointer(handle, "pointerup", 2100 * scale());
    assert.equal(server.layers[0].clips[0].source_in_ms, 2137, "trim snaps to actual first beat, not 30fps quantization");
    assert.equal(server.layers[0].clips[0].start_ms, 2137);
    await undo();
    const out = button("调整片段出点");
    await pointer(out, "pointerdown", 0);
    await pointer(out, "pointermove", -5900 * scale());
    await pointer(out, "pointerup", -5900 * scale());
    assert.equal(server.layers[0].clips[0].source_out_ms, 4137);
    await pointer(out, "pointerdown", 0);
    await pointer(out, "pointermove", 3000 * scale());
    await pointer(out, "pointerup", 3000 * scale());
    assert.equal(server.layers[0].clips[0].source_out_ms, 7137, "extending a trimmed clip retains hidden source bar targets");
    await undo(); await undo();
    await pointer(handle, "pointerdown", 0);
    await pointer(handle, "pointermove", 2100 * scale(), true);
    await pointer(handle, "pointerup", 2100 * scale(), true);
    assert.equal(server.layers[0].clips[0].source_in_ms, 2100, "Alt temporarily bypasses bar snapping");
    await undo();
    await act(async () => useWorkshopStore.setState({barSnap: false}));
    await pointer(handle, "pointerdown", 0);
    await pointer(handle, "pointermove", 2077 * scale());
    await pointer(handle, "pointerup", 2077 * scale());
    assert.ok(Math.abs(server.layers[0].clips[0].source_in_ms - 2077) < .001, "disabled snapping preserves sample-accurate free trim");
    await undo();
    await act(async () => useWorkshopStore.setState({barSnap: true}));
    const rail = document.querySelector<HTMLElement>('.vj-ruler-rail')!;
    await pointer(rail, "pointerdown", 2100 * scale());
    await pointer(rail, "pointerup", 2100 * scale());
    assert.equal(seeks.at(-1), 2137, "ruler positioning uses the same beat mapping as cutting");
    await pointer(rail, "pointerdown", 600 * scale());
    await pointer(rail, "pointerup", 600 * scale());
    assert.equal(seeks.at(-1), 637, "ruler positioning also snaps to quarter-bar lines");
    await pointer(rail, "pointerdown", 600 * scale(), true);
    await pointer(rail, "pointerup", 600 * scale(), true);
    assert.equal(seeks.at(-1), 600, "Alt bypasses beat snapping while positioning");
    const storedGrid = workshopGrid(server.layers[0], server.sources[0], results)!;
    const corrected = {...storedGrid, locked: true, downbeats: [.25, 2.25]};
    assert.equal(workshopGrid({...server.layers[0], grid: corrected}, server.sources[0], results), corrected, "precise reanalysis never overwrites manual correction");
    assert.equal(workshopGrid({...server.layers[0], grid: {...corrected, source_signature: 'old'}}, server.sources[0], results)?.downbeats[0], .137, "stale manual grids cannot override current-source beats");
    const faster = {...structuredClone(server.layers[0].clips[0]), speed: {...server.layers[0].clips[0].speed, start: 2, middle: 2, end: 2}};
    assert.ok(clipBeatTimes(faster, storedGrid).includes(1068.5), "downbeat times respect speed changes");
    assert.ok(clipBeatTimes(faster, storedGrid).includes(318.5), "quarter-bar times respect speed changes");
    const moved = {...faster, start_ms: 1000, source_in_ms: 400, source_out_ms: 900};
    assert.deepEqual(clipBeatTimes(moved, storedGrid), [1118.5], "beat mapping respects source trims, speed and timeline offset");
    assert.ok(clipBeatTimes(moved, storedGrid, true).includes(1368.5), "extending retains hidden quarter-bar targets");
    const beforeFades = structuredClone(server);
    for (const audio of [true, false]) {
      await act(async () => {
        server = structuredClone(beforeFades);
        server.sources[0].video = !audio;
        server.sources[0].kind = audio ? "audio" : "video";
        const c = server.layers[0].clips[0];
        Object.assign(c, {start_ms: 1000, source_in_ms: 1000});
        Object.assign(c.fades, {offset_ms: 1000, span_ms: 12000,
          audio_in_ms: 2000, video_in_ms: 2000, audio_out_ms: 4000, video_out_ms: 4000});
        useWorkshopStore.setState({projects: [server], revision: server.revision, draft: structuredClone(server), past: [], future: [], barSnap: true, snap: false});
      });
      const fadeIn = button(`调整${audio ? "声音" : "画面"}淡入`);
      await pointer(fadeIn, "pointerdown", 0);
      await pointer(fadeIn, "pointermove", 600 * scale());
      await pointer(fadeIn, "pointerup", 600 * scale());
      assert.equal(visibleFade(server.layers[0].clips[0], false, audio), 1637,
        "fade-in endpoint snaps to 2637, respecting clip position and inherited envelope offset");
      const fadeOut = button(`调整${audio ? "声音" : "画面"}淡出`);
      await pointer(fadeOut, "pointerdown", 0);
      await pointer(fadeOut, "pointermove", 100 * scale());
      await pointer(fadeOut, "pointerup", 100 * scale());
      assert.equal(visibleFade(server.layers[0].clips[0], true, audio), 1863,
        "fade-out endpoint snaps to the non-downbeat at 8137, not the clip end");
      await undo(); await undo();
      await pointer(fadeIn, "pointerdown", 0);
      await pointer(fadeIn, "pointermove", 600 * scale(), true);
      await pointer(fadeIn, "pointerup", 600 * scale(), true);
      assert.equal(visibleFade(server.layers[0].clips[0], false, audio), 1600, "Alt bypasses fade beat snapping");
      await undo();
      await pointer(fadeIn, "pointerdown", 0);
      await pointer(fadeIn, "pointermove", -990 * scale());
      await pointer(fadeIn, "pointerup", -990 * scale());
      assert.equal(visibleFade(server.layers[0].clips[0], false, audio), 0, "fade-in snaps fully closed at an off-beat clip start");
      await undo();
      await pointer(fadeOut, "pointerdown", 0);
      await pointer(fadeOut, "pointermove", 1990 * scale());
      await pointer(fadeOut, "pointerup", 1990 * scale());
      assert.equal(visibleFade(server.layers[0].clips[0], true, audio), 0, "fade-out snaps fully closed at an off-beat clip end");
      await undo();
      await act(async () => useWorkshopStore.setState({barSnap: false}));
      await pointer(fadeOut, "pointerdown", 0);
      await pointer(fadeOut, "pointermove", 100 * scale());
      await pointer(fadeOut, "pointerup", 100 * scale());
      assert.equal(visibleFade(server.layers[0].clips[0], true, audio), 1900, "disabled snapping leaves fades free");
      await undo();
      await act(async () => useWorkshopStore.setState({snap: true, position: 2650}));
      await pointer(fadeIn, "pointerdown", 0);
      await pointer(fadeIn, "pointermove", 600 * scale());
      await pointer(fadeIn, "pointerup", 600 * scale());
      assert.equal(visibleFade(server.layers[0].clips[0], false, audio), 1650, "timeline magnet also uses the fade endpoint");
    }
    await act(async () => {
      server = beforeFades;
      useWorkshopStore.setState({projects: [server], revision: server.revision, draft: structuredClone(server), past: [], future: [], barSnap: true, snap: false});
      useWorkshopRhythmStore.setState({results: {...results, [rhythmKey(server.sources[0])]: {analysis: {...analysis, downbeat_confidence: .1}, status: null}}});
    });
    assert.match(document.querySelector('.vj-rhythm-controls')!.textContent!, /首拍置信度低/);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'BPM 分析')!.click());
    assert.deepEqual(analysisRequests, [true, true], "manual reanalysis also uses precise mode");
  } finally {
    await act(async () => {await useWorkshopStore.getState().flush(); root.unmount();});
    api.waveform = original.waveform; api.rhythm = original.rhythm; api.analyzeRhythm = original.analyze; api.editWorkshop = original.edit; api.workshop = original.workshop;
    api.workshopFrameUrl = original.frame;
    clearAllWaveformCaches(); dom.window.close();
  }
});
