/**
 * Real-Time Learning — Failure Classifier Tests
 * Tests all 5 failure types with multiple sub-patterns.
 */

import { describe, it, expect } from "vitest";
import type { DetectionPayload } from "../types.js";
import { FailureClassifier } from "../classification/failure-classifier.js";

function makePayload(overrides: Partial<DetectionPayload>): DetectionPayload {
  return {
    type: "TOOL_ERR",
    tier: 1,
    source: "exec",
    context: {},
    failure_desc: "test failure",
    ...overrides,
  };
}

describe("FailureClassifier", () => {
  const classifier = new FailureClassifier();

  // TOOL_ERR patterns
  it("classifies ENOENT as wrong_path", () => {
    const result = classifier.classify(
      makePayload({ failure_desc: "Tool exec failed: ENOENT /foo/bar" }),
    );
    expect(result.root_cause).toBe("wrong_path");
    expect(result.propagation_targets).toContain("sop_patch");
  });

  it("classifies permission denied as permissions", () => {
    const result = classifier.classify(
      makePayload({ failure_desc: "Tool exec failed: permission denied" }),
    );
    expect(result.root_cause).toBe("permissions");
  });

  it("classifies command not found as missing_binary", () => {
    const result = classifier.classify(
      makePayload({ failure_desc: "Tool exec failed: command not found" }),
    );
    expect(result.root_cause).toBe("missing_binary");
    expect(result.propagation_targets).toContain("hook_pattern");
  });

  it("classifies ECONNREFUSED as network_failure", () => {
    const result = classifier.classify(
      makePayload({ failure_desc: "Tool exec failed: ECONNREFUSED" }),
    );
    expect(result.root_cause).toBe("network_failure");
  });

  it("classifies TypeScript error as type_error", () => {
    const result = classifier.classify(
      makePayload({ failure_desc: "TS2345: Argument of type 'string' is not assignable" }),
    );
    expect(result.root_cause).toBe("type_error");
    expect(result.propagation_targets).toContain("regression_test");
  });

  // CORRECT patterns
  it("classifies user 'wrong path' correction", () => {
    const result = classifier.classify(
      makePayload({
        type: "CORRECT",
        tier: 2,
        failure_desc: "User correction: that's the wrong path, use /opt/bin instead",
      }),
    );
    expect(result.root_cause).toBe("wrong_path");
  });

  it("classifies user 'outdated SOP' correction", () => {
    const result = classifier.classify(
      makePayload({
        type: "CORRECT",
        tier: 2,
        failure_desc: "User correction: that's an outdated SOP",
      }),
    );
    expect(result.root_cause).toBe("stale_sop");
  });

  it("classifies 'use this instead' correction", () => {
    const result = classifier.classify(
      makePayload({
        type: "CORRECT",
        tier: 2,
        failure_desc: "User correction: should be pnpm not npm",
      }),
    );
    expect(result.root_cause).toBe("incorrect_approach");
  });

  // SOP_VIOL
  it("classifies SOP violation as stale_sop_rule", () => {
    const result = classifier.classify(
      makePayload({ type: "SOP_VIOL", tier: 2, failure_desc: "Hook fired, SOP stale" }),
    );
    expect(result.root_cause).toBe("stale_sop_rule");
    expect(result.propagation_targets).toContain("hook_pattern");
  });

  // TRUST_DEM
  it("classifies trust demotion", () => {
    const result = classifier.classify(
      makePayload({ type: "TRUST_DEM", tier: 3, failure_desc: "Trust demotion: overstepped" }),
    );
    expect(result.root_cause).toBe("trust_boundary_crossed");
    expect(result.propagation_targets).toContain("regression_test");
  });

  // PIPE_FAIL
  it("classifies pipeline failure", () => {
    const result = classifier.classify(
      makePayload({ type: "PIPE_FAIL", tier: 3, failure_desc: "Pipeline stage build failed" }),
    );
    expect(result.root_cause).toBe("pipeline_stage_failure");
    expect(result.propagation_targets).toContain("synapse_relay");
  });

  // Fallback
  it("falls back to unknown for unrecognized TOOL_ERR", () => {
    const result = classifier.classify(
      makePayload({ failure_desc: "Some completely novel error XYZ123" }),
    );
    expect(result.root_cause).toBe("unknown");
    expect(result.propagation_targets).toEqual(["synapse_relay"]);
  });
});
