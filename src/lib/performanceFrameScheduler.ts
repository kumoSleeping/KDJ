export type PerformanceFrameSubscriber = (nowMs: number) => void;

const subscribers = new Set<PerformanceFrameSubscriber>();
let scheduledFrame: number | null = null;

function schedule(): void {
  if (scheduledFrame !== null || subscribers.size === 0) return;
  scheduledFrame = window.requestAnimationFrame((now) => {
    scheduledFrame = null;
    for (const subscriber of subscribers) subscriber(now);
    schedule();
  });
}

/** One browser refresh callback drives every Deck renderer with the exact same frame timestamp. */
export function subscribePerformanceFrame(subscriber: PerformanceFrameSubscriber): () => void {
  subscribers.add(subscriber);
  schedule();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0 && scheduledFrame !== null) {
      window.cancelAnimationFrame(scheduledFrame);
      scheduledFrame = null;
    }
  };
}
