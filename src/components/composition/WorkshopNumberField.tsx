import { useEffect, useRef, useState } from "react";
export function NumberField({
  label,
  value,
  min,
  max,
  step = 0.001,
  onChange,
  onCommit,
  suffix = "",
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange(v: number): void;
  onCommit?(): void;
  suffix?: string;
}) {
  const [text, setText] = useState(String(Math.round(value * 1000) / 1000));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(Math.round(value * 1000) / 1000));
  }, [value]);
  return (
    <label className="vj-number">
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        value={text}
        min={min}
        max={max}
        step={step}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (
            e.target.value !== "" &&
            Number.isFinite(n) &&
            (min === undefined || n >= min) &&
            (max === undefined || n <= max)
          )
            onChange(n);
        }}
        onBlur={() => {
          focused.current = false;
          setText(String(Math.round(value * 1000) / 1000));
          onCommit?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          e.stopPropagation();
        }}
      />
      {suffix && <small>{suffix}</small>}
    </label>
  );
}
