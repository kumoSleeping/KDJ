/** Provider placeholders are not song lyrics, even when they carry timestamps. */
export function hasVisibleLyrics(lines: readonly { text: string }[]): boolean {
  const text = lines.map(line => line.text.trim()).filter(Boolean);
  if (!text.length) return false;
  const instrumental = /^(?:纯音乐(?:[，,\s：:-]*(?:请欣赏|敬请欣赏))?|此歌曲为没有填词的纯音乐(?:[，,\s]*(?:请欣赏|敬请欣赏))?|instrumental(?:\s+music)?)[。.!！\s]*$/i;
  return !text.some(line => instrumental.test(line));
}

/**
 * Whether it is settled what a song's lyrics are: they are in, or known to be missing. While a
 * lookup is under way, or none has been made, nothing can be said yet.
 */
export function lyricsSettled(entry: { status: string; inflight: unknown }): boolean {
  return !entry.inflight && entry.status !== "idle" && entry.status !== "loading";
}
