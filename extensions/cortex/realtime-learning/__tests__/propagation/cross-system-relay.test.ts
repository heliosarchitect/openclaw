import { describe, expect, it, vi } from "vitest";
import type { FailureEvent, RealtimeLearningDeps } from "../../types.js";
import { CrossSystemRelay } from "../../propagation/cross-system-relay.js";

function makeFailure(): FailureEvent {
  return {
    id: "fail-001",
    type: "TOOL_ERR",
    source: "exec",
    failure_desc: "exit 1",
    context: {},
    detected_at: new Date().toISOString(),
    root_cause: "missing dep",
  } as any;
}

describe("CrossSystemRelay", () => {
  it("calls sendSynapse with structured body", async () => {
    const sendSynapse = vi.fn().mockResolvedValue("msg-123");
    const deps = { sendSynapse } as unknown as RealtimeLearningDeps;
    const relay = new CrossSystemRelay(deps);
    const result = await relay.relay(makeFailure());
    expect(sendSynapse).toHaveBeenCalledOnce();
    expect(result).toBe("msg-123");
    const [subject, body] = sendSynapse.mock.calls[0];
    expect(subject).toContain("missing dep");
    const parsed = JSON.parse(body);
    expect(parsed.failure_id).toBe("fail-001");
    expect(parsed.requires_action).toBe(true);
  });

  it("handles offline synapse gracefully", async () => {
    const sendSynapse = vi.fn().mockResolvedValue(undefined);
    const deps = { sendSynapse } as unknown as RealtimeLearningDeps;
    const relay = new CrossSystemRelay(deps);
    const result = await relay.relay(makeFailure());
    expect(result).toBeUndefined();
  });
});
