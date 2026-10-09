import { useRef, type KeyboardEvent, type ReactNode } from "react";
import "./Segmented.css";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** Accessible name when the label is an icon. */
  name?: string;
}

/** A few exclusive choices side by side. The chosen one changes ink only. */
export function Segmented<T extends string | number>({ label, options, value, disabled = false, className, onChange }: {
  label: string; options: readonly SegmentedOption<T>[]; value: T; disabled?: boolean; className?: string;
  onChange(value: T): void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = options.findIndex(option => option.value === value);
    const next = ["ArrowRight", "ArrowDown"].includes(event.key) ? at + 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? at - 1
      : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
    if (next === null || disabled) return;
    event.preventDefault(); event.stopPropagation();
    const index = (next + options.length) % options.length;
    onChange(options[index].value);
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[index]?.focus({ preventScroll: true });
  };
  return <div ref={group} className={`kd-segmented${className ? ` ${className}` : ""}`} role="radiogroup" aria-label={label} onKeyDown={move}>
    {options.map(option => <button key={String(option.value)} type="button" role="radio" aria-checked={option.value === value}
      aria-label={option.name} title={option.name} tabIndex={option.value === value ? 0 : -1} disabled={disabled}
      onClick={() => { if (option.value !== value) onChange(option.value); }}>{option.label}</button>)}
  </div>;
}
