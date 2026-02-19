import { describe, expect, it } from "vitest";
import { FleetAdapter } from "../../data-sources/fleet-adapter.js";

describe("FleetAdapter", () => {
  it("source_id is correct", () => {
    const adapter = new FleetAdapter();
    expect(adapter.source_id).toBe("fleet.health");
  });

  it("poll with mockData returns mock", async () => {
    const adapter = new FleetAdapter();
    (adapter as any).mockData = { hosts: 3, unreachable: 0 };
    const reading = await adapter.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).hosts).toBe(3);
  });
});
