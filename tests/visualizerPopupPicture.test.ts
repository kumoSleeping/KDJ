import assert from "node:assert/strict";
import test from "node:test";
import { popupPictureAfter, popupSettingsStay, type PopupPicture } from "../src/lib/visualizerPopupPicture";

test("a song starts unknown and its report replaces the one before it", () => {
  const first = popupPictureAfter(null, 7, "loading");
  assert.deepEqual(first, { song: 7, content: "loading" });
  assert.deepEqual(popupPictureAfter(first, 7, "empty"), { song: 7, content: "empty" });
  // The next song owes nothing to what the last one turned out to be.
  assert.deepEqual(popupPictureAfter({ song: 7, content: "empty" }, 8, "loading"), { song: 8, content: "loading" });
  assert.deepEqual(popupPictureAfter({ song: 7, content: "ready" }, 8, "loading"), { song: 8, content: "loading" });
});

test("a window that has come up stays up for its song", () => {
  const up: PopupPicture = { song: 7, content: "ready" };
  // A second picture being decoded, or a scene that stops drawing, reports these again.
  assert.equal(popupPictureAfter(up, 7, "loading"), up);
  assert.equal(popupPictureAfter(up, 7, "empty"), up);
  // A song that had nothing can get a picture later (one added in the studio).
  assert.deepEqual(popupPictureAfter({ song: 7, content: "empty" }, 7, "loading"), { song: 7, content: "loading" });
  assert.deepEqual(popupPictureAfter({ song: 7, content: "loading" }, 7, "ready"), up);
});

test("an unchanged report keeps the same record", () => {
  const waiting: PopupPicture = { song: 7, content: "loading" };
  assert.equal(popupPictureAfter(waiting, 7, "loading"), waiting);
});

test("the drawer's controls leave only for a song known to bring no window", () => {
  assert.equal(popupSettingsStay(null, 7), true, "nothing reported yet");
  assert.equal(popupSettingsStay({ song: 7, content: "loading" }, 7), true);
  assert.equal(popupSettingsStay({ song: 7, content: "ready" }, 7), true);
  assert.equal(popupSettingsStay({ song: 7, content: "empty" }, 7), false);
  // The record is still about the song before: the new one has not been found out yet.
  assert.equal(popupSettingsStay({ song: 6, content: "empty" }, 7), true);
  assert.equal(popupSettingsStay({ song: 6, content: "ready" }, 7), true);
});
