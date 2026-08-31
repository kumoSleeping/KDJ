/**
 * Editable fields keep their normal keys, except focused range sliders: after dragging one,
 * Space should still operate the global player transport.
 */
export function shouldIgnorePlayerShortcut(
  target: EventTarget | null,
  key: string,
  code: string,
): boolean {
  const element = target as HTMLInputElement | null;
  if (!element) return false;
  const tag = element.tagName;
  const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable;
  if (!editable) return false;
  const isRange = tag === "INPUT" && element.type === "range";
  const isSpace = key === " " || key === "Spacebar" || code === "Space";
  return !(isRange && isSpace);
}
