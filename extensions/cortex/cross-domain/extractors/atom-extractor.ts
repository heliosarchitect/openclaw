/**
 * Task-009: Cross-Domain Pattern Transfer — Atom Extractor
 *
 * Converts existing brain.db atoms into PatternFingerprints by mapping
 * causal structure to the 12-dim structural vector via keyword heuristics.
 */

import { randomUUID } from "node:crypto";
import type {
  DomainExtractor,
  DomainId,
  ExtractOptions,
  PatternFingerprint,
  StructuralVector,
} from "../types.js";

// ── Keyword Heuristic Maps ────────────────────────────────────────

const DIVERGENCE_KEYWORDS = [
  "diverge",
  "divergence",
  "diverging",
  "deviation",
  "separates",
  "separating",
  "deviates",
];
const REVERSION_KEYWORDS = [
  "revert",
  "reversion",
  "mean-revert",
  "reversal",
  "snap back",
  "regression",
];
const CASCADE_KEYWORDS = [
  "cascade",
  "chain",
  "propagat",
  "domino",
  "ripple",
  "contagion",
  "spillover",
];
const DECAY_KEYWORDS = ["decay", "fade", "diminish", "degrade", "erode", "weaken", "wane"];
const THRESHOLD_KEYWORDS = [
  "threshold",
  "breakpoint",
  "limit",
  "breach",
  "exceed",
  "overflow",
  "saturate",
];
const TREND_UP_KEYWORDS = ["accumulate", "increase", "rise", "grow", "bull", "long", "uptrend"];
const TREND_DOWN_KEYWORDS = ["decline", "decrease", "fall", "drop", "bear", "short", "downtrend"];
const OSCILLATION_KEYWORDS = ["oscillat", "cycle", "periodic", "wave", "alternating", "rhythm"];

function keywordScore(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits++;
  }
  return Math.min(1, hits / 2); // 2+ hits = max
}

/** Infer domain from atom categories or content */
function inferDomain(categories: string[], content: string): DomainId {
  const text = [...categories, content].join(" ").toLowerCase();
  if (
    text.includes("trading") ||
    text.includes("augur") ||
    text.includes("signal") ||
    text.includes("price")
  )
    return "trading";
  if (
    text.includes("radio") ||
    text.includes("ham") ||
    text.includes("propagation") ||
    text.includes("ft991")
  )
    return "radio";
  if (
    text.includes("fleet") ||
    text.includes("infra") ||
    text.includes("itsm") ||
    text.includes("server") ||
    text.includes("service")
  )
    return "fleet";
  return "meta";
}

/** Map an atom's causal text to a 12-dim structural vector */
function atomTextToStructure(
  subject: string,
  action: string,
  outcome: string,
  consequences: string,
): StructuralVector {
  const fullText = `${subject} ${action} ${outcome} ${consequences}`;

  const trendUp = keywordScore(fullText, TREND_UP_KEYWORDS);
  const trendDown = keywordScore(fullText, TREND_DOWN_KEYWORDS);

  return {
    trend_direction: trendUp - trendDown,
    trend_strength: Math.max(trendUp, trendDown),
    oscillation_frequency: keywordScore(fullText, OSCILLATION_KEYWORDS),
    reversion_force: keywordScore(fullText, REVERSION_KEYWORDS),
    divergence_magnitude: keywordScore(fullText, DIVERGENCE_KEYWORDS),
    divergence_polarity:
      keywordScore(fullText, DIVERGENCE_KEYWORDS) > 0
        ? keywordScore(fullText, REVERSION_KEYWORDS) > 0
          ? -0.5
          : 0.5
        : 0,
    threshold_proximity: keywordScore(fullText, THRESHOLD_KEYWORDS),
    cascade_potential: keywordScore(fullText, CASCADE_KEYWORDS),
    signal_decay_rate: keywordScore(fullText, DECAY_KEYWORDS),
    lead_time_normalized: extractLeadTime(consequences),
    effect_size: extractEffectSize(consequences),
    frequency_of_occurrence: 0.5, // default; refined in later passes
  };
}

/** Extract normalized lead time from text (e.g. "within 4h" → 0.4) */
function extractLeadTime(text: string): number {
  const match = text.match(/(\d+)\s*(?:h|hour|hr)/i);
  if (match) {
    const hours = parseInt(match[1], 10);
    return Math.min(1, hours / 24); // normalize against 24h max
  }
  const minMatch = text.match(/(\d+)\s*(?:m|min)/i);
  if (minMatch) {
    const mins = parseInt(minMatch[1], 10);
    return Math.min(1, mins / (24 * 60));
  }
  return 0;
}

/** Extract effect size from text (e.g. "82% WR" → 0.82, "+1.5%" → 0.75) */
function extractEffectSize(text: string): number {
  // Win rate
  const wrMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:WR|win|accuracy)/i);
  if (wrMatch) return parseFloat(wrMatch[1]) / 100;

  // Percentage return
  const pctMatch = text.match(/[+\-]?(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) return Math.min(1, parseFloat(pctMatch[1]) / 5); // normalize 5% = max

  return 0.3; // default moderate
}

// ── Atom DB Reader ────────────────────────────────────────────────

interface AtomRow {
  id: string;
  subject: string;
  action: string;
  outcome: string;
  consequences: string;
  confidence: number;
  created_at: string;
  categories?: string;
}

/** Read atoms from brain.db via sqlite3 CLI */
async function readAtoms(since?: string, limit = 500): Promise<AtomRow[]> {
  const { execSync } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const dbPath = `${homedir()}/.openclaw/workspace/memory/brain.db`;

  // Validate limit is a safe integer (SEC-001)
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit ?? 500)), 2000);

  let query = `SELECT id, subject, action, outcome, consequences, confidence, created_at FROM atoms`;

  // Validate `since` is ISO date format only — prevent SQL/shell injection (SEC-001)
  if (since && /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/.test(since)) {
    query += ` WHERE created_at > '${since}'`;
  }
  query += ` ORDER BY created_at DESC LIMIT ${safeLimit}`;

  try {
    const raw = execSync(`sqlite3 -json "${dbPath}" "${query.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    if (!raw.trim()) return [];
    return JSON.parse(raw) as AtomRow[];
  } catch {
    return [];
  }
}

// ── Extractor ─────────────────────────────────────────────────────

export class AtomExtractor implements DomainExtractor {
  // Atoms span multiple domains; we infer per-atom
  readonly domain = "meta" as const;
  readonly version = "1.0.0";

  async extract(options: ExtractOptions): Promise<PatternFingerprint[]> {
    const atoms = await readAtoms(options.since, options.limit ?? 500);
    const fingerprints: PatternFingerprint[] = [];

    for (const atom of atoms) {
      const domain = inferDomain(
        atom.categories?.split(",") ?? [],
        `${atom.subject} ${atom.action} ${atom.outcome}`,
      );

      fingerprints.push({
        fingerprint_id: randomUUID(),
        source_domain: domain,
        source_id: atom.id,
        source_type: "atom",
        label: `${atom.subject}: ${atom.action}`.slice(0, 120),
        confidence: atom.confidence ?? 0.7,
        structure: atomTextToStructure(atom.subject, atom.action, atom.outcome, atom.consequences),
        created_at: new Date().toISOString(),
        run_id: options.run_id,
      });
    }

    return fingerprints;
  }
}
