import assert from "node:assert/strict";
import test from "node:test";
import { DJ_TRACK_TABLE_COLUMN_WIDTHS, fitDjTrackColumns } from "../src/lib/djTableLayout";
import { beginColumnPointerReorder } from "../src/lib/tableColumnPrefs";
import { cycleTableSort } from "../src/lib/tableSort";

test("DJ track table keeps performance columns inside one fixed-width row", () => {
  const columns = ["title", "artist", "album", "bpm", "camelot", "energy", "duration", "format", "rating"]
    .map((key) => ({ key }));
  assert.deepEqual(
    fitDjTrackColumns(columns).map((column) => column.key),
    ["title", "artist", "bpm", "camelot", "duration"],
  );
  const allocated = Object.values(DJ_TRACK_TABLE_COLUMN_WIDTHS)
    .reduce((sum, width) => sum + Number.parseFloat(width), 0);
  assert.equal(allocated, 90, "the fixed index column owns the remaining 10%");
});

test("track table sorting releases to source order and preserves secondary promotion", () => {
  const source = { sort: "custom", order: "asc", sort2: null, order2: "asc" } as const;
  const ascending = cycleTableSort(source, "bpm", "custom", "asc");
  assert.deepEqual(ascending, { ...source, sort: "bpm" });
  const descending = cycleTableSort(ascending, "bpm", "custom", "asc");
  assert.equal(descending.order, "desc");
  assert.deepEqual(cycleTableSort(descending, "bpm", "custom", "asc"), source);

  const withSecondary = cycleTableSort(ascending, "key", "custom", "asc");
  assert.equal(withSecondary.sort, "bpm");
  assert.equal(withSecondary.sort2, "key");
  assert.deepEqual(cycleTableSort(withSecondary, "key", "custom", "asc"), {
    sort: "key",
    order: "asc",
    sort2: "bpm",
    order2: "asc",
  });
});

test("a canceled column drag still consumes the synthetic sort click", () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const events = new EventTarget();
  const body = {
    dataset: {} as Record<string, string>,
    removeAttribute(name: string) {
      if (name === "data-kd-col-dragging") delete this.dataset.kdColDragging;
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: events,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body,
      elementFromPoint: () => null,
    },
  });

  const pointerEvent = (type: string, clientX: number, clientY: number) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: clientX },
      clientY: { value: clientY },
    });
    return event;
  };

  let consumedClicks = 0;
  let moves = 0;
  let ended = 0;
  try {
    beginColumnPointerReorder(
      { button: 0, clientX: 10, clientY: 10 },
      "title",
      ["title", "artist"],
      {
        onStart: () => undefined,
        onOver: () => undefined,
        onMove: () => {
          moves += 1;
        },
        onEnd: () => {
          ended += 1;
        },
        onDragged: () => {
          consumedClicks += 1;
        },
      },
    );

    events.dispatchEvent(pointerEvent("pointermove", 20, 10));
    assert.equal(consumedClicks, 0, "click suppression must stay armed until pointerup");
    events.dispatchEvent(pointerEvent("pointerup", 20, 10));
    assert.equal(consumedClicks, 1, "an activated drag consumes the following click");
    assert.equal(moves, 0, "releasing outside a valid target does not reorder columns");
    assert.equal(ended, 1);
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }
});
