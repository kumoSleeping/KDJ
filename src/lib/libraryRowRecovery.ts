import { flushSync } from "react-dom";
import { tracePlayback } from "./playbackTrace";

const COMMIT_BUDGET_MS = 3;
const MAX_ROWS_PER_FRAME = 4;
const MAX_REMEMBERED_ROWS = 50_000;

interface RecoveryViewport {
  first: number;
  end: number;
  moving: boolean;
  visible: boolean;
}
interface WaitingRow {
  index: number;
  available: boolean;
  fresh: boolean;
  admit(): void;
  element(): HTMLElement | null;
}

/** One owner per table. A slot keeps its number while its expensive cells wait for a turn. */
export interface LibraryRowRecovery {
  deferred(): boolean;
  seen(id: number): boolean;
  remember(id: number): void;
  enqueue(row: WaitingRow): () => void;
  hold(direction?: -1 | 1): void;
  resume(direction?: -1 | 1): void;
  destroy(): void;
}

/**
 * This is a commit budget, not an animation delay. Only the admitted rows update; the table,
 * its index and already readable rows do not render again for each batch. The next frame reads
 * the viewport anew, so a reversal reprioritizes work and unmounting cancels it altogether.
 */
export function createLibraryRowRecovery(
  viewport: () => RecoveryViewport,
  reveal: (rows: HTMLElement[], direction: -1 | 1) => void,
  settled: () => void,
): LibraryRowRecovery {
  const waiting = new Set<WaitingRow>();
  const seen = new Set<number>();
  let held = false;
  let deferred = false;
  let direction: -1 | 1 = 1;
  let frame = 0;
  let costPerRow = 1;
  let stats = { rows: 0, batches: 0, ms: 0, max: 0 };

  const finish = () => {
    const wasDeferred = deferred;
    deferred = false;
    if (wasDeferred) settled();
    if (import.meta.env.DEV && stats.rows) tracePlayback("library-row-recovery", {
      rows: stats.rows, batches: stats.batches, commitMs: Math.round(stats.ms), commitMax: Math.round(stats.max * 10) / 10,
    });
    stats = { rows: 0, batches: 0, ms: 0, max: 0 };
  };
  const schedule = () => {
    if (!held && !frame && waiting.size) frame = requestAnimationFrame(run);
  };
  const run = () => {
    frame = 0;
    if (held) return;
    const view = viewport();
    if (!view.visible) return;
    const screen = Math.max(1, view.end - view.first);
    const inView = (row: WaitingRow) => row.index >= view.first && row.index < view.end;
    const ahead = (row: WaitingRow) => direction > 0 ? row.index >= view.end : row.index < view.first;
    const distance = (row: WaitingRow) => row.index < view.first ? view.first - row.index : Math.max(0, row.index - view.end + 1);
    const candidates = [...waiting].filter(row => row.available && (inView(row) || !view.moving || (ahead(row) && distance(row) <= screen)));
    candidates.sort((a, b) => Number(!inView(a)) - Number(!inView(b))
      || (inView(a) && inView(b) ? direction * (a.index - b.index) : distance(a) - distance(b)));
    // During the tail of a fling, leave the far overscan alone. A scroll or its rest callback
    // wakes it again. Never keep an RAF loop alive just waiting for data or an idle viewport.
    if (!candidates.length) return;
    const batch = candidates.slice(0, Math.max(1, Math.min(MAX_ROWS_PER_FRAME, Math.floor(COMMIT_BUDGET_MS / costPerRow))));
    for (const row of batch) waiting.delete(row);
    const began = performance.now();
    flushSync(() => { for (const row of batch) row.admit(); });
    const spent = performance.now() - began;
    costPerRow = Math.max(0.25, costPerRow * 0.5 + spent / batch.length * 0.5);
    stats.rows += batch.length;
    stats.batches += 1;
    stats.ms += spent;
    stats.max = Math.max(stats.max, spent);
    // Content starts its own full gesture only after it exists; a late data response never
    // inherits an already expired animation. Numbers are outside the animated contents.
    reveal(batch.filter(row => row.fresh && inView(row)).flatMap(row => {
      const element = row.element();
      return element?.isConnected ? [element] : [];
    }), direction);
    if (!waiting.size) finish();
    else schedule();
  };

  return {
    deferred: () => deferred,
    seen: id => seen.has(id),
    remember(id) {
      seen.delete(id);
      seen.add(id);
      const oldest = seen.values().next().value;
      if (seen.size > MAX_REMEMBERED_ROWS && oldest !== undefined) seen.delete(oldest);
    },
    enqueue(row) {
      waiting.add(row);
      schedule();
      return () => {
        waiting.delete(row);
        if (!waiting.size && frame) { cancelAnimationFrame(frame); frame = 0; }
      };
    },
    hold(nextDirection) {
      if (nextDirection) direction = nextDirection;
      held = true;
      deferred = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
    resume(nextDirection) {
      if (nextDirection) direction = nextDirection;
      held = false;
      if (!waiting.size) finish();
      else schedule();
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      waiting.clear();
      seen.clear();
      held = false;
      deferred = false;
      stats = { rows: 0, batches: 0, ms: 0, max: 0 };
    },
  };
}
