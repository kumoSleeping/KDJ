import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isOneLibraryTargetConnected,
  oneLibraryPlayableTrack,
  oneLibraryTrackByPlaybackId,
  reconcileOneLibrarySelection,
  resolveOneLibraryDropTarget,
  reorderOneLibraryContentIds,
} from "../src/lib/oneLibraryTrack";
import {
  PLAYLIST_DROP_DEVICE_ATTR,
  PLAYLIST_DROP_ID_ATTR,
  playlistDropLocation,
} from "../src/lib/folderDrop";
import {
  isOneLibraryPlaybackTrack,
  localLibraryDataTrackId,
  oneLibraryPlaybackSource,
  usesLocalLibraryRecord,
  usesRemotePlaybackSource,
} from "../src/lib/playbackTrackSource";
import type { CuePoint, OneLibraryTarget, OneLibraryTrack, RemovableDevice } from "../src/types";
import { oneLibraryTreeDropPosition } from "../src/lib/oneLibraryTree";
import {
  cueColor,
  cueColorLabel,
  cueTimeRange,
  cueTypeLabel,
  DEFAULT_LOOP_OVERLAY_COLOR,
  formatCueTime,
  hotCueLabel,
  waveformLoopRegions,
} from "../src/lib/cuePoints";
import { OneLibraryCueList } from "../src/components/library/OneLibraryCueList";
import { TrackKeyChip } from "../src/components/common/TrackKeyChip";

test("OneLibrary multi-row reorder keeps the selected block in visible order", () => {
  assert.deepEqual(
    reorderOneLibraryContentIds([1, 2, 3, 4, 5], [2, 4], 5, false),
    [1, 3, 5, 2, 4],
  );
  assert.deepEqual(
    reorderOneLibraryContentIds([1, 2, 3, 4, 5], [4, 2], 1, true),
    [2, 4, 1, 3, 5],
  );
});

test("OneLibrary reorder ignores an invalid target instead of losing rows", () => {
  const current = [1, 2, 3];
  assert.deepEqual(reorderOneLibraryContentIds(current, [2], 99, true), current);
});

test("OneLibrary refresh retains surviving selections and clears removed focus", () => {
  const tracks = [{ content_id: 2 }, { content_id: 3 }] as OneLibraryTrack[];
  assert.deepEqual(reconcileOneLibrarySelection(tracks, [1, 2], 1), {
    selectedContentIds: [2],
    focusedContentId: null,
  });
  assert.deepEqual(reconcileOneLibrarySelection(tracks, [2], 2), {
    selectedContentIds: [2],
    focusedContentId: 2,
  });
});

test("OneLibrary tree drops account for the source row leaving a zero-based sibling list", () => {
  const source = { parent_id: 0, seq: 0 };
  const target = { id: 20, parent_id: 0, seq: 2 };
  assert.deepEqual(oneLibraryTreeDropPosition(source, target, "before"), {
    parentId: 0,
    sequence: 1,
  });
  assert.deepEqual(oneLibraryTreeDropPosition(source, target, "after"), {
    parentId: 0,
    sequence: 2,
  });
  assert.deepEqual(oneLibraryTreeDropPosition(source, target, "inside"), {
    parentId: 20,
    sequence: null,
  });
});

test("online drag fallback resolves the exact writable OneLibrary playlist", () => {
  const attributes = new Map([
    [PLAYLIST_DROP_DEVICE_ATTR, "/Volumes/KDJ"],
    [PLAYLIST_DROP_ID_ATTR, "7"],
  ]);
  const location = playlistDropLocation({
    getAttribute: (name: string) => attributes.get(name) ?? null,
  });
  assert.deepEqual(location, { devicePath: "/Volumes/KDJ", playlistId: 7 });

  const device: RemovableDevice = {
    path: "/Volumes/KDJ",
    name: "KDJ",
    file_system: "ExFAT",
    total_bytes: 8_000_000_000,
    available_bytes: 4_000_000_000,
    read_only: false,
    one_library_file_system: true,
    has_one_library: true,
    is_virtual: true,
  };
  const playlists = {
    "/Volumes/KDJ": [{
      device_path: "/Volumes/KDJ",
      id: 7,
      seq: 0,
      name: "Set",
      attribute: 0,
      parent_id: 0,
      track_count: 0,
    }],
  };
  assert.deepEqual(
    resolveOneLibraryDropTarget(
      location!.devicePath,
      location!.playlistId,
      [device],
      playlists,
    ),
    {
      device_path: "/Volumes/KDJ",
      device_name: "KDJ",
      is_virtual: true,
      playlist_id: 7,
      playlist_name: "Set",
    },
  );
  assert.equal(
    resolveOneLibraryDropTarget("/Volumes/KDJ", 7, [{ ...device, read_only: true }], playlists),
    null,
  );
  assert.equal(
    playlistDropLocation({ getAttribute: () => "" }),
    null,
  );
});

test("OneLibrary cue labels preserve type, number, time, loop, and standard color", () => {
  const cue: CuePoint = {
    id: 9,
    hot_cue: 2,
    start_ms: 62_345,
    end_ms: 66_000,
    color_index: 7,
    color: "Blue",
    comment: "Drop",
    active_loop: true,
  };
  assert.equal(hotCueLabel(cue.hot_cue), "B");
  assert.equal(cueTypeLabel(cue), "Hot Loop B");
  assert.equal(formatCueTime(cue.start_ms), "01:02.345");
  assert.equal(cueTimeRange(cue), "01:02.345 – 01:06.000");
  assert.equal(cueColorLabel(cue), "蓝色");
  assert.equal(cueColor(cue), "#4676df");
  assert.equal(cueTypeLabel({ ...cue, hot_cue: null, end_ms: null }), "Memory Cue");
});

test("waveform loop regions use cue color when the live loop matches a cue loop", () => {
  const cue: CuePoint = {
    id: 2,
    hot_cue: 2,
    start_ms: 8_000,
    end_ms: 12_000,
    color_index: 4,
    color: "yellow",
    comment: "",
    active_loop: true,
  };
  const live = waveformLoopRegions([], 8, 4);
  assert.equal(live.length, 1);
  assert.equal(live[0].color, DEFAULT_LOOP_OVERLAY_COLOR);
  assert.equal(live[0].active, true);
  const matched = waveformLoopRegions([cue], 8, 4);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].color, "#d4a900");
  assert.equal(matched[0].active, true);
  const preview = waveformLoopRegions([cue], null, null);
  assert.equal(preview.length, 1);
  assert.equal(preview[0].active, false);
});

test("OneLibrary cue UI renders waveform flags, loop ranges, details, and no empty filler", async () => {
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    document: {
      baseURI: "http://127.0.0.1/",
      createElement: () => ({ preservesPitch: true, webkitPreservesPitch: true }),
      documentElement: { dataset: {} },
      querySelectorAll: () => [],
    },
    window: {
      kdj: { baseUrl: "http://127.0.0.1:43123", platform: "darwin" },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  const { Waveform } = await import("../src/components/library/Waveform");
  const cue: CuePoint = {
    id: 9,
    hot_cue: 2,
    start_ms: 62_345,
    end_ms: 66_000,
    color_index: 7,
    color: "Blue",
    comment: "Drop",
    active_loop: true,
  };
  const markup = renderToStaticMarkup(createElement("div", null,
    createElement(Waveform, {
      trackId: 42,
      duration: 120,
      cuePoints: [cue],
      seekable: false,
    }),
    createElement(OneLibraryCueList, { cuePoints: [cue] }),
  ));
  assert.match(markup, /class="kd-wave-cue-loop"/);
  assert.match(markup, /class="kd-wave-cue" data-kind="hot"/);
  assert.match(markup, /data-kind="loop-end"/);
  assert.match(markup, /Hot Loop B/);
  assert.match(markup, /01:02\.345 – 01:06\.000/);
  assert.match(markup, /蓝色/);
  assert.match(markup, /Drop/);
  assert.equal(renderToStaticMarkup(createElement(OneLibraryCueList, { cuePoints: [] })), "");
});

test("an ad-hoc loop paints a default overlay until it matches a cue loop color", async () => {
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    document: {
      baseURI: "http://127.0.0.1/",
      createElement: () => ({ preservesPitch: true, webkitPreservesPitch: true }),
      documentElement: { dataset: {} },
      querySelectorAll: () => [],
    },
    window: {
      kdj: { baseUrl: "http://127.0.0.1:43123", platform: "darwin" },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  const { Waveform } = await import("../src/components/library/Waveform");
  const { DEFAULT_LOOP_OVERLAY_COLOR } = await import("../src/lib/cuePoints");
  const adHoc = renderToStaticMarkup(createElement(Waveform, {
    trackId: 42,
    duration: 120,
    loopStart: 8,
    loopLength: 4,
    seekable: false,
  }));
  assert.match(adHoc, /class="kd-wave-cue-loop"/);
  assert.match(adHoc, /data-active="true"/);
  assert.match(adHoc, new RegExp(DEFAULT_LOOP_OVERLAY_COLOR));
  assert.doesNotMatch(adHoc, /data-kind="loop-start"/);
  assert.doesNotMatch(adHoc, /data-kind="loop-end"/);
  const cue: CuePoint = {
    id: 9,
    hot_cue: 2,
    start_ms: 8_000,
    end_ms: 12_000,
    color_index: 4,
    color: "yellow",
    comment: "",
    active_loop: true,
  };
  const matched = renderToStaticMarkup(createElement(Waveform, {
    trackId: 42,
    duration: 120,
    cuePoints: [cue],
    loopStart: 8,
    loopLength: 4,
    seekable: false,
  }));
  assert.match(matched, /#d4a900/);
  assert.doesNotMatch(matched, new RegExp(DEFAULT_LOOP_OVERLAY_COLOR));
});

test("local and OneLibrary keys share the same colored presentation", () => {
  const camelot = renderToStaticMarkup(createElement(TrackKeyChip, {
    track: { music_key: "F# M", camelot: "2B" },
    notation: "camelot",
  }));
  const traditional = renderToStaticMarkup(createElement(TrackKeyChip, {
    track: { music_key: "F# M", camelot: "2B" },
    notation: "traditional",
  }));
  assert.match(camelot, /class="kd-camelot"/);
  assert.match(camelot, /--kd-key-color:hsl\(/);
  assert.match(camelot, />2B</);
  assert.match(traditional, /--kd-key-color:hsl\(/);
  assert.match(traditional, />F# M</);
});

test("OneLibrary select all follows the currently visible filtered rows", async () => {
  const { usePlaylistStore } = await import("../src/stores/playlistStore");
  const tracks = [{ content_id: 1 }, { content_id: 2 }, { content_id: 3 }] as OneLibraryTrack[];
  usePlaylistStore.setState({
    selectedTracks: tracks,
    visibleContentIds: [2, 3],
    selectedContentIds: [1],
    focusedContentId: 1,
    selectionMode: false,
  });
  usePlaylistStore.getState().selectAllTracks();
  assert.deepEqual(usePlaylistStore.getState().selectedContentIds, [2, 3]);
  assert.equal(usePlaylistStore.getState().focusedContentId, 2);
  assert.equal(usePlaylistStore.getState().selectionMode, true);
});

test("OneLibrary playback snapshots use stable non-library ids and the mounted path", () => {
  const target: OneLibraryTarget = {
    device_path: "/Volumes/KDJ",
    device_name: "KDJ",
    is_virtual: true,
    playlist_id: 7,
    playlist_name: "Set",
  };
  const track: OneLibraryTrack = {
    content_id: 42,
    sequence: 0,
    local_track_id: 42,
    external_modified: false,
    external_update_count: 0,
    title: "Song",
    artist: "Artist",
    album: "Album",
    genre: "House",
    year: "2026",
    bpm: 128,
    music_key: "Am",
    camelot: "8A",
    open_key: "1m",
    duration: 180,
    bitrate: 320,
    samplerate: 44_100,
    size: 123,
    rating: 4,
    comment: "",
    cover_version: "image-7",
    cue_points: [{
      id: 9,
      hot_cue: 2,
      start_ms: 62_345,
      end_ms: 66_000,
      color_index: 7,
      color: "Blue",
      comment: "Drop",
      active_loop: true,
    }],
    path: "/Volumes/KDJ/Contents/Song.mp3",
    filename: "Song.mp3",
  };
  const first = oneLibraryPlayableTrack(track, target);
  const second = oneLibraryPlayableTrack(track, target);
  assert.equal(first.id, second.id);
  assert.ok(first.id < -1_000_000_000);
  assert.equal(first.path, track.path);
  assert.equal(first.format, "mp3");
  assert.equal(first.source_platform, "onelibrary");
  assert.equal(first.local_track_id, 42, "歌词等本地数据应复用导出来源曲目");
  assert.equal(localLibraryDataTrackId(first), 42);
  assert.equal(localLibraryDataTrackId({ ...first, local_track_id: null }), null);
  assert.deepEqual(first.cue_points, track.cue_points);
  assert.equal(isOneLibraryPlaybackTrack(first), true);
  assert.equal(usesLocalLibraryRecord(first), false);
  assert.deepEqual(oneLibraryPlaybackSource(first), {
    devicePath: "/Volumes/KDJ",
    contentId: 42,
  });
  assert.equal(oneLibraryTrackByPlaybackId(first.id)?.path, track.path);
  assert.equal(
    usesRemotePlaybackSource(first),
    false,
    "OneLibrary 的负数稳定 id 不能被误判成在线试听",
  );

  const windows = { ...first, id: first.id - 1, source_key: "C:\\Music\\KDJ:5" };
  assert.deepEqual(oneLibraryPlaybackSource(windows), {
    devicePath: "C:\\Music\\KDJ",
    contentId: 5,
  });
  for (const source_key of ["/Volumes/KDJ", "/Volumes/KDJ:0", "/Volumes/KDJ:5.5", ":5"]) {
    assert.equal(oneLibraryPlaybackSource({ ...first, source_key }), null, source_key);
  }

  const importedLocal = { ...first, id: 99 };
  assert.equal(isOneLibraryPlaybackTrack(importedLocal), false);
  assert.equal(usesLocalLibraryRecord(importedLocal), true);
  assert.equal(oneLibraryPlaybackSource(importedLocal), null);
});

test("real online preview ids still use the remote playback source", () => {
  const online = {
    ...oneLibraryPlayableTrack(
      {
        content_id: 1,
        sequence: 0,
        local_track_id: null,
        external_modified: false,
        external_update_count: 0,
        title: "Online",
        artist: "Artist",
        album: "",
        genre: "",
        year: "",
        bpm: null,
        music_key: "",
        camelot: "",
        open_key: "",
        duration: 120,
        bitrate: null,
        samplerate: null,
        size: 0,
        rating: 0,
        comment: "",
        cover_version: "",
        cue_points: [],
        path: "stream:wyy:1",
        filename: "Online",
      },
      {
        device_path: "/Volumes/KDJ",
        device_name: "KDJ",
        is_virtual: true,
        playlist_id: 7,
        playlist_name: "Set",
      },
    ),
    id: -1,
    source_platform: "wyy",
    source_key: "1",
    format: "stream",
  };

  assert.equal(isOneLibraryPlaybackTrack(online), false);
  assert.equal(usesRemotePlaybackSource(online), true);
});

test("OneLibrary selection disconnects when its virtual disk is no longer mounted", () => {
  const target: OneLibraryTarget = {
    device_path: "/Volumes/KDJ",
    device_name: "KDJ",
    is_virtual: true,
    playlist_id: 7,
    playlist_name: "Set",
  };
  const mounted: RemovableDevice = {
    path: "/Volumes/KDJ",
    name: "KDJ",
    file_system: "ExFAT",
    total_bytes: 8_000_000_000,
    available_bytes: 4_000_000_000,
    read_only: false,
    one_library_file_system: true,
    has_one_library: true,
    is_virtual: true,
  };

  assert.equal(isOneLibraryTargetConnected(target, [mounted]), true);
  assert.equal(isOneLibraryTargetConnected(target, []), false);
  assert.equal(
    isOneLibraryTargetConnected(target, [{ ...mounted, is_virtual: false }]),
    false,
    "同一路径后来被实体卷复用也不能保留旧 KDJ 列表",
  );
});
