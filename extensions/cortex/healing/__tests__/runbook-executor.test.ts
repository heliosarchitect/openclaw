import { describe, expect, it, vi } from "vitest";
import type { HealthAnomaly, Incident, Runbook, RunbookDefinition, RunbookStep } from "../types.js";
import { RunbookExecutor, type ExecutorDeps } from "../runbook-executor.js";

function makeStep(id: string, succeed = true): RunbookStep {
  return {
    id,
    description: `Step ${id}`,
    timeout_ms: 5000,
    async dry_run() {
      return `Would do ${id}`;
    },
    async execute() {
      return {
        step_id: id,
        status: succeed ? ("success" as const) : ("failed" as const),
        output: succeed ? "done" : "failed",
        artifacts: [],
        duration_ms: 10,
      };
    },
  };
}

function makeDeps(): ExecutorDeps {
  return {
    incidentManager: {
      transition: vi.fn(),
      selfResolve: vi.fn(),
    } as any,
    getProbe: () => undefined,
    verificationIntervalMs: 10,
    // MED-002: injected classifier stub — returns no anomalies (healthy reading)
    classifier: { classify: vi.fn().mockReturnValue([]) } as any,
  };
}

function makeRunbook(mode: "dry_run" | "auto_execute" = "auto_execute"): Runbook {
  return {
    id: "rb-test",
    label: "Test",
    applies_to: ["process_dead"],
    mode,
    confidence: 0.9,
    dry_run_count: 0,
    last_executed_at: null,
    last_succeeded_at: null,
    auto_approve_whitelist: false,
    steps: [],
    created_at: "",
    approved_at: null,
    schema_version: 1,
  };
}

function makeAnomaly(): HealthAnomaly {
  return {
    id: "a1",
    anomaly_type: "process_dead",
    target_id: "test",
    severity: "high",
    detected_at: new Date().toISOString(),
    source_id: "test",
    details: {},
    remediation_hint: "rb-test",
  };
}

function makeIncident(): Incident {
  return {
    id: "i1",
    anomaly_type: "process_dead",
    target_id: "test",
    severity: "high",
    state: "detected",
    runbook_id: "rb-test",
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

function makeDef(steps: RunbookStep[]): RunbookDefinition {
  return {
    id: "rb-test",
    label: "Test",
    applies_to: ["process_dead"],
    auto_approve_whitelist: false,
    build: () => steps,
  };
}

describe("RunbookExecutor", () => {
  it("executes steps in dry_run mode", async () => {
    const deps = makeDeps();
    const executor = new RunbookExecutor(deps);
    const result = await executor.execute(
      makeRunbook("dry_run"),
      makeDef([makeStep("s1"), makeStep("s2")]),
      makeIncident(),
      makeAnomaly(),
    );
    expect(result.mode).toBe("dry_run");
    expect(result.success).toBe(true);
    expect(result.steps_executed).toHaveLength(2);
    expect(result.steps_executed[0].output).toContain("DRY RUN");
    expect(result.verification_passed).toBeNull();
  });

  it("stops on step failure", async () => {
    const deps = makeDeps();
    const executor = new RunbookExecutor(deps);
    const result = await executor.execute(
      makeRunbook(),
      makeDef([makeStep("s1"), makeStep("s2", false), makeStep("s3")]),
      makeIncident(),
      makeAnomaly(),
    );
    expect(result.success).toBe(false);
    expect(result.steps_executed).toHaveLength(2);
    expect(result.escalation_needed).toBe(true);
  });

  it("returns empty result if no definition", async () => {
    const deps = makeDeps();
    const executor = new RunbookExecutor(deps);
    const result = await executor.execute(makeRunbook(), null, makeIncident(), makeAnomaly());
    expect(result.success).toBe(false);
    expect(result.escalation_needed).toBe(true);
  });
});
