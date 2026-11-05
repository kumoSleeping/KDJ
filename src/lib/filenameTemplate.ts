/**
 * The downloaded song's file name (`filename_template`, kdj-core paths.rs `render_filename`) as
 * the pieces settings lays out: fields (歌名, 歌手, 专辑) and the marks between them, in order.
 * The template string stays what is saved; pieces are only how it is shown and changed.
 */

export type Field = "title" | "artist" | "album";
export type Piece = { kind: "field"; field: Field } | { kind: "mark"; text: string };

export const DEFAULT_TEMPLATE = "{title} - {artist}";

export const FIELDS: ReadonlyArray<{ field: Field; label: string }> = [
  { field: "title", label: "歌名" },
  { field: "artist", label: "歌手" },
  { field: "album", label: "专辑" },
];

/** The marks offered, as they are shown and what they put in the name. */
export const MARKS: ReadonlyArray<{ label: string; text: string }> = [
  { label: "-", text: " - " },
  { label: "_", text: "_" },
  { label: "·", text: " · " },
  { label: "空格", text: " " },
  { label: "(", text: " (" },
  { label: ")", text: ")" },
  { label: "[", text: " [" },
  { label: "]", text: "]" },
];

/** Placeholders the server knows, by the field they are shown as (`artists`, `track` are aliases). */
const NAMES: Record<string, Field> = { title: "title", track: "title", artist: "artist", artists: "artist", album: "album" };

export function fieldLabel(field: Field): string {
  return FIELDS.find(f => f.field === field)!.label;
}

/** How a mark reads in its piece: one of MARKS by its label, else its own text. */
export function markLabel(text: string): string {
  return MARKS.find(m => m.text === text)?.label ?? text;
}

/** The marks in `text`: the longest of MARKS at each place, any other run of characters as it is. */
function marksOf(text: string): Piece[] {
  const pieces: Piece[] = [];
  const known = [...MARKS].sort((a, b) => b.text.length - a.text.length);
  let other = "";
  for (let at = 0; at < text.length;) {
    const mark = known.find(m => text.startsWith(m.text, at));
    if (!mark) { other += text[at]; at += 1; continue; }
    if (other) { pieces.push({ kind: "mark", text: other }); other = ""; }
    pieces.push({ kind: "mark", text: mark.text });
    at += mark.text.length;
  }
  if (other) pieces.push({ kind: "mark", text: other });
  return pieces;
}

/**
 * The pieces of a saved template; null when the server would not use it either (a placeholder
 * it does not know, `{id}`, a brace left open): it names files with the default then.
 */
export function parseTemplate(template: string): Piece[] | null {
  const pieces: Piece[] = [];
  let rest = template;
  for (let open = rest.indexOf("{"); open >= 0; open = rest.indexOf("{")) {
    pieces.push(...marksOf(rest.slice(0, open)));
    const close = rest.indexOf("}", open);
    const field = close < 0 ? undefined : NAMES[rest.slice(open + 1, close)];
    if (!field) return null;
    pieces.push({ kind: "field", field });
    rest = rest.slice(close + 1);
  }
  pieces.push(...marksOf(rest));
  return pieces;
}

export function templateOf(pieces: readonly Piece[]): string {
  return pieces.map(p => (p.kind === "field" ? `{${p.field}}` : p.text)).join("");
}

const OPENING = /[([（【]+$/;
const CLOSING = /^[)\]）】]+/;

/**
 * The name `pieces` give a song, as the server writes it (paths.rs `expand_template`): a field
 * without a value takes away the marks joining it to the field before it (to the one after it,
 * when it is the first), and the brackets around it. Characters a file name cannot hold are not
 * taken out here.
 */
export function exampleName(pieces: readonly Piece[], values: Record<Field, string>): string {
  // Marks between fields joined into one text: text, field, text, field, …, text.
  const parts: Array<{ text: string } | { value: string }> = [{ text: "" }];
  for (const piece of pieces) {
    if (piece.kind === "mark") (parts[parts.length - 1] as { text: string }).text += piece.text;
    else parts.push({ value: values[piece.field] }, { text: "" });
  }
  for (;;) {
    const i = parts.findIndex(p => "value" in p && !p.value);
    if (i < 0) break;
    const first = !parts.slice(0, i).some(p => "value" in p);
    const before = parts[i - 1] as { text: string };
    before.text = first ? before.text.trimEnd().replace(OPENING, "") : "";
    const after = parts[i + 1] as { text: string };
    after.text = first && parts.slice(i + 2).some(p => "value" in p) ? "" : after.text.replace(CLOSING, "");
    parts[i] = { text: "" };
  }
  const name = parts.map(p => ("value" in p ? p.value : p.text)).join("").replace(/\s+/g, " ").trim();
  return name || `${values.title} - ${values.artist}`;
}
