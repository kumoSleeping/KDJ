import { useEffect, useId, useLayoutEffect, useState, type KeyboardEvent, type RefObject } from "react";
import { ContextMenu } from "../common/ContextMenu";
import { buildSearchSuggestions } from "../../lib/searchSuggestions";
import type { TrackSummary } from "../../types";
import "./SearchPresets.css";

/** Track suggestions edit the query; submission stays with SearchBar. */
export function useSearchPresets({ query, onQueryChange, track, playingTrack, inputRef }: {
  query: string;
  onQueryChange(value: string): void;
  track?: TrackSummary | null;
  playingTrack?: TrackSummary | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0, anchorTop: 0 });
  const listId = useId();
  const inputId = useId();
  const match = query.slice(0, caret).match(/(?:^|\s)@([^@\n]*)$/);
  const start = match ? caret - match[1].length - 1 : -1;
  const candidates = buildSearchSuggestions(track, playingTrack)
    .filter(item => item.label.toLocaleLowerCase().includes((match?.[1] || "").toLocaleLowerCase()));
  const open = enabled && start >= 0 && candidates.length > 0;
  const selected = Math.min(active, Math.max(0, candidates.length - 1));

  const syncCaret = () => {
    const input = inputRef.current;
    if (!input) return;
    setCaret(input.selectionStart);
    setEnabled(input.selectionStart === input.selectionEnd);
    setActive(0);
  };

  const choose = (index: number) => {
    const item = candidates[index];
    if (!item || start < 0) return;
    const before = query.slice(0, start);
    const after = query.slice(caret);
    const insertion = `${item.label} `;
    onQueryChange(`${before}${insertion}${after}`);
    setEnabled(false);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.focus();
      input?.setSelectionRange(before.length + insertion.length, before.length + insertion.length);
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ x: rect.left, y: rect.bottom + 4, anchorTop: rect.top });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, inputRef]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, selected, listId]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setEnabled(false);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (candidates.length) setActive((selected + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && candidates.length) {
      event.preventDefault();
      choose(selected);
      return true;
    }
    return false;
  };

  return {
    open,
    syncCaret,
    onKeyDown,
    onBlur: (target: EventTarget | null) => {
      if (!(target instanceof Element) || !target.closest(`[id="${listId}"]`)) setEnabled(false);
    },
    aria: {
      id: inputId,
      "aria-expanded": open,
      "aria-controls": open ? listId : undefined,
      "aria-autocomplete": "list" as const,
      "aria-activedescendant": open && candidates.length ? `${listId}-${selected}` : undefined,
    },
    menu: open ? <ContextMenu {...position} id={listId} label="歌曲搜索建议" role="listbox"
      initialFocus="none" keepOpen={`[id="${inputId}"]`} onClose={() => setEnabled(false)}
      className="kd-search-suggestions">
      {candidates.map((item, index) => <button key={item.id} type="button" role="option" id={`${listId}-${index}`} aria-selected={selected === index}
          tabIndex={-1} onPointerDown={event => event.preventDefault()}
          onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
          <span className="kd-menu-label">{item.label}</span>
        </button>)}
    </ContextMenu> : null,
  };
}
