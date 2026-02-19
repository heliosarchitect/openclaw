# Self-Healing Infrastructure: Design Document

**Task ID:** task-006-self-healing  
**Phase:** 5.2 — Game-Changer Features  
**Author:** Design Architect (Pipeline Stage)  
**Date:** 2026-02-18  
**Cortex Version Target:** 2.2.0  
**Depends on:** Cortex v2.1.0 (predictive intent), v2.0.0 (session persistence), v1.5.0 (pre-action hooks), v1.3.0 (metrics)

---

## 1. Design Goals

The self-healing system transforms anomaly detection (already present in v2.1.0 predictive intent) into end-to-end automated remediation. Every design decision optimizes for:

1. **Safety first** — Zero false actions. Pre-verify before acting. Dry-run before graduating.
2. **Silence** — Tier-0 fixes produce no noise. Only escalations produce messages.
3. **Auditability** — Every state transition is persisted in brain.db with timestamps and actor.
4. **Reuse** — Share probe data with the predictive intent PollingEngine; don't create parallel polling loops.
5. **Extensibility** — New runbooks can be added in a single file with zero core changes.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Cortex Plugin (index.ts)                       │
│                                                                         │
│  ┌─────────────────────────┐     ┌──────────────────────────────────┐  │
│  │  Predictive Intent      │────▶│  Self-Healing Engine             │  │
│  │  PollingEngine          │     │  (HealingEngine)                 │  │
│  │  (10 adapters, shared)  │     │                                  │  │
│  └─────────────────────────┘     │  ┌──────────────────────────┐   │  │
│             │                    │  │  AnomalyClassifier        │   │  │
│             │ SourceReading       │  │  (maps readings → events) │   │  │
│             │ broadcast           │  └──────────────────────────┘   │  │
│             ▼                    │            │                      │  │
│  ┌─────────────────────────┐     │  ┌─────────▼────────────────┐   │  │
│  │  HealingProbeRegistry   │     │  │  IncidentManager          │   │  │
│  │  (new health probes     │     │  │  (lifecycle state machine)│   │  │
│  │   not in PollingEngine) │     │  └─────────────────────────┬┘   │  │
│  └─────────────────────────┘     │            │               │     │  │
│                                  │  ┌─────────▼─────────┐     │     │  │
│                                  │  │  RunbookExecutor  │     │     │  │
│                                  │  │  (step-by-step    │     │     │  │
│                                  │  │   remediation)    │     │     │  │
│                                  │  └───────────────────┘     │     │  │
│                                  │            │               │     │  │
│                                  │  ┌─────────▼───────────────▼─┐  │  │
│                                  │  │  EscalationRouter          │  │  │
│                                  │  │  (tier 0-3 delivery)       │  │  │
│                                  │  └────────────────────────────┘  │  │
│                                  └──────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  brain.db additions: incidents + runbooks tables                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

The HealingEngine is **event-driven**: it receives `SourceReading` objects from the existing PollingEngine and from its own supplemental probes. It does not run its own polling loop — it subscribes to existing data streams via a callback registration pattern.

---

## 3. Directory Structure

```
cortex/
  healing/
    index.ts                    # HealingEngine — main orchestrator
    types.ts                    # HealthAnomaly, Incident, Runbook, RunbookStep interfaces
    anomaly-classifier.ts       # Maps SourceReading → HealthAnomaly[]
    incident-manager.ts         # Incident CRUD + state machine + brain.db persistence
    runbook-registry.ts         # RunbookRegistry — catalog of all remediation procedures
    runbook-executor.ts         # RunbookExecutor — step execution + verification
    escalation-router.ts        # Tier 0–3 routing (Synapse / Signal)
    probe-registry.ts           # HealingProbeRegistry — supplemental probes not in PollingEngine
    probes/
      augur-process-probe.ts    # AUGUR PID + process table check
      gateway-probe.ts          # OpenClaw gateway self-probe
      brain-db-probe.ts         # SQLite integrity check
      disk-probe.ts             # Disk usage on / and ~/
      memory-probe.ts           # /proc/meminfo available RAM
      log-bloat-probe.ts        # Log file size checks
    runbooks/
      rb-restart-service.ts     # Process restart (AUGUR, signal-cli, etc.)
      rb-kill-zombie.ts         # Send SIGKILL to zombie process
      rb-restart-augur.ts       # Kill + restart AUGUR executor
      rb-clear-phantom.ts       # Mark phantom position as closed in trades DB
      rb-kick-pipeline.ts       # Call pipeline-stage-done --blocked
      rb-probe-then-alert.ts    # Retry 3x, then Synapse alert
      rb-rotate-logs.ts         # Archive/compress logs > 7 days
      rb-emergency-cleanup.ts   # Rotate logs + prune pycache/tmp
      rb-gc-trigger.ts          # Log memory state + Synapse notify
      rb-force-gc.ts            # Kill highest non-critical process
      rb-db-emergency.ts        # Halt writes + backup brain.db
      rb-gateway-restart.ts     # openclaw gateway restart
    __tests__/
      anomaly-classifier.test.ts
      incident-manager.test.ts
      runbook-executor.test.ts
      escalation-router.test.ts
      runbook-registry.test.ts
      probes/
        disk-probe.test.ts
        memory-probe.test.ts
        brain-db-probe.test.ts
      runbooks/
        rb-rotate-logs.test.ts
        rb-gc-trigger.test.ts
```

---

## 4. Type Definitions (`types.ts`)

### 4.1 AnomalyType and HealthAnomaly

```typescript
export type AnomalyType =
  | "process_dead"
  | "process_zombie"
  | "signal_stale"
  | "phantom_position"
  | "pipeline_stuck"
  | "fleet_unreachable"
  | "disk_pressure"
  | "disk_critical"
  | "memory_pressure"
  | "memory_critical"
  | "db_corruption"
  | "log_bloat"
  | "gateway_unresponsive";

export type AnomalySeverity = "low" | "medium" | "high" | "critical";

export interface HealthAnomaly {
  id: string; // uuid
  anomaly_type: AnomalyType;
  target_id: string; // e.g. 'augur-executor', 'disk:/', 'fleet:radio'
  severity: AnomalySeverity;
  detected_at: string; // ISO 8601
  source_id: string; // Which adapter/probe produced this
  details: Record<string, unknown>; // Raw data from SourceReading
  remediation_hint: string; // e.g. 'rb-restart-service'
  self_resolved?: boolean; // True if re-probe before execution shows clear
}
```

### 4.2 Incident

```typescript
export type IncidentState =
  | "detected"
  | "diagnosing"
  | "remediating"
  | "verifying"
  | "resolved"
  | "escalated"
  | "self_resolved"
  | "remediation_failed"
  | "dismissed";

export interface IncidentAuditEntry {
  timestamp: string;
  state: IncidentState;
  actor: "system" | "matthew";
  note: string;
  step_id?: string;
}

export interface Incident {
  id: string; // uuid
  anomaly_type: AnomalyType;
  target_id: string;
  severity: AnomalySeverity;
  state: IncidentState;
  runbook_id: string | null;
  detected_at: string;
  state_changed_at: string;
  resolved_at: string | null;
  escalation_tier: number | null;
  escalated_at: string | null;
  dismiss_until: string | null;
  audit_trail: IncidentAuditEntry[];
  details: Record<string, unknown>;
  schema_version: number;
}
```

### 4.3 Runbook

```typescript
export type RunbookMode = "dry_run" | "auto_execute";
export type RunbookStepStatus = "pending" | "success" | "failed" | "skipped";

export interface RunbookStepResult {
  step_id: string;
  status: RunbookStepStatus;
  output: string;
  artifacts: string[];
  duration_ms: number;
}

export interface RunbookStep {
  id: string;
  description: string;
  timeout_ms: number;
  dry_run(): Promise<string>;
  execute(context: RunbookContext): Promise<RunbookStepResult>;
}

export interface RunbookContext {
  anomaly: HealthAnomaly;
  incident_id: string;
  dry_run: boolean;
}

export interface Runbook {
  id: string; // e.g. 'rb-restart-service'
  label: string;
  applies_to: AnomalyType[];
  mode: RunbookMode;
  confidence: number; // 0.0–1.0
  dry_run_count: number; // consecutive dry-run verifications
  last_executed_at: string | null;
  last_succeeded_at: string | null;
  auto_approve_whitelist: boolean; // True for rb-rotate-logs, rb-gc-trigger
  steps: RunbookStep[];
  created_at: string;
  approved_at: string | null;
  schema_version: number;
}
```

### 4.4 HealingEngineConfig

```typescript
export interface HealingEngineConfig {
  enabled: boolean;
  auto_execute_whitelist: string[]; // runbook IDs safe for tier-0 without approval
  tier3_signal_channel: string;
  confidence_auto_execute: number; // 0.8 — minimum confidence for tier-0
  dry_run_graduation_count: number; // 3 — consecutive dry-runs before auto-graduation
  verification_interval_ms: number; // 30s — re-probe after remediation
  min_clear_readings: number; // 3 — consecutive clear probes to mark resolved
  incident_dismiss_window_ms: number; // 24h — suppress re-alert after dismiss
  probe_intervals_ms: {
    // Supplemental probe schedule
    augur_process: number; // 60s
    gateway: number; // 120s
    brain_db: number; // 900s
    disk: number; // 600s
    memory: number; // 300s
    log_bloat: number; // 1800s
  };
}
```

---

## 5. Core Components

### 5.1 AnomalyClassifier (`anomaly-classifier.ts`)

Single responsibility: convert `SourceReading` objects into `HealthAnomaly[]`.

**Classification rules** (keyed by `source_id`):

| source_id            | Anomaly Type           | Trigger Condition                                               |
| -------------------- | ---------------------- | --------------------------------------------------------------- |
| `augur.signals`      | `signal_stale`         | `data.signal_stale === true` or `data.minutes_since_update > 5` |
| `augur.signals`      | `phantom_position`     | `data.has_open_position && !data.has_live_signal`               |
| `fleet.health`       | `fleet_unreachable`    | `data.unreachable.length > 0`                                   |
| `pipeline.state`     | `pipeline_stuck`       | `data.stuck_task !== null`                                      |
| `heal.augur_process` | `process_dead`         | `data.pid_found === false`                                      |
| `heal.augur_process` | `process_zombie`       | `data.zombie === true`                                          |
| `heal.gateway`       | `gateway_unresponsive` | `data.consecutive_failures >= 2`                                |
| `heal.brain_db`      | `db_corruption`        | `data.integrity_ok === false`                                   |
| `heal.disk`          | `disk_pressure`        | `data.usage_pct > 0.85 && data.usage_pct <= 0.95`               |
| `heal.disk`          | `disk_critical`        | `data.usage_pct > 0.95`                                         |
| `heal.memory`        | `memory_pressure`      | `data.available_mb < 512 && data.available_mb > 256`            |
| `heal.memory`        | `memory_critical`      | `data.available_mb <= 256`                                      |
| `heal.log_bloat`     | `log_bloat`            | `data.bloated_files.length > 0`                                 |

**API:**

```typescript
class AnomalyClassifier {
  classify(reading: SourceReading): HealthAnomaly[];
  // Returns [] if reading is unavailable or has no anomalies.
  // Never throws — classification errors produce empty result.
}
```

### 5.2 IncidentManager (`incident-manager.ts`)

Manages incident lifecycle with full brain.db persistence.

**State machine:**

```
detected → diagnosing → remediating → verifying → resolved
                                  ↘                ↗
                                   remediation_failed → escalated
         ↘ self_resolved (anomaly cleared before execution)
         ↘ dismissed (explicit dismiss with timestamp)
```

**Key invariants:**

- **Unique constraint**: Only one non-terminal incident per `(anomaly_type, target_id)`. Re-detection refreshes `detected_at`, adds audit entry, does NOT create duplicate.
- **Dismissed**: If an incident is dismissed, the same `(anomaly_type, target_id)` pair is suppressed until `dismiss_until` timestamp.
- **All state transitions** append to `audit_trail` JSON column in brain.db.

**API:**

```typescript
class IncidentManager {
  // Create or refresh existing open incident
  async upsertIncident(anomaly: HealthAnomaly): Promise<Incident>;

  // Transition state; appends audit entry
  async transition(
    incidentId: string,
    newState: IncidentState,
    note: string,
    actor?: "system" | "matthew",
  ): Promise<void>;

  // Get all non-terminal incidents
  async getOpenIncidents(): Promise<Incident[]>;

  // Get single incident
  async getIncident(id: string): Promise<Incident | null>;

  // Check if anomaly is dismissed
  async isDismissed(anomalyType: AnomalyType, targetId: string): Promise<boolean>;

  // Dismiss with window
  async dismiss(incidentId: string, reason: string, windowMs: number): Promise<void>;

  // Mark as self-resolved
  async selfResolve(incidentId: string): Promise<void>;
}
```

**brain.db schema additions:**

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
  audit_trail TEXT NOT NULL DEFAULT '[]',  -- JSON array of IncidentAuditEntry
  details TEXT NOT NULL DEFAULT '{}',      -- JSON object from anomaly
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(state, anomaly_type, target_id)
  WHERE state NOT IN ('resolved', 'self_resolved', 'dismissed');

CREATE TABLE IF NOT EXISTS runbooks (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  applies_to TEXT NOT NULL,           -- JSON array of AnomalyType
  mode TEXT NOT NULL DEFAULT 'dry_run',
  confidence REAL NOT NULL DEFAULT 0.5,
  dry_run_count INTEGER NOT NULL DEFAULT 0,
  last_executed_at TEXT,
  last_succeeded_at TEXT,
  auto_approve_whitelist INTEGER NOT NULL DEFAULT 0,  -- boolean
  created_at TEXT NOT NULL,
  approved_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
```

### 5.3 RunbookRegistry (`runbook-registry.ts`)

Maintains in-memory + persisted catalog of all runbooks.

**Startup sequence:**

1. Load built-in runbooks from `healing/runbooks/*.ts` (always `dry_run` mode on first run)
2. Load persisted mode/confidence/counts from brain.db `runbooks` table
3. Merge: built-in structure + persisted runtime state

**Auto-whitelist**: `rb-rotate-logs` and `rb-gc-trigger` have `auto_approve_whitelist: true` — they start in `auto_execute` mode without Matthew's approval.

**API:**

```typescript
class RunbookRegistry {
  async load(): Promise<void>;

  getRunbook(id: string): Runbook | null;

  getForAnomaly(anomalyType: AnomalyType): Runbook | null;

  async approve(runbookId: string): Promise<void>;

  async recordExecution(runbookId: string, success: boolean): Promise<void>;

  async checkGraduation(runbookId: string): Promise<boolean>;
  // Returns true if dry_run_count >= 3 → auto-graduates to auto_execute

  async listRunbooks(): Promise<Runbook[]>;
}
```

### 5.4 RunbookExecutor (`runbook-executor.ts`)

Executes runbooks step-by-step with atomicity, timeout enforcement, and pre/post-verification.

**Execution flow:**

```
1. Re-probe: verify anomaly still active (NFR-002)
   → if clear: close incident as self_resolved, skip
   → if still active: proceed

2. For each RunbookStep:
   a. If dry_run mode: call step.dry_run(), log output, continue
   b. If auto_execute mode:
      - Run step.execute(context)
      - If step fails within timeout_ms: mark incident remediation_failed → escalate
      - If step succeeds: continue to next step

3. Post-execution: wait verification_interval_ms (30s), then re-probe
   → probe passes: transition incident to resolved, write metric
   → probe fails: transition to remediation_failed → escalate
```

**API:**

```typescript
class RunbookExecutor {
  async execute(
    runbook: Runbook,
    incident: Incident,
    options?: { force_dry_run?: boolean },
  ): Promise<RunbookExecutionResult>;
}

interface RunbookExecutionResult {
  success: boolean;
  mode: RunbookMode;
  steps_executed: RunbookStepResult[];
  verification_passed: boolean | null; // null in dry_run mode
  escalation_needed: boolean;
}
```

**Safety invariant**: RunbookStep implementations MUST use only statically-defined command strings. Dynamic construction from `anomaly.details` is forbidden at the type level (steps receive `RunbookContext` and access pre-approved command templates only).

### 5.5 EscalationRouter (`escalation-router.ts`)

Routes notifications based on escalation tier.

```typescript
class EscalationRouter {
  async route(tier: 0 | 1 | 2 | 3, incident: Incident, context: EscalationContext): Promise<void>;
}

interface EscalationContext {
  action_taken?: string;
  verification_status?: string;
  proposed_steps?: string[]; // For tier-2 approval request
  failure_reason?: string; // For tier-3
  matthew_decision_needed?: string; // Plain language for tier-3
}
```

| Tier | Implementation                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 0    | Write metric only (no messages)                                                                       |
| 1    | `synapse(action='send', to='all', priority='info', body=<summary>)`                                   |
| 2    | `synapse(action='send', to='all', priority='action', body=<approval_request>)`                        |
| 3    | `synapse` + `message(action='send', channel='signal', ...)` — Signal guaranteed even if Synapse fails |

**Tier-3 Signal format** (plain language per NFR-003):

```
🚨 Self-Healing Alert
What broke: <anomaly description>
What was tried: <runbook name + steps attempted>
What happened: <failure reason>
What you need to decide: <matthew_decision_needed>
Incident ID: <id> (for cortex_heal dismiss or record_fix)
```

### 5.6 HealingProbeRegistry (`probe-registry.ts`)

Manages the supplemental health probes that run ONLY within the healing system (not registered in PollingEngine, since they're healing-specific and not useful for predictive intent insights).

**Probes:**

| Probe ID             | File                     | Checks                                                 |
| -------------------- | ------------------------ | ------------------------------------------------------ |
| `heal.augur_process` | `augur-process-probe.ts` | AUGUR PID file + `ps aux` check; zombie detection      |
| `heal.gateway`       | `gateway-probe.ts`       | `openclaw gateway status` consecutive failure counting |
| `heal.brain_db`      | `brain-db-probe.ts`      | `PRAGMA integrity_check` on brain.db                   |
| `heal.disk`          | `disk-probe.ts`          | `df -h /` and `df -h ~/` usage percentages             |
| `heal.memory`        | `memory-probe.ts`        | Parse `/proc/meminfo` for MemAvailable                 |
| `heal.log_bloat`     | `log-bloat-probe.ts`     | Find log files > 100MB in known log dirs               |

Each probe implements `DataSourceAdapter` (NFR-004 — extensibility):

```typescript
class DiskProbe implements DataSourceAdapter {
  readonly source_id = "heal.disk";
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  async poll(): Promise<SourceReading>;
  setMockData?(data: Record<string, unknown>): void;
}
```

### 5.7 HealingEngine (`index.ts`)

The orchestrator. Initialized in `cortex/index.ts` alongside the PollingEngine.

```typescript
class HealingEngine {
  constructor(
    private bridge: CortexBridge,
    private config: HealingEngineConfig,
    private logger: Logger,
  ) {}

  async start(): Promise<void>;
  // 1. Load RunbookRegistry (from brain.db)
  // 2. Start HealingProbeRegistry (starts probe timers)
  // 3. Subscribe to PollingEngine readings via onReading callback

  // Called by PollingEngine on each new SourceReading
  async onReading(reading: SourceReading): Promise<void>;
  // 1. AnomalyClassifier.classify(reading)
  // 2. For each anomaly: IncidentManager.upsertIncident(anomaly)
  // 3. For each new/refreshed incident: dispatch to handleIncident()

  private async handleIncident(incident: Incident): Promise<void>;
  // Implements the detect → diagnose → remediate → verify → escalate flow

  // cortex_heal tool backing methods
  async getStatus(): Promise<{ open_incidents: Incident[]; runbook_summary: object }>;
  async listRunbooks(): Promise<Runbook[]>;
  async approveRunbook(runbookId: string): Promise<void>;
  async dryRunRunbook(runbookId: string, targetId: string): Promise<string>;
  async executeRunbook(
    runbookId: string,
    targetId: string,
    confirm: boolean,
  ): Promise<RunbookExecutionResult>;
  async recordFix(incidentId: string, description: string): Promise<void>;
  async dismissIncident(incidentId: string, reason: string): Promise<void>;
}
```

**Integration with PollingEngine** (non-intrusive):

```typescript
// In cortex/index.ts — after pollingEngine.start():
if (config.self_healing?.enabled) {
  healingEngine = new HealingEngine(bridge, healingConfig, api.logger);
  await healingEngine.start();

  // Subscribe to polling engine readings
  pollingEngine.onReading((reading) => {
    void healingEngine.onReading(reading);
  });
}
```

The PollingEngine needs one additive method: `onReading(callback)` — fires the callback after each adapter poll cycle. This is a zero-breaking-change addition.

---

## 6. Runbook Implementations

Each runbook file exports a class implementing:

```typescript
interface RunbookDefinition {
  readonly id: string;
  readonly label: string;
  readonly applies_to: AnomalyType[];
  readonly auto_approve_whitelist: boolean;
  build(anomaly: HealthAnomaly): RunbookStep[];
}
```

### Representative Runbook: `rb-restart-service.ts`

```typescript
// rb-restart-service: Restart AUGUR or signal-cli via known service map
const SERVICE_MAP: Record<string, { cmd: string; verify_pid_path?: string }> = {
  "augur-executor": {
    cmd: "cd ~/Projects/augur && pm2 restart augur-executor || python3 -m augur.executor &",
    verify_pid_path: "/tmp/augur-executor.pid",
  },
  "signal-cli": {
    cmd: "systemctl --user restart signal-cli.service",
  },
};
// Steps: [verify_service_map_exists, kill_old_pid, run_start_cmd, verify_pid_appears]
// All commands are hardcoded strings from SERVICE_MAP — no dynamic construction.
```

### Auto-whitelisted: `rb-rotate-logs.ts`

```typescript
// rb-rotate-logs: Archive logs > 7 days to .archive/ subdirectory
// Steps: [find_old_logs (dry_run: list), gzip_and_move, verify_disk_delta]
// auto_approve_whitelist: true → starts in auto_execute mode
```

### Conservative: `rb-db-emergency.ts`

```typescript
// rb-db-emergency: Halt brain.db writes, backup, Signal alert
// Steps: [set_db_readonly_flag, cp_brain_db_to_backup, emit_tier3_signal]
// mode: 'dry_run' — never auto-executes, always tier-3 escalation
```

---

## 7. `cortex_heal` Tool Registration

Registered in `cortex/index.ts` alongside existing tools. All 7 actions:

```typescript
// actions: status | list_runbooks | approve | dry_run | execute | record_fix | dismiss

// status → healingEngine.getStatus()
// list_runbooks → healingEngine.listRunbooks()
// approve → healingEngine.approveRunbook(params.runbook_id)
// dry_run → healingEngine.dryRunRunbook(params.runbook_id, params.target_id)
// execute → requires params.confirm === true, then healingEngine.executeRunbook(...)
// record_fix → healingEngine.recordFix(params.incident_id, params.description)
// dismiss → healingEngine.dismissIncident(params.incident_id, params.reason)
```

**Safety check**: `execute` action validates `params.confirm === true` explicitly. Without it:

```json
{ "error": "Safety check: must pass confirm=true to force-execute a runbook" }
```

---

## 8. Metrics Integration

New metric events (emitted via existing `writeMetric('pipeline', {...})` pattern):

```typescript
// These use the pipeline metrics writer with heal_ prefix on task_id
writeMetric("pipeline", {
  task_id: "heal_anomaly_detected",
  stage: anomaly.anomaly_type,
  result: "detected",
});
writeMetric("pipeline", {
  task_id: "heal_remediation_started",
  stage: runbook.id,
  result: "started",
});
writeMetric("pipeline", { task_id: "heal_remediation_success", stage: runbook.id, result: "pass" });
writeMetric("pipeline", { task_id: "heal_remediation_failed", stage: runbook.id, result: "fail" });
writeMetric("pipeline", {
  task_id: "heal_escalation_fired",
  stage: `tier${tier}`,
  result: "fired",
});
writeMetric("pipeline", {
  task_id: "heal_signal_sent",
  stage: anomaly.anomaly_type,
  result: "sent",
});
writeMetric("pipeline", { task_id: "heal_runbook_created", stage: runbook.id, result: "created" });
writeMetric("pipeline", {
  task_id: "heal_runbook_graduated",
  stage: runbook.id,
  result: "graduated",
});
```

**`brain_api.py` extension**: Add `self_healing_status()` method returning:

```python
{
  "open_incident_count": int,
  "runbooks_by_mode": {"dry_run": int, "auto_execute": int},
  "last_remediation_at": str | None,
  "last_escalation_at": str | None,
  "last_signal_sent_at": str | None
}
```

---

## 9. Config Schema Extension

Addition to `cortex/index.ts` configSchema:

```typescript
// PHASE 5.2: Self-Healing
self_healing: Type.Optional(Type.Object({
  enabled: Type.Boolean({ default: true }),
  tier3_signal_channel: Type.String({ default: 'signal' }),
  confidence_auto_execute: Type.Number({ default: 0.8, minimum: 0, maximum: 1 }),
  dry_run_graduation_count: Type.Number({ default: 3, minimum: 1, maximum: 10 }),
  verification_interval_ms: Type.Number({ default: 30000, minimum: 5000 }),
  min_clear_readings: Type.Number({ default: 3, minimum: 1 }),
  incident_dismiss_window_ms: Type.Number({ default: 86400000 }),  // 24h
  auto_execute_whitelist: Type.Array(Type.String(), {
    default: ['rb-rotate-logs', 'rb-gc-trigger']
  }),
  probe_intervals_ms: Type.Optional(Type.Object({
    augur_process: Type.Number({ default: 60000 }),
    gateway: Type.Number({ default: 120000 }),
    brain_db: Type.Number({ default: 900000 }),
    disk: Type.Number({ default: 600000 }),
    memory: Type.Number({ default: 300000 }),
    log_bloat: Type.Number({ default: 1800000 }),
  })),
  debug: Type.Boolean({ default: false }),
})),
```

---

## 10. Integration Touchpoints (NFR-004)

### Shared Data with Predictive Intent

| Predictive Adapter         | Self-Healing Use                                             |
| -------------------------- | ------------------------------------------------------------ |
| `fleet-adapter.ts`         | `fleet_unreachable` classification from `data.unreachable[]` |
| `augur-signals-adapter.ts` | `signal_stale` + `phantom_position` from same SourceReading  |
| `pipeline-adapter.ts`      | `pipeline_stuck` from `data.stuck_task`                      |

No data is fetched twice. The PollingEngine fires `onReading` once per poll cycle; the HealingEngine receives the same object the predictive intent system receives.

### Supplemental-Only Probes (not in PollingEngine)

`heal.augur_process`, `heal.gateway`, `heal.brain_db`, `heal.disk`, `heal.memory`, `heal.log_bloat` — these run only within HealingProbeRegistry. They implement `DataSourceAdapter` so they could be promoted to PollingEngine in a future release without a redesign.

---

## 11. Incident-to-Runbook Learning Pipeline (FR-006)

When `cortex_heal record_fix` is called:

1. Look up open incident for the service/target Matthew just fixed
2. If found: capture `description` field as "what was done"
3. Create a new `Runbook` entry in brain.db with:
   - `mode: 'dry_run'`
   - `confidence: 0.5` (starter)
   - `applies_to: [incident.anomaly_type]`
   - Steps: informational only — no auto-exec commands until Matthew approves
4. Post Synapse message: "Draft runbook `rb-matthew-fix-<uuid>` created for `<anomaly_type>`. Review with `cortex_heal dry_run` and approve with `cortex_heal approve`."

Graduation path:

- **Manual**: `cortex_heal approve <runbook_id>` → mode transitions to `auto_execute`
- **Automatic**: `dry_run_count >= 3` consecutive matching incidents where dry-run would have resolved → auto-graduate (write metric `heal_runbook_graduated`)

---

## 12. Acceptance Criteria Traceability

| AC     | Design Coverage                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------- |
| AC-001 | `augur-process-probe` (60s) → `process_dead` → `rb-restart-service` → 30s verify                                  |
| AC-002 | `pipeline-adapter` shared reading → `pipeline_stuck` → Synapse tier-1 within 2 poll cycles                        |
| AC-003 | `disk-probe` (10m) → `disk_pressure` → `rb-rotate-logs` (whitelisted) → Synapse tier-1                            |
| AC-004 | `disk-probe` → `disk_critical` → `rb-emergency-cleanup` → Signal tier-3                                           |
| AC-005 | `brain-db-probe` (15m) → `db_corruption` → `rb-db-emergency` → Signal tier-3 immediately                          |
| AC-006 | `record_fix` → draft runbook in `dry_run` mode in brain.db                                                        |
| AC-007 | `cortex_heal approve` → `RunbookRegistry.approve()` → mode=`auto_execute`                                         |
| AC-008 | `RunbookRegistry.checkGraduation()` called after each dry-run → auto-graduate at count=3                          |
| AC-009 | `cortex_heal status` → `HealingEngine.getStatus()` → all open incidents                                           |
| AC-010 | `RunbookExecutor` re-probes before execution; if clear → `selfResolve()`                                          |
| AC-011 | `EscalationRouter.route(3, ...)` — Signal send wrapped in try/catch; Synapse separately, neither blocks the other |

---

## 13. Build Scope Estimate

| Component                          | Complexity | LOC estimate       |
| ---------------------------------- | ---------- | ------------------ |
| `types.ts`                         | Low        | ~150               |
| `anomaly-classifier.ts`            | Medium     | ~200               |
| `incident-manager.ts`              | High       | ~350               |
| `runbook-registry.ts`              | Medium     | ~250               |
| `runbook-executor.ts`              | High       | ~300               |
| `escalation-router.ts`             | Medium     | ~200               |
| `probe-registry.ts`                | Low        | ~100               |
| 6 probe files                      | Low        | ~80 each → ~480    |
| 12 runbook files                   | Medium     | ~80 each → ~960    |
| `healing/index.ts` (HealingEngine) | High       | ~400               |
| `index.ts` integration changes     | Medium     | ~150               |
| `brain_api.py` extension           | Low        | ~60                |
| SQL migration file                 | Low        | ~40                |
| 10 test files                      | High       | ~200 each → ~2,000 |
| **Total**                          |            | **~5,610 LOC**     |

---

## 14. Risk Register

| Risk                                              | Likelihood | Mitigation                                                                                |
| ------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| Runbook step kills wrong process (PID reuse)      | Medium     | PID file + process name double-check before SIGKILL                                       |
| Self-healing loop: fix → new anomaly → fix again  | Low        | Incident dedup + `dismiss_until` window                                                   |
| brain.db probe causes write during corruption     | Low        | `rb-db-emergency` sets readonly flag before backup                                        |
| Gateway restart kills the session running healing | Medium     | Gateway restart verified within 30s; HealingEngine restarts with plugin on gateway reload |
| PollingEngine `onReading` callback throws         | Low        | HealingEngine wraps callback in try/catch; never propagates to PollingEngine              |

---

## 15. Open Questions for Build Stage

1. **AUGUR restart command**: Does AUGUR use PM2, direct Python, or a shell script? Build stage should verify before writing `rb-restart-service.ts`.
2. **signal-cli service name**: Is it `signal-cli.service` or a different unit name? Needs `systemctl --user list-units` check during build.
3. **brain.db path**: Already in CortexBridge — confirm it exposes `dbPath` for the `brain-db-probe` to use directly.
4. **PollingEngine `onReading` hook**: Minor additive change to `polling-engine.ts` — already flagged for build stage, not a blocker.
