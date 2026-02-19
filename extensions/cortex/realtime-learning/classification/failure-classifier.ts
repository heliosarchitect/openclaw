/**
 * Real-Time Learning — Failure Classifier
 * Cortex v2.6.0 (task-011)
 *
 * Rule-based, deterministic classification. No LLM in the hot path.
 * Maps failure events to root cause labels and propagation targets.
 */

import type {
  ClassificationResult,
  ClassificationRule,
  DetectionPayload,
  PropagationTarget,
} from "../types.js";

const RULES: ClassificationRule[] = [
  // TOOL_ERR patterns (order matters — more specific first)
  {
    type: "TOOL_ERR",
    rootCausePattern: /command not found|not a valid command/i,
    rootCauseLabel: "missing_binary",
    propagationTargets: ["sop_patch", "hook_pattern", "atom"],
  },
  {
    type: "TOOL_ERR",
    rootCausePattern: /permission denied|EACCES/i,
    rootCauseLabel: "permissions",
    propagationTargets: ["sop_patch", "atom"],
  },
  {
    type: "TOOL_ERR",
    rootCausePattern: /ENOENT|No such file|not found/i,
    rootCauseLabel: "wrong_path",
    propagationTargets: ["hook_pattern", "atom", "sop_patch"],
  },
  {
    type: "TOOL_ERR",
    rootCausePattern: /ECONNREFUSED|ETIMEDOUT|socket hang up/i,
    rootCauseLabel: "network_failure",
    propagationTargets: ["atom", "synapse_relay"],
  },
  {
    type: "TOOL_ERR",
    rootCausePattern: /syntax error|unexpected token|SyntaxError/i,
    rootCauseLabel: "syntax_error",
    propagationTargets: ["atom", "regression_test"],
  },
  {
    type: "TOOL_ERR",
    rootCausePattern: /TypeScript|TS\d{4}|type.*not assignable/i,
    rootCauseLabel: "type_error",
    propagationTargets: ["atom", "regression_test"],
  },

  // CORRECT patterns
  {
    type: "CORRECT",
    rootCausePattern: /wrong path|incorrect path/i,
    rootCauseLabel: "wrong_path",
    propagationTargets: ["sop_patch", "atom"],
  },
  {
    type: "CORRECT",
    rootCausePattern: /outdated SOP|stale SOP|that SOP/i,
    rootCauseLabel: "stale_sop",
    propagationTargets: ["sop_patch", "regression_test"],
  },
  {
    type: "CORRECT",
    rootCausePattern: /wrong (?:binary|command|tool)/i,
    rootCauseLabel: "wrong_binary",
    propagationTargets: ["sop_patch", "hook_pattern", "atom"],
  },
  {
    type: "CORRECT",
    rootCausePattern: /should be|use this instead|use .+ instead/i,
    rootCauseLabel: "incorrect_approach",
    propagationTargets: ["sop_patch", "atom"],
  },

  // SOP_VIOL — always stale_sop_rule
  {
    type: "SOP_VIOL",
    rootCauseLabel: "stale_sop_rule",
    propagationTargets: ["sop_patch", "hook_pattern", "atom"],
  },

  // TRUST_DEM — always trust_boundary_crossed
  {
    type: "TRUST_DEM",
    rootCauseLabel: "trust_boundary_crossed",
    propagationTargets: ["sop_patch", "regression_test", "atom"],
  },

  // PIPE_FAIL — always pipeline_stage_failure
  {
    type: "PIPE_FAIL",
    rootCauseLabel: "pipeline_stage_failure",
    propagationTargets: ["regression_test", "synapse_relay"],
  },
];

export class FailureClassifier {
  /**
   * Classify a detection payload into a root cause and propagation targets.
   * Deterministic — always returns a result (falls back to 'unknown').
   */
  classify(payload: DetectionPayload): ClassificationResult {
    for (const rule of RULES) {
      if (rule.type !== "*" && rule.type !== payload.type) continue;

      if (rule.rootCausePattern) {
        const textToSearch = `${payload.failure_desc} ${payload.raw_input ?? ""}`;
        if (!rule.rootCausePattern.test(textToSearch)) continue;
      }

      return {
        root_cause: rule.rootCauseLabel,
        propagation_targets: [...rule.propagationTargets],
      };
    }

    // Fallback: unknown root cause → escalate via Synapse
    return {
      root_cause: "unknown",
      propagation_targets: ["synapse_relay"],
    };
  }
}
