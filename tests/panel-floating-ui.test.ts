import assert from "node:assert/strict";
import test from "node:test";

test("panels detach and return without remounting their state or media DOM", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {url:"http://localhost"});
  Object.assign(globalThis, {window:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement,
    localStorage:dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT:true});
  const {createElement: h, act, useEffect, useState} = await import("react");
  const {createRoot} = await import("react-dom/client");
  const {PanelStack} = await import("../src/components/common/PanelStack");
  const {Panel} = await import("../src/components/common/Panel");
  const {PanelDockZone, usePanelDock} = await import("../src/components/common/panelDock");
  let mounts = 0, unmounts = 0;
  function StatefulPanel() {
    const [value, setValue] = useState(0);
    useEffect(() => { mounts++; return () => {unmounts++;}; }, []);
    return h(Panel, {heading:"下载"}, h("button", {"aria-label":"计数", onClick:()=>setValue(n=>n+1)}, String(value)), h("video", {"data-test-media":true}));
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(h("div", null, h(PanelDockZone, {side:"top"}), h(PanelDockZone, {side:"right"}), h(PanelStack, {storageKey:"test-panels", reorderable:true,
      index:{panels:{downloads:{label:"下载",icon:null},lyrics:{label:"歌词",icon:null}}}, children:[h(StatefulPanel,{key:"downloads"}),h(Panel,{key:"lyrics",heading:"歌词"},"歌词内容")]}))));
    const video = document.querySelector("video");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="计数"]')!.click());
    const grip = document.querySelector('[aria-label="移动下载板块"]')!;
    await act(async () => grip.dispatchEvent(new dom.window.KeyboardEvent("keydown", {key:"Enter",bubbles:true})));
    const floating = document.querySelector('[role="dialog"][aria-label="下载"]')!;
    assert.ok(floating);
    assert.equal(floating.querySelector("video"), video);
    assert.ok(floating.classList.contains("kd-panel"), "floating window uses shared panel chrome");
    assert.ok(floating.querySelector(".kd-panel-head"));
    assert.equal(floating.querySelectorAll(".kd-pip-resize").length,8);
    floating.getBoundingClientRect = () => ({left:80,top:80,width:460,height:320,right:540,bottom:400,x:80,y:80,toJSON(){}});
    await act(async () => floating.querySelector('[data-edge="se"]')!.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true})));
    assert.equal((floating as HTMLElement).style.width,"476px", "resizing changes the window width");

    assert.equal(floating.querySelector('[aria-label="计数"]')!.textContent,"1");
    assert.equal(mounts,1); assert.equal(unmounts,0);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="收回下载板块"]')!.click());
    assert.equal(document.querySelector('[role="dialog"][aria-label="下载"]'),null);
    assert.equal(document.querySelector('#root video'),video);
    assert.equal(document.querySelector('[aria-label="计数"]')!.textContent,"1");
    assert.equal(mounts,1); assert.equal(unmounts,0);
    dom.window.HTMLElement.prototype.setPointerCapture = () => {};
    dom.window.HTMLElement.prototype.hasPointerCapture = () => true;
    dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
    const slots = Array.from(document.querySelectorAll<HTMLElement>('#root [data-panel-stack="test-panels"]'));
    slots.forEach((slot,index) => { slot.getBoundingClientRect = () => ({left:100,right:500,top:100+index*120,bottom:200+index*120,width:400,height:100,x:100,y:100+index*120,toJSON(){}}); });
    const drag = async (x:number,y:number) => {
      const handle=document.querySelector('[aria-label="移动下载板块"]')!;
      await act(async () => handle.dispatchEvent(new dom.window.MouseEvent("pointerdown",{bubbles:true,button:0,clientX:120,clientY:130})));
      await act(async () => handle.dispatchEvent(new dom.window.MouseEvent("pointermove",{bubbles:true,clientX:x,clientY:y})));
      await act(async () => handle.dispatchEvent(new dom.window.MouseEvent("pointerup",{bubbles:true,clientX:x,clientY:y})));
    };
    await drag(120,215);
    assert.deepEqual(Array.from(document.querySelectorAll<HTMLElement>('#root [data-panel-stack="test-panels"]')).map(slot=>slot.dataset.panelId),["lyrics","downloads"], "dropping in a gap reorders instead of detaching");
    assert.equal(document.querySelector('[role="dialog"][aria-label="下载"]'),null);
    await drag(700,230);
    assert.ok(document.querySelector('[role="dialog"][aria-label="下载"]'), "dragging outside the column detaches");
    assert.equal(document.querySelector('[role="dialog"] video'),video);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="收回下载板块"]')!.click());
    assert.equal(document.querySelector('#root video'),video);
    assert.equal(mounts,1); assert.equal(unmounts,0);

    const top = document.querySelector<HTMLElement>('[data-panel-dock="top"]')!;
    const right = document.querySelector<HTMLElement>('[data-panel-dock="right"]')!;
    top.getBoundingClientRect = () => ({left:100,right:500,top:0,bottom:80,width:400,height:80,x:100,y:0,toJSON(){}});
    right.getBoundingClientRect = () => ({left:600,right:900,top:100,bottom:700,width:300,height:600,x:600,y:100,toJSON(){}});
    assert.equal(localStorage.getItem("kd-panel-docks-v1"), null, "mounting dock zones does not write preferences");
    await drag(200,40);
    assert.equal(top.querySelector("video"), video, "a panel moves into the empty top zone");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(usePanelDock.getState().dragging, false);
    await drag(750,300);
    assert.equal(right.querySelector("video"), video, "the same panel moves from top to right");
    assert.equal(top.querySelector("video"), null);
    assert.equal(document.querySelector('[aria-label="计数"]')!.textContent, "1");
    assert.equal(mounts,1); assert.equal(unmounts,0);
    assert.equal(JSON.parse(localStorage.getItem("kd-panel-docks-v1")!)["test-panels:downloads"].side, "right");
    await drag(950,750);
    const detached = document.querySelector<HTMLElement>('[role="dialog"][aria-label="下载"]')!;
    assert.equal(detached.querySelector("video"), video);
    detached.getBoundingClientRect = () => ({left:80,top:80,width:460,height:320,right:540,bottom:400,x:80,y:80,toJSON(){}});
    const dragHeader = detached.querySelector(".kd-internal-window-head")!;
    for (const [type,x,y] of [["pointerdown",100,100],["pointermove",200,40],["pointerup",200,40]] as const) {
      await act(async () => dragHeader.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y})));
    }
    assert.equal(document.querySelector('[role="dialog"]'), null, "a floating header can dock the panel");
    assert.equal(top.querySelector("video"), video);
    assert.equal(mounts,1); assert.equal(unmounts,0);
    assert.equal(document.querySelector("[data-drop-target]"), null, "drop feedback clears on release");

    const {FloatingPanelWindow} = await import("../src/components/common/FloatingPanelWindow");
    const windowKey = "test-window-bounds";
    const renderWindow = () => h(FloatingPanelWindow, {title:"轨道属性", subtitle:"很长的曲名", storageKey:windowKey, closeLabel:"关闭属性", close:()=>{}, children:"内容"});
    const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      const left = Number.parseFloat(this.style.left) || 80, top = Number.parseFloat(this.style.top) || 80;
      const width = Number.parseFloat(this.style.width) || 460, height = Number.parseFloat(this.style.height) || 320;
      return {left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON(){}};
    };
    try {
      await act(async () => root.render(renderWindow()));
      assert.equal(localStorage.getItem(windowKey),null,"opening does not write preferences");
      const header = document.querySelector(".kd-internal-window-head")!;
      for (const [type,x,y] of [["pointerdown",100,100],["pointermove",240,180],["pointerup",240,180]] as const) {
        await act(async () => header.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y})));
      }
      const corner = document.querySelector('[data-edge="se"]')!;
      await act(async () => corner.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true})));
      await act(async () => corner.dispatchEvent(new dom.window.KeyboardEvent("keyup",{key:"ArrowRight",bubbles:true})));
      const stored = localStorage.getItem(windowKey)!;
      assert.deepEqual(JSON.parse(stored),{left:220,top:160,width:476,height:320});
      await act(async () => root.render(null));
      await act(async () => root.render(renderWindow()));
      const reopened = document.querySelector<HTMLElement>('[role="dialog"]')!;
      assert.equal(reopened.style.left,"220px");
      assert.equal(reopened.style.top,"160px");
      assert.equal(reopened.style.width,"476px");
      assert.equal(localStorage.getItem(windowKey),stored,"restoring does not rewrite preferences");
      await act(async () => root.render(null));
      Object.defineProperty(dom.window,"innerWidth",{value:500,configurable:true});
      Object.defineProperty(dom.window,"innerHeight",{value:400,configurable:true});
      await act(async () => root.render(renderWindow()));
      const fitted = document.querySelector<HTMLElement>('[role="dialog"]')!;
      assert.equal(fitted.style.left,"16px");
      assert.equal(fitted.style.top,"72px");
      assert.equal(localStorage.getItem(windowKey),stored,"viewport fitting preserves saved bounds");
    } finally { dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect; }

    await act(async () => root.render(h("div", null, h(PanelDockZone, {side:"top"}), h(PanelDockZone, {side:"right"}),
      h(FloatingPanelWindow, {title:"编辑器", storageKey:"test-editor-dock", closeLabel:"关闭编辑器", close:()=>{},
        children:h("input", {defaultValue:"未保存的编辑", "aria-label":"编辑内容"})}))));
    const editor = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const input = editor.querySelector("input");
    const editorTop = document.querySelector<HTMLElement>('[data-panel-dock="top"]')!;
    const editorRight = document.querySelector<HTMLElement>('[data-panel-dock="right"]')!;
    editorTop.getBoundingClientRect = () => ({left:0,right:250,top:0,bottom:80,width:250,height:80,x:0,y:0,toJSON(){}});
    editorRight.getBoundingClientRect = () => ({left:260,right:490,top:80,bottom:350,width:230,height:270,x:260,y:80,toJSON(){}});
    const moveEditor = async (x:number,y:number) => {
      const header = editor.querySelector(".kd-internal-window-head")!;
      for (const [type,px,py] of [["pointerdown",100,100],["pointermove",x,y],["pointerup",x,y]] as const) {
        await act(async () => header.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,button:0,clientX:px,clientY:py})));
      }
    };
    await moveEditor(150,40);
    assert.equal(editorTop.querySelector("input"),input, "standalone editor windows dock without losing unsaved input");
    await moveEditor(350,200);
    assert.equal(editorRight.querySelector("input"),input);
    await moveEditor(500,390);
    assert.equal(editor.dataset.docked, undefined, "dragging outside both zones restores the editor window");
    assert.equal(editor.querySelector("input"),input);
    assert.equal(input!.value,"未保存的编辑");
    assert.equal(usePanelDock.getState().dragging,false);

  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
