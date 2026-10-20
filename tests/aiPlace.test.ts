import assert from "node:assert/strict";
import test from "node:test";
import { aiTaskBegan, aiTaskEnded, beginAiMove, registerSearchText } from "../src/lib/aiPlace";
import { useAiStore } from "../src/stores/aiStore";
import { readPlace, registerWorkspaceNav, useNavStore, type NavPane } from "../src/stores/navStore";

const settle = () => new Promise(resolve => setTimeout(resolve, 360));

/** A workspace whose list and pane the test moves by hand, and a search field. */
function stage() {
  useNavStore.setState({ past: [], present: null, future: [], dismissedOverlay: null, canBack: false, canForward: false, canUndo: false });
  const screen = { search: null as number | null, pane: "local" as NavPane, text: "mine" };
  const applied: Array<[number | null, NavPane]> = [];
  const notes: string[] = [];
  useAiStore.setState({ running: true, noteUserChange: (change: string) => notes.push(change) });
  const unregisterNav = registerWorkspaceNav({
    read: () => ({ search: screen.search, pane: screen.pane }),
    apply: (search, pane) => {
      applied.push([search, pane]);
      screen.search = search;
      screen.pane = pane;
    },
  });
  const unregisterText = registerSearchText({ read: () => screen.text, write: text => { screen.text = text; } });
  useNavStore.getState().commit(readPlace());
  return {
    screen,
    applied,
    notes,
    /** The window lands somewhere and the history takes it in, as Workspace does. */
    land(search: number | null, pane: NavPane) {
      screen.search = search;
      screen.pane = pane;
      useNavStore.getState().commit(readPlace());
    },
    done() {
      unregisterNav();
      unregisterText();
    },
  };
}

test("the AI's search moved the window and the listener left it be: it goes back when the task ends", async () => {
  const s = stage();
  try {
    aiTaskBegan();
    const moved = beginAiMove("dj set");
    s.screen.text = "dj set";
    s.land(4, "search");
    moved();
    await settle();
    aiTaskEnded();
    await settle();
    assert.deepEqual(s.applied, [[null, "local"]]);
    assert.equal(s.screen.text, "mine");
    assert.deepEqual(s.notes, []);
  } finally {
    s.done();
  }
});

test("the listener went somewhere during the task: nothing is put back, and the AI is told", async () => {
  const s = stage();
  try {
    aiTaskBegan();
    const moved = beginAiMove("dj set");
    s.screen.text = "dj set";
    s.land(4, "search");
    moved();
    await settle();
    s.land(4, "local"); // the listener goes back to the library
    aiTaskEnded();
    await settle();
    assert.deepEqual(s.applied, []);
    assert.equal(s.screen.text, "dj set");
    assert.deepEqual(s.notes, ["用户切到了本地曲库"]);
  } finally {
    s.done();
  }
});

test("a task in which the AI moved nothing leaves the window alone", async () => {
  const s = stage();
  try {
    aiTaskBegan();
    aiTaskEnded();
    await settle();
    assert.deepEqual(s.applied, []);
  } finally {
    s.done();
  }
});
