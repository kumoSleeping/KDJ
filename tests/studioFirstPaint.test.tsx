import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import VisualizerStudioPanel from "../src/components/composition/VisualizerStudioPanel";
import { useVisualizerStudioStore } from "../src/stores/visualizerStudioStore";
import { VisualizerDock } from "../src/components/composition/VisualizerDock";
import { useSidePanels } from "../src/lib/sidePanels";
import { RightDock } from "../src/components/workspace/RightDock";

const dom = new JSDOM('<div id="root"></div><div id="dock"></div>', { url: "http://localhost" });
dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement, HTMLCanvasElement: dom.window.HTMLCanvasElement, IS_REACT_ACT_ENVIRONMENT: true });
let next = 0;
const frames = new Map<number, FrameRequestCallback>();
Object.assign(globalThis, {
  requestAnimationFrame: (f: FrameRequestCallback) => { frames.set(++next, f); return next; },
  cancelAnimationFrame: (id: number) => frames.delete(id),
  ResizeObserver: class { observe() {} disconnect() {} },
});
Object.defineProperty(document, "hidden", { configurable: true, value: false });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => ({ save(){},restore(){},drawImage(){},globalAlpha:1 }) });
let resolveAnalysis!: (value: unknown) => void;
let resolveLyrics!: (value: unknown) => void;
const fixture = {
  analysis: new Promise(resolve => { resolveAnalysis = resolve; }),
  lyrics: new Promise(resolve => { resolveLyrics = resolve; }),
  draws: [] as { time: number; timeline: { frames: { rms: number }[] } }[],
  clock: { trackId:42, ready:true, fresh:true, playing:false, currentTime:30 },
  listeners: new Set<() => void>(),
  panelReads: 0,
  prepares: 0, imageLoads: 0, analyses: 0,
  session: { trackId: 42 as number | null }, commands: [] as any[], plays: [] as any[],
  windows: [] as any[],
};
Object.assign(globalThis, { studioTest: fixture });
const root = createRoot(document.getElementById("root")!);
const wait = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
let lastFrameTime = 0;
const step = (time:number) => { lastFrameTime=time; const pending=[...frames.values()]; frames.clear(); pending.forEach(f=>f(time)); };
const track = { id:42,title:"Test",artist:"",album:"",filename:"test.wav",path:"/test.wav",duration:180 } as any;
(async () => {
  try {
    await act(async()=> { root.render(<VisualizerStudioPanel inlineTrack={track} showDetails={false}/>); await wait(30); });
    await act(async()=> { await wait(30); });
    const firstCanvas = document.querySelector("canvas");
    assert.ok(firstCanvas, `artwork must appear while both lyrics and global analysis remain pending: ${document.body.innerHTML}`);
    assert.ok(fixture.draws.length > 0);
    assert.equal(fixture.draws.at(-1)!.timeline.frames[0].rms,0);
    await act(async()=> { await wait(270); });
    await act(async()=> { resolveAnalysis({ signature:"test",timeline:{version:1,sample_rate:22050,sample_count:180*22050,fps:60,frames:[{bands:[.5],rms:.2,bass:.3,onset:0}]}}); await wait(0); });
    assert.equal(document.querySelector("canvas"),firstCanvas,"analysis arrival must retain the canvas node");
    step(performance.now()+300);
    const settled = fixture.draws.length;
    await act(async()=> { await wait(280); });
    assert.equal(fixture.draws.length,settled,"parked clock must not redraw on the 125ms session timer");
    await act(async()=> { resolveLyrics({lrc:"[00:00]line",translated_lrc:""}); await wait(0); });
    assert.equal(document.querySelector("canvas"),firstCanvas,"late metadata must not unmount the visible scene");
    step(performance.now()+300);
    await act(async()=> { fixture.clock.playing=true; fixture.listeners.forEach(f=>f()); });
    const before=fixture.draws.length, start=Math.max(performance.now(),lastFrameTime)+40;
    for(let i=1;i<=120;i++) { fixture.clock.currentTime=30+i/120; step(start+i*1000/120); }
    const drawn=fixture.draws.length-before;
    assert.ok(drawn>=28 && drawn<=31,`120Hz display should draw about 30 preview frames, got ${drawn}`);
    await act(async()=> { fixture.listeners.forEach(f=>f()); await wait(140); });
    const panelReads = fixture.panelReads;
    for (let i=0;i<3;i++) await act(async()=> { fixture.clock.currentTime+=.25; fixture.listeners.forEach(f=>f()); await wait(140); });
    assert.equal(fixture.panelReads,panelReads,"position ticks should only rerender transport controls, not the whole settings panel");
    const preparedCount=fixture.prepares, images=fixture.imageLoads, analyses=fixture.analyses;
    await act(async()=> { fixture.clock.ready=false; fixture.session.trackId=null; fixture.listeners.forEach(f=>f()); });
    assert.equal(document.querySelector('canvas'),firstCanvas,'a same-song deck gap must retain the visible canvas');
    const slider=document.querySelector('[role="slider"]')!;
    for (const key of ['End','Home','ArrowRight']) await act(async()=> {
      slider.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true}));
    });
    assert.equal(fixture.plays.length,0,'seeking while the previous seek is landing must never reload the song');
    assert.equal(fixture.commands.filter(c=>c.type==='seek').length,3);
    await act(async()=> { fixture.session.trackId=42; fixture.clock.ready=true;fixture.clock.currentTime=100;fixture.listeners.forEach(f=>f());await wait(300); });
    step(Math.max(performance.now(),lastFrameTime)+500);
    assert.equal(document.querySelector('canvas'),firstCanvas);
    assert.equal(fixture.prepares,preparedCount,'same-song seek must not rebuild the scene');
    assert.equal(fixture.imageLoads,images,'same-song seek must not reload pictures');
    assert.equal(fixture.analyses,analyses,'same-song seek must not rerun audio analysis');
    Object.defineProperty(document,"hidden",{configurable:true,value:true});
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    assert.equal(frames.size,0,"background preview must cancel animation callbacks");
    // ---- The configuration is an app of the main window's right column, on the desktop too.
    const editor = () => useVisualizerStudioStore.getState();
    const dock = createRoot(document.getElementById("dock")!);
    const host = document.getElementById("dock")!;
    Object.assign(dom.window, { __TAURI_INTERNALS__: {}, kdj: { platform: "darwin" } });
    const raisedBefore = useSidePanels.getState().raised.token;
    await act(async()=> {
      root.render(null);
      dock.render(<VisualizerDock/>);
      editor().open(track);
      await wait(60);
    });
    await act(async()=> { await wait(30); });
    assert.equal(fixture.windows.length,0,'opening the configuration must not ask for a separate window');
    assert.equal(editor().track?.id,42);
    assert.equal(editor().inlineSettings,false);
    assert.deepEqual([useSidePanels.getState().raised.id,useSidePanels.getState().raised.token],['visualizer',raisedBefore+1],'opening brings the column app forward');
    assert.ok(host.querySelector('.kd-viz-dock .kd-aside-head-title')?.textContent?.includes('可视化配置'));
    assert.ok(host.querySelector('.kd-viz-preview canvas'),`the picture sits in the column app: ${host.innerHTML.slice(0,400)}`);
    assert.equal(document.querySelector('[role="dialog"][aria-label="可视化预览小窗"]'),null,'the picture must not pop out by itself');
    assert.equal(fixture.plays.length,0,'editing the playing song must preserve its transport');
    await act(async()=> { editor().open(track); });
    assert.equal(useSidePanels.getState().raised.token,raisedBefore+2,'asking again raises the app');
    // Every continuous parameter is a slider that shows its value and returns to its default.
    const sliders=[...host.querySelectorAll<HTMLInputElement>('.kd-viz-settings .kd-slider input[type="range"]')];
    assert.ok(sliders.length>=6,`sliders: ${sliders.length}`);
    assert.equal(host.querySelector('.kd-dj-arcknob'),null);
    const split=host.querySelector<HTMLInputElement>('.kd-slider input[type="range"]')!;
    const readout=()=>split.closest('.kd-slider')!.querySelector('.kd-slider-value')!;
    assert.equal(readout().textContent,'61.5%');
    assert.equal((readout() as HTMLButtonElement).disabled,true,'nothing to reset at the default');
    // react-dom is loaded before this file installs the DOM globals, so it does not listen for
    // `input` here; hand the change to the slider's own handler.
    const props=(split as any)[Object.keys(split).find(key=>key.startsWith('__reactProps$'))!];
    await act(async()=> { props.onChange({ currentTarget:{ value:'30' } }); });
    assert.equal(readout().textContent,'30%');
    await act(async()=> { await wait(340); split.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true})); });
    assert.equal(readout().textContent,'61.5%','double-click returns to the default');
    await act(async()=> { host.querySelector<HTMLElement>('[aria-label="撤销"]')!.click(); });
    assert.equal(readout().textContent,'30%','slider edits join the undo history');
    // Closing goes through the editor's own guard; the app keeps its content while sliding out.
    // No IndexedDB here: the editor asks before discarding what it could not save.
    (dom.window as any).confirm = () => true;
    await act(async()=> { host.querySelector<HTMLElement>('[aria-label="关闭可视化配置"]')!.click(); await wait(60); });
    assert.equal(editor().track,null,'the close control closes the app');
    assert.ok(host.querySelector('.kd-viz-settings'),'a closed app keeps showing what it showed');
    // A song that is not playing: opening its configuration leaves the transport alone.
    await act(async()=> { editor().open({ ...track, id:43, title:'Other' }); await wait(60); });
    assert.equal(fixture.plays.length,0,'opening the configuration must not load another song');
    assert.equal(fixture.windows.length,0);
    await act(async()=> { editor().close(); await wait(10); });
    // The floating picture's gear: the picture stays the editor, its controls come up in the column.
    await act(async()=> {
      // As VisualizerPopup mounts it.
      root.render(<VisualizerStudioPanel inlineTrack={track} showDetails={false} popup onClose={() => { if (editor().inlineSettings) editor().close(); }}/>);
      await wait(60);
    });
    await act(async()=> { editor().openInlineSettings(track); await wait(30); });
    assert.equal(fixture.windows.length,0,'the gear must not ask for a separate window');
    assert.equal(editor().inlineSettings,true);
    assert.equal(useSidePanels.getState().raised.id,'visualizer');
    assert.ok(host.querySelector('.kd-viz-settings-host [role="tablist"]'),'the controls are hosted by the column app');
    assert.equal(host.querySelector('canvas'),null,'the picture stays in its floating window');
    assert.equal(typeof editor().beforeClose,'function','the unsaved-change guard is registered');
    await act(async()=> { host.querySelector<HTMLElement>('[aria-label="关闭可视化配置"]')!.click(); await wait(60); });
    assert.equal(editor().track,null,'closing the column app ends the hosted controls');
    await act(async()=>dock.unmount());
    // ---- The column itself: the front app that closes stays, as it was, while it leaves.
    const column = createRoot(host);
    const app = (id:string) => ({ id, label:id, node:<input data-probe={id} defaultValue=""/> });
    const show = (ids:string[], order:string[]) => act(async()=> { column.render(<RightDock apps={ids.map(app)} order={order}/>); });
    const section = (id:string) => host.querySelector<HTMLElement>(`.kd-dock-app[data-app="${id}"]`);
    await show(['lyrics','visualizer'],['lyrics','visualizer']);
        const probe = section('visualizer')!.querySelector('input')!;
    probe.value = 'typed';
    assert.equal(section('lyrics')!.dataset.covered,'true');
    await show(['lyrics'],['lyrics']);
    assert.equal(section('visualizer')?.dataset.leaving,'true','a closed front app slides out instead of vanishing');
    assert.ok(section('visualizer')!.querySelector('input')===probe,'and it is the same instance, not a fresh mount');
    assert.equal(section('lyrics')!.dataset.covered,undefined,'the app beneath is revealed at once');
    await act(async()=> { await wait(340); });
    assert.equal(section('visualizer'),null);
    // Raising changes the front without changing the set: the app in front is the one that leaves.
    await show(['lyrics','visualizer'],['lyrics','visualizer']);
    await show(['lyrics','visualizer'],['visualizer','lyrics']);
    await show(['visualizer'],['visualizer']);
    assert.equal(section('lyrics')?.dataset.leaving,'true','the raised app leaves visibly');
    await show(['lyrics','visualizer'],['visualizer','lyrics']);
    assert.equal(section('lyrics')?.dataset.leaving,undefined,'reopened while leaving: it is simply open again');
    assert.equal(host.querySelectorAll('.kd-dock-app[data-app="lyrics"]').length,1);
    await show(['lyrics'],['lyrics']);
    assert.equal(section('visualizer'),null,'a covered app that closes is simply gone');
    await act(async()=>column.unmount());
    console.log("PASS: early artwork, retained canvas, paused redraw suppression, 120Hz→30fps pacing, isolated position updates, background suspension, column app, leaving apps");
  } finally {
    await act(async()=>root.unmount()); dom.window.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1});
