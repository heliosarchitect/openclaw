# Self-Healing Infrastructure: Build Report

**Task ID:** task-006-self-healing  
**Stage:** build  
**Date:** 2026-02-18  
**Cortex Version Target:** 2.2.0

---

## Build Summary

All components from the design document were implemented and integrated into the cortex plugin.

## Components Built

### Core Engine (healing/)

| File                    | LOC  | Description                                                                             |
| ----------------------- | ---- | --------------------------------------------------------------------------------------- |
| `types.ts`              | ~150 | Full type definitions: AnomalyType, Incident, Runbook, RunbookStep, HealingEngineConfig |
| `anomaly-classifier.ts` | ~200 | Maps SourceReading → HealthAnomaly[] for 13 anomaly types                               |
| `incident-manager.ts`   | ~220 | Incident CRUD + state machine + brain.db persistence + upsert dedup                     |
| `runbook-registry.ts`   | ~250 | Runbook catalog with dry_run graduation + approval workflow                             |
| `runbook-executor.ts`   | ~200 | Step-by-step execution with pre-verification + post-verification                        |
| `escalation-router.ts`  | ~180 | Tier 0-3 routing (metrics only → Synapse → Signal)                                      |
| `probe-registry.ts`     | ~100 | Supplemental probe timer management                                                     |
| `index.ts`              | ~310 | HealingEngine orchestrator: event-driven detect→diagnose→remediate→escalate             |

### Probes (healing/probes/)

| Probe                    | Interval | Checks                                                 |
| ------------------------ | -------- | ------------------------------------------------------ |
| `augur-process-probe.ts` | 60s      | PID file + process table + zombie detection            |
| `gateway-probe.ts`       | 120s     | `openclaw gateway status` consecutive failure counting |
| `brain-db-probe.ts`      | 15m      | `PRAGMA integrity_check`                               |
| `disk-probe.ts`          | 10m      | `df` usage percentages on / and ~/                     |
| `memory-probe.ts`        | 5m       | `/proc/meminfo` MemAvailable                           |
| `log-bloat-probe.ts`     | 30m      | Log files > 100MB                                      |

### Runbooks (healing/runbooks/)

12 runbooks implemented: `rb-restart-service`, `rb-kill-zombie`, `rb-restart-augur`, `rb-clear-phantom`, `rb-kick-pipeline`, `rb-probe-then-alert`, `rb-rotate-logs`, `rb-emergency-cleanup`, `rb-gc-trigger`, `rb-force-gc`, `rb-db-emergency`, `rb-gateway-restart`.

Auto-whitelisted (start in auto_execute): `rb-rotate-logs`, `rb-gc-trigger`.

### Integration Changes

1. **`cortex-bridge.ts`** — Added `runSQL()`, `getSQL()`, `allSQL()`, `dbPath` for direct brain.db access from TypeScript
2. **`predictive/polling-engine.ts`** — Added `onReading(callback)` public method for external listeners (zero-breaking-change)
3. **`index.ts`** — Full HealingEngine lifecycle integration: init after PollingEngine, start on session start, stop on session stop. Synapse messaging via brain.db Python bridge.

### Tests

| Suite                           | Tests  | Status             |
| ------------------------------- | ------ | ------------------ |
| anomaly-classifier.test.ts      | 14     | ✅                 |
| incident-manager.test.ts        | 5      | ✅                 |
| runbook-executor.test.ts        | 3      | ✅                 |
| runbook-registry.test.ts        | 6      | ✅                 |
| escalation-router.test.ts       | 7      | ✅                 |
| probes/disk-probe.test.ts       | 1      | ✅                 |
| probes/memory-probe.test.ts     | 2      | ✅                 |
| probes/brain-db-probe.test.ts   | 2      | ✅                 |
| runbooks/rb-rotate-logs.test.ts | 4      | ✅                 |
| runbooks/rb-gc-trigger.test.ts  | 3      | ✅                 |
| **Total**                       | **47** | **✅ All passing** |

Full cortex suite: **330 tests across 26 files — all passing, zero regressions.**

## Bug Fixed During Build

**MockDB test helper** (`incident-manager.test.ts`): The `isDismissed` check used `sql.includes('dismissed')` which false-matched the `NOT IN ('resolved','self_resolved','dismissed')` clause in the upsert query. Fixed to `sql.includes("state = 'dismissed'")`.

## Compilation

`pnpm tsc --noEmit` — **0 errors**

## Design Deviations

1. **Signal delivery**: Plugin context doesn't have access to the gateway `message` tool directly. Tier-3 Signal alerts are sent as `urgent` priority Synapse messages instead. The agent's heartbeat picks up urgent Synapse messages and can forward to Signal.
2. **`cortex_heal` tool**: Not registered in this build stage — tool registration happens in the test/deploy stages since it requires schema validation integration.
