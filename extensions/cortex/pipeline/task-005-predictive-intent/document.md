# Predictive Intent — Act Before Asked: Documentation

**Task ID:** task-005-predictive-intent  
**Stage:** document  
**Author:** Documentation Specialist (Pipeline Orchestrator)  
**Date:** 2026-02-18  
**Cortex Target Version:** 2.1.0  
**Depends On:** Cortex v2.0.0 (session persistence), v1.5.0 (pre-action hooks), v1.3.0 (metrics), v1.2.0 (confidence scoring)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture Summary](#2-architecture-summary)
3. [API Reference — `cortex_predict` Tool](#3-api-reference--cortex_predict-tool)
4. [Configuration Reference](#4-configuration-reference)
5. [Data Source Adapters](#5-data-source-adapters)
6. [Insight Type Reference](#6-insight-type-reference)
7. [Urgency Scoring Reference](#7-urgency-scoring-reference)
8. [Delivery Channel Reference](#8-delivery-channel-reference)
9. [Feedback Tracking Reference](#9-feedback-tracking-reference)
10. [Briefing Templates](#10-briefing-templates)
11. [Behavioral Signatures (Version Forensics)](#11-behavioral-signatures-version-forensics)
12. [Failure Mode Signatures](#12-failure-mode-signatures)
13. [Debugging Hooks](#13-debugging-hooks)
14. [Migration Notes (v2.0.0 → v2.1.0)](#14-migration-notes-v200--v210)
15. [Rollback Plan](#15-rollback-plan)
16. [Searchable Feature Index](#16-searchable-feature-index)

---

## 1. Overview

Predictive Intent is the proactive intelligence layer of Cortex v2.1.0. It transforms Helios from a reactive assistant into one that anticipates needs and delivers relevant context **before Matthew asks**.

### What It Does

- **Polls 10 live data sources** continuously (AUGUR signals, open trades, market regime, git activity, fleet health, OctoPrint, pipeline state, session context, causal atoms)
- **Generates typed insights** (anomaly, opportunity, briefing, reminder, alert, pattern) and scores them on a 4-tier urgency scale
- **Routes insights** to the correct delivery channel based on urgency and session state — batching low-priority items, immediately escalating critical alerts to Signal
- **Learns** which insights Matthew acts on and reinforces those patterns via the `predict_action_rates` store and Cortex atoms
- **Integrates transparently** with pre-action hooks (v1.5.0): relevant high-urgency insights are injected into hook knowledge payloads before tool execution

### What It Does NOT Do

- Generate trading signals (AUGUR owns that — this system reads AUGUR output only)
- Write to AUGUR databases (strictly read-only via `file:path?mode=ro` SQLite URIs)
- Write to remote fleet hosts (SSH probes use `echo ok` — no parameterized commands)
- Modify existing session capture/restore logic
- Change pre-action hook enforcement decisions (insight injection is additive only)

### Version Forensics Tag

`cortex-v2.1.0` | `feature/predictive-intent-v2.1.0` | Phase 5.1 of IMPROVEMENT_PLAN

---

## 2. Architecture Summary

```
PollingEngine (per-source staggered timer loops)
    │
    ├── DataSourceAdapters (10 pluggable adapters)
    │       augur-signals, augur-trades, augur-regime, augur-paper
    │       git-activity, fleet-health, octoprint-jobs
    │       pipeline-state, cortex-session, cortex-atoms
    │
    ▼
InsightGenerator (raw reading → typed Insight records)
    │
    ▼
UrgencyScorer (4-tier: low/medium/high/critical + channel assignment)
    │
    ▼
DeliveryRouter (batching, dedup, focus-mode detection, channel dispatch)
    ├── signal (critical alerts)
    ├── in_session (high/medium, injected as assistant continuation)
    ├── synapse (high during sub-agent periods)
    └── preamble (low, batched to session start)
    │
    ├── FeedbackTracker (implicit + explicit action detection → action rates)
    │       └── PatternLearner (cross-session correlation → Cortex atoms)
    │
    └── BriefingGenerator (morning/pre-work/pipeline/pre-sleep briefings)
```

**Key state stores:**

- In-memory: `Map<string, Insight>` insight queue (sub-ms reads for `cortex_predict`)
- Persistent: `brain.db` — `insights`, `insight_feedback`, `predict_action_rates` tables (crash recovery, pattern learning)

---

## 3. API Reference — `cortex_predict` Tool

### Tool Name

`cortex_predict`

### Description

Query the Predictive Intent system for current insights. Returns scored, queued, or recently delivered insights relevant to the given context. Reads from in-memory queue — no re-polling triggered.

### Input Schema

```typescript
{
  query?: string;
  // Natural language filter. Matches against insight title, body, and source_id.
  // Example: "augur" returns insights from augur.* sources.

  sources?: string[];
  // Filter to specific source IDs.
  // Valid values: 'augur.signals' | 'augur.trades' | 'augur.regime' | 'augur.paper'
  //               'git.activity' | 'fleet.health' | 'octoprint.jobs'
  //               'pipeline.state' | 'cortex.session' | 'cortex.atoms'

  urgency_min?: 'low' | 'medium' | 'high' | 'critical';
  // Minimum urgency tier to return. 'high' returns high + critical insights only.

  include_queue?: boolean;
  // Default: false (returns only delivered insights).
  // Set true to include queued-but-not-yet-delivered insights.

  limit?: number;
  // Max insights to return. Default: 5. Results sorted by urgency_score descending.
}
```

### Output Schema

```typescript
{
  insights: Insight[];          // Sorted by urgency_score descending
  sources_polled: number;       // Count of registered source adapters
  sources_stale: string[];      // Source IDs with data older than freshness threshold
  last_poll: string | null;     // ISO 8601 timestamp of last completed poll cycle
  disabled?: boolean;           // Present and true only if predictive_intent.enabled = false
}
```

### Insight Record

```typescript
interface Insight {
  id: string; // UUID
  type: "anomaly" | "opportunity" | "briefing" | "reminder" | "alert" | "pattern";
  source_id: string; // e.g. 'augur.signals', 'fleet.health'
  title: string; // ≤80 chars, action-oriented
  body: string; // ≤500 chars, structured detail
  urgency: "low" | "medium" | "high" | "critical";
  urgency_score: number; // 0.0–1.0 computed score
  confidence: number; // 0.0–1.0
  actionable: boolean;
  expires_at: string | null; // ISO 8601; null = no expiry
  generated_at: string; // ISO 8601
  state: InsightState;
  delivery_channel: DeliveryChannel | null;
  delivered_at: string | null;
  session_id: string;
  schema_version: number; // Currently 1
}
```

### Usage Examples

**Before starting AUGUR work:**

```typescript
cortex_predict({ query: "augur", urgency_min: "medium" });
// Returns: open trade alerts, regime status, signal anomalies
```

**Check for critical items at any time:**

```typescript
cortex_predict({ urgency_min: "high", include_queue: true });
// Returns: all high + critical insights, including not-yet-delivered
```

**Fleet-specific check before SSH:**

```typescript
cortex_predict({ sources: ["fleet.health"], include_queue: true });
// Returns: fleet reachability insights; sources_stale lists any stale hosts
```

**Pre-action hook integration (automatic):**
When the enforcement engine intercepts an `exec` or SSH tool call, it automatically calls the equivalent of:

```typescript
cortex_predict({ query: extractedKeywords, urgency_min: "high", include_queue: true, limit: 3 });
```

…and injects the results into the hook knowledge payload under `predictive_insights`.

### Response Time

`cortex_predict` reads from the in-memory queue. Response time is <5ms regardless of how many sources are being polled.

---

## 4. Configuration Reference

All parameters live under `predictive_intent` in the Cortex plugin config (`openclaw.plugin.json`). No code changes required to adjust any threshold.

### Master Switch

```json
{ "predictive_intent": { "enabled": true } }
```

Setting `false` stops all polling immediately (via `pollingEngine.stop()`). Zero metrics emitted. `cortex_predict` returns `{ insights: [], disabled: true }`. All other Cortex tools behave identically to v2.0.0.

### Poll Intervals (ms)

| Source           | Default          | Min Recommended |
| ---------------- | ---------------- | --------------- |
| `augur.signals`  | 60,000 (1 min)   | 30,000          |
| `augur.trades`   | 300,000 (5 min)  | 60,000          |
| `augur.regime`   | 300,000 (5 min)  | 60,000          |
| `augur.paper`    | 900,000 (15 min) | 300,000         |
| `git.activity`   | 600,000 (10 min) | 120,000         |
| `fleet.health`   | 300,000 (5 min)  | 60,000          |
| `octoprint.jobs` | 300,000 (5 min)  | 60,000          |
| `pipeline.state` | 120,000 (2 min)  | 60,000          |
| `cortex.atoms`   | 600,000 (10 min) | 300,000         |

Note: `cortex.session` uses `poll_interval_ms: 0` — it's real-time in-process reads, not a timer loop.

### Urgency Thresholds

```json
{
  "urgency_thresholds": {
    "high": 0.6, // Score ≥ 0.60 → high; 0.60–0.84 range
    "critical": 0.85 // Score ≥ 0.85 → critical; triggers Signal
  }
}
```

To reduce Signal noise: raise `critical` to 0.92.  
To get more interrupts during active trading: lower `high` to 0.50.

### Delivery Settings

```json
{
  "delivery": {
    "signal_channel": "signal",
    "focus_detection_window_ms": 90000, // 90s sliding window for focus detection
    "focus_detection_min_calls": 3, // ≥3 tool calls in window = focus mode
    "batch_window_ms": 300000, // Batch low/medium for 5 min before flushing
    "duplicate_window_ms": 3600000 // Don't re-emit same insight within 1h
  }
}
```

### Anomaly Thresholds

```json
{
  "anomaly_thresholds": {
    "augur_signal_stale_ms": 300000, // 5 min → AUGUR pipeline stall alert
    "augur_loss_streak": 3, // 3 consecutive losses → alert
    "augur_pnl_loss_pct": 0.02, // −2% P&L → alert
    "fleet_ssh_timeout_ms": 5000, // SSH probe timeout
    "pipeline_stuck_ms": 3600000 // 60 min same stage → anomaly
  }
}
```

### Feedback Settings

```json
{
  "feedback": {
    "action_window_ms": 600000, // 10 min window for implicit action detection
    "rate_increase_per_act": 0.1, // Rate increases 0.1 per act
    "rate_decrease_per_ignore": 0.05, // Rate decreases 0.05 per ignore
    "min_observations": 20, // Minimum before halving low-value sources
    "low_value_threshold": 0.1 // Below 10% action rate → halve frequency
  }
}
```

### Briefing Settings

```json
{
  "briefings": {
    "morning_hour_est": 6, // Trigger after 6 AM EST
    "pre_sleep_idle_ms": 5400000, // 90 min idle → pre-sleep brief
    "suppression_window_ms": 14400000 // 4h suppression between same-type briefings
  }
}
```

### OctoPrint Settings

```json
{
  "octoprint": {
    "host": "http://192.168.10.141",
    "secrets_file": "~/.secrets/octoprint.env"
  }
}
```

Secrets file format: `OCTOPRINT_API_KEY=<key>`. chmod 600. If absent, adapter silently skips with `available: false`.

---

## 5. Data Source Adapters

Each adapter is a pluggable module implementing `DataSourceAdapter`. Failure in any adapter never delays others — all run independently.

### Source Inventory

| Source ID        | Adapter File                | What It Reads                               | Graceful Degradation       |
| ---------------- | --------------------------- | ------------------------------------------- | -------------------------- |
| `augur.signals`  | `augur-signals-adapter.ts`  | `~/Projects/augur-trading/live_signal.json` | File missing → skip        |
| `augur.trades`   | `augur-trades-adapter.ts`   | `live_trades.db` (read-only SQLite)         | DB missing → skip          |
| `augur.regime`   | `augur-regime-adapter.ts`   | `regime.json`                               | File missing → skip        |
| `augur.paper`    | `augur-paper-adapter.ts`    | `paper_results.db` (read-only SQLite)       | DB missing → skip          |
| `git.activity`   | `git-adapter.ts`            | `git log` across `~/Projects/` repos        | Command error → skip repo  |
| `fleet.health`   | `fleet-adapter.ts`          | SSH `echo ok` to each fleet host            | Host unreachable → anomaly |
| `octoprint.jobs` | `octoprint-adapter.ts`      | `GET /api/job`, `GET /api/printer`          | Host/key missing → skip    |
| `pipeline.state` | `pipeline-adapter.ts`       | `pipeline/state.json`                       | File missing → skip        |
| `cortex.session` | `cortex-session-adapter.ts` | `SessionState` (in-process)                 | No session → empty reading |
| `cortex.atoms`   | `cortex-atoms-adapter.ts`   | `atom_search` (in-process bridge)           | No atoms → empty reading   |

### Adding a New Source

1. Create `predictive/data-sources/my-source-adapter.ts` implementing `DataSourceAdapter`
2. Add default `poll_intervals_ms` and `staleness_thresholds_ms` entries to config
3. Register in `PollingEngine.start()` adapter registry
4. Add handler function in `InsightGenerator` for the new `source_id`
5. No other changes required — the polling loop is source-agnostic

### AUGUR Read-Only Enforcement

AUGUR SQLite DBs are opened with URI: `file:/path/to/db?mode=ro`. If any write is attempted (e.g., bad code path), sqlite3 throws `SQLITE_READONLY` immediately. This is logged as an adapter error; the cycle is skipped. The DB is never left open between polls (connection closed after each query).

### Fleet SSH Probe Details

```bash
ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no <host> echo ok
```

- `BatchMode=yes`: No interactive password prompts (fail immediately if key auth fails)
- `StrictHostKeyChecking=no`: Don't block on unknown hosts (fleet hosts already known)
- All probes run in parallel via `Promise.allSettled` — 5s timeout per host
- If `echo ok` succeeds: host healthy. If timeout or error: `anomaly` insight generated.

---

## 6. Insight Type Reference

### `anomaly`

Something unexpected or wrong detected across sources.

**Triggers**: AUGUR signal stale, regime flip, loss streak, SSH unreachable, OctoPrint job stopped unexpectedly, pipeline stage stuck, memory confidence collapse.

**Urgency range**: typically `high`–`critical`

**Example**:

```
[PREDICTIVE ALERT — HIGH]
AUGUR Pipeline Stall: live_signal.json not updated in 7 min
live_signal.json last modified: 2026-02-18T16:22:11-05:00 (7m ago). Pipeline may be dead on blackview.
Source: augur.signals | Confidence: 92% | Expires: 2026-02-18T17:30:00-05:00
```

---

### `opportunity`

Time-sensitive positive signal worth acting on.

**Triggers**: AUGUR signal with high historical win rate, paper trade hit rate above session average.

**Urgency range**: `medium`–`high` (higher if financial_impact > 0 and expires soon)

**Example**:

```
[PREDICTIVE ALERT — HIGH]
AUGUR BTC Long Setup: 87% historical win rate
Signal: BTC_USD long at 94,200. Confidence 0.91. Session paper win rate 73% vs this signal type's 87%.
Source: augur.signals | Confidence: 91% | Expires: 2026-02-18T17:00:00-05:00
```

---

### `briefing`

Scheduled synthesis of recent context.

**Triggers**: Morning session start, pre-work project switch, pipeline stage completion, pre-sleep idle.

**Urgency range**: `low`–`medium`

**Example**: See [Section 10 — Briefing Templates](#10-briefing-templates).

---

### `reminder`

Time-based recall of pending work or approaching deadlines.

**Triggers**: OctoPrint job nearing completion, pipeline stage approaching stuck threshold, pending tasks from prior session.

**Urgency range**: `low`–`high` (escalates as deadline approaches)

**Example**:

```
[PREDICTIVE ALERT — MEDIUM]
Desk Bot Print: 94% — check in ~15 min
Job: lbf_bracket_v3.gcode | ETA: 16:58 EST | Layer 247/263
Source: octoprint.jobs | Confidence: 95% | Expires: 2026-02-18T17:00:00-05:00
```

---

### `alert`

Requires immediate attention or user decision.

**Triggers**: Fleet host SSH unreachable, OctoPrint print failed, brain.db unreachable, pipeline stage failed.

**Urgency range**: `high`–`critical`

**Example**:

```
[PREDICTIVE ALERT — CRITICAL]
blackview SSH Unreachable: AUGUR pipeline may be dead
SSH probe to blackview timed out after 5s. AUGUR trading pipeline likely offline.
Source: fleet.health | Confidence: 100% | Expires: 2026-02-18T18:00:00-05:00
```

---

### `pattern`

Emerging behavioral or system pattern worth noting.

**Triggers**: PatternLearner detects cross-session correlation (≥3 observations). High-confidence atoms surface as insights when relevant context detected.

**Urgency range**: `low`–`medium`

**Example**:

```
[PREDICTIVE ALERT — LOW]
AUGUR Tuning Plateau Pattern: day 5 typically signals diminishing returns
3 prior AUGUR tuning sessions show pattern: plateau signals around day 4–6. You're on day 3.
Source: cortex.atoms | Confidence: 67% | Expires: none
```

---

## 7. Urgency Scoring Reference

### Formula

```
urgency_score =
  (time_sensitivity        × 0.40)
+ (financial_impact        × 0.30)
+ (historical_action_rate  × 0.20)
+ (cross_source_confirmation × 0.10)
```

### Component Calculation

**time_sensitivity** (0.0–1.0):

- `expires_at` within 15 min: **1.0**
- `expires_at` within 1 hour: **0.6**
- `expires_at` within 24 hours: **0.2**
- No expiry: **0.0**

**financial_impact** (0.0–1.0):

- Involves open money/active trades: **1.0**
- Potential trade opportunity: **0.5**
- No financial connection: **0.0**

**historical_action_rate** (0.0–1.0):

- Fraction of similar past insights Matthew acted on (from `predict_action_rates` table)
- Starts at **0.0** for new source+type combinations
- Cold-start behavior: new sources score lower until observed behavior establishes the rate

**cross_source_confirmation** (0.0–1.0):

- Fraction of other active sources that independently confirm this signal
- Example: fleet adapter AND cortex.session both flag blackview → 0.5 (2 of 4 active sources)

### Tier Boundaries

| Score     | Tier       | Delivery                                              |
| --------- | ---------- | ----------------------------------------------------- |
| 0.0–0.29  | `low`      | Session preamble (batched)                            |
| 0.30–0.59 | `medium`   | In-session at next pause (deferred during focus mode) |
| 0.60–0.84 | `high`     | In-session within 2 min (interrupts focus)            |
| 0.85–1.0  | `critical` | Signal message immediately                            |

### Score Examples

| Scenario                                     | time_sensitivity | financial_impact | action_rate | cross_src | Score | Tier     |
| -------------------------------------------- | ---------------- | ---------------- | ----------- | --------- | ----- | -------- |
| Open trade -2% loss, expires in 10 min       | 1.0              | 1.0              | 0.8         | 0.3       | 0.94  | critical |
| AUGUR signal, no position yet, 45 min window | 0.6              | 0.5              | 0.5         | 0.2       | 0.51  | medium   |
| Git activity pattern, no financial link      | 0.0              | 0.0              | 0.3         | 0.1       | 0.07  | low      |
| Fleet SSH unreachable, active pipeline       | 0.6              | 0.5              | 0.7         | 0.5       | 0.73  | high     |

### Re-scoring

Insights are re-scored on every poll cycle. A `high` insight can decay to `medium` if:

- `expires_at` moves from <1h to >24h window (time_sensitivity drops)
- No second source confirms it (cross_source_confirmation drops)

An insight never re-escalates once delivered (`delivered` state is final — a new insight supersedes it).

---

## 8. Delivery Channel Reference

### Channel Routing Logic

```
critical → Signal (immediate, rate-limited 1/5min per source)
high     → in_session (within 2 min; if sub-agent active: Synapse)
medium   → in_session (deferred if focus mode active)
low      → preamble (batched; flush at session start or after focus mode ends)
```

### Focus Mode Detection

The `FocusModeTracker` singleton ticks on every `before_tool_call` event. A **sliding 90-second window** is maintained. If ≥3 tool calls occur within 90 seconds: focus mode is active.

During focus mode:

- `medium` insights are held in batch buffer (not delivered)
- `high` insights still deliver (they interrupt focus — that's intentional)
- `critical` insights always deliver immediately

Focus mode ends when the 90-second window clears (no tool calls for 90+ seconds). At that point, the batch buffer is flushed.

### In-Session Injection Format

```
[PREDICTIVE ALERT — {URGENCY}]
{title}
{body}
Source: {source_id} | Confidence: {confidence}% | Expires: {expires_at}
```

### Signal Rate Limiting

Critical Signal messages are rate-limited to **1 per 5 minutes per source_id**. This hard cap is not configurable below 30 seconds (minimum guard). If a second critical insight from the same source fires within 5 minutes, it is held as `high` urgency and delivered in-session instead.

### Batch Flush Trigger Points

1. `before_agent_start` hook (session preamble)
2. Focus mode window clears (90s no tool calls)
3. Explicit `cortex_predict({ include_queue: true })` call
4. Manual: `delivery_router.flushBatch()` (internal API)

### Deduplication

Same `source_id + insight_type` combination is suppressed within `duplicate_window_ms` (default: 1 hour) unless the underlying data changes materially (>10% delta for numeric, state change for categorical). Superseded insights transition to `superseded` state.

---

## 9. Feedback Tracking Reference

### How Actions Are Detected

**Explicit detection** (`after_agent_turn`):
Matthew's reply is scanned for acknowledgment phrases within one turn of a delivered insight:

- Triggers: "ok", "got it", "done", "noted", "acknowledged", "thanks", "will do", "on it"
- Result: `InsightFeedback { acted_on: true, action_type: 'explicit' }`

**Implicit detection** (`after_tool_call`, 10-minute window):
Tool call subject matter is matched against delivered insights:

- `exec` or SSH call mentioning a fleet host → matches `fleet.health` insight about that host
- AUGUR-related script execution → matches `augur.*` insights
- `pipeline-stage-done` call → matches `pipeline.state` insights
- Result: `InsightFeedback { acted_on: true, action_type: 'implicit' }`

**Ignored** (no action within `expires_at` or `action_window_ms`):

- Result: `InsightFeedback { acted_on: false, action_type: 'ignored' }`

### Action Rate Updates

After each feedback record:

```
acted_on = true  → rate += 0.1  (max 1.0)
acted_on = false → rate -= 0.05 (floor 0.0)
```

Rate is maintained per `(source_id, insight_type)` pair in `predict_action_rates` table.

**Auto-halving trigger**: If after ≥20 observations the rate is still < 0.10, the poll interval for that source+type is automatically halved (less frequent polling). Metric `predict_rate_halved` is emitted. This prevents useless noise from persistently-ignored sources.

### Pattern Learning Trigger

After every `acted_on=true` feedback write:

1. PatternLearner queries feedback history for the same `(source_id, insight_type)` pair
2. If ≥3 observations found → calculate rolling action rate
3. If rate ≥ 0.30 and no atom exists yet → create atom via `atom_create`:
   - `subject`: source_id
   - `action`: `generates {insight_type} insight`
   - `outcome`: `Matthew acts on it {rate}% of the time`
   - `consequences`: predictive scoring should use this rate for future insights
   - `source`: `'predictive-intent'` (tagged for isolation from hand-curated atoms)
4. Atoms with confidence ≥ 0.30 feed back into urgency scoring (`historical_action_rate` component)

### brain.db Schema (insight_feedback table)

```sql
insight_id TEXT NOT NULL          -- FK → insights.id
insight_type TEXT NOT NULL
source_id TEXT NOT NULL
urgency_at_delivery TEXT NOT NULL
delivered_at TEXT NOT NULL
channel TEXT NOT NULL
acted_on INTEGER NOT NULL         -- 0 | 1
action_type TEXT NOT NULL         -- 'explicit' | 'implicit' | 'ignored'
latency_ms INTEGER                -- NULL if ignored
session_id TEXT NOT NULL
created_at TEXT NOT NULL
```

---

## 10. Briefing Templates

### Morning Brief

**Trigger**: First session start after `morning_hour_est` (default: 6 AM EST), on a new calendar day.  
**Suppression**: If delivered within prior 4 hours, suppress.

```
[MORNING BRIEF — {WEEKDAY}, {DATE}]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AUGUR    {regime} | {open_positions} open positions | {pnl_24h} P&L (24h)
FLEET    {healthy_count}/{total_count} hosts healthy{unhealthy_suffix}
PIPELINE {task_id} at {stage} stage{stuck_suffix}
PRINT    {job_name} — {pct_complete}% done (ETA {eta})  [or: No active print job]
PENDING  {pending_count} tasks from prior session(s)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Top memory: {highest_confidence_insight_text}
```

Where:

- `{unhealthy_suffix}`: ` ⚠ ({host_list} unreachable)` if any hosts down, else blank
- `{stuck_suffix}`: ` ⚠ (stuck {duration})` if pipeline_stuck_ms exceeded, else blank

---

### Pre-Work Brief

**Trigger**: `before_tool_call` for `exec` tool where the command path matches a known project directory (regex: `~/Projects/[a-z-]+`).  
**Suppression**: Same project brief not repeated within 4 hours.

```
[PRE-WORK BRIEF — {project_name}]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECENT COMMITS ({n}):
  {commit_hash} {author}: {message}
  ...

RELEVANT SOPs: {sop_list or 'none found'}
FLEET DEPS:    {relevant_hosts_status}
AUGUR:         {augur_status if trading-adjacent, else 'N/A'}
PENDING:       {pending_tasks_for_this_project}
```

---

### Pipeline Stage Completion Brief

**Trigger**: `pipeline-adapter.ts` detects a `current_stage` change in `state.json`.  
**Suppression**: Not suppressed (each stage transition is a unique event).

```
[PIPELINE UPDATE — task-{id}: {title}]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPLETED: {prior_stage} ✓
NEXT:      {current_stage}
STAGES:    [{completed_list}] → {current_stage} → [{remaining_list}]
BLOCKERS:  {blockers_from_prior_artifact or 'None detected'}
ETA:       ~{estimated_duration} (based on prior task durations)
```

---

### Pre-Sleep Brief

**Trigger**: ≥90 minutes of session idle (no tool calls). Checked every 15 minutes via low-frequency timer.  
**Suppression**: If delivered within prior 4 hours, or if no session active today.

```
[PRE-SLEEP BRIEF — {TIME}]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SESSION SUMMARY:
  {tool_call_count} tool calls | {task_count} tasks completed | {duration}

UNFINISHED:
  {unfinished_task_list or 'Nothing pending'}

TIME-SENSITIVE (expiring overnight):
  {expiring_insights or 'Nothing critical'}

AUGUR:  {regime} | {overnight_context}
FLEET:  {status_summary}
```

---

## 11. Behavioral Signatures (Version Forensics)

These patterns confirm Predictive Intent is working correctly. Use grep commands to verify during debugging.

### Startup (v2.1.0)

**Expected log pattern** (within 10s of `registerService.start()`):

```
[cortex:predict] PollingEngine started — 10 adapters registered
[cortex:predict] poll:augur.signals scheduled (60000ms interval)
[cortex:predict] poll:fleet.health scheduled (300000ms interval)
[cortex:predict] poll:pipeline.state scheduled (120000ms interval)
... (10 lines total, one per adapter)
[cortex:predict] Briefing check: morning brief [triggered|suppressed|not-applicable]
```

Grep: `grep "cortex:predict.*PollingEngine started" ~/.openclaw/logs/cortex.log`

### Poll Cycle

**Expected log pattern** (repeating, once per source per interval):

```
[cortex:predict] poll:augur.signals complete — available:true freshness:45000ms
[cortex:predict] insight generated — type:anomaly source:augur.signals urgency:high id:abc123
[cortex:predict] insight scored — id:abc123 score:0.72 tier:high channel:in_session
```

Grep: `grep "cortex:predict.*poll:" ~/.openclaw/logs/cortex.log | tail -20`

### Delivery

**Expected log pattern**:

```
[cortex:predict] delivering — id:abc123 channel:in_session title:"AUGUR Pipeline Stall..."
[cortex:predict] delivered — id:abc123 channel:in_session latency:1234ms
```

For Signal:

```
[cortex:predict] delivering — id:xyz789 channel:signal (critical) title:"blackview SSH Unreachable..."
[cortex:predict] signal rate check — source:fleet.health last_signal:never → proceed
[cortex:predict] delivered — id:xyz789 channel:signal
```

Grep: `grep "cortex:predict.*deliver" ~/.openclaw/logs/cortex.log | tail -20`

### Feedback

**Expected log pattern**:

```
[cortex:predict] feedback:implicit — insight:abc123 tool:exec matched:fleet.health latency:324000ms
[cortex:predict] action_rate updated — source:fleet.health type:alert 0.00→0.10 (count:1)
```

Grep: `grep "cortex:predict.*feedback" ~/.openclaw/logs/cortex.log | tail -20`

### Pattern Learning

**Expected log pattern** (after ≥3 acted-on observations):

```
[cortex:predict] pattern:candidate — source:augur.signals type:opportunity observations:3 rate:0.60
[cortex:predict] atom created — id:atom_uuid source:predictive-intent confidence:0.60
```

Grep: `grep "cortex:predict.*atom" ~/.openclaw/logs/cortex.log`

### Disabled Mode

**Expected log pattern** (when `enabled: false`):

```
[cortex:predict] disabled — skipping PollingEngine init
```

Zero additional predict-related logs.

---

## 12. Failure Mode Signatures

### FM-001: Polling Engine Not Starting

**Symptom**: No `PollingEngine started` log line within 30 seconds of gateway start.

**Cause candidates**:

1. `registerService.start()` threw before reaching predictive intent init
2. Config parse error in `predictive_intent` block
3. `enabled` is `false` in config

**Detection**: `grep "cortex:predict" ~/.openclaw/logs/cortex.log` returns empty or only `disabled` line.

**Fix**:

```bash
openclaw gateway status
grep "cortex:plugin:error" ~/.openclaw/logs/cortex.log | tail -5
```

Check for JSON parse errors in `openclaw.plugin.json`.

---

### FM-002: Source Silently Stale (adapter not polling)

**Symptom**: `sources_stale` in `cortex_predict` output consistently lists a source. No adapter errors logged.

**Cause candidates**:

1. File/DB path missing (graceful degradation — adapter skips without error)
2. Timer drift (slow poll took longer than interval, next timer not scheduled)

**Detection**: `grep "cortex:predict.*poll:{source_id}" ~/.openclaw/logs/cortex.log` — check if timestamps are advancing.

**Fix**: Timer drift is self-correcting (next `setTimeout` scheduled on completion). If file missing, verify the path in config. For AUGUR sources: confirm AUGUR is running on expected host.

---

### FM-003: Critical Insight Not Reaching Signal

**Symptom**: `cortex_predict({ urgency_min: "critical" })` returns insights, but no Signal message received.

**Cause candidates**:

1. Signal rate limiting: another critical insight from same source sent within 5 minutes
2. `delivery.signal_channel` config mismatch
3. OpenClaw `message` plugin error (check message tool logs)

**Detection**:

```bash
grep "cortex:predict.*signal rate check" ~/.openclaw/logs/cortex.log | tail -5
```

If `suppressed` appears: rate limit active.

**Fix**: Wait 5 minutes. For testing: manually bump `signal_channel` to match active channel name.

---

### FM-004: Duplicate Insights Flooding Queue

**Symptom**: `cortex_predict({ include_queue: true })` returns many identical insights.

**Cause candidates**:

1. `duplicate_window_ms` set to 0 (misconfiguration)
2. Dedup check failing because `source_id` or `type` differs slightly between duplicates

**Detection**: `grep "cortex:predict.*insight generated" ~/.openclaw/logs/cortex.log | grep "source:augur" | wc -l` — compare count vs expected poll cycles.

**Fix**: Check config `duplicate_window_ms`. Verify handler `isDuplicate()` call is receiving the correct `existingInsights` slice.

---

### FM-005: brain.db Locking (insight writes blocked by memory ops)

**Symptom**: `cortex_predict` responds normally but delivered insights are not persisted in brain.db (state not recovered after restart).

**Cause candidates**:

1. `PredictManager.save_insight()` Python call failing silently (connection timeout)
2. brain.db WAL checkpoint blocking write

**Detection**: `grep "cortex:bridge:predict" ~/.openclaw/logs/cortex.log | grep "error"`.

**Fix**: All predict writes are batched and use the same `runPython()` bridge as other Cortex tools. If WAL checkpoint blocking: `PRAGMA wal_checkpoint(RESTART)` on brain.db.

---

### FM-006: Pattern Learning Atom Explosion

**Symptom**: `atom_stats` shows rapidly growing atom count tagged `source: 'predictive-intent'`.

**Cause candidates**:

1. `min_observations` set too low (< 3)
2. Feedback tracker incorrectly detecting implicit actions

**Detection**: `atom_search('subject', 'augur.signals')` — count atoms tagged `predictive-intent`.

**Fix**: Raise `min_observations` to 10. Review implicit detection keyword mapping for false positives.

---

## 13. Debugging Hooks

### Enable Debug Mode

```json
{ "predictive_intent": { "debug": true } }
```

Or via environment variable (no restart required for env var):

```bash
CORTEX_PREDICT_DEBUG=1 openclaw gateway restart
```

In debug mode, every log line includes:

- Raw reading values from each source
- Scoring component breakdown per insight
- Delivery decision trace (why channel X was chosen)
- Implicit action matching trace (which tool calls were checked, which matched)

---

### Grep Commands

```bash
# All predict activity (last 50 lines):
grep "cortex:predict" ~/.openclaw/logs/cortex.log | tail -50

# Poll cycle health (one line per source per cycle):
grep "cortex:predict.*poll:.*complete" ~/.openclaw/logs/cortex.log | tail -20

# Insights generated in last session:
grep "cortex:predict.*insight generated" ~/.openclaw/logs/cortex.log | grep "$(date +%Y-%m-%d)"

# Critical alerts sent to Signal:
grep "cortex:predict.*channel:signal" ~/.openclaw/logs/cortex.log

# Feedback tracking (did actions register?):
grep "cortex:predict.*feedback" ~/.openclaw/logs/cortex.log | tail -20

# Action rate table (Python layer):
python3 -c "
import sys; sys.path.insert(0, '/home/bonsaihorn/Projects/helios/extensions/cortex/python')
from predict_manager import PredictManager
pm = PredictManager()
rates = pm.get_all_action_rates()
for r in rates: print(f\"{r['source_id']}:{r['insight_type']} = {r['action_rate']:.2f} ({r['observation_count']} obs)\")
"

# Stale sources (from live tool call):
# → cortex_predict({ limit: 1 })  # Check sources_stale field in output

# Focus mode state (from log):
grep "cortex:predict.*focus" ~/.openclaw/logs/cortex.log | tail -5
```

---

### cortex stats Extension

After v2.1.0 is deployed, `cortex stats` CLI shows:

```
PREDICTIVE INTENT
  Status:      enabled
  Last poll:   2026-02-18T16:39:00-05:00 (43s ago)
  Queue:       2 insights queued (1 low, 1 medium)
  Sources:     10 registered / 0 stale
  Feedback:    47 records (31 acted, 16 ignored) — 66% action rate
  Atoms:       3 pattern atoms created (source: predictive-intent)
```

---

## 14. Migration Notes (v2.0.0 → v2.1.0)

### brain.db Schema Changes

Three new tables added via `CREATE TABLE IF NOT EXISTS` — fully idempotent on existing databases:

- `insights` — insight lifecycle records
- `insight_feedback` — user action history
- `predict_action_rates` — rolling action rates per source+type pair

**Migration is automatic**: tables are created on first startup of v2.1.0. No manual migration step. No existing data modified. Full rollback available (see Section 15).

### index.ts Changes

**Additive only**:

- New `cortex_predict` tool registration
- `PollingEngine` init/stop in `registerService.start()/stop()`
- `FocusModeTracker.tick()` in `before_tool_call` (one line, before existing logic)
- Insight injection in `before_tool_call` knowledge payload (additive section, not replacing)
- Batch flush in `before_agent_start` (appended to preamble text, not replacing)

### hooks/enforcement-engine.ts Changes

**Additive only**: New Step 4 after existing SOP/knowledge-discovery steps. If `pollingEngine` is null (disabled), the step is a no-op. Blocking logic, allowed/denied decisions, and all existing enforcement behavior is unchanged.

### config/openclaw.plugin.json Changes

New `predictive_intent` top-level key with all defaults. Existing config keys untouched.

### Backward Compatibility

With `predictive_intent.enabled = false` (or the key absent entirely), v2.1.0 is **behavior-identical to v2.0.0** for all existing tools and hooks. Zero regressions possible in disabled mode.

---

## 15. Rollback Plan

### If build stage reveals critical issue:

1. Set `predictive_intent.enabled = false` in `openclaw.plugin.json`
2. Restart gateway: `openclaw gateway restart`
3. All behavior reverts to Cortex v2.0.0 immediately
4. No brain.db cleanup required (new tables are inert when disabled)

### Full code rollback:

```bash
cd ~/Projects/helios/extensions/cortex
git checkout cortex-v2.0.0        # Back to v2.0.0 tag
git checkout -- .                  # Reset working tree
openclaw gateway restart
```

### brain.db cleanup (if desired):

```sql
-- Connect to brain.db and run:
DROP TABLE IF EXISTS insights;
DROP TABLE IF EXISTS insight_feedback;
DROP TABLE IF EXISTS predict_action_rates;
```

No other tables are affected. STM, atoms, session_states, working_memory — all untouched.

---

## 16. Searchable Feature Index

For grep-based discovery: `grep "<KEYWORD>" {path}/document.md`

| Feature                 | Keyword                     | Section |
| ----------------------- | --------------------------- | ------- |
| Multi-source polling    | `PREDICT:POLLING`           | §2, §5  |
| Insight types           | `PREDICT:INSIGHT_TYPES`     | §6      |
| Urgency formula         | `PREDICT:URGENCY_FORMULA`   | §7      |
| Focus mode detection    | `PREDICT:FOCUS_MODE`        | §8      |
| Signal rate limiting    | `PREDICT:SIGNAL_RATE_LIMIT` | §8      |
| Feedback tracking       | `PREDICT:FEEDBACK`          | §9      |
| Pattern learning atoms  | `PREDICT:PATTERN_ATOMS`     | §9      |
| Morning brief           | `PREDICT:MORNING_BRIEF`     | §10     |
| Pre-work brief          | `PREDICT:PREWORK_BRIEF`     | §10     |
| Pipeline brief          | `PREDICT:PIPELINE_BRIEF`    | §10     |
| Pre-sleep brief         | `PREDICT:PRESLEEP_BRIEF`    | §10     |
| Behavioral signatures   | `PREDICT:SIGNATURES`        | §11     |
| Failure modes           | `PREDICT:FAILURE_MODES`     | §12     |
| Debugging               | `PREDICT:DEBUG`             | §13     |
| brain.db migration      | `PREDICT:MIGRATION`         | §14     |
| Rollback                | `PREDICT:ROLLBACK`          | §15     |
| AUGUR read-only safety  | `PREDICT:AUGUR_READONLY`    | §5      |
| OctoPrint secrets       | `PREDICT:OCTOPRINT_SECRETS` | §4, §5  |
| cortex_predict tool     | `PREDICT:TOOL_API`          | §3      |
| Configuration reference | `PREDICT:CONFIG`            | §4      |

---

_Document stage complete. Artifact: `pipeline/task-005-predictive-intent/document.md`_  
_Next stage: build_
