/**
 * OutcomeCollector — Feedback window management + correction detection
 * Earned Autonomy Phase 5.6
 *
 * Runs as a background sweep (every 60s). Resolves pending outcomes
 * by either detecting corrections or expiring the feedback window.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Outcome, RiskTier, TrustConfig } from "./types.js";
import { updateScore } from "./score-updater.js";
import { DEFAULT_TRUST_CONFIG } from "./types.js";

// ──────────────────────────────────────────────────────
// Correction Detection (rule-based, no LLM)
// ──────────────────────────────────────────────────────

const SIGNIFICANT_PATTERNS =
  /\b(broke|crash(?:ed)?|critical|revert|disaster|lost\s+data|corrupted|destroyed)\b/i;
// H2 mitigation: narrowed MINOR_PATTERNS — removed bare "no" which is too common in normal conversation.
// Bare "no" now only counts when accompanied by correction context (handled by SIGNIFICANT_PATTERNS
// or by more specific phrases below). This prevents score drift from conversational messages.
const MINOR_PATTERNS =
  /\b(wrong|not\s+right|undo|different|fix\s+that|that'?s\s+wrong|shouldn'?t\s+have|redo|that\s+was\s+wrong|don'?t\s+do\s+that|bad\s+move|incorrect)\b/i;

export type CorrectionSeverity = "minor" | "significant" | null;

export function detectCorrectionSeverity(text: string): CorrectionSeverity {
  if (SIGNIFICANT_PATTERNS.test(text)) return "significant";
  if (MINOR_PATTERNS.test(text)) return "minor";
  return null;
}

// ──────────────────────────────────────────────────────
// Outcome Collector
// ──────────────────────────────────────────────────────

export class OutcomeCollector {
  private config: TrustConfig;

  constructor(
    private db: Database.Database,
    config?: Partial<TrustConfig>,
  ) {
    this.config = { ...DEFAULT_TRUST_CONFIG, ...config };
  }

  /**
   * Resolve a specific decision with an outcome.
   * Updates decision_log and trust_scores via EWMA.
   */
  resolveOutcome(
    decisionId: string,
    outcome: Outcome,
    source: string,
    correctionMessage: string | null = null,
  ): { oldScore: number; newScore: number; category: string; tier: RiskTier } | null {
    const row = this.db
      .prepare(`SELECT category, risk_tier, outcome FROM decision_log WHERE decision_id = ?`)
      .get(decisionId) as { category: string; risk_tier: number; outcome: string } | undefined;

    if (!row || row.outcome !== "pending") return null;

    const category = row.category;
    const tier = row.risk_tier as RiskTier;

    // Update decision_log
    this.db
      .prepare(
        `UPDATE decision_log
         SET outcome = ?, outcome_source = ?, outcome_resolved_at = datetime('now'),
             correction_message = ?
         WHERE decision_id = ?`,
      )
      .run(outcome, source, correctionMessage, decisionId);

    // Remove from pending_outcomes
    this.db.prepare(`DELETE FROM pending_outcomes WHERE decision_id = ?`).run(decisionId);

    // Update trust score via EWMA
    const scoreRow = this.db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = ?`)
      .get(category) as { current_score: number } | undefined;

    const oldScore = scoreRow?.current_score ?? this.config.initial_scores[tier] ?? 0.55;
    const newScore = updateScore(oldScore, outcome, tier, this.config);

    if (scoreRow) {
      // M1 fix: also update decisions_last_30d with a subquery count
      this.db
        .prepare(
          `UPDATE trust_scores
           SET current_score = ?,
               decision_count = decision_count + 1,
               decisions_last_30d = (
                 SELECT COUNT(*) FROM decision_log
                 WHERE category = trust_scores.category
                   AND timestamp >= datetime('now', '-30 days')
               ),
               last_updated = datetime('now')
           WHERE category = ?`,
        )
        .run(newScore, category);
    } else {
      // Bootstrap score row if missing
      this.db
        .prepare(
          `INSERT INTO trust_scores (score_id, category, risk_tier, current_score, ewma_alpha, decision_count, initial_score)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          randomUUID(),
          category,
          tier,
          newScore,
          this.config.ewma_alphas[tier] ?? 0.1,
          this.config.initial_scores[tier] ?? 0.55,
        );
    }

    return { oldScore, newScore, category, tier };
  }

  /**
   * Sweep expired feedback windows — called periodically.
   * Returns number of outcomes resolved.
   */
  sweepExpiredWindows(): number {
    const expired = this.db
      .prepare(
        `SELECT po.decision_id FROM pending_outcomes po
         JOIN decision_log dl ON dl.decision_id = po.decision_id
         WHERE po.feedback_window_expires_at <= datetime('now')
           AND dl.outcome = 'pending'`,
      )
      .all() as Array<{ decision_id: string }>;

    let resolved = 0;
    for (const { decision_id } of expired) {
      const result = this.resolveOutcome(decision_id, "pass", "feedback_window_expired");
      if (result) resolved++;
    }
    return resolved;
  }

  /**
   * Record a tool error for a specific decision.
   */
  recordToolError(decisionId: string, isHeliosError: boolean, errorMessage: string): void {
    const outcome: Outcome = isHeliosError ? "tool_error_helios" : "tool_error_external";
    this.resolveOutcome(decisionId, outcome, "tool_failure", errorMessage);
  }

  /**
   * Record Matthew's correction for the most recent pending decision
   * matching a category.
   *
   * H2 mitigation: only matches pending decisions within the correction_window_minutes
   * (default 30 min). Prevents conversational messages from retroactively affecting
   * old decisions and causing EWMA score drift.
   */
  recordCorrection(
    correctionText: string,
    category?: string,
  ): { resolved: boolean; decisionId?: string; severity?: string } {
    const severity = detectCorrectionSeverity(correctionText);
    if (!severity) return { resolved: false };

    // H2: only search within the correction feedback window (default 30 min)
    const windowMinutes = this.config.correction_window_minutes ?? 30;

    // Find most recent pending decision within the correction window
    const query = category
      ? `SELECT decision_id FROM decision_log
         WHERE outcome = 'pending' AND category = ?
           AND timestamp >= datetime('now', '-${windowMinutes} minutes')
         ORDER BY timestamp DESC LIMIT 1`
      : `SELECT decision_id FROM decision_log
         WHERE outcome = 'pending'
           AND timestamp >= datetime('now', '-${windowMinutes} minutes')
         ORDER BY timestamp DESC LIMIT 1`;

    const row = category
      ? (this.db.prepare(query).get(category) as { decision_id: string } | undefined)
      : (this.db.prepare(query).get() as { decision_id: string } | undefined);

    if (!row) return { resolved: false };

    const outcome: Outcome =
      severity === "significant" ? "corrected_significant" : "corrected_minor";

    this.resolveOutcome(row.decision_id, outcome, "correction_detected", correctionText);
    return { resolved: true, decisionId: row.decision_id, severity };
  }

  /**
   * Get count of pending outcomes.
   */
  pendingCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM pending_outcomes`).get() as {
      cnt: number;
    };
    return row.cnt;
  }
}
