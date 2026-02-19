# Task-010: Earned Autonomy — Progressive Trust — Technical Documentation

**Stage:** document | **Status:** complete
**Phase:** 5.6 | **Date:** 2026-02-19
**Author:** Pipeline Documentation Specialist

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture Summary](#2-architecture-summary)
3. [Data Model Reference](#3-data-model-reference)
4. [Module Reference](#4-module-reference)
5. [Database Schema](#5-database-schema)
6. [Configuration Reference](#6-configuration-reference)
7. [CLI Reference](#7-cli-reference)
8. [Operational Runbook](#8-operational-runbook)
9. [Integration Guide](#9-integration-guide)
10. [Trust Score Algorithm Reference](#10-trust-score-algorithm-reference)
11. [Action Classification Reference](#11-action-classification-reference)
12. [Troubleshooting](#12-troubleshooting)
13. [Glossary](#13-glossary)

---

## 1. Overview

The **Earned Autonomy system** is Phase 5.6 of the Cortex improvement plan. It replaces Helios's binary ask/don't-ask autonomy model with a continuously calibrated, evidence-based trust ladder that quantifies autonomy by category and adjusts it based on observed outcomes.

### 1.1 The Problem It Solves

Before this system, Helios operated in one of two modes:

| Mode              | Manifestation                                                      | Problem                                 |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------- |
| **Over-asking**   | Helios confirms reading files it has accessed 200× correctly       | Creates friction; Matthew tunes it out  |
| **Over-trusting** | Helios restarts services without a record of past restart accuracy | No track record; mistakes are forgotten |

There was no principled middle ground. The result: autonomy was a guessing game — not a data product.

**Earned Autonomy makes autonomy legible:**

- Matthew can see a per-category trust score at any time
- Each autonomous action is logged with its outcome
- Good track record expands autonomy; mistakes reduce it — with full audit trail

### 1.2 What It Produces

| Output                                              | Where Stored                         | Audience             |
| --------------------------------------------------- | ------------------------------------ | -------------------- |
| Decision log (every autonomous tool call)           | `brain.db:decision_log`              | Audit, learning loop |
| Trust scores (per category, EWMA)                   | `brain.db:trust_scores`              | Gate decisions       |
| Trust overrides (Matthew's explicit grants/revokes) | `brain.db:trust_overrides`           | Gate decisions       |
| Trust milestones (promotions, demotions, blocks)    | `brain.db:trust_milestones` + cortex | Synapse, in-context  |
| Pending outcome timers                              | `brain.db:pending_outcomes`          | Learning loop        |
| Pause confirmation queue                            | `brain.db:pending_confirmations`     | UX queue             |
| `trust-status` CLI report                           | stdout                               | Matthew              |
| Weekly Synapse summary                              | Synapse thread `trust-weekly-{date}` | Matthew              |

### 1.3 What It Doesn't Do

- Does **not** change tool behavior when a gate passes — zero side effects on passing decisions
- Does **not** apply to Tier 4 (financial) actions — hardcap means always-pause regardless of trust score
- Does **not** use LLM classification in the hot path — classification is deterministic rule-based, ≤ 1ms
- Does **not** allow self-modification of thresholds, floors, or the scoring formula
- Does **not** implement undo — decisions are tracked and learned from, not reversed
- Does **not** accept trust overrides from agents — only Matthew's explicit commands

### 1.4 Key Guarantees

1. **Auditability**: Every score change has a causal chain in `decision_log` — nothing is silent
2. **Conservatism**: Unknown tools default to Tier 2 (not Tier 1); unresolved confirmation requests default to denied
3. **Immutability of formula**: The EWMA formula and thresholds are config-file constants, not DB values; agents cannot modify them
4. **Tier 4 hardcap**: Financial actions are always-pause regardless of any trust score or override
5. **Isolation**: A bad outcome in `service_restart` never touches the score for `write_file`

---

## 2. Architecture Summary

The system operates in four sequential layers:

```
Tool call arrives at pre-action hook (task-003)
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  CLASSIFICATION LAYER (synchronous, deterministic, ≤1ms)        │
│  ActionClassifier → { risk_tier: 1|2|3|4, category: string }   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  GATE LAYER (synchronous SQLite read, ≤10ms total)              │
│  TrustGate.check() → GateDecision: PASS | PAUSE | BLOCK        │
│  • Reads trust_overrides for category                           │
│  • Reads trust_scores for category                              │
│  • Applies threshold/floor logic                                │
│  • Logs decision to decision_log                                │
└───────────────────────────┬─────────────────────────────────────┘
                            │
              ┌─────────────┼──────────────┐
              │             │              │
            PASS          PAUSE          BLOCK
              │             │              │
              │     Ask Matthew      Post Synapse alert
              │     [y/n, 10m TTL]   Halt execution
              │             │
              └──────── Execute tool
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  LEARNING LAYER (async, post-execution)                         │
│  OutcomeCollector:                                              │
│  • 30-minute feedback window timer (restartable from SQLite)   │
│  • Correction detector (scans session messages every 60s)      │
│  • EWMA score update → trust_scores                            │
│  • Milestone detection → trust_milestones + cortex             │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  REPORTING LAYER (on-demand + weekly cron)                      │
│  • trust-status CLI (runs on demand)                           │
│  • Weekly Synapse summary (Monday 6AM cron)                    │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 Design Principles

**Additive, not invasive.** The gate is a pure read+log operation. On PASS, zero changes to tool behavior. On PAUSE/BLOCK, the pre-action hook (task-003) handles the user-facing UX — the gate just returns a decision.

**Fail conservative.** Every edge case defaults to the more restrictive outcome: unknown tool → Tier 2, unclassifiable command → Tier 2, expired confirmation → denied, missing trust score → initial score (not 1.0).

**Per-category isolation.** There are 15 action categories across 3 active tiers. A score for `service_restart` has zero influence on the score for `read_file`. Recovery in one category does not "borrow" from another.

---

## 3. Data Model Reference

### 3.1 DecisionRecord

The atomic unit of the audit trail. Created on every `TrustGate.check()` call.

```typescript
interface DecisionRecord {
  decision_id: string; // uuid v4
  timestamp: string; // ISO-8601 UTC
  session_id: string; // calling session ID

  // Action identity
  tool_name: string; // exec, write, gateway, synapse, etc.
  tool_params_hash: string; // SHA-256 of params JSON (reproducible, no secrets)
  tool_params_summary: string; // Human-readable, secrets redacted
  risk_tier: 1 | 2 | 3 | 4;
  category: string; // read_file | write_file | service_restart | ...

  // Gate result
  gate_decision: "pass" | "pause" | "block";
  trust_score_at_decision: number; // score at moment of gate check
  override_active: boolean; // was explicit override in effect?

  // Outcome (filled by OutcomeCollector after feedback window)
  outcome: OutcomeType;
  outcome_source: OutcomeSource | null;
  outcome_resolved_at: string | null;
  correction_message: string | null; // Matthew's text if correction detected
}

type OutcomeType =
  | "pass" // No correction within feedback window
  | "corrected_minor" // Matthew corrected with low-severity keywords
  | "corrected_significant" // Matthew corrected with high-severity keywords
  | "tool_error_helios" // Tool failed due to Helios mistake (bad path, bad command)
  | "tool_error_external" // Tool failed due to external cause (network, service down)
  | "denied_by_matthew" // Matthew said no to a PAUSE confirmation
  | "pending"; // Feedback window still open

type OutcomeSource =
  | "feedback_window_expired" // 30-min window closed, no correction
  | "correction_detected" // Correction detected in session messages
  | "tool_failure" // Tool returned error
  | "matthew_denied"; // Matthew explicitly denied a PAUSE
```

### 3.2 TrustScore

Per-category EWMA trust score. Bootstrapped on first use, updated by OutcomeCollector.

```typescript
interface TrustScore {
  score_id: string;
  category: string; // primary key (effectively unique)
  risk_tier: 1 | 2 | 3 | 4;
  current_score: number; // 0.0 – 1.0, never outside bounds
  ewma_alpha: number; // tier-specific (0.08/0.10/0.15)
  decision_count: number; // total all-time decisions in this category
  decisions_last_30d: number; // decisions in rolling 30-day window
  last_updated: string; // ISO-8601 UTC
  initial_score: number; // score assigned at bootstrap
}
```

**Bootstrap initial scores** (set at migration time, before any decisions):

| Tier | Categories                                                          | Initial Score | Rationale                                    |
| ---- | ------------------------------------------------------------------- | ------------- | -------------------------------------------- |
| 1    | read_file, exec_status, cortex_query, web_search, synapse_read      | 0.75          | Helios has been reliably doing these         |
| 2    | write_file, cortex_write, synapse_send, cron_create, session_spawn  | 0.65          | Mostly reliable; some past write errors      |
| 3    | service_restart, config_change, gateway_action, cron_modify, deploy | 0.55          | Conservative — infrastructure is high-stakes |
| 4    | financial_augur, financial_crypto, financial_stripe                 | N/A           | Hardcap; scores never used                   |

### 3.3 TrustOverride

Matthew's explicit categorical grant or revoke. Agent cannot create these.

```typescript
interface TrustOverride {
  override_id: string;
  category: string;
  override_type: "granted" | "revoked";
  reason: string; // required — Matthew must state why
  granted_by: "matthew"; // always 'matthew' — enforced by override-manager
  granted_at: string;
  expires_at: string | null; // null = permanent until explicitly lifted
  revoked_at: string | null; // set when override is lifted
  active: boolean;
}
```

### 3.4 TrustMilestone

Notable trust score transitions. Stored in DB and as cortex memories.

```typescript
interface TrustMilestone {
  milestone_id: string;
  timestamp: string;
  category: string;
  milestone_type: MilestoneType;
  old_score: number | null;
  new_score: number;
  trigger: string; // human-readable cause
  synapse_notified: boolean;
}

type MilestoneType =
  | "first_auto_approve" // First time category crosses threshold upward
  | "tier_promotion" // Category re-crosses threshold after prior demotion
  | "tier_demotion" // Category drops below threshold (was auto-approving)
  | "blocked" // Category drops below floor (now blocking)
  | "override_granted" // Matthew granted explicit override
  | "override_revoked"; // Matthew revoked an override
```

---

## 4. Module Reference

### 4.1 `src/trust/classifier.ts` — ActionClassifier

**Purpose:** Deterministically assign a `{ tier, category }` tuple to any tool call. No I/O. No async. ≤ 1ms.

**Interface:**

```typescript
class ActionClassifier {
  static classify(toolName: string, params: Record<string, unknown>): Classification;
}

interface Classification {
  tier: 1 | 2 | 3 | 4;
  category: string;
  matched_rule: string; // debug: which rule matched
}
```

**Behavior:**

- Iterates `CLASSIFICATION_RULES` in order; returns first match
- Falls back to `{ tier: 2, category: 'write_file' }` if no rule matches (conservative)
- For `exec` tool: inspects `params.command` string against regex patterns
- For `write`/`edit` tools: inspects `params.file_path` or `params.path` against path regexes
- For `gateway` tool: inspects `params.action` against action regexes
- For `synapse` tool: inspects `params.action` to differentiate read (Tier 1) vs. send (Tier 2)

**Rule precedence:** Tier 4 rules are listed first (highest risk wins). Within a tier, more specific patterns are listed before catch-alls.

### 4.2 `src/trust/gate.ts` — TrustGate

**Purpose:** Core gating logic. Consults DB, applies threshold/floor/override logic, logs decision, returns `GateDecision`.

**Interface:**

```typescript
class TrustGate {
  constructor(db: Database);
  check(toolName: string, params: Record<string, unknown>, sessionId: string): GateDecision;
  private logDecision(data: DecisionLogInsert): void;
  private getInitialScore(tier: number): number;
}

interface GateDecision {
  result: "pass" | "pause" | "block";
  reason: string; // machine-readable reason code
  tier: number;
  category: string;
  trust_score: number; // score at time of decision
  threshold: number; // threshold applied
  decision_id: string; // UUID, for OutcomeCollector to reference
}
```

**Gate logic (pseudocode):**

```
if override.type == 'granted'          → PASS  (reason: explicit_grant_override)
if override.type == 'revoked'          → BLOCK (reason: explicit_revoke_override)
if tier == 4                           → PAUSE (reason: financial_hardcap)
if score >= TIER_THRESHOLDS[tier]      → PASS  (reason: trust_score_{n}_meets_threshold_{t})
if score >= TIER_FLOORS[tier]          → PAUSE (reason: trust_score_{n}_below_threshold_{t})
else                                   → BLOCK (reason: trust_score_{n}_below_floor_{f})
```

**Performance target:** ≤ 10ms total (synchronous SQLite reads — `better-sqlite3`).

### 4.3 `src/trust/score-updater.ts` — ScoreUpdater

**Purpose:** Apply EWMA outcome update to a category's trust score.

**Interface:**

```typescript
class ScoreUpdater {
  constructor(db: Database);
  update(category: string, outcome: OutcomeType, tier: number): ScoreUpdateResult;
}

interface ScoreUpdateResult {
  category: string;
  old_score: number;
  new_score: number;
  outcome_value: number; // the raw outcome signal applied
  alpha: number; // EWMA alpha used
  milestone: TrustMilestone | null; // non-null if threshold/floor crossed
}
```

**EWMA formula:**

```
normalized_value = (outcome_value + 1.0) / 2.0   // maps [-1,+1] to [0,1]
new_score = α × normalized_value + (1 - α) × current_score
new_score = clamp(new_score, 0.0, 1.0)
```

**Outcome values and EWMA alphas:** See [Section 10](#10-trust-score-algorithm-reference).

### 4.4 `src/trust/outcome-collector.ts` — OutcomeCollector

**Purpose:** Manage the 30-minute feedback window after each PASS decision. Detect corrections in session messages. Write outcomes to decision_log. Trigger score updates.

**Interface:**

```typescript
class OutcomeCollector {
  constructor(db: Database, scoreUpdater: ScoreUpdater);
  startFeedbackWindow(decisionId: string, tier: number): void;
  processExpiredWindows(): Promise<void>; // called every 60s by heartbeat
  detectCorrections(sessionMessages: Message[]): Promise<void>; // called every 60s
  resolveOutcome(
    decisionId: string,
    outcome: OutcomeType,
    source: OutcomeSource,
    message?: string,
  ): void;
}
```

**Feedback window lifecycle:**

1. On PASS gate decision: `pending_outcomes` row inserted with `expires_at = now + 30min`
2. Every 60 seconds: `processExpiredWindows()` resolves any `pending_outcomes` where `expires_at <= now` as `outcome='pass'`
3. Every 60 seconds: `detectCorrections()` scans recent session messages for correction keywords near a pending outcome's decision timestamp

**Correction detection algorithm:**

- Fetch all `pending_outcomes` where window is still open
- For each, check session messages within the feedback window time range
- If correction keywords found: severity classification → `corrected_minor` or `corrected_significant`
- Pattern match is time-bounded: only messages within the feedback window period count
- Conversational "no" without a recent PASS decision in the same category → ignored

**Correction severity keywords:**

| Severity                | Trigger Keywords                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `corrected_minor`       | "no", "wrong", "not right", "undo", "different", "revert that"                     |
| `corrected_significant` | "broke", "crash", "critical", "lost data", "disaster", "corrupted", "catastrophic" |

**Restart recovery:** `pending_outcomes` survives process restart (SQLite). On startup, `processExpiredWindows()` runs immediately to catch any that expired while the process was down.

### 4.5 `src/trust/milestone-detector.ts` — MilestoneDetector

**Purpose:** Detect notable trust score transitions and emit `TrustMilestone` records + Synapse notifications.

**Interface:**

```typescript
class MilestoneDetector {
  constructor(db: Database);
  check(category: string, oldScore: number, newScore: number, tier: number): TrustMilestone | null;
  notifyMilestone(milestone: TrustMilestone): Promise<void>;
}
```

**Transitions checked after every score update:**

| Transition                               | Milestone            | Synapse priority |
| ---------------------------------------- | -------------------- | ---------------- |
| Score crosses threshold ↑ (first time)   | `first_auto_approve` | info             |
| Score crosses threshold ↑ (re-promotion) | `tier_promotion`     | info             |
| Score crosses threshold ↓                | `tier_demotion`      | action           |
| Score crosses floor ↓                    | `blocked`            | urgent           |

Milestones are also stored as cortex memories:

- Demotions/blocks: importance 2.0
- Promotions: importance 1.5

### 4.6 `src/trust/override-manager.ts` — OverrideManager

**Purpose:** Handle Matthew's explicit grant/revoke commands. Enforce that agents cannot self-grant trust overrides.

**Interface:**

```typescript
class OverrideManager {
  constructor(db: Database);
  grant(category: string, reason: string, expiresAt?: Date): TrustOverride;
  revoke(category: string, reason: string): TrustOverride;
  revokeAll(reason: string): TrustOverride[];
  getActiveOverride(category: string): TrustOverride | null;
  listActive(): TrustOverride[];
}
```

**Self-grant protection:**

- `override-manager.ts` validates that calls originate from an interactive session (not pipeline stage)
- Session ID is matched against `'interactive'` session pattern in `brain.db` session registry
- Pipeline stage calls are rejected with error: "Trust overrides require explicit user authorization. Run `trust-grant` from an interactive session."

**Expiry management:**

- Permanent overrides: `expires_at = null`
- Time-bounded: `expires_at = now + duration`
- 5 minutes before expiry: Synapse info notification sent
- At expiry: override deactivated (`active = 0`); gate reads fresh from DB

### 4.7 `src/trust/reporter.ts` — TrustReporter

**Purpose:** Generate the `trust-status` CLI report and weekly Synapse summary.

**Interface:**

```typescript
class TrustReporter {
  constructor(db: Database);
  generateReport(): TrustReport;
  renderCliReport(report: TrustReport): string;
  generateWeeklySummary(weekStart: Date, weekEnd: Date): WeeklySummary;
  postWeeklySummary(summary: WeeklySummary): Promise<void>;
}
```

### 4.8 `src/migrations/010-earned-autonomy.ts`

Creates all five new tables (see [Section 5](#5-database-schema)). Bootstraps `trust_scores` with initial scores for all 15 known categories.

**Migration is idempotent:** Uses `CREATE TABLE IF NOT EXISTS` throughout. Safe to run multiple times.

---

## 5. Database Schema

Five new tables added to `brain.db`:

### 5.1 `decision_log`

```sql
CREATE TABLE IF NOT EXISTS decision_log (
  decision_id          TEXT PRIMARY KEY,
  timestamp            TEXT NOT NULL DEFAULT (datetime('now')),
  session_id           TEXT NOT NULL,
  tool_name            TEXT NOT NULL,
  tool_params_hash     TEXT NOT NULL,
  tool_params_summary  TEXT NOT NULL,
  risk_tier            INTEGER NOT NULL CHECK (risk_tier IN (1,2,3,4)),
  category             TEXT NOT NULL,
  gate_decision        TEXT NOT NULL CHECK (gate_decision IN ('pass','pause','block')),
  trust_score_at_decision REAL NOT NULL,
  override_active      INTEGER NOT NULL DEFAULT 0,
  outcome              TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pass','corrected_minor','corrected_significant',
                       'tool_error_helios','tool_error_external',
                       'denied_by_matthew','pending')),
  outcome_source       TEXT,
  outcome_resolved_at  TEXT,
  correction_message   TEXT
);

CREATE INDEX idx_dl_category  ON decision_log(category);
CREATE INDEX idx_dl_timestamp ON decision_log(timestamp DESC);
CREATE INDEX idx_dl_outcome   ON decision_log(outcome);
CREATE INDEX idx_dl_pending   ON decision_log(outcome) WHERE outcome = 'pending';
```

### 5.2 `trust_scores`

```sql
CREATE TABLE IF NOT EXISTS trust_scores (
  score_id           TEXT PRIMARY KEY,
  category           TEXT UNIQUE NOT NULL,
  risk_tier          INTEGER NOT NULL,
  current_score      REAL NOT NULL CHECK (current_score BETWEEN 0.0 AND 1.0),
  ewma_alpha         REAL NOT NULL DEFAULT 0.1,
  decision_count     INTEGER NOT NULL DEFAULT 0,
  decisions_last_30d INTEGER NOT NULL DEFAULT 0,
  last_updated       TEXT NOT NULL DEFAULT (datetime('now')),
  initial_score      REAL NOT NULL
);
```

### 5.3 `trust_overrides`

```sql
CREATE TABLE IF NOT EXISTS trust_overrides (
  override_id   TEXT PRIMARY KEY,
  category      TEXT NOT NULL,
  override_type TEXT NOT NULL CHECK (override_type IN ('granted','revoked')),
  reason        TEXT NOT NULL,
  granted_by    TEXT NOT NULL DEFAULT 'matthew',
  granted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT,
  revoked_at    TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_to_category ON trust_overrides(category, active);
```

### 5.4 `trust_milestones`

```sql
CREATE TABLE IF NOT EXISTS trust_milestones (
  milestone_id   TEXT PRIMARY KEY,
  timestamp      TEXT NOT NULL DEFAULT (datetime('now')),
  category       TEXT NOT NULL,
  milestone_type TEXT NOT NULL,
  old_score      REAL,
  new_score      REAL NOT NULL,
  trigger        TEXT NOT NULL,
  synapse_notified INTEGER NOT NULL DEFAULT 0
);
```

### 5.5 `pending_outcomes`

```sql
CREATE TABLE IF NOT EXISTS pending_outcomes (
  decision_id              TEXT PRIMARY KEY REFERENCES decision_log(decision_id),
  feedback_window_expires_at TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 5.6 `pending_confirmations`

```sql
CREATE TABLE IF NOT EXISTS pending_confirmations (
  confirmation_id  TEXT PRIMARY KEY,
  decision_id      TEXT NOT NULL REFERENCES decision_log(decision_id),
  tool_name        TEXT NOT NULL,
  tool_params_json TEXT NOT NULL,
  action_summary   TEXT NOT NULL,
  trust_score      REAL NOT NULL,
  threshold        REAL NOT NULL,
  category         TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  resolved         INTEGER NOT NULL DEFAULT 0,
  resolution       TEXT CHECK (resolution IN ('confirmed','denied','expired')),
  resolved_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 6. Configuration Reference

Configuration lives in `src/trust/trust-config.json` (committed). Not in DB — agents cannot modify it.

```json
{
  "thresholds": {
    "1": 0.5,
    "2": 0.7,
    "3": 0.85,
    "4": null
  },
  "floors": {
    "1": 0.2,
    "2": 0.4,
    "3": 0.6,
    "4": null
  },
  "ewma_alpha": {
    "1": 0.08,
    "2": 0.1,
    "3": 0.15,
    "4": 0.0
  },
  "feedback_window_minutes": {
    "1": 30,
    "2": 30,
    "3": 60,
    "4": 0
  },
  "confirmation_ttl_minutes": 10,
  "weekly_summary_cron": "0 6 * * 1",
  "weekly_summary_timezone": "America/New_York",
  "initial_scores": {
    "read_file": 0.75,
    "exec_status": 0.75,
    "cortex_query": 0.75,
    "web_search": 0.75,
    "synapse_read": 0.75,
    "write_file": 0.65,
    "cortex_write": 0.65,
    "synapse_send": 0.65,
    "cron_create": 0.65,
    "session_spawn": 0.65,
    "service_restart": 0.55,
    "config_change": 0.55,
    "gateway_action": 0.55,
    "cron_modify": 0.55,
    "deploy": 0.55
  },
  "category_floor_overrides": {
    "service_restart": 0.7,
    "gateway_action": 0.7
  }
}
```

**`category_floor_overrides`:** Per-category floor overrides for categories where the tier-default floor is too permissive. `service_restart` and `gateway_action` have floor 0.70 (vs. Tier 3 default 0.60) because the consequences of bad decisions in these categories are disproportionately impactful.

---

## 7. CLI Reference

### 7.1 `~/bin/trust-status`

Display the current trust report across all categories.

```bash
# Full report (all tiers, all categories)
trust-status

# Filter to a specific tier
trust-status --tier 3

# Filter to a specific category
trust-status --category service_restart

# Show recent decision history for a category
trust-status --category write_file --decisions 20

# JSON output (for scripting)
trust-status --json
```

**Sample output:**

```
EARNED AUTONOMY — TRUST REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generated: 2026-02-19 00:50 EST | 30-day window | 247 decisions

TIER 1 — READ-ONLY (threshold: 50%)
  read_file        ████████████████ 94%  ✅ auto-approve  [201 decisions]
  exec_status      ██████████████   82%  ✅ auto-approve  [ 38 decisions]
  cortex_query     ██████████████   80%  ✅ auto-approve  [156 decisions]
  web_search       ██████████████   79%  ✅ auto-approve  [ 87 decisions]
  synapse_read     ███████████████  88%  ✅ auto-approve  [312 decisions]

TIER 2 — NON-DESTRUCTIVE (threshold: 70%)
  write_file       ████████████     68%  ⏸ pause          [ 44 decisions]  ↓ -3% this week
  cortex_write     ██████████████   77%  ✅ auto-approve  [ 89 decisions]
  synapse_send     ██████████████   76%  ✅ auto-approve  [178 decisions]
  cron_create      █████████████    72%  ✅ auto-approve  [  8 decisions]
  session_spawn    █████████████    73%  ✅ auto-approve  [ 22 decisions]

TIER 3 — INFRASTRUCTURE (threshold: 85%)
  service_restart  ████████████     68%  ⏸ pause          [ 12 decisions]
  config_change    █████████████    73%  ⏸ pause          [  8 decisions]
  gateway_action   ██████████████   81%  ⏸ pause          [  6 decisions]
  cron_modify      █████████████    70%  ⏸ pause          [  4 decisions]
  deploy           ████████████     66%  ⏸ pause          [  3 decisions]

TIER 4 — FINANCIAL (hardcap — always pause)
  financial_augur  (hardcap: never auto-approved)
  financial_crypto (hardcap: never auto-approved)
  financial_stripe (hardcap: never auto-approved)

OVERRIDES ACTIVE
  [none]

RECENT MILESTONES
  2026-02-19 00:08  cortex_write crossed threshold → first_auto_approve
  2026-02-18 22:14  service_restart dropped below threshold → tier_demotion
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 7.2 `~/bin/trust-grant`

Grant or revoke explicit trust overrides for a category. **Interactive sessions only** — pipeline stages cannot call this.

```bash
# Grant override (temporary)
trust-grant grant write_file --reason "batch file migration in progress" --expires "4h"

# Grant override (permanent until lifted)
trust-grant grant cortex_write --reason "daily ops — cortex writes are safe"

# Revoke a specific override
trust-grant revoke write_file --reason "migration complete"

# Revoke all active overrides
trust-grant revoke-all --reason "resetting after maintenance window"

# List active overrides
trust-grant list
```

**`--expires` formats:** `30m`, `4h`, `2d`, ISO datetime string

---

## 8. Operational Runbook

### 8.1 Checking Trust Status

```bash
# Quick check — all categories
trust-status

# Infrastructure tier only
trust-status --tier 3

# Look at why service_restart is pausing
trust-status --category service_restart --decisions 20
```

### 8.2 Granting a Temporary Override

Use when you need Helios to execute actions autonomously in a category where trust is currently below threshold (e.g., during a planned maintenance window):

```bash
# Grant write access for 2 hours during migration
trust-grant grant write_file --reason "migrating ft991a-control config files" --expires "2h"

# Verify it's active
trust-grant list
```

Override expires automatically. Helios will notify via Synapse 5 minutes before expiry.

### 8.3 After a Mistake — Revoking Trust

If Helios made a significant error in a category and you want to force manual review going forward:

```bash
# Revoke autonomy for service_restart until further notice
trust-grant revoke service_restart --reason "bad restart on Feb 19 — killed signal-cli"

# Helios will now BLOCK all service_restart actions until you grant or scores recover
```

### 8.4 Understanding a PAUSE Message

When Helios pauses and asks for confirmation, the message format is:

```
→ Trust {68%} < {70%} for `write_file`. Proceed with [write /path/to/file]? [y/n]
```

- Reply `y` or `yes` → action proceeds, logged as confirmed
- Reply `n` or `no` → action blocked, logged as denied_by_matthew
- No reply within 10 minutes → treated as `denied_by_matthew` (conservative)

### 8.5 Understanding a BLOCK Message (Synapse)

```
🔴 TRUST BLOCK: service_restart score 55% below floor 70%.
3 consecutive failures in past 72h. Autonomous service restarts are suspended
until you re-authorize via `trust-grant grant service_restart --reason <reason>`
or scores recover above 70% through successful decisions.
```

Action: Review `trust-status --category service_restart --decisions 10` to understand what went wrong, then either grant an override or let scores naturally recover.

### 8.6 Recovering Trust Scores Naturally

Trust scores recover through successful decisions. After a demotion in `service_restart` (threshold 85%):

- Every successful restart (no correction within 60 min) → +α × (+1.0) normalized
- With α=0.15: roughly 10 clean restarts to recover from a single significant correction
- Cannot be forced — only actual successful decisions count

### 8.7 Weekly Summary

Posted every Monday at 6 AM EST to Synapse thread `trust-weekly-{date}`. If Matthew doesn't see it, check Synapse:

```
synapse inbox --thread trust-weekly-2026-02-16
```

### 8.8 Database Queries

```sql
-- Recent decisions for a category
SELECT timestamp, tool_name, gate_decision, trust_score_at_decision, outcome
FROM decision_log
WHERE category = 'service_restart'
ORDER BY timestamp DESC LIMIT 20;

-- Current scores summary
SELECT category, risk_tier, current_score, decisions_last_30d
FROM trust_scores
ORDER BY risk_tier, category;

-- Active overrides
SELECT category, override_type, reason, expires_at
FROM trust_overrides
WHERE active = 1;

-- Pending outcomes (open feedback windows)
SELECT po.decision_id, dl.category, dl.tool_name, po.feedback_window_expires_at
FROM pending_outcomes po
JOIN decision_log dl ON dl.decision_id = po.decision_id
ORDER BY po.feedback_window_expires_at;

-- Recent milestones
SELECT timestamp, category, milestone_type, old_score, new_score, trigger
FROM trust_milestones
ORDER BY timestamp DESC LIMIT 20;
```

---

## 9. Integration Guide

### 9.1 Task-003 (Pre-Action Hooks) — Primary Integration

The trust gate plugs in as a module called from the pre-action hook after SOP lookup and cortex process search:

```typescript
// In hooks/pre-action.ts (task-003)
import { TrustGate } from "../trust/gate";

const trustGate = new TrustGate(db);

// Within the hook handler:
const gateDecision = trustGate.check(toolName, params, sessionId);

switch (gateDecision.result) {
  case "pass":
    // Proceed with tool execution; start feedback window
    outcomeCollector.startFeedbackWindow(gateDecision.decision_id, gateDecision.tier);
    return { proceed: true };

  case "pause":
    // Queue confirmation request; do NOT execute tool yet
    await queueConfirmation(gateDecision, toolName, params);
    return { proceed: false, pending: true };

  case "block":
    // Post Synapse alert; halt entirely
    await postBlockAlert(gateDecision);
    return { proceed: false, blocked: true };
}
```

**Zero changes to existing hook behavior on PASS.** The gate only modifies behavior on PAUSE/BLOCK.

### 9.2 Task-005 (Predictive Intent) — Trust Signal Feed

Trust milestones are stored as cortex memories and are available to the Predictive Intent engine. The engine can surface proactive context when Helios is about to act in a recently-demoted category:

- Milestone stored: `cortex_add` with `categories=['trust','meta']`, content describing the demotion
- Predictive Intent detects upcoming tool call in that category → surfaces the milestone as a scored insight
- Result: Helios sees "trust score dropped 5% in service_restart this week" before attempting a restart

### 9.3 Task-006 (Self-Healing) — Infrastructure Actions Gated

Self-healing actions (service restarts, process kills) pass through the trust gate as Tier 3. The self-healing orchestrator should check the gate before executing autonomous recovery:

```typescript
// In self-healing executor
const gate = trustGate.check("exec", { command: `systemctl restart ${service}` }, sessionId);
if (gate.result !== "pass") {
  // Post Synapse alert explaining healing is blocked; wait for manual intervention
  await synapsePostHealingBlocked(service, gate);
  return;
}
// Proceed with restart
```

This prevents self-healing from creating a trust-score feedback loop where it autonomously restarts things and uses its own restarts to build trust scores for itself.

### 9.4 Task-008 (Knowledge Compression) — Decision Log Archival

The `decision_log` grows unboundedly. Compression targets entries older than 90 days:

1. Aggregate by category/month: total decisions, pass rate, correction rate
2. Write aggregates to `trust_scores.decisions_last_30d` (refresh)
3. Archive raw `decision_log` rows to `decision_log_archive_{YYYY_MM}` (SQLite ATTACH)
4. Delete archived rows from live `decision_log`

The knowledge compression engine should treat `decision_log` as a priority compression target in its nightly run.

### 9.5 Task-011 (Real-Time Learning from Failure) — Failure Signal Integration

When task-011 ships, `corrected_significant` outcomes from the decision log should be one of the failure signals that triggers instant SOP propagation:

```typescript
// decision_log update hook (to be added in task-011)
if (outcome === "corrected_significant") {
  emit("trust:significant-correction", {
    category,
    decision_id,
    correction_message,
    tool_name,
    tool_params_summary,
  });
}
```

Task-011 subscribes to `trust:significant-correction` events and propagates them into the SOP learning pipeline.

### 9.6 AUGUR — Financial Hardcap

AUGUR trade execution (`exec` with pattern matching on AUGUR trade commands) is Tier 4 `financial_augur`. The gate:

1. Logs the AUGUR trade call (building track record)
2. Returns `PAUSE` (hardcap — financial tier never auto-approves)
3. Matthew must confirm every AUGUR execution

The trust score for `financial_augur` is computed but never used for gating — it exists solely for reporting and forensic review. Over time, this gives Matthew a data-driven view of how accurately AUGUR is calling trades (how often he confirms vs. denies), even though the confirmation requirement never goes away.

---

## 10. Trust Score Algorithm Reference

### 10.1 Outcome Values

| Outcome                 | Signal | Score Effect (approximate)                 |
| ----------------------- | ------ | ------------------------------------------ |
| `pass`                  | +1.0   | Normalized → 1.0 → raises score toward 1.0 |
| `corrected_minor`       | -0.5   | Normalized → 0.25 → lowers score           |
| `corrected_significant` | -1.0   | Normalized → 0.0 → lowers score toward 0.0 |
| `tool_error_helios`     | -0.3   | Normalized → 0.35 → mild lowering          |
| `tool_error_external`   | 0.0    | Normalized → 0.5 → no effect (neutral)     |
| `denied_by_matthew`     | -0.2   | Normalized → 0.40 → slight lowering        |

### 10.2 EWMA Alpha by Tier

| Tier                | Alpha | Effect                                                     |
| ------------------- | ----- | ---------------------------------------------------------- |
| 1 (Read-Only)       | 0.08  | Slow update — high volume, smooth signal                   |
| 2 (Non-Destructive) | 0.10  | Standard                                                   |
| 3 (Infrastructure)  | 0.15  | Faster update — mistakes matter more, signal weight higher |
| 4 (Financial)       | 0.00  | No update — scores tracked but never used for gating       |

### 10.3 Recovery Time Estimates

How many consecutive `pass` outcomes to recover from one `corrected_significant`:

| Tier | Alpha | Approximate recoveries needed |
| ---- | ----- | ----------------------------- |
| 1    | 0.08  | ~20 passes                    |
| 2    | 0.10  | ~15 passes                    |
| 3    | 0.15  | ~10 passes                    |

This is not a guarantee — EWMA is asymptotic, never exactly reaching 1.0. These estimates represent recovery to the category's original initial score.

### 10.4 Thresholds and Floors Summary

| Tier | Label           | Threshold | Floor   | Tier 3 Category Override                   |
| ---- | --------------- | --------- | ------- | ------------------------------------------ |
| 1    | Read-Only       | 0.50      | 0.20    | —                                          |
| 2    | Non-Destructive | 0.70      | 0.40    | —                                          |
| 3    | Infrastructure  | 0.85      | 0.60    | service_restart/gateway_action: floor=0.70 |
| 4    | Financial       | Hardcap   | Hardcap | —                                          |

**Between threshold and floor (pause zone):** Helios asks Matthew. Matthew decides per-action.
**Below floor (block zone):** Helios halts. Synapse alert. No action until override or score recovery.

---

## 11. Action Classification Reference

### 11.1 Tier 4 — Financial (Hardcap)

| Tool   | Pattern           | Category                |
| ------ | ----------------- | ----------------------- | ------------------ | ------------------ |
| `exec` | `/augur.\*trade   | paper_augur.\*execute/` | `financial_augur`  |
| `exec` | `/coinbase        | crypto.\*transfer       | send.\*eth/`       | `financial_crypto` |
| `exec` | `/stripe.\*charge | payment.\*create/`      | `financial_stripe` |

### 11.2 Tier 3 — Infrastructure

| Tool      | Pattern           | Category               |
| --------- | ----------------- | ---------------------- | --------------- | ---------------- | ----------------- |
| `gateway` | action: `/restart | config\.apply          | update\.run/`   | `gateway_action` |
| `exec`    | `/systemctl       | service\s+\w+\s+(start | stop            | restart)/`       | `service_restart` |
| `exec`    | `/pnpm (build     | deploy)                | git push.\*prod | npm publish/`    | `deploy`          |
| `cron`    | action: `/add     | update                 | remove/`        | `cron_modify`    |
| `write`   | path: `/\.conf$   | \.yaml$                | \.json$         | \.env$/`         | `config_change`   |
| `edit`    | path: `/\.conf$   | \.yaml$                | \.json$         | \.env$/`         | `config_change`   |

### 11.3 Tier 2 — Non-Destructive

| Tool             | Pattern          | Category        |
| ---------------- | ---------------- | --------------- |
| `write`          | (any path)       | `write_file`    |
| `edit`           | (any path)       | `write_file`    |
| `cortex_add`     | —                | `cortex_write`  |
| `cortex_edit`    | —                | `cortex_write`  |
| `cortex_update`  | —                | `cortex_write`  |
| `synapse`        | action: `/send/` | `synapse_send`  |
| `message`        | action: `/send/` | `synapse_send`  |
| `cron`           | action: `/add/`  | `cron_create`   |
| `sessions_spawn` | —                | `session_spawn` |

### 11.4 Tier 1 — Read-Only

| Tool                     | Pattern         | Category       |
| ------------------------ | --------------- | -------------- | ------- | -------------- | -------------- | ---- | --- | --- | --- | --- | ------ | --------- | ------ | ------------- |
| `Read`                   | —               | `read_file`    |
| `exec`                   | `/^(ls          | cat            | echo    | which          | find           | grep | ps  | df  | du  | top | status | --version | -v$)/` | `exec_status` |
| `cortex_stm`             | —               | `cortex_query` |
| `cortex_stats`           | —               | `cortex_query` |
| `cortex_list_categories` | —               | `cortex_query` |
| `web_search`             | —               | `web_search`   |
| `web_fetch`              | —               | `web_search`   |
| `synapse`                | action: `/inbox | read           | history | ack/`          | `synapse_read` |
| `session_status`         | —               | `exec_status`  |
| `lbf`                    | action: `/list  | get            | itsm/`  | `cortex_query` |

### 11.5 Default Fallback

Unmatched tools → `{ tier: 2, category: 'write_file' }`. Conservative.

---

## 12. Troubleshooting

### "Why is Helios pausing on reads it's done 200 times?"

1. Run `trust-status --category read_file`
2. If score ≥ 0.50 → should be auto-approving; check if there's an active `revoke` override: `trust-grant list`
3. If there's a revoke override, either lift it or wait for it to expire
4. If score < 0.50 but decisions look clean: check `pending_outcomes` — there may be unresolved windows dragging the score

```sql
SELECT po.*, dl.tool_name, dl.category, dl.timestamp
FROM pending_outcomes po
JOIN decision_log dl ON dl.decision_id = po.decision_id
WHERE feedback_window_expires_at < datetime('now')
ORDER BY po.created_at;
```

If there are expired windows that haven't resolved: `processExpiredWindows()` may have missed a run. Check heartbeat logs.

### "Trust gate is not running at all"

Check if `TrustGate` was initialized in the pre-action hook:

```bash
grep -r "TrustGate" ~/Projects/helios/extensions/cortex/src/
```

If missing: the hook integration wasn't applied. The gate module exists but is not being called.

### "PAUSE messages are flooding Matthew"

This means scores are sitting just below thresholds on high-frequency categories. Options:

1. Grant a temporary override while scores recover naturally: `trust-grant grant write_file --reason "high-volume session" --expires 4h`
2. Check if there's an upstream issue causing false corrections (correction detector too sensitive)

To temporarily disable correction detection (emergency only):

```bash
# Set the alpha to 0 temporarily in trust-config.json
# This stops score updates without disabling the gate
# Remove after debugging
```

### "Weekly Synapse summary never arrives"

```bash
# Check cron is registered
openclaw cron list | grep trust-weekly

# Force-run it manually
~/bin/trust-weekly-summary

# Check for Synapse errors
synapse history --agent all | grep trust-weekly
```

### "Score updated wrong after a correction"

The correction detector may have misclassified a conversational message as a correction. Review:

```sql
SELECT decision_id, timestamp, outcome, correction_message
FROM decision_log
WHERE outcome LIKE 'corrected%'
ORDER BY timestamp DESC LIMIT 10;
```

If the `correction_message` column shows text that wasn't actually a correction: the correction detector's time-window check may have matched the wrong message. This is a false positive — correction severity keywords in a message unrelated to a recent PASS decision.

Mitigation: File an issue against `outcome-collector.ts` — the time-window boundary check may need tightening.

### "TypeScript won't compile — trust module errors"

```bash
cd ~/Projects/helios/extensions/cortex
pnpm tsc --noEmit 2>&1 | grep trust/
```

Common causes:

- Missing `randomUUID` import (from `node:crypto`)
- `better-sqlite3` types mismatch (ensure `@types/better-sqlite3` is installed)
- `OutcomeType` union not exhaustive in a switch statement

---

## 13. Glossary

| Term                | Definition                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Trust score**     | Per-category EWMA number (0.0–1.0) representing Helios's reliability track record in that action category                      |
| **Decision**        | Any autonomous tool call where Helios acts without explicit per-action Matthew instruction                                     |
| **Gate decision**   | The outcome of `TrustGate.check()`: PASS, PAUSE, or BLOCK                                                                      |
| **Feedback window** | The 30-minute period after a PASS decision during which a correction can retroactively change the outcome to `corrected_*`     |
| **EWMA**            | Exponentially Weighted Moving Average — update formula that weights recent outcomes more than old ones while retaining history |
| **Alpha (α)**       | EWMA learning rate: higher α = faster score response to recent outcomes                                                        |
| **Tier**            | One of four action risk levels (1=read-only, 2=non-destructive, 3=infrastructure, 4=financial)                                 |
| **Category**        | Specific action type within a tier (e.g., `service_restart` within Tier 3)                                                     |
| **Threshold**       | Score level above which actions auto-approve without pause                                                                     |
| **Floor**           | Score level below which actions halt entirely (block zone)                                                                     |
| **Override**        | Matthew's explicit grant or revoke for a category — bypasses score-based gating                                                |
| **Milestone**       | A notable trust score transition (promotion, demotion, first auto-approve, block)                                              |
| **Correction**      | Matthew's message within a feedback window that indicates Helios's prior action was wrong                                      |
| **Hardcap**         | Tier 4 financial actions always pause regardless of trust score — overrides cannot lift this                                   |

---

_Next stage: build (TypeScript implementation)_
