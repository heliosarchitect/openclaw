import { describe, expect, it } from "vitest";
import { MemoryProbe } from "../../probes/memory-probe.js";

describe("MemoryProbe", () => {
  it("returns mock data correctly", async () => {
    const probe = new MemoryProbe(300000);
    probe.setMockData({ available_mb: 2048, total_mb: 16384 });
    const reading = await probe.poll();
    expect(reading.available).toBe(true);
    expect(reading.data.available_mb).toBe(2048);
  });

  it("reads from /proc/meminfo on Linux", async () => {
    const probe = new MemoryProbe(300000);
    const reading = await probe.poll();
    // Should be available on Linux
    if (process.platform === "linux") {
      expect(reading.available).toBe(true);
      expect(typeof reading.data.available_mb).toBe("number");
    }
  });
});
