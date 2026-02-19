import { describe, expect, it } from "vitest";
import { AugurProcessProbe } from "../../probes/augur-process-probe.js";

describe("AugurProcessProbe", () => {
  it("source_id is correct", () => {
    const probe = new AugurProcessProbe(60000);
    expect(probe.source_id).toBe("heal.augur_process");
  });

  it("poll with mockData returns mock", async () => {
    const probe = new AugurProcessProbe(60000);
    probe.setMockData({ pid_found: true, zombie: false, process_count: 1 });
    const reading = await probe.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).pid_found).toBe(true);
  });

  it("poll without mock returns real data", async () => {
    const probe = new AugurProcessProbe(60000);
    const reading = await probe.poll();
    expect(reading.source_id).toBe("heal.augur_process");
    // In test env, augur likely not running
    expect(reading).toHaveProperty("data");
  });
});
