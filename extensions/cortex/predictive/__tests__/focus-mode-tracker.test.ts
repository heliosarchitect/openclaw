/**
 * Unit Tests — FocusModeTracker
 * Predictive Intent v2.1.0 | task-005
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FocusModeTracker } from "../focus-mode-tracker.js";

describe("FocusModeTracker", () => {
  let tracker: FocusModeTracker;

  beforeEach(() => {
    tracker = new FocusModeTracker();
  });

  it("starts inactive (no calls)", () => {
    expect(tracker.isFocusModeActive()).toBe(false);
    expect(tracker.getCallCount()).toBe(0);
  });

  it("activates after minCalls ticks within window", () => {
    tracker.tick();
    tracker.tick();
    expect(tracker.isFocusModeActive()).toBe(false);
    tracker.tick();
    expect(tracker.isFocusModeActive()).toBe(true);
    expect(tracker.getCallCount()).toBe(3);
  });

  it("deactivates when ticks fall outside window", () => {
    const now = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now) // tick 1
      .mockReturnValueOnce(now + 10) // tick 2
      .mockReturnValueOnce(now + 20) // tick 3
      .mockReturnValue(now + 100000); // 100s later — outside 90s window

    tracker.tick();
    tracker.tick();
    tracker.tick();
    expect(tracker.isFocusModeActive()).toBe(false);
    vi.restoreAllMocks();
  });

  it("respects configure(windowMs, minCalls)", () => {
    tracker.configure(1000, 2);
    tracker.tick();
    expect(tracker.isFocusModeActive()).toBe(false);
    tracker.tick();
    expect(tracker.isFocusModeActive()).toBe(true);
  });

  it("prunes old timestamps on tick", () => {
    const now = Date.now();
    // tick() calls Date.now() once for push, then filters
    // getCallCount() also calls Date.now() and filters
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now) // tick 1: push
      .mockReturnValueOnce(now + 100000) // tick 2: push (100s later)
      .mockReturnValueOnce(now + 100000); // getCallCount filter

    tracker.tick(); // records timestamp at `now`
    tracker.tick(); // records at now+100s, filters: now is >90s old → pruned
    expect(tracker.getCallCount()).toBe(1); // only the now+100s entry
    vi.restoreAllMocks();
  });
});
