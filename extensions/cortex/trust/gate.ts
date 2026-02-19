/**
 * TrustGate — Core gate logic for earned autonomy
 * Earned Autonomy Phase 5.6
 *
 * Synchronous SQLite reads. Target: ≤10ms per check.
 * Entry point for pre-action hook integration (task-003).
 */

import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { GateDecision, GateResult, RiskTier, TrustConfig } from "./types.js";
import { ActionClassifier } from "./classifier.js";
import { DEFAULT_TRUST_CONFIG } from "./types.js";

export class TrustGate {
  private config: TrustConfig;

  constructor(
    private db: Database.Database,
    config?: Partial<TrustConfig>,
  ) {
    this.config = { ...DEFAULT_TRUST_CONFIG, ...config };
  }

  /**
   * Check whether a tool call should be allowed, paused, or blocked.
   * Returns a GateDecision. Logs the decision to decision_log.
   */
  check(toolName: string, params: Record<string, unknown>, sessionId: string): GateDecision {
    const { tier, category } = ActionClassifier.classify(toolName, params);
    const decision_id = randomUUID();

    // Read override
    const override = this.db
      .prepare(
        `SELECT override_type FROM trust_overrides
         WHERE category = ? AND active = 1
           AND (expires_at IS NULL OR expires_at > datetime('now'))
         LIMIT 1`,
      )
      .get(category) as { override_type: string } | undefined;

    // Read trust score
    const scoreRow = this.db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = ?`)
      .get(category) as { current_score: number } | undefined;

    const score = scoreRow?.current_score ?? this.getInitialScore(tier);
    const threshold = this.config.tier_thresholds[tier] ?? 0.7;
    const floor = this.config.tier_floors[tier] ?? 0.4;

    let result: GateResult;
    let reason: string;
    let overrideActive = false;

    if (override?.override_type === "granted") {
      result = "pass";
      reason = "explicit_grant_override";
      overrideActive = true;
    } else if (override?.override_type === "revoked") {
      result = "block";
      reason = "explicit_revoke_override";
      overrideActive = true;
    } else if (tier === 4) {
      result = "pause";
      reason = "financial_hardcap";
    } else if (score >= threshold) {
      result = "pass";
      reason = `trust_score_${score.toFixed(3)}_meets_threshold_${threshold}`;
    } else if (score >= floor) {
      result = "pause";
      reason = `trust_score_${score.toFixed(3)}_below_threshold_${threshold}`;
    } else {
      result = "block";
      reason = `trust_score_${score.toFixed(3)}_below_floor_${floor}`;
    }

    // Log decision
    const paramsJson = JSON.stringify(params);
    const paramsHash = createHash("sha256").update(paramsJson).digest("hex").slice(0, 16);
    const paramsSummary = this.summarizeParams(toolName, params);

    this.db
      .prepare(
        `INSERT INTO decision_log (
          decision_id, session_id, tool_name, tool_params_hash, tool_params_summary,
          risk_tier, category, gate_decision, trust_score_at_decision, override_active, outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        decision_id,
        sessionId,
        toolName,
        paramsHash,
        paramsSummary,
        tier,
        category,
        result,
        score,
        overrideActive ? 1 : 0,
      );

    // For PASS decisions, create pending outcome record for feedback window
    if (result === "pass") {
      const windowMs = this.config.feedback_window_ms[tier] ?? 30 * 60 * 1000;
      const expiresAt = new Date(Date.now() + windowMs).toISOString();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO pending_outcomes (decision_id, feedback_window_expires_at)
           VALUES (?, ?)`,
        )
        .run(decision_id, expiresAt);
    }

    return {
      result,
      reason,
      tier: tier as RiskTier,
      category,
      trust_score: score,
      threshold,
      decision_id,
      override_active: overrideActive,
    };
  }

  private getInitialScore(tier: number): number {
    return this.config.initial_scores[tier] ?? 0.55;
  }

  /**
   * Scrub known secret patterns from command strings before storing in decision_log.
   * Prevents API keys, tokens, and passwords from leaking into plaintext DB records.
   */
  private sanitizeCommand(cmd: string): string {
    return (
      cmd
        // Bearer tokens and Authorization headers
        .replace(/\b(Bearer\s+)\S+/gi, "$1***REDACTED***")
        // curl-style auth headers: -H "Authorization: ..."
        .replace(/-H\s+["']Authorization:\s*[^"']+["']/gi, '-H "Authorization: ***REDACTED***"')
        // Key/token/password/secret as CLI args (key=value or key:value)
        .replace(/\b(token|key|password|secret|api[_-]?key|auth)[=:]\S+/gi, "$1=***REDACTED***")
        // Space-separated CLI flags: --password foo, --token foo, --secret foo
        .replace(
          /(--(password|token|secret|api-key|auth-token|access-key))\s+\S+/gi,
          "$1 ***REDACTED***",
        )
        // AWS credentials (AKIA... access key IDs and secret keys)
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, "***AWS_KEY***")
        .replace(/\b(aws[_-]?secret[_-]?access[_-]?key)[=:\s]+\S+/gi, "$1=***REDACTED***")
        // GitHub tokens (ghp_, gho_, ghs_, github_pat_)
        .replace(/\b(ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{20,}\b/g, "***GH_TOKEN***")
        // GitLab tokens (glpat-)
        .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "***GL_TOKEN***")
        // Slack tokens (xoxb-, xoxp-, xoxs-, xoxa-, xoxr-)
        .replace(/\bxox[bpsar]-[A-Za-z0-9-]{10,}\b/g, "***SLACK_TOKEN***")
        // URLs with embedded credentials (https://user:pass@host, postgres://, mongodb://, etc.)
        .replace(/:\/\/[^:\/\s]+:[^@\/\s]+@/g, "://***CREDS***@")
        // Environment variable exports with secrets
        .replace(
          /\b(export\s+)([\w]*(SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[\w]*)=\S+/gi,
          "$1$2=***REDACTED***",
        )
        // JWT tokens (eyJ... base64 payload)
        .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "***JWT***")
        // Private keys / long hex secrets (40+ hex chars)
        .replace(/\b[0-9a-fA-F]{40,}\b/g, "***HEX_SECRET***")
        // PEM private key blocks
        .replace(
          /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
          "***PEM_PRIVATE_KEY***",
        )
        // Base64-encoded secrets (op:// 1Password refs, long base64 blobs)
        .replace(/\bop:\/\/\S+/g, "***1PASS_REF***")
    );
  }

  private summarizeParams(toolName: string, params: Record<string, unknown>): string {
    const parts: string[] = [toolName];
    if (typeof params.command === "string") {
      // Sanitize command before storing — prevents secret leakage in decision_log (M4)
      parts.push(this.sanitizeCommand(params.command).slice(0, 120));
    }
    if (typeof params.action === "string") {
      parts.push(`action=${params.action}`);
    }
    if (typeof params.file_path === "string") {
      parts.push(params.file_path);
    } else if (typeof params.path === "string") {
      parts.push(params.path as string);
    }
    return parts.join(" | ").slice(0, 250);
  }
}
