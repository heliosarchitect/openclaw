/**
 * Task-009: Cross-Domain Pattern Transfer — Reporter
 *
 * Generates run reports and writes artifacts to the pipeline directory.
 */

import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CDPTRunReport,
  CrossDomainHypothesis,
  CrossDomainMatch,
  CrossPollinationAlert,
  DomainMetaphor,
  PatternFingerprint,
} from "./types.js";

export interface CDPTRunData {
  report: CDPTRunReport;
  fingerprints: PatternFingerprint[];
  matches: CrossDomainMatch[];
  metaphors: DomainMetaphor[];
  alerts: CrossPollinationAlert[];
  hypotheses: CrossDomainHypothesis[];
}

const REPORTS_DIR = join(homedir(), "Projects/helios/extensions/cortex/reports");

/**
 * Write the full run data to a JSON report file.
 */
export async function writeRunReport(data: CDPTRunData): Promise<string> {
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const filename = `cross-domain-${data.report.run_id}.json`;
  const filepath = join(REPORTS_DIR, filename);

  await writeFile(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

/**
 * Format a human-readable summary for Synapse posting.
 */
export function formatSynapseSummary(data: CDPTRunData): string {
  const r = data.report;
  const lines: string[] = [
    `# CDPT Run Report — ${r.run_id}`,
    "",
    `**Duration:** ${(r.duration_ms / 1000).toFixed(1)}s | **Verdict:** ${r.verdict}`,
    `**Extractors:** ${r.extractors_run} | **Fingerprints:** ${r.fingerprints_created} created, ${r.fingerprints_rejected} rejected`,
    `**Matches:** ${r.matches_found} (${r.matches_structural} structural, ${r.matches_causal} causal, ${r.matches_temporal} temporal)`,
    `**Metaphors:** ${r.metaphors_generated} | **Alerts:** ${r.alerts_fired} | **Hypotheses:** ${r.hypotheses_generated}`,
  ];

  if (data.metaphors.length > 0) {
    lines.push("", "## Top Metaphors");
    for (const m of data.metaphors.slice(0, 5)) {
      lines.push(`- **${m.pattern_label}**: ${m.text}`);
    }
  }

  if (data.alerts.length > 0) {
    lines.push("", "## Cross-Pollination Alerts");
    for (const a of data.alerts) {
      lines.push(`- [${a.urgency.toUpperCase()}] ${a.transfer_recommendation}`);
    }
  }

  if (data.hypotheses.length > 0) {
    lines.push("", "## New Hypotheses");
    for (const h of data.hypotheses.slice(0, 5)) {
      lines.push(`- ${h.text}`);
    }
  }

  if (r.errors.length > 0) {
    lines.push("", "## Errors");
    for (const e of r.errors) {
      lines.push(`- [${e.stage}${e.extractor ? `/${e.extractor}` : ""}] ${e.message}`);
    }
  }

  return lines.join("\n");
}
