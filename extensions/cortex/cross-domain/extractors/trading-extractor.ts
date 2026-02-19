/**
 * Task-009: Cross-Domain Pattern Transfer — Trading Extractor
 *
 * Reads AUGUR signal database and converts validated signals
 * into PatternFingerprints.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type {
  DomainExtractor,
  ExtractOptions,
  PatternFingerprint,
  StructuralVector,
} from "../types.js";
import { assertNotBrainDb, validateDbPath } from "../utils.js";

interface SignalRow {
  id?: string;
  product: string;
  signal_name: string;
  direction: string;
  win_rate: number;
  avg_return: number;
  total_signals: number;
  avg_duration_mins?: number;
}

function signalToStructure(signal: SignalRow): StructuralVector {
  const isShort = signal.direction?.toLowerCase() === "short";
  const wr = signal.win_rate ?? 0;
  const ret = Math.abs(signal.avg_return ?? 0);

  // Infer pattern type from signal name
  const name = (signal.signal_name ?? "").toLowerCase();
  const hasDivergence = name.includes("div") || name.includes("vwap") || name.includes("deviation");
  const hasMomentum = name.includes("momentum") || name.includes("macd") || name.includes("rsi");
  const hasReversion =
    name.includes("revert") ||
    name.includes("bounce") ||
    name.includes("oversold") ||
    name.includes("overbought");

  return {
    trend_direction: isShort ? -0.7 : 0.7,
    trend_strength: Math.min(1, ret / 2), // 2% return = max strength
    oscillation_frequency: hasMomentum ? 0.6 : 0.2,
    reversion_force: hasReversion ? 0.8 : hasDivergence ? 0.5 : 0.1,
    divergence_magnitude: hasDivergence ? 0.8 : 0.2,
    divergence_polarity: hasDivergence ? (isShort ? -0.7 : 0.7) : 0,
    threshold_proximity: 0.3, // trading signals are threshold-adjacent by nature
    cascade_potential: 0.2, // single-product signals, low cascade
    signal_decay_rate: signal.avg_duration_mins
      ? Math.min(1, signal.avg_duration_mins / 240) // 4h = max
      : 0.4,
    lead_time_normalized: 0.3, // typical signal lead
    effect_size: Math.min(1, wr), // win rate as effect size
    frequency_of_occurrence: Math.min(1, (signal.total_signals ?? 0) / 100),
  };
}

async function readSignals(limit = 200): Promise<SignalRow[]> {
  const { execSync } = await import("node:child_process");
  const rawPath =
    process.env.AUGUR_DB_PATH ?? `${homedir()}/Projects/augur-trading/data/signals.db`;

  // SEC-002: validate path has no shell metacharacters
  // SEC-003: refuse if pointed at brain.db
  let dbPath: string;
  try {
    dbPath = validateDbPath(rawPath, "AUGUR_DB_PATH");
    assertNotBrainDb(dbPath);
  } catch (err: any) {
    console.warn(`[TradingExtractor] ${err?.message}`);
    return [];
  }

  if (!existsSync(dbPath)) return [];

  // Ensure limit is a safe integer
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit ?? 200)), 1000);

  // Try common table names
  for (const table of ["validated_signals", "signals", "vip2_signals"]) {
    try {
      const raw = execSync(
        `sqlite3 -json "${dbPath}" "SELECT * FROM ${table} ORDER BY win_rate DESC LIMIT ${safeLimit}"`,
        { encoding: "utf-8", timeout: 10000 },
      );
      if (raw.trim()) return JSON.parse(raw) as SignalRow[];
    } catch {
      continue;
    }
  }
  return [];
}

export class TradingExtractor implements DomainExtractor {
  readonly domain = "trading" as const;
  readonly version = "1.0.0";

  async extract(options: ExtractOptions): Promise<PatternFingerprint[]> {
    const signals = await readSignals(options.limit ?? 200);
    const fingerprints: PatternFingerprint[] = [];

    for (const signal of signals) {
      const id = signal.id ?? `${signal.product}-${signal.signal_name}-${signal.direction}`;
      fingerprints.push({
        fingerprint_id: randomUUID(),
        source_domain: "trading",
        source_id: String(id),
        source_type: "signal",
        label: `${signal.product} ${signal.direction} ${signal.signal_name}`.slice(0, 120),
        confidence: Math.min(1, signal.win_rate ?? 0.5),
        structure: signalToStructure(signal),
        created_at: new Date().toISOString(),
        run_id: options.run_id,
      });
    }

    return fingerprints;
  }
}
