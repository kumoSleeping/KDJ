import test from "node:test";
import assert from "node:assert/strict";
import packageInfo from "../package.json";
import {
  bilibiliVideoShareSearchQuery,
  firstSourceShareLink,
  formatShareText,
  matchedBilibiliVideoShareLink,
  matchedTrackShareLink,
  platformShareLink,
  songSourceShareLink,
  trackShareLink,
  trackShareSearchQuery,
  writeShareLinkDrag,
} from "../src/lib/shareLink";
import type { SongSource } from "../src/types";
import {
  DEFAULT_SHARE_CONTENT_MODE,
  normalizeShareContentMode,
} from "../src/lib/sharePrefs";
import {
  buildShareClipboardTextHtml,
} from "../src/lib/shareClipboardMarkup";
import { copyShareContent } from "../src/lib/shareClipboard";

function source(
  platform: SongSource["platform"],
  key: string,
  payload: Record<string, unknown> = {},
  title = "",
  artists: string[] = [],
  duration: number | null = null,
): SongSource {
  return {
    platform,
    key,
    payload,
    title,
    artists,
    album: "",
    duration,
    cover: "",
    max_quality: null,
    vip: false,
  };
}

test("music platform sources build public HTTPS share pages", () => {
  assert.equal(
    songSourceShareLink(source("wyy", "347230")),
    "https://y.music.163.com/m/song?id=347230",
  );
  assert.equal(
    songSourceShareLink(source("qqm", "002v8JmQ3rkWK6")),
    "https://y.qq.com/n/ryqq/songDetail/002v8JmQ3rkWK6",
  );
  assert.equal(
    songSourceShareLink(source("ytm", "abc_DEF-123")),
    "https://music.youtube.com/watch?v=abc_DEF-123",
  );
});

test("video platform sources use their canonical watch pages", () => {
  assert.equal(
    platformShareLink("youtube", "fallback", { video_id: "dQw4w9WgXcQ" }),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assert.equal(
    platformShareLink("bilibili", "fallback", { bvid: "BV1L94y1H7CV" }),
    "https://www.bilibili.com/video/BV1L94y1H7CV",
  );
  assert.equal(
    platformShareLink("bilibili", "BV1L94y1H7CV", { page_index: 0, page_count: 4 }),
    "https://www.bilibili.com/video/BV1L94y1H7CV?p=1",
  );
  assert.equal(
    platformShareLink("bilibili", "BV1L94y1H7CV", { page_index: 2, page_count: 4 }),
    "https://www.bilibili.com/video/BV1L94y1H7CV?p=3",
  );
});

test("SoundCloud only copies a trusted public permalink", () => {
  assert.equal(
    songSourceShareLink(
      source("soundcloud", "123", { permalink_url: "http://soundcloud.com/dj/nightdrive" }),
    ),
    "https://soundcloud.com/dj/nightdrive",
  );
  assert.equal(
    songSourceShareLink(
      source("soundcloud", "123", { permalink_url: "https://example.com/not-soundcloud" }),
    ),
    null,
  );
});

test("merged rows fall back from a local source to a shareable online source", () => {
  assert.equal(
    firstSourceShareLink([source("local", "9"), source("wyy", "347230")], 0),
    "https://y.music.163.com/m/song?id=347230",
  );
});

test("local files share immediately when they retain a supported platform identity", () => {
  assert.equal(
    trackShareLink({ source_platform: "qqm", source_key: "002v8JmQ3rkWK6" }),
    "https://y.qq.com/n/ryqq/songDetail/002v8JmQ3rkWK6",
  );
  assert.equal(
    trackShareLink({ source_platform: "bilibili", source_key: "BV1eiXRYHEzL" }),
    "https://www.bilibili.com/video/BV1eiXRYHEzL",
    "下载入库的 B 站视频要直接复用它保留的 BV 号",
  );
  assert.equal(trackShareLink({ source_platform: "local", source_key: "" }), null);
});

test("imported local files can use a strict metadata match", () => {
  const track = {
    title: "夜曲",
    filename: "夜曲.flac",
    artist: "周杰伦",
    duration: 226,
    source_platform: "local",
    source_key: "",
  };
  assert.equal(trackShareSearchQuery(track), "夜曲 周杰伦");
  assert.equal(
    matchedTrackShareLink(track, [
      source("wyy", "185811", {}, "夜曲", ["其他艺人"], 226),
      source("qqm", "001zMQr71F1Qo8", {}, "夜曲", ["周杰伦"], 227),
    ]),
    "https://y.qq.com/n/ryqq/songDetail/001zMQr71F1Qo8",
  );
});

test("legacy Bilibili downloads recover their BV link from KDJ's multipart title", () => {
  const track = {
    title: "电棍语录 微信8.0【待补充】 - P1 - 白银癌症晚期【简介有链接】",
    filename: "电棍语录 微信8.0【待补充】 - P1 - 白银癌症晚期【简介有链接】.mp4",
    artist: "",
    duration: 23,
    source_platform: "local",
    source_key: "",
  };
  assert.equal(bilibiliVideoShareSearchQuery(track), "电棍语录 微信8.0【待补充】");
  assert.equal(
    matchedBilibiliVideoShareLink(track, [
      source(
        "bilibili",
        "BV1DV411q72V",
        {},
        "电棍语录 微信8.0【待补充】",
        ["寒曦Shina"],
        640,
      ),
      source("bilibili", "BV1wrong", {}, "白银癌症晚期", [], 23),
    ]),
    "https://www.bilibili.com/video/BV1DV411q72V?p=1",
    "本地文件只有当前分 P 的时长，不能拿它和整条视频时长比较",
  );
});

test("local metadata matching rejects a different version", () => {
  const track = {
    title: "同名歌曲",
    filename: "同名歌曲.flac",
    artist: "原唱",
    duration: 200,
    source_platform: "local",
    source_key: "",
  };
  assert.equal(
    matchedTrackShareLink(track, [
      source("wyy", "1", {}, "同名歌曲", ["翻唱"], 200),
      source("qqm", "abc", {}, "同名歌曲", ["原唱"], 230),
    ]),
    null,
  );
});

test("malformed platform keys never become links", () => {
  assert.equal(platformShareLink("wyy", "347230&x=1"), null);
  assert.equal(platformShareLink("qqm", "javascript:alert(1)"), null);
  assert.equal(platformShareLink("bilibili", "not-a-bvid"), null);
});

test("more info keeps compact text and only adds the KDJ watermark", () => {
  const link = "https://y.music.163.com/m/song?id=347230";
  const info = { title: "海阔天空", artists: ["Beyond"], album: "乐与怒" };

  assert.equal(formatShareText(link, info, "link_only"), link);
  assert.equal(
    formatShareText(link, info, "song_info"),
    `海阔天空 - Beyond ${link}`,
  );
  assert.equal(
    formatShareText(link, info, "more_info"),
    [
      `海阔天空 - Beyond ${link}`,
      `Share from KDJ v${packageInfo.version}`,
    ].join("\n"),
  );
  assert.equal(
    formatShareText(link, { title: "  夜曲  ", artists: [] }, "song_info"),
    `夜曲 ${link}`,
  );
});

test("sharing defaults to compact song information", () => {
  assert.equal(DEFAULT_SHARE_CONTENT_MODE, "song_info");
  assert.equal(normalizeShareContentMode(undefined), "song_info");
  assert.equal(normalizeShareContentMode("more_info"), "more_info");
});

test("detailed clipboard text HTML escapes metadata and links", () => {
  const html = buildShareClipboardTextHtml(
    "歌曲：A < B · 链接：https://example.com?a=1&b=2\nShare from KDJ v0.2.45",
  );
  assert.match(html, /歌曲：A &lt; B/);
  assert.match(html, /a=1&amp;b=2/);
  assert.match(html, /Share from KDJ v0\.2\.45/);
  assert.doesNotMatch(html, /<img\b/);
});

test("detailed sharing starts the clipboard write before artwork finishes", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
  const calls: string[] = [];
  let rejectArtwork: ((reason: unknown) => void) | undefined;

  class TestClipboardItem {
    constructor(
      readonly payload: Record<string, string | Blob | PromiseLike<string | Blob>>,
      readonly options?: ClipboardItemOptions,
    ) {}
  }

  try {
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: async () => {
            calls.push("writeText");
          },
          write: async (items: ClipboardItem[]) => {
            calls.push("write");
            assert.equal(items.length, 2);
            const copy = items[0] as unknown as TestClipboardItem;
            const image = items[1] as unknown as TestClipboardItem;
            assert.deepEqual(Object.keys(copy.payload), ["text/html", "text/plain"]);
            assert.equal(copy.options?.presentationStyle, "inline");
            assert.deepEqual(Object.keys(image.payload), ["image/png"]);
            assert.equal(image.options?.presentationStyle, "attachment");
            await image.payload["image/png"];
          },
        },
      },
    });

    const sharing = copyShareContent(
      "夜曲 - 周杰伦 https://example.com/song",
      "more_info",
      () => {
        calls.push("artwork");
        return new Promise<Blob>((_resolve, reject) => {
          rejectArtwork = reject;
        });
      },
    );

    // Node 没有 DOM，所以纯文本保底走 writeText；关键是封面 Promise
    // 仍然 pending 时 write 已经在本次点击的同步调用栈里发起。
    assert.deepEqual(calls, ["writeText", "artwork", "write"]);
    rejectArtwork?.(new Error("模拟封面不可用"));
    await sharing;
  } finally {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
    if (clipboardItemDescriptor) {
      Object.defineProperty(globalThis, "ClipboardItem", clipboardItemDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "ClipboardItem");
    }
  }
});

test("external drag publishes a URL while preserving KDJ's internal plain-text fallback", () => {
  const values = new Map<string, string>([["text/plain", "kdj-internal-payload"]]);
  const transfer = {
    effectAllowed: "none",
    setData(type: string, value: string) { values.set(type, value); },
    setDragImage() {},
  } as unknown as DataTransfer;

  writeShareLinkDrag(transfer, "https://y.music.163.com/m/song?id=347230", null);
  assert.equal(transfer.effectAllowed, "copyLink");
  assert.equal(values.get("text/uri-list"), "https://y.music.163.com/m/song?id=347230");
  assert.equal(values.get("text/plain"), "https://y.music.163.com/m/song?id=347230");

  writeShareLinkDrag(transfer, "https://y.music.163.com/m/song?id=347230", null, {
    plainText: "夜曲 - 周杰伦 https://y.music.163.com/m/song?id=347230",
  });
  assert.equal(
    values.get("text/plain"),
    "夜曲 - 周杰伦 https://y.music.163.com/m/song?id=347230",
  );
  assert.equal(values.get("text/uri-list"), "https://y.music.163.com/m/song?id=347230");

  values.set("text/plain", "kdj-internal-payload");
  writeShareLinkDrag(transfer, "https://y.music.163.com/m/song?id=347230", null, {
    preservePlainText: true,
  });
  assert.equal(values.get("text/plain"), "kdj-internal-payload");
});
