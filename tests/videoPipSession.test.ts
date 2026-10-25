import assert from "node:assert/strict";
import test from "node:test";
import { useVideoPip, type VideoPipSession } from "../src/lib/videoPip";

const preview = (bvid: string): VideoPipSession => ({
  source: "network", platform: "bilibili", bvid, page: 0, title: "t", author: "a",
});

test("opening the video already on screen keeps its duration, place and play state; another video starts from nothing", () => {
  const pip = useVideoPip.getState();
  pip.setSession(preview("BV1ue411P7XK"));
  pip.setDuration(152.8);
  pip.setPosition(40);
  pip.setPlaying(true);

  // The same search result clicked again: the host does not load it again.
  pip.setSession(preview("BV1ue411P7XK"));
  assert.deepEqual(
    (({ duration, position, playing }) => ({ duration, position, playing }))(useVideoPip.getState()),
    { duration: 152.8, position: 40, playing: true },
  );

  pip.setSession(preview("BV1Pe411V7K4"));
  assert.deepEqual(
    (({ duration, position, playing }) => ({ duration, position, playing }))(useVideoPip.getState()),
    { duration: 0, position: 0, playing: false },
  );

  // After the window was closed the host let the source go; opening it again loads it anew.
  pip.setDuration(67);
  pip.clear();
  pip.setSession(preview("BV1Pe411V7K4"));
  assert.equal(useVideoPip.getState().duration, 0);
});
