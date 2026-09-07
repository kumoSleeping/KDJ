import assert from "node:assert/strict";
import test from "node:test";
import type { CompositionProject, WorkshopClip } from "../src/types/workshop";

test("video joint controls share undo and positioning menus never expand a track", async () => {
  const {JSDOM} = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {url:"http://localhost"});
  Object.assign(globalThis, {window:dom.window, document:dom.window.document, localStorage:dom.window.localStorage,
    HTMLElement:dom.window.HTMLElement, CustomEvent:dom.window.CustomEvent, Event:dom.window.Event,
    ResizeObserver:class {observe(){} disconnect(){}}, IS_REACT_ACT_ENVIRONMENT:true});
  dom.window.HTMLElement.prototype.setPointerCapture=()=>{};
  const {createElement,act} = await import("react");
  const {createRoot} = await import("react-dom/client");
  const {WorkshopVideoTransition} = await import("../src/components/composition/WorkshopVideoTransition");
  const {WorkshopLayerAnalysis} = await import("../src/components/composition/WorkshopLayerAnalysis");
  const {useWorkshopStore} = await import("../src/stores/workshopStore");
  const {api} = await import("../src/lib/api");
  const {fadeAlpha} = await import("../src/lib/workshop");
  const {videoProject, videoTransitionSpan} = await import("../src/lib/workshopTransitions");
  const left: WorkshopClip = {id:"left",source_id:"s",start_ms:0,source_in_ms:0,source_out_ms:3000,
    speed:{preset:"constant",start:1,middle:1,end:1,domain_start_ms:0,domain_end_ms:10000},
    picture:{x:.5,y:.5,scale:1,opacity:1},sound:{muted:false,gain:1,manual:false},
    fades:{offset_ms:0,span_ms:3000,video_in_ms:0,video_out_ms:0,audio_in_ms:0,audio_out_ms:0,linear:false}};
  const p:CompositionProject = {id:"p",revision:0,name:"joint",migrated_from:null,
    sources:[{id:"s",track_id:1,path:"/source.mp4",title:"video",duration_ms:10000,video:true,audio:true,width:160,height:90,fps:25,signature:""}],
    layers:[{id:"l",source_id:"s",clips:[left,{...structuredClone(left),id:"right",start_ms:3000,source_in_ms:6000,source_out_ms:9000}]}],
    canvas:{width:160,height:90,fps:25,initialized:true},
    output:{name:"joint",directory:"/tmp",in_ms:0,out_ms:null,quality:20,acceleration:"software"}};
  let server=structuredClone(p), revision=0;
  const oldApi={workshop:api.workshop,editWorkshop:api.editWorkshop};
  api.workshop=async()=>({session:"transition-ui",revision,projects:[server],jobs:[]});
  api.editWorkshop=async(_id,base,edit)=>{assert.equal(base,server.revision);server={...server,...structuredClone(edit),revision:base+1};revision++;return api.workshop();};
  useWorkshopStore.setState({session:"transition-ui",revision:0,projects:[p],draft:p,activeId:"p",saving:0,gesture:null,past:[],future:[],
    positions:{p:{session:"transition-ui",project_id:"p",revision:0,items:[{id:"analysis",layer_id:"l",phase:"ready",progress:1,
      reference_id:"music",reference_title:"music",reason:"",applied:null,presets:[{id:"sections",label:"分段匹配",placements:[]}]}]}}});
  const root=createRoot(document.getElementById("root")!);
  function Probe(){const project=useWorkshopStore(s=>s.draft)!;return createElement("div",{className:"track",style:{height:60,width:600}},
    createElement(WorkshopLayerAnalysis,{projectId:"p",layerId:"l",sourceTitle:"video"}),
    createElement(WorkshopVideoTransition,{project,left:project.layers[0].clips[0],right:project.layers[0].clips[1],scale:.1}));}
  const change=async(fn:()=>void)=>act(async()=>{fn();await useWorkshopStore.getState().flush();});
  try {
    await act(async()=>root.render(createElement(Probe)));
    const style=document.querySelector('.track')!.getAttribute('style');
    await act(async()=>document.querySelector<HTMLButtonElement>('.vj-layer-position-trigger')!.click());
    assert.equal(document.querySelector('.vj-position-popup')?.parentElement,document.body);
    assert.equal(document.querySelector('.track .vj-position-choice-actions'),null);
    assert.equal(document.querySelector('.track details'),null);
    await act(async()=>window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'})));
    assert.equal(document.querySelector('.vj-position-popup'),null);
    await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="画面过渡"]')!.click());
    assert.equal(document.querySelector('.vj-transition-popup')?.parentElement,document.body);
    await change(()=>[...document.querySelectorAll<HTMLButtonElement>('.vj-transition-popup button')].find(b=>b.textContent==='交叉淡化')!.click());
    const current=()=>useWorkshopStore.getState().draft!.layers[0].clips[1].video_transition!;
    assert.equal(current().duration_ms,500);
    const curves = document.querySelectorAll('.vj-transition-curves path');
    assert.equal(curves.length,2);
    assert.equal(document.querySelector('.vj-transition-curves')?.getAttribute('viewBox'), '0 0 100 30');
    assert.match(curves[0].getAttribute('d')!, /^M0,4 .*L100,4$/);
    assert.match(curves[1].getAttribute('d')!, /^M0,27 .*L100,4$/);
    assert.equal(curves[0].getAttribute('aria-label'), '前段透明度');
    assert.equal(curves[1].getAttribute('aria-label'), '后段透明度');
    const draft = useWorkshopStore.getState().draft!;
    const [outgoing, incoming] = videoProject(draft).layers[0].clips;
    const span = videoTransitionSpan(...draft.layers[0].clips as [WorkshopClip, WorkshopClip])!;
    const start = draft.layers[0].clips[1].start_ms - span.before;
    const samples = [...curves].map(curve => curve.getAttribute('d')!.split(' ').map(point => point.slice(1).split(',').map(Number)));
    samples[0].forEach(([x, y], i) => {
      const time = start + x / 100 * (span.before + span.after);
      const a = (27 - y) / 23, b = (27 - samples[1][i][1]) / 23;
      assert.ok(Math.abs(a - fadeAlpha(outgoing, time - outgoing.start_ms)) < 1e-9, 'outgoing curve matches preview alpha');
      assert.ok(Math.abs(b - fadeAlpha(incoming, time - incoming.start_ms)) < 1e-9, 'incoming curve matches preview alpha');
      assert.ok(Math.abs(b + a * (1 - b) - 1) < 1e-9, 'source-over never exposes the black background');
    });
    assert.equal(samples[0][12][1], 4, 'outgoing alpha stays 100% at midpoint, not 50%');
    assert.equal(samples[1][12][1], 15.5, 'incoming alpha is 50% at midpoint');
    assert.deepEqual(server.layers[0].clips.map(c=>[c.start_ms,c.source_in_ms,c.source_out_ms,c.sound,c.fades]),
      p.layers[0].clips.map(c=>[c.start_ms,c.source_in_ms,c.source_out_ms,c.sound,c.fades]));
    await change(()=>document.querySelector('[role="slider"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
    assert.equal(current().duration_ms,540);
    await change(()=>useWorkshopStore.getState().undo());assert.equal(current().duration_ms,500);
    await change(()=>useWorkshopStore.getState().redo());assert.equal(current().duration_ms,540);
    await change(()=>[...document.querySelectorAll<HTMLButtonElement>('.vj-transition-align button')].find(b=>b.textContent==='靠前')!.click());
    assert.equal(current().alignment,-1);
    // Pointer edits are one transaction; cancel restores both sides together.
    const slider=document.querySelector('[role="slider"]')!;
    const pointer=async(type:string,x:number)=>act(async()=>{slider.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,button:0,clientX:x}));});
    await pointer('pointerdown',100);await pointer('pointermove',90);
    assert.equal(current().duration_ms,640);
    await pointer('pointercancel',90);assert.equal(current().duration_ms,540);
    await change(()=>document.querySelector<HTMLButtonElement>('[aria-label="移除画面过渡"]')!.click());
    assert.equal(server.layers[0].clips[1].video_transition,undefined);
    assert.equal(document.querySelector('.track')!.getAttribute('style'),style);
  } finally {
    await act(async()=>root.unmount());Object.assign(api,oldApi);dom.window.close();
  }
});
