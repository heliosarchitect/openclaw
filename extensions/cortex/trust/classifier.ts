/**
 * ActionClassifier — Deterministic tool→tier+category classification
 * Earned Autonomy Phase 5.6
 *
 * Synchronous, no I/O, ≤1ms. First matching rule wins.
 */

import type { Classification, ClassificationRule, RiskTier } from "./types.js";

// ──────────────────────────────────────────────────────
// Static Rule Table (order matters — first match wins)
// ──────────────────────────────────────────────────────

const CLASSIFICATION_RULES: ClassificationRule[] = [
  // ── Tier 4: Financial (hardcap) ──────────────────────
  {
    tool: "exec",
    pattern: /augur.*trade|paper_augur.*execute/i,
    tier: 4,
    category: "financial_augur",
  },
  {
    tool: "exec",
    pattern: /coinbase|crypto.*transfer|send.*eth|send.*btc/i,
    tier: 4,
    category: "financial_crypto",
  },
  {
    tool: "exec",
    pattern: /stripe.*charge|payment.*create/i,
    tier: 4,
    category: "financial_stripe",
  },

  // ── Tier 3: Infrastructure ───────────────────────────
  {
    tool: "gateway",
    action: /restart|config\.apply|update\.run/,
    tier: 3,
    category: "gateway_action",
  },
  {
    tool: "exec",
    pattern:
      /systemctl\s+(start|stop|restart|enable|disable)|service\s+\w+\s+(start|stop|restart)/i,
    tier: 3,
    category: "service_restart",
  },
  {
    tool: "exec",
    pattern: /pnpm\s+(build|deploy)|git\s+push.*prod|npm\s+publish/i,
    tier: 3,
    category: "deploy",
  },
  { tool: "cron", action: /^(update|remove)$/, tier: 3, category: "cron_modify" },
  { tool: "write", path: /\.(conf|yaml|yml|json|env|toml)$/i, tier: 3, category: "config_change" },
  { tool: "edit", path: /\.(conf|yaml|yml|json|env|toml)$/i, tier: 3, category: "config_change" },
  { tool: "Edit", path: /\.(conf|yaml|yml|json|env|toml)$/i, tier: 3, category: "config_change" },
  { tool: "Write", path: /\.(conf|yaml|yml|json|env|toml)$/i, tier: 3, category: "config_change" },

  // ── Tier 2: Non-Destructive ──────────────────────────
  { tool: "write", path: /.*/, tier: 2, category: "write_file" },
  { tool: "Write", path: /.*/, tier: 2, category: "write_file" },
  { tool: "edit", path: /.*/, tier: 2, category: "write_file" },
  { tool: "Edit", path: /.*/, tier: 2, category: "write_file" },
  { tool: "cortex_add", tier: 2, category: "cortex_write" },
  { tool: "cortex_edit", tier: 2, category: "cortex_write" },
  { tool: "cortex_update", tier: 2, category: "cortex_write" },
  { tool: "cortex_move", tier: 2, category: "cortex_write" },
  { tool: "cortex_dedupe", tier: 2, category: "cortex_write" },
  { tool: "cortex_create_category", tier: 2, category: "cortex_write" },
  { tool: "synapse", action: /^send$/, tier: 2, category: "synapse_send" },
  { tool: "cron", action: /^add$/, tier: 2, category: "cron_create" },
  { tool: "sessions_spawn", tier: 2, category: "session_spawn" },
  { tool: "message", action: /^send$/, tier: 2, category: "synapse_send" },
  { tool: "exec", pattern: /.*/, tier: 2, category: "write_file" }, // exec fallback

  // ── Tier 1: Read-Only ────────────────────────────────
  { tool: "Read", tier: 1, category: "read_file" },
  { tool: "read", tier: 1, category: "read_file" },
  { tool: "cortex_stm", tier: 1, category: "cortex_query" },
  { tool: "cortex_stats", tier: 1, category: "cortex_query" },
  { tool: "cortex_list_categories", tier: 1, category: "cortex_query" },
  { tool: "cortex_predict", tier: 1, category: "cortex_query" },
  { tool: "web_search", tier: 1, category: "web_search" },
  { tool: "web_fetch", tier: 1, category: "web_search" },
  { tool: "synapse", action: /^(inbox|read|history|ack)$/, tier: 1, category: "synapse_read" },
  { tool: "session_status", tier: 1, category: "exec_status" },
  { tool: "sessions_list", tier: 1, category: "exec_status" },
  { tool: "sessions_history", tier: 1, category: "exec_status" },
  { tool: "subagents", tier: 1, category: "exec_status" },
  { tool: "lbf", action: /^(list|get|itsm)/, tier: 1, category: "cortex_query" },
  { tool: "image", tier: 1, category: "cortex_query" },
  { tool: "atom_search", tier: 1, category: "cortex_query" },
  { tool: "atom_stats", tier: 1, category: "cortex_query" },
  { tool: "atom_find_causes", tier: 1, category: "cortex_query" },
  { tool: "abstract_deeper", tier: 1, category: "cortex_query" },
  { tool: "classify_query", tier: 1, category: "cortex_query" },
  { tool: "temporal_search", tier: 1, category: "cortex_query" },
  { tool: "temporal_patterns", tier: 1, category: "cortex_query" },
  { tool: "what_happened_before", tier: 1, category: "cortex_query" },
  { tool: "working_memory", tier: 1, category: "cortex_query" },
  { tool: "browser", tier: 1, category: "web_search" },
  { tool: "nodes", tier: 1, category: "exec_status" },
  { tool: "agents_list", tier: 1, category: "exec_status" },
  { tool: "tts", tier: 1, category: "exec_status" },
];

// Exec read-only patterns (matched before the Tier 2 exec fallback)
const EXEC_READONLY_PATTERNS = [
  /^\s*(ls|cat|echo|which|find|grep|head|tail|wc|file|stat|readlink|realpath|pwd|whoami|hostname|uname|date|uptime|ps|top|htop|df|du|free|id|env|printenv)\b/,
  /^\s*(git\s+(status|log|diff|show|branch|tag|remote|stash\s+list))\b/,
  /^\s*(pnpm\s+(ls|list|why)|npm\s+(ls|list|outdated))\b/,
  /--version\s*$/,
  /^\S+\s+-v\s*$/,
  /^\s*(test\s+-|\[)/,
  /^\s*openclaw\s+(status|gateway\s+status)\b/,
];

/**
 * Classify a tool call into a risk tier and category.
 * Deterministic, synchronous, no I/O.
 */
export function classify(toolName: string, params: Record<string, unknown> = {}): Classification {
  const command = typeof params.command === "string" ? params.command : "";
  const action = typeof params.action === "string" ? params.action : "";
  const filePath =
    typeof params.file_path === "string"
      ? params.file_path
      : typeof params.path === "string"
        ? params.path
        : "";

  // ── TIER 4 FINANCIAL CHECK FIRST (hardcap — must precede all shortcuts) ──
  // Prevents compound commands like "ls && augur trade --live" from bypassing via read-only prefix.
  // Full-string match (not anchored) to catch embedded financial commands.
  if (toolName === "exec" && command) {
    if (/\baugur\b.*\btrade\b|\bpaper_augur\b.*\bexecute\b/i.test(command)) {
      return { tier: 4, category: "financial_augur" };
    }
    if (/\bcoinbase\b|\bcrypto.*transfer\b|\bsend.*\beth\b|\bsend.*\bbtc\b/i.test(command)) {
      return { tier: 4, category: "financial_crypto" };
    }
    if (/\bstripe.*charge\b|\bpayment.*create\b/i.test(command)) {
      return { tier: 4, category: "financial_stripe" };
    }
  }

  // ── EXEC READ-ONLY SHORTCUT (safe — Tier 4 already screened above) ──────
  if (toolName === "exec" && command) {
    for (const pat of EXEC_READONLY_PATTERNS) {
      if (pat.test(command)) {
        return { tier: 1, category: "exec_status" };
      }
    }
  }

  for (const rule of CLASSIFICATION_RULES) {
    // Match tool name
    if (typeof rule.tool === "string") {
      if (rule.tool !== toolName) continue;
    } else if (!rule.tool.test(toolName)) {
      continue;
    }

    // Match action (if specified)
    if (rule.action && !rule.action.test(action)) continue;

    // Match command pattern (if specified, for exec)
    if (rule.pattern && !rule.pattern.test(command)) continue;

    // Match file path (if specified)
    if (rule.path && !rule.path.test(filePath)) continue;

    return { tier: rule.tier, category: rule.category };
  }

  // Default fallback: Tier 2 (conservative)
  return { tier: 2, category: "write_file" };
}

export const ActionClassifier = { classify };
