import { describe, expect, it } from "vitest";
import { DiskProbe } from "../../probes/disk-probe.js";

describe("DiskProbe", () => {
  it("returns available reading with mock data", async () => {
    const probe = new DiskProbe(600000);
    probe.setMockData({ mounts: [{ mount: "/", usage_pct: 0.75 }] });
    const reading = await probe.poll();
    expect(reading.available).toBe(true);
    expect(reading.source_id).toBe("heal.disk");
    expect((reading.data.mounts as any[])[0].usage_pct).toBe(0.75);
  });
});
