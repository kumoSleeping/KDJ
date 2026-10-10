import assert from "node:assert/strict";
import test from "node:test";
import {
  LYRICS_FOLLOWING,
  LYRICS_FOLLOW_PAUSE_MS,
  LYRICS_JUMP_TRAVEL,
  LYRICS_SEEK_WAIT_MS,
  LYRICS_STAGGER_LINES,
  LYRICS_STAGGER_MS,
  centredScrollTop,
  followAfterScroll,
  followAfterSeek,
  followAfterTouch,
  followResumesIn,
  followSettled,
  followedLine,
  followsNow,
  glideDelay,
  glideKind,
  planGlide,
  type LyricsLayout,
} from "../src/lib/lyricsGlide";

/** Twenty lines of 60 px in a column 300 px tall, with half the column above and below. */
const layout: LyricsLayout = {
  tops: Array.from({ length: 20 }, (_, index) => 150 - 30 + index * 60),
  heights: Array.from({ length: 20 }, () => 60),
  viewport: 300,
  maxScroll: 120 + 20 * 60 + 120 - 300,
};
const atRest = () => 0;

test("the sung line rests on the centre line, the first and the last included", () => {
  assert.equal(centredScrollTop(layout, 0), 0, "the room above lets the first line reach the centre");
  assert.equal(centredScrollTop(layout, 5), 300);
  assert.equal(centredScrollTop(layout, 19), layout.maxScroll);
  assert.equal(centredScrollTop(layout, -1), 0, "before the first line the column waits at its top");
  assert.equal(centredScrollTop(layout, 20), null);
  assert.equal(centredScrollTop({ tops: [], heights: [], viewport: 300, maxScroll: 0 }, -1), null);
  assert.equal(followedLine(4, 4), 4);
  assert.equal(followedLine(-1, 4), 4, "between two lines the one sung last keeps the centre");
  assert.equal(followedLine(-1, -1), -1);
});

test("a change nearby is a glide, one further than the column is tall a jump", () => {
  assert.equal(glideKind(0.4, 300), "none");
  assert.equal(glideKind(60, 300), "glide");
  assert.equal(glideKind(-300, 300), "glide");
  assert.equal(glideKind(301, 300), "jump");
  assert.equal(glideKind(-900, 300), "jump");
});

test("the lines the column leaves behind trail it, a few ms apart", () => {
  // The usual way, up: the lines below the sung one follow it.
  assert.equal(glideDelay(4, 5, 60), 0);
  assert.equal(glideDelay(5, 5, 60), 0);
  assert.equal(glideDelay(6, 5, 60), LYRICS_STAGGER_MS);
  assert.equal(glideDelay(8, 5, 60), 3 * LYRICS_STAGGER_MS);
  assert.equal(glideDelay(15, 5, 60), LYRICS_STAGGER_LINES * LYRICS_STAGGER_MS, "a long column arrives as fast");
  // Back down: the lines above trail, the ones below lead, so none runs into the next.
  assert.equal(glideDelay(6, 5, -60), 0);
  assert.equal(glideDelay(4, 5, -60), LYRICS_STAGGER_MS);
});

test("a glide moves the lines on screen from where they were", () => {
  const from = centredScrollTop(layout, 5)!, to = centredScrollTop(layout, 6)!;
  const plan = planGlide(layout, from, to, 6, atRest);
  assert.ok(plan.length > 0 && plan.length < layout.tops.length, "lines far off screen take no part");
  for (const move of plan) assert.equal(move.from, 60, "each starts where it was: the distance the column jumped");
  assert.equal(plan.find(move => move.index === 6)!.delay, 0);
  assert.equal(plan.find(move => move.index === 8)!.delay, 2 * LYRICS_STAGGER_MS);
  assert.deepEqual(planGlide(layout, from, from, 5, atRest), []);
});

test("a glide that is interrupted starts again from where each line has got to", () => {
  const from = centredScrollTop(layout, 6)!, to = centredScrollTop(layout, 7)!;
  // Line 7 still had 22 px to go, line 8 had not set off (60), the others had arrived.
  const left = (index: number) => index === 7 ? 22 : index === 8 ? 60 : 0;
  const plan = planGlide(layout, from, to, 7, left);
  assert.equal(plan.find(move => move.index === 6)!.from, 60);
  assert.equal(plan.find(move => move.index === 7)!.from, 82);
  assert.equal(plan.find(move => move.index === 8)!.from, 120);
});

test("a jump is not ridden out", () => {
  const plan = planGlide(layout, centredScrollTop(layout, 1)!, centredScrollTop(layout, 15)!, 15, () => 500);
  assert.ok(plan.length > 0);
  for (const move of plan) {
    assert.equal(move.from, LYRICS_JUMP_TRAVEL, "a short way, whatever was left of an earlier glide");
    assert.equal(move.delay, 0);
    assert.ok(Math.abs(move.index - 15) <= 6, "only what the jump lands on moves");
  }
  const back = planGlide(layout, centredScrollTop(layout, 15)!, centredScrollTop(layout, 1)!, 1, atRest);
  assert.equal(back[0]!.from, -LYRICS_JUMP_TRAVEL);
});

test("the listener's own scroll pauses the column, and it returns after a while", () => {
  let follow = LYRICS_FOLLOWING;
  assert.equal(followsNow(follow, 3, 1_000), true);
  assert.equal(followResumesIn(follow, 3, 1_000), null);
  follow = followAfterScroll(follow, 1_000);
  assert.equal(followsNow(follow, 4, 1_500), false, "the song goes on; the column stays where it was put");
  assert.equal(followResumesIn(follow, 4, 1_500), LYRICS_FOLLOW_PAUSE_MS - 500);
  // More scrolling starts the pause over.
  follow = followAfterScroll(follow, 2_000);
  assert.equal(followsNow(follow, 4, 1_000 + LYRICS_FOLLOW_PAUSE_MS), false);
  assert.equal(followsNow(follow, 4, 2_000 + LYRICS_FOLLOW_PAUSE_MS), true);
});

test("a finger on the column holds it; the pause counts from when it lifts", () => {
  let follow = followAfterTouch(LYRICS_FOLLOWING, true, 1_000);
  assert.equal(followsNow(follow, 2, 60_000), false, "however long it rests there");
  assert.equal(followResumesIn(follow, 2, 60_000), null, "its lifting asks again");
  follow = followAfterTouch(follow, false, 61_000);
  assert.equal(followsNow(follow, 2, 61_500), false);
  assert.equal(followsNow(follow, 2, 61_000 + LYRICS_FOLLOW_PAUSE_MS), true);
});

test("a click on a line holds the column until the seek has landed there", () => {
  // The listener scrolled to find the line, then clicked it: the pause is over.
  let follow = followAfterSeek(followAfterScroll(LYRICS_FOLLOWING, 1_000), 9, 1_200);
  assert.equal(followsNow(follow, 4, 1_250), false, "not back to the line that was being sung");
  assert.equal(followResumesIn(follow, 4, 1_250), LYRICS_SEEK_WAIT_MS - 50);
  assert.equal(followsNow(follow, 9, 1_300), true, "the player got there: the clicked line goes to the centre");
  follow = followSettled(follow, 9, 1_300);
  assert.equal(follow.seek, null);
  assert.equal(followsNow(follow, 10, 1_400), true);
  // A seek that never lands (the player refused) is not waited for for ever.
  follow = followAfterSeek(LYRICS_FOLLOWING, 9, 5_000);
  assert.equal(followsNow(follow, 4, 5_000 + LYRICS_SEEK_WAIT_MS), true);
  assert.equal(followSettled(follow, 4, 5_000 + LYRICS_SEEK_WAIT_MS).seek, null);
  assert.equal(followSettled(follow, 4, 5_100), follow);
});
