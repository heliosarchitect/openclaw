import { describe, expect, it } from "vitest";
import type { DetectionPayload } from "../../types.js";
import { AsyncQueue } from "../../async-queue.js";
import { TrustEventRelay } from "../../detection/trust-event-relay.js";

describe("TrustEventRelay", () => {
  it("enqueues on trust demotion", () => {
    const queue = new AsyncQueue<DetectionPayload>();
    const relay = new TrustEventRelay(queue);
    relay.onDemotion({ milestone: "deploy", priorTier: 3, reason: "failed deployment" });
    expect(queue.pending).toBe(1);
  });

  it("payload has correct type and tier", async () => {
    const items: DetectionPayload[] = [];
    const queue = new AsyncQueue<DetectionPayload>();
    queue.onDrain(async (item) => {
      items.push(item);
    });
    const relay = new TrustEventRelay(queue);
    relay.onDemotion({
      milestone: "deploy",
      priorTier: 3,
      reason: "failed deployment",
      sessionId: "s1",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(items[0].type).toBe("TRUST_DEM");
    expect(items[0].tier).toBe(3);
    expect(items[0].source).toBe("task-010-trust-engine");
    expect(items[0].failure_desc).toContain("failed deployment");
  });
});
