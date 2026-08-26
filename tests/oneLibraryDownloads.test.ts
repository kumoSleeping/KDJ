import assert from "node:assert/strict";
import test from "node:test";
import {
  persistOneLibraryDownloadTasks,
  removePendingOneLibraryDownloadTasks,
  removePendingVirtualDiskDownloads,
  updatePendingOneLibraryDownload,
} from "../src/lib/oneLibraryDownloadPersistence";
import type { DownloadTask, OneLibraryTarget, SongSource } from "../src/types";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const target: OneLibraryTarget = {
  device_path: "/Volumes/KDJ",
  device_name: "KDJ",
  is_virtual: true,
  playlist_id: 7,
  playlist_name: "Set",
};
const source: SongSource = {
  platform: "wyy",
  key: "song-1",
  title: "Song",
  artists: ["Artist"],
  album: "Album",
  duration: 180,
  cover: "",
  max_quality: "flac",
  vip: false,
  payload: {},
};
const task: DownloadTask = {
  id: "task-1",
  kind: "audio",
  platform: "wyy",
  title: "Song",
  artist: "Artist",
  quality: "flac",
  state: "queued",
  phase: "waiting",
  progress: 0,
  downloaded_bytes: 0,
  total_bytes: 0,
  speed_bps: 0,
  path: "",
  error: "",
  track_id: null,
  created_at: 1,
  updated_at: 1,
};

test("OneLibrary download target survives until it is explicitly removed", () => {
  persistOneLibraryDownloadTasks(target, [source], [task]);
  const stored = JSON.parse(storage.getItem("kd-onelibrary-download-targets-v1") ?? "[]");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].target.playlist_id, 7);
  assert.equal(stored[0].source.key, "song-1");

  updatePendingOneLibraryDownload(stored[0].id, () => null);
  assert.equal(storage.getItem("kd-onelibrary-download-targets-v1"), null);
});

test("deleting the managed virtual disk forgets only its pending writes", () => {
  const physicalTarget = {
    ...target,
    device_path: "/Volumes/USB",
    device_name: "USB",
    is_virtual: false,
  };
  persistOneLibraryDownloadTasks(target, [source], [{ ...task, id: "virtual-task" }]);
  persistOneLibraryDownloadTasks(physicalTarget, [source], [{ ...task, id: "physical-task" }]);

  removePendingVirtualDiskDownloads();

  const stored = JSON.parse(storage.getItem("kd-onelibrary-download-targets-v1") ?? "[]");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].target.device_path, "/Volumes/USB");
  storage.removeItem("kd-onelibrary-download-targets-v1");
});

test("canceling queued downloads also forgets their pending device writes", () => {
  persistOneLibraryDownloadTasks(target, [source], [{ ...task, id: "keep" }]);
  persistOneLibraryDownloadTasks(target, [source], [{ ...task, id: "cancel" }]);

  removePendingOneLibraryDownloadTasks(["cancel"]);

  const stored = JSON.parse(storage.getItem("kd-onelibrary-download-targets-v1") ?? "[]");
  assert.deepEqual(stored.map((row: { task_id: string }) => row.task_id), ["keep"]);
  storage.removeItem("kd-onelibrary-download-targets-v1");
});
