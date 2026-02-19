import { describe, expect, it } from "vitest";
import type { DetectionPayload } from "../../types.js";
import { AsyncQueue } from "../../async-queue.js";
import { HookViolationRelay } from "../../detection/hook-violation-relay.js";

describe("HookViolationRelay", () => {
  it("enqueues on SOP violation", () => {
    const queue = new AsyncQueue<DetectionPayload>();
    const relay = new HookViolationRelay(queue);
    relay.onViolation({ hookId: "pre-exec", sopFile: "fleet.ai.sop", ruleId: "ssh-check" });
    expect(queue.pending).toBe(1);
  });

  it("payload has correct type and tier", async () => {
    const items: DetectionPayload[] = [];
    const queue = new AsyncQueue<DetectionPayload>();
    queue.onDrain(async (item) => {
      items.push(item);
    });
    const relay = new HookViolationRelay(queue);
    relay.onViolation({
      hookId: "pre-exec",
      sopFile: "fleet.ai.sop",
      ruleId: "ssh-check",
      description: "stale SOP",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(items[0].type).toBe("SOP_VIOL");
    expect(items[0].tier).toBe(2);
    expect(items[0].failure_desc).toBe("stale SOP");
  });

  it("uses default description when not provided", async () => {
    const items: DetectionPayload[] = [];
    const queue = new AsyncQueue<DetectionPayload>();
    queue.onDrain(async (item) => {
      items.push(item);
    });
    const relay = new HookViolationRelay(queue);
    relay.onViolation({ hookId: "pre-exec", sopFile: "git.ai.sop", ruleId: "force-push" });
    await new Promise((r) => setTimeout(r, 50));
    expect(items[0].failure_desc).toContain("git.ai.sop");
  });
});
