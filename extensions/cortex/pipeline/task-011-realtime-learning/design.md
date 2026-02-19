# Task-011: Real-Time Learning — Adapt Without Restart — Design

**Stage:** design | **Status:** pass
**Phase:** 5.7 of IMPROVEMENT_PLAN
**Date:** 2026-02-19
**Builds on:** task-003 (pre-action hooks), task-010 (earned autonomy/trust), task-007 (adversarial testing), task-008 (knowledge compression)

---

## 1. Architecture Overview

The Real-Time Learning system is a **reactive event pipeline** with three layers:

```
┌─────────────────────────────────────────────────────────────┐
│  DETECTION LAYER  (event sources → failure_events table)    │
│  ToolMonitor · CorrectionScanner · HookViolationRelay ·     │
│  TrustEventRelay · PipelineFailRelay                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ async queue (in-process)
┌──────────────────────────▼──────────────────────────────────┐
│  CLASSIFICATION LAYER  (rule-based root cause tagging)      │
│  FailureClassifier → RootCauseRouter                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ async queue
┌──────────────────────────▼──────────────────────────────────┐
│  PROPAGATION LAYER  (fix → commit → test → metrics)         │
│  SOPPatcher · HookPatternUpdater · AtomPropagator ·         │
│  RegressionTestGen · RecurrenceDetector · MetricsEmitter    │
└─────────────────────────────────────────────────────────────┘
```

**Key design constraint:** Every layer is async and non-blocking. The detection layer adds ≤ 2ms to any monitored path — it enqueues an event and returns. Classification and propagation run in the background.

---

## 2. File & Module Layout

```
~/Projects/helios/extensions/cortex/
├── src/
│   └── realtime-learning/
│       ├── index.ts                    # Module entry: registers listeners, exports public API
│       ├── detection/
│       │   ├── tool-monitor.ts         # Wraps exec/write/gateway for error capture
│       │   ├── correction-scanner.ts   # Scans session messages for correction signals
│       │   ├── hook-violation-relay.ts # Consumes SOP violation events from task-003
│       │   ├── trust-event-relay.ts    # Consumes trust demotion events from task-010
│       │   └── pipeline-fail-relay.ts  # Consumes pipeline fail events from orchestrator
│       ├── classification/
│       │   ├── failure-classifier.ts   # Deterministic classifier (rule-based)
│       │   └── root-cause-router.ts    # Maps failure type → propagation targets
│       ├── propagation/
│       │   ├── sop-patcher.ts          # Rewrites SOP files (Tier 1-2 auto, Tier 3 preview)
│       │   ├── hook-pattern-updater.ts # Adds/removes patterns in hooks/patterns.ts
│       │   ├── atom-propagator.ts      # Creates/updates atoms recording failure→fix chain
│       │   ├── regression-test-gen.ts  # Writes regression test entries to brain.db + files
│       │   └── cross-system-relay.ts   # Posts structured Synapse msg for cross-agent fixes
│       ├── recurrence/
│       │   └── recurrence-detector.ts  # Queries failure_events; alerts on 30-day repeats
│       ├── metrics/
│       │   └── metrics-emitter.ts      # Tracks T2P, completeness, recurrence, false-pos
│       ├── cli/
│       │   └── failure-log.ts          # ~/bin/failure-log CLI — human-readable history
│       └── db/
│           └── schema.ts               # brain.db migrations: failure_events, propagation_records, regression_tests
```

---

## 3. Data Model (brain.db additions)

### 3.1 `failure_events`

```sql
CREATE TABLE IF NOT EXISTS failure_events (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
  type         TEXT NOT NULL,   -- TOOL_ERR | CORRECT | SOP_VIOL | TRUST_DEM | PIPE_FAIL
  tier         INTEGER NOT NULL, -- 1 | 2 | 3
  source       TEXT NOT NULL,   -- tool name, message snippet, hook id, etc.
  context      TEXT NOT NULL,   -- JSON: session_id, tool_call_id, message_id, etc.
  raw_input    TEXT,            -- what Helios tried to do
  failure_desc TEXT NOT NULL,   -- human-readable description of the failure
  root_cause   TEXT,            -- populated by classifier
  propagation_status TEXT NOT NULL DEFAULT 'pending', -- pending | in_progress | propagated | escalated | no_fix_needed
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  last_recurred_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fe_type     ON failure_events(type);
CREATE INDEX IF NOT EXISTS idx_fe_tier     ON failure_events(tier);
CREATE INDEX IF NOT EXISTS idx_fe_detected ON failure_events(detected_at);
CREATE INDEX IF NOT EXISTS idx_fe_root     ON failure_events(root_cause);
```

### 3.2 `propagation_records`

```sql
CREATE TABLE IF NOT EXISTS propagation_records (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  failure_id      TEXT NOT NULL REFERENCES failure_events(id),
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  propagation_type TEXT NOT NULL, -- sop_patch | hook_update | atom_update | regression_test | synapse_relay | cross_system
  target_file     TEXT,           -- path of SOP/hook/test file modified
  commit_sha      TEXT,           -- git SHA if auto-committed
  synapse_msg_id  TEXT,           -- for Tier 3 preview messages
  preview_sent_at TEXT,
  matthew_approved INTEGER,       -- NULL = pending, 1 = approved, 0 = rejected
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | committed | previewed | approved | rejected | failed
  diff_preview    TEXT,           -- stored diff for preview messages
  error_detail    TEXT            -- if status=failed
);
CREATE INDEX IF NOT EXISTS idx_pr_failure  ON propagation_records(failure_id);
CREATE INDEX IF NOT EXISTS idx_pr_status   ON propagation_records(status);
```

### 3.3 `regression_tests`

```sql
CREATE TABLE IF NOT EXISTS regression_tests (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  failure_id   TEXT NOT NULL REFERENCES failure_events(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_run_at  TEXT,
  description  TEXT NOT NULL,   -- what scenario this tests
  test_file    TEXT,            -- path to .test.ts file if generated
  pass_count   INTEGER NOT NULL DEFAULT 0,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  last_result  TEXT,            -- pass | fail | skip
  active       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_rt_failure  ON regression_tests(failure_id);
CREATE INDEX IF NOT EXISTS idx_rt_active   ON regression_tests(active);
```

---

## 4. Detection Layer

### 4.1 Tool Monitor (`tool-monitor.ts`)

Intercepts exec/write/gateway tool outcomes. Since OpenClaw tools are external (not in-process), this monitor hooks into the **cortex observation bus** — the existing event emitter used by task-003 pre-action hooks.

```typescript
// Pseudo-code — actual hook point is the observation bus
observationBus.on("tool:result", async (event: ToolResultEvent) => {
  if (event.exitCode !== 0 || event.exception) {
    await enqueueDetection({
      type: "TOOL_ERR",
      tier: 1,
      source: event.toolName,
      context: { session_id: event.sessionId, tool_call_id: event.id },
      raw_input: event.input,
      failure_desc: `Tool ${event.toolName} failed: ${event.error ?? `exit ${event.exitCode}`}`,
    });
  }
});
```

**Budget guarantee:** `enqueueDetection()` pushes to an in-memory `AsyncQueue` and returns synchronously. The queue drain loop runs on `setImmediate` — never blocks the hot path.

### 4.2 Correction Scanner (`correction-scanner.ts`)

Monitors session messages for correction signals within a 5-minute sliding window after any tool call.

**Correction keywords** (configurable in `~/Projects/helios/config/realtime-learning.json`):

```
wrong path, that's wrong, bad command, use X instead, outdated SOP,
stale SOP, that hook is wrong, wrong binary, incorrect, no that's not right,
should be, use this instead, stop doing that, that's broken
```

**Logic:**

1. After each tool call, arm the scanner with a 5-minute window
2. If a session message arrives containing ≥1 correction keyword AND the Levenshtein proximity to the last tool call output is ≥ 0.3, emit a `CORRECT` failure event
3. Include the correction message text as `failure_desc`, the tool call as `context`

**False positive guard:** Messages that contain correction keywords but are part of a code block or quoted text are excluded (pattern: lines starting with ` ``` ` or `>` are stripped before keyword scan).

### 4.3 Hook Violation Relay (`hook-violation-relay.ts`)

Task-003 already emits `sop:violation` events when a hook fires but the SOP rule was flagged stale. This relay subscribes to that event and repackages it as a `SOP_VIOL` failure event.

```typescript
observationBus.on("sop:violation", async (event: SopViolationEvent) => {
  await enqueueDetection({
    type: "SOP_VIOL",
    tier: 2,
    source: event.hookId,
    context: { sop_file: event.sopFile, rule_id: event.ruleId },
    failure_desc: `SOP ${event.sopFile} rule "${event.ruleId}" fired but flagged stale`,
  });
});
```

### 4.4 Trust Event Relay (`trust-event-relay.ts`)

Task-010 emits `trust:demotion` events on `corrected_significant`. This relay converts those to `TRUST_DEM` failure events.

```typescript
observationBus.on("trust:demotion", async (event: TrustDemotionEvent) => {
  await enqueueDetection({
    type: "TRUST_DEM",
    tier: 3,
    source: "task-010-trust-engine",
    context: { milestone: event.milestone, prior_tier: event.priorTier },
    failure_desc: `Trust demotion: ${event.reason}`,
  });
});
```

### 4.5 Pipeline Fail Relay (`pipeline-fail-relay.ts`)

Pipeline stage results with `result=fail|blocked` are routed through Synapse. This relay subscribes to the local Synapse topic `pipeline:stage-result` for failure events.

---

## 5. Classification Layer

### 5.1 Failure Classifier (`failure-classifier.ts`)

Rule-based, deterministic. No LLM in the hot path.

```typescript
interface ClassificationRule {
  type: FailureType;
  rootCausePattern: RegExp | string[];
  rootCauseLabel: string;
  propagationTargets: PropagationTarget[];
}

const RULES: ClassificationRule[] = [
  {
    type: "TOOL_ERR",
    rootCausePattern: /ENOENT|not found|No such file/,
    rootCauseLabel: "wrong_path",
    propagationTargets: ["hook_pattern", "atom"],
  },
  {
    type: "TOOL_ERR",
    rootCausePattern: /permission denied|EACCES/i,
    rootCauseLabel: "permissions",
    propagationTargets: ["sop_patch", "atom"],
  },
  {
    type: "TOOL_ERR",
    rootCausePattern: /command not found|not a valid command/i,
    rootCauseLabel: "missing_binary",
    propagationTargets: ["sop_patch", "hook_pattern", "atom"],
  },
  {
    type: "CORRECT",
    rootCausePattern: /wrong path|incorrect path/i,
    rootCauseLabel: "wrong_path",
    propagationTargets: ["sop_patch", "atom"],
  },
  {
    type: "CORRECT",
    rootCausePattern: /outdated SOP|stale SOP|that SOP/i,
    rootCauseLabel: "stale_sop",
    propagationTargets: ["sop_patch", "regression_test"],
  },
  {
    type: "SOP_VIOL",
    rootCauseLabel: "stale_sop_rule",
    propagationTargets: ["sop_patch", "hook_pattern", "atom"],
  },
  {
    type: "TRUST_DEM",
    rootCauseLabel: "trust_boundary_crossed",
    propagationTargets: ["sop_patch", "regression_test", "atom"],
  },
  {
    type: "PIPE_FAIL",
    rootCauseLabel: "pipeline_stage_failure",
    propagationTargets: ["regression_test", "synapse_relay"],
  },
];
```

**Fallback:** If no rule matches, `root_cause = 'unknown'` and `propagation_targets = ['synapse_relay']` — posts a Synapse message asking Matthew to classify.

### 5.2 Root Cause Router (`root-cause-router.ts`)

Takes the classified event + propagation targets array and dispatches to the appropriate propagation workers. Each worker receives the full `FailureEvent` plus a `PropagationContext`.

---

## 6. Propagation Layer

### 6.1 SOP Patcher (`sop-patcher.ts`)

**For Tier 1-2 failures** (TOOL_ERR, CORRECT, SOP_VIOL with `root_cause` != `unknown`):

1. Locate the relevant SOP file using the `context.sop_file` field or by scanning `~/Projects/helios/sops/` for keyword matches against the failure description
2. For **additive changes** (adding a new "avoid this" rule or updating a path): auto-commit
3. For **modifying existing rules**: generate a diff, post to Synapse for preview (Tier 3 escalation path)
4. All commits: `git commit -m "fix(sop): auto-patch from failure ${failureId} [realtime-learning]"`

```typescript
async function patchSOP(failure: FailureEvent, sopPath: string): Promise<PropagationRecord> {
  const existing = await readFile(sopPath, "utf8");
  const patch = generatePatch(failure, existing); // deterministic rule-based patch

  if (patch.type === "additive") {
    await writeFile(sopPath, patch.result);
    const sha = await gitCommit(sopPath, failure.id);
    return { status: "committed", commit_sha: sha, target_file: sopPath };
  } else {
    // Tier 3 escalation — preview required
    const msgId = await postPreviewToSynapse(failure, patch.diff, sopPath);
    return {
      status: "previewed",
      synapse_msg_id: msgId,
      diff_preview: patch.diff,
      target_file: sopPath,
    };
  }
}
```

**SOP patch generation rules:**

- `wrong_path`: append a "Correct path: X" entry to the relevant SOP section
- `stale_sop`: append a "Updated [date]: Rule X changed to Y" entry
- `missing_binary`: append an "Ensure binary X is installed at path Y" entry
- `trust_boundary_crossed`: append the specific action Helios took that crossed the boundary

### 6.2 Hook Pattern Updater (`hook-pattern-updater.ts`)

Adds a new deny pattern to `hooks/patterns.ts` when a tool error traces to a repeated bad input pattern.

**Safety:** Pattern additions are always additive (never remove patterns). Additive = auto-committed. Review is only required if a pattern modification is attempted (rare — patterns are append-only).

### 6.3 Atom Propagator (`atom-propagator.ts`)

For every propagated failure, creates an atom documenting the causal chain:

```typescript
await atom_create({
  subject: `failure:${failure.type}:${failure.id}`,
  action: `triggered by ${failure.root_cause} in session ${failure.context.session_id}`,
  outcome: `propagated to ${propagationTargets.join(", ")}`,
  consequences: `regression test created; SOP patched; recurrence detection armed`,
});
```

This ensures the causal graph tracks which failures led to which fixes — enabling `atom_find_causes` to trace recurring issues to their root.

### 6.4 Regression Test Generator (`regression-test-gen.ts`)

For TRUST_DEM and PIPE_FAIL events, generates a regression test entry:

1. Insert into `regression_tests` in brain.db
2. Create a `.test.ts` stub in `src/realtime-learning/__tests__/regression/` with:
   - Test name: `"regression: ${failure.type} — ${failure.root_cause} (${failure.id})"`
   - Test body: reproduce the failure condition (tool invocation or SOP lookup that caused it)
   - Expected: the patched behavior succeeds

```typescript
// Generated regression test stub
describe("regression: ${failureType} — ${rootCause}", () => {
  it("should not recur after propagation (failure ${failureId})", async () => {
    // Reproduce the original failure context
    // Assert the patched SOP/hook/atom prevents recurrence
  });
});
```

### 6.5 Cross-System Relay (`cross-system-relay.ts`)

For failures with infrastructure root causes traced from AUGUR or other agent domains:

```typescript
await synapse.send({
  to: "all",
  thread_id: `cross-system:${failure.id}`,
  subject: `Cross-system propagation needed: ${failure.root_cause}`,
  body: JSON.stringify({
    failure_id: failure.id,
    source_domain: failure.context.domain,
    root_cause: failure.root_cause,
    recommended_fix: patch.description,
    target_sop: targetSop,
    requires_action: true,
  }),
  priority: "action",
});
```

---

## 7. Recurrence Detector (`recurrence-detector.ts`)

Runs as a lightweight background check after every propagation record is committed:

```typescript
async function checkRecurrence(failure: FailureEvent): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const priorOccurrences = await db.all(
    `
    SELECT id, detected_at, propagation_status 
    FROM failure_events
    WHERE root_cause = ? 
      AND id != ?
      AND detected_at > ?
    ORDER BY detected_at DESC
  `,
    [failure.root_cause, failure.id, thirtyDaysAgo],
  );

  if (priorOccurrences.length > 0) {
    // Same root cause recurred within 30 days — escalate
    await db.run(
      `
      UPDATE failure_events SET recurrence_count = recurrence_count + 1, last_recurred_at = ?
      WHERE id = ?
    `,
      [new Date().toISOString(), failure.id],
    );

    await synapse.send({
      to: "all",
      thread_id: `recurrence:${failure.root_cause}`,
      subject: `⚠️ Recurrence detected: ${failure.root_cause}`,
      body: `Failure pattern "${failure.root_cause}" re-fired. Prior occurrence: ${priorOccurrences[0].id} (${priorOccurrences[0].detected_at}). Propagation from that event: ${priorOccurrences[0].propagation_status}. Manual review needed.`,
      priority: "urgent",
    });
  }
}
```

---

## 8. Metrics Emitter (`metrics-emitter.ts`)

Tracks the five metrics defined in requirements. Stored in brain.db `propagation_records` (computable from existing columns — no separate metrics table needed).

**Computed metrics (via SQL):**

```sql
-- Time-to-propagation (T2P) average
SELECT AVG((julianday(completed_at) - julianday(started_at)) * 86400) as avg_t2p_seconds
FROM propagation_records WHERE status = 'committed';

-- Propagation completeness
SELECT
  CAST(COUNT(DISTINCT failure_id) AS REAL) /
  (SELECT COUNT(*) FROM failure_events WHERE propagation_status != 'no_fix_needed')
  * 100 as completeness_pct
FROM propagation_records WHERE status = 'committed';

-- Recurrence rate
SELECT
  CAST(COUNT(*) FILTER (WHERE recurrence_count > 0) AS REAL) / COUNT(*) * 100 as recurrence_rate
FROM failure_events;
```

**Weekly report:** A cron job (added in deploy stage) emits a weekly Synapse summary of all five metrics.

---

## 9. CLI: `~/bin/failure-log`

Human-readable failure history with propagation status.

```
$ failure-log
┌─────────────────────────────────────────────────────────────────────────┐
│ HELIOS FAILURE LOG — last 7 days                                        │
├──────────┬──────────┬────────────────────────────────┬──────────────────┤
│ ID       │ Type     │ Description                    │ Status           │
├──────────┼──────────┼────────────────────────────────┼──────────────────┤
│ a1b2c3d4 │ TOOL_ERR │ exec: ENOENT ~/bin/wrong-path  │ ✅ committed     │
│ e5f6a7b8 │ CORRECT  │ "use pnpm not npm"              │ ⏳ previewed     │
│ c9d0e1f2 │ TRUST_DEM│ overstepped on config write    │ 🔔 escalated     │
└──────────┴──────────┴────────────────────────────────┴──────────────────┘

$ failure-log --id a1b2c3d4
[details: failure event + propagation records for that ID]
```

**Options:** `--days N`, `--type TOOL_ERR|CORRECT|SOP_VIOL|TRUST_DEM|PIPE_FAIL`, `--status pending|committed|escalated`, `--id <id>`

---

## 10. Configuration (`~/Projects/helios/config/realtime-learning.json`)

```json
{
  "correction_keywords": [
    "wrong path",
    "that's wrong",
    "bad command",
    "use X instead",
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
  "weekly_metrics_hour": 9
}
```

---

## 11. Integration Points

| Upstream System           | Integration Type                               | Dependency Risk        |
| ------------------------- | ---------------------------------------------- | ---------------------- |
| task-003 pre-action hooks | Event bus subscription (`sop:violation`)       | Low — existing bus     |
| task-010 trust engine     | Event bus subscription (`trust:demotion`)      | Low — existing bus     |
| Pipeline orchestrator     | Synapse subscription (`pipeline:stage-result`) | Low — existing Synapse |
| brain.db                  | New tables via migration (schema.ts)           | Low — additive         |
| Atom system (Phase 3)     | atom_create calls (existing tool)              | None                   |
| Synapse                   | Messaging for previews/alerts                  | None                   |
| git                       | Auto-commits for SOP patches                   | Low — localized        |

---

## 12. Testing Strategy

### Unit Tests

- `FailureClassifier`: test all 5 failure types × multiple sub-patterns → correct root cause label
- `CorrectionScanner`: test keyword detection, false positive rejection (code blocks, quotes)
- `SOPPatcher`: test additive vs modifying detection, diff generation
- `RecurrenceDetector`: test 30-day window, escalation trigger

### Integration Tests

- Full pipeline: inject a mock tool error → verify failure event → classification → SOP patch → committed
- Tier 3 preview: inject a mock TRUST_DEM → verify Synapse preview message → simulate approval → verify commit
- Recurrence: inject same root cause twice within 30 days → verify escalation Synapse message

### Regression Tests (auto-generated on deployment)

- None initially — the system generates these as failures occur in production

---

## 13. Build Stages Required

| Stage    | Work                                                             |
| -------- | ---------------------------------------------------------------- |
| document | API docs, configuration reference, brain.db schema docs          |
| build    | All TypeScript modules, DB migrations, CLI, integration with bus |
| security | Audit: auto-commit controls, Tier 3 preview bypass prevention    |
| test     | Unit + integration tests, 45/45 baseline + new tests             |
| deploy   | Run migrations, register bus listeners, add weekly metrics cron  |

---

## 14. Risks & Mitigations

| Risk                                              | Mitigation                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Correction scanner false positives pollute log    | Proximity threshold + code-block exclusion + Matthew feedback loop |
| SOP auto-patch produces incorrect rule            | Additive-only auto-commit; modifying changes require preview       |
| Detection bus overhead degrades performance       | Async queue + benchmarked ≤2ms budget                              |
| Missing bus events if task-003/010 not loaded     | Graceful degradation: module logs warning but doesn't crash        |
| Git commit collisions on rapid concurrent patches | Per-file mutex (one patch operation per SOP file at a time)        |
| Brain.db migration failure on deploy              | Migration is idempotent — safe to re-run; schema.ts guards         |
