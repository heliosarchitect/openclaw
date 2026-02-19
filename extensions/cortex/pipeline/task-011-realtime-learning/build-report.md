# Task-011: Real-Time Learning — Build Report

**Stage:** build | **Status:** pass
**Date:** 2026-02-19T02:33:00-05:00
**Phase:** 5.7 of IMPROVEMENT_PLAN

---

## Modules Built

### Core (`realtime-learning/`)

| File             | Purpose                                                                    | Lines |
| ---------------- | -------------------------------------------------------------------------- | ----- |
| `index.ts`       | Main orchestrator — wires detection→classification→propagation pipeline    | ~300  |
| `types.ts`       | All type definitions, config, defaults, DB interface                       | ~180  |
| `schema.ts`      | brain.db migrations: failure_events, propagation_records, regression_tests | ~70   |
| `async-queue.ts` | Non-blocking event queue (≤2ms hot path budget)                            | ~60   |

### Detection Layer (`detection/`)

| File                      | Purpose                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `tool-monitor.ts`         | Monitors exec/write/gateway for non-zero exits, exceptions                   |
| `correction-scanner.ts`   | Scans user messages for correction keywords in 5-min window after tool calls |
| `hook-violation-relay.ts` | Converts SOP violation events from task-003 into failure events              |
| `trust-event-relay.ts`    | Converts trust demotion events from task-010 into failure events             |
| `pipeline-fail-relay.ts`  | Converts pipeline stage failures into failure events                         |

### Classification Layer (`classification/`)

| File                    | Purpose                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `failure-classifier.ts` | Rule-based deterministic classifier — 12 rules across 5 failure types, fallback to 'unknown' |

### Propagation Layer (`propagation/`)

| File                     | Purpose                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `sop-patcher.ts`         | Auto-patches SOP files (additive=auto-commit, modifying=Synapse preview) |
| `atom-propagator.ts`     | Creates atoms documenting failure→fix causal chains                      |
| `regression-test-gen.ts` | Generates regression test entries in brain.db + .test.ts stubs           |
| `cross-system-relay.ts`  | Posts structured Synapse messages for cross-agent propagation            |

### Recurrence & Metrics

| File                                | Purpose                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `recurrence/recurrence-detector.ts` | 30-day sliding window recurrence check with Synapse escalation     |
| `metrics/metrics-emitter.ts`        | Computes T2P, completeness, recurrence rate; formats weekly report |

---

## Tests

**26/26 passing** across 4 test files:

- `failure-classifier.test.ts` — 12 tests: all 5 failure types × sub-patterns + fallback
- `async-queue.test.ts` — 4 tests: async processing, sync enqueue performance, error resilience
- `correction-scanner.test.ts` — 5 tests: keyword detection, code block filtering, quote filtering
- `integration.test.ts` — 5 tests: full pipeline for TOOL_ERR, CORRECT, TRUST_DEM, PIPE_FAIL, metrics

---

## TypeScript

`pnpm tsc --noEmit` — **clean** (exit 0)

---

## Database Schema

Three new tables added to brain.db (idempotent migrations):

1. **failure_events** — stores detected failures with type, tier, root cause, propagation status
2. **propagation_records** — tracks each fix attempt (SOP patch, atom, regression test, etc.)
3. **regression_tests** — auto-generated test entries linked to failures

---

## Architecture Decisions

1. **Async queue pattern** — detection enqueues synchronously (≤1ms), processing runs on setImmediate. Zero blocking of the main session.
2. **Rule ordering matters** — classifier rules ordered most-specific-first (e.g., "command not found" before general "not found") to avoid false classifications.
3. **Additive-only auto-commit** — SOP patches that add new rules are auto-committed. Modifications to existing rules require Synapse preview (Tier 3 escalation).
4. **Graceful degradation** — if atoms table doesn't exist, atom propagation skips silently. If SOP directory doesn't exist, creates corrections.md fallback.
5. **No LLM in hot path** — all classification is rule-based and deterministic.

---

## Integration Points Ready

- `toolMonitor.onToolResult()` — wire to after_tool_call hook in index.ts
- `correctionScanner.onUserMessage()` — wire to user message handler
- `hookViolationRelay.onViolation()` — wire to task-003 SOP violation events
- `trustEventRelay.onDemotion()` — wire to task-010 trust demotion events
- `pipelineFailRelay.onPipelineFail()` — wire to pipeline stage results

Integration into main index.ts deferred to deploy stage.
