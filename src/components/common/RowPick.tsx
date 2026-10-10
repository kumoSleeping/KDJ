import { useRef, type MouseEvent, type ReactNode } from "react";
import "./RowPick.css";

/** None of what the mark stands for is picked, a part of it, or all of it. */
export type PickState = "none" | "some" | "all";

/**
 * The selection mark of the lists: a small ring that fills with ink and takes a tick when its
 * row is picked. One drawing for a row, for the head of a column (all / some / none) and for
 * the work rail's glyph, so "picked" is written the same way everywhere.
 *
 * This is the picture alone; `RowPick` is the control.
 */
export function PickMark({ state }: { state: PickState }) {
  return (
    <span className="kd-pick" data-state={state} aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <path className="kd-pick-tick" d="M4.6 8.3 7 10.6 11.5 5.7" />
        <path className="kd-pick-dash" d="M5 8h6" />
      </svg>
    </span>
  );
}

export interface RowPickProps {
  state: PickState;
  /** What the control picks, read out with its state. */
  label: string;
  onToggle(event: MouseEvent<HTMLButtonElement>): void;
  disabled?: boolean;
  /** A row that can be focused itself keeps its mark out of the tab order. */
  tabbable?: boolean;
  className?: string;
}

/**
 * The mark as a control. A click on it never reaches its row: the row has its own click, and
 * the two would undo each other.
 */
export function RowPick({ state, label, onToggle, disabled = false, tabbable = true, className }: RowPickProps) {
  return (
    <button
      type="button"
      role="checkbox"
      className={className ? `kd-pick-control ${className}` : "kd-pick-control"}
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      aria-label={label}
      disabled={disabled}
      tabIndex={tabbable ? 0 : -1}
      draggable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(event);
      }}
    >
      <PickMark state={state} />
    </button>
  );
}

/**
 * What a row's index cell holds: its number, and while rows are being picked the mark in the
 * number's place. Both lie in the same spot of the cell, so nothing of the row moves when the
 * one gives way to the other; `pick` is null for a row that cannot be picked, which keeps its
 * number.
 */
export function RowIndex({ number, picking, pick }: {
  number: ReactNode;
  /** Rows are being picked: the number steps back. */
  picking: boolean;
  pick: ReactNode;
}) {
  // The mark pops in when picking starts under a row that was already there. A row built while
  // rows are being picked (scrolled in, another page of results) has its mark from the start.
  const seenIdle = useRef(!picking);
  if (!picking) seenIdle.current = true;
  const shown = picking && Boolean(pick);
  return (
    <span
      className="kd-row-index"
      data-picking={shown ? "true" : undefined}
      data-pop={shown && seenIdle.current ? "true" : undefined}
    >
      <span className="kd-row-number">{number}</span>
      {shown ? pick : null}
    </span>
  );
}
