/**
 * Task-009: Cross-Domain Pattern Transfer — Main Orchestrator
 * Phase 5.5 of IMPROVEMENT_PLAN
 *
 * Coordinates: Extract → Normalize → Match → Synthesize → Report
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CDPTRunData } from "./reporter.js";
import type {
  CDPTConfig,
  CDPTError,
  CDPTRunReport,
  DomainExtractor,
  PatternFingerprint,
} from "./types.js";
import { ExtractorRegistry } from "./extractor-registry.js";
import { AtomExtractor } from "./extractors/atom-extractor.js";
import { FleetExtractor } from "./extractors/fleet-extractor.js";
import { MemoryExtractor } from "./extractors/memory-extractor.js";
import { RadioExtractor } from "./extractors/radio-extractor.js";
import { TradingExtractor } from "./extractors/trading-extractor.js";
import { findMatches } from "./matcher.js";
import { normalizeFingerprints } from "./normalizer.js";
// ── Import Extractors ─────────────────────────────────────────────
import { writeRunReport, formatSynapseSummary } from "./reporter.js";
import { generateAlerts } from "./synthesizers/alert-generator.js";
import { generateHypotheses } from "./synthesizers/hypothesis-generator.js";
import { generateMetaphors } from "./synthesizers/metaphor-engine.js";
import { DEFAULT_CONFIG } from "./types.js";

// ── Config ────────────────────────────────────────────────────────

async function loadConfig(): Promise<CDPTConfig> {
  const configPath = join(
    homedir(),
    "Projects/helios/extensions/cortex/cross-domain/cdpt-config.json",
  );
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, "utf-8");
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      // fall through to defaults
    }
  }
  return DEFAULT_CONFIG;
}

// ── Build Atom Index ──────────────────────────────────────────────

async function buildAtomIndex(): Promise<Set<string>> {
  const { execSync } = await import("node:child_process");
  const dbPath = `${homedir()}/.openclaw/workspace/memory/brain.db`;
  try {
    const raw = execSync(`sqlite3 -json "${dbPath}" "SELECT id FROM atoms"`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    if (!raw.trim()) return new Set();
    const rows = JSON.parse(raw) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  } catch {
    return new Set();
  }
}

// ── Main Engine ───────────────────────────────────────────────────

export async function runCDPT(): Promise<CDPTRunData> {
  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const errors: CDPTError[] = [];
  const config = await loadConfig();

  console.log(`[CDPT] Starting run ${runId}...`);

  // 1. Register extractors
  const registry = new ExtractorRegistry();
  const extractors: DomainExtractor[] = [
    new AtomExtractor(),
    new MemoryExtractor(),
    new TradingExtractor(),
    new RadioExtractor(),
    new FleetExtractor(),
  ];

  for (const ext of extractors) {
    if (config.enabled_extractors && !config.enabled_extractors.includes(ext.domain)) continue;
    registry.register(ext);
  }

  // 2. Extract fingerprints from all domains
  const rawFingerprints: PatternFingerprint[] = [];
  let extractorsRun = 0;

  for (const extractor of registry.getAll()) {
    try {
      console.log(`[CDPT] Running ${extractor.domain} extractor v${extractor.version}...`);
      const fps = await extractor.extract({ run_id: runId });
      rawFingerprints.push(...fps);
      extractorsRun++;
      console.log(`[CDPT]   → ${fps.length} fingerprints extracted`);
    } catch (err: any) {
      errors.push({
        stage: "extract",
        extractor: extractor.domain,
        message: err?.message ?? String(err),
        timestamp: new Date().toISOString(),
      });
      console.error(`[CDPT] Error in ${extractor.domain} extractor: ${err?.message}`);
    }
  }

  // 3. Normalize
  console.log(`[CDPT] Normalizing ${rawFingerprints.length} fingerprints...`);
  const { accepted, rejected } = normalizeFingerprints(rawFingerprints, config);
  console.log(`[CDPT]   → ${accepted.length} accepted, ${rejected.length} rejected`);

  // 4. Match across domains
  console.log(`[CDPT] Finding cross-domain matches...`);
  const atomIndex = await buildAtomIndex();
  const matches = findMatches(accepted, { config, atomIndex });
  console.log(`[CDPT]   → ${matches.length} matches found`);

  // 5. Build fingerprint index for synthesis
  const fpIndex = new Map<string, PatternFingerprint>();
  for (const fp of accepted) fpIndex.set(fp.fingerprint_id, fp);

  // 6. Synthesize
  console.log(`[CDPT] Generating metaphors...`);
  const metaphors = generateMetaphors(matches, fpIndex);

  console.log(`[CDPT] Generating alerts...`);
  const alerts = generateAlerts(matches, fpIndex);

  console.log(`[CDPT] Generating hypotheses...`);
  const hypotheses = generateHypotheses(matches, fpIndex, config.max_hypotheses_per_run);

  // 7. Build report
  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  const matchesByType = { structural: 0, causal: 0, temporal: 0 };
  for (const m of matches) matchesByType[m.match_type]++;

  const report: CDPTRunReport = {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    extractors_run: extractorsRun,
    fingerprints_created: accepted.length,
    fingerprints_rejected: rejected.length,
    matches_found: matches.length,
    matches_structural: matchesByType.structural,
    matches_causal: matchesByType.causal,
    matches_temporal: matchesByType.temporal,
    metaphors_generated: metaphors.length,
    alerts_fired: alerts.length,
    hypotheses_generated: hypotheses.length,
    errors,
    verdict: errors.length === 0 ? "PASS" : accepted.length > 0 ? "PARTIAL" : "FAIL",
  };

  const runData: CDPTRunData = {
    report,
    fingerprints: accepted,
    matches,
    metaphors,
    alerts,
    hypotheses,
  };

  // 8. Write report
  const reportPath = await writeRunReport(runData);
  console.log(`[CDPT] Report written to ${reportPath}`);
  console.log(
    `[CDPT] Run ${runId} complete — ${report.verdict} in ${(durationMs / 1000).toFixed(1)}s`,
  );
  console.log(formatSynapseSummary(runData));

  return runData;
}

// ── CLI Entry Point ───────────────────────────────────────────────

if (process.argv[1]?.endsWith("cdpt-engine.ts")) {
  runCDPT()
    .then((data) => {
      process.exit(data.report.verdict === "FAIL" ? 1 : 0);
    })
    .catch((err) => {
      console.error(`[CDPT] Fatal error: ${err}`);
      process.exit(1);
    });
}
