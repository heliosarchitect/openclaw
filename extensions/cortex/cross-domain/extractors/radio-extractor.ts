/**
 * Task-009: Cross-Domain Pattern Transfer — Radio Extractor
 *
 * Reads ft991a-control logs and propagation data.
 * Runs in bootstrap mode (confidence capped at 0.3) when < 20 observations.
 */

import { randomUUID } from "node:crypto";
import type {
  DomainExtractor,
  ExtractOptions,
  PatternFingerprint,
  StructuralVector,
} from "../types.js";

/** Bootstrap mode: generate seed fingerprints from known radio patterns */
function getBootstrapPatterns(runId: string): PatternFingerprint[] {
  const now = new Date().toISOString();
  const BOOTSTRAP_CONFIDENCE = 0.3;

  const patterns: Array<{ label: string; structure: StructuralVector }> = [
    {
      label: "Solar flux divergence from 30-day mean → propagation change",
      structure: {
        trend_direction: 0,
        trend_strength: 0.4,
        oscillation_frequency: 0.3,
        reversion_force: 0.7,
        divergence_magnitude: 0.8,
        divergence_polarity: -0.5,
        threshold_proximity: 0.5,
        cascade_potential: 0.3,
        signal_decay_rate: 0.4,
        lead_time_normalized: 0.5,
        effect_size: 0.6,
        frequency_of_occurrence: 0.4,
      },
    },
    {
      label: "10m band opening/closing cycle — diurnal propagation window",
      structure: {
        trend_direction: 0,
        trend_strength: 0.3,
        oscillation_frequency: 0.9,
        reversion_force: 0.6,
        divergence_magnitude: 0.2,
        divergence_polarity: 0,
        threshold_proximity: 0.4,
        cascade_potential: 0.1,
        signal_decay_rate: 0.6,
        lead_time_normalized: 0.4,
        effect_size: 0.7,
        frequency_of_occurrence: 0.8,
      },
    },
    {
      label: "Signal fade event — leading indicator separates from baseline",
      structure: {
        trend_direction: -0.6,
        trend_strength: 0.5,
        oscillation_frequency: 0.2,
        reversion_force: 0.4,
        divergence_magnitude: 0.7,
        divergence_polarity: 0.6,
        threshold_proximity: 0.6,
        cascade_potential: 0.2,
        signal_decay_rate: 0.7,
        lead_time_normalized: 0.3,
        effect_size: 0.5,
        frequency_of_occurrence: 0.3,
      },
    },
    {
      label: "K-index spike → HF blackout cascade",
      structure: {
        trend_direction: -0.8,
        trend_strength: 0.8,
        oscillation_frequency: 0.1,
        reversion_force: 0.3,
        divergence_magnitude: 0.4,
        divergence_polarity: 0.3,
        threshold_proximity: 0.9,
        cascade_potential: 0.8,
        signal_decay_rate: 0.5,
        lead_time_normalized: 0.2,
        effect_size: 0.9,
        frequency_of_occurrence: 0.2,
      },
    },
  ];

  return patterns.map((p) => ({
    fingerprint_id: randomUUID(),
    source_domain: "radio" as const,
    source_id: `bootstrap-radio-${p.label.slice(0, 30).replace(/\s/g, "-")}`,
    source_type: "event" as const,
    label: p.label,
    confidence: BOOTSTRAP_CONFIDENCE,
    structure: p.structure,
    created_at: now,
    run_id: runId,
  }));
}

export class RadioExtractor implements DomainExtractor {
  readonly domain = "radio" as const;
  readonly version = "1.0.0";

  async extract(options: ExtractOptions): Promise<PatternFingerprint[]> {
    // TODO: when ft991a-control logbook (task-012) is built, read actual QSO/propagation data
    // For now: bootstrap mode with known radio pattern archetypes
    return getBootstrapPatterns(options.run_id);
  }
}
