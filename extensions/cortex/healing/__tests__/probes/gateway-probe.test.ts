import { describe, expect, it } from "vitest";
import { GatewayProbe } from "../../probes/gateway-probe.js";

describe("GatewayProbe", () => {
  it("source_id is correct", () => {
    const probe = new GatewayProbe(60000);
    expect(probe.source_id).toBe("heal.gateway");
  });

  it("poll with mockData returns mock", async () => {
    const probe = new GatewayProbe(60000);
    probe.setMockData({ ok: true, consecutive_failures: 0 });
    const reading = await probe.poll();
    expect(reading.available).toBe(true);
    expect(reading.data).toEqual({ ok: true, consecutive_failures: 0 });
    expect(reading.source_id).toBe("heal.gateway");
  });

  it("freshness_threshold_ms is 2x poll interval", () => {
    const probe = new GatewayProbe(30000);
    expect(probe.freshness_threshold_ms).toBe(60000);
  });
});
