import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { WorkshopSubtitle } from "../../types/workshop";
import { defaultSubtitle, rasterizeSubtitle, subtitleFonts } from "../../lib/workshopSubtitle";
import { useWorkshopStore } from "../../stores/workshopStore";
import { NumberField } from "./WorkshopNumberField";

export function WorkshopSubtitleEditor({ initial, clipId, close }: {
  initial?: WorkshopSubtitle; clipId?: string; close(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<WorkshopSubtitle>(() => structuredClone(initial ?? defaultSubtitle));
  const [rendered, setRendered] = useState<{key: string; png: Blob; url: string} | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(settings);
  const patch = (value: Partial<WorkshopSubtitle>) => setSettings(s => ({...s, ...value}));
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector("textarea")?.focus();
  }, []);
  useEffect(() => {
    let alive = true, url: string | undefined;
    setRendered(null); setError("");
    const timer = setTimeout(() => {
      if (!settings.text.trim()) return;
      void rasterizeSubtitle(settings).then(png => {
        if (!alive) return;
        url = URL.createObjectURL(png);
        setRendered({key, png, url});
      }).catch(e => { if (alive) setError(String(e)); });
    }, 120);
    return () => { alive = false; clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
  }, [key]);
  const submit = async () => {
    if (busy || rendered?.key !== key) return;
    if (initial && JSON.stringify(initial) === key) { close(); return; }
    setBusy(true); setError("");
    try {
      const saved = await useWorkshopStore.getState().saveSubtitle(settings, rendered.png, clipId);
      if (saved) close();
      else setError(useWorkshopStore.getState().error);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="vj-dialog vj-subtitle-dialog" aria-label={clipId ? "编辑字幕" : "添加字幕"}
    onCancel={e => { e.preventDefault(); if (!busy) close(); }} onKeyDown={e => e.stopPropagation()}>
    <header><strong>{clipId ? "编辑字幕" : "添加字幕"}</strong>
      <button type="button" aria-label="关闭字幕设置" disabled={busy} onClick={close}><X size={15} /></button></header>
    <fieldset disabled={busy}>
      <label className="vj-subtitle-text">文字<textarea autoFocus aria-label="字幕文字" maxLength={2000} rows={4}
        value={settings.text} onChange={e => patch({text: e.target.value})} /></label>
      <div className="vj-subtitle-options">
        <label>字体<select aria-label="字幕字体" value={settings.font} onChange={e => patch({font: e.target.value as WorkshopSubtitle["font"]})}>
          {Object.entries(subtitleFonts).map(([id, font]) => <option key={id} value={id}>{font.label}</option>)}
        </select></label>
        <NumberField label="字号" value={settings.font_size} min={12} max={240} step={1} suffix="px" onChange={font_size => patch({font_size})} />
        <button type="button" aria-pressed={settings.bold} onClick={() => patch({bold: !settings.bold})}>粗体</button>
        <button type="button" aria-pressed={settings.italic} onClick={() => patch({italic: !settings.italic})}>斜体</button>
        <label>对齐<select aria-label="字幕对齐" value={settings.align} onChange={e => patch({align: e.target.value as WorkshopSubtitle["align"]})}>
          <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
        </select></label>
        <label>文字颜色<input type="color" aria-label="字幕颜色" value={settings.color} onChange={e => patch({color: e.target.value})} /></label>
        <label>描边颜色<input type="color" aria-label="字幕描边颜色" value={settings.outline_color} onChange={e => patch({outline_color: e.target.value})} /></label>
        <NumberField label="描边" value={settings.outline_width} min={0} max={12} step={.5} suffix="px" onChange={outline_width => patch({outline_width})} />
      </div>
    </fieldset>
    <div className="vj-subtitle-sample">{rendered?.key === key && <img src={rendered.url} alt="字幕预览" />}</div>
    {error && <div className="vj-error" role="status">{error}</div>}
    <footer><button type="button" disabled={busy} onClick={close}>取消</button>
      <button type="button" disabled={busy || rendered?.key !== key} onClick={() => void submit()}>{busy ? "保存中" : clipId ? "保存" : "添加"}</button></footer>
  </dialog>, document.body);
}
