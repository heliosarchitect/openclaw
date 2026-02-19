# Self-Healing Infrastructure: Requirements Document

**Task ID:** task-006-self-healing  
**Phase:** 5.2 — Game-Changer Features  
**Author:** Requirements Analyst (Pipeline Orchestrator — catch-up artifact)  
**Date:** 2026-02-18  
**Cortex Version:** 2.1.0 → 2.2.0  
**OpenClaw Compatibility:** Plugin API v2.x+  
**Dependencies:** Cortex v2.1.0 (predictive intent), v2.0.0 (session persistence), v1.5.0 (pre-action hooks), v1.3.0 (metrics)

---

## Summary

Self-Healing Infrastructure transforms Helios from a system that detects anomalies into one that resolves them automatically. When a service fails, a pipeline stalls, or a resource threshold is breached, the system follows a defined runbook to remediate the issue — silently if safe, via Synapse if action is required, via Signal only if Matthew's decision is truly needed. Every manual fix Matthew applies becomes a runbook, building an ever-expanding library of automated responses.

This is NOT a monitoring dashboard. It is a **detect → diagnose → remediate → escalate** pipeline: the system attempts self-repair first and escalates only when automated resolution fails.

---

## Functional Requirements

### FR-001: Continuous Service Health Monitoring

- **Requirement**: The system MUST monitor the following services and processes:

  | Monitor Target    | Check Method                             | Probe Interval |
  | ----------------- | ---------------------------------------- | -------------- |
  | AUGUR executor    | PID file + process table check           | 60s            |
  | AUGUR signal file | `live_signal.json` staleness check       | 60s            |
  | signal-cli        | Process existence + socket reachable     | 90s            |
  | OpenClaw gateway  | Self-probe via `openclaw gateway status` | 2 min          |
  | Pipeline agents   | Synapse message timestamp check          | 2 min          |
  | Fleet hosts       | SSH reachability (all known hosts)       | 5 min          |
  | Disk pressure     | `/` and `~/` usage threshold checks      | 10 min         |
  | Memory pressure   | `/proc/meminfo` available RAM check      | 5 min          |
  | brain.db health   | SQLite integrity check                   | 15 min         |
  | Log file bloat    | Log size threshold checks                | 30 min         |

- **Priority**: CRITICAL
- **Testable**: Health probe returns structured `HealthReading` within 5s; unreachable hosts return `available: false`, not thrown errors.

---

### FR-002: Anomaly Detection and Classification

- **Requirement**: The system MUST detect and classify the following anomaly types:

  | Anomaly Type           | Detection Condition                                                     | Severity |
  | ---------------------- | ----------------------------------------------------------------------- | -------- |
  | `process_dead`         | Expected PID absent from process table                                  | critical |
  | `process_zombie`       | Process exists but in Z state; parent not reaping                       | high     |
  | `signal_stale`         | `live_signal.json` updated_at > 5 min ago while AUGUR should be running | high     |
  | `phantom_position`     | Open position in trades DB with no corresponding live signal            | high     |
  | `pipeline_stuck`       | Pipeline task in same stage > 60 min with no Synapse message            | high     |
  | `fleet_unreachable`    | SSH probe timeout for known host                                        | high     |
  | `disk_pressure`        | Disk usage > 85% on monitored mount                                     | high     |
  | `disk_critical`        | Disk usage > 95% on monitored mount                                     | critical |
  | `memory_pressure`      | Available RAM < 512MB                                                   | medium   |
  | `memory_critical`      | Available RAM < 256MB                                                   | critical |
  | `db_corruption`        | SQLite integrity check returns errors                                   | critical |
  | `log_bloat`            | Log file > 100MB without rotation                                       | medium   |
  | `gateway_unresponsive` | OpenClaw gateway self-probe fails twice consecutively                   | critical |

- **Integration with Predictive Intent**: Anomaly detection MUST re-use the `anomaly` and `alert` insight types from the existing PollingEngine. Where possible, self-healing health probes share readings with predictive intent adapters to avoid redundant polling.
- **Priority**: CRITICAL
- **Testable**: Each anomaly type triggers a classified `HealthAnomaly` record with correct severity and remediation hint.

---

### FR-003: Automated Remediation via Runbooks

- **Requirement**: The system MUST maintain a runbook registry mapping anomaly signatures to remediation procedures.

  | Anomaly                | Runbook ID             | Default Action                                                    |
  | ---------------------- | ---------------------- | ----------------------------------------------------------------- |
  | `process_dead`         | `rb-restart-service`   | Restart via PM2/systemd/direct; verify PID re-appears             |
  | `process_zombie`       | `rb-kill-zombie`       | Send SIGKILL to zombie; log parent PID for audit                  |
  | `signal_stale`         | `rb-restart-augur`     | Kill AUGUR executor + restart; verify signal freshens             |
  | `phantom_position`     | `rb-clear-phantom`     | Mark phantom position as `closed` in trades DB; alert via Synapse |
  | `pipeline_stuck`       | `rb-kick-pipeline`     | Call `pipeline-stage-done` with blocked status; Synapse alert     |
  | `fleet_unreachable`    | `rb-probe-then-alert`  | 3 retries at 30s interval; if still down, Synapse alert           |
  | `disk_pressure`        | `rb-rotate-logs`       | Archive/compress logs > 7 days; gzip and move to `.archive/`      |
  | `disk_critical`        | `rb-emergency-cleanup` | Rotate logs + prune pycache + tmp files; Signal alert             |
  | `memory_pressure`      | `rb-gc-trigger`        | Log memory state; notify via Synapse                              |
  | `memory_critical`      | `rb-force-gc`          | Kill highest-memory non-critical process; Signal alert            |
  | `log_bloat`            | `rb-rotate-logs`       | Same as disk_pressure runbook                                     |
  | `db_corruption`        | `rb-db-emergency`      | Halt DB writes; backup DB; Signal alert immediately               |
  | `gateway_unresponsive` | `rb-gateway-restart`   | `openclaw gateway restart`; verify within 30s                     |

- **Step Atomicity**: Each remediation step MUST be atomic — it either succeeds or it does not execute. No partial modifications.
- **Dry-Run Mode**: Every step MUST implement `dry_run(): Promise<string>` describing what it would do. New runbooks start in `dry_run` mode.
- **Timeout Enforcement**: Each step has a configurable `timeout_ms` (default: 30s). Step failure ≠ system crash — it triggers escalation.
- **Priority**: CRITICAL
- **Testable**: Dry-run mode returns human-readable description; live mode returns structured result with `success: boolean` and `artifacts: string[]`.

---

### FR-004: Incident Lifecycle Management

- **Requirement**: Each detected anomaly MUST create an `Incident` record tracking the full lifecycle:

  ```
  detected → diagnosing → remediating → verifying → resolved
                                    ↘ escalated → resolved (after Matthew action)
                         ↘ remediation_failed → escalated
  ```

- **Unique constraint**: Only one open incident per `(anomaly_type, target_id)` pair at a time. Re-detection refreshes the existing incident rather than creating a duplicate.
- **Resolution verification**: After a remediation step completes, the original health probe MUST be re-run within 30s to verify the fix. If probe still fails, incident escalates.
- **Incident audit trail**: Every state transition, every step executed, and its result MUST be written to `brain.db` in the `incidents` table.
- **Priority**: CRITICAL
- **Testable**: Incident created on anomaly detection, state transitions logged on each step, resolved on successful verification probe.

---

### FR-005: Escalation Tier System

- **Requirement**: When automated remediation fails or is not appropriate, the system MUST escalate through these tiers:

  | Tier | Condition                                              | Action                                                          |
  | ---- | ------------------------------------------------------ | --------------------------------------------------------------- |
  | 0    | Known runbook, auto-execute mode, confidence ≥ 0.8     | Execute silently; write metric only                             |
  | 1    | Known runbook executed, result uncertain               | Synapse alert with "action taken" summary; Matthew can override |
  | 2    | Runbook exists but confidence < 0.8 (needs approval)   | Synapse alert requesting approval before execution              |
  | 3    | No runbook, remediation failed, or `critical` severity | Signal notification to Matthew; describe exact failure          |

- **No escalation bypass**: If a tier-3 escalation fires, it MUST reach Signal. Not just Synapse.
- **Priority**: HIGH
- **Testable**: Verify each tier triggers correct delivery channel; tier-3 always produces a Signal message.

---

### FR-006: Incident-to-Runbook Pipeline

- **Requirement**: When Matthew manually fixes an issue (via exec tool in-session), the system MUST:
  1. Detect that an open incident was present for the affected service/target
  2. Capture the commands executed that led to resolution
  3. Propose a new or updated runbook via Synapse
  4. Enter the new runbook in `dry_run` mode until Matthew approves it

- **Manual trigger**: `cortex_heal` tool with `action: 'record_fix'` allows Matthew to explicitly trigger runbook capture with a description of what was done.
- **Learning threshold**: A runbook graduates from `dry_run` to `auto_execute` mode when: (a) Matthew explicitly approves it, OR (b) it has been dry-run-verified as "would have resolved" for 3 consecutive instances of the same anomaly.
- **Priority**: HIGH
- **Testable**: After recording a fix, a draft runbook appears in brain.db in `dry_run` mode; executing the target `cortex_heal approve` transitions it to `auto_execute`.

---

### FR-007: `cortex_heal` Tool

- **Requirement**: A new `cortex_heal` OpenClaw tool MUST be registered with these actions:

  | Action          | Description                                                                   |
  | --------------- | ----------------------------------------------------------------------------- |
  | `status`        | Return all open incidents with current state and remediation progress         |
  | `list_runbooks` | Return all runbooks with mode, confidence, and last-used timestamp            |
  | `approve`       | Approve a runbook for auto-execute mode (by runbook_id)                       |
  | `dry_run`       | Execute a runbook in dry-run mode and return proposed steps                   |
  | `execute`       | Force-execute a runbook for a given target (even if not triggered by anomaly) |
  | `record_fix`    | Manually record a fix for an open incident; triggers runbook proposal         |
  | `dismiss`       | Dismiss an open incident with a reason (won't re-alert for 24h)               |

- **Priority**: HIGH
- **Testable**: All 7 actions return valid JSON; `dry_run` never modifies system state; `execute` requires explicit `confirm: true` flag to prevent accidents.

---

### FR-008: Metrics and Observability

- **Requirement**: The following metrics MUST be emitted via `writeMetric('pipeline', {...})`:

  | Metric                     | Trigger                                         |
  | -------------------------- | ----------------------------------------------- |
  | `heal_anomaly_detected`    | Each new anomaly classified                     |
  | `heal_remediation_started` | Each runbook execution begins                   |
  | `heal_remediation_success` | Remediation verified as resolved                |
  | `heal_remediation_failed`  | Remediation completed but probe still fails     |
  | `heal_escalation_fired`    | Each escalation to tier 1+                      |
  | `heal_signal_sent`         | Each tier-3 Signal notification                 |
  | `heal_runbook_created`     | Each new runbook drafted                        |
  | `heal_runbook_graduated`   | Runbook transitions from dry_run → auto_execute |

- **`cortex stats` extension**: Add `self_healing_status` section to `brain_api.py` returning: open incident count, runbook count by mode, last remediation timestamp, last escalation timestamp.
- **Priority**: MEDIUM
- **Testable**: Each metric event produces a timestamped record in the metrics DB.

---

## Non-Functional Requirements

### NFR-001: Safety-First Execution

- The healing engine MUST NEVER execute shell commands that weren't pre-defined in a registered runbook step. Dynamic command construction from anomaly data is PROHIBITED.
- All runbook steps must be reviewed by a human (Matthew approval) before graduating to auto-execute mode, EXCEPT for explicitly whitelisted safe operations (log rotation, process restart of known services).
- **Whitelist for auto-approval**: `rb-rotate-logs`, `rb-gc-trigger` (notify only). Everything else requires explicit approval or tier-3 escalation.

### NFR-002: Zero False-Action Rate

- The system MUST verify the anomaly condition is still active immediately before executing remediation. If the condition self-resolved, skip execution and close the incident as `self_resolved`.
- Minimum 3 consecutive positive probe readings (at 30s intervals) required before classifying an intermittent anomaly as cleared.

### NFR-003: Observability Without Noise

- Tier-0 actions (silent auto-fix) MUST write a compact audit entry to brain.db but produce no Signal or Synapse messages.
- Tier-1/2 Synapse messages MUST include: anomaly description, action taken, verification status, and current incident state.
- Signal messages (tier-3) MUST be written in plain language: what broke, what was tried, and exactly what Matthew needs to decide.

### NFR-004: Integration Touchpoints

- Self-healing probes MUST reuse data already collected by predictive intent adapters (specifically `fleet-adapter.ts`, `augur-signals-adapter.ts`, `pipeline-adapter.ts`) to avoid duplicate polling overhead.
- Where a new probe is required, it MUST implement `DataSourceAdapter` from `predictive/data-sources/adapter-interface.ts` so it can be registered in the PollingEngine if needed in future.

---

## Acceptance Criteria

| ID     | Criterion                                                                                   |
| ------ | ------------------------------------------------------------------------------------------- |
| AC-001 | AUGUR process death → runbook executes within 30s → process restarted → verified within 60s |
| AC-002 | Pipeline stuck → Synapse alert fires with stage details within 2min of threshold            |
| AC-003 | Disk > 85% → log rotation executes silently → Synapse summary sent                          |
| AC-004 | Disk > 95% → Signal notification fires; Matthew receives plain-language description         |
| AC-005 | DB corruption detected → writes halted immediately → Signal notification fires              |
| AC-006 | Matthew fixes an open incident manually → runbook draft created in dry_run mode             |
| AC-007 | Matthew approves runbook → mode transitions to auto_execute                                 |
| AC-008 | Runbook dry-run executes cleanly for 3 consecutive matching incidents → auto-graduates      |
| AC-009 | `cortex_heal status` returns all open incidents with current state                          |
| AC-010 | Remediation self-resolves before execution → incident closed as `self_resolved`, no action  |
| AC-011 | Tier-3 escalation always produces Signal message even if Synapse send fails                 |

---

## Out of Scope

- Predictive intent polling (already in v2.1.0) — this feature builds ON TOP of it
- New types of memory storage — brain.db tables are additive only
- External alerting services (PagerDuty, etc.) — Signal is the terminal escalation channel
- Auto-healing of brain.db itself during active write sessions (BCDR handles that)
- Fleet-side remediation (SSHing to remote hosts and running repair commands) — not in v2.2.0

---

## Version and Branch

- **Release**: Cortex v2.2.0
- **Branch**: `feature/self-healing-v2.2.0`
- **Depends on**: Cortex v2.1.0 (predictive intent adapters), v1.5.0 (pre-action hooks), v1.3.0 (metrics writer)
