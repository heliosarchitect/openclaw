# Task-010: Earned Autonomy — Progressive Trust — Requirements

**Stage:** requirements | **Status:** pass (reconstructed from IMPROVEMENT_PLAN at design stage)
**Phase:** 5.6 of IMPROVEMENT_PLAN
**Date:** 2026-02-18

---

## Problem Statement

Helios currently operates in one of two unsatisfying modes:

1. **Over-asking**: Every ambiguous action triggers a confirmation request to Matthew, creating friction even for things Helios has done correctly hundreds of times (reading a file, querying status, posting to Synapse).
2. **Over-trusting**: Helios sometimes acts autonomously on actions that warrant human review (infrastructure changes, config modifications, AUGUR intervention) without a structured record of whether those actions were correct.

There is no middle ground — no principled, quantified way to say "Helios has earned the right to do X without asking." The result is a guessing game: Matthew can't see a trust score, Helios can't calibrate confidence against an actual track record, and every session starts from scratch.

The root problem: **autonomy is binary and untracked.** It should be continuous and evidence-based.

Concrete manifestations today:

- Helios asks Matthew to confirm reading a file in a project Helios has accessed 200 times correctly
- Helios autonomously restarts a service with no record of whether previous restarts were correct or catastrophic
- Matthew has no way to grant or revoke autonomy for specific action categories
- When Helios makes a mistake, the error doesn't lower its autonomy threshold for that category — it just gets apologized for and forgotten

---

## Goals

1. **Decision tracking**: Log every autonomous decision (tool call, action taken without explicit user instruction) with context, risk assessment, outcome, and feedback signal
2. **Trust scoring**: Per-category, per-risk-tier rolling trust score derived from actual tracked outcomes — not assumed
3. **Progressive tier unlocking**: Auto-approve gates based on trust score thresholds; good track record raises the threshold, mistakes lower it
4. **Transparency**: Matthew can query trust scores and the full decision log at any time via `~/bin/trust-status`; Synapse weekly summary of trust evolution
5. **Pre-action hook integration**: Earned autonomy gates plug into the existing task-003 pre-action hook architecture — no new interception layer needed
6. **Graceful degradation**: If trust score drops below a floor for a category, Helios halts autonomous action in that category and requests explicit re-authorization from Matthew

---

## Non-Goals

- Replacing the existing confirmation-request UX entirely — some actions ALWAYS require Matthew's explicit authorization regardless of trust score (financial transactions, deletion of critical data, changes to safety/security configuration)
- Real-time decision replay or undo — the system tracks what happened and its outcome, but does not implement undo
- Multi-user trust (only Matthew's signals are authoritative for trust updates)
- LLM-assisted risk classification in the hot path — risk classification is deterministic (rule-based) to avoid latency in the pre-action hook

---

## Success Criteria

- [ ] Decision log records every autonomous tool call with: action type, risk tier, context, timestamp, outcome (pass/fail/corrected)
- [ ] Trust score computed per-category per-tier on a 30-day rolling exponentially weighted window
- [ ] Auto-approve gate: when trust score ≥ tier threshold, action proceeds without confirmation
- [ ] Auto-pause gate: when trust score < floor threshold for tier, Helios halts and posts Synapse alert
- [ ] `~/bin/trust-status` CLI produces readable trust report (by category, by tier, trend arrows)
- [ ] Matthew can explicitly grant/revoke trust for a category via a single command (override persists in `brain.db`)
- [ ] Weekly Synapse summary of trust evolution (new promotions, demotions, flagged outliers)
- [ ] Integration with task-003 pre-action hooks — hook calls trust gate, not a separate interceptor
- [ ] TypeScript implementation compiles cleanly (`pnpm tsc --noEmit`)
- [ ] All decision tracking is additive — zero changes to existing tool behavior when trust gate passes

---

## Inputs / Outputs

**Inputs:**

- Tool call metadata from the pre-action hook pipeline (task-003)
- Outcome signals: Matthew's corrections (corrections update trust score negatively), successful completions (no correction within feedback window = positive), explicit failures (tool error = negative)
- Matthew's explicit grant/revoke commands (stored as `trust_overrides` in `brain.db`)

**Outputs:**

- `brain.db` new tables: `decision_log`, `trust_scores`, `trust_overrides`
- Auto-approve gate decisions (pass/pause/block) returned to pre-action hook
- `~/bin/trust-status` CLI report
- Weekly Synapse trust summary
- Cortex memory: trust milestone events (first promotion to tier 3, first demotion, etc.)

---

## Action Risk Taxonomy

Actions are classified into four risk tiers. Classification is deterministic and fast (no LLM):

| Tier | Label           | Examples                                                              | Default Trust Threshold | Hard Cap |
| ---- | --------------- | --------------------------------------------------------------------- | ----------------------- | -------- |
| 1    | Read-Only       | File reads, exec status checks, cortex queries, web searches          | 0.50 (low bar)          | No       |
| 2    | Non-Destructive | File writes, cortex_add, Synapse messages, cron job creation          | 0.70                    | No       |
| 3    | Infrastructure  | Service restarts, config changes, gateway restart, cron modifications | 0.85                    | No       |
| 4    | Financial       | AUGUR trade execution, crypto transfers, Stripe charges               | 1.00 (always ask)       | Yes      |

**Tier 4 is hardcapped**: trust score cannot unlock financial actions. Matthew's explicit per-action authorization is always required. The decision IS logged (for track record building), but the gate always pauses.

---

## Action Categories (within tiers)

Each action is classified to a category within its tier. Trust scores are tracked per-category so that bad outcomes in "service restart" don't lower trust in "file write".

**Tier 1 categories:** `read_file`, `exec_status`, `cortex_query`, `web_search`, `synapse_read`
**Tier 2 categories:** `write_file`, `cortex_write`, `synapse_send`, `cron_create`, `session_spawn`
**Tier 3 categories:** `service_restart`, `config_change`, `gateway_action`, `cron_modify`, `deploy`
**Tier 4 categories:** `financial_augur`, `financial_crypto`, `financial_stripe`

---

## Trust Score Algorithm

Trust score for category C is a 30-day exponentially weighted moving average (EWMA) of outcomes:

```
outcome_value(outcome):
  pass (no correction)    → +1.0
  corrected (minor)       → -0.5
  corrected (significant) → -1.0
  tool_error (Helios)     → -0.3   (tool failed due to Helios error, not external)
  tool_error (external)   → 0.0    (external failure doesn't affect trust)

EWMA weight: α = 0.1 (slow decay, emphasizes history)
trust_score_new = α × outcome_value + (1 - α) × trust_score_current
trust_score clamped to [0.0, 1.0]
```

**Feedback window:** Outcome is determined 30 minutes after action completion. If Matthew sends a correction within the window, outcome = `corrected`. If no correction and no error, outcome = `pass`.

**Initial trust score:** 0.75 for tier 1 (Helios has been operating reliably), 0.65 for tier 2, 0.55 for tier 3, N/A for tier 4.

---

## Gate Logic

```
Given: action with risk_tier T, category C, trust_score S
Given: threshold[T] = { 1: 0.50, 2: 0.70, 3: 0.85, 4: Infinity }
Given: floor[T] = { 1: 0.20, 2: 0.40, 3: 0.60, 4: Infinity }

if trust_override[C] == "granted":   → PASS (no scoring gate)
if trust_override[C] == "revoked":   → BLOCK (always pause)
if T == 4:                           → PAUSE (hardcap — always pause)
if S >= threshold[T]:                → PASS
if S >= floor[T] and S < threshold[T]: → PAUSE (ask Matthew)
if S < floor[T]:                     → BLOCK (halt + Synapse alert)
```

**PASS**: Action proceeds. Decision logged, feedback window started.
**PAUSE**: Action queued. Matthew asked for confirmation. If confirmed → PASS and log. If denied → log as denied.
**BLOCK**: Action halted. Synapse alert sent. No action taken until Matthew intervenes or threshold is re-established.

---

## Constraints

- Trust gate adds ≤ 10ms to pre-action hook execution (synchronous SQLite read — no async)
- Trust scores persist across restarts (SQLite, not in-memory)
- All trust operations are logged for auditability — no silent score changes
- Trust overrides (grant/revoke) require explicit user command, not agent self-modification
- The earned autonomy system cannot modify its own scoring algorithm or thresholds (immutable config)
