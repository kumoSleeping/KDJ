import assert from "node:assert/strict";
import test from "node:test";
import {
  albumOfSource,
  appendFetchedGroups,
  COLLECTION_BATCH_SIZE,
  collectionListWindow,
  collectionReveal,
  collectionRowsInHand,
  fetchedCollectionTotal,
  filteredCollectionItem,
  nextCollectionBatch,
  RESTORED_FETCH_ROWS,
  restoredCollectionView,
} from "../src/lib/searchCollections";
import { normalizeWorkspaceSession } from "../src/lib/workspaceSession";
import type { IntakeItem, MergedGroup } from "../src/types";

function group(key: string, id = `list:${key}`): MergedGroup {
  return {
    group_id: id,
    title: key,
    artists: [],
    album: "",
    duration: null,
    cover: "",
    sources: [{
      platform: "bilibili",
      key,
      title: key,
      artists: [],
      album: "",
      duration: null,
      cover: "",
      max_quality: null,
      vip: false,
      payload: {},
    }],
    best_source_index: 0,
    score: 0,
  };
}

function item(kind: IntakeItem["kind"], entry: string, rows: number): IntakeItem {
  return {
    entry,
    kind,
    platform: null,
    title: entry,
    groups: Array.from({ length: rows }, (_, index) => group(`${entry}-${index}`)),
    collections: [],
    errors: {},
    error: "",
  };
}

test("an opened collection shows its first batch and grows by one batch at a time", () => {
  const list = [item("playlist", "a", 230)];
  assert.equal(collectionRowsInHand(list), 230);
  assert.deepEqual(collectionReveal(list, COLLECTION_BATCH_SIZE), { rows: [50], shown: 50 });

  // 230 rows in hand: 50, 100, 150, 200, 230, and nothing after that. Nothing is fetched.
  const shown: number[] = [];
  let step = nextCollectionBatch(50, 230, 230);
  while (step) {
    assert.equal(step.fetch, null);
    shown.push(step.shown);
    step = nextCollectionBatch(step.shown, 230, 230);
  }
  assert.deepEqual(shown, [100, 150, 200, 230]);
  assert.deepEqual(collectionReveal(list, 230), { rows: [230], shown: 230 });
  // More asked for than there is: the list is simply whole.
  assert.deepEqual(collectionReveal(list, 9999), { rows: [230], shown: 230 });
  assert.deepEqual(collectionReveal(list, Number.NaN), { rows: [0], shown: 0 });
});

test("a list that is fetched in pieces asks the provider for a cumulative count", () => {
  // A favourites folder of 230: 50 in hand, the directory knows the rest.
  assert.deepEqual(nextCollectionBatch(50, 50, 230), { shown: 100, fetch: 100 });
  assert.deepEqual(nextCollectionBatch(200, 200, 230), { shown: 230, fetch: 230 });
  assert.equal(nextCollectionBatch(230, 230, 230), null);
  // Everything was fetched for a download while 50 were shown: the rest is only shown.
  assert.deepEqual(nextCollectionBatch(50, 230, 230), { shown: 100, fetch: null });
  // A row was removed after the batch was shown: the next batch starts from what is in hand.
  assert.deepEqual(nextCollectionBatch(50, 49, 229), { shown: 99, fetch: 99 });
  // A failed fetch changes nothing, so the same batch is asked for again.
  assert.deepEqual(nextCollectionBatch(50, 50, 230), nextCollectionBatch(50, 50, 230));

  // The answer says how long the list really is: a short one has ended.
  assert.equal(fetchedCollectionTotal(100, 100, 230), 230);
  assert.equal(fetchedCollectionTotal(100, 73, 230), 73);
  assert.equal(fetchedCollectionTotal(100, 100, 60), 100);
});

test("the list is always a prefix: nothing below a partly shown collection is there yet", () => {
  const list = [
    item("playlist", "a", 120),
    item("search", "words", 30),
    item("album", "b", 80),
  ];
  assert.equal(collectionRowsInHand(list), 200);
  assert.deepEqual(collectionReveal(list, 50), { rows: [50, null, null], shown: 50 });
  assert.deepEqual(collectionReveal(list, 100), { rows: [100, null, null], shown: 100 });
  // The first collection is whole: what follows it shows, and the next collection starts.
  assert.deepEqual(collectionReveal(list, 150), { rows: [120, 30, 30], shown: 150 });
  assert.deepEqual(collectionReveal(list, 200), { rows: [120, 30, 80], shown: 200 });
  // Plain results are never held back.
  assert.deepEqual(collectionReveal([item("search", "q", 180)], 50), { rows: [180], shown: 0 });
  assert.deepEqual(collectionReveal([], 50), { rows: [], shown: 0 });
});

test("rows in hand keep their identity when a longer answer arrives", () => {
  const inHand = [group("a"), group("b"), group("a", "list:a:again")];
  const fetched = [group("a", "new:a"), group("b", "new:b"), group("a", "new:a2"), group("c"), group("a", "new:a3")];
  const next = appendFetchedGroups(inHand, fetched);
  assert.equal(next.length, 5);
  // The same objects, in the same order: selection keys and row state survive.
  assert.ok(next.slice(0, 3).every((entry, index) => entry === inHand[index]));
  assert.deepEqual(next.slice(3).map((entry) => entry.group_id), ["list:c", "new:a3"]);

  // A row removed from the list on screen is not brought back under its old place, and an id
  // that is already a row's key is never handed out twice.
  const afterRemoval = appendFetchedGroups([group("b", "t:b:1")], [group("b", "t:b:0"), group("c", "t:b:1")]);
  assert.deepEqual(afterRemoval.map((entry) => entry.group_id), ["t:b:1", "t:b:1+"]);
  assert.equal(afterRemoval[1].sources[0].key, "c");
  assert.deepEqual(appendFetchedGroups(inHand, []), inHand);
});

test("the rail is told the whole size, and there is one page", () => {
  assert.deepEqual(collectionListWindow(230, 50), { total: 230, page: 1, pageCount: 1, start: 0, end: 50 });
  assert.deepEqual(collectionListWindow(30, 50), { total: 30, page: 1, pageCount: 1, start: 0, end: 30 });
  assert.deepEqual(collectionListWindow(Number.NaN, 50).total, 0);
});

test("a playlist is reopened as far as it was shown, unless that means a long fetch", () => {
  // Rows that are all in hand: as far as it was, where it was.
  assert.deepEqual(restoredCollectionView({ shown: 450, scrollTop: 16000 }, false), { shown: 450, scrollTop: 16000 });
  // A session from before the list grew knows no count: the first batch, where it was.
  assert.deepEqual(restoredCollectionView({ shown: 0, scrollTop: 900 }, true), { shown: 50, scrollTop: 900 });
  assert.deepEqual(
    restoredCollectionView({ shown: RESTORED_FETCH_ROWS, scrollTop: 7000 }, true),
    { shown: RESTORED_FETCH_ROWS, scrollTop: 7000 },
  );
  // Too deep to fetch before anything is shown: from the top.
  assert.deepEqual(
    restoredCollectionView({ shown: RESTORED_FETCH_ROWS + 50, scrollTop: 9000 }, true),
    { shown: 50, scrollTop: 0 },
  );

  const session = normalizeWorkspaceSession({ stream: { scrollTop: 1200, shown: 150.7 } });
  assert.equal(session.stream.shown, 150);
  assert.equal(normalizeWorkspaceSession({ stream: { shown: -4 } }).stream.shown, 0);
  assert.equal(normalizeWorkspaceSession({ stream: {} }).stream.shown, 0);
});

test("a search within an opened collection keeps the songs holding every word, with their ids", () => {
  const list = item("playlist", "a", 0);
  const song = (key: string, title: string, artist: string, album: string) => ({
    ...group(key),
    title,
    artists: [artist],
    album,
  });
  list.groups = [
    song("1", "Ｈｅｌｌｏ World", "Adele", "25"),
    song("2", "晴天", "周杰伦", "叶惠美"),
    song("3", "七里香", "周杰伦", "七里香"),
  ];

  assert.equal(filteredCollectionItem(list, "  "), list);
  assert.deepEqual(filteredCollectionItem(list, "周杰伦").groups.map((g) => g.group_id), ["list:2", "list:3"]);
  assert.deepEqual(filteredCollectionItem(list, "周杰伦 叶惠美").groups.map((g) => g.group_id), ["list:2"]);
  // Full-width letters and case do not matter.
  assert.deepEqual(filteredCollectionItem(list, "hello adele").groups.map((g) => g.group_id), ["list:1"]);
  assert.equal(filteredCollectionItem(list, "周杰伦").kind, "playlist");

  const none = filteredCollectionItem(list, "不存在");
  assert.equal(none.kind, "search");
  assert.equal(none.groups.length, 0);
});

test("a NetEase or QQ song names its album as a collection; a song outside an album does not", () => {
  const source = (platform: "wyy" | "qqm" | "bilibili", album: string, payload: Record<string, unknown>) => ({
    ...group("s").sources[0],
    platform,
    album,
    artists: ["周杰伦"],
    cover: "c.jpg",
    payload,
  });
  assert.deepEqual(albumOfSource(source("wyy", "叶惠美", { al: { id: 18915, name: "叶惠美" } })), {
    kind: "album", platform: "wyy", key: "18915", title: "叶惠美", subtitle: "周杰伦", cover: "c.jpg", count: 0,
  });
  assert.equal(albumOfSource(source("wyy", "旧接口", { album: { id: 7 } }))?.key, "7");
  assert.equal(albumOfSource(source("qqm", "叶惠美", { album: { id: 8220, mid: "003bSL0v4bpKAx" } }))?.key, "003bSL0v4bpKAx");
  assert.equal(albumOfSource(source("qqm", "叶惠美", { album: { id: 8220, mid: "" } }))?.key, "8220");

  assert.equal(albumOfSource(source("wyy", "", { al: { id: 0 } })), null);
  assert.equal(albumOfSource(source("qqm", "单曲", { album: { mid: "", id: 0 } })), null);
  assert.equal(albumOfSource(source("bilibili", "合集", { al: { id: 5 } })), null);
});
