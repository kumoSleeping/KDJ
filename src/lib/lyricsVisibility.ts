/** Provider placeholders are not song lyrics, even when they carry timestamps. */
export function hasVisibleLyrics(lines: readonly { text: string }[]): boolean {
  const text = lines.map(line => line.text.trim()).filter(Boolean);
  if (!text.length) return false;
  const instrumental = /^(?:纯音乐(?:[，,\s：:-]*(?:请欣赏|敬请欣赏))?|此歌曲为没有填词的纯音乐(?:[，,\s]*(?:请欣赏|敬请欣赏))?|instrumental(?:\s+music)?)[。.!！\s]*$/i;
  return !text.some(line => instrumental.test(line));
}
