/**
 * Task-009: Cross-Domain Pattern Transfer — Hypothesis Generator
 *
 * For causal and temporal matches, generates testable hypotheses
 * by combining mechanisms across domains.
 */

import { randomUUID } from "node:crypto";
import type { CrossDomainHypothesis, CrossDomainMatch, PatternFingerprint } from "../types.js";

const DOMAIN_OBSERVATION_METHODS: Record<string, string> = {
  trading: "monitoring AUGUR signal database for matching pattern occurrences",
  radio: "logging signal strength reports and propagation events on ft991a-control",
  fleet: "tracking ITSM events and service health metrics for the predicted pattern",
  meta: "observing cortex memory patterns and atom graph changes",
};

/**
 * Generate a testable hypothesis from a cross-domain match.
 * Template: IF [mechanism from A] operates similarly in [B],
 *           THEN [predicted outcome in B] — testable by [method].
 */
function generateHypothesisText(source: PatternFingerprint, target: PatternFingerprint): string {
  const srcMethod = source.label;
  const tgtDomain = target.source_domain;
  const tgtPattern = target.label;
  const testMethod = DOMAIN_OBSERVATION_METHODS[tgtDomain] ?? "direct observation";

  return (
    `HYPOTHESIS [UNVALIDATED]: IF the mechanism behind "${srcMethod}" ` +
    `(validated in ${source.source_domain}) operates similarly in ${tgtDomain}, ` +
    `THEN "${tgtPattern}" should exhibit analogous behavior with predictable timing — ` +
    `testable by ${testMethod}.`
  );
}

/**
 * Generate hypotheses for causal and temporal matches.
 * Capped at maxHypotheses per run.
 */
export function generateHypotheses(
  matches: CrossDomainMatch[],
  fingerprintIndex: Map<string, PatternFingerprint>,
  maxHypotheses = 10,
): CrossDomainHypothesis[] {
  const hypotheses: CrossDomainHypothesis[] = [];

  // Prioritize causal > temporal, higher similarity first
  const eligible = matches
    .filter((m) => m.match_type === "causal" || m.match_type === "temporal")
    .sort((a, b) => b.similarity_score - a.similarity_score);

  for (const match of eligible) {
    if (hypotheses.length >= maxHypotheses) break;

    const fpA = fingerprintIndex.get(match.fingerprint_a_id);
    const fpB = fingerprintIndex.get(match.fingerprint_b_id);
    if (!fpA || !fpB) continue;

    // Source = higher confidence
    const [source, target] = fpA.confidence >= fpB.confidence ? [fpA, fpB] : [fpB, fpA];

    hypotheses.push({
      hypothesis_id: randomUUID(),
      match_id: match.match_id,
      text: generateHypothesisText(source, target),
      source_domain: source.source_domain,
      target_domain: target.source_domain,
      status: "unvalidated",
      confidence: 0.6, // cross-domain transfer confidence start
      created_at: new Date().toISOString(),
    });
  }

  return hypotheses;
}
