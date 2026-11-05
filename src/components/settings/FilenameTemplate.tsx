/**
 * 设置 → 下载 → 歌曲文件名: the downloaded song's name laid out as pieces (歌名, 歌手, 专辑 and
 * the marks between them). A piece is dragged to another place, or moved with ← → once focused;
 * × or Delete takes it out; the keys under them add one at the end. Each change is saved at once
 * as `filename_template` and shown on an example song.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import {
  DEFAULT_TEMPLATE, exampleName, fieldLabel, FIELDS, markLabel, MARKS, parseTemplate, templateOf, type Piece,
} from "../../lib/filenameTemplate";
import "./FilenameTemplate.css";

const EXAMPLE = { title: "夜に駆ける", artist: "YOASOBI", album: "THE BOOK" };

/** Where a piece dragged to (x, y) goes among `boxes` (the others' places, in order). */
function placeAt(boxes: DOMRect[], x: number, y: number): number {
  let best = 0, distance = Infinity;
  boxes.forEach((box, n) => {
    const d = Math.hypot(x - (box.left + box.width / 2), y - (box.top + box.height / 2));
    if (d < distance) { distance = d; best = n; }
  });
  const box = boxes[best];
  if (!box) return 0;
  return x < box.left + box.width / 2 ? best : best + 1;
}

export function FilenameTemplate({ template, onChange }: { template: string; onChange(template: string): void }) {
  const saved = parseTemplate(template);
  const [moving, setMoving] = useState<{ pieces: Piece[]; at: number } | null>(null);
  const pieces = moving?.pieces ?? saved ?? parseTemplate(DEFAULT_TEMPLATE)!;
  const nodes = useRef<Array<HTMLSpanElement | null>>([]);
  const fields = pieces.filter(p => p.kind === "field").length;

  const save = (next: Piece[]) => {
    const text = templateOf(next);
    if (text !== template) onChange(text);
  };
  const remove = (at: number) => save(pieces.filter((_, n) => n !== at));
  const move = (from: number, to: number, list = pieces) => {
    const next = [...list];
    const [piece] = next.splice(from, 1);
    next.splice(to, 0, piece);
    return next;
  };

  const press = (at: number) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const start = { x: event.clientX, y: event.clientY };
    let state: { pieces: Piece[]; at: number } | null = null;
    const follow = (e: PointerEvent) => {
      if (!state && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      const now = state ?? { pieces, at };
      const others = nodes.current.slice(0, now.pieces.length)
        .map((node, n) => (n === now.at || !node ? null : node.getBoundingClientRect()))
        .filter((box): box is DOMRect => box !== null);
      const to = placeAt(others, e.clientX, e.clientY);
      state = to === now.at && state ? state : { pieces: move(now.at, to, now.pieces), at: to };
      setMoving(state);
    };
    const end = () => {
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setMoving(null);
      if (state) save(state.pieces);
    };
    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  // The name always keeps one field: without any, every song would get the same name.
  const removable = (piece: Piece) => piece.kind === "mark" || fields > 1;

  const keys = (at: number) => (event: KeyboardEvent<HTMLSpanElement>) => {
    const to = event.key === "ArrowLeft" ? at - 1 : event.key === "ArrowRight" ? at + 1 : null;
    if (to !== null) {
      event.preventDefault();
      if (to < 0 || to >= pieces.length) return;
      save(move(at, to));
      requestAnimationFrame(() => nodes.current[to]?.focus());
    } else if ((event.key === "Delete" || event.key === "Backspace") && removable(pieces[at])) {
      event.preventDefault();
      remove(at);
    }
  };
  return <div className="kd-djp-group kd-name-template">
    <div className="kd-djp-label-row">
      <span className="kd-djp-label" title="网易云、QQ 音乐、SoundCloud 和 YouTube Music 下载的歌；视频仍以视频标题命名">歌曲文件名</span>
      {template !== DEFAULT_TEMPLATE && <button type="button" className="kd-name-reset" onClick={() => onChange(DEFAULT_TEMPLATE)}>恢复默认</button>}
    </div>
    <div className="kd-name-pieces" role="list" aria-label="文件名的顺序（拖动或用左右键换位置）">
      {pieces.map((piece, n) => {
        const label = piece.kind === "field" ? fieldLabel(piece.field) : markLabel(piece.text);
        return <span key={`${n}:${label}`} ref={node => { nodes.current[n] = node; }} role="listitem" tabIndex={0}
          className="kd-name-piece" data-kind={piece.kind} data-moving={moving?.at === n || undefined}
          aria-label={piece.kind === "field" ? label : `符号 ${label}`}
          onPointerDown={press(n)} onKeyDown={keys(n)}>
          <span className="kd-name-piece-text">{label}</span>
          {removable(piece) && <button type="button" className="kd-name-piece-x" tabIndex={-1} aria-label={`去掉${label}`}
            onClick={() => remove(n)}><X size={11} aria-hidden="true" /></button>}
        </span>;
      })}
    </div>
    <div className="kd-name-add" aria-label="加在最后">
      {FIELDS.filter(f => !pieces.some(p => p.kind === "field" && p.field === f.field)).map(f =>
        <button key={f.field} type="button" className="kd-name-add-key" data-kind="field"
          onClick={() => save([...pieces, { kind: "field", field: f.field }])}>{f.label}</button>)}
      {MARKS.map(m => <button key={m.label} type="button" className="kd-name-add-key" data-kind="mark"
        aria-label={`加上符号 ${m.label}`} onClick={() => save([...pieces, { kind: "mark", text: m.text }])}>{m.label}</button>)}
    </div>
    <p className="kd-name-example">例：{exampleName(pieces, EXAMPLE)}.flac</p>
  </div>;
}
