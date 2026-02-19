/**
 * Real-Time Learning — Async Event Queue
 * Cortex v2.6.0 (task-011)
 *
 * Non-blocking queue that enqueues synchronously and drains on setImmediate.
 * Guarantees ≤2ms overhead on the hot path.
 */

export class AsyncQueue<T> {
  private queue: T[] = [];
  private draining = false;
  private handler: ((item: T) => Promise<void>) | null = null;
  private logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void };

  constructor(logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void }) {
    this.logger = logger;
  }

  /**
   * Set the async handler that processes each queued item.
   */
  onDrain(handler: (item: T) => Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Enqueue an item — returns immediately (sync, ≤1ms).
   */
  enqueue(item: T): void {
    this.queue.push(item);
    if (!this.draining) {
      this.draining = true;
      setImmediate(() => void this.drain());
    }
  }

  /**
   * Number of items waiting.
   */
  get pending(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        if (this.handler) {
          await this.handler(item);
        }
      } catch (err) {
        this.logger?.warn?.(`[AsyncQueue] Handler error: ${err}`);
      }
    }
    this.draining = false;
  }
}
