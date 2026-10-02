import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import VisualizerStudioPanel from "../src/components/composition/VisualizerStudioPanel";
import { useVisualizerStudioStore } from "../src/stores/visualizerStudioStore";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
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
    await act(async()=> {
      useVisualizerStudioStore.getState().open(track);
      root.render(<VisualizerStudioPanel showDetails={false}/>);
      await wait(30);
    });
    assert.equal(useVisualizerStudioStore.getState().inlineSettings,false,'explicit editing must not depend on a visible sidebar');
    assert.equal(useVisualizerStudioStore.getState().fromPlayback,true);
    let preview=document.querySelector('[role="dialog"][aria-label="可视化预览小窗"]');
    assert.ok(preview,'opening generation must also pop out its preview');
    assert.equal(fixture.plays.length,0,'editing the playing song must preserve its transport');
    await act(async()=> { preview!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})); });
    assert.equal(document.querySelector('[role="dialog"][aria-label="可视化预览小窗"]'),null);
    await act(async()=> { useVisualizerStudioStore.getState().open(track); });
    preview=document.querySelector('[role="dialog"][aria-label="可视化预览小窗"]');
    assert.ok(preview,'repeating the right-click action must reopen a collected preview');
    console.log("PASS: early artwork, retained canvas, paused redraw suppression, 120Hz→30fps pacing, isolated position updates, background suspension");
  } finally {
    await act(async()=>root.unmount()); dom.window.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1});
