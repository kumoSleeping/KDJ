/**
 * `/pi` at the start of the search field hands what follows to the AI (docs/ai-dock.md). The
 * search row has no mode of its own for it: the AI key writes the prefix, and taking it out of
 * the field (or the key again) gives the field back to the search.
 */
export const PI_PREFIX = "/pi ";

const PREFIX = /^\/pi(?:\s|$)/i;

/** The field's words are for the AI. */
export function isPiText(text: string): boolean {
  return PREFIX.test(text);
}

/** What the AI is asked: the words after the prefix. */
export function piRequestText(text: string): string {
  return text.replace(PREFIX, "").trim();
}

/** The words with the prefix in front, once. */
export function withPiPrefix(text: string): string {
  return isPiText(text) ? text : `${PI_PREFIX}${text.replace(/^\s+/, "")}`;
}

/** The words without the prefix, as they go back to the search. */
export function withoutPiPrefix(text: string): string {
  return text.replace(PREFIX, "");
}
