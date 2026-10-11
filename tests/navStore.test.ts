import assert from "node:assert/strict";
import test from "node:test";
import {
  registerWorkspaceNav,
  samePlace,
  useNavStore,
  type NavPane,
  type Place,
} from "../src/stores/navStore";

const library = (over: Partial<Place> = {}): Place => ({
  listMode: "library",
  folder: "",
  folderDeep: true,
  selectedId: null,
  overlay: null,
  search: null,
  pane: "local",
  ...over,
});

function fresh() {
  useNavStore.setState({
    past: [],
    present: null,
    future: [],
    dismissedOverlay: null,
    canBack: false,
    canForward: false,
    canUndo: false,
  });
}

test("picking another song is not going somewhere: the place keeps the pick, the stack stays", () => {
  fresh();
  const nav = useNavStore.getState();
  nav.commit(library());
  nav.commit(library({ selectedId: 7 }));
  nav.commit(library({ selectedId: 9 }));
  assert.equal(useNavStore.getState().past.length, 0);
  assert.equal(useNavStore.getState().present?.selectedId, 9);
  assert.equal(useNavStore.getState().canBack, false);
  assert.ok(samePlace(library(), library({ selectedId: 3 })));
});

test("another online list, the pane switched, or the pane closed is a step; back brings the list back through the workspace", () => {
  fresh();
  const applied: Array<[number | null, NavPane]> = [];
  const unregister = registerWorkspaceNav({
    read: () => ({ search: null, pane: null }),
    apply: (search, pane) => applied.push([search, pane]),
  });
  try {
    const nav = useNavStore.getState();
    nav.commit(library()); //                                   the local list
    nav.commit(library({ search: 1, pane: "search" })); //      a search answered
    nav.commit(library({ search: 1, pane: "local" })); //       the sidebar: back to the local list, the results hidden
    nav.commit(library({ search: 2, pane: "search" })); //      another search from there
    nav.commit(library({ search: null, pane: "local" })); //    the results closed
    assert.equal(useNavStore.getState().past.length, 4);
    assert.deepEqual(useNavStore.getState().searchesKept(), new Set([1, 2]));

    useNavStore.getState().back();
    assert.deepEqual(applied.at(-1), [2, "search"]);
    useNavStore.getState().back();
    assert.deepEqual(applied.at(-1), [1, "local"]);
    useNavStore.getState().back();
    assert.deepEqual(applied.at(-1), [1, "search"]);
    useNavStore.getState().back();
    assert.deepEqual(applied.at(-1), [null, "local"]);
    assert.equal(useNavStore.getState().canBack, false);
    assert.equal(useNavStore.getState().canForward, true);
    useNavStore.getState().forward();
    assert.deepEqual(applied.at(-1), [1, "search"]);
  } finally {
    unregister();
  }
});

test("the lists the history can still return to are those of every place on the stack", async () => {
  fresh();
  const nav = useNavStore.getState();
  nav.commit(library({ search: 4, pane: "search" }));
  nav.commit(library({ search: 5, pane: "search" }));
  useNavStore.getState().back();
  // Applying a place is over after a microtask; the workspace commits later than that.
  await Promise.resolve();
  nav.commit(library({ search: 6, pane: "search" })); // a new search from the past drops the future
  assert.deepEqual(useNavStore.getState().searchesKept(), new Set([4, 6]));
});
