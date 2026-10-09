import { useId, type CSSProperties } from "react";
import "./Slider.css";

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Marked on the track. A double-click, or the value readout, returns here. */
  defaultValue?: number;
  /** Where the filled part starts; `min` unless the value is an offset to either side. */
  origin?: number;
  format?(value: number): string;
  disabled?: boolean;
  className?: string;
  onChange(value: number): void;
}

/**
 * One parameter on one row: its name, a track and the current value. Built on the app-wide
 * range style (design.css), so it is the same quiet track and round handle as everywhere else.
 */
export function Slider({ label, value, min, max, step = 1, defaultValue, origin = min, format = String,
  disabled = false, className, onChange }: SliderProps) {
  const id = useId();
  const span = max - min || 1;
  const at = (input: number) => Math.max(0, Math.min(1, (input - min) / span));
  const here = at(value), from = at(origin);
  const changed = defaultValue !== undefined && Math.abs(value - defaultValue) > step / 1000;
  const reset = () => { if (defaultValue !== undefined && changed && !disabled) onChange(defaultValue); };
  const text = format(value);
  const style = {
    "--kd-slider-lo": Math.min(from, here), "--kd-slider-hi": Math.max(from, here),
    ...(defaultValue !== undefined ? { "--kd-slider-default": at(defaultValue) } : {}),
  } as CSSProperties;
  return <div className={`kd-slider${className ? ` ${className}` : ""}`} data-changed={changed || undefined}>
    <label className="kd-slider-label" htmlFor={id}>{label}</label>
    <span className="kd-slider-rail" style={style}>
      {defaultValue !== undefined && <i className="kd-slider-mark" aria-hidden="true" />}
      <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        aria-valuetext={text} onChange={event => onChange(Number(event.currentTarget.value))} onDoubleClick={reset} />
    </span>
    {defaultValue === undefined ? <output className="kd-slider-value" htmlFor={id}>{text}</output>
      : <button type="button" className="kd-slider-value" disabled={disabled || !changed}
        aria-label={`${label}恢复默认`} title="恢复默认" onClick={reset}>{text}</button>}
  </div>;
}
