# Task-010: Earned Autonomy — Deploy Report

**Stage:** deploy | **Status:** pass
**Phase:** 5.6 | **Date:** 2026-02-19 01:45 EST
**Version Released:** cortex-v2.6.0
**Commit:** 2d36740f2
**Author:** Pipeline Deploy Specialist

---

## Deploy Summary

Earned Autonomy — Progressive Trust System deployed to production. All security mitigations applied. Migration run. Crons registered. Deployed in **passive/logging-only mode** (gate logic active, pre-action hook activation deferred to task-011 completion).

---

## Pre-Deploy Verification

| Check                                        | Result                        |
| -------------------------------------------- | ----------------------------- |
| TypeScript compilation (`pnpm tsc --noEmit`) | ✅ 0 errors                   |
| Unit + integration + E2E tests               | ✅ 94/94 passing (285ms)      |
| Security mitigations applied                 | ✅ C1, H1, H2, M4 all in code |
| Migration idempotency test                   | ✅ pass (migration.test.ts)   |

---

## Security Mitigations Applied

All four required-before-deploy findings from the security review are resolved in the codebase:

| Finding                                                   | File                   | Mitigation Applied                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1 CRITICAL** — Tier 4 bypass via exec read-only prefix | `classifier.ts`        | Tier 4 financial checks moved first, before `EXEC_READONLY_PATTERNS` shortcut. Full-string regex (not anchored) catches `ls && augur trade --live`.                                                |
| **H1 HIGH** — Self-grant prevention not enforced          | `override-manager.ts`  | `setOverride()` now requires `callerSessionId`; `isInteractiveSession()` rejects pipeline/subagent/isolated/cron/background session ID patterns. `~/bin/trust-grant` passes `OPENCLAW_SESSION_ID`. |
| **H2 HIGH** — Correction detection no timing validation   | `outcome-collector.ts` | `recordCorrection()` filters to decisions within `correction_window_minutes` (default 30min). Bare "no" removed from `MINOR_PATTERNS`; replaced with specific correction phrases.                  |
| **M4 MEDIUM** — Secret leakage in `decision_log`          | `gate.ts`              | `sanitizeCommand()` scrubs Bearer tokens, key=value secrets, JWT tokens, and 40+ char hex strings before storing in `tool_params_summary`.                                                         |

---

## Database Migration

**Migration:** `runMigration()` from `trust/migration.ts`
**Target:** `~/.openclaw/workspace/memory/brain.db`
**Executed:** 2026-02-19 01:44 EST

### Tables Created (6)

| Table                   | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `decision_log`          | Every autonomous gate decision with outcome tracking |
| `trust_scores`          | Per-category EWMA trust scores                       |
| `trust_overrides`       | Matthew's explicit grants/revokes                    |
| `trust_milestones`      | Notable trust score transitions                      |
| `pending_outcomes`      | Feedback window timers (survive restarts)            |
| `pending_confirmations` | PAUSE queue with 10-min TTL                          |

### Indexes Created (5)

- `idx_dl_category` — fast lookup by category
- `idx_dl_timestamp` — reverse-chronological queries
- `idx_dl_outcome` — full outcome filtering
- `idx_dl_pending` — partial index on `outcome='pending'` (sweep queries)
- `idx_to_category` — trust_overrides category + active lookup

### Bootstrap Trust Scores (18 categories)

| Category         | Tier | Initial Score | Alpha |
| ---------------- | ---- | ------------- | ----- |
| cortex_query     | 1    | 0.75          | 0.08  |
| exec_status      | 1    | 0.75          | 0.08  |
| read_file        | 1    | 0.75          | 0.08  |
| synapse_read     | 1    | 0.75          | 0.08  |
| web_search       | 1    | 0.75          | 0.08  |
| cortex_write     | 2    | 0.65          | 0.10  |
| cron_create      | 2    | 0.65          | 0.10  |
| session_spawn    | 2    | 0.65          | 0.10  |
| synapse_send     | 2    | 0.65          | 0.10  |
| write_file       | 2    | 0.65          | 0.10  |
| config_change    | 3    | 0.55          | 0.15  |
| cron_modify      | 3    | 0.55          | 0.15  |
| deploy           | 3    | 0.55          | 0.15  |
| gateway_action   | 3    | 0.55          | 0.15  |
| service_restart  | 3    | 0.55          | 0.15  |
| financial_augur  | 4    | 0.00          | 0.00  |
| financial_crypto | 4    | 0.00          | 0.00  |
| financial_stripe | 4    | 0.00          | 0.00  |

**Note on Tier 3 initial scores:** All Tier 3 categories start at 0.55, which is **below the floor (0.60)** and in "blocked" state. This is **intentional conservatism** for infrastructure actions. Matthew can immediately grant overrides via `trust-grant grant <category>` or the scores will rise naturally as decisions accumulate.

---

## CLI Tools Deployed

### `~/bin/trust-status`

Reports current trust scores, thresholds, active overrides, and recent milestones for all 18 categories.

```bash
$ trust-status
# Full tier-by-tier report with visual score bars
```

### `~/bin/trust-grant`

Matthew-only CLI for granting/revoking trust overrides. Session validation prevents agent self-grant.

```bash
# Grant temporary override
trust-grant grant config_change --reason "batch yaml migration" --expires "4h"

# Revoke specific override
trust-grant revoke config_change --reason "migration complete"

# Revoke all active overrides
trust-grant revoke-all
```

---

## Cron Jobs Registered

| Cron ID    | Name                                | Schedule           | Purpose                                                                      |
| ---------- | ----------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `6aaee7cd` | `earned-autonomy-outcome-sweep`     | Every 5 min        | Sweep expired feedback windows, resolve pending outcomes, update EWMA scores |
| `788896ef` | `earned-autonomy-retention-cleanup` | Daily 4:00 AM EST  | Delete `decision_log` rows older than 90 days (outcome ≠ 'pending')          |
| `32f81624` | `earned-autonomy-weekly-summary`    | Monday 6:00 AM EST | Generate and post weekly trust report to Synapse thread `trust-weekly`       |

---

## Git Release

| Field         | Value                                        |
| ------------- | -------------------------------------------- |
| Tag           | `cortex-v2.6.0`                              |
| Commit        | `2d36740f2`                                  |
| Gitea         | ✅ pushed (gitea.fleet.wood/Helios/openclaw) |
| GitHub fork   | ✅ pushed (heliosarchitect/openclaw)         |
| Files changed | 29 files (5,548 insertions, 26 deletions)    |

---

## Deployment Mode: Passive/Logging-Only

The system is deployed with the gate logic **active and collecting data**, but the pre-action hook integration (task-003) is **NOT yet activated**. This means:

- ✅ `TrustGate.check()` is callable and will log decisions + update scores
- ✅ Migration complete, tables accepting data
- ✅ EWMA learning loop live (outcome sweep cron running)
- ⏸ Pre-action hook does NOT yet call `TrustGate.check()` on every tool call
- ⏸ PAUSE confirmation flow (`pending_confirmations` queue) not active in hook

**Activation gate** (switch hook integration on):

1. Task-011 (Real-Time Learning from Failure) completes
2. Pre-action hook edited to call `TrustGate.check()` at the correct point
3. `pending_confirmations` PAUSE flow implemented in hook (Low-L3 finding)
4. Test coverage confirms hook + gate interaction (task-016)

This staged rollout ensures trust scores are calibrated with real data before any tool calls are actually blocked or paused.

---

## Open Items (Next Sprint)

| Priority | Finding                                                              | Sprint   |
| -------- | -------------------------------------------------------------------- | -------- |
| 🟡 M1    | `decisions_last_30d` counter fix needed (reporter shows 0)           | task-016 |
| 🟡 M2    | sweepExpiredWindows() cron registered ✅ — health check still needed | task-016 |
| 🟡 M3    | 90-day retention cron registered ✅ — table size monitoring pending  | task-016 |
| 🟢 L1    | Add paramsHash truncation comment in gate.ts                         | task-016 |
| 🟢 L2    | Log warning on conservative Tier 2 fallback                          | task-016 |
| 🟢 L3    | Implement pending_confirmations PAUSE flow in hook                   | task-011 |

---

## Integration Points Active

| System                           | Integration                             | Status                      |
| -------------------------------- | --------------------------------------- | --------------------------- |
| brain.db                         | 6 tables, 18 bootstrapped scores        | ✅ Live                     |
| Pre-action hook (task-003)       | `TrustGate.check()` integration         | ⏸ Deferred                  |
| Predictive Intent (task-005)     | Trust milestones → Synapse → PI signals | ✅ Architecture ready       |
| Self-Healing (task-006)          | service_restart goes through trust gate | ⏸ When hook active          |
| Knowledge Compression (task-008) | 90-day archival of decision_log         | ✅ Cron registered          |
| AUGUR                            | financial_augur hardcap                 | ✅ Always pause (alpha=0.0) |

---

_Deploy complete. Next stage: done (version bump + release notes)_
