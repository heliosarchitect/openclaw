# Task-010: Earned Autonomy — Progressive Trust — Design

**Stage:** design | **Status:** complete
**Phase:** 5.6 | **Date:** 2026-02-19
**Author:** Pipeline Design Specialist

---

## 1. Overview

The **Earned Autonomy system** transforms Helios's autonomy from binary (ask/don't ask) into a continuously calibrated, evidence-based trust ladder. Decisions made well accumulate into a quantified track record; that track record unlocks progressively larger actions without interrupting Matthew.

### Design Philosophy

Three layers operating in sequence:

1. **Classify** — deterministically assign every action to a risk tier and category (no LLM, no async)
2. **Gate** — apply trust score against tier threshold; pass, pause, or block in ≤ 10ms
3. **Learn** — collect outcome signal, update trust score via EWMA, emit milestone events

Each layer is independently testable. The system is a **pure read-write adjunct** to the existing pre-action hook — it consults `brain.db` and returns a gate decision. It never modifies the tool execution pipeline beyond blocking or passing at the gate.

### Integration with Task-003 (Pre-Action Hooks)

The pre-action hook already intercepts tool calls. Earned Autonomy plugs in as a callable within that hook:

```
Pre-Action Hook (task-003)
├── SOP lookup
├── Cortex process search
└── → TrustGate.check(toolName, params, context)
         ├── PASS  → hook allows tool execution
         ├── PAUSE → hook queues and asks Matthew
         └── BLOCK → hook halts and posts Synapse alert
```

No new interception layer. No new entry point. Trust gate is a module imported by the hook.

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Earned Autonomy System                            │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  CLASSIFICATION LAYER (synchronous, deterministic, ≤1ms)      │  │
│  │                                                                │  │
│  │  ActionClassifier                                              │  │
│  │  ├── tool → risk_tier (1-4) + category string                 │  │
│  │  └── Uses static rule table (no DB, no LLM)                   │  │
│  └────────────────────────┬───────────────────────────────────────┘  │
│                           │                                           │
│  ┌────────────────────────▼───────────────────────────────────────┐  │
│  │  GATE LAYER (synchronous SQLite read, ≤10ms)                  │  │
│  │                                                                │  │
│  │  TrustGate.check(action)                                       │  │
│  │  ├── Read trust_overrides for category                        │  │
│  │  ├── Read trust_scores for (category, tier)                   │  │
│  │  ├── Apply threshold/floor logic                              │  │
│  │  └── Return GateDecision: PASS | PAUSE | BLOCK                │  │
│  └────────────────────────┬───────────────────────────────────────┘  │
│                           │                                           │
│  ┌────────────────────────▼───────────────────────────────────────┐  │
│  │  LEARNING LAYER (async, post-execution)                       │  │
│  │                                                                │  │
│  │  OutcomeCollector                                              │  │
│  │  ├── Feedback window timer (30 min, cancelable)               │  │
│  │  ├── Correction detector (session message scanner)            │  │
│  │  ├── EWMA score update → trust_scores                         │  │
│  │  └── Milestone detector → emit trust_milestones               │  │
│  └────────────────────────┬───────────────────────────────────────┘  │
│                           │                                           │
│  ┌────────────────────────▼───────────────────────────────────────┐  │
│  │  REPORTING LAYER (on-demand + weekly cron)                    │  │
│  │                                                                │  │
│  │  TrustReporter                                                 │  │
│  │  ├── ~/bin/trust-status CLI                                    │  │
│  │  └── Weekly Synapse summary                                    │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Data Model

### 3.1 Decision Log

```typescript
interface DecisionRecord {
  decision_id: string; // uuid
  timestamp: string; // ISO timestamp
  session_id: string; // which session made this decision

  // Action identity
  tool_name: string; // exec, write, gateway, etc.
  tool_params_hash: string; // SHA-256 of params JSON (for dedup, not full params)
  tool_params_summary: string; // Human-readable summary (no secrets)
  risk_tier: 1 | 2 | 3 | 4;
  category: string; // read_file | write_file | service_restart | ...

  // Gate result
  gate_decision: "pass" | "pause" | "block";
  trust_score_at_decision: number;
  override_active: boolean; // was an explicit grant/revoke override in effect?

  // Outcome (filled in by OutcomeCollector after feedback window)
  outcome:
    | "pass"
    | "corrected_minor"
    | "corrected_significant"
    | "tool_error_helios"
    | "tool_error_external"
    | "denied_by_matthew"
    | "pending";
  outcome_source:
    | "feedback_window_expired"
    | "correction_detected"
    | "tool_failure"
    | "matthew_denied"
    | null;
  outcome_resolved_at: string | null; // ISO timestamp when outcome was determined
  correction_message: string | null; // Matthew's correction text if applicable
}
```

### 3.2 Trust Scores

```typescript
interface TrustScore {
  score_id: string;
  category: string; // e.g., 'write_file'
  risk_tier: 1 | 2 | 3 | 4;
  current_score: number; // 0.0 - 1.0
  ewma_alpha: number; // default 0.1 (configurable per tier)
  decision_count: number; // total decisions in this category (all time)
  decisions_last_30d: number; // decisions in last 30 days
  last_updated: string; // ISO timestamp
  initial_score: number; // score assigned at bootstrap
}
```

### 3.3 Trust Overrides

```typescript
interface TrustOverride {
  override_id: string;
  category: string;
  override_type: "granted" | "revoked";
  reason: string; // Matthew's stated reason
  granted_by: string; // 'matthew' always (agent cannot self-grant)
  granted_at: string;
  expires_at: string | null; // null = permanent until explicitly lifted
  revoked_at: string | null; // set when override is lifted
  active: boolean;
}
```

### 3.4 Trust Milestones

```typescript
interface TrustMilestone {
  milestone_id: string;
  timestamp: string;
  category: string;
  milestone_type:
    | "first_auto_approve"
    | "tier_promotion"
    | "tier_demotion"
    | "blocked"
    | "override_granted"
    | "override_revoked";
  old_score: number | null;
  new_score: number;
  trigger: string; // human-readable reason
  synapse_notified: boolean;
}
```

---

## 4. Classification Layer

### 4.1 ActionClassifier (`src/trust/classifier.ts`)

Deterministic, synchronous, ≤ 1ms. No I/O. Returns `{ tier, category }`.

```typescript
// Static rule table — ORDER MATTERS (first match wins)
const CLASSIFICATION_RULES: ClassificationRule[] = [
  // ── Tier 4: Financial (hardcap) ──────────────────────────────────────
  {
    tool: "exec",
    pattern: /augur.*trade|paper_augur.*execute/,
    tier: 4,
    category: "financial_augur",
  },
  {
    tool: "exec",
    pattern: /coinbase|crypto.*transfer|send.*eth|send.*btc/,
    tier: 4,
    category: "financial_crypto",
  },
  {
    tool: "exec",
    pattern: /stripe.*charge|payment.*create/,
    tier: 4,
    category: "financial_stripe",
  },

  // ── Tier 3: Infrastructure ─────────────────────────────────────────
  {
    tool: "gateway",
    action: /restart|config\.apply|update\.run/,
    tier: 3,
    category: "gateway_action",
  },
  {
    tool: "exec",
    pattern: /systemctl|service\s+\w+\s+(start|stop|restart)/,
    tier: 3,
    category: "service_restart",
  },
  {
    tool: "exec",
    pattern: /pnpm (build|deploy)|git push.*prod|npm publish/,
    tier: 3,
    category: "deploy",
  },
  { tool: "cron", action: /add|update|remove/, tier: 3, category: "cron_modify" },
  { tool: "write", path: /\.conf$|\.yaml$|\.json$|\.env$/, tier: 3, category: "config_change" },
  { tool: "edit", path: /\.conf$|\.yaml$|\.json$|\.env$/, tier: 3, category: "config_change" },

  // ── Tier 2: Non-Destructive ────────────────────────────────────────
  { tool: "write", path: /.*/, tier: 2, category: "write_file" },
  { tool: "edit", path: /.*/, tier: 2, category: "write_file" },
  { tool: "cortex_add", tier: 2, category: "cortex_write" },
  { tool: "cortex_edit", tier: 2, category: "cortex_write" },
  { tool: "cortex_update", tier: 2, category: "cortex_write" },
  { tool: "synapse", action: /send/, tier: 2, category: "synapse_send" },
  { tool: "cron", action: /add/, tier: 2, category: "cron_create" }, // create-only cron
  { tool: "sessions_spawn", tier: 2, category: "session_spawn" },
  { tool: "message", action: /send/, tier: 2, category: "synapse_send" },

  // ── Tier 1: Read-Only ─────────────────────────────────────────────
  { tool: "Read", tier: 1, category: "read_file" },
  {
    tool: "exec",
    pattern: /^(ls|cat|echo|which|find|grep|ps|df|du|top|htop|status|--version|-v$)/,
    tier: 1,
    category: "exec_status",
  },
  { tool: "cortex_stm", tier: 1, category: "cortex_query" },
  { tool: "cortex_stats", tier: 1, category: "cortex_query" },
  { tool: "cortex_list_categories", tier: 1, category: "cortex_query" },
  { tool: "web_search", tier: 1, category: "web_search" },
  { tool: "web_fetch", tier: 1, category: "web_search" },
  { tool: "synapse", action: /inbox|read|history|ack/, tier: 1, category: "synapse_read" },
  { tool: "session_status", tier: 1, category: "exec_status" },
  { tool: "lbf", action: /list|get|itsm/, tier: 1, category: "cortex_query" },

  // ── Default: Tier 2 Non-Destructive (conservative fallback) ──────
  { tool: /.*/, tier: 2, category: "write_file" },
];
```

**Design decision — conservative fallback**: Unclassified tools default to Tier 2 rather than Tier 1. This prevents a new tool from being silently auto-approved as read-only when it might not be.

**Exec command analysis**: The `exec` tool is the most varied. Classification inspects the `command` parameter and uses the first token (command name) and patterns to assign tier. Long-running commands that don't match a read-only pattern default to Tier 2.

---

## 5. Gate Layer

### 5.1 TrustGate (`src/trust/gate.ts`)

```typescript
export type GateDecision = {
  result: "pass" | "pause" | "block";
  reason: string;
  tier: number;
  category: string;
  trust_score: number;
  threshold: number;
  decision_id: string; // pre-created, for logging
};

const TIER_THRESHOLDS: Record<number, number> = { 1: 0.5, 2: 0.7, 3: 0.85, 4: Infinity };
const TIER_FLOORS: Record<number, number> = { 1: 0.2, 2: 0.4, 3: 0.6, 4: Infinity };

export class TrustGate {
  constructor(private db: Database) {}

  check(toolName: string, params: Record<string, unknown>, sessionId: string): GateDecision {
    // 1. Classify (synchronous, no I/O)
    const { tier, category } = ActionClassifier.classify(toolName, params);

    // 2. Read override (synchronous SQLite read)
    const override = this.db
      .prepare(
        `SELECT override_type FROM trust_overrides
       WHERE category = ? AND active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))`,
      )
      .get(category) as { override_type: string } | undefined;

    // 3. Read trust score (synchronous SQLite read)
    const scoreRow = this.db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = ?`)
      .get(category) as { current_score: number } | undefined;

    const score = scoreRow?.current_score ?? this.getInitialScore(tier);
    const decision_id = randomUUID();

    // 4. Gate logic
    let result: "pass" | "pause" | "block";
    let reason: string;

    if (override?.override_type === "granted") {
      result = "pass";
      reason = "explicit_grant_override";
    } else if (override?.override_type === "revoked") {
      result = "block";
      reason = "explicit_revoke_override";
    } else if (tier === 4) {
      result = "pause";
      reason = "financial_hardcap";
    } else if (score >= TIER_THRESHOLDS[tier]) {
      result = "pass";
      reason = `trust_score_${score.toFixed(2)}_meets_threshold_${TIER_THRESHOLDS[tier]}`;
    } else if (score >= TIER_FLOORS[tier]) {
      result = "pause";
      reason = `trust_score_${score.toFixed(2)}_below_threshold_${TIER_THRESHOLDS[tier]}`;
    } else {
      result = "block";
      reason = `trust_score_${score.toFixed(2)}_below_floor_${TIER_FLOORS[tier]}`;
    }

    // 5. Log decision (synchronous insert)
    this.logDecision({
      decision_id,
      tier,
      category,
      result,
      score,
      reason,
      sessionId,
      toolName,
      params,
    });

    return {
      result,
      reason,
      tier,
      category,
      trust_score: score,
      threshold: TIER_THRESHOLDS[tier],
      decision_id,
    };
  }

  private getInitialScore(tier: number): number {
    return { 1: 0.75, 2: 0.65, 3: 0.55, 4: 0.0 }[tier] ?? 0.55;
  }
}
```

### 5.2 PAUSE Flow

When gate returns `pause`:

1. Pre-action hook formats a concise confirmation request: `"Trust score {score:.0%} below {threshold:.0%} for {category}. Proceed with {action_summary}? [y/n]"`
2. Request is queued in `pending_confirmations` table with 10-minute TTL
3. If Matthew replies `y` / confirms → decision updated to `gate_decision=pause, outcome=pass` → tool executes
4. If Matthew replies `n` / denies → decision updated to `outcome=denied_by_matthew` → tool blocked
5. If TTL expires without response → treated as `denied_by_matthew` (conservative default)

**PAUSE messages are brief**: "→ Trust {68%} < {70%} for `write_file`. Proceed? [y/n]" — not a wall of text.

### 5.3 BLOCK Flow

When gate returns `block`:

1. Tool execution halted immediately
2. Synapse alert posted: `priority='urgent'`, `thread_id='trust-block-{category}'`
3. Alert format: "🔴 TRUST BLOCK: {category} score {score:.0%} below floor {floor:.0%}. {N} consecutive failures. Autonomous action in this category is suspended until Matthew re-authorizes."
4. Decision logged with `outcome='block'`

---

## 6. Learning Layer

### 6.1 OutcomeCollector (`src/trust/outcome-collector.ts`)

The feedback window is the core of the learning loop. After a tool call completes (gate=`pass`):

1. A 30-minute async timer starts, keyed to `decision_id`
2. Timer is stored in `pending_outcomes` (SQLite) so it survives restarts
3. Correction detector runs as a background scanner (every 60 seconds) watching for:
   - Matthew's explicit corrections (keywords: "no", "wrong", "undo", "that's not right", "fix", "revert")
   - Tool failures attributed to Helios error (error message patterns indicating bad command, wrong path, etc.)
4. On detection of correction: timer cancelled, `outcome = corrected_{severity}` based on correction keywords
5. On timer expiry (no correction): `outcome = pass`
6. Outcome written to `decision_log`, EWMA update triggered

**Correction severity heuristics (rule-based, no LLM):**

| Keywords detected in correction                                 | Severity    |
| --------------------------------------------------------------- | ----------- |
| "no", "wrong", "not right", "undo", "different"                 | minor       |
| "broke", "crash", "critical", "revert", "disaster", "lost data" | significant |
| No correction keywords but Matthew explicitly commands a redo   | minor       |

### 6.2 EWMA Score Updater (`src/trust/score-updater.ts`)

```typescript
const OUTCOME_VALUES: Record<string, number> = {
  pass: +1.0,
  corrected_minor: -0.5,
  corrected_significant: -1.0,
  tool_error_helios: -0.3,
  tool_error_external: 0.0, // neutral — not Helios's fault
  denied_by_matthew: -0.2, // slight negative — Matthew chose not to trust this
};

const EWMA_ALPHA: Record<number, number> = {
  1: 0.08, // slow update — tier 1 is high-volume, smooth it
  2: 0.1, // standard
  3: 0.15, // faster update — tier 3 mistakes matter more
  4: 0.0, // no score updates (hardcap, never auto-approved)
};

function updateScore(current: number, outcome: string, tier: number): number {
  const alpha = EWMA_ALPHA[tier] ?? 0.1;
  const value = OUTCOME_VALUES[outcome] ?? 0.0;

  // Normalize value to [0, 1] before EWMA: value=+1→1.0, value=0→0.5, value=-1→0.0
  const normalized = (value + 1.0) / 2.0;

  const newScore = alpha * normalized + (1 - alpha) * current;
  return Math.max(0.0, Math.min(1.0, newScore));
}
```

**Score floor protection:** A single catastrophic event (corrected_significant) cannot drop a score below 0.0 — EWMA bounds guarantee this. Recovery is possible via continued good decisions.

### 6.3 Milestone Detector (`src/trust/milestone-detector.ts`)

After every score update, the milestone detector checks for notable transitions:

| Condition                                                          | Milestone Type       | Synapse notify? |
| ------------------------------------------------------------------ | -------------------- | --------------- |
| Score crosses threshold upward (first time in this category)       | `first_auto_approve` | Yes (info)      |
| Score crosses threshold upward (after previous demotion)           | `tier_promotion`     | Yes (info)      |
| Score crosses threshold downward (was auto-approving, now pausing) | `tier_demotion`      | Yes (action)    |
| Score crosses floor downward (now blocking)                        | `blocked`            | Yes (urgent)    |
| Matthew grants override                                            | `override_granted`   | Yes (info)      |
| Matthew revokes override                                           | `override_revoked`   | Yes (info)      |

Milestone stored in `trust_milestones` and as a cortex memory (importance 2.0 for demotions/blocks, 1.5 for promotions).

---

## 7. Database Schema

### 7.1 New Tables in `brain.db`

```sql
-- Decision log: every autonomous decision
CREATE TABLE IF NOT EXISTS decision_log (
  decision_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_params_hash TEXT NOT NULL,
  tool_params_summary TEXT NOT NULL,
  risk_tier INTEGER NOT NULL CHECK (risk_tier IN (1,2,3,4)),
  category TEXT NOT NULL,
  gate_decision TEXT NOT NULL CHECK (gate_decision IN ('pass','pause','block')),
  trust_score_at_decision REAL NOT NULL,
  override_active INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pass','corrected_minor','corrected_significant',
                        'tool_error_helios','tool_error_external','denied_by_matthew','pending')),
  outcome_source TEXT,
  outcome_resolved_at TEXT,
  correction_message TEXT
);

CREATE INDEX idx_dl_category ON decision_log(category);
CREATE INDEX idx_dl_timestamp ON decision_log(timestamp DESC);
CREATE INDEX idx_dl_outcome ON decision_log(outcome);
CREATE INDEX idx_dl_pending ON decision_log(outcome) WHERE outcome = 'pending';

-- Trust scores: current EWMA score per category
CREATE TABLE IF NOT EXISTS trust_scores (
  score_id TEXT PRIMARY KEY,
  category TEXT UNIQUE NOT NULL,
  risk_tier INTEGER NOT NULL,
  current_score REAL NOT NULL CHECK (current_score BETWEEN 0.0 AND 1.0),
  ewma_alpha REAL NOT NULL DEFAULT 0.1,
  decision_count INTEGER NOT NULL DEFAULT 0,
  decisions_last_30d INTEGER NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  initial_score REAL NOT NULL
);

-- Trust overrides: Matthew's explicit grants/revokes
CREATE TABLE IF NOT EXISTS trust_overrides (
  override_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  override_type TEXT NOT NULL CHECK (override_type IN ('granted','revoked')),
  reason TEXT NOT NULL,
  granted_by TEXT NOT NULL DEFAULT 'matthew',
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_to_category ON trust_overrides(category, active);

-- Milestones: notable trust transitions
CREATE TABLE IF NOT EXISTS trust_milestones (
  milestone_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  category TEXT NOT NULL,
  milestone_type TEXT NOT NULL,
  old_score REAL,
  new_score REAL NOT NULL,
  trigger TEXT NOT NULL,
  synapse_notified INTEGER NOT NULL DEFAULT 0
);

-- Pending outcomes: feedback window timers (survive restarts)
CREATE TABLE IF NOT EXISTS pending_outcomes (
  decision_id TEXT PRIMARY KEY REFERENCES decision_log(decision_id),
  feedback_window_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pending confirmations: pause queue
CREATE TABLE IF NOT EXISTS pending_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decision_log(decision_id),
  tool_name TEXT NOT NULL,
  tool_params_json TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  trust_score REAL NOT NULL,
  threshold REAL NOT NULL,
  category TEXT NOT NULL,
  expires_at TEXT NOT NULL,     -- 10 minute TTL
  resolved INTEGER NOT NULL DEFAULT 0,
  resolution TEXT,               -- 'confirmed' | 'denied' | 'expired'
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 7.2 Migration

`src/migrations/010-earned-autonomy.ts`

Runs automatically on startup. Bootstraps `trust_scores` with initial values for all known categories.

---

## 8. File Structure

```
src/
├── trust/
│   ├── gate.ts                    # TrustGate — main entry point for pre-action hook
│   ├── classifier.ts              # ActionClassifier — rule-based tool→tier+category
│   ├── score-updater.ts           # EWMA update logic
│   ├── outcome-collector.ts       # Feedback window + correction detector
│   ├── milestone-detector.ts      # Score transition → milestone events
│   ├── reporter.ts                # ~/bin/trust-status + weekly Synapse summary
│   ├── override-manager.ts        # grant/revoke trust override commands
│   └── __tests__/
│       ├── classifier.test.ts
│       ├── gate.test.ts
│       ├── score-updater.test.ts
│       └── outcome-collector.test.ts
├── migrations/
│   └── 010-earned-autonomy.ts
└── types/
    └── trust.ts                   # All interfaces

~/bin/
├── trust-status                   # CLI: trust report by category + tier
└── trust-grant                    # CLI: matthew grant/revoke override
```

---

## 9. Trust Status CLI (`~/bin/trust-status`)

```
$ trust-status

EARNED AUTONOMY — TRUST REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generated: 2026-02-19 00:22 EST | 30-day window | 247 decisions

TIER 1 — READ-ONLY (threshold: 50%)
  read_file        ████████████████ 94%  ✅ auto-approve  [201 decisions]
  exec_status      ██████████████   82%  ✅ auto-approve  [38 decisions]
  cortex_query     ██████████████   80%  ✅ auto-approve  [156 decisions]
  web_search       ██████████████   79%  ✅ auto-approve  [87 decisions]
  synapse_read     ███████████████  88%  ✅ auto-approve  [312 decisions]

TIER 2 — NON-DESTRUCTIVE (threshold: 70%)
  write_file       ████████████     68%  ⏸ pause          [44 decisions]  ↓ -3% this week
  cortex_write     ██████████████   77%  ✅ auto-approve  [89 decisions]
  synapse_send     ██████████████   76%  ✅ auto-approve  [178 decisions]
  session_spawn    █████████████    73%  ✅ auto-approve  [22 decisions]

TIER 3 — INFRASTRUCTURE (threshold: 85%)
  service_restart  ████████████     68%  ⏸ pause          [12 decisions]
  config_change    █████████████    73%  ⏸ pause          [8 decisions]
  gateway_action   ██████████████   81%  ⏸ pause          [6 decisions]

TIER 4 — FINANCIAL (hardcap — always pause)
  financial_augur  (hardcap: never auto-approved)
  financial_crypto (hardcap: never auto-approved)

OVERRIDES ACTIVE
  [none]

RECENT MILESTONES
  2026-02-19 00:08  cortex_write crossed threshold → first_auto_approve
  2026-02-18 22:14  service_restart dropped below threshold → tier_demotion
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### `~/bin/trust-grant` CLI

```bash
# Grant override
trust-grant grant write_file --reason "batch file migration in progress" --expires "4h"

# Revoke override
trust-grant revoke write_file --reason "migration complete"

# Revoke all active overrides
trust-grant revoke-all
```

---

## 10. Weekly Synapse Summary

Posted every Monday at 6:00 AM (after the weekend's overnight learning cron):

```
EARNED AUTONOMY — WEEKLY TRUST SUMMARY
Week of 2026-02-13 to 2026-02-19 | 247 decisions tracked

PROMOTIONS (crossed threshold upward):
  ✅ cortex_write: 67% → 77% (first auto-approve)
  ✅ synapse_read: 66% → 76% (re-promoted after demotion 2026-02-12)

DEMOTIONS (crossed threshold downward):
  ⬇️  service_restart: 86% → 81% (cause: 2 config mistakes 2026-02-17)

BLOCKS (crossed floor):
  [none this week]

OUTCOME BREAKDOWN (all categories):
  Pass:               224 (91%)
  Corrected minor:     18 (7%)
  Corrected significant: 2 (1%)
  Tool errors:          3 (1%)

TREND: Overall reliability improving (+2.4% avg score vs. prior week)
Top improvement: cortex_write +15% | Biggest concern: service_restart -5%
```

---

## 11. Integration Points

### 11.1 Task-003 (Pre-Action Hooks)

The trust gate is a single `TrustGate.check(toolName, params, sessionId)` call inserted into the pre-action hook's execution flow, after SOP lookup and cortex process search. The hook already has the structure to block/pause/pass — the gate just adds a structured data source to that decision.

### 11.2 Task-005 (Predictive Intent)

Trust milestones (promotions, demotions, blocks) are stored in cortex memories and fed into the predictive intent system. If Helios is about to take an action in a recently-demoted category, Predictive Intent can proactively surface the context ("trust score dropped 5% in service_restart this week — confirm before proceeding?").

### 11.3 Task-006 (Self-Healing)

Self-healing actions (service restarts, process kills) go through the trust gate as Tier 3 `service_restart`. If the self-healing system has earned high trust in this category (via successful prior restarts), it auto-approves. If not, it pauses for confirmation. This prevents the self-healing system from autonomously taking infrastructure actions it hasn't earned the right to take.

### 11.4 Task-008 (Knowledge Compression)

The decision log grows unboundedly. Knowledge compression runs nightly — the compression engine targets `decision_log` entries older than 90 days, summarizing them into aggregate statistics in `trust_scores` and archiving the raw decisions to cold storage (SQLite attach or compressed JSON backup).

### 11.5 AUGUR

AUGUR trade execution is Tier 4 `financial_augur` — always pauses. The trust gate logs the decision (so we build a track record of AUGUR calling correctly) but never auto-approves. This is the designed hardcap.

---

## 12. Testing Plan (for Build Stage)

| Test                                                                            | Type        | Assertion                                                                            |
| ------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `Read` tool classifies as tier 1 `read_file`                                    | Unit        | ActionClassifier returns `{ tier: 1, category: 'read_file' }`                        |
| `exec("systemctl restart signal-cli")` classifies as tier 3 `service_restart`   | Unit        | Pattern match on "systemctl restart"                                                 |
| Unknown tool defaults to tier 2                                                 | Unit        | ActionClassifier fallback rule                                                       |
| Gate passes when score ≥ threshold                                              | Unit        | Mock DB score=0.80, threshold=0.70 → 'pass'                                          |
| Gate pauses when floor ≤ score < threshold                                      | Unit        | Mock DB score=0.50, floor=0.40, threshold=0.70 → 'pause'                             |
| Gate blocks when score < floor                                                  | Unit        | Mock DB score=0.30, floor=0.40 → 'block'                                             |
| Tier 4 always pauses regardless of score                                        | Unit        | Score=1.0, tier=4 → 'pause'                                                          |
| Grant override bypasses threshold                                               | Unit        | Mock override='granted', score=0.10 → 'pass'                                         |
| Revoke override blocks regardless of score                                      | Unit        | Mock override='revoked', score=0.99 → 'block'                                        |
| EWMA score update: pass outcome raises score                                    | Unit        | score=0.65, outcome='pass' → new_score > 0.65                                        |
| EWMA score update: significant correction lowers score                          | Unit        | score=0.90, outcome='corrected_significant' → new_score < 0.90                       |
| EWMA score bounded at [0, 1]                                                    | Unit        | 10 consecutive significant corrections from 0.0 → stays at 0.0                       |
| Milestone fires on threshold crossing                                           | Unit        | Score 0.69 → 0.71 (threshold=0.70) → milestone_type='first_auto_approve'             |
| No milestone on score change that doesn't cross threshold                       | Unit        | Score 0.75 → 0.77 (threshold=0.70) → no milestone                                    |
| Decision log record created on every gate.check call                            | Integration | gate.check() → decision_log entry exists with matching decision_id                   |
| Pending outcome record created on PASS gate decision                            | Integration | gate.check() → pending_outcomes entry with 30-min expiry                             |
| Outcome resolved as 'pass' after feedback window expires                        | Integration | Insert pending outcome → advance clock 31 min → outcome='pass', score updated        |
| Outcome resolved as 'corrected_minor' on correction detection                   | Integration | Inject correction text with "wrong" → outcome='corrected_minor'                      |
| trust-status CLI produces output for all categories                             | Integration | Run CLI → all known categories appear in output                                      |
| Weekly Synapse summary posts to correct thread                                  | Integration | Run reporter → synapse send with thread_id='trust-weekly-{date}'                     |
| Migration bootstraps trust_scores for all known categories                      | Integration | Fresh DB → migration → trust_scores has entries for all 15 default categories        |
| E2E: 10 pass decisions → score rises above threshold → gate transitions to PASS | E2E         | Start below threshold, 10 pass outcomes → gate result changes from 'pause' to 'pass' |

---

## 13. Implementation Plan (Build Stage)

| Step | Work                                                     | Files                                     |
| ---- | -------------------------------------------------------- | ----------------------------------------- |
| 1    | Types + interfaces                                       | `types/trust.ts`                          |
| 2    | DB migration + bootstrap                                 | `migrations/010-earned-autonomy.ts`       |
| 3    | ActionClassifier (rule table + classify function)        | `trust/classifier.ts`                     |
| 4    | TrustGate (core gate logic + decision logging)           | `trust/gate.ts`                           |
| 5    | EWMA Score Updater                                       | `trust/score-updater.ts`                  |
| 6    | OutcomeCollector (feedback window + correction detector) | `trust/outcome-collector.ts`              |
| 7    | MilestoneDetector                                        | `trust/milestone-detector.ts`             |
| 8    | OverrideManager (grant/revoke logic)                     | `trust/override-manager.ts`               |
| 9    | Reporter (trust-status + weekly Synapse)                 | `trust/reporter.ts`                       |
| 10   | Pre-action hook integration (task-003 hook.ts edit)      | `hooks/pre-action.ts` (edit)              |
| 11   | Shell CLIs                                               | `~/bin/trust-status`, `~/bin/trust-grant` |
| 12   | Weekly cron registration                                 | Cron tool call in deploy stage            |
| 13   | Unit + integration tests                                 | `trust/__tests__/`                        |

---

## 14. Security Considerations

**Trust overrides must not be self-granted.** The `trust_overrides` table has a `granted_by` column that is always set to 'matthew'. A check in `override-manager.ts` validates that override creation is only callable from a confirmed user instruction path (not from an agent-autonomous pipeline stage). If the pipeline stage itself tried to call `trust-grant grant ...`, the override manager rejects it because the session_id would not match the expected interactive session pattern.

**Score manipulation resistance.** The EWMA formula is deterministic and cannot be manipulated by injecting fake outcomes. Outcomes are written by the `OutcomeCollector` which reads from real tool results and Matthew's real messages — it does not accept externally-supplied outcomes. A compromised subagent posting a fake "pass" outcome to Synapse would not affect trust scores; the collector reads from session message history, not from Synapse payloads.

**Audit trail.** Every score change produces a decision_log row with the full causal chain: decision → outcome source → score delta. A forensic audit of any trust score can trace every contributing decision and its outcome. Nothing is silent.

---

## 15. Risks

| Risk                                                                 | Likelihood | Mitigation                                                                                                                    |
| -------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Correction detector has false positives ("no" used conversationally) | Medium     | Require correction keywords within 10 minutes of a logged PASS decision; conversational "no" without recent decision → ignore |
| High volume of Tier 1 read operations dilutes score signal           | Low        | Per-category EWMA with slower alpha (0.08 for Tier 1); read categories don't affect infrastructure categories                 |
| PAUSE queue grows unbounded if Matthew ignores confirmations         | Low        | 10-minute TTL on pending_confirmations; expired → treated as denied (conservative)                                            |
| Bootstrap scores are wrong for some categories                       | Low        | Matthew can immediately run `trust-status` and `trust-grant` to correct any miscalibrated starting scores                     |
| Trust gate adds latency to every tool call                           | Low        | Synchronous SQLite reads are typically < 1ms; gate target is ≤ 10ms total                                                     |
| Earned trust in one context doesn't reflect safety in another        | Medium     | Categories are narrow enough that context-transfer risk is low (write_file ≠ config_change)                                   |

---

## 16. Open Questions

1. **Feedback window duration**: 30 minutes is the proposed default. Should this differ by tier? (Tier 3 infrastructure changes might need a longer window — Matthew might not notice a bad restart for an hour.) Proposal: configurable per-tier, default 30/30/60/60 min.
2. **Historical backfill**: We have no decision history. Bootstrap scores are educated guesses. Should we synthesize a synthetic history from the existing session/atom record? Proposal: yes, run a one-time retrospective analysis at deploy time to calibrate initial scores more accurately.
3. **Override expiry UX**: When an override expires, does Helios proactively tell Matthew? Proposal: yes — 5 minutes before expiry, post a Synapse info message: "write_file override expires in 5 min. Renew with `trust-grant grant write_file`."
4. **Negative trust floor for critical categories**: Should `service_restart` have a higher floor (e.g., 0.70 instead of 0.60) than a lower-risk Tier 3 action? Proposal: yes — make floor configurable per-category in `trust-config.json`.
5. **Integration with task-011 (Real-Time Learning from Failure)**: When task-011 ships, trust corrections should be one of the failure signals that triggers instant SOP propagation. The earned autonomy system should emit a structured event on `corrected_significant` that task-011 can subscribe to.

---

_Next stage: document → build (TypeScript implementation)_
