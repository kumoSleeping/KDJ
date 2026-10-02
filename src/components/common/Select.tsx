import { Fragment, useId, useLayoutEffect, useRef, useState, type SelectHTMLAttributes } from "react";
import { Check, ChevronDown } from "lucide-react";
import { ContextMenu } from "./ContextMenu";

type SelectProps = Pick<SelectHTMLAttributes<HTMLSelectElement>,
  "children" | "value" | "defaultValue" | "onChange" | "disabled" | "className" | "style" |
  "id" | "name" | "title" | "autoFocus" | "tabIndex" | "aria-label" | "aria-labelledby" | "aria-describedby"
> & { "data-size"?: string };

interface Option {
  value: string;
  label: string;
  disabled: boolean;
  selected: boolean;
  group: string;
  groupIndex: number;
}

/** Native options/change events remain the data contract; the visible UI uses ContextMenu. */
export function Select({ children, value, defaultValue, onChange, disabled, className, style,
  id, name, title, autoFocus, tabIndex, ...accessibility }: SelectProps) {
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const [options, setOptions] = useState<Option[]>([]);
  const [anchor, setAnchor] = useState<{ x: number; y: number; top: number; width: number; focus: "selected" | "first" | "last" } | null>(null);

  // Read the rendered options, including optgroups and options supplied by child components.
  useLayoutEffect(() => {
    const select = native.current;
    if (!select) return;
    const groups = Array.from(select.querySelectorAll("optgroup"));
    const next = Array.from(select.options).map(option => {
      const group = option.parentElement?.tagName === "OPTGROUP" ? option.parentElement as HTMLOptGroupElement : null;
      return { value: option.value, label: option.label, selected: option.selected,
        disabled: option.disabled || !!group?.disabled, group: group?.label ?? "", groupIndex: group ? groups.indexOf(group) : -1 };
    });
    setOptions(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    if (select.matches(":disabled") || !next.length) setAnchor(null);
  });

  const open = (focus: "selected" | "first" | "last" = "selected") => {
    if (trigger.current?.matches(":disabled") || !options.length) return;
    const rect = trigger.current!.getBoundingClientRect();
    trigger.current!.focus({ preventScroll: true });
    setAnchor({ x: rect.left, y: rect.bottom + 4, top: rect.top, width: rect.width, focus });
  };
  const choose = (index: number) => {
    const select = native.current;
    if (!select || select.matches(":disabled") || options[index].disabled) return;
    setAnchor(null);
    trigger.current?.focus({ preventScroll: true });
    if (select.selectedIndex === index) return;
    select.selectedIndex = index;
    // Dispatch synchronously so existing handlers keep genuine target/currentTarget semantics.
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  return <>
    <button {...accessibility} ref={trigger} id={id ?? uid} type="button" title={title}
      className={["kd-select-control", className].filter(Boolean).join(" ")} style={style}
      disabled={disabled} autoFocus={autoFocus} tabIndex={tabIndex}
      aria-haspopup="menu" aria-expanded={!!anchor} aria-controls={anchor ? `${uid}-menu` : undefined}
      onClick={() => anchor ? setAnchor(null) : open()}
      onKeyDown={event => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          open(event.key === "Home" ? "first" : event.key === "End" ? "last" : "selected");
        }
      }}>
      <span className="kd-select-value">{options.find(option => option.selected)?.label ?? ""}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    <select ref={native} hidden aria-hidden="true" tabIndex={-1} name={name}
      value={value} defaultValue={defaultValue} disabled={disabled} onChange={onChange}>
      {children}
    </select>
    {anchor && <ContextMenu id={`${uid}-menu`} label={accessibility["aria-label"]}
      x={anchor.x} y={anchor.y} anchorTop={anchor.top} minWidth={anchor.width} initialFocus={anchor.focus}
      keepOpen={`[id="${id ?? uid}"]`} onClose={() => setAnchor(null)} className="kd-select-menu">
      {options.map((option, index) => <Fragment key={`${option.value}-${index}`}>
        {option.groupIndex >= 0 && option.groupIndex !== options[index - 1]?.groupIndex &&
          <div className="kd-menu-heading" role="presentation">{option.group}</div>}
        <button type="button" role="menuitemradio" aria-checked={option.selected}
          aria-describedby={option.groupIndex >= 0 ? `${uid}-group-${index}` : undefined}
          disabled={option.disabled} onClick={() => choose(index)}>
          <span className="kd-menu-check" aria-hidden="true">{option.selected && <Check size={13} />}</span>
          <span className="kd-menu-label">{option.label}</span>
          {option.groupIndex >= 0 && <span hidden id={`${uid}-group-${index}`}>{option.group}</span>}
        </button>
      </Fragment>)}
    </ContextMenu>}
  </>;
}
