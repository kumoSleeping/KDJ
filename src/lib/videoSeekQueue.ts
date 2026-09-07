interface SeekRequest {
  revision: number;
  run(signal: AbortSignal): Promise<void>;
  resolve(applied: boolean): void;
  reject(reason: unknown): void;
}

/** One decoder command in flight, one latest target waiting. Shared by media and embed backends. */
export class VideoSeekQueue {
  private revision = 0;
  private active: AbortController | null = null;
  private pending: SeekRequest | null = null;

  request(run: SeekRequest["run"]): Promise<boolean> {
    const revision = ++this.revision;
    this.pending?.resolve(false);
    return new Promise((resolve, reject) => {
      this.pending = { revision, run, resolve, reject };
      void this.drain();
    });
  }

  cancel(): void {
    this.revision++;
    this.pending?.resolve(false);
    this.pending = null;
    this.active?.abort();
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    const request = this.pending;
    if (!request) return;
    this.pending = null;
    const abort = new AbortController();
    this.active = abort;
    try {
      await request.run(abort.signal);
      request.resolve(!abort.signal.aborted && request.revision === this.revision);
    } catch (error) {
      if (abort.signal.aborted || request.revision !== this.revision) request.resolve(false);
      else request.reject(error);
    } finally {
      this.active = null;
      void this.drain();
    }
  }
}
