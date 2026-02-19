# Task-010: Earned Autonomy — Security Review

**Stage:** security | **Status:** pass (with required mitigations)
**Phase:** 5.6 | **Date:** 2026-02-19
**Reviewer:** Pipeline Security Specialist
**Build reviewed:** trust/ (10 source files, 1,347 lines) + 4 test files

---

## Executive Summary

The Earned Autonomy system has a strong foundational security posture: deterministic classification avoids LLM manipulation in the hot path, synchronous SQLite reads prevent race conditions, parameterized queries eliminate SQL injection, and the Tier 4 hardcap correctly prevents financial auto-approval. However, code review revealed **one Critical finding** and **two High findings** that must be mitigated before deploy. Six additional Medium/Low findings require documentation or future-sprint fixes.

**Deploy recommendation:** ✅ **Pass with mitigations** — fix Critical + High findings before activating the pre-action hook integration. The feature may be deployed in passive/logging-only mode while mitigations are applied.

---

## Scope

Files reviewed:

- `trust/classifier.ts` — ActionClassifier rule table + exec read-only handling
- `trust/gate.ts` — TrustGate, decision logging, pending outcome creation
- `trust/outcome-collector.ts` — Feedback window, correction detection, EWMA trigger
- `trust/override-manager.ts` — Grant/revoke logic, expiry parsing
- `trust/migration.ts` — Schema creation, index definitions, bootstrap
- `trust/score-updater.ts` (referenced in outcome-collector)
- `trust/milestone-detector.ts` (called by override-manager)
- `trust/reporter.ts` (CLI output)
- `trust/types.ts` — Constants, config defaults, known categories
- `~/bin/trust-status`, `~/bin/trust-grant` — CLI scripts

---

## Findings

### 🔴 CRITICAL — C1: Exec Read-Only Check Fires Before Tier 4 Financial Patterns

**File:** `classifier.ts`, function `classify()`, lines ~55-65 (EXEC_READONLY_PATTERNS block)

**Description:**
The classifier applies `EXEC_READONLY_PATTERNS` to exec commands **before** the main rule loop that contains Tier 4 financial patterns. A compound command beginning with a read-only token will match the early-exit path and be classified as Tier 1 `exec_status`, completely bypassing Tier 4 detection:

```typescript
// This fires FIRST, before the CLASSIFICATION_RULES loop:
if (toolName === "exec" && command) {
  for (const pat of EXEC_READONLY_PATTERNS) {
    if (pat.test(command)) {
      return { tier: 1, category: "exec_status" }; // ← early return
    }
  }
}
```

**Exploit path:**

```
exec({ command: "ls && augur trade --live" })
→ EXEC_READONLY_PATTERNS[0] matches "ls" at start
→ Returns { tier: 1, category: 'exec_status' }
→ Financial hardcap NEVER checked
→ Gate auto-approves if trust score ≥ 0.50
```

This is the highest-severity finding in the system. An agent or pipeline subagent with control over its exec commands could embed financial operations behind a read prefix and bypass the hardcap.

**Severity:** CRITICAL — defeats the financial hardcap for Tier 4

**Mitigation (required before deploy):**

Reorder classification so that Tier 4 financial patterns are checked **first**, before the read-only pattern shortcut:

```typescript
export function classify(toolName: string, params: Record<string, unknown> = {}): Classification {
  const command = typeof params.command === "string" ? params.command : "";
  const action  = typeof params.action  === "string" ? params.action  : "";
  const filePath = ...;

  // ── TIER 4 MUST CHECK FIRST (before any shortcuts) ──────────────────
  if (toolName === "exec" && command) {
    if (/augur.*trade|paper_augur.*execute/i.test(command))  return { tier: 4, category: "financial_augur" };
    if (/coinbase|crypto.*transfer|send.*eth|send.*btc/i.test(command)) return { tier: 4, category: "financial_crypto" };
    if (/stripe.*charge|payment.*create/i.test(command))    return { tier: 4, category: "financial_stripe" };
  }

  // ── THEN read-only shortcut (now safe — Tier 4 already screened) ─────
  if (toolName === "exec" && command) {
    for (const pat of EXEC_READONLY_PATTERNS) {
      if (pat.test(command)) return { tier: 1, category: "exec_status" };
    }
  }

  // ... rest of rule loop
}
```

Additionally, consider using the **full command string** (not just prefix-anchored patterns) for financial detection to catch embedded commands:

```typescript
// Prefer: use full-string financial patterns that detect anywhere in command
if (/\baugur\b.*\btrade\b|\bpaper_augur\b.*\bexecute\b/i.test(command)) ...
```

**Test to add:**

```typescript
test("exec with read prefix before financial command → tier 4", () => {
  expect(classify("exec", { command: "ls && augur trade --live" })).toMatchObject({
    tier: 4,
    category: "financial_augur",
  });
});
test("exec with read prefix before crypto command → tier 4", () => {
  expect(classify("exec", { command: "echo ok; coinbase transfer 1 BTC" })).toMatchObject({
    tier: 4,
    category: "financial_crypto",
  });
});
```

---

### 🟠 HIGH — H1: Self-Grant Prevention Not Enforced in Code

**File:** `override-manager.ts`, method `setOverride()`

**Description:**
The design doc specifies that trust overrides can only be set from an interactive session (Matthew's commands), not from agent-autonomous pipeline stages. However, the implementation hardcodes `granted_by: 'matthew'` as a string literal — there is no runtime validation that the caller is actually an interactive session vs. a pipeline subagent:

```typescript
// In setOverride():
const override: TrustOverride = {
  ...
  granted_by: "matthew",  // ← ALWAYS 'matthew' regardless of who called this
  ...
};
```

Any code that can `import OverrideManager` and call `setOverride()` will successfully create a `granted_by = 'matthew'` override, even if the call originates from a background subagent, a pipeline hook, or a malicious Synapse payload that triggers agent-autonomous execution.

**Impact:** A compromised or manipulated subagent could self-grant trust overrides for sensitive categories (e.g., `service_restart`, `config_change`), defeating the human-authorization requirement.

**Severity:** HIGH — undermines the core "Matthew-only" trust override requirement

**Mitigation (required before deploy):**

1. Add a `callerSessionId` parameter to `setOverride()` that is validated against a known interactive session ID:

```typescript
setOverride(
  category: string,
  type: OverrideType,
  reason: string,
  callerSessionId: string,      // ← required, from calling context
  expiresIn: string | null = null,
): TrustOverride {
  // Validate caller is an interactive session, not a pipeline subagent
  if (!this.isInteractiveSession(callerSessionId)) {
    throw new Error(
      `OverrideManager.setOverride() called from non-interactive session '${callerSessionId}'. ` +
      `Trust overrides require Matthew's explicit authorization from an interactive session.`
    );
  }
  // ... rest of implementation
}

private isInteractiveSession(sessionId: string): boolean {
  // Pipeline subagents have predictable session ID patterns (e.g., 'pipeline-*', 'subagent-*')
  // Interactive sessions come from the main OpenClaw session or direct CLI
  const PIPELINE_PATTERNS = [/^pipeline-/, /^subagent-/, /^isolated-/];
  return !PIPELINE_PATTERNS.some(p => p.test(sessionId));
}
```

2. The `~/bin/trust-grant` CLI should pass `process.env.OPENCLAW_SESSION_ID` as `callerSessionId`.

3. Log all override attempts (both accepted and rejected) for auditability.

**Note:** The current pipeline stage runner (this very stage) itself is a background subagent. The OverrideManager mitigation would correctly prevent pipeline stages from granting overrides.

---

### 🟠 HIGH — H2: Correction Detection Has No Timing Validation

**File:** `outcome-collector.ts`, method `recordCorrection()`

**Description:**
The design doc specifies that correction detection operates within a **10-minute window of a logged PASS decision**. However, the `recordCorrection()` implementation looks for any `pending` decision in the category, with no timestamp constraint:

```typescript
const query = category
  ? `SELECT decision_id FROM decision_log
     WHERE outcome = 'pending' AND category = ?
     ORDER BY timestamp DESC LIMIT 1`
  : `SELECT decision_id FROM decision_log
     WHERE outcome = 'pending'
     ORDER BY timestamp DESC LIMIT 1`;
```

**Impact:** A correction message sent hours after an action could silently apply to the most recent pending decision in that category — even if completely unrelated to the user's intent. The MINOR_PATTERNS regex includes common words like `"no"` and `"wrong"` that appear frequently in normal conversation:

```typescript
const MINOR_PATTERNS = /\b(no|wrong|not\s+right|undo|different|...)\b/i;
```

A message like "No, I don't think that's right about the weather" would:

1. Match MINOR_PATTERNS (contains "no" and "not right")
2. Find the most recent pending decision (could be a file write from 45 minutes ago)
3. Apply `corrected_minor` outcome, lowering the trust score

Over time, this produces score drift from false corrections.

**Severity:** HIGH — causes trust score manipulation via conversational messages; undermines EWMA integrity

**Mitigation (required before deploy):**

Add timestamp validation in `recordCorrection()`:

```typescript
recordCorrection(correctionText: string, category?: string): ... {
  const severity = detectCorrectionSeverity(correctionText);
  if (!severity) return { resolved: false };

  // Only match pending decisions within the correction window (configurable, default 30 min)
  const windowMinutes = this.config.correction_window_minutes ?? 30;

  const query = category
    ? `SELECT decision_id FROM decision_log
       WHERE outcome = 'pending' AND category = ?
         AND timestamp >= datetime('now', '-${windowMinutes} minutes')   -- ← ADD THIS
       ORDER BY timestamp DESC LIMIT 1`
    : `SELECT decision_id FROM decision_log
       WHERE outcome = 'pending'
         AND timestamp >= datetime('now', '-${windowMinutes} minutes')   -- ← ADD THIS
       ORDER BY timestamp DESC LIMIT 1`;
  // ...
}
```

Also consider narrowing `MINOR_PATTERNS` to require more context. The bare word `"no"` is too broad:

```typescript
// Before: /\b(no|wrong|...)\b/i — too broad
// After: require "no" only in direct-response constructions
const MINOR_PATTERNS =
  /\b(wrong|not\s+right|undo|different|fix\s+that|that'?s?\s+wrong|shouldn'?t\s+have|redo)\b/i;
// Move standalone "no" to require companion correction words, e.g.:
// "no, that's wrong" vs just "no"
```

---

### 🟡 MEDIUM — M1: `decisions_last_30d` Column Never Incremented

**File:** `outcome-collector.ts`, method `resolveOutcome()` (and `migration.ts` bootstrap)

**Description:**
`trust_scores.decisions_last_30d` is initialized to 0 and never updated in the current implementation. The `resolveOutcome()` method increments `decision_count` but not `decisions_last_30d`:

```typescript
this.db
  .prepare(
    `UPDATE trust_scores
   SET current_score = ?, decision_count = decision_count + 1,
       last_updated = datetime('now')  -- ← decisions_last_30d missing
   WHERE category = ?`,
  )
  .run(newScore, category);
```

**Impact:** `trust-status` CLI report shows 0 for all `decisions_last_30d` values, making the trend analysis section non-functional.

**Mitigation:**

```sql
UPDATE trust_scores
SET current_score = ?,
    decision_count = decision_count + 1,
    decisions_last_30d = (
      SELECT COUNT(*) FROM decision_log
      WHERE category = trust_scores.category
        AND timestamp >= datetime('now', '-30 days')
    ),
    last_updated = datetime('now')
WHERE category = ?
```

Or recompute via a nightly maintenance sweep rather than on every update (to avoid per-update subquery cost).

---

### 🟡 MEDIUM — M2: `pending_outcomes` Sweep Has No Scheduling Guarantee

**File:** `outcome-collector.ts`, method `sweepExpiredWindows()`

**Description:**
The `sweepExpiredWindows()` method resolves expired feedback windows, but it is a passive method that must be called externally. If the caller stops scheduling the sweep (cron failure, plugin restart without re-registration), pending outcomes accumulate indefinitely, decision counts stagnate, and trust scores stop learning.

There is currently no evidence in the build report or design doc of a registered cron job for this sweep.

**Impact:** Trust learning silently freezes. Scores calculated from bootstrap values never improve. Matthew can't detect this failure without running `trust-status` and noticing stale `last_updated` timestamps.

**Mitigation:**

1. Register a recurring cron job in the deploy stage: `every 5 minutes, call sweepExpiredWindows()`
2. Add a health check: if `last_updated` on any score is > 2h old AND `decision_count > 0`, post Synapse alert
3. Add sweep timestamp to `trust_scores`: `last_sweep_at TEXT` column

---

### 🟡 MEDIUM — M3: No Retention Policy on `decision_log`

**File:** `migration.ts`

**Description:**
`decision_log` has no TTL, no partition, and no enforced retention. All decisions are retained indefinitely. At current Helios tool-call volumes (estimated 500-2000 tool calls/day), the table will reach millions of rows within months.

The design doc references task-008 Knowledge Compression for 90-day archival, but task-008 integration is not implemented in this build, nor is there a nightly cleanup cron.

**Impact:** SQLite performance degrades at large row counts. The partial index `idx_dl_pending` helps for the sweep query, but full-table scans in `recordCorrection()` (no timestamp filter — see H2) will slow as the table grows.

**Mitigation:**

1. Add a nightly cleanup cron: `DELETE FROM decision_log WHERE timestamp < datetime('now', '-90 days') AND outcome != 'pending'`
2. Document the task-008 integration point as a deploy-stage prerequisite
3. Track table size in the health check heartbeat

---

### 🟡 MEDIUM — M4: `tool_params_summary` May Leak Sensitive Information

**File:** `gate.ts`, method `summarizeParams()`

**Description:**
The `summarizeParams()` method builds a human-readable summary truncated to 250 characters and stores it in `decision_log.tool_params_summary`. For exec commands, it stores up to 120 characters of the raw command string:

```typescript
if (typeof params.command === "string") {
  parts.push(params.command.slice(0, 120));
}
```

Commands may contain API keys, passwords, authentication tokens, or personal data passed as arguments (e.g., `curl https://api.example.com -H "Authorization: Bearer eyJ..."`).

**Impact:** Secrets persisted in `brain.db` in plaintext. Anyone with read access to the SQLite file (or the `trust-status` CLI) can retrieve sensitive command arguments from the log.

**Mitigation:**

1. Scrub known secret patterns from summaries before storing:

```typescript
private sanitizeCommand(cmd: string): string {
  return cmd
    .replace(/\b(Bearer\s+\S+|token[=:]\S+|key[=:]\S+|password[=:]\S+|secret[=:]\S+)/gi, '***REDACTED***')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '***JWT***');  // JWT tokens
}
```

2. Add a `TRUST_LOG_COMMANDS` env flag (default `false`) to opt-in to full command logging for debugging purposes only

---

### 🟢 LOW — L1: `paramsHash` Truncated — Document Non-Cryptographic Use

**File:** `gate.ts`, line `paramsHash = createHash("sha256").update(paramsJson).digest("hex").slice(0, 16)`

**Description:**
The `tool_params_hash` is truncated to 16 hex chars (64 bits). For a log-level deduplication identifier this is acceptable, but truncated hashes should not be used for cryptographic integrity verification. If future code attempts to use this hash as a tamper-detection mechanism, the short form is inadequate.

**Mitigation:** Add a code comment: `// 16-char prefix for dedup/display only — not cryptographic integrity`

---

### 🟢 LOW — L2: Conservative Fallback Not Logged as Warning

**File:** `classifier.ts`, end of `classify()` function

**Description:**
When an unclassified tool falls through all rules to the default Tier 2 fallback, this fires silently. Over time, new tools added to the platform will silently classify as `write_file` with no visibility.

**Impact:** Tier 1 tools that should be read-only will be treated as Tier 2, generating unnecessary pause prompts and undermining the system's user experience.

**Mitigation:** Log a warning when the fallback fires, and track `unknown_tool_hits` in a `trust_diagnostics` table or cortex memory.

---

### 🟢 LOW — L3: `pending_confirmations` Table Created but Never Populated

**File:** `migration.ts`, `gate.ts`

**Description:**
`pending_confirmations` is defined in the migration schema (correctly matching the design doc's PAUSE queue), but `gate.ts` creates a `pending_outcomes` record on PASS and logs the decision on PAUSE — it does not insert into `pending_confirmations`. The PAUSE flow is incomplete in the current build.

**Impact:** PAUSE decisions halt tool execution (gate returns `'pause'`) but the confirmation queue is empty, so there is no mechanism for Matthew to confirm or deny the queued action. The pause effectively becomes a silent block.

**Mitigation:** This is a known MVP gap — the pre-action hook integration (task-003 edit) must implement the PAUSE confirmation flow. Document this explicitly in the deploy notes and ensure the hook does not return `pause` without a visible user prompt.

---

## Security Architecture Assessment

### What Works Well ✅

| Area                              | Finding                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| **SQL injection**                 | All DB operations use parameterized prepared statements — no injection risk      |
| **Tier 4 hardcap intent**         | Financial categories defined and checked; hardcap logic correct once C1 is fixed |
| **EWMA score bounds**             | `Math.max(0.0, Math.min(1.0, ...))` prevents score manipulation outside range    |
| **Override expiry**               | ISO timestamps in SQLite with `datetime('now')` comparison — robust to restarts  |
| **No async in gate hot path**     | Synchronous SQLite reads prevent race conditions at the gate decision point      |
| **Audit trail**                   | Every decision logged with full causal chain — forensic trail exists             |
| **Score manipulation resistance** | Outcomes come from real session state, not external payloads                     |
| **Schema constraints**            | `CHECK` constraints on tier values, gate decisions, outcomes — DB enforces types |

### Attack Surface Summary

| Vector                                               | Status                                              |
| ---------------------------------------------------- | --------------------------------------------------- |
| SQL injection via tool params                        | ✅ Mitigated (parameterized queries)                |
| Financial hardcap bypass via command prefix          | ❌ Critical — C1                                    |
| Self-grant of trust overrides from subagent          | ❌ High — H1                                        |
| Trust score manipulation via conversational messages | ❌ High — H2                                        |
| Secret leakage in decision_log                       | ⚠️ Medium — M4                                      |
| Score freeze via sweep scheduling failure            | ⚠️ Medium — M2                                      |
| DB performance degradation at scale                  | ⚠️ Medium — M3                                      |
| Unknown tool misclassification                       | ✅ Conservative Tier 2 default (acceptable)         |
| Bootstrap score miscalibration                       | ✅ Matthew can correct via trust-grant              |
| Fake Synapse payload triggering override             | ✅ OverrideManager not called from Synapse handlers |

---

## Required Actions Before Activation

| Priority    | Finding | Action                                                          |
| ----------- | ------- | --------------------------------------------------------------- |
| 🔴 CRITICAL | C1      | Reorder classifier: Tier 4 check before exec read-only shortcut |
| 🟠 HIGH     | H1      | Add session ID validation to OverrideManager.setOverride()      |
| 🟠 HIGH     | H2      | Add 30-minute timestamp window to recordCorrection() query      |
| 🟡 MEDIUM   | M4      | Scrub secrets from tool_params_summary before storing           |

## Recommended for Next Sprint

| Priority  | Finding | Action                                                         |
| --------- | ------- | -------------------------------------------------------------- |
| 🟡 MEDIUM | M1      | Fix decisions_last_30d counter                                 |
| 🟡 MEDIUM | M2      | Register sweepExpiredWindows() cron in deploy stage            |
| 🟡 MEDIUM | M3      | Add 90-day decision_log retention cron                         |
| 🟢 LOW    | L1      | Add hash truncation comment                                    |
| 🟢 LOW    | L2      | Log warning on conservative fallback                           |
| 🟢 LOW    | L3      | Implement pending_confirmations PAUSE flow in hook integration |

---

## Deploy Gating Decision

**Result: ✅ PASS WITH CONDITIONS**

The Earned Autonomy system may be deployed in **passive/logging-only mode** immediately — the gate runs, decisions are logged, trust scores update, but the pre-action hook integration is NOT activated yet. This allows the system to accumulate a real decision history and calibrate scores before going live.

**Activation gate** (flip hook integration on): After C1, H1, H2, and M4 mitigations are applied and the test suite passes with the new cases added.

**Estimated mitigation effort:** ~2-3 hours (4 targeted code changes + 4 new test cases)

---

_Security review complete. Next stage: test_
