import assert from "node:assert/strict";
import test from "node:test";
import { bindTracksToPhysicalDecks } from "../src/lib/deckTrackBinding";
import type { Track } from "../src/types";

function track(id: number, title: string): Track {
  return { id, title } as Track;
}

test("Deck rows bind by physical side for local and remote ids alike", () => {
  const local = track(7, "local");
  const remote = track(-3, "remote");
  assert.deepEqual(
    bindTracksToPhysicalDecks([7, -3], [null, remote], [local]),
    [local, remote],
  );
});

test("stale preferred rows cannot control a replacement physical Deck", () => {
  const oldRemote = track(-3, "old remote");
  const replacement = track(-4, "replacement");
  assert.deepEqual(
    bindTracksToPhysicalDecks([-4, null], [oldRemote, null], [replacement]),
    [replacement, null],
  );
  assert.deepEqual(
    bindTracksToPhysicalDecks([-4, null], [oldRemote, null], []),
    [null, null],
  );
});

test("the same Track may intentionally be installed on both physical Decks", () => {
  const shared = track(-8, "shared");
  assert.deepEqual(
    bindTracksToPhysicalDecks([-8, -8], [shared, null], []),
    [shared, shared],
  );
});
