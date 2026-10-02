/** A bounded LRU: revisiting tiles never retains bitmaps for an entire long recording. */
export class WaveformTileCache<T> {
  private tiles = new Map<string, T>();
  constructor(private readonly capacity = 8) {}
  get(key: string): T | undefined {
    const value = this.tiles.get(key);
    if (value !== undefined) { this.tiles.delete(key); this.tiles.set(key, value); }
    return value;
  }
  set(key: string, value: T) {
    this.tiles.delete(key);
    this.tiles.set(key, value);
    while (this.tiles.size > this.capacity) this.tiles.delete(this.tiles.keys().next().value!);
  }
  clear() { this.tiles.clear(); }
}
