/**
 * The work rail's turn, as bookkeeping only: which items are on the strip, which are being
 * taken away and which are waiting to be laid out. `WorkRail.tsx` draws the slots and moves
 * from one stage to the next when the gesture of a stage has ended; `motion.css` (`turn`) is
 * the gesture itself.
 *
 * The strip stays, its content turns over:
 *
 * 1. `out`  — every item whose key is not wanted any more leaves, the last one first, one
 *             step apart. It is a picture from here on (the rail draws it inert). Items that
 *             are wanted before and after stay where they are, and items that are new wait.
 * 2. `in`   — the pictures are gone and the wanted items are laid out in their order: the new
 *             ones arrive, the first one first; the ones that stayed only close up.
 * 3. `rest` — nothing carries a mark.
 *
 * A change that arrives during a turn joins it: what is no longer wanted starts to leave at
 * once (also an item that was still arriving), what is wanted waits for the pictures. A key
 * that leaves and is wanted again is a new slot — its old picture finishes leaving first.
 * An item whose key is the same before and after is never touched, whatever its content: a
 * count or a file name that changes is the same item with other text, not a turn.
 */

export type RailStage = "rest" | "out" | "in";
/** `wait`: mounted but held off the strip until the pictures have gone (see `adoptRail`). */
export type RailPhase = "stay" | "in" | "out" | "wait";

export interface RailSlot {
  /** React identity. A key that comes back is another slot than its leaving picture. */
  id: number;
  key: string;
  phase: RailPhase;
  /** Its place in the cascade it is part of: leaving counts from the end, arriving from the start. */
  step: number;
}

export interface RailTurn {
  slots: RailSlot[];
  /** The order that is laid out when the pictures are gone; null when the strip shows what is wanted. */
  waiting: string[] | null;
  stage: RailStage;
  /** Counts the stages begun. The rail waits for the gesture of one beat only. */
  beat: number;
  nextId: number;
}

/**
 * Later items start with this one: a long strip turns as fast as a short one, and a full turn
 * (everything out, everything in) stays under 450 ms on the schema's clock.
 */
export const RAIL_TURN_STEPS = 3;

const step = (index: number) => Math.min(index, RAIL_TURN_STEPS);

/** An empty strip on which `keys` are about to be laid out. */
export function startRail(keys: readonly string[]): RailTurn {
  return { slots: [], waiting: [...keys], stage: "out", beat: 0, nextId: 0 };
}

/** What the strip shows once the turn has ended. */
export function railTarget(turn: RailTurn): string[] {
  return turn.waiting ?? turn.slots.filter((slot) => slot.phase !== "out").map((slot) => slot.key);
}

export function sameRailKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/** Marks `leaving` (in strip order) as pictures that go, the last one first. */
function leave(slots: RailSlot[], leaving: ReadonlySet<number>): RailSlot[] {
  let index = leaving.size;
  return slots.map((slot) => {
    if (!leaving.has(slot.id)) return slot;
    index -= 1;
    return { ...slot, phase: "out", step: step(index) };
  });
}

/** `keys` are wanted now. Nothing changes when they already are. */
export function turnRail(turn: RailTurn, keys: readonly string[]): RailTurn {
  if (sameRailKeys(railTarget(turn), keys)) return turn;
  const wanted = new Set(keys);
  // One that was never laid out has no picture to leave: it is simply dropped.
  const slots = turn.slots.filter((slot) => slot.phase !== "wait" || wanted.has(slot.key));
  const leaving = new Set(
    slots.filter((slot) => slot.phase !== "out" && !wanted.has(slot.key)).map((slot) => slot.id),
  );
  return {
    ...turn,
    slots: leave(slots, leaving),
    waiting: [...keys],
    stage: "out",
    beat: turn.beat + 1,
  };
}

/**
 * The strip is handed to this rail by another one, whose items (`pictures`, in strip order)
 * leave here; then this rail's own items are laid out — all of them, as the strip is new to
 * them. The ones it already holds stay mounted (a field keeps its state) but wait off the strip.
 */
export function adoptRail(turn: RailTurn, pictures: readonly string[]): RailTurn {
  const taken = pictures.map((key, index): RailSlot => ({
    id: turn.nextId + index,
    key,
    phase: "out",
    step: step(pictures.length - 1 - index),
  }));
  // Pictures that are already leaving here go on leaving (taking over twice changes nothing).
  const leaving = turn.slots.filter((slot) => slot.phase === "out");
  const held = turn.slots
    .filter((slot) => slot.phase !== "out")
    .map((slot): RailSlot => ({ ...slot, phase: "wait", step: 0 }));
  return {
    slots: [...leaving, ...taken, ...held],
    waiting: railTarget(turn),
    stage: "out",
    beat: turn.beat + 1,
    nextId: turn.nextId + pictures.length,
  };
}

/** The leaving gesture has ended: the pictures go and what is wanted is laid out. */
export function clearRail(turn: RailTurn): RailTurn {
  if (turn.stage !== "out") return turn;
  const kept = new Map(turn.slots.filter((slot) => slot.phase !== "out").map((slot) => [slot.key, slot]));
  const keys = turn.waiting ?? [...kept.keys()];
  let nextId = turn.nextId;
  let arriving = 0;
  const slots = keys.map((key): RailSlot => {
    const slot = kept.get(key);
    // One that was still arriving when the turn began goes on arriving; its mark is not restarted.
    if (slot && slot.phase !== "wait") return slot;
    const arrived: RailSlot = { id: slot?.id ?? nextId, key, phase: "in", step: step(arriving) };
    if (!slot) nextId += 1;
    arriving += 1;
    return arrived;
  });
  const moving = slots.some((slot) => slot.phase === "in");
  return { slots, waiting: null, stage: moving ? "in" : "rest", beat: turn.beat + 1, nextId };
}

/** The arriving gesture has ended: nothing carries a mark any more. */
export function settleRail(turn: RailTurn): RailTurn {
  if (turn.stage !== "in") return turn;
  return {
    ...turn,
    slots: turn.slots.map((slot) => (slot.phase === "in" ? { ...slot, phase: "stay", step: 0 } : slot)),
    stage: "rest",
    beat: turn.beat + 1,
  };
}
