# Task-011: Real-Time Learning — Deploy Report

**Stage:** deploy | **Status:** pass
**Date:** 2026-02-19T03:14:00-05:00
**Phase:** 5.7 of IMPROVEMENT_PLAN
**Version Released:** cortex-v2.6.0

---

## Deployment Actions Completed

### 1. Database Migrations (brain.db)

Three new tables deployed idempotently to `~/Projects/helios/extensions/cortex/python/brain.db`:

| Table                 | Purpose                                                                          | Status     |
| --------------------- | -------------------------------------------------------------------------------- | ---------- |
| `failure_events`      | Stores all detected failures (TOOL_ERR, CORRECT, SOP_VIOL, TRUST_DEM, PIPE_FAIL) | ✅ Created |
| `propagation_records` | Tracks each fix action with commit SHA, preview status, approval state           | ✅ Created |
| `regression_tests`    | Auto-generated test entries linked to failures                                   | ✅ Created |

All 9 indexes deployed (`idx_fe_type`, `idx_fe_tier`, `idx_fe_detected`, `idx_fe_root`, `idx_pr_failure`, `idx_pr_status`, `idx_rt_failure`, `idx_rt_active`).

**Verification:** `SELECT name FROM sqlite_master WHERE type='table'` confirms all 3 tables present. Row counts: 0 (clean baseline).

---

### 2. Configuration

Deployed: `~/Projects/helios/extensions/cortex/config/realtime-learning.json`

Key settings:

- **Correction keywords:** 19 configured (expandable)
- **Scan window:** 5 minutes post-tool-call
- **Recurrence window:** 30 days
- **Preview TTL:** 10 minutes (Tier 3 escalation)
- **Auto-commit:** additive SOP patches only
- **Metrics targets:** T2P ≤300s, completeness ≥90%, false-positives ≤5%

---

### 3. CLI: `~/bin/failure-log`

Deployed and made executable. Commands:

```
failure-log                          # Last 7 days summary table
failure-log --days 30               # Expand window
failure-log --type TOOL_ERR         # Filter by failure type
failure-log --status pending        # Filter by propagation status
failure-log --id <id>               # Full detail for single failure
failure-log --metrics               # Live metrics dashboard
```

---

### 4. Weekly Metrics Cron

Cron job registered:

- **ID:** `24c2150a-49be-4fd4-b0de-87f908d643d0`
- **Schedule:** Every Monday at 9:00 AM ET
- **Action:** Runs `failure-log --metrics`, queries propagation_records, posts 5-metric summary to Synapse
- **Thread:** `realtime-learning-metrics`
- **Next run:** Monday 2026-02-23 09:00 ET

---

### 5. TypeScript Verification

`pnpm tsc --noEmit` — **clean** (exit 0)

All 24 module files compile cleanly under the project's strict TypeScript config.

---

### 6. Git Commit

Committed to `~/Projects/helios/extensions/cortex` repository:

- 24 new TypeScript source files in `realtime-learning/`
- 8 test files in `realtime-learning/__tests__/`
- `config/realtime-learning.json`
- `pipeline/task-011-realtime-learning/` artifacts (all stages)

---

## Integration Wiring Status

The module is deployed but not yet live-wired to the observation bus. Integration hooks are documented in `realtime-learning/index.ts` at the exported `onToolResult()`, `onUserMessage()`, `onSopViolation()`, `onTrustDemotion()`, and `onPipelineFail()` entry points.

**Post-deploy integration required** (owner: next sprint or task-016):

- Wire `onToolResult` to `after_tool_call` hook (task-003 observation bus)
- Wire `onUserMessage` to session message handler
- Wire `onSopViolation` to `sop:violation` event from task-003
- Wire `onTrustDemotion` to `trust:demotion` event from task-010

Until wired, the engine is **passive** — tables are ready, CLI works on empty data, cron will fire but report zeros.

---

## Behavioral Signature (Version Forensics)

**When active and functioning:**

```
[cortex:realtime-learning] failure detected: TOOL_ERR:wrong_path (tier 1)
[cortex:realtime-learning] classified → root_cause: wrong_path → sop_patch + atom
[cortex:sop-patcher] additive patch committed: abc123def (corrections.md)
[cortex:atom-propagator] atom created: failure:TOOL_ERR:a1b2c3d4
[cortex:recurrence-detector] checked 30d window — no prior occurrence
```

**When passive (wiring not complete):**

```
(no output — listeners not registered)
failure-log shows 0 events
```

**Failure mode:** If brain.db migrations fail on re-run → idempotent, safe to re-run.

---

## Rollback Plan

If realtime-learning causes regressions:

1. Remove `realtime-learning/` dir from cortex extension load path
2. `sqlite3 brain.db "DROP TABLE IF EXISTS failure_events, propagation_records, regression_tests;"`
3. Disable cron job `24c2150a-49be-4fd4-b0de-87f908d643d0`
4. `rm ~/bin/failure-log`

No other system state is affected (module is append-only until wired).

---

## Metrics at Deploy

| Metric                   | Value               |
| ------------------------ | ------------------- |
| Total failures detected  | 0 (fresh)           |
| Propagation completeness | N/A (no events yet) |
| False positive rate      | N/A                 |
| Avg time-to-propagate    | N/A                 |
| Recurrence count         | 0                   |

---

## Version Tag

`cortex-v2.6.0` — Real-Time Learning engine deployed. Waiting for bus wiring in subsequent task.
