# Cortex v2.2.0 — Self-Healing Infrastructure

**Released:** 2026-02-18  
**Task:** task-006-self-healing (Phase 5.2)  
**Commit:** f65c4b3e2  
**Tag:** cortex-v2.2.0  
**Prior version:** cortex-v2.1.0 (Predictive Intent)

---

## Summary

Cortex v2.2.0 introduces end-to-end automated self-healing: the system now detects anomalies, manages incident lifecycles, executes remediation runbooks with pre/post verification, and escalates to Synapse or Signal only when human attention is genuinely required. Tier-0 fixes are completely silent.

This is Phase 5.2 of the Helios Improvement Plan. It builds directly on the Predictive Intent PollingEngine (v2.1.0) — supplemental probes subscribe to the existing reading stream rather than creating a parallel polling loop.

---

## What's New

### Core Engine: `healing/`

| Module                     | Purpose                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `index.ts` — HealingEngine | Orchestrator: detect → diagnose → remediate → escalate (event-driven)                            |
| `types.ts`                 | Full type definitions: AnomalyType, Incident, Runbook, RunbookStep, HealingEngineConfig          |
| `anomaly-classifier.ts`    | Maps SourceReading → HealthAnomaly[] for 13 anomaly types                                        |
| `incident-manager.ts`      | Incident CRUD, state machine (detected → triaged → remediating → resolved), brain.db persistence |
| `runbook-registry.ts`      | 12-runbook catalog with dry-run graduation workflow (3 dry-runs OR explicit approval)            |
| `runbook-executor.ts`      | Step-by-step execution: pre-verification re-probe + post-verification confirm (NFR-002)          |
| `escalation-router.ts`     | Tier 0–3 routing: 0=metric-only, 1=Synapse info, 2=Synapse action, 3=Synapse+Signal urgent       |
| `probe-registry.ts`        | Supplemental probe timer management (6 probes not in PollingEngine)                              |

### Supplemental Probes: `healing/probes/`

| Probe                    | Interval | What it monitors                                           |
| ------------------------ | -------- | ---------------------------------------------------------- |
| `augur-process-probe.ts` | 60s      | AUGUR executor PID file + process table + zombie detection |
| `gateway-probe.ts`       | 120s     | `openclaw gateway status` consecutive failure counting     |
| `brain-db-probe.ts`      | 15m      | SQLite `PRAGMA integrity_check` on brain.db                |
| `disk-probe.ts`          | 10m      | `df` usage percentages on `/` and `~/`                     |
| `memory-probe.ts`        | 5m       | `/proc/meminfo` MemAvailable                               |
| `log-bloat-probe.ts`     | 30m      | Log files > 100MB in known log dirs                        |

### Runbooks: `healing/runbooks/` (12 total)

| Runbook                | Mode             | Trigger Anomaly  |
| ---------------------- | ---------------- | ---------------- |
| `rb-restart-service`   | dry_run          | service_down     |
| `rb-kill-zombie`       | dry_run          | process_zombie   |
| `rb-restart-augur`     | dry_run          | augur_crashed    |
| `rb-clear-phantom`     | dry_run          | phantom_position |
| `rb-kick-pipeline`     | dry_run          | pipeline_stuck   |
| `rb-probe-then-alert`  | dry_run          | generic          |
| `rb-rotate-logs`       | **auto_execute** | log_bloat        |
| `rb-emergency-cleanup` | dry_run          | disk_critical    |
| `rb-gc-trigger`        | **auto_execute** | memory_pressure  |
| `rb-force-gc`          | dry_run          | memory_critical  |
| `rb-db-emergency`      | dry_run          | db_corruption    |
| `rb-gateway-restart`   | dry_run          | gateway_down     |

Auto-execute whitelist (safe to run without approval): `rb-rotate-logs`, `rb-gc-trigger`.
All others start in `dry_run` mode; graduate to `auto_execute` after 3 confirmed dry-runs or explicit `confirm=true`.

### brain.db Schema Additions

Two new tables added to `brain.db`:

```sql
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,           -- crypto.randomUUID()
  anomaly_type TEXT NOT NULL,
  target_id TEXT,
  state TEXT NOT NULL,           -- detected|triaged|remediating|resolved|self_resolved|escalated|dismissed
  severity INTEGER NOT NULL,     -- 0-3 (tier)
  detected_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL,
  resolved_at TEXT,
  escalated_at TEXT,
  dismissed_until TEXT,          -- 24h suppression after dismiss
  runbook_id TEXT,
  audit_trail TEXT               -- JSON array of state transitions
);

CREATE TABLE IF NOT EXISTS runbooks (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,            -- dry_run|auto_execute
  dry_run_count INTEGER DEFAULT 0,
  last_executed_at TEXT,
  last_outcome TEXT,
  graduation_approved_by TEXT
);
```

### Integration Changes

- **`cortex-bridge.ts`**: Added `runSQL()`, `getSQL()`, `allSQL()`, `dbPath` for direct brain.db access from TypeScript components.
- **`predictive/polling-engine.ts`**: Added `onReading(callback)` public method — zero-breaking-change hook for HealingEngine to subscribe to existing data streams.
- **`index.ts`** (cortex plugin): Full HealingEngine lifecycle: `init()` after PollingEngine, `start()` on session start, `stop()` on session stop.

---

## Security — All Required Mitigations Applied

| Finding                                                 | Severity | Status                                                             |
| ------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| Shell injection via anomaly.details in rb-kick-pipeline | HIGH-001 | ✅ Fixed: `execFile` + `SAFE_STAGE`/`SAFE_TASKID` regex validation |
| Unvalidated PID string in kill -9 (rb-force-gc)         | HIGH-002 | ✅ Fixed: `/^\d+$/` validation + `/proc/<pid>/comm` TOCTOU guard   |
| `require()` in ESM context (runbook-executor.ts)        | MED-002  | ✅ Fixed: AnomalyClassifier injected via `ExecutorDeps.classifier` |
| Filename injection in rb-rotate-logs gzip step          | MED-001  | 📋 Deferred v2.2.1: switch to Node.js fs/zlib APIs                 |
| Overly broad find scope in rb-emergency-cleanup         | MED-003  | 📋 Deferred v2.2.1: narrow to known log dirs                       |
| rb-kill-zombie ignores anomaly.target_id                | LOW-001  | 📋 Deferred v2.2.1                                                 |
| rb-db-emergency uses cp on live SQLite                  | LOW-002  | 📋 Deferred v2.2.1: use sqlite3 .backup                            |
| sendSignal wiring via Synapse only                      | LOW-003  | 📋 Deferred v2.2.1: add file-based fallback                        |
| Dynamic SET clause in IncidentManager.transition        | LOW-004  | 📋 Deferred v2.2.1                                                 |

---

## Test Coverage

| Suite                                 | Tests    | Result               |
| ------------------------------------- | -------- | -------------------- |
| anomaly-classifier.test.ts            | 14       | ✅                   |
| incident-manager.test.ts              | 5        | ✅                   |
| runbook-executor.test.ts              | 3        | ✅                   |
| runbook-executor-verification.test.ts | 4        | ✅                   |
| runbook-registry.test.ts              | 6        | ✅                   |
| escalation-router.test.ts             | 7        | ✅                   |
| probes/disk-probe.test.ts             | 1        | ✅                   |
| probes/memory-probe.test.ts           | 2        | ✅                   |
| probes/brain-db-probe.test.ts         | 2        | ✅                   |
| runbooks/rb-kick-pipeline.test.ts     | 9        | ✅                   |
| runbooks/rb-force-gc.test.ts          | 4        | ✅                   |
| runbooks/rb-gc-trigger.test.ts        | 3        | ✅                   |
| runbooks/rb-rotate-logs.test.ts       | 4        | ✅                   |
| **Total healing**                     | **64**   | **✅ All pass**      |
| **Full extension suite**              | **1423** | **✅ 0 regressions** |

TypeScript: `pnpm tsc --noEmit` — 0 errors.

---

## Behavioral Signatures (Version Forensics)

### What v2.2.0 looks like when working

```
[HealingEngine] init — AnomalyClassifier ready, 12 runbooks loaded
[HealingEngine] started — 6 supplemental probes active
[HealingEngine] onReading: disk /dev/sda1 87% — threshold 80 — anomaly: disk_high [tier-1]
[IncidentManager] upsert incident <uuid> state=detected anomaly=disk_high
[RunbookExecutor] dry-run rb-rotate-logs: would rotate 3 log files in ~/.openclaw/logs
[EscalationRouter] tier-1 → Synapse (info): Disk usage 87% on /dev/sda1
[HealingEngine] onReading: disk /dev/sda1 72% — no anomaly (self-resolved after probe cycle)
[IncidentManager] incident <uuid> → self_resolved (pre-probe clear)
```

### What v2.2.0 looks like when broken

- `[HealingEngine] init — HealingProbeRegistry start failed` → cortex-bridge.ts `dbPath` not resolved; check brain.db path
- `[RunbookExecutor] pre-verify threw` → check AnomalyClassifier injection in `ExecutorDeps`
- `[EscalationRouter] tier-3 sendSynapse failed` → Synapse DB unreachable; check brain.db write permissions
- No HealingEngine logs at all → `index.ts` integration not loaded; verify OpenClaw gateway restart after deploy

### Debugging hooks

```bash
# Active incidents
sqlite3 ~/.openclaw/brain.db "SELECT id,anomaly_type,state,severity,detected_at FROM incidents WHERE state NOT IN ('resolved','self_resolved','dismissed') ORDER BY detected_at DESC"

# Runbook execution history
sqlite3 ~/.openclaw/brain.db "SELECT id,mode,dry_run_count,last_executed_at,last_outcome FROM runbooks ORDER BY last_executed_at DESC"

# Healing metrics (last 24h)
sqlite3 ~/.openclaw/brain.db "SELECT event_name,count(*) FROM metrics WHERE event_name LIKE 'heal_%' AND ts > datetime('now','-24 hours') GROUP BY event_name"

# All incident state transitions
sqlite3 ~/.openclaw/brain.db "SELECT id, json_each.value FROM incidents, json_each(audit_trail) WHERE id='<incident-id>'"
```

---

## Escalation Tiers Reference

| Tier | Trigger                                  | Action                           | User visible?                   |
| ---- | ---------------------------------------- | -------------------------------- | ------------------------------- |
| 0    | Ephemeral anomaly, auto-resolved         | Metric logged only               | ❌ Silent                       |
| 1    | Anomaly persists, severity=1             | Synapse info message             | Agent-visible at heartbeat      |
| 2    | Severity=2 or runbook failed             | Synapse action (priority=action) | Agent-visible, prompts response |
| 3    | Severity=3 or db_corruption/gateway_down | Synapse urgent + Signal          | 🚨 Direct to Matthew            |

---

## Design Deviation Notes

1. **Signal delivery path**: Plugin context cannot call the gateway `message` tool directly. Tier-3 Signal alerts are routed via Synapse with `priority='urgent'`. The heartbeat picks up urgent Synapse messages and forwards to Signal. Explicit `sendSignal` wiring documented in LOW-003 (v2.2.1 to add file-based fallback).

2. **`cortex_heal` tool**: Tool registration deferred to v2.2.1. The healing engine runs and escalates autonomously; manual override (`cortex_heal record_fix`, `cortex_heal dismiss`) will land in the next patch.

---

## Rollback

```bash
# If v2.2.0 causes issues, revert to v2.1.0:
cd ~/Projects/helios/extensions/cortex
git revert f65c4b3e2 --no-commit
git commit -m "revert: roll back to Cortex v2.1.0"
# Restart OpenClaw to reload extension
openclaw gateway restart
```

Brain.db schema additions (`incidents`, `runbooks` tables) are additive — rollback will not corrupt existing data.

---

## Next: v2.2.1 (Deferred Fixes)

- MED-001: Switch rb-rotate-logs gzip step to Node.js fs/zlib API
- MED-003: Narrow rb-emergency-cleanup scope from `$HOME` to known log dirs
- LOW-001: Service-specific zombie kill (use `anomaly.target_id` + SERVICE_MAP)
- LOW-002: SQLite `.backup` for brain.db emergency copy
- LOW-003: File-based fallback for Signal tier-3 when Synapse is down
- LOW-004: Explicit SET columns in IncidentManager.transition
- `cortex_heal` tool registration (manual override API)

---

**Deploy signed off by:** Deploy Specialist (pipeline stage)  
**Date:** 2026-02-18 19:23 ET
