/**
 * RunbookExecutor verification loop integration test — MED-002 fix verification
 *
 * Prior to the MED-002 fix, readingIsClear() used require('./anomaly-classifier.js')
 * which throws "require is not defined" in ESM context, leaving incidents in 'verifying'
 * state forever and suppressing all post-execution escalation.
 *
 * This test confirms:
 * 1. The verification probe path executes without throwing
 * 2. Incident transitions to 'resolved' when verification probe returns clear
 * 3. Incident transitions to 'remediation_failed' when verification probe still shows anomaly
 * 4. Injected classifier.classify() is actually called during verification
 */

import { describe, expect, it, vi } from "vitest";
import type { SourceReading } from "../../predictive/types.js";
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

function makeAnomaly(type = "process_dead"): HealthAnomaly {
  return {
    id: "a1",
    anomaly_type: type as any,
    target_id: "augur-executor",
    severity: "high",
    detected_at: new Date().toISOString(),
    source_id: "augur-probe",
    details: {},
    remediation_hint: "rb-restart-augur",
  };
}

function makeIncident(): Incident {
  return {
    id: "i1",
    anomaly_type: "process_dead",
    target_id: "augur-executor",
    severity: "high",
    state: "detected",
    runbook_id: "rb-restart-augur",
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

function makeRunbook(): Runbook {
  return {
    id: "rb-restart-augur",
    label: "Restart AUGUR",
    applies_to: ["process_dead"],
    mode: "auto_execute",
    confidence: 0.9,
    dry_run_count: 3,
    last_executed_at: null,
    last_succeeded_at: null,
    auto_approve_whitelist: true,
    steps: [],
    created_at: "",
    approved_at: null,
    schema_version: 1,
  };
}

function makeDef(steps: RunbookStep[]): RunbookDefinition {
  return {
    id: "rb-restart-augur",
    label: "Restart AUGUR",
    applies_to: ["process_dead"],
    auto_approve_whitelist: true,
    build: () => steps,
  };
}

// Minimal SourceReading that satisfies the DataSourceAdapter poll() contract
function makeReading(available = true): SourceReading {
  return {
    source_id: "augur-probe",
    available,
    data: {},
    fetched_at: new Date().toISOString(),
  };
}

describe("RunbookExecutor — MED-002 verification loop (classifier injection)", () => {
  it("does NOT throw when verification probe runs (MED-002 regression test)", async () => {
    const anomaly = makeAnomaly();
    // First call (pre-probe): anomaly still active → don't short-circuit, execute the runbook
    // Subsequent calls (post-execution verification): anomaly cleared → resolved
    const classifyMock = vi
      .fn()
      .mockReturnValueOnce([anomaly]) // pre-probe: still active
      .mockReturnValue([]); // verification: cleared
    const transitionMock = vi.fn();

    const probe = { poll: vi.fn().mockResolvedValue(makeReading(true)), source_id: "augur-probe" };

    const deps: ExecutorDeps = {
      incidentManager: { transition: transitionMock, selfResolve: vi.fn() } as any,
      getProbe: (sourceId) => (sourceId === "augur-probe" ? (probe as any) : undefined),
      verificationIntervalMs: 1, // near-zero for test speed
      classifier: { classify: classifyMock } as any,
    };

    const executor = new RunbookExecutor(deps);

    // Should NOT throw — prior to fix this would throw "require is not defined"
    const result = await executor.execute(
      makeRunbook(),
      makeDef([makeStep("restart")]),
      makeIncident(),
      anomaly,
    );

    expect(result.success).toBe(true);
    expect(result.verification_passed).toBe(true);
    // classifier.classify must be called at least twice (pre-probe + verification)
    expect(classifyMock).toHaveBeenCalledTimes(2);
  });

  it("transitions to resolved when verification probe returns clear", async () => {
    const anomaly = makeAnomaly();
    // Pre-probe: anomaly still active (don't self-resolve) → execute step
    // Post-verification: anomaly cleared → transition to 'resolved'
    const classifyMock = vi
      .fn()
      .mockReturnValueOnce([anomaly]) // pre-probe: still active → execute
      .mockReturnValue([]); // verification probe: cleared → resolved
    const transitionMock = vi.fn();

    const probe = { poll: vi.fn().mockResolvedValue(makeReading(true)), source_id: "augur-probe" };

    const deps: ExecutorDeps = {
      incidentManager: { transition: transitionMock, selfResolve: vi.fn() } as any,
      getProbe: () => probe as any,
      verificationIntervalMs: 1,
      classifier: { classify: classifyMock } as any,
    };

    const executor = new RunbookExecutor(deps);
    await executor.execute(makeRunbook(), makeDef([makeStep("s1")]), makeIncident(), anomaly);

    // Last transition should be to 'resolved'
    const calls = transitionMock.mock.calls.map((c) => c[1]);
    expect(calls).toContain("resolved");
    expect(calls).not.toContain("remediation_failed");
  });

  it("transitions to remediation_failed when verification probe still shows anomaly", async () => {
    const anomaly = makeAnomaly();
    // ALL classify calls return the anomaly (both pre-probe and verification → never clears).
    // Pre-probe: anomaly still active → execute the runbook (don't self-resolve)
    // Verification: anomaly still active → transition to 'remediation_failed'
    const classifyMock = vi.fn().mockReturnValue([anomaly]);
    const transitionMock = vi.fn();

    const probe = { poll: vi.fn().mockResolvedValue(makeReading(true)), source_id: "augur-probe" };

    const deps: ExecutorDeps = {
      incidentManager: { transition: transitionMock, selfResolve: vi.fn() } as any,
      getProbe: () => probe as any,
      verificationIntervalMs: 1,
      classifier: { classify: classifyMock } as any,
    };

    const executor = new RunbookExecutor(deps);
    const result = await executor.execute(
      makeRunbook(),
      makeDef([makeStep("s1")]),
      makeIncident(),
      anomaly,
    );

    expect(result.verification_passed).toBe(false);
    expect(result.escalation_needed).toBe(true);

    const calls = transitionMock.mock.calls.map((c) => c[1]);
    expect(calls).toContain("remediation_failed");
    expect(calls).not.toContain("resolved");
  });

  it("self-resolves incident (no execution) when pre-probe shows anomaly already cleared", async () => {
    const anomaly = makeAnomaly();
    const classifyMock = vi.fn().mockReturnValue([]); // cleared before we even run
    const selfResolveMock = vi.fn();

    const probe = { poll: vi.fn().mockResolvedValue(makeReading(true)), source_id: "augur-probe" };

    const deps: ExecutorDeps = {
      incidentManager: { transition: vi.fn(), selfResolve: selfResolveMock } as any,
      getProbe: () => probe as any,
      verificationIntervalMs: 1,
      classifier: { classify: classifyMock } as any,
    };

    const executor = new RunbookExecutor(deps);
    const result = await executor.execute(
      makeRunbook(),
      makeDef([makeStep("s1")]),
      makeIncident(),
      anomaly,
    );

    // Pre-probe cleared the anomaly — no steps should have run
    expect(result.steps_executed).toHaveLength(0);
    expect(result.verification_passed).toBe(true);
    expect(selfResolveMock).toHaveBeenCalled();
  });
});
