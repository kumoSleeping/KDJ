import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { StoreApi } from "zustand";
import { usePlaybackPrefs } from "./playbackPrefs";
import { useArrowKeyControl } from "./arrowKeyControl";
import { useSharePrefs } from "./sharePrefs";
import { useLyricsPrefs } from "./lyricsPrefs";
import { useUpdateStore } from "../stores/updateStore";
import { applyAppFontScale, readAppFontScale, APP_FONT_SCALE_EVENT } from "./fontScale";
import { editorWindowLabels } from "./windowRole";

const CHANGED = "kdj:preference-changed", REQUEST = "kdj:preference-request";
type Message = { source: string; group: string; values: Record<string, unknown> };
let started: Promise<void> | undefined;

/** Sync only preference fields, never actions, playback state or editor documents. */
export function startPreferenceWindowSync(): Promise<void> {
  return started ??= (async () => {
    const win = getCurrentWebviewWindow(), source = win.label;
    const labels = ["main", ...editorWindowLabels];
    let receiving = false;
    const publish = (group: string, values: Record<string, unknown>) => {
      if (receiving) return;
      const message: Message = { source, group, values };
      void Promise.all(labels.filter(label => label !== source).map(label => emitTo(label, CHANGED, message)))
        .catch(error => console.warn("偏好设置同步失败", error));
    };
    function bind<T extends object>(group: string, store: StoreApi<T>, keys: readonly (keyof T)[], apply?: (patch: Partial<T>) => void) {
      const snapshot = () => Object.fromEntries(keys.map(key => [key, store.getState()[key]]));
      store.subscribe((state, previous) => {
        const changed = keys.filter(key => state[key] !== previous[key]);
        if (changed.length) publish(group, Object.fromEntries(changed.map(key => [key, state[key]])));
      });
      return { group, snapshot, receive: (values: Record<string, unknown>) => {
        const patch = Object.fromEntries(keys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[String(key)]])) as Partial<T>;
        if (apply) apply(patch); else store.setState(patch);
      } };
    }
    const bindings = [
      bind("playback", usePlaybackPrefs, ["transportFade", "tempoRange", "playingDetailPinned", "detailWaveformVisible", "detailControlVisible", "localExternalDragMode", "timeDisplayMode"]),
      bind("keyboard", useArrowKeyControl, ["enabled", "horizontalMode", "verticalMode"]),
      bind("share", useSharePrefs, ["contentMode"]),
      bind("lyrics", useLyricsPrefs, ["engines", "displaySource", "tryOnlineWhenMissing"], patch => {
        useLyricsPrefs.getState().syncFromSnapshot({ ...useLyricsPrefs.getState(), ...patch });
      }),
      bind("updates", useUpdateStore, ["autoCheck"]),
    ];
    let fontScale = readAppFontScale();
    window.addEventListener(APP_FONT_SCALE_EVENT, event => {
      fontScale = (event as CustomEvent<number>).detail;
      publish("font", { scale: fontScale });
    });
    await win.listen<Message>(CHANGED, ({ payload }) => {
      if (payload.source === source || !labels.includes(payload.source)) return;
      receiving = true;
      try {
        if (payload.group === "font" && typeof payload.values.scale === "number") {
          fontScale = payload.values.scale;
          applyAppFontScale(fontScale);
          window.dispatchEvent(new CustomEvent(APP_FONT_SCALE_EVENT, { detail: fontScale }));
        } else bindings.find(binding => binding.group === payload.group)?.receive(payload.values);
      } finally { receiving = false; }
    });
    if (source === "main") {
      await win.listen<string>(REQUEST, async ({ payload: target }) => {
        if (!editorWindowLabels.some(label => label === target)) return;
        for (const binding of bindings) await emitTo(target, CHANGED, { source, group: binding.group, values: binding.snapshot() });
        await emitTo(target, CHANGED, { source, group: "font", values: { scale: fontScale } });
      });
    } else await emitTo("main", REQUEST, source);
  })();
}
