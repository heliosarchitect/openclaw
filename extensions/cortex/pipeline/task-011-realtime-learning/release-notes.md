# cortex-v2.6.0 — Real-Time Learning Engine

**Release Date:** 2026-02-19
**Phase:** 5.7 of IMPROVEMENT_PLAN
**Task:** task-011-realtime-learning
**Commit:** df539391c

---

## Summary

Helios can now detect its own failures, classify root causes, and propagate fixes — automatically, without a restart. When a tool errors, a user corrects a bad response, a SOP violation fires, or a trust demotion occurs, the engine logs the failure, classifies it deterministically, and applies the fix (SOP patch, atom update, regression test, or Synapse escalation) in the background with zero impact on the hot path.

---

## New Capabilities

### Detection Layer (5 event sources)

- **ToolMonitor** — captures exec/write/gateway non-zero exits and exceptions
- **CorrectionScanner** — detects user correction signals (19 keywords) within 5-minute window after tool calls; false-positive guards for code blocks and quoted text
- **HookViolationRelay** — converts task-003 SOP violation events into failure records
- **TrustEventRelay** — converts task-010 trust demotion events into failure records
- **PipelineFailRelay** — captures pipeline stage failures from orchestrator

### Classification Layer (deterministic, no LLM in hot path)

- **FailureClassifier** — 12 rules across 5 failure types; maps to root cause labels (`wrong_path`, `stale_sop`, `missing_binary`, `trust_boundary_crossed`, `pipeline_stage_failure`, `unknown`)
- **Root Cause Router** — dispatches to propagation targets per failure type

### Propagation Layer (4 fix mechanisms)

- **SOPPatcher** — additive SOP patches auto-committed; modifying patches sent to Synapse as Tier 3 preview
- **AtomPropagator** — records failure→fix causal chains in atom graph
- **RegressionTestGen** — generates `.test.ts` stubs + brain.db entries for TRUST_DEM and PIPE_FAIL events
- **CrossSystemRelay** — Synapse messages for cross-agent propagation needs

### Infrastructure

- **RecurrenceDetector** — 30-day sliding window; Synapse escalation on repeat patterns
- **MetricsEmitter** — computes T2P, completeness, recurrence rate, false-positive rate, escalation queue depth
- **AsyncQueue** — non-blocking event queue; ≤2ms hot path budget guaranteed

---

## New Database Tables (brain.db)

| Table                 | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `failure_events`      | All detected failures with type, tier, root cause, propagation status |
| `propagation_records` | Each fix action with commit SHA, Synapse message ID, approval state   |
| `regression_tests`    | Auto-generated test entries linked to failures                        |

9 indexes deployed for query performance.

---

## New Files

| Path                                    | Purpose                                    |
| --------------------------------------- | ------------------------------------------ |
| `realtime-learning/index.ts`            | Main orchestrator, public API entry points |
| `realtime-learning/types.ts`            | All types, config interface, defaults      |
| `realtime-learning/schema.ts`           | brain.db migrations (idempotent)           |
| `realtime-learning/async-queue.ts`      | Non-blocking event queue                   |
| `realtime-learning/detection/*.ts`      | 5 detection modules                        |
| `realtime-learning/classification/*.ts` | Classifier + router                        |
| `realtime-learning/propagation/*.ts`    | 4 propagation workers                      |
| `realtime-learning/recurrence/*.ts`     | Recurrence detector                        |
| `realtime-learning/metrics/*.ts`        | Metrics emitter                            |
| `realtime-learning/__tests__/*.ts`      | 8 test files (50/50 passing)               |
| `config/realtime-learning.json`         | Configuration file                         |
| `~/bin/failure-log`                     | CLI: history, detail, metrics views        |

---

## New Cron Jobs

| ID         | Schedule       | Purpose                                                     |
| ---------- | -------------- | ----------------------------------------------------------- |
| `24c2150a` | Mondays 9AM ET | Weekly metrics report → Synapse `realtime-learning-metrics` |

---

## Test Coverage

**50/50 tests passing** across 8 test files:

- `failure-classifier.test.ts` (12 tests)
- `async-queue.test.ts` (4 tests)
- `correction-scanner.test.ts` (5 tests)
- `integration.test.ts` (5 tests)
- `metrics-emitter.test.ts` (5 tests)
- `recurrence-detector.test.ts` (5 tests)
- `regression-test-gen.test.ts` (6 tests)
- `sop-patcher.test.ts` (8 tests)

TypeScript: `pnpm tsc --noEmit` clean.

---

## Integration Status

**Passive until wired.** Bus integration points are exported from `realtime-learning/index.ts` but not yet wired to the observation bus. The engine listens to nothing until the following hooks are connected:

```typescript
import { createRealtimeLearningEngine } from "./realtime-learning/index.js";
const rtl = await createRealtimeLearningEngine(db, config);

// Wire these to the observation bus:
observationBus.on("tool:result", rtl.onToolResult);
observationBus.on("user:message", rtl.onUserMessage);
observationBus.on("sop:violation", rtl.onSopViolation);
observationBus.on("trust:demotion", rtl.onTrustDemotion);
observationBus.on("pipeline:fail", rtl.onPipelineFail);
```

Bus wiring scheduled for a subsequent task (task-016 or dedicated).

---

## Behavioral Signature

**Log pattern when active:**

```
[cortex:realtime-learning] failure detected: TOOL_ERR:wrong_path (tier 1)
[cortex:realtime-learning] classified → root_cause: wrong_path → sop_patch + atom
[cortex:sop-patcher] additive patch committed: df539391c (corrections.md)
[cortex:atom-propagator] atom created: failure:TOOL_ERR:a1b2c3d4
[cortex:recurrence-detector] checked 30d window — no prior occurrence
```

**Log pattern when passive:**

```
(no output — bus not yet wired)
failure-log shows 0 events
```

---

## Rollback

```bash
# Remove module from load path (cortex extension config)
# Drop tables:
sqlite3 ~/Projects/helios/extensions/cortex/python/brain.db \
  "DROP TABLE IF EXISTS propagation_records; DROP TABLE IF EXISTS regression_tests; DROP TABLE IF EXISTS failure_events;"
# Disable cron:
# openclaw cron disable 24c2150a
# Remove CLI:
rm ~/bin/failure-log
```

No other systems affected (passive until wired).

---

## Versions

| Component          | v2.5.0 | v2.6.0       |
| ------------------ | ------ | ------------ |
| Earned Autonomy    | ✅     | ✅           |
| Real-Time Learning | ❌     | ✅ (passive) |
| Brain DB tables    | 8      | 11           |
| Weekly crons       | 1      | 2            |
| CLI tools          | 2      | 3            |
