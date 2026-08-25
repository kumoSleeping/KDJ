/** Collapse toggle edges that have not entered IPC yet while preserving their final parity. */
export class LoopToggleParity {
  private odd = false;

  push(): void {
    this.odd = !this.odd;
  }

  consume(): boolean {
    const value = this.odd;
    this.odd = false;
    return value;
  }

  clear(): void {
    this.odd = false;
  }
}
