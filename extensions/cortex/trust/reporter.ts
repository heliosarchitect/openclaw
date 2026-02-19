/**
 * TrustReporter — CLI report + weekly Synapse summary generation
 * Earned Autonomy Phase 5.6
 */

import type Database from "better-sqlite3";
import type { RiskTier, TrustConfig } from "./types.js";
import { DEFAULT_TRUST_CONFIG, KNOWN_CATEGORIES } from "./types.js";

interface ScoreRow {
  category: string;
  risk_tier: number;
  current_score: number;
  decision_count: number;
  decisions_last_30d: number;
}

interface MilestoneRow {
  timestamp: string;
  category: string;
  milestone_type: string;
  old_score: number | null;
  new_score: number;
}

interface OverrideRow {
  category: string;
  override_type: string;
  reason: string;
  expires_at: string | null;
}

export class TrustReporter {
  private config: TrustConfig;

  constructor(
    private db: Database.Database,
    config?: Partial<TrustConfig>,
  ) {
    this.config = { ...DEFAULT_TRUST_CONFIG, ...config };
  }

  /**
   * Generate the trust-status CLI report.
   */
  generateReport(): string {
    const scores = this.db
      .prepare(`SELECT * FROM trust_scores ORDER BY risk_tier, category`)
      .all() as ScoreRow[];

    const overrides = this.db
      .prepare(
        `SELECT category, override_type, reason, expires_at FROM trust_overrides
         WHERE active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))`,
      )
      .all() as OverrideRow[];

    const recentMilestones = this.db
      .prepare(
        `SELECT timestamp, category, milestone_type, old_score, new_score
         FROM trust_milestones ORDER BY timestamp DESC LIMIT 10`,
      )
      .all() as MilestoneRow[];

    const totalDecisions = this.db.prepare(`SELECT COUNT(*) as cnt FROM decision_log`).get() as {
      cnt: number;
    };

    const now = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "short",
    });

    const lines: string[] = [];
    lines.push("EARNED AUTONOMY — TRUST REPORT");
    lines.push("━".repeat(60));
    lines.push(`Generated: ${now} | 30-day window | ${totalDecisions.cnt} decisions`);
    lines.push("");

    const tierLabels: Record<number, string> = {
      1: "READ-ONLY",
      2: "NON-DESTRUCTIVE",
      3: "INFRASTRUCTURE",
      4: "FINANCIAL",
    };

    const scoreMap = new Map(scores.map((s) => [s.category, s]));

    for (let tier = 1; tier <= 4; tier++) {
      const tierThreshold = this.config.tier_thresholds[tier] ?? 0;
      lines.push(
        `TIER ${tier} — ${tierLabels[tier]} (threshold: ${tier === 4 ? "hardcap" : `${Math.round(tierThreshold * 100)}%`})`,
      );

      const cats = KNOWN_CATEGORIES.filter((c) => c.tier === tier);
      for (const { category } of cats) {
        const s = scoreMap.get(category);
        if (tier === 4) {
          lines.push(`  ${category.padEnd(20)} (hardcap: never auto-approved)`);
          continue;
        }

        const score = s?.current_score ?? this.config.initial_scores[tier] ?? 0;
        const pct = Math.round(score * 100);
        const barLen = Math.round(score * 20);
        const bar = "█".repeat(barLen).padEnd(20);
        const decisions = s?.decision_count ?? 0;

        let status: string;
        if (score >= tierThreshold) {
          status = "✅ auto-approve";
        } else if (score >= (this.config.tier_floors[tier] ?? 0)) {
          status = "⏸ pause";
        } else {
          status = "🔴 blocked";
        }

        lines.push(
          `  ${category.padEnd(20)} ${bar} ${String(pct).padStart(3)}%  ${status}  [${decisions} decisions]`,
        );
      }
      lines.push("");
    }

    // Overrides
    lines.push("OVERRIDES ACTIVE");
    if (overrides.length === 0) {
      lines.push("  [none]");
    } else {
      for (const o of overrides) {
        const expiry = o.expires_at
          ? `expires ${new Date(o.expires_at).toLocaleString("en-US", { timeZone: "America/New_York", timeStyle: "short" })}`
          : "permanent";
        lines.push(`  ${o.override_type.toUpperCase()} ${o.category} — ${o.reason} (${expiry})`);
      }
    }
    lines.push("");

    // Recent milestones
    lines.push("RECENT MILESTONES");
    if (recentMilestones.length === 0) {
      lines.push("  [none yet]");
    } else {
      for (const m of recentMilestones) {
        const ts = new Date(m.timestamp).toLocaleString("en-US", {
          timeZone: "America/New_York",
          dateStyle: "short",
          timeStyle: "short",
        });
        const scoreChange =
          m.old_score != null
            ? `${Math.round(m.old_score * 100)}%→${Math.round(m.new_score * 100)}%`
            : `${Math.round(m.new_score * 100)}%`;
        lines.push(`  ${ts}  ${m.category} ${scoreChange} → ${m.milestone_type}`);
      }
    }
    lines.push("━".repeat(60));

    return lines.join("\n");
  }

  /**
   * Generate weekly Synapse summary text.
   */
  generateWeeklySummary(): string {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    const milestones = this.db
      .prepare(`SELECT * FROM trust_milestones WHERE timestamp >= ? ORDER BY timestamp`)
      .all(weekAgo) as MilestoneRow[];

    const outcomeBreakdown = this.db
      .prepare(
        `SELECT outcome, COUNT(*) as cnt FROM decision_log
         WHERE timestamp >= ? AND outcome != 'pending'
         GROUP BY outcome`,
      )
      .all(weekAgo) as Array<{ outcome: string; cnt: number }>;

    const totalDecisions = outcomeBreakdown.reduce((s, r) => s + r.cnt, 0);

    const lines: string[] = [];
    lines.push("EARNED AUTONOMY — WEEKLY TRUST SUMMARY");
    lines.push(
      `Week ending ${new Date().toISOString().split("T")[0]} | ${totalDecisions} decisions tracked`,
    );
    lines.push("");

    const promotions = milestones.filter(
      (m) => m.milestone_type === "first_auto_approve" || m.milestone_type === "tier_promotion",
    );
    const demotions = milestones.filter((m) => m.milestone_type === "tier_demotion");
    const blocks = milestones.filter((m) => m.milestone_type === "blocked");

    lines.push("PROMOTIONS:");
    if (promotions.length === 0) lines.push("  [none]");
    for (const m of promotions) {
      lines.push(
        `  ✅ ${m.category}: ${m.old_score != null ? Math.round(m.old_score * 100) : "?"}% → ${Math.round(m.new_score * 100)}% (${m.milestone_type})`,
      );
    }

    lines.push("\nDEMOTIONS:");
    if (demotions.length === 0) lines.push("  [none]");
    for (const m of demotions) {
      lines.push(
        `  ⬇️ ${m.category}: ${m.old_score != null ? Math.round(m.old_score * 100) : "?"}% → ${Math.round(m.new_score * 100)}%`,
      );
    }

    lines.push("\nBLOCKS:");
    if (blocks.length === 0) lines.push("  [none]");
    for (const m of blocks) {
      lines.push(`  🔴 ${m.category}: score ${Math.round(m.new_score * 100)}%`);
    }

    lines.push("\nOUTCOME BREAKDOWN:");
    for (const { outcome, cnt } of outcomeBreakdown) {
      const pct = totalDecisions > 0 ? Math.round((cnt / totalDecisions) * 100) : 0;
      lines.push(`  ${outcome}: ${cnt} (${pct}%)`);
    }

    return lines.join("\n");
  }
}
