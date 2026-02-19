/**
 * Task-009: Cross-Domain Pattern Transfer — Memory Extractor
 *
 * Converts cortex memories (especially high-importance and compressed ones)
 * into PatternFingerprints using keyword heuristics.
 */

import { randomUUID } from "node:crypto";
import type {
  DomainExtractor,
  DomainId,
  ExtractOptions,
  PatternFingerprint,
  StructuralVector,
} from "../types.js";

interface MemoryRow {
  id: string;
  content: string;
  categories: string;
  importance: number;
  timestamp: string;
}

/** Infer domain from memory categories */
function inferDomain(categories: string[]): DomainId {
  const cats = categories.map((c) => c.toLowerCase());
  if (cats.some((c) => c.includes("trading") || c.includes("augur") || c.includes("signals")))
    return "trading";
  if (cats.some((c) => c.includes("radio") || c.includes("ham"))) return "radio";
  if (cats.some((c) => c.includes("fleet") || c.includes("infrastructure") || c.includes("system")))
    return "fleet";
  return "meta";
}

/** Simple keyword-based structure extraction from memory content */
function contentToStructure(content: string): StructuralVector {
  const lower = content.toLowerCase();
  const has = (kws: string[]) => {
    let hits = 0;
    for (const kw of kws) if (lower.includes(kw)) hits++;
    return Math.min(1, hits / 2);
  };

  const up = has(["increase", "rise", "growth", "accumulate", "bull", "long", "improve"]);
  const down = has(["decrease", "fall", "decline", "drop", "bear", "short", "degrade"]);

  return {
    trend_direction: up - down,
    trend_strength: Math.max(up, down),
    oscillation_frequency: has(["cycle", "oscillat", "periodic", "wave", "rhythm"]),
    reversion_force: has(["revert", "reversion", "reversal", "snap back", "mean-revert"]),
    divergence_magnitude: has(["diverge", "divergence", "deviation", "separate"]),
    divergence_polarity: has(["diverge"]) > 0 ? (has(["revert", "reversal"]) > 0 ? -0.5 : 0.5) : 0,
    threshold_proximity: has(["threshold", "breach", "limit", "exceed", "overflow"]),
    cascade_potential: has(["cascade", "chain", "propagat", "domino", "ripple"]),
    signal_decay_rate: has(["decay", "fade", "diminish", "degrade", "erode"]),
    lead_time_normalized: 0.3, // default for memories
    effect_size: has(["significant", "major", "critical", "breakthrough", "strong"]),
    frequency_of_occurrence: 0.5,
  };
}

async function readMemories(since?: string, limit = 200): Promise<MemoryRow[]> {
  const { execSync } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const dbPath = `${homedir()}/.openclaw/workspace/memory/brain.db`;

  let query = `SELECT id, content, categories, importance, created_at as timestamp FROM stm WHERE importance >= 2.0`;
  if (since) {
    query += ` AND created_at > '${since}'`;
  }
  query += ` ORDER BY importance DESC, timestamp DESC LIMIT ${limit}`;

  try {
    const raw = execSync(`sqlite3 -json "${dbPath}" "${query}"`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    if (!raw.trim()) return [];
    return JSON.parse(raw) as MemoryRow[];
  } catch {
    return [];
  }
}

export class MemoryExtractor implements DomainExtractor {
  readonly domain = "meta" as const;
  readonly version = "1.0.0";

  async extract(options: ExtractOptions): Promise<PatternFingerprint[]> {
    const memories = await readMemories(options.since, options.limit ?? 200);
    const fingerprints: PatternFingerprint[] = [];

    for (const mem of memories) {
      const categories = mem.categories ? mem.categories.split(",").map((c) => c.trim()) : [];
      const domain = inferDomain(categories);

      fingerprints.push({
        fingerprint_id: randomUUID(),
        source_domain: domain,
        source_id: mem.id,
        source_type: "memory",
        label: mem.content.slice(0, 120),
        confidence: Math.min(1, mem.importance / 3), // normalize importance to confidence
        structure: contentToStructure(mem.content),
        created_at: new Date().toISOString(),
        run_id: options.run_id,
      });
    }

    return fingerprints;
  }
}
