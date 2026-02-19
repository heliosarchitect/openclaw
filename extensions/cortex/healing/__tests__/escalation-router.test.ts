import { describe, expect, it, vi } from "vitest";
import type { Incident } from "../types.js";
import { EscalationRouter, type EscalationDeps } from "../escalation-router.js";

function makeDeps(): EscalationDeps & { synapseCalls: string[]; signalCalls: string[] } {
  const synapseCalls: string[] = [];
  const signalCalls: string[] = [];
  return {
    synapseCalls,
    signalCalls,
    sendSynapse: async (body) => {
      synapseCalls.push(body);
    },
    sendSignal: async (msg) => {
      signalCalls.push(msg);
    },
    writeMetric: async () => {},
  };
}

function makeIncident(severity = "high" as const): Incident {
  return {
    id: "inc-1",
    anomaly_type: "process_dead",
    target_id: "augur-executor",
    severity,
    state: "detected",
    runbook_id: "rb-restart-service",
    detected_at: new Date().toISOString(),
    state_changed_at: new Date().toISOString(),
    resolved_at: null,
    escalation_tier: null,
    escalated_at: null,
    dismiss_until: null,
    audit_trail: [],
    details: {},
    schema_version: 1,
  };
}

describe("EscalationRouter", () => {
  it("tier 0 sends no messages", async () => {
    const deps = makeDeps();
    const router = new EscalationRouter(deps);
    await router.route(0, makeIncident(), {});
    expect(deps.synapseCalls).toHaveLength(0);
    expect(deps.signalCalls).toHaveLength(0);
  });

  it("tier 1 sends Synapse only", async () => {
    const deps = makeDeps();
    const router = new EscalationRouter(deps);
    await router.route(1, makeIncident(), { action_taken: "Restarted service" });
    expect(deps.synapseCalls).toHaveLength(1);
    expect(deps.signalCalls).toHaveLength(0);
    expect(deps.synapseCalls[0]).toContain("Action Taken");
  });

  it("tier 3 sends both Synapse and Signal", async () => {
    const deps = makeDeps();
    const router = new EscalationRouter(deps);
    await router.route(3, makeIncident(), { failure_reason: "Restart failed" });
    expect(deps.synapseCalls).toHaveLength(1);
    expect(deps.signalCalls).toHaveLength(1);
    expect(deps.signalCalls[0]).toContain("Self-Healing Alert");
  });

  it("determineTier returns 3 for critical severity", () => {
    const router = new EscalationRouter(makeDeps());
    const tier = router.determineTier(
      makeIncident("critical"),
      true,
      "auto_execute",
      1.0,
      0.8,
      false,
    );
    expect(tier).toBe(3);
  });

  it("determineTier returns 0 for auto_execute with high confidence", () => {
    const router = new EscalationRouter(makeDeps());
    const tier = router.determineTier(
      makeIncident("medium"),
      true,
      "auto_execute",
      0.9,
      0.8,
      false,
    );
    expect(tier).toBe(0);
  });

  it("determineTier returns 2 for low confidence", () => {
    const router = new EscalationRouter(makeDeps());
    const tier = router.determineTier(makeIncident("medium"), true, "dry_run", 0.3, 0.8, false);
    expect(tier).toBe(2);
  });

  it("determineTier returns 3 for remediation failure", () => {
    const router = new EscalationRouter(makeDeps());
    const tier = router.determineTier(makeIncident("medium"), true, "auto_execute", 0.9, 0.8, true);
    expect(tier).toBe(3);
  });
});
