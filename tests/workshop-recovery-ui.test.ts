import assert from "node:assert/strict";
import test from "node:test";
import type { CompositionProject, WorkshopSnapshot } from "../src/types/workshop";

function project(id = "project"): CompositionProject {
  return {id, revision: 0, name: "作品", migrated_from: null,
    sources: [{id:"source", track_id:1, path:"/source.wav", title:"音乐", duration_ms:10000, video:false, audio:true, width:0, height:0, fps:30, signature:""}],
    layers: [{id:"layer", source_id:"source", clips:[{id:"clip", source_id:"source", start_ms:0, source_in_ms:0, source_out_ms:10000,
      speed:{preset:"constant", start:1, middle:1, end:1, domain_start_ms:0, domain_end_ms:10000},
      picture:{x:.5,y:.5,scale:1,opacity:1}, sound:{muted:false,gain:1,manual:false},
      fades:{offset_ms:0,span_ms:10000,audio_in_ms:0,audio_out_ms:0,video_in_ms:0,video_out_ms:0,linear:false}}]}],
    canvas:{width:160,height:90,fps:30,initialized:false},
    output:{name:"作品",directory:"/output",format:"wav",in_ms:0,out_ms:null,quality:20,acceleration:"auto"},markers:[]};
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {promise,resolve}; }

test("store rebases edits and unfinished gestures after imports, and cancels alignment without blocking project changes", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>", {url:"http://localhost"});
  Object.assign(globalThis, {window:dom.window, document:dom.window.document, localStorage:dom.window.localStorage,
    HTMLElement:dom.window.HTMLElement, CustomEvent:dom.window.CustomEvent, Event:dom.window.Event});
  const {useWorkshopStore:store} = await import("../src/stores/workshopStore");
  const {api} = await import("../src/lib/api");
  let server = project(), revision = 0;
  const other = project("other");
  const snapshot = (): WorkshopSnapshot => ({session:"recovery", revision, projects:[structuredClone(server),structuredClone(other)],jobs:[]});
  api.workshop = async () => snapshot();
  const submissions: CompositionProject[] = [];
  api.editWorkshop = async (id, baseRevision, update) => {
    assert.equal(id, server.id); assert.equal(baseRevision, server.revision);
    server = {...server,...structuredClone(update),revision:baseRevision+1}; revision++;
    submissions.push(structuredClone(server)); return snapshot();
  };
  store.getState().accept(snapshot());
  for (const unfinished of [false,true]) {
    const started = deferred<void>(), release = deferred<void>();
    api.intakeWorkshop = async () => {
      const before = structuredClone(server); started.resolve(); await release.promise;
      const extra = structuredClone(server.layers[0]); extra.id = `imported-${unfinished}`; extra.clips[0].id = `clip-${unfinished}`;
      server.layers.push(extra); server.revision++; revision++;
      return {snapshot:snapshot(),before,project_id:server.id,errors:[]};
    };
    const pending = store.getState().intake([2],[],0,server.id); await started.promise;
    const next = structuredClone(store.getState().draft!); next.name = `edited-${unfinished}`;
    if (unfinished) { store.getState().begin(); store.getState().transient(next); }
    else store.getState().edit(() => next);
    release.resolve(); await pending;
    if (unfinished) { assert.equal(store.getState().draft!.name,next.name); store.getState().commit(); }
    await store.getState().flush();
    assert.ok(store.getState().draft!.layers.some(l => l.id === `imported-${unfinished}`));
    assert.equal(store.getState().draft!.name,next.name);
    assert.ok(submissions.at(-1)!.layers.some(l => l.id === `imported-${unfinished}`));
    store.getState().undo(); await store.getState().flush();
    assert.ok(store.getState().draft!.layers.some(l => l.id === `imported-${unfinished}`),"undoing the edit retains the preceding import");
    assert.notEqual(store.getState().draft!.name,next.name);
    store.getState().redo(); await store.getState().flush();
    assert.equal(store.getState().draft!.name,next.name);
  }
  store.getState().edit(p => ({...structuredClone(p),name:"local-conflict"}));
  server.name = "external-conflict"; server.revision++; revision++;
  store.getState().accept(snapshot()); await store.getState().flush();
  assert.match(store.getState().error,/冲突/);
  assert.equal(server.name,"external-conflict");
  assert.equal(store.getState().draft!.name,"external-conflict");

  const started = deferred<void>(), finish = deferred<{start_ms:number;revision:number}>();
  const canceled: string[] = [];
  api.cancelWorkshopAlignment = async request => { canceled.push(request); };
  api.alignWorkshop = async () => { started.resolve(); return finish.promise; };
  store.getState().select("clip");
  const align = store.getState().align("reference"); await started.promise;
  assert.equal(store.getState().saving,0);
  const count = submissions.length;
  await store.getState().selectProject("other");
  assert.equal(store.getState().activeId,"other");
  assert.equal(store.getState().aligning,null);
  assert.equal(canceled.length,1);
  finish.resolve({start_ms:500,revision:server.revision}); await align;
  assert.equal(submissions.length,count,"a canceled late result cannot save over the new project");
  dom.window.close();
});

test("pending imports preserve undo/redo navigation and optimistic edits", async t => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>", {url:"http://localhost"});
  Object.assign(globalThis, {window:dom.window, document:dom.window.document, localStorage:dom.window.localStorage,
    HTMLElement:dom.window.HTMLElement, CustomEvent:dom.window.CustomEvent, Event:dom.window.Event});
  const {useWorkshopStore:store} = await import("../src/stores/workshopStore");
  const {api} = await import("../src/lib/api");
  let sequence = 0;
  const fixture = () => {
    const session = `history-${++sequence}`;
    let server = project(session), revision = 0;
    const snapshot = (): WorkshopSnapshot => ({session,revision,projects:[structuredClone(server)],jobs:[]});
    api.workshop = async () => snapshot();
    api.editWorkshop = async (id, baseRevision, update) => {
      assert.equal(id,server.id); assert.equal(baseRevision,server.revision);
      server = {...server,...structuredClone(update),revision:baseRevision+1}; revision++;
      return snapshot();
    };
    store.getState().accept(snapshot());
    store.setState({error:"",expandedId:server.id});
    const move = (x: number, unfinished = false) => {
      const next = structuredClone(store.getState().draft!);
      next.layers[0].clips[0].picture.x = x;
      if (unfinished) {store.getState().begin(); store.getState().transient(next);}
      else store.getState().edit(() => next);
    };
    const check = (x: number, imported: boolean) => {
      for (const p of [store.getState().draft!,server]) {
        assert.equal(p.layers[0].clips[0].picture.x,x);
        assert.equal(p.layers.some(l => l.id === "imported"),imported);
      }
      assert.equal(store.getState().error,"");
      assert.equal(store.getState().saving,0);
    };
    const importing = async () => {
      const started = deferred<void>(), release = deferred<void>();
      api.intakeWorkshop = async () => {
        const before = structuredClone(server); started.resolve(); await release.promise;
        const layer = structuredClone(server.layers[0]); layer.id = "imported"; layer.clips[0].id = "imported-clip";
        server.layers.push(layer); server.revision++; revision++;
        return {snapshot:snapshot(),before,project_id:server.id,errors:[]};
      };
      const pending = store.getState().intake([2],[],0,server.id);
      await started.promise;
      return {finish:async () => {release.resolve(); await pending;}};
    };
    const undo = async () => {store.getState().undo(); await store.getState().flush();};
    const redo = async () => {store.getState().redo(); await store.getState().flush();};
    return {move,check,importing,undo,redo};
  };
  try {
    await t.test("undo during import does not return the discarded edit when undoing import", async () => {
      const f = fixture(); f.move(.7); await store.getState().flush();
      const pending = await f.importing();
      store.getState().undo(); await pending.finish(); await store.getState().flush();
      f.check(.5,true);
      await f.undo(); f.check(.5,false);
      assert.equal(store.getState().past.length,0);
      await f.redo(); f.check(.5,true);
    });
    await t.test("multiple undo and redo steps remain navigable below the completed import", async () => {
      const f = fixture(); f.move(.6); f.move(.7); await store.getState().flush();
      const pending = await f.importing();
      store.getState().undo(); store.getState().undo(); store.getState().redo();
      await pending.finish(); await store.getState().flush(); f.check(.6,true);
      await f.undo(); f.check(.6,false);
      await f.undo(); f.check(.5,false);
      await f.redo(); f.check(.6,false);
      await f.redo(); f.check(.6,true);
    });
    await t.test("redo during import retains the selected edit beneath the import", async () => {
      const f = fixture(); f.move(.7); await store.getState().flush(); await f.undo();
      const pending = await f.importing(); store.getState().redo();
      await pending.finish(); await store.getState().flush(); f.check(.7,true);
      await f.undo(); f.check(.7,false);
      await f.undo(); f.check(.5,false);
    });
    await t.test("a new edit after undo branches history without restoring the old edit", async () => {
      const f = fixture(); f.move(.7); await store.getState().flush();
      const pending = await f.importing(); store.getState().undo(); f.move(.8);
      await pending.finish(); await store.getState().flush(); f.check(.8,true);
      await f.undo(); f.check(.8,false);
      await f.undo(); f.check(.5,false);
      await f.redo(); f.check(.8,false);
      await f.redo(); f.check(.8,true);
    });
    await t.test("an unfinished adjustment after undo stays above the import", async () => {
      const f = fixture(); f.move(.7); await store.getState().flush();
      const pending = await f.importing(); store.getState().undo(); f.move(.8,true);
      await pending.finish();
      assert.equal(store.getState().draft!.layers[0].clips[0].picture.x,.8);
      assert.ok(store.getState().gesture);
      store.getState().commit(); await store.getState().flush(); f.check(.8,true);
      await f.undo(); f.check(.5,true);
      await f.undo(); f.check(.5,false);
    });
    await t.test("immediate undo after import still sees a committed edit awaiting save", async () => {
      const f = fixture();
      const pending = await f.importing(); f.move(.8);
      const saveStarted = deferred<void>(), releaseSave = deferred<void>();
      const edit = api.editWorkshop;
      api.editWorkshop = async (...args) => {saveStarted.resolve(); await releaseSave.promise; return edit(...args);};
      await pending.finish(); await saveStarted.promise;
      assert.equal(store.getState().draft!.layers[0].clips[0].picture.x,.8);
      assert.ok(store.getState().draft!.layers.some(l => l.id === "imported"));
      store.getState().undo(); releaseSave.resolve(); await store.getState().flush(); f.check(.5,true);
      await f.undo(); f.check(.5,false);
    });
    await t.test("redo commits an unfinished new edit and discards the old redo branch", async () => {
      const f = fixture(); f.move(.7); await store.getState().flush(); await f.undo();
      f.move(.8,true); await f.redo(); f.check(.8,false);
      assert.equal(store.getState().future.length,0);
      assert.equal(store.getState().gesture,null);
      await f.undo(); f.check(.5,false);
      await f.redo(); f.check(.8,false);
    });
    await t.test("an unchanged gesture leaves redo available", async () => {
      const f = fixture(); f.move(.7); await store.getState().flush(); await f.undo();
      store.getState().begin(); await f.redo(); f.check(.7,false);
      assert.equal(store.getState().gesture,null);
    });
  } finally {dom.window.close();}
});
