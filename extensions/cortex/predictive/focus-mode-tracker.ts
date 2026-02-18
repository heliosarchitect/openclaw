/**
 * Focus Mode Tracker — Singleton sliding-window focus mode detection.
 * Ticked by before_tool_call in index.ts.
 * Cortex v2.1.0
 */

export class FocusModeTracker {
  private callTimestamps: number[] = [];
  private windowMs: number = 90000;
  private minCalls: number = 3;

  tick(): void {
    const now = Date.now();
    this.callTimestamps.push(now);
    this.callTimestamps = this.callTimestamps.filter(t => now - t < this.windowMs);
  }

  isFocusModeActive(): boolean {
    const now = Date.now();
    this.callTimestamps = this.callTimestamps.filter(t => now - t < this.windowMs);
    return this.callTimestamps.length >= this.minCalls;
  }

  configure(windowMs: number, minCalls: number): void {
    this.windowMs = windowMs;
    this.minCalls = minCalls;
  }

  getCallCount(): number {
    const now = Date.now();
    this.callTimestamps = this.callTimestamps.filter(t => now - t < this.windowMs);
    return this.callTimestamps.length;
  }
}

export const focusModeTracker = new FocusModeTracker();
