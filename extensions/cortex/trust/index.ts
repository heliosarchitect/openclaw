/**
 * Earned Autonomy — Progressive Trust System
 * Cortex Phase 5.6
 *
 * Main barrel export. Pre-action hook integration point.
 */

export { ActionClassifier, classify } from "./classifier.js";
export { TrustGate } from "./gate.js";
export { MilestoneDetector } from "./milestone-detector.js";
export { runMigration } from "./migration.js";
export { OutcomeCollector, detectCorrectionSeverity } from "./outcome-collector.js";
export { OverrideManager } from "./override-manager.js";
export { TrustReporter } from "./reporter.js";
export { ScoreUpdater, updateScore } from "./score-updater.js";
export type {
  Classification,
  ClassificationRule,
  DecisionRecord,
  GateDecision,
  GateResult,
  MilestoneType,
  Outcome,
  OutcomeSource,
  OverrideType,
  RiskTier,
  TrustConfig,
  TrustMilestone,
  TrustOverride,
  TrustScore,
} from "./types.js";
export { DEFAULT_TRUST_CONFIG, KNOWN_CATEGORIES, OUTCOME_VALUES } from "./types.js";
