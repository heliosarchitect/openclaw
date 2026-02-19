import { describe, expect, it } from "vitest";
import { BrainDbProbe } from "../../probes/brain-db-probe.js";

describe("BrainDbProbe", () => {
  it("returns mock data correctly", async () => {
    const probe = new BrainDbProbe(900000);
    probe.setMockData({ integrity_ok: true });
    const reading = await probe.poll();
    expect(reading.available).toBe(true);
    expect(reading.data.integrity_ok).toBe(true);
  });

  it("detects corruption via mock", async () => {
    const probe = new BrainDbProbe(900000);
    probe.setMockData({ integrity_ok: false, error: "page corruption" });
    const reading = await probe.poll();
    expect(reading.data.integrity_ok).toBe(false);
  });
});
