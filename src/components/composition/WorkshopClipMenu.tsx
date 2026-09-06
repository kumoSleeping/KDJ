import { useEffect, useLayoutEffect, useRef } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import { deleteClip, findClip, updateClip, resetFadeSpan, isVisualSource, isImageSource } from "../../lib/workshop";
import type { WorkshopClip } from "../../types/workshop";
export function WorkshopClipMenu({ id, x, y, close }: { id: string; x: number; y: number; close(): void }) {
  const p = useWorkshopStore(s => s.draft), ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const menu = ref.current, bounds = menu?.parentElement;
    if (!menu || !bounds) return;
    const place = () => {
      // Expanded sections change the menu height; keep the whole scroll area
      // inside the workshop, above the player and other clipping ancestors.
      const inset = 8;
      menu.style.left = `${Math.max(inset, Math.min(x, bounds.clientWidth - menu.offsetWidth - inset))}px`;
      menu.style.top = `${Math.max(inset, Math.min(y, bounds.clientHeight - menu.offsetHeight - inset))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    observer.observe(bounds);
    return () => observer.disconnect();
  }, [id, x, y]);
  useEffect(() => {
    const finish = () => {
      // Commit the focused numeric field before unmounting it on outside clicks.
      const active = document.activeElement;
      if (active instanceof HTMLElement && ref.current?.contains(active)) active.blur();
      closeRef.current();
    };
    const dismiss = (e: Event) => { if (!ref.current?.contains(e.target as Node)) finish(); };
    // Clip and trim gestures stop propagation; catch the outside press before
    // those handlers, while still letting the click perform its normal action.
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("focusin", dismiss, true);
    window.addEventListener("blur", finish);
    ref.current?.focus();
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("focusin", dismiss, true);
      window.removeEventListener("blur", finish);
    };
  }, []);
  const c = p && findClip(p, id), source = c && p?.sources.find(s => s.id === c.source_id);
  if (!c || !source) return null;
  const edit = (fn: (c: WorkshopClip) => void) => useWorkshopStore.getState().edit(p => updateClip(p, id, fn));
  const remove = (ripple: boolean) => {
    const state = useWorkshopStore.getState();
    state.edit(p => deleteClip(p, id, ripple));
    state.select(null);
    close();
  };
  const speed = (n: number) => { if (n >= .5 && n <= 2) edit(c => { c.speed = {...c.speed, preset:"constant", start:n, middle:n, end:n}; resetFadeSpan(c); }); };
  const number = (label: string, value: number, min: number, max: number, fn: (n: number) => void, suffix = "%") =>
    <label className="vj-context-number">{label}<input key={`${id}:${label}:${value}`} type="number" aria-label={label} defaultValue={value} min={min} max={max} step={suffix === "×" ? .05 : suffix === "秒" ? .001 : 1}
      onBlur={e => { const n = Number(e.currentTarget.value); if (e.currentTarget.value && Number.isFinite(n) && n >= min && n <= max && n !== value) fn(n); }}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />{suffix}</label>;
  return <div ref={ref} className="vj-clip-menu vj-menu" aria-label="片段操作菜单" tabIndex={-1} style={{left:x, top:y}}
    onContextMenu={e => e.preventDefault()} onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") close(); }}>
    {isVisualSource(source) && <button type="button" onClick={() => {
      edit(c => { c.picture = {...c.picture, x:.5, y:.5, scale:1}; });
      close();
    }}><RotateCcw size={13} />还原原始比例</button>}
    <button type="button" onClick={() => remove(false)}><Trash2 size={13} />删除片段</button>
    <button type="button" onClick={() => remove(true)}>删除并闭合本行空隙</button>
    {isVisualSource(source) && <details><summary>画面</summary><div className="vj-menu-options">
      <button onClick={() => edit(c => { c.picture = {...c.picture, x:.5, y:.5, scale:.5}; })}>居中 50%</button>
      {number("大小", Math.round(c.picture.scale * 100), 10, 200, n => edit(c => {c.picture.scale = n / 100;}))}
      {number("透明度", Math.round(c.picture.opacity * 100), 0, 100, n => edit(c => {c.picture.opacity = n / 100;}))}
      {number("横向", Math.round(c.picture.x * 100), 0, 100, n => edit(c => {c.picture.x = n / 100;}))}
      {number("纵向", Math.round(c.picture.y * 100), 0, 100, n => edit(c => {c.picture.y = n / 100;}))}
    </div></details>}
    {isImageSource(source) && <>
      {number("显示时长", (c.display_duration_ms ?? 5000)/1000, 1/p!.canvas.fps, (21_600_000-c.start_ms)/1000, n => edit(c => {c.display_duration_ms=n*1000;resetFadeSpan(c);}), "秒")}
      <details><summary>变换与裁剪</summary><div className="vj-menu-options">
        {number("旋转", c.picture.rotation ?? 0, -360, 360, n => edit(c => {c.picture.rotation=n;}), "°")}
        <button aria-pressed={Boolean(c.picture.flip_x)} onClick={() => edit(c => {c.picture.flip_x=!c.picture.flip_x;})}>水平翻转</button>
        <button aria-pressed={Boolean(c.picture.flip_y)} onClick={() => edit(c => {c.picture.flip_y=!c.picture.flip_y;})}>垂直翻转</button>
        <button onClick={() => {useWorkshopStore.setState({cropId:id});close();}}>裁剪画面</button>
        {(["左侧裁剪","上侧裁剪","右侧裁剪","下侧裁剪"] as const).map((label,i) => <div key={label}>{number(label, Math.round((c.picture.crop?.[i]??0)*100), 0, 98-(c.picture.crop?.[(i+2)%4]??0)*100, n => edit(c => {const crop=[...(c.picture.crop??[0,0,0,0])] as [number,number,number,number];crop[i]=n/100;c.picture.crop=crop;}))}</div>)}
        <button onClick={() => {edit(c => {c.picture.crop=[0,0,0,0];});useWorkshopStore.setState({cropId:null});}}>重置裁剪</button>
        <button onClick={() => {edit(c => {c.picture={...c.picture,x:.5,y:.5,scale:1,rotation:0,flip_x:false,flip_y:false,crop:[0,0,0,0]};});useWorkshopStore.setState({cropId:null});}}>重置画面</button>
      </div></details>
    </>}
    {source.audio && <details><summary>声音</summary><div className="vj-menu-options">
      <button aria-pressed={c.sound.muted} onClick={() => edit(c => {c.sound.muted = !c.sound.muted; c.sound.manual = true;})}>{c.sound.muted ? "取消静音" : "静音"}</button>
      {number("音量", Math.round(c.sound.gain * 100), 0, 200, n => edit(c => {c.sound.gain = n / 100; c.sound.manual = true;}))}
    </div></details>}
    {!isImageSource(source) && <details><summary>变速</summary><div className="vj-menu-options">
      {[.5,.75,1,1.25,1.5,2].map(n => <button key={n} aria-pressed={c.speed.preset === "constant" && c.speed.start === n} onClick={() => speed(n)}>{n}×</button>)}
      {number("自定速度", c.speed.start, .5, 2, speed, "×")}
    </div></details>}
  </div>;
}
