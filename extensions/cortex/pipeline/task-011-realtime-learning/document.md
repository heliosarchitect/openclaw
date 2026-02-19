# Task-011: Real-Time Learning — Adapt Without Restart — Documentation

**Stage:** document | **Status:** pass
**Phase:** 5.7 of IMPROVEMENT_PLAN
**Date:** 2026-02-19
**Version Target:** cortex-v2.5.0
**Builds on:** task-003 (pre-action hooks), task-010 (earned autonomy/trust), task-007 (adversarial testing), task-008 (knowledge compression)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Quick Start](#2-quick-start)
3. [Architecture Reference](#3-architecture-reference)
4. [Module API Reference](#4-module-api-reference)
   - 4.1 Detection Layer
   - 4.2 Classification Layer
   - 4.3 Propagation Layer
   - 4.4 Recurrence Detector
   - 4.5 Metrics Emitter
5. [brain.db Schema Reference](#5-braindb-schema-reference)
6. [Configuration Reference](#6-configuration-reference)
7. [CLI Reference: `failure-log`](#7-cli-reference-failure-log)
8. [Failure Taxonomy Reference](#8-failure-taxonomy-reference)
9. [Propagation Safety Rules](#9-propagation-safety-rules)
10. [Behavioral Signatures (Version Forensics)](#10-behavioral-signatures-version-forensics)
11. [Failure Mode Signatures](#11-failure-mode-signatures)
12. [Debugging Hooks](#12-debugging-hooks)
13. [Integration Points & Dependencies](#13-integration-points--dependencies)
14. [Metrics Reference](#14-metrics-reference)
15. [Rollback Plan](#15-rollback-plan)

---

## 1. Overview

Real-Time Learning closes the feedback loop that today allows the same mistake to recur across sessions. When Helios makes an error — a bad path, a stale SOP, a crossed trust boundary — the system now:

1. **Detects** the failure within 5 seconds
2. **Classifies** it deterministically (no LLM in the hot path)
3. **Propagates** a fix: patches the SOP, updates hook patterns, creates atoms, generates a regression test
4. **Monitors** for recurrence and escalates if a fix didn't hold

All of this runs asynchronously — zero blocking of the main session. The detection layer adds ≤ 2ms overhead to any monitored tool call.

### What This Is Not

- It does **not** replace Matthew's judgment. Tier 3 changes (modifying existing SOP rules, trust boundary cases) are previewed via Synapse and require explicit approval.
- It does **not** retroactively backfill prior sessions. Learning is future-forward from deployment.
- It does **not** directly modify other agents' files. Cross-system propagation sends a structured Synapse message; the receiving agent acts on it.

---

## 2. Quick Start

### Check the failure log

```bash
failure-log                          # last 7 days, all types
failure-log --days 30               # last 30 days
failure-log --type CORRECT          # corrections only
failure-log --status pending        # unresolved failures
failure-log --id a1b2c3d4           # full detail for one failure
```

### Inspect a propagation record

```bash
failure-log --id <failure_id>
# Shows: detection time, type, tier, root cause, propagation status, commit SHA, Synapse msg ID
```

### Query metrics

```bash
failure-log --metrics               # current T2P, completeness, recurrence rate
```

### Approve a Tier 3 preview

When Helios sends a Synapse preview for a non-additive SOP change, reply to the thread with `y` (approve) or `n` (reject) within 10 minutes. Default on timeout: **skip** (no commit).

### Disable the system (emergency)

```bash
# Stop detection (leaves brain.db intact)
pkill -f realtime-learning
# Or: set "enabled": false in ~/Projects/helios/config/realtime-learning.json and restart Cortex
```

---

## 3. Architecture Reference

```
┌─────────────────────────────────────────────────────────────────┐
│  DETECTION LAYER  (≤ 2ms overhead, async enqueue)               │
│                                                                 │
│  ToolMonitor         — tool:result events (exec/write/gateway)  │
│  CorrectionScanner   — session message keyword scanner          │
│  HookViolationRelay  — sop:violation events from task-003       │
│  TrustEventRelay     — trust:demotion events from task-010      │
│  PipelineFailRelay   — Synapse pipeline:stage-result failures   │
│                                                                 │
│  All sources → AsyncQueue (in-memory, drain on setImmediate)    │
└──────────────────────────┬──────────────────────────────────────┘
                           │ failure_event record
┌──────────────────────────▼──────────────────────────────────────┐
│  CLASSIFICATION LAYER  (deterministic, rule-based)              │
│                                                                 │
│  FailureClassifier    — maps event → type + root_cause_label    │
│  RootCauseRouter      — maps root_cause → propagation_targets[] │
└──────────────────────────┬──────────────────────────────────────┘
                           │ classified event + targets
┌──────────────────────────▼──────────────────────────────────────┐
│  PROPAGATION LAYER  (async workers, one per target type)        │
│                                                                 │
│  SOPPatcher           — Tier 1-2: auto-commit additive patches  │
│                       — Tier 3: Synapse preview (10min TTL)     │
│  HookPatternUpdater   — append-only deny pattern additions      │
│  AtomPropagator       — create atom: failure→fix causal chain   │
│  RegressionTestGen    — brain.db entry + .test.ts stub          │
│  CrossSystemRelay     — structured Synapse msg to other domains │
│                                                                 │
│  After propagation: RecurrenceDetector + MetricsEmitter         │
└─────────────────────────────────────────────────────────────────┘
```

**Key invariant:** Detection is synchronous-to-enqueue, everything after is async. The main session thread is never blocked by learning.

---

## 4. Module API Reference

### 4.1 Detection Layer

#### `ToolMonitor`

**File:** `src/realtime-learning/detection/tool-monitor.ts`

Subscribes to the cortex observation bus `tool:result` events. Fires on any non-zero exit code or caught exception.

```typescript
// Event type expected on bus
interface ToolResultEvent {
  toolName: string;
  sessionId: string;
  id: string; // tool call ID
  input: string; // stringified tool input
  exitCode?: number;
  error?: string;
  exception?: Error;
}
```

**Triggers:** `exitCode !== 0 || exception != null`
**Emits:** `TOOL_ERR` failure event, Tier 1

---

#### `CorrectionScanner`

**File:** `src/realtime-learning/detection/correction-scanner.ts`

Maintains a 5-minute sliding window after each tool call. Scans incoming session messages for correction keyword matches.

```typescript
interface CorrectionScannerConfig {
  keywords: string[]; // from realtime-learning.json
  windowMs: number; // default 300000 (5 min)
  proximityThreshold: number; // default 0.3 (Levenshtein ratio)
}
```

**False positive exclusion:** Strips lines starting with ` ``` ` or `>` before keyword scan.

**Triggers:** ≥1 keyword match AND proximity ≥ threshold AND scanner window is open
**Emits:** `CORRECT` failure event, Tier 2

---

#### `HookViolationRelay`

**File:** `src/realtime-learning/detection/hook-violation-relay.ts`

Subscribes to `sop:violation` on the observation bus.

```typescript
// Expects from task-003
interface SopViolationEvent {
  hookId: string;
  sopFile: string;
  ruleId: string;
  stale: boolean;
}
```

**Triggers:** Any `sop:violation` where `stale === true`
**Emits:** `SOP_VIOL` failure event, Tier 2

---

#### `TrustEventRelay`

**File:** `src/realtime-learning/detection/trust-event-relay.ts`

Subscribes to `trust:demotion` on the observation bus.

```typescript
// Expects from task-010
interface TrustDemotionEvent {
  milestone: string;
  priorTier: number;
  reason: string;
}
```

**Triggers:** Any `trust:demotion` event
**Emits:** `TRUST_DEM` failure event, Tier 3

---

#### `PipelineFailRelay`

**File:** `src/realtime-learning/detection/pipeline-fail-relay.ts`

Subscribes to Synapse topic `pipeline:stage-result`. Filters for `result === 'fail' || result === 'blocked'`.

**Triggers:** Pipeline stage result with fail/blocked outcome
**Emits:** `PIPE_FAIL` failure event, Tier 3

---

### 4.2 Classification Layer

#### `FailureClassifier`

**File:** `src/realtime-learning/classification/failure-classifier.ts`

**Signature:**

```typescript
function classifyFailure(event: RawFailureEvent): ClassifiedFailureEvent;
```

**Returns:** Input event augmented with `root_cause: string` and `propagation_targets: PropagationTarget[]`.

**Classification Rules:**

| Type      | Pattern Match                               | Root Cause Label         | Targets                                |
| --------- | ------------------------------------------- | ------------------------ | -------------------------------------- |
| TOOL_ERR  | `/ENOENT\|not found\|No such file/`         | `wrong_path`             | `hook_pattern`, `atom`                 |
| TOOL_ERR  | `/permission denied\|EACCES/i`              | `permissions`            | `sop_patch`, `atom`                    |
| TOOL_ERR  | `/command not found\|not a valid command/i` | `missing_binary`         | `sop_patch`, `hook_pattern`, `atom`    |
| CORRECT   | `/wrong path\|incorrect path/i`             | `wrong_path`             | `sop_patch`, `atom`                    |
| CORRECT   | `/outdated SOP\|stale SOP\|that SOP/i`      | `stale_sop`              | `sop_patch`, `regression_test`         |
| SOP_VIOL  | _(any)_                                     | `stale_sop_rule`         | `sop_patch`, `hook_pattern`, `atom`    |
| TRUST_DEM | _(any)_                                     | `trust_boundary_crossed` | `sop_patch`, `regression_test`, `atom` |
| PIPE_FAIL | _(any)_                                     | `pipeline_stage_failure` | `regression_test`, `synapse_relay`     |

**Fallback:** `root_cause = 'unknown'`, `propagation_targets = ['synapse_relay']` — posts to Synapse requesting Matthew's classification.

---

#### `RootCauseRouter`

**File:** `src/realtime-learning/classification/root-cause-router.ts`

**Signature:**

```typescript
async function routeToWorkers(
  event: ClassifiedFailureEvent,
  ctx: PropagationContext,
): Promise<PropagationRecord[]>;
```

Dispatches the classified event concurrently to all workers in `event.propagation_targets`. Waits for all workers to resolve (or timeout at 60s) before updating `failure_events.propagation_status`.

---

### 4.3 Propagation Layer

#### `SOPPatcher`

**File:** `src/realtime-learning/propagation/sop-patcher.ts`

**Signature:**

```typescript
async function patchSOP(
  failure: ClassifiedFailureEvent,
  sopPath: string,
): Promise<PropagationRecord>;
```

**Patch Types:**

| Root Cause               | Patch Strategy                                                  | Auto-commit? |
| ------------------------ | --------------------------------------------------------------- | ------------ |
| `wrong_path`             | Append `# Correct path: <corrected>` to relevant SOP section    | Yes          |
| `stale_sop`              | Append `# Updated <date>: <correction summary>` to rule         | Yes          |
| `missing_binary`         | Append `# Ensure: <binary> at <path>` to dependencies section   | Yes          |
| `trust_boundary_crossed` | Append the specific action as an explicit boundary note         | Yes          |
| _(modifying existing)_   | Generate diff → Synapse preview → wait for approval (10min TTL) | No           |

**Commit message format:**

```
fix(sop): auto-patch from failure ${failureId} [realtime-learning]
```

**File mutex:** One patch operation per SOP file at a time. Concurrent patches queue behind a per-file lock.

---

#### `HookPatternUpdater`

**File:** `src/realtime-learning/propagation/hook-pattern-updater.ts`

**Signature:**

```typescript
async function addDenyPattern(
  failure: ClassifiedFailureEvent,
  patternEntry: HookPattern,
): Promise<PropagationRecord>;
```

Appends a new deny rule to `hooks/patterns.ts`. Append-only — never removes or modifies existing patterns.

**Commit message format:**

```
fix(hooks): add deny pattern for ${failureId} [realtime-learning]
```

---

#### `AtomPropagator`

**File:** `src/realtime-learning/propagation/atom-propagator.ts`

**Signature:**

```typescript
async function propagateToAtom(
  failure: ClassifiedFailureEvent,
  propagationRecords: PropagationRecord[],
): Promise<void>;
```

Creates an atom encoding the failure→fix causal chain:

```
subject:      "failure:<TYPE>:<id>"
action:       "triggered by <root_cause> in session <session_id>"
outcome:      "propagated to <targets>"
consequences: "regression test created; SOP patched; recurrence detection armed"
```

This makes every failure discoverable via `atom_find_causes` — future root cause analysis can trace cascading failures.

---

#### `RegressionTestGen`

**File:** `src/realtime-learning/propagation/regression-test-gen.ts`

**Signature:**

```typescript
async function generateRegressionTest(failure: ClassifiedFailureEvent): Promise<PropagationRecord>;
```

**Outputs:**

1. `regression_tests` brain.db row (active, linked to `failure_id`)
2. TypeScript stub at `src/realtime-learning/__tests__/regression/regression-${failure.id}.test.ts`

**Stub structure:**

```typescript
describe("regression: ${failureType} — ${rootCause}", () => {
  it("should not recur after propagation (failure ${failureId})", async () => {
    // Reproduce: <original failure context>
    // Assert: patched SOP/hook/atom prevents recurrence
  });
});
```

The stub is left intentionally incomplete — it documents what needs to be tested and is filled during the next test stage or by the auto-test pipeline.

---

#### `CrossSystemRelay`

**File:** `src/realtime-learning/propagation/cross-system-relay.ts`

**Signature:**

```typescript
async function relayToExternalDomain(
  failure: ClassifiedFailureEvent,
  recommendedFix: string,
  targetSop: string,
): Promise<PropagationRecord>;
```

Sends a structured Synapse message when a failure's root cause traces to another agent's domain (e.g., AUGUR failure → infrastructure SOP):

```json
{
  "failure_id": "...",
  "source_domain": "augur",
  "root_cause": "wrong_path",
  "recommended_fix": "Update binary path from X to Y in AUGUR infrastructure SOP",
  "target_sop": "~/Projects/augur/sops/infrastructure.md",
  "requires_action": true
}
```

**Safety:** Helios never directly writes another agent's files. This message is advisory.

---

### 4.4 Recurrence Detector

**File:** `src/realtime-learning/recurrence/recurrence-detector.ts`

**Signature:**

```typescript
async function checkRecurrence(failure: ClassifiedFailureEvent): Promise<void>;
```

Runs after every propagation record commit. Queries `failure_events` for any record with the same `root_cause` within the last 30 days (configurable).

**On recurrence detected:**

1. Increments `recurrence_count` on the current failure event
2. Sets `last_recurred_at`
3. Posts urgent Synapse alert to thread `recurrence:<root_cause>`:
   ```
   ⚠️ Recurrence detected: <root_cause>
   Prior occurrence: <id> (<date>)
   Propagation status from prior: <status>
   Manual review needed.
   ```

---

### 4.5 Metrics Emitter

**File:** `src/realtime-learning/metrics/metrics-emitter.ts`

**Signature:**

```typescript
async function emitWeeklyReport(): Promise<void>;
async function getMetricsSnapshot(): Promise<MetricsSnapshot>;
```

All metrics are computed from existing `failure_events` and `propagation_records` columns — no separate metrics table.

See [Section 14](#14-metrics-reference) for SQL definitions and targets.

---

## 5. brain.db Schema Reference

All three tables are additive migrations — existing tables are unaffected.

### `failure_events`

| Column               | Type    | Description                                                            |
| -------------------- | ------- | ---------------------------------------------------------------------- |
| `id`                 | TEXT PK | Random 8-byte hex ID                                                   |
| `detected_at`        | TEXT    | ISO timestamp (UTC, SQLite datetime)                                   |
| `type`               | TEXT    | `TOOL_ERR \| CORRECT \| SOP_VIOL \| TRUST_DEM \| PIPE_FAIL`            |
| `tier`               | INTEGER | Propagation complexity: `1` (fast) \| `2` (SOP) \| `3` (preview req'd) |
| `source`             | TEXT    | Tool name, message snippet, hook ID, etc.                              |
| `context`            | TEXT    | JSON: `{session_id, tool_call_id, message_id, sop_file, ...}`          |
| `raw_input`          | TEXT    | What Helios tried to do (tool input, message text)                     |
| `failure_desc`       | TEXT    | Human-readable description                                             |
| `root_cause`         | TEXT    | Classifier output. `null` until classified; `'unknown'` if no match    |
| `propagation_status` | TEXT    | `pending \| in_progress \| propagated \| escalated \| no_fix_needed`   |
| `recurrence_count`   | INTEGER | How many times this root cause has recurred (default 0)                |
| `last_recurred_at`   | TEXT    | ISO timestamp of last recurrence, null if none                         |

**Indexes:** `type`, `tier`, `detected_at`, `root_cause`

---

### `propagation_records`

| Column             | Type    | Description                                                                                   |
| ------------------ | ------- | --------------------------------------------------------------------------------------------- |
| `id`               | TEXT PK | Random 8-byte hex ID                                                                          |
| `failure_id`       | TEXT FK | References `failure_events.id`                                                                |
| `started_at`       | TEXT    | ISO timestamp                                                                                 |
| `completed_at`     | TEXT    | ISO timestamp; null until propagation finishes                                                |
| `propagation_type` | TEXT    | `sop_patch \| hook_update \| atom_update \| regression_test \| synapse_relay \| cross_system` |
| `target_file`      | TEXT    | Path of SOP/hook/test file modified; null for atom/synapse                                    |
| `commit_sha`       | TEXT    | Git SHA if auto-committed; null for preview/synapse                                           |
| `synapse_msg_id`   | TEXT    | Synapse message ID for Tier 3 preview messages                                                |
| `preview_sent_at`  | TEXT    | ISO timestamp when Synapse preview was posted                                                 |
| `matthew_approved` | INTEGER | `NULL` = pending, `1` = approved, `0` = rejected                                              |
| `status`           | TEXT    | `pending \| committed \| previewed \| approved \| rejected \| failed`                         |
| `diff_preview`     | TEXT    | Stored diff shown in Synapse preview                                                          |
| `error_detail`     | TEXT    | Error message/stack if `status = 'failed'`                                                    |

**Indexes:** `failure_id`, `status`

---

### `regression_tests`

| Column        | Type    | Description                                   |
| ------------- | ------- | --------------------------------------------- |
| `id`          | TEXT PK | Random 8-byte hex ID                          |
| `failure_id`  | TEXT FK | References `failure_events.id`                |
| `created_at`  | TEXT    | ISO timestamp                                 |
| `last_run_at` | TEXT    | ISO timestamp; null until first run           |
| `description` | TEXT    | Human-readable test scenario description      |
| `test_file`   | TEXT    | Path to `.test.ts` stub file; null if DB-only |
| `pass_count`  | INTEGER | Cumulative pass count (default 0)             |
| `fail_count`  | INTEGER | Cumulative fail count (default 0)             |
| `last_result` | TEXT    | `pass \| fail \| skip`; null until first run  |
| `active`      | INTEGER | `1` = active (run in CI), `0` = retired       |

**Indexes:** `failure_id`, `active`

---

### Migration Safety

All three migrations are guarded with `CREATE TABLE IF NOT EXISTS` — safe to re-run on restart or redeploy. The migration file is:

```
src/realtime-learning/db/schema.ts
```

Run manually:

```bash
cd ~/Projects/helios/extensions/cortex
npx ts-node src/realtime-learning/db/schema.ts
```

---

## 6. Configuration Reference

**File:** `~/Projects/helios/config/realtime-learning.json`

```json
{
  "enabled": true,

  "correction_keywords": [
    "wrong path",
    "that's wrong",
    "bad command",
    "outdated SOP",
    "stale SOP",
    "that hook is wrong",
    "wrong binary",
    "incorrect",
    "no that's not right",
    "should be",
    "use this instead",
    "stop doing that",
    "that's broken"
  ],
  "correction_scan_window_ms": 300000,
  "correction_proximity_threshold": 0.3,

  "recurrence_window_days": 30,

  "preview_ttl_minutes": 10,
  "tier3_default_on_timeout": "skip",

  "sop_auto_commit_types": ["additive"],

  "weekly_metrics_day": "monday",
  "weekly_metrics_hour": 9,

  "detection_queue_drain_interval_ms": 0,
  "propagation_timeout_ms": 60000,
  "per_file_lock_timeout_ms": 5000
}
```

### Field Reference

| Field                               | Default        | Description                                                                                                |
| ----------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `enabled`                           | `true`         | Master kill switch. Set `false` and restart Cortex to disable entirely.                                    |
| `correction_keywords`               | _(list)_       | Keywords triggering correction scan. Extend with domain-specific terms.                                    |
| `correction_scan_window_ms`         | `300000`       | 5-minute window after a tool call during which correction messages are scanned.                            |
| `correction_proximity_threshold`    | `0.3`          | Minimum Levenshtein ratio between correction message and last tool output. Lower = more sensitive.         |
| `recurrence_window_days`            | `30`           | How far back to check for same `root_cause` when testing for recurrence.                                   |
| `preview_ttl_minutes`               | `10`           | How long to wait for Matthew's approval on a Tier 3 preview before timing out.                             |
| `tier3_default_on_timeout`          | `"skip"`       | What to do when Tier 3 preview times out. `"skip"` = don't commit. `"commit"` = commit anyway (dangerous). |
| `sop_auto_commit_types`             | `["additive"]` | Only `"additive"` patches are auto-committed. Extend only with extreme care.                               |
| `weekly_metrics_day`                | `"monday"`     | Day of week for weekly Synapse metrics report.                                                             |
| `weekly_metrics_hour`               | `9`            | Hour (0-23, local time) for weekly report.                                                                 |
| `detection_queue_drain_interval_ms` | `0`            | `setImmediate` drain (0 = next event loop tick). Increase only for load testing.                           |
| `propagation_timeout_ms`            | `60000`        | Max time for the full propagation worker group before declaring timeout.                                   |
| `per_file_lock_timeout_ms`          | `5000`         | Max time to wait for a per-file SOP patch mutex before skipping.                                           |

---

## 7. CLI Reference: `failure-log`

**Location:** `~/bin/failure-log`
**Source:** `src/realtime-learning/cli/failure-log.ts`

### Usage

```
failure-log [options]

Options:
  --days <N>           Show failures from last N days (default: 7)
  --type <TYPE>        Filter by type: TOOL_ERR | CORRECT | SOP_VIOL | TRUST_DEM | PIPE_FAIL
  --status <STATUS>    Filter by propagation_status: pending | in_progress | propagated | escalated | no_fix_needed
  --tier <N>           Filter by tier: 1 | 2 | 3
  --id <id>            Show full detail for one failure ID
  --metrics            Show current metrics snapshot
  --json               Output as JSON (default: table)
  -h, --help           Show this help
```

### Output Examples

**Default table view:**

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ HELIOS FAILURE LOG — last 7 days                                                │
├──────────┬──────────────┬────────────────────────────────────┬──────────────────┤
│ ID       │ Type         │ Description                        │ Status           │
├──────────┼──────────────┼────────────────────────────────────┼──────────────────┤
│ a1b2c3d4 │ TOOL_ERR [1] │ exec: ENOENT ~/bin/wrong-path      │ ✅ propagated    │
│ e5f6a7b8 │ CORRECT  [2] │ "use pnpm not npm"                 │ ⏳ previewed     │
│ c9d0e1f2 │ TRUST_DEM[3] │ overstepped on config write        │ 🔔 escalated     │
└──────────┴──────────────┴────────────────────────────────────┴──────────────────┘
3 failures | 1 propagated | 1 previewed | 1 escalated
```

**Metrics view (`--metrics`):**

```
PROPAGATION METRICS (2026-02-19)
  Avg T2P (time to propagation): 42s  [target: ≤ 60s]  ✅
  Propagation completeness:      85%  [target: ≥ 80%]  ✅
  Recurrence rate:                2%  [target: ≤ 5%]   ✅
  Detection latency (avg):       1.3s [target: ≤ 5s]   ✅
  False positive rate:            7%  [target: ≤ 10%]  ✅
```

**Detail view (`--id a1b2c3d4`):**

```
FAILURE: a1b2c3d4
  Type:        TOOL_ERR (Tier 1)
  Detected:    2026-02-19T02:15:33Z
  Source:      exec
  Root Cause:  wrong_path
  Description: exec: ENOENT /home/bonsaihorn/bin/wrong-path (exit 1)
  Status:      propagated

PROPAGATION RECORDS:
  [pr-001] sop_patch → ~/Projects/helios/sops/binaries.md
           Committed: abc123f | 2026-02-19T02:15:51Z (18s)
  [pr-002] atom_update → failure:TOOL_ERR:a1b2c3d4
           Committed: 2026-02-19T02:15:53Z
```

---

## 8. Failure Taxonomy Reference

| Type Code   | Name             | Detection Source                            | Tier | Auto-Fix?                           |
| ----------- | ---------------- | ------------------------------------------- | ---- | ----------------------------------- |
| `TOOL_ERR`  | Tool Error       | Non-zero exec exit code or exception        | 1    | Yes (additive SOP + hook pattern)   |
| `CORRECT`   | Correction       | Session message keyword within 5-min window | 2    | Yes (additive SOP patch)            |
| `SOP_VIOL`  | SOP Violation    | task-003 `sop:violation` event (stale rule) | 2    | Yes (SOP refresh + hook pattern)    |
| `TRUST_DEM` | Trust Demotion   | task-010 `trust:demotion` event             | 3    | Preview required                    |
| `PIPE_FAIL` | Pipeline Failure | Pipeline stage result = fail/blocked        | 3    | Regression test only; Synapse alert |

**Tier meanings:**

- **Tier 1:** Auto-committed immediately. Low complexity, additive-only changes.
- **Tier 2:** Auto-committed if change is additive. Synapse preview if modifying existing rules.
- **Tier 3:** Always requires Synapse preview and Matthew's explicit approval (or timeout → skip).

---

## 9. Propagation Safety Rules

These rules are **hard-coded** — they cannot be overridden by configuration.

1. **SOP infrastructure files require preview before commit.** Core files (`sops/process.md`, `sops/infrastructure.md`, hook config files) always require Tier 3 preview regardless of whether the change is additive.

2. **Additive changes are always auto-committed.** Adding new rules, paths, or notes to SOP files never requires preview. The only time preview fires for non-core files is when an existing rule would be modified or removed.

3. **Cross-system propagation is Synapse-only.** Helios never writes files in another agent's domain (AUGUR, etc.). It posts a structured message; the receiving agent/session acts on it.

4. **Propagation log is immutable.** Every propagation attempt — success, failure, timeout, rejection — is recorded. No silent skips. Even `no_fix_needed` has a record.

5. **Recurrence escalates.** If the same `root_cause` fires twice within `recurrence_window_days`, the second event is flagged and an urgent Synapse alert is sent. The system treats recurrence as evidence that propagation failed — not as a normal event.

6. **System cannot self-certify.** `propagation_status = 'propagated'` requires either a passing regression test or Matthew's explicit confirmation. Auto-commits set `status = 'committed'` on the propagation record; the parent failure event stays `in_progress` until a test passes.

---

## 10. Behavioral Signatures (Version Forensics)

These log/behavior patterns confirm the system is operating correctly. Use these to verify deployment or diagnose regressions.

### ✅ System is healthy

```
# brain.db has the three tables
sqlite3 ~/Projects/helios/brain.db ".tables" | grep -E "failure_events|propagation_records|regression_tests"
→ Should list all three

# Detection layer is active (within 5s of a tool error, a failure_event row appears)
failure-log --days 1 | head -5

# Weekly metrics cron is scheduled
crontab -l | grep realtime-learning
→ Should show Monday 9AM job

# Config is loaded
cat ~/Projects/helios/config/realtime-learning.json | jq .enabled
→ true
```

### ✅ A failure was correctly processed

```
# Failure detected within 5s
# See: detected_at vs tool call timestamp in failure-log --id <id>

# Propagation completed within 60s (Tier 1-2)
# See: propagation_records.completed_at - started_at in failure-log --id <id>

# Atom created
atom_search field=subject query="failure:TOOL_ERR:"

# SOP git commit present
cd ~/Projects/helios && git log --oneline --grep="realtime-learning" | head -5
→ Should show fix(sop)/fix(hooks) commits
```

---

## 11. Failure Mode Signatures

### 🔴 Detection is silent (no failure_events appearing)

**Symptoms:** Tool errors, corrections from Matthew, or hook violations occur but no rows appear in `failure_events`.

**Likely causes:**

- `enabled: false` in `realtime-learning.json`
- Observation bus not initialized (Cortex restart needed)
- AsyncQueue drain loop crashed silently

**Diagnosis:**

```bash
cat ~/Projects/helios/config/realtime-learning.json | jq .enabled
# Check Cortex process logs
journalctl -u cortex --since "10 minutes ago" | grep -i "realtime-learning\|detection"
```

---

### 🔴 Propagation stuck in `pending`

**Symptoms:** `failure_events.propagation_status = 'pending'` for > 60 seconds.

**Likely causes:**

- Propagation worker crashed (check `propagation_records.error_detail`)
- Per-file mutex deadlock (check `per_file_lock_timeout_ms`)
- brain.db locked (another write holding the lock)

**Diagnosis:**

```bash
sqlite3 ~/Projects/helios/brain.db \
  "SELECT id, failure_id, propagation_type, status, error_detail FROM propagation_records WHERE status='pending' ORDER BY started_at DESC LIMIT 10;"
```

---

### 🔴 Tier 3 preview never arrives

**Symptoms:** TRUST_DEM or PIPE_FAIL failure event created, but no Synapse message appears.

**Likely causes:**

- Synapse write failed (check `propagation_records.status = 'failed'`)
- `synapse_msg_id` null in propagation record (message not sent)

**Diagnosis:**

```bash
failure-log --type TRUST_DEM --status pending
# Check synapse inbox
synapse action=inbox
```

---

### 🔴 Recurrence alert fires for newly deployed system

**Symptoms:** Recurrence alerts immediately after first deployment.

**Likely cause:** brain.db is being shared with a dev/test environment that already has `failure_events` rows. The 30-day window doesn't know it's a fresh deploy.

**Fix:** Run the migration only against the production brain.db, or clear old dev failure events:

```bash
sqlite3 ~/Projects/helios/brain.db \
  "DELETE FROM failure_events WHERE detected_at < datetime('now', '-30 days');"
```

---

### 🔴 False positives flooding the log

**Symptoms:** `failure-log --type CORRECT` shows many spurious corrections.

**Likely cause:** `correction_proximity_threshold` too low, or correction keywords match common non-correction text.

**Fix:** Increase `correction_proximity_threshold` (e.g., 0.3 → 0.5) and/or remove overly broad keywords from `correction_keywords` in `realtime-learning.json`. Restart Cortex.

---

## 12. Debugging Hooks

```bash
# 1. Last 10 failure events (any type)
sqlite3 ~/Projects/helios/brain.db \
  "SELECT id, type, tier, root_cause, propagation_status, detected_at FROM failure_events ORDER BY detected_at DESC LIMIT 10;"

# 2. Failed propagations (error detail)
sqlite3 ~/Projects/helios/brain.db \
  "SELECT pr.id, pr.failure_id, pr.propagation_type, pr.error_detail FROM propagation_records pr WHERE pr.status='failed';"

# 3. Active regression tests
sqlite3 ~/Projects/helios/brain.db \
  "SELECT id, description, pass_count, fail_count, last_result, test_file FROM regression_tests WHERE active=1;"

# 4. Git commits from realtime-learning
cd ~/Projects/helios && git log --oneline --grep="realtime-learning"

# 5. Recurrence events
sqlite3 ~/Projects/helios/brain.db \
  "SELECT id, type, root_cause, recurrence_count, last_recurred_at FROM failure_events WHERE recurrence_count > 0;"

# 6. T2P for last 24 hours
sqlite3 ~/Projects/helios/brain.db \
  "SELECT AVG((julianday(completed_at) - julianday(started_at)) * 86400) as avg_t2p_seconds FROM propagation_records WHERE status='committed' AND started_at > datetime('now', '-1 day');"

# 7. Correction scanner window state (live)
# Check Cortex process logs for: [correction-scanner] window armed | window closed
journalctl -u cortex --since "5 minutes ago" | grep correction-scanner

# 8. Atom entries created by realtime-learning
atom_search field=subject query="failure:"
```

---

## 13. Integration Points & Dependencies

| System / Task                 | Integration Mechanism                  | Direction        | Failure Behavior                                                                           |
| ----------------------------- | -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| **task-003 pre-action hooks** | Observation bus `sop:violation` event  | Inbound          | Graceful degradation — logs warning, `SOP_VIOL` detection disabled until task-003 restarts |
| **task-010 trust engine**     | Observation bus `trust:demotion` event | Inbound          | Same — `TRUST_DEM` detection disabled; other types still work                              |
| **Pipeline orchestrator**     | Synapse `pipeline:stage-result` topic  | Inbound          | `PIPE_FAIL` detection disabled; other types still work                                     |
| **brain.db**                  | Direct SQLite write (three new tables) | Outbound (write) | If DB locked > 5s, propagation worker times out and logs error                             |
| **Atom system (Phase 3)**     | `atom_create` tool calls               | Outbound         | Failure logged to propagation_records; non-fatal                                           |
| **Synapse**                   | `synapse.send()` for previews/alerts   | Outbound         | Retry 3x with 1s backoff; after 3rd failure, error logged                                  |
| **git**                       | `git commit` for SOP/hook patches      | Outbound         | If git fails, propagation_records.status = 'failed'; manual commit required                |
| **hooks/patterns.ts**         | File append via write tool             | Outbound (write) | Per-file mutex prevents corruption; timeout = skip + log                                   |

**Dependency load order:** This module must be initialized **after** task-003 and task-010 modules are loaded, as it subscribes to their events. The observation bus handles this via lazy subscription — events emitted before subscription are not replayed (by design).

---

## 14. Metrics Reference

All metrics are computed from `failure_events` and `propagation_records`.

### Metric Definitions & Targets

| Metric                       | SQL                                                                                                                | Target |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| **Avg T2P**                  | `AVG((julianday(completed_at) - julianday(started_at)) * 86400) FROM propagation_records WHERE status='committed'` | ≤ 60s  |
| **Propagation completeness** | `COUNT(DISTINCT failure_id) / COUNT(*) FROM failure_events WHERE propagation_status != 'no_fix_needed'` (x100)     | ≥ 80%  |
| **Recurrence rate**          | `COUNT(*) FILTER (WHERE recurrence_count > 0) / COUNT(*) FROM failure_events` (x100)                               | ≤ 5%   |
| **Detection latency**        | Measured by `detected_at` vs tool call timestamp (stored in `context` JSON)                                        | ≤ 5s   |
| **False positive rate**      | Manual signal only — Matthew marks events as `no_fix_needed`; rate = those / total CORRECT events (x100)           | ≤ 10%  |

### Weekly Report Cadence

- **Schedule:** Every Monday at 9:00 AM local time (cron, deployed at deploy stage)
- **Delivery:** Synapse, `to='all'`, `priority='info'`, `thread_id='realtime-learning-metrics'`
- **Content:** All 5 metrics, 7-day vs 30-day comparison, top 3 root causes by frequency, top 3 root causes by recurrence

---

## 15. Rollback Plan

### Rollback scope

Real-Time Learning is additive across three axes:

1. **New brain.db tables** — dropping them is safe (no existing tables depend on them)
2. **New TypeScript modules** — removing the module directory does not affect other Cortex modules
3. **New config file** — removing `realtime-learning.json` is safe (no other config depends on it)
4. **Observation bus subscriptions** — de-registering listeners is safe (bus continues for other subscribers)

### Step-by-step rollback

```bash
# 1. Disable detection (immediate effect, no restart required)
# Edit ~/Projects/helios/config/realtime-learning.json: "enabled": false

# 2. Remove the module from Cortex's module loader
# Edit src/index.ts: comment out the realtime-learning import/register call

# 3. Restart Cortex
openclaw gateway restart

# 4. Optionally drop the brain.db tables (data loss — make sure you want this)
sqlite3 ~/Projects/helios/brain.db \
  "DROP TABLE IF EXISTS regression_tests; DROP TABLE IF EXISTS propagation_records; DROP TABLE IF EXISTS failure_events;"

# 5. Optionally remove SOP patches and hook patterns added by realtime-learning
# Check: git log --oneline --grep="realtime-learning"
# Revert individually: git revert <sha>
# Or bulk: git log --grep="realtime-learning" --pretty=format:"%H" | xargs git revert --no-commit
# Then: git commit -m "revert: roll back realtime-learning patches"
```

### Version to roll back to

Previous stable version: **cortex-v2.4.0** (task-010, earned autonomy)

```bash
cd ~/Projects/helios
git checkout cortex-v2.4.0
pnpm install
pnpm tsc --noEmit
openclaw gateway restart
```

---

## Appendix A: File Index

```
~/Projects/helios/extensions/cortex/src/realtime-learning/
├── index.ts                                    # Module entry point
├── detection/
│   ├── tool-monitor.ts                         # exec/write/gateway error capture
│   ├── correction-scanner.ts                   # Session message keyword scanner
│   ├── hook-violation-relay.ts                 # task-003 SOP violation relay
│   ├── trust-event-relay.ts                    # task-010 trust demotion relay
│   └── pipeline-fail-relay.ts                  # Pipeline fail event relay
├── classification/
│   ├── failure-classifier.ts                   # Deterministic rule-based classifier
│   └── root-cause-router.ts                    # Classifier → propagation dispatch
├── propagation/
│   ├── sop-patcher.ts                          # SOP file patching (auto + preview)
│   ├── hook-pattern-updater.ts                 # hooks/patterns.ts append-only updater
│   ├── atom-propagator.ts                      # Atom causal chain recorder
│   ├── regression-test-gen.ts                  # brain.db + .test.ts stub generator
│   └── cross-system-relay.ts                   # Cross-agent Synapse relay
├── recurrence/
│   └── recurrence-detector.ts                  # 30-day recurrence scanner + alerter
├── metrics/
│   └── metrics-emitter.ts                      # T2P/completeness/recurrence tracker
├── cli/
│   └── failure-log.ts                          # ~/bin/failure-log CLI source
└── db/
    └── schema.ts                               # brain.db migrations (3 tables)

~/Projects/helios/config/
└── realtime-learning.json                      # Configuration (correction keywords, timeouts, etc.)

~/bin/
└── failure-log                                 # Compiled CLI binary (symlinked from src)

~/Projects/helios/extensions/cortex/pipeline/task-011-realtime-learning/
├── requirements.md                             # Stage: requirements (pass)
├── design.md                                   # Stage: design (pass)
└── document.md                                 # Stage: document (this file, pass)
```

---

_Generated by Helios pipeline | task-011-realtime-learning | document stage | 2026-02-19_
