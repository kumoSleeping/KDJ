import assert from "node:assert/strict";
import test from "node:test";
import {
  getPlayerSession,
  getPlayerSessionState,
  publishPlayerSession,
  subscribePlayerSession,
  type PlayerSessionSnapshot,
} from "../src/lib/playerSession";

test("the clockless session keeps its identity while only the position moves", () => {
  const base: PlayerSessionSnapshot = { trackId: 7, status: "playing", playing: true, position: 0, duration: 200, error: "" };
  let notified = 0;
  const unsubscribe = subscribePlayerSession(() => { notified += 1; });
  try {
    publishPlayerSession(base);
    const state = getPlayerSessionState();
    assert.deepEqual({ ...state }, base);
    // Ten ticks of the player clock: every listener hears them, the clockless view does not change.
    for (let tick = 1; tick <= 10; tick += 1) publishPlayerSession({ ...base, position: tick / 10 });
    assert.equal(notified, 11);
    assert.equal(getPlayerSession().position, 1);
    assert.equal(getPlayerSessionState(), state, "same object: useSyncExternalStore does not re-render");
    // Anything else replaces it.
    for (const change of [{ status: "paused", playing: false }, { duration: 201 }, { error: "x" }, { trackId: 8 }] as Partial<PlayerSessionSnapshot>[]) {
      const before = getPlayerSessionState();
      publishPlayerSession({ ...getPlayerSession(), ...change });
      assert.notEqual(getPlayerSessionState(), before, JSON.stringify(change));
      for (const [key, value] of Object.entries(change)) assert.equal(getPlayerSessionState()[key as keyof typeof change], value);
    }
    // An identical snapshot is not published at all.
    const settled = getPlayerSessionState(), heard = notified;
    publishPlayerSession({ ...getPlayerSession() });
    assert.equal(notified, heard);
    assert.equal(getPlayerSessionState(), settled);
  } finally {
    unsubscribe();
  }
});
