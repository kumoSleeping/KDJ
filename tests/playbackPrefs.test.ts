import assert from "node:assert/strict";
import test from "node:test";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, String(value)); },
    removeItem(key: string) { values.delete(key); },
  },
});

test("playback preferences apply the new VDJ defaults once and persist later choices", async () => {
  // 旧字段不能迁移成仍在使用的偏好；旧存储即便顺带写过旧默认值，升级后的
  // 第一次启动仍应展开 Control、关闭细节波形。
  values.set("kd-playback-prefs", JSON.stringify({
    transportFade: false,
    quantize: false,
    controlPanelPinned: true,
    detailWaveformVisible: true,
    detailControlVisible: false,
  }));
  const { usePlaybackPrefs } = await import("../src/lib/playbackPrefs");

  assert.equal(usePlaybackPrefs.getState().transportFade, false);
  assert.equal(usePlaybackPrefs.getState().tempoRange, 25);
  assert.equal(usePlaybackPrefs.getState().playingDetailPinned, false);
  assert.equal(usePlaybackPrefs.getState().detailWaveformVisible, false);
  assert.equal(usePlaybackPrefs.getState().detailControlVisible, true);
  assert.equal(usePlaybackPrefs.getState().localExternalDragMode, "file");
  assert.equal(usePlaybackPrefs.getState().timeDisplayMode, "elapsed");

  usePlaybackPrefs.getState().setTempoRange(16);
  usePlaybackPrefs.getState().setPlayingDetailPinned(true);
  usePlaybackPrefs.getState().setDetailWaveformVisible(true);
  usePlaybackPrefs.getState().setDetailControlVisible(false);
  usePlaybackPrefs.getState().setLocalExternalDragMode("share_link");
  usePlaybackPrefs.getState().setTimeDisplayMode("remaining");
  assert.equal(usePlaybackPrefs.getState().tempoRange, 16);
  assert.equal(usePlaybackPrefs.getState().playingDetailPinned, true);
  assert.equal(usePlaybackPrefs.getState().detailWaveformVisible, true);
  assert.equal(usePlaybackPrefs.getState().detailControlVisible, false);
  assert.equal(usePlaybackPrefs.getState().localExternalDragMode, "share_link");
  assert.equal(usePlaybackPrefs.getState().timeDisplayMode, "remaining");
  assert.deepEqual(JSON.parse(values.get("kd-playback-prefs") ?? "{}"), {
    version: 1,
    transportFade: false,
    tempoRange: 16,
    playingDetailPinned: true,
    detailWaveformVisible: true,
    detailControlVisible: false,
    localExternalDragMode: "share_link",
    timeDisplayMode: "remaining",
  });
});
