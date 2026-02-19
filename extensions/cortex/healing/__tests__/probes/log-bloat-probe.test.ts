import { describe, expect, it } from "vitest";
import { LogBloatProbe } from "../../probes/log-bloat-probe.js";

describe("LogBloatProbe", () => {
  it("source_id is correct", () => {
    const probe = new LogBloatProbe(60000);
    expect(probe.source_id).toBe("heal.log_bloat");
  });

  it("poll with mockData returns mock", async () => {
    const probe = new LogBloatProbe(60000);
    probe.setMockData({ bloated_files: ["/var/log/big.log"], count: 1 });
    const reading = await probe.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).count).toBe(1);
  });

  it("poll without mock returns real data (graceful)", async () => {
    const probe = new LogBloatProbe(60000);
    const reading = await probe.poll();
    expect(reading.source_id).toBe("heal.log_bloat");
    expect(reading.available).toBe(true);
  });
});
