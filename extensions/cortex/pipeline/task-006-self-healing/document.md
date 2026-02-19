# Self-Healing Infrastructure: Documentation

**Task ID:** task-006-self-healing  
**Stage:** document  
**Author:** Documentation Specialist (Pipeline Orchestrator)  
**Date:** 2026-02-18  
**Cortex Target Version:** 2.2.0  
**Depends On:** Cortex v2.1.0 (predictive intent), v2.0.0 (session persistence), v1.5.0 (pre-action hooks), v1.3.0 (metrics)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture Summary](#2-architecture-summary)
3. [API Reference — `cortex_heal` Tool](#3-api-reference--cortex_heal-tool)
4. [Configuration Reference](#4-configuration-reference)
5. [Anomaly Type Reference](#5-anomaly-type-reference)
6. [Runbook Reference](#6-runbook-reference)
7. [Incident Lifecycle Reference](#7-incident-lifecycle-reference)
8. [Escalation Tier Reference](#8-escalation-tier-reference)
9. [Health Probe Reference](#9-health-probe-reference)
10. [brain.db Schema Additions](#10-braindb-schema-additions)
11. [Metrics Reference](#11-metrics-reference)
12. [Incident-to-Runbook Learning](#12-incident-to-runbook-learning)
13. [Behavioral Signatures (Version Forensics)](#13-behavioral-signatures-version-forensics)
14. [Failure Mode Signatures](#14-failure-mode-signatures)
15. [Debugging Hooks](#15-debugging-hooks)
16. [Migration Notes (v2.1.0 → v2.2.0)](#16-migration-notes-v210--v220)
17. [Rollback Plan](#17-rollback-plan)
18. [Searchable Feature Index](#18-searchable-feature-index)

---

## 1. Overview

Self-Healing Infrastructure is the autonomous remediation layer of Cortex v2.2.0. It transforms Helios from a system that _detects_ anomalies into one that _resolves_ them — silently when safe, via Synapse when Matthew should know, and via Signal only when his decision is genuinely required.

### What It Does

- **Continuously monitors** 10 targets: AUGUR processes, signal staleness, pipeline state, fleet hosts, disk usage, RAM, brain.db integrity, log bloat, OpenClaw gateway, and phantom positions
- **Classifies 13 anomaly types** from both shared PollingEngine readings (reusing v2.1.0 data) and 6 supplemental healing probes
- **Manages incident lifecycle** — one incident per unique `(anomaly_type, target_id)` pair; full state machine from `detected` → `resolved`; complete audit trail in brain.db
- **Executes runbooks** step-by-step with atomicity, timeout enforcement, pre-execution re-verification, and post-execution proof
- **Routes escalations** across 4 tiers: silent metric (tier 0), Synapse info (tier 1), Synapse approval request (tier 2), Signal alert (tier 3)
- **Learns from Matthew's fixes**: `cortex_heal record_fix` captures manual remediation as draft runbooks, which graduate to auto-execute after approval or 3 verified dry-runs
- **Integrates non-intrusively** with the existing PollingEngine via a single `onReading` callback subscription — zero polling duplication

### What It Does NOT Do

- Generate new anomaly detection logic outside the 13 defined types (v2.2.0 scope only)
- Execute dynamically-constructed shell commands — all runbook steps use statically-defined command templates
- Auto-execute remediation against fleet-remote hosts (SSH probe fires an alert, not an exec)
- Auto-heal brain.db corruption during an active write session (BCDR handles that; this feature halts writes and alerts)
- Replace or modify the predictive intent PollingEngine (only subscribes to its output)

### Version Forensics Tag

`cortex-v2.2.0` | `feature/self-healing-v2.2.0` | Phase 5.2 of IMPROVEMENT_PLAN

---

## 2. Architecture Summary

```
PollingEngine (v2.1.0 — 10 adapters, staggered timers)
    │
    │  onReading(callback) — new additive hook, zero breaking change
    ▼
HealingEngine (healing/index.ts)
    │
    ├── AnomalyClassifier ──────── maps SourceReading → HealthAnomaly[]
    │       (reads shared data from PollingEngine adapters)
    │
    ├── HealingProbeRegistry ───── runs 6 supplemental probes (own timers)
    │       augur-process (60s), gateway (120s), brain-db (900s)
    │       disk (600s), memory (300s), log-bloat (1800s)
    │
    ├── IncidentManager ────────── full lifecycle state machine + brain.db
    │       upsertIncident → diagnose → remediate → verify → resolve
    │       unique per (anomaly_type, target_id), dedup on re-detection
    │
    ├── RunbookRegistry ────────── 12 built-in runbooks + brain.db persistence
    │       dry_run mode (default) | auto_execute (whitelisted or approved)
    │       graduation: 3 consecutive dry-run verifications → auto-execute
    │
    ├── RunbookExecutor ────────── step-by-step execution
    │       1. re-probe before acting (self-resolve if clear)
    │       2. execute steps atomically with timeout enforcement
    │       3. wait 30s, re-probe for verification
    │       4. escalate on verification failure
    │
    └── EscalationRouter ───────── tier 0–3 routing
            0: metric only (silent)
            1: Synapse info (action taken)
            2: Synapse action-required (approval needed)
            3: Signal + Synapse (tier-3 always reaches Matthew)

brain.db
    ├── incidents (new table) — full audit trail per incident
    └── runbooks (new table)  — mode, confidence, dry_run_count, approval
```

**Key architectural principles:**

- The HealingEngine is **event-driven**, not polling-driven — it reacts to PollingEngine output
- Supplemental probes run only for anomaly types that have no PollingEngine adapter
- No data is fetched twice — predictive intent adapters share readings via the `onReading` subscription

---

## 3. API Reference — `cortex_heal` Tool

The `cortex_heal` tool is registered as an OpenClaw plugin tool in `cortex/index.ts`. All 7 actions are available immediately after `cortex gateway restart` with v2.2.0 deployed.

### 3.1 `status` — View Open Incidents

Returns all active incidents with their current state and remediation progress.

**Parameters:** none

**Example:**

```json
{ "action": "status" }
```

**Response:**

```json
{
  "open_incidents": [
    {
      "id": "inc-abc123",
      "anomaly_type": "disk_pressure",
      "target_id": "disk:/",
      "severity": "high",
      "state": "verifying",
      "runbook_id": "rb-rotate-logs",
      "detected_at": "2026-02-18T18:00:00-05:00",
      "state_changed_at": "2026-02-18T18:01:30-05:00",
      "escalation_tier": 1,
      "audit_trail": [
        { "timestamp": "...", "state": "detected", "actor": "system", "note": "Disk / at 87%" },
        {
          "timestamp": "...",
          "state": "remediating",
          "actor": "system",
          "note": "Executing rb-rotate-logs"
        },
        {
          "timestamp": "...",
          "state": "verifying",
          "actor": "system",
          "note": "Waiting 30s for re-probe"
        }
      ]
    }
  ],
  "runbook_summary": {
    "total": 12,
    "auto_execute": 2,
    "dry_run": 10
  }
}
```

---

### 3.2 `list_runbooks` — Inspect Runbook Registry

Returns all registered runbooks with their mode, confidence, last-used timestamps, and dry-run counts.

**Parameters:** none

**Example:**

```json
{ "action": "list_runbooks" }
```

**Response:**

```json
{
  "runbooks": [
    {
      "id": "rb-rotate-logs",
      "label": "Rotate Log Files",
      "applies_to": ["disk_pressure", "log_bloat"],
      "mode": "auto_execute",
      "confidence": 0.95,
      "dry_run_count": 0,
      "auto_approve_whitelist": true,
      "last_executed_at": "2026-02-18T17:45:00-05:00",
      "last_succeeded_at": "2026-02-18T17:45:02-05:00",
      "approved_at": null
    },
    {
      "id": "rb-restart-service",
      "label": "Restart Service",
      "applies_to": ["process_dead"],
      "mode": "dry_run",
      "confidence": 0.75,
      "dry_run_count": 1,
      "auto_approve_whitelist": false,
      "last_executed_at": null,
      "approved_at": null
    }
  ]
}
```

---

### 3.3 `approve` — Graduate Runbook to Auto-Execute

Approves a runbook for automatic execution. Transitions `mode: 'dry_run'` → `mode: 'auto_execute'`. Requires the runbook to not be whitelisted (whitelisted runbooks are already auto-execute).

**Parameters:**
| Field | Type | Required | Description |
|---|---|---|---|
| `runbook_id` | string | ✅ | ID of the runbook to approve (e.g. `rb-restart-service`) |

**Example:**

```json
{ "action": "approve", "runbook_id": "rb-restart-service" }
```

**Response:**

```json
{
  "success": true,
  "runbook_id": "rb-restart-service",
  "mode": "auto_execute",
  "approved_at": "2026-02-18T18:05:00-05:00"
}
```

**Note:** After approval, the runbook will execute automatically on next matching anomaly detection if confidence ≥ 0.8.

---

### 3.4 `dry_run` — Preview Runbook Steps

Executes a runbook in dry-run mode against a target — no system state is modified. Returns a human-readable description of each step and what it would do.

**Parameters:**
| Field | Type | Required | Description |
|---|---|---|---|
| `runbook_id` | string | ✅ | Runbook to preview |
| `target_id` | string | ✅ | Target to preview against (e.g. `disk:/`, `augur-executor`) |

**Example:**

```json
{ "action": "dry_run", "runbook_id": "rb-rotate-logs", "target_id": "disk:/" }
```

**Response:**

```json
{
  "runbook_id": "rb-rotate-logs",
  "target_id": "disk:/",
  "mode": "dry_run",
  "steps": [
    {
      "step_id": "find_old_logs",
      "description": "Would find 14 log files older than 7 days in ~/.openclaw/logs/ totaling 2.3GB"
    },
    {
      "step_id": "gzip_and_move",
      "description": "Would gzip and move 14 files to ~/.openclaw/logs/.archive/"
    },
    {
      "step_id": "verify_disk_delta",
      "description": "Would verify disk usage drops below 85% threshold"
    }
  ],
  "estimated_impact": "~2.3GB freed on disk:/"
}
```

---

### 3.5 `execute` — Force-Execute a Runbook

Force-executes a runbook for a given target, bypassing normal anomaly-triggered flow. **Requires `confirm: true` to prevent accidental execution.**

**Parameters:**
| Field | Type | Required | Description |
|---|---|---|---|
| `runbook_id` | string | ✅ | Runbook to execute |
| `target_id` | string | ✅ | Target to execute against |
| `confirm` | boolean | ✅ | Must be `true` — safety gate |

**Example:**

```json
{ "action": "execute", "runbook_id": "rb-rotate-logs", "target_id": "disk:/", "confirm": true }
```

**Without `confirm: true`:**

```json
{ "error": "Safety check: must pass confirm=true to force-execute a runbook" }
```

**Response:**

```json
{
  "success": true,
  "mode": "auto_execute",
  "steps_executed": [
    {
      "step_id": "find_old_logs",
      "status": "success",
      "output": "Found 14 files (2.3GB)",
      "duration_ms": 340
    },
    {
      "step_id": "gzip_and_move",
      "status": "success",
      "output": "Moved 14 files to .archive/",
      "duration_ms": 8200
    },
    {
      "step_id": "verify_disk_delta",
      "status": "success",
      "output": "Disk: 87% → 71%",
      "duration_ms": 120
    }
  ],
  "verification_passed": true
}
```

---

### 3.6 `record_fix` — Capture Manual Remediation

When Matthew manually fixes an issue, call `record_fix` to capture what was done and generate a draft runbook for future automation. The system looks up any open incident matching the affected service and links the fix.

**Parameters:**
| Field | Type | Required | Description |
|---|---|---|---|
| `incident_id` | string | ✅ | Open incident this fix resolves |
| `description` | string | ✅ | Plain-language description of what was done (becomes runbook basis) |

**Example:**

```json
{
  "action": "record_fix",
  "incident_id": "inc-abc123",
  "description": "Ran pm2 restart augur-executor and verified PID appeared within 10s"
}
```

**Response:**

```json
{
  "success": true,
  "incident_id": "inc-abc123",
  "incident_resolved": true,
  "draft_runbook_id": "rb-matthew-fix-7f3a2b",
  "draft_runbook_mode": "dry_run",
  "synapse_message_sent": true,
  "next_step": "Review with cortex_heal dry_run, then approve with cortex_heal approve"
}
```

---

### 3.7 `dismiss` — Suppress an Incident

Dismisses an open incident with a reason. The same `(anomaly_type, target_id)` pair will not re-alert for 24 hours (configurable via `incident_dismiss_window_ms`).

**Parameters:**
| Field | Type | Required | Description |
|---|---|---|---|
| `incident_id` | string | ✅ | Incident to dismiss |
| `reason` | string | ✅ | Why it's being dismissed (written to audit trail) |

**Example:**

```json
{ "action": "dismiss", "incident_id": "inc-abc123", "reason": "Expected maintenance window" }
```

**Response:**

```json
{
  "success": true,
  "incident_id": "inc-abc123",
  "dismiss_until": "2026-02-19T18:10:00-05:00"
}
```

---

## 4. Configuration Reference

Self-healing is configured in the Cortex plugin config under `self_healing`. Add or modify these settings via `gateway config.patch`:

```yaml
# cortex plugin config (excerpt)
self_healing:
  enabled: true # Master switch
  tier3_signal_channel: signal # Channel for critical tier-3 alerts
  confidence_auto_execute: 0.8 # Min confidence for tier-0 execution
  dry_run_graduation_count: 3 # Consecutive dry-run passes before auto-graduate
  verification_interval_ms: 30000 # 30s — wait before re-probe after remediation
  min_clear_readings: 3 # Consecutive clear probes to mark anomaly resolved
  incident_dismiss_window_ms: 86400000 # 24h — suppress re-alert after dismiss

  auto_execute_whitelist:
    - rb-rotate-logs # Log rotation (always safe)
    - rb-gc-trigger # Memory notification only (never destructive)

  probe_intervals_ms:
    augur_process: 60000 # 60s
    gateway: 120000 # 2 min
    brain_db: 900000 # 15 min
    disk: 600000 # 10 min
    memory: 300000 # 5 min
    log_bloat: 1800000 # 30 min

  debug: false # Verbose healing engine logs
```

**Notes:**

- All probe intervals are independent of the PollingEngine — they fire on their own timers
- `confidence_auto_execute` applies only to runbooks NOT on the `auto_execute_whitelist`; whitelisted runbooks always execute regardless of confidence
- Setting `enabled: false` disables the entire HealingEngine including supplemental probes; the PollingEngine continues unaffected
- `debug: true` logs every `onReading` callback, every classification result, and every escalation decision — useful for diagnosing false positives

---

## 5. Anomaly Type Reference

### 5.1 Complete Anomaly Type Table

| Anomaly Type           | Severity | Detection Source                  | Trigger Condition                                                    |
| ---------------------- | -------- | --------------------------------- | -------------------------------------------------------------------- |
| `process_dead`         | critical | `heal.augur_process` probe        | Expected PID absent from process table                               |
| `process_zombie`       | high     | `heal.augur_process` probe        | Process in Z state, parent not reaping                               |
| `signal_stale`         | high     | `augur.signals` adapter (shared)  | `live_signal.json` not updated > 5 min while AUGUR should be running |
| `phantom_position`     | high     | `augur.signals` adapter (shared)  | Open position in trades DB without a corresponding live signal       |
| `pipeline_stuck`       | high     | `pipeline.state` adapter (shared) | Task in same stage > 60 min with no Synapse message                  |
| `fleet_unreachable`    | high     | `fleet.health` adapter (shared)   | SSH probe timeout for a known host                                   |
| `disk_pressure`        | high     | `heal.disk` probe                 | Disk usage > 85% and ≤ 95%                                           |
| `disk_critical`        | critical | `heal.disk` probe                 | Disk usage > 95%                                                     |
| `memory_pressure`      | medium   | `heal.memory` probe               | Available RAM < 512MB and > 256MB                                    |
| `memory_critical`      | critical | `heal.memory` probe               | Available RAM ≤ 256MB                                                |
| `db_corruption`        | critical | `heal.brain_db` probe             | SQLite `PRAGMA integrity_check` returns errors                       |
| `log_bloat`            | medium   | `heal.log_bloat` probe            | Any log file > 100MB without rotation                                |
| `gateway_unresponsive` | critical | `heal.gateway` probe              | `openclaw gateway status` fails 2 consecutive times                  |

### 5.2 Shared vs. Supplemental Anomaly Detection

**Shared** anomaly types reuse data already collected by the v2.1.0 PollingEngine — no additional polling:

- `signal_stale`, `phantom_position` — from `augur-signals-adapter.ts`
- `fleet_unreachable` — from `fleet-adapter.ts`
- `pipeline_stuck` — from `pipeline-adapter.ts`

**Supplemental** anomaly types require the HealingProbeRegistry's dedicated probes:

- All others: `process_dead`, `process_zombie`, `disk_pressure/critical`, `memory_pressure/critical`, `db_corruption`, `log_bloat`, `gateway_unresponsive`

---

## 6. Runbook Reference

### 6.1 Built-In Runbooks

All 12 runbooks ship with v2.2.0. Default mode is `dry_run` unless marked **whitelisted** (auto-execute).

| Runbook ID             | Label                   | Anomaly Types                | Mode                | Notes                                                 |
| ---------------------- | ----------------------- | ---------------------------- | ------------------- | ----------------------------------------------------- |
| `rb-restart-service`   | Restart Service         | `process_dead`               | dry_run             | Requires approval — uses SERVICE_MAP (hardcoded)      |
| `rb-kill-zombie`       | Kill Zombie Process     | `process_zombie`             | dry_run             | SIGKILL + parent PID audit log                        |
| `rb-restart-augur`     | Restart AUGUR Executor  | `signal_stale`               | dry_run             | Kill executor + restart; verify signal freshens       |
| `rb-clear-phantom`     | Clear Phantom Position  | `phantom_position`           | dry_run             | Marks position `closed` in trades DB + Synapse alert  |
| `rb-kick-pipeline`     | Kick Stuck Pipeline     | `pipeline_stuck`             | dry_run             | Calls `pipeline-stage-done --blocked`; Synapse alert  |
| `rb-probe-then-alert`  | Probe Then Alert        | `fleet_unreachable`          | dry_run             | 3 retries @ 30s; Synapse alert if still down          |
| `rb-rotate-logs`       | Rotate Log Files        | `disk_pressure`, `log_bloat` | **auto_execute** ✅ | Whitelisted — safe; gzip logs > 7 days to `.archive/` |
| `rb-emergency-cleanup` | Emergency Disk Cleanup  | `disk_critical`              | dry_run             | Log rotate + pycache/tmp prune + Signal tier-3        |
| `rb-gc-trigger`        | GC Notification         | `memory_pressure`            | **auto_execute** ✅ | Whitelisted — notify only, no destructive action      |
| `rb-force-gc`          | Force GC / Kill Process | `memory_critical`            | dry_run             | Kill highest non-critical process + Signal tier-3     |
| `rb-db-emergency`      | DB Emergency            | `db_corruption`              | dry_run             | Halt writes + backup brain.db + Signal tier-3         |
| `rb-gateway-restart`   | Restart Gateway         | `gateway_unresponsive`       | dry_run             | `openclaw gateway restart`; verify within 30s         |

### 6.2 Runbook Modes

**`dry_run` mode**: The runbook executes `step.dry_run()` for each step, which returns a human-readable description of what it would do. No system state is modified. Dry-runs are logged to brain.db and count toward graduation.

**`auto_execute` mode**: The runbook executes fully. Each step's `execute()` method runs with the configured `timeout_ms`. Failures trigger escalation rather than crashing the engine.

### 6.3 Service Map for `rb-restart-service`

`rb-restart-service` uses a hardcoded `SERVICE_MAP` — no dynamic command construction:

| Target ID        | Start Command                                              | PID Verification          |
| ---------------- | ---------------------------------------------------------- | ------------------------- |
| `augur-executor` | `pm2 restart augur-executor` (falls back to direct Python) | `/tmp/augur-executor.pid` |
| `signal-cli`     | `systemctl --user restart signal-cli.service`              | process name match        |

New services can be added to `SERVICE_MAP` in `runbooks/rb-restart-service.ts` and require a code change + deployment — this is intentional for safety.

### 6.4 Runbook Step Atomicity and Safety

Every `RunbookStep` implements:

- `dry_run(): Promise<string>` — describe the action without modifying state
- `execute(context: RunbookContext): Promise<RunbookStepResult>` — perform the action atomically
- `timeout_ms` — maximum allowed execution time (default: 30s per step)

**Safety invariant**: Steps MUST NOT construct shell commands dynamically from `anomaly.details`. All commands must be statically-defined strings or template literals with validated interpolation only (e.g., hardcoded paths from a predefined map).

---

## 7. Incident Lifecycle Reference

### 7.1 State Machine

```
detected
    │
    ├─▶ self_resolved   (anomaly cleared before remediation — no action taken)
    │
    ├─▶ dismissed       (Matthew dismissed it — suppressed for 24h)
    │
    ▼
diagnosing
    │
    ▼
remediating
    │
    ├─▶ remediation_failed ──▶ escalated
    │
    ▼
verifying
    │
    ├─▶ escalated       (re-probe fails — runbook didn't fix it)
    │
    ▼
resolved
```

### 7.2 Key Invariants

- **Uniqueness**: Only one non-terminal incident per `(anomaly_type, target_id)`. Re-detection refreshes `detected_at` and appends an audit entry — it does NOT create a duplicate incident.
- **Dismiss suppression**: If dismissed, the same `(anomaly_type, target_id)` produces no new incident until `dismiss_until` has elapsed.
- **Pre-execution re-probe**: Before any runbook step executes, the health probe fires again. If the anomaly has cleared → incident transitions to `self_resolved`; runbook does not execute.
- **Verification**: After remediation completes, the system waits `verification_interval_ms` (30s), then re-probes. Three consecutive clear readings are required to mark the incident `resolved`.
- **Audit trail**: Every state transition, every runbook step result, and every escalation is appended to `incidents.audit_trail` (JSON column in brain.db).

### 7.3 Escalation on Failure

If a runbook step fails (timeout, non-zero exit, or exception), the incident transitions:

```
remediating → remediation_failed → escalated
```

The EscalationRouter fires at the appropriate tier based on runbook mode and anomaly severity. The engine then resumes monitoring — the incident stays open.

---

## 8. Escalation Tier Reference

| Tier | Condition                                                                           | Action                              | Channels              |
| ---- | ----------------------------------------------------------------------------------- | ----------------------------------- | --------------------- |
| 0    | Auto-execute, confidence ≥ 0.8, whitelisted or approved                             | Execute silently; write metric only | brain.db metrics only |
| 1    | Runbook executed; action taken; result nominal                                      | Synapse info message with summary   | Synapse               |
| 2    | Runbook exists; confidence < 0.8; needs approval before execution                   | Synapse action-required message     | Synapse               |
| 3    | No runbook, remediation failed, `critical` severity, or Matthew's decision required | Synapse + Signal                    | Synapse + Signal      |

### 8.1 Tier-3 Signal Message Format

Tier-3 always produces a Signal notification. Format (plain language per NFR-003):

```
🚨 Self-Healing Alert
What broke: <anomaly description in plain English>
What was tried: <runbook name and steps attempted>
What happened: <failure reason or why no action was possible>
What you need to decide: <clear ask — approve runbook, dismiss, or fix manually>
Incident ID: <id> (use cortex_heal dismiss <id> or cortex_heal record_fix <id>)
```

**Guaranteed delivery**: The EscalationRouter wraps Synapse and Signal sends in independent try/catch blocks. If Synapse fails, Signal still fires. If Signal fails, the error is logged and the incident stays escalated (Matthew will see it on next status check). Neither failure blocks the other.

### 8.2 Tier-1 Synapse Message Format

```
✅ Self-Healing: Action Taken
Anomaly: <anomaly_type> on <target_id> (severity: <severity>)
Action: Executed <runbook_id> — <N> steps completed
Result: Verification probe passed — incident resolved
Metric: heal_remediation_success recorded
```

### 8.3 Tier-2 Synapse Message Format

```
⏸️ Self-Healing: Approval Required
Anomaly: <anomaly_type> on <target_id>
Runbook ready: <runbook_id> — confidence <x>% (below 80% auto-execute threshold)
Proposed steps: <dry_run output summary>
To approve: cortex_heal approve <runbook_id>
To preview: cortex_heal dry_run <runbook_id> <target_id>
```

---

## 9. Health Probe Reference

### 9.1 Supplemental Probes (HealingProbeRegistry)

These probes run on their own timers inside the HealingEngine. They do NOT appear in the PollingEngine's adapter list.

| Probe ID             | File                            | Poll Interval | What It Checks                                                                     |
| -------------------- | ------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `heal.augur_process` | `probes/augur-process-probe.ts` | 60s           | AUGUR PID file presence + `ps aux` cross-check; zombie state detection             |
| `heal.gateway`       | `probes/gateway-probe.ts`       | 120s          | `openclaw gateway status` consecutive failure count (fires anomaly at ≥ 2)         |
| `heal.brain_db`      | `probes/brain-db-probe.ts`      | 900s          | `PRAGMA integrity_check` on brain.db (read-only connection)                        |
| `heal.disk`          | `probes/disk-probe.ts`          | 600s          | `df -h /` and `df -h ~/` — emits `disk_pressure` or `disk_critical`                |
| `heal.memory`        | `probes/memory-probe.ts`        | 300s          | Parses `/proc/meminfo` MemAvailable — emits `memory_pressure` or `memory_critical` |
| `heal.log_bloat`     | `probes/log-bloat-probe.ts`     | 1800s         | Scans known log directories for files > 100MB                                      |

### 9.2 Probe Interface

All probes implement `DataSourceAdapter` (from `predictive/data-sources/adapter-interface.ts`) — this means they can be promoted to the PollingEngine in a future release without redesign:

```typescript
class DiskProbe implements DataSourceAdapter {
  readonly source_id = "heal.disk";
  readonly poll_interval_ms = 600_000;
  readonly freshness_threshold_ms = 660_000;
  async poll(): Promise<SourceReading>;
  setMockData?(data: Record<string, unknown>): void; // Test injection hook
}
```

### 9.3 SourceReading Returned by Probes

Supplemental probes return a `SourceReading` with `available: false` on error — they never throw, never crash the polling loop:

```typescript
// Disk probe SourceReading (normal)
{
  source_id: 'heal.disk',
  available: true,
  timestamp: '2026-02-18T18:00:00-05:00',
  data: {
    mounts: {
      '/': { usage_pct: 0.87, used_gb: 43.5, total_gb: 50, available_gb: 6.5 },
      '/home/bonsaihorn': { usage_pct: 0.71, used_gb: 355, total_gb: 500, available_gb: 145 }
    }
  }
}

// Disk probe SourceReading (error)
{
  source_id: 'heal.disk',
  available: false,
  timestamp: '...',
  error: 'df command timed out after 5000ms'
}
```

---

## 10. brain.db Schema Additions

Two new tables are added in a migration file (`healing/migration-v2.2.0.sql`):

### 10.1 `incidents` Table

```sql
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  anomaly_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'detected',
  runbook_id TEXT,
  detected_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL,
  resolved_at TEXT,
  escalation_tier INTEGER,
  escalated_at TEXT,
  dismiss_until TEXT,
  audit_trail TEXT NOT NULL DEFAULT '[]',  -- JSON: IncidentAuditEntry[]
  details TEXT NOT NULL DEFAULT '{}',      -- JSON: anomaly.details
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_incidents_open
  ON incidents(state, anomaly_type, target_id)
  WHERE state NOT IN ('resolved', 'self_resolved', 'dismissed');
```

### 10.2 `runbooks` Table

```sql
CREATE TABLE IF NOT EXISTS runbooks (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  applies_to TEXT NOT NULL,            -- JSON: AnomalyType[]
  mode TEXT NOT NULL DEFAULT 'dry_run',
  confidence REAL NOT NULL DEFAULT 0.5,
  dry_run_count INTEGER NOT NULL DEFAULT 0,
  last_executed_at TEXT,
  last_succeeded_at TEXT,
  auto_approve_whitelist INTEGER NOT NULL DEFAULT 0,  -- 0=false, 1=true
  created_at TEXT NOT NULL,
  approved_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
```

### 10.3 `brain_api.py` Extension

`self_healing_status()` is added to `brain_api.py`:

```python
def self_healing_status(self) -> dict:
    """Return self-healing summary for cortex stats."""
    open_incidents = self.db.execute(
        "SELECT COUNT(*) FROM incidents WHERE state NOT IN ('resolved','self_resolved','dismissed')"
    ).fetchone()[0]

    runbooks_by_mode = {
        row['mode']: row['cnt']
        for row in self.db.execute("SELECT mode, COUNT(*) as cnt FROM runbooks GROUP BY mode")
    }

    last_remediation = self.db.execute(
        "SELECT MAX(state_changed_at) FROM incidents WHERE state IN ('resolved','self_resolved')"
    ).fetchone()[0]

    last_escalation = self.db.execute(
        "SELECT MAX(escalated_at) FROM incidents WHERE escalated_at IS NOT NULL"
    ).fetchone()[0]

    return {
        "open_incident_count": open_incidents,
        "runbooks_by_mode": runbooks_by_mode,
        "last_remediation_at": last_remediation,
        "last_escalation_at": last_escalation,
    }
```

---

## 11. Metrics Reference

All healing metrics are emitted via the existing `writeMetric('pipeline', {...})` infrastructure from v1.3.0.

| Metric `task_id`           | Trigger                                    | `stage` Value       | `result` Value |
| -------------------------- | ------------------------------------------ | ------------------- | -------------- |
| `heal_anomaly_detected`    | New anomaly classified                     | `anomaly_type`      | `'detected'`   |
| `heal_remediation_started` | Runbook execution begins                   | `runbook_id`        | `'started'`    |
| `heal_remediation_success` | Verification probe passes                  | `runbook_id`        | `'pass'`       |
| `heal_remediation_failed`  | Verification probe fails after remediation | `runbook_id`        | `'fail'`       |
| `heal_escalation_fired`    | Any tier 1+ escalation                     | `'tier0'`–`'tier3'` | `'fired'`      |
| `heal_signal_sent`         | Tier-3 Signal notification sent            | `anomaly_type`      | `'sent'`       |
| `heal_runbook_created`     | New draft runbook written to brain.db      | `runbook_id`        | `'created'`    |
| `heal_runbook_graduated`   | Runbook transitions dry_run → auto_execute | `runbook_id`        | `'graduated'`  |

### Querying Healing Metrics

```bash
# Count healing events in the last 24h
sqlite3 ~/.openclaw/brain.db \
  "SELECT task_id, COUNT(*) FROM metrics
   WHERE type='pipeline' AND task_id LIKE 'heal_%'
   AND created_at > datetime('now', '-1 day')
   GROUP BY task_id"

# All failed remediations
sqlite3 ~/.openclaw/brain.db \
  "SELECT task_id, stage, created_at FROM metrics
   WHERE type='pipeline' AND task_id='heal_remediation_failed'
   ORDER BY created_at DESC LIMIT 20"
```

---

## 12. Incident-to-Runbook Learning

### 12.1 How Learning Works

When Matthew fixes an issue manually:

1. An open incident should already exist for the affected service (if not, the anomaly wasn't detected — worth noting)
2. Matthew calls `cortex_heal record_fix <incident_id> "<description>"`
3. The system resolves the incident and creates a draft runbook in brain.db with:
   - `mode: 'dry_run'`
   - `confidence: 0.5` (starter)
   - `applies_to: [incident.anomaly_type]`
   - A single descriptive step containing Matthew's description (no auto-exec commands)
4. A Synapse message proposes the draft for review

### 12.2 Graduation Paths

**Manual graduation**: `cortex_heal approve <runbook_id>` → mode transitions to `auto_execute`, metric `heal_runbook_graduated` fires.

**Automatic graduation**: After 3 consecutive matching incidents where:

- The runbook's dry-run predicted the correct resolution
- The actual anomaly self-resolved or was manually fixed with the same method

→ `RunbookRegistry.checkGraduation()` automatically transitions to `auto_execute` and posts a Synapse notification.

### 12.3 Whitelist vs. Approval

| Runbook Class                                   | Initial Mode               | How It Gets to Auto-Execute                                |
| ----------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| Whitelisted (`rb-rotate-logs`, `rb-gc-trigger`) | `auto_execute` immediately | Always auto-execute; no approval needed                    |
| Standard built-in                               | `dry_run`                  | Matthew's `cortex_heal approve` OR 3 dry-run verifications |
| Draft (from `record_fix`)                       | `dry_run`                  | Same as standard — never auto-executes until reviewed      |

---

## 13. Behavioral Signatures (Version Forensics)

### 13.1 Healthy State Signatures

When self-healing is operating normally, you should see:

**In logs (`openclaw gateway log`):**

```
[HealingEngine] started: 6 probes active, 12 runbooks loaded
[HealingProbeRegistry] heal.augur_process: ok (pid 12345 alive, non-zombie)
[HealingProbeRegistry] heal.disk: ok (/ at 71%, ~ at 68%)
[AnomalyClassifier] reading heal.disk: no anomalies
[IncidentManager] no open incidents
```

**In brain.db metrics:**

- Regular `heal_anomaly_detected` entries with subsequent `heal_remediation_success`
- No long gaps in `heal.disk` or `heal.memory` probe readings (within 2× poll interval)

**In Synapse (`synapse inbox`):**

- Tier-1 messages with "Action Taken" summaries for any auto-executed remediations
- No pending tier-2 approval requests older than 24h (those indicate a confidence issue)

### 13.2 Indicators of Sub-Optimal State

| Observation                                          | Likely Cause                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `heal_escalation_fired` with `tier=tier3` repeatedly | Runbook failing verification — may need approval or manual fix           |
| No metrics with `heal_` prefix since deployment      | HealingEngine not started — check `self_healing.enabled: true` in config |
| Tier-2 Synapse messages accumulating without action  | Runbooks awaiting approval — review with `cortex_heal list_runbooks`     |
| `heal_runbook_graduated` metric fires unexpectedly   | 3 dry-run verifications passed for an auto-graduating runbook            |
| Incident stays in `verifying` state > 5 min          | Verification probe timeout or network issue on probe target              |

---

## 14. Failure Mode Signatures

### FM-001: HealingEngine Not Starting

**Symptoms:**

- No `[HealingEngine] started` log line at gateway startup
- `cortex_heal status` returns connection error or unknown tool

**Root causes:**

1. `self_healing.enabled` is `false` in config
2. PollingEngine failed to start (HealingEngine depends on `pollingEngine.onReading`)
3. brain.db migration for v2.2.0 tables failed (schema mismatch)

**Diagnosis:**

```bash
openclaw gateway log | grep -i 'HealingEngine\|self.heal\|migration'
sqlite3 ~/.openclaw/brain.db ".tables" | grep -E 'incidents|runbooks'
```

---

### FM-002: Probe Not Firing

**Symptoms:**

- No recent `heal.disk` (or similar) readings in metrics
- `cortex_heal status` shows no open incidents for a known bad state

**Root causes:**

1. Probe interval too long relative to check window
2. Probe silently erroring (returns `available: false`) — anomaly not classified
3. HealingProbeRegistry not started (check for `[HealingProbeRegistry] started` log)

**Diagnosis:**

```bash
openclaw gateway log | grep 'HealingProbeRegistry\|heal\.disk\|heal\.memory'
sqlite3 ~/.openclaw/brain.db \
  "SELECT source_id, available, error FROM source_readings
   WHERE source_id LIKE 'heal.%' ORDER BY created_at DESC LIMIT 10"
```

---

### FM-003: Runbook Stuck in dry_run (Never Executes)

**Symptoms:**

- Tier-2 Synapse messages for the same anomaly repeatedly
- Runbook `dry_run_count` not incrementing toward graduation

**Root causes:**

1. Runbook never gets matching anomaly (target_id mismatch)
2. `checkGraduation()` not being called (bug in RunbookRegistry)
3. Confidence threshold mismatch between stored runbook and config

**Diagnosis:**

```bash
# Check runbook state in brain.db
sqlite3 ~/.openclaw/brain.db \
  "SELECT id, mode, confidence, dry_run_count, approved_at FROM runbooks"

# Force approval
# cortex_heal approve <runbook_id>
```

---

### FM-004: False-Positive Incident (Anomaly Didn't Exist)

**Symptoms:**

- Incident created and remediation executed for a service that was running fine
- Matthew gets a tier-3 Signal message for a non-issue

**Root causes:**

1. Probe threshold too aggressive (e.g., disk probe fires at 85% but usage fluctuates)
2. `min_clear_readings` not enforced for intermittent conditions
3. PID file stale from prior run (AUGUR restarted, new PID, old file still present)

**Mitigation:**

- Dismiss the incident: `cortex_heal dismiss <id> "false positive"`
- Adjust probe thresholds in config or increase `verification_interval_ms`
- For AUGUR PID: ensure `augur-process-probe.ts` cross-checks against `ps aux` (not just PID file existence)

---

### FM-005: Runbook Step Timeout

**Symptoms:**

- `heal_remediation_failed` metric with step error "timed out after 30000ms"
- Incident escalated to tier 2/3 immediately after remediation

**Root causes:**

1. Target service taking > 30s to restart (increase `timeout_ms` in that step)
2. Network issue (fleet probe or SSH-related step)
3. `pm2 restart` hanging (PM2 itself needs attention)

**Diagnosis:**

```bash
sqlite3 ~/.openclaw/brain.db \
  "SELECT id, audit_trail FROM incidents
   WHERE state='remediation_failed' ORDER BY state_changed_at DESC LIMIT 3"
# Parse audit_trail JSON to find failing step
```

---

## 15. Debugging Hooks

### 15.1 Log Grep Patterns

```bash
# HealingEngine startup
openclaw gateway log | grep 'HealingEngine\|RunbookRegistry\|HealingProbeRegistry'

# All anomaly classifications
openclaw gateway log | grep 'AnomalyClassifier'

# All escalations
openclaw gateway log | grep 'EscalationRouter\|escalation.tier'

# Specific probe output
openclaw gateway log | grep 'heal\.disk\|heal\.memory\|heal\.augur'

# Runbook execution
openclaw gateway log | grep 'RunbookExecutor\|runbook\|dry_run\|auto_execute'
```

### 15.2 brain.db Queries

```bash
# All open incidents
sqlite3 ~/.openclaw/brain.db \
  "SELECT id, anomaly_type, target_id, severity, state, detected_at
   FROM incidents
   WHERE state NOT IN ('resolved','self_resolved','dismissed')
   ORDER BY detected_at DESC"

# Incident audit trail (replace <id>)
sqlite3 ~/.openclaw/brain.db \
  "SELECT json_each.value FROM incidents, json_each(incidents.audit_trail)
   WHERE incidents.id = '<id>'"

# Runbook graduation progress
sqlite3 ~/.openclaw/brain.db \
  "SELECT id, mode, confidence, dry_run_count, approved_at FROM runbooks
   ORDER BY dry_run_count DESC"

# Healing metrics summary (last 7 days)
sqlite3 ~/.openclaw/brain.db \
  "SELECT task_id, stage, COUNT(*) as cnt
   FROM metrics
   WHERE type='pipeline' AND task_id LIKE 'heal_%'
   AND created_at > datetime('now', '-7 days')
   GROUP BY task_id, stage
   ORDER BY task_id, cnt DESC"
```

### 15.3 Enable Debug Logging

```yaml
# In config (via gateway config.patch)
self_healing:
  debug: true
```

Debug mode emits full `SourceReading` objects on every `onReading` callback, classification results including negatives, and EscalationRouter tier decisions.

### 15.4 Force a Probe Cycle

No direct API — probes run on their own timers. To force a probe reading during development/debug:

1. Set the probe interval to 1000ms temporarily via config
2. Or call `cortex_heal dry_run <runbook_id> <target_id>` which internally invokes the relevant probe for verification

---

## 16. Migration Notes (v2.1.0 → v2.2.0)

### 16.1 What Changes

| Component            | Change Type | Details                                                                                    |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `brain.db`           | Additive    | 2 new tables: `incidents`, `runbooks`                                                      |
| `cortex/index.ts`    | Additive    | HealingEngine startup + `cortex_heal` tool registration + `pollingEngine.onReading()` hook |
| `polling-engine.ts`  | Additive    | One new method: `onReading(callback)` — zero breaking change                               |
| `brain_api.py`       | Additive    | New `self_healing_status()` method                                                         |
| Config schema        | Additive    | New `self_healing` block (optional, defaults all safe)                                     |
| `healing/` directory | New         | Full new module, ~5,600 LOC                                                                |

### 16.2 Zero Breaking Changes

v2.2.0 is strictly additive. If `self_healing.enabled: false` (or the block is omitted from config), **no new code runs** — the PollingEngine, cortex tools, and brain.db are untouched from v2.1.0 behavior.

### 16.3 Migration Steps

The migration runs automatically on gateway startup when v2.2.0 is deployed:

1. `healing/migration-v2.2.0.sql` runs via the existing migration framework
2. Two new tables (`incidents`, `runbooks`) are created if they don't exist
3. Built-in runbooks are seeded into `runbooks` table with `mode: 'dry_run'` (except whitelisted)
4. HealingEngine starts and logs `[HealingEngine] started: 6 probes active, 12 runbooks loaded`

**Rollback**: If needed, the migration is reversible by dropping the two new tables. The rollback does NOT affect any other data.

### 16.4 First-Run Behavior

On first start with v2.2.0:

- All probes fire immediately on their first cycle
- Any existing anomalies will be detected and incidents created within 1–2 min
- Runbooks are all in `dry_run` mode — no auto-execution until Matthew approves or whitelisted rules apply
- Expected: Synapse may receive several tier-2 approval request messages as the system observes the initial environment state

---

## 17. Rollback Plan

### 17.1 Rollback Decision Points

| Signal                                                      | Action                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| False-positive remediations (runbook killed a live service) | `cortex_heal dismiss` for all open incidents; set `self_healing.enabled: false`; investigate probe thresholds |
| Tier-3 Signal storm (repeated alerts for same issue)        | Dismiss the incident; increase `incident_dismiss_window_ms`; investigate runbook                              |
| brain.db migration failure                                  | Gateway won't start; roll back git tag and restart                                                            |
| HealingEngine crash loop                                    | Gateway restart loops; check logs for `[HealingEngine] fatal`; disable module in config                       |

### 17.2 Emergency Disable

Via config.patch (no code change needed):

```yaml
self_healing:
  enabled: false
```

This stops all probes, all remediation, and all escalation. The PollingEngine continues. brain.db tables are preserved.

### 17.3 Full Rollback to v2.1.0

```bash
# Tag before rollback
cd ~/Projects/helios/extensions/cortex
git tag cortex-v2.2.0-rollback-$(date +%Y%m%d)
git push origin --tags

# Revert
git checkout cortex-v2.1.0
pnpm install
pnpm tsc --noEmit
# Deploy
openclaw gateway restart

# brain.db cleanup (optional — tables are inert without the module)
sqlite3 ~/.openclaw/brain.db "DROP TABLE IF EXISTS incidents; DROP TABLE IF EXISTS runbooks;"
```

---

## 18. Searchable Feature Index

```
# Feature index for grep-based discovery
# Format: FEATURE:<id> — <description> — file/location

FEATURE:heal-engine         — HealingEngine main orchestrator           — healing/index.ts
FEATURE:anomaly-classifier  — SourceReading → HealthAnomaly[] mapping   — healing/anomaly-classifier.ts
FEATURE:incident-manager    — Lifecycle state machine + brain.db CRUD   — healing/incident-manager.ts
FEATURE:runbook-registry    — Runbook catalog + graduation tracking      — healing/runbook-registry.ts
FEATURE:runbook-executor    — Step execution + timeout + verification    — healing/runbook-executor.ts
FEATURE:escalation-router   — Tier 0-3 Synapse/Signal routing           — healing/escalation-router.ts
FEATURE:probe-registry      — Supplemental health probe management       — healing/probe-registry.ts
FEATURE:cortex-heal-tool    — OpenClaw tool (7 actions)                 — cortex/index.ts

# Probe IDs
PROBE:augur-process         — AUGUR PID + zombie detection              — healing/probes/augur-process-probe.ts
PROBE:gateway               — OpenClaw gateway consecutive fail count   — healing/probes/gateway-probe.ts
PROBE:brain-db              — SQLite PRAGMA integrity_check             — healing/probes/brain-db-probe.ts
PROBE:disk                  — df usage thresholds                       — healing/probes/disk-probe.ts
PROBE:memory                — /proc/meminfo MemAvailable               — healing/probes/memory-probe.ts
PROBE:log-bloat             — Log file size > 100MB scan                — healing/probes/log-bloat-probe.ts

# Runbook IDs
RUNBOOK:rb-restart-service  — Process restart via SERVICE_MAP           — healing/runbooks/rb-restart-service.ts
RUNBOOK:rb-kill-zombie      — SIGKILL zombie + audit parent PID         — healing/runbooks/rb-kill-zombie.ts
RUNBOOK:rb-restart-augur    — Kill + restart AUGUR executor             — healing/runbooks/rb-restart-augur.ts
RUNBOOK:rb-clear-phantom    — Mark phantom position closed in trades DB — healing/runbooks/rb-clear-phantom.ts
RUNBOOK:rb-kick-pipeline    — Call pipeline-stage-done --blocked        — healing/runbooks/rb-kick-pipeline.ts
RUNBOOK:rb-probe-then-alert — 3x retry SSH probe then Synapse alert     — healing/runbooks/rb-probe-then-alert.ts
RUNBOOK:rb-rotate-logs      — Gzip/archive logs > 7 days [whitelisted] — healing/runbooks/rb-rotate-logs.ts
RUNBOOK:rb-emergency-cleanup — Log rotate + pycache/tmp prune           — healing/runbooks/rb-emergency-cleanup.ts
RUNBOOK:rb-gc-trigger       — Memory state log + Synapse notify [white] — healing/runbooks/rb-gc-trigger.ts
RUNBOOK:rb-force-gc         — Kill highest non-critical process          — healing/runbooks/rb-force-gc.ts
RUNBOOK:rb-db-emergency     — Halt brain.db writes + backup + alert     — healing/runbooks/rb-db-emergency.ts
RUNBOOK:rb-gateway-restart  — openclaw gateway restart + verify 30s    — healing/runbooks/rb-gateway-restart.ts

# Anomaly types
ANOMALY:process_dead        — Expected PID absent
ANOMALY:process_zombie      — Z-state process, parent not reaping
ANOMALY:signal_stale        — AUGUR signal file > 5 min old
ANOMALY:phantom_position    — Open position, no live signal
ANOMALY:pipeline_stuck      — Same stage > 60 min, no Synapse message
ANOMALY:fleet_unreachable   — SSH probe timeout on known host
ANOMALY:disk_pressure       — Disk > 85% ≤ 95%
ANOMALY:disk_critical       — Disk > 95%
ANOMALY:memory_pressure     — RAM < 512MB > 256MB
ANOMALY:memory_critical     — RAM ≤ 256MB
ANOMALY:db_corruption       — SQLite integrity_check errors
ANOMALY:log_bloat           — Log file > 100MB
ANOMALY:gateway_unresponsive — Gateway status fails 2x consecutive

# Database tables
TABLE:incidents             — Incident lifecycle + audit trail — brain.db
TABLE:runbooks              — Runbook catalog + runtime state  — brain.db

# Escalation tiers
TIER:0  — Silent auto-execute (metric only)
TIER:1  — Synapse info (action taken summary)
TIER:2  — Synapse action-required (approval needed)
TIER:3  — Synapse + Signal guaranteed (Matthew's decision required)

# Acceptance criteria trace
AC-001  — AUGUR process dead → restart within 30s → verified 60s
AC-002  — Pipeline stuck → Synapse tier-1 within 2 poll cycles
AC-003  — Disk > 85% → log rotation silent → Synapse tier-1
AC-004  — Disk > 95% → Signal tier-3 fires
AC-005  — DB corruption → writes halt → Signal tier-3
AC-006  — Manual fix → draft runbook created in dry_run mode
AC-007  — Approve → runbook transitions to auto_execute
AC-008  — 3 dry-run verifications → auto-graduation
AC-009  — cortex_heal status → all open incidents returned
AC-010  — Anomaly self-resolves → incident closed, runbook skipped
AC-011  — Tier-3 always reaches Signal even if Synapse fails
```

---

_Document generated by Pipeline Orchestrator — document stage — 2026-02-18_  
_Version: Cortex v2.2.0-pre | Task: task-006-self-healing | Stage: document → build_
