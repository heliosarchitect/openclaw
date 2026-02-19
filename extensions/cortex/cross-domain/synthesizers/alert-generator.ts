/**
 * Task-009: Cross-Domain Pattern Transfer — Cross-Pollination Alert Generator
 *
 * Fires when a high-confidence pattern in one domain finds a structural match
 * in another domain where it hasn't been tested (transfer_opportunity = true).
 */

import { randomUUID } from "node:crypto";
import type { CrossDomainMatch, CrossPollinationAlert, PatternFingerprint } from "../types.js";

const DOMAIN_NAMES: Record<string, string> = {
  trading: "trading/AUGUR",
  radio: "ham radio",
  fleet: "fleet infrastructure",
  meta: "AI/Cortex",
};

/**
 * Generate a transfer recommendation from match context.
 * Template-based for v1; can be upgraded to LLM-assisted later.
 */
function generateRecommendation(source: PatternFingerprint, target: PatternFingerprint): string {
  const srcDomain = DOMAIN_NAMES[source.source_domain] ?? source.source_domain;
  const tgtDomain = DOMAIN_NAMES[target.source_domain] ?? target.source_domain;

  return (
    `Pattern "${source.label}" (confidence ${(source.confidence * 100).toFixed(0)}% in ${srcDomain}) ` +
    `structurally matches "${target.label}" in ${tgtDomain} ` +
    `(confidence only ${(target.confidence * 100).toFixed(0)}%). ` +
    `Consider applying the validated logic from ${srcDomain} to test this pattern in ${tgtDomain}.`
  );
}

/**
 * Generate cross-pollination alerts for transfer opportunities.
 * Only fires for causal or temporal matches with transfer_opportunity = true.
 */
export function generateAlerts(
  matches: CrossDomainMatch[],
  fingerprintIndex: Map<string, PatternFingerprint>,
): CrossPollinationAlert[] {
  const alerts: CrossPollinationAlert[] = [];

  for (const match of matches) {
    if (!match.transfer_opportunity) continue;
    if (match.match_type === "structural") continue; // only causal + temporal

    const fpA = fingerprintIndex.get(match.fingerprint_a_id);
    const fpB = fingerprintIndex.get(match.fingerprint_b_id);
    if (!fpA || !fpB) continue;

    // Determine source (high confidence) and target (low confidence)
    const [source, target] = fpA.confidence >= fpB.confidence ? [fpA, fpB] : [fpB, fpA];

    const urgency = source.confidence >= 0.85 ? "action" : "info";

    alerts.push({
      alert_id: randomUUID(),
      match_id: match.match_id,
      source_domain: source.source_domain,
      source_pattern: source.label,
      source_confidence: source.confidence,
      target_domain: target.source_domain,
      target_pattern: target.label,
      target_confidence: target.confidence,
      transfer_recommendation: generateRecommendation(source, target),
      urgency,
      created_at: new Date().toISOString(),
    });
  }

  return alerts;
}
