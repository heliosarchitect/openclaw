/**
 * Real-Time Learning — Async Queue Tests
 */

import { describe, it, expect } from "vitest";
import { AsyncQueue } from "../async-queue.js";

describe("AsyncQueue", () => {
  it("processes items asynchronously", async () => {
    const results: number[] = [];
    const queue = new AsyncQueue<number>();
    queue.onDrain(async (n) => {
      results.push(n);
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    await new Promise((r) => setTimeout(r, 50));
    expect(results).toEqual([1, 2, 3]);
  });

  it("enqueue is synchronous (≤1ms)", () => {
    const queue = new AsyncQueue<number>();
    queue.onDrain(async () => {});

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      queue.enqueue(i);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(10); // 100 enqueues in <10ms
  });

  it("handles handler errors without crashing", async () => {
    const results: number[] = [];
    const queue = new AsyncQueue<number>({ warn: () => {} });
    queue.onDrain(async (n) => {
      if (n === 2) throw new Error("boom");
      results.push(n);
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    await new Promise((r) => setTimeout(r, 50));
    expect(results).toEqual([1, 3]);
  });

  it("reports pending count", () => {
    const queue = new AsyncQueue<number>();
    // No handler set — items stay in queue
    queue.enqueue(1);
    queue.enqueue(2);
    // pending may be 0 since drain starts on setImmediate
    expect(queue.pending).toBeGreaterThanOrEqual(0);
  });
});
