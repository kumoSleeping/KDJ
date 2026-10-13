import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { createListArrival, type ListArrival } from "../common/listArrival";
import { listScrollsItself, rowListPadding, useRowList } from "../common/rowList";
import { QueueList } from "./QueuePrimitives";

/** Only viewport state survives a page switch, not its DOM or its row subscriptions. */
export interface QueueListPosition {
  offset?: number;
  measurements?: VirtualItem[];
}

/** Task rows use the same bounded window and presentation gesture as the workspace lists. */
export function QueueTaskList({ count, getKey, children, position, empty }: {
  count: number;
  /** What an empty list shows, in place of rows: a picture that does not stretch to the list. */
  empty?: ReactNode;
  getKey(index: number): string;
  children(index: number): ReactNode;
  position: QueueListPosition;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const initial = useRef({ offset: position.offset ?? 0, measurements: position.measurements });
  const [own] = useState(listScrollsItself);
  const screenRows = useRef(8);
  const { virtualizer } = useRowList({
    scrollerRef: scroller, count, getKey, rowHeight: 80, headHeight: 0,
    screenRows: screenRows.current, measured: true, own, windowed: true,
    initialOffset: initial.current.offset, initialMeasurementsCache: initial.current.measurements,
  });
  screenRows.current = Math.max(1, Math.ceil((virtualizer.scrollRect?.height ?? 640) / 80));
  const items = virtualizer.getVirtualItems();
  const elements = useRef(new Map<string, HTMLElement>());
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    scroller.current = node;
    // The body's padding already holds the whole list. Restore before the virtualizer's
    // offset observer attaches, so the first rows built are the ones the listener left.
    if (node) node.scrollTop = initial.current.offset;
  }, []);
  const register = useCallback((node: HTMLDivElement) => {
    virtualizer.measureElement(node);
    const key = node.dataset.queueKey!;
    const row = node.firstElementChild;
    if (row instanceof HTMLElement) elements.current.set(key, row);
    return () => { if (elements.current.get(key) === row) elements.current.delete(key); };
  }, [virtualizer]);
  useLayoutEffect(() => {
    const node = scroller.current;
    return () => {
      if (node) position.offset = node.scrollTop;
      position.measurements = virtualizer.takeSnapshot();
    };
  }, [position, virtualizer]);

  const arrival = useRef<ListArrival | null>(null);
  const presented = useRef(false);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const current = createListArrival(node);
    arrival.current = current;
    return () => { current.stop(); arrival.current = null; };
  }, []);
  useLayoutEffect(() => {
    if (!count) { presented.current = false; return; }
    if (presented.current) return;
    const top = virtualizer.scrollOffset ?? 0;
    const bottom = top + (virtualizer.scrollRect?.height ?? 0);
    if (bottom <= top) return;
    const rows = items.filter(item => item.end > top && item.start < bottom)
      .map(item => elements.current.get(String(item.key)));
    if (!rows.some(Boolean)) return;
    arrival.current?.present(rows);
    presented.current = true;
  });

  return <QueueList ref={attachScroller}>
    {!count && empty && <div className="kd-queue-empty">{empty}</div>}
    <div style={rowListPadding(items, virtualizer.getTotalSize(), 0)}>
      {items.map(item => <div key={item.key} data-index={item.index} data-queue-key={item.key} ref={register}>
        {children(item.index)}
      </div>)}
    </div>
  </QueueList>;
}
