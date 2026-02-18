# Predictive Intent — Act Before Asked: Requirements Document

**Task ID:** task-005-predictive-intent  
**Phase:** 5.1 — Game-Changer Features  
**Author:** Requirements Analyst (Sub-Agent)  
**Date:** 2026-02-18  
**Cortex Version:** 2.0.0 → 2.1.0  
**OpenClaw Compatibility:** Plugin API v2.x+  
**Dependencies:** Cortex v2.0.0 (session persistence), v1.5.0 (pre-action hooks), v1.3.0 (metrics), v1.2.0 (confidence scoring)

---

## Summary

Predictive Intent makes Helios proactive rather than purely reactive. The system continuously monitors multiple live data sources — AUGUR trading signals, git repository activity, fleet health, OctoPrint jobs, session context, and Cortex memory patterns — and synthesizes cross-source signals into time-aware insights that are delivered before Matthew asks for them. Critically, the system learns which predictions Matthew acts on and reinforces those patterns, creating a feedback loop that improves prediction quality over time. The result: relevant briefings arrive at the right moment, anomaly alerts surface before manual investigation, and the cognitive overhead of "checking everything before starting work" is eliminated.

This is NOT a monitoring dashboard. It is a **prediction and delivery system**: the engine decides what to say, when to say it, and at what priority — and gets smarter about all three dimensions with each interaction.

---

## Functional Requirements

### FR-001: Multi-Source Context Fusion Engine

- **Requirement**: The system MUST continuously poll and aggregate data from at least the following sources:

  | Source ID         | Data Accessed                                               | Poll Interval |
  | ----------------- | ----------------------------------------------------------- | ------------- |
  | `augur.signals`   | `~/Projects/augur-trading/live_signal.json`                 | 60s           |
  | `augur.trades`    | `live_trades.db` — open positions, P&L since session start  | 5 min         |
  | `augur.regime`    | `regime.json` — current market regime                       | 5 min         |
  | `augur.paper`     | `paper_results.db` — paper trade stats                      | 15 min        |
  | `git.activity`    | Recent commits across `~/Projects/` repos                   | 10 min        |
  | `fleet.health`    | SSH reachability, service status on known hosts             | 5 min         |
  | `octoprint.jobs`  | Active print job status (% complete, estimated end)         | 5 min         |
  | `pipeline.state`  | Cortex pipeline `state.json` — stage progress               | 2 min         |
  | `cortex.session`  | Hot topics, working memory, pending tasks from SessionState | real-time     |
  | `cortex.atoms`    | Causal chain patterns relevant to active context            | 10 min        |
  | `cortex.memories` | High-confidence memories in active-project categories       | 15 min        |

- **Freshness Tracking**: Each reading must carry a `captured_at` timestamp and a `freshness_ms` staleness threshold. Readings older than their threshold are flagged as stale and excluded from predictions unless no fresh data is available.
- **Graceful Degradation**: If a source is unavailable (host unreachable, file missing, service down), that source is silently skipped for prediction. Its unavailability is itself a potential insight (see FR-004 anomaly detection).
- **Priority**: CRITICAL
- **Testable**: After startup, polling loop produces structured readings for ≥ 5 sources within 2 minutes; stale readings excluded from synthesis step.

---

### FR-002: Insight Generation — Prediction Types

- **Requirement**: The system MUST generate insights of the following types:

  | Type          | Description                                                 | Example                                                                  |
  | ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
  | `anomaly`     | Something unexpected or wrong detected across sources       | "AUGUR regime flipped to BEARISH — paper trades paused"                  |
  | `opportunity` | Time-sensitive positive signal worth acting on              | "AUGUR showing BTC long setup — 87% historical win rate"                 |
  | `briefing`    | Scheduled synthesis of recent context before a session/task | "Morning brief: 3 open trades, fleet healthy, 1 pipeline task waiting"   |
  | `reminder`    | Time-based recall of pending work or approaching deadlines  | "Desk bot print job 94% — check in 15 min"                               |
  | `alert`       | Requires immediate attention or user decision               | "blackview SSH unreachable — AUGUR pipeline may be dead"                 |
  | `pattern`     | Emerging behavioral or system pattern worth noting          | "You're 3 days into AUGUR tuning — typical plateau signals around day 5" |

- **Deduplication**: The system MUST NOT emit the same insight twice within a 60-minute window unless the underlying data changes materially (>10% delta for numeric values, state change for categorical values).
- **Expiry**: Every insight MUST have an `expires_at` timestamp — insights that are no longer actionable are silently dropped, not delivered.
- **Priority**: CRITICAL
- **Testable**: Over a 30-minute observation window, each source produces correctly typed insights; duplicate suppression prevents re-emission within 60 minutes for unchanged data.

---

### FR-003: Urgency Scoring Algorithm

- **Requirement**: The system MUST score every generated insight on a four-tier urgency scale and apply delivery routing based on that score.

  **Urgency Levels**:

  | Level      | Score Range | Delivery Route            | Interrupt Threshold |
  | ---------- | ----------- | ------------------------- | ------------------- |
  | `low`      | 0.0–0.29    | Session preamble or queue | Never interrupt     |
  | `medium`   | 0.30–0.59   | Next natural pause        | Defer during focus  |
  | `high`     | 0.60–0.84   | In-session, within 2 min  | Interrupt focus     |
  | `critical` | 0.85–1.0    | Immediate Signal message  | Always interrupt    |

  **Urgency Score Formula**:

  ```
  urgency = (time_sensitivity × 0.40)
           + (financial_impact × 0.30)
           + (historical_action_rate × 0.20)
           + (cross_source_confirmation × 0.10)

  time_sensitivity:          1.0 if expires in <15 min; 0.6 if <1h; 0.2 if <24h; 0.0 if no expiry
  financial_impact:          1.0 if involves open money/trades; 0.5 if potential trade; 0.0 otherwise
  historical_action_rate:    fraction of similar past insights that Matthew acted on (from feedback store)
  cross_source_confirmation: fraction of data sources that agree on this signal (0–1)
  ```

- **Score Persistence**: Urgency scores are recalculated on each poll cycle; a `high` insight that expires without action decays to `low` rather than staying elevated.
- **Priority**: HIGH
- **Testable**: Given two identical insights — one for an open trade expiring in 5 min, one for a low-stakes pattern — they score in different urgency tiers; routing rules apply correctly.

---

### FR-004: Anomaly Detection

- **Requirement**: The system MUST detect and generate `anomaly` insights for the following conditions automatically:

  **AUGUR Anomalies**:
  - `live_signal.json` not updated within 5 minutes (pipeline stall)
  - Market regime flip (BULLISH↔BEARISH↔NEUTRAL) since last check
  - Paper trade loss streak ≥ 3 consecutive trades (session-scoped)
  - Open position P&L below −2% threshold
  - Signal confidence score drops below configured minimum threshold

  **Fleet Anomalies**:
  - Any host in fleet inventory unreachable via SSH (test with timeout 5s)
  - OctoPrint print job failure or unexpected stop
  - Print job completion (positive alert — "desk bot done")
  - Disk usage spike or service restart detected

  **Pipeline Anomalies**:
  - Cortex pipeline task stuck in same stage for >60 minutes
  - Pipeline stage failed (result=fail in state.json)
  - Sub-agent not posting to Synapse within expected window

  **Memory/Knowledge Anomalies**:
  - Memory confidence score falls below 0.4 for a `critical`-tagged memory
  - Contradiction detected between two high-confidence memories in same category
  - Brain.db unreachable or corrupted

- **Anomaly Thresholds**: All numeric thresholds MUST be externally configurable in the predictive intent config block without code changes.
- **Priority**: HIGH
- **Testable**: Simulate each anomaly condition; verify correct `anomaly` insight generated with expected urgency tier within one poll cycle.

---

### FR-005: Scheduled Proactive Briefings

- **Requirement**: The system MUST generate the following scheduled briefings automatically:

  **Morning Brief** (triggered at first session of the day OR first session after 6 AM EST):

  ```
  [MORNING BRIEF — {date}]
  AUGUR: {regime}, {open_positions} open, {pnl_24h} P&L (24h)
  FLEET: {healthy_count}/{total_count} hosts healthy
  PIPELINE: {in_progress_task} at {stage} stage
  PRINT: {job_status} ({pct_complete}% done, ETA {eta})
  PENDING: {pending_task_count} tasks from prior session(s)
  TOP MEMORY: {highest_confidence_insight_for_active_projects}
  ```

  **Pre-Work Brief** (triggered when new working memory pin is added or new project directory accessed):
  - Relevant SOPs for detected project
  - Recent git commits to that project (last 3, any by others)
  - Fleet status for hosts the project uses
  - Active AUGUR signals if trading-adjacent

  **Pipeline Stage Completion Brief** (triggered when a stage transitions in state.json):
  - What completed, what's next
  - Any blockers detected in prior stage artifacts
  - Estimated time to next stage based on prior task durations

  **Pre-Sleep Brief** (triggered when no activity for 90+ minutes, optional):
  - Summary of session activity
  - Unfinished tasks to surface next session
  - Any time-sensitive items expiring overnight

- **Briefing Suppression**: If the most recent briefing of the same type was delivered within 4 hours, suppress (don't duplicate).
- **Priority**: HIGH
- **Testable**: Morning session start after 6 AM triggers morning brief with correct data from each source; repeat trigger within 4h produces no second brief.

---

### FR-006: Insight Delivery System

- **Requirement**: The system MUST deliver insights through the correct channel based on urgency level and session state.

  **Delivery Channels**:

  | Channel           | When Used                                                          |
  | ----------------- | ------------------------------------------------------------------ |
  | Session preamble  | `low` urgency; queued for next natural session start               |
  | In-session inject | `medium` / `high` urgency; injected as assistant turn continuation |
  | Synapse message   | `high` urgency during sub-agent active periods                     |
  | Signal message    | `critical` urgency; always delivers regardless of session state    |

  **In-Session Injection Format**:

  ```
  [PREDICTIVE ALERT — {urgency}]
  {title}
  {body}
  Source: {source_id} | Confidence: {confidence:.0%} | Expires: {expires_at}
  ```

- **Focus Mode Detection**: The system MUST detect "focus sessions" (consecutive tool calls within short intervals) and suppress `medium` insights during active focus periods. Detection heuristic: ≥3 tool calls within 90 seconds.
- **Batching**: Multiple `low` and `medium` insights MUST be batched and delivered together at session boundaries rather than as individual interrupts.
- **Priority**: HIGH
- **Testable**: `critical` urgency insight triggers Signal message within 60 seconds; `low` urgency insight appears in next session preamble, not mid-session.

---

### FR-007: Feedback Tracking — Learn What Matthew Acts On

- **Requirement**: The system MUST track which insights Matthew acknowledges or acts on, and use this data to improve future `historical_action_rate` scoring.

  **Action Detection**:
  - Explicit acknowledgment: Matthew replies to an insight with "ok", "got it", "done", "thanks", or similar confirmation
  - Implicit action: Tool call that matches the insight's subject within 10 minutes of delivery (e.g., insight about fleet health → SSH to relevant host within 10 min)
  - Ignored: Insight delivered, no relevant action or acknowledgment within insight's expiry window

  **Feedback Schema**:

  ```typescript
  interface InsightFeedback {
    insight_id: string;
    insight_type: InsightType;
    source_id: string;
    urgency_at_delivery: UrgencyLevel;
    delivered_at: string; // ISO 8601
    channel: DeliveryChannel;
    acted_on: boolean;
    action_type: "explicit" | "implicit" | "ignored";
    latency_ms: number | null; // Time from delivery to action
    session_id: string;
  }
  ```

  **Reinforcement Rules**:
  - `acted_on=true` → `historical_action_rate` for this source+type combination increases by 0.1 (max 1.0)
  - `acted_on=false` (ignored) → rate decreases by 0.05 (floor 0.0)
  - Rate is smoothed over a rolling 30-day window (not raw count, prevents cold-start cliff)
  - Source+type combinations with `historical_action_rate < 0.10` after ≥20 observations are flagged for review and frequency is halved automatically

- **Storage**: Feedback records written to `brain.db` `insight_feedback` table; rates computed on read (not precomputed) to avoid staleness.
- **Priority**: HIGH
- **Testable**: After 5 acted-on insights of type `augur.opportunity`, `historical_action_rate` for that combination is ≥ 0.5 (rolling average from 0 base); rate persists across session boundaries.

---

### FR-008: Insight State Machine

- **Requirement**: Every generated insight MUST pass through a defined lifecycle state machine.

  ```
  [generated] → [scored] → [queued] → [delivered] → [acted_on | ignored | expired]
                                                    ↘ [superseded]
  ```

  - **generated**: Raw data reading converted to an Insight record with initial urgency score
  - **scored**: Urgency calculated; delivery channel assigned; expiry set
  - **queued**: Waiting for the right delivery moment (not yet delivered)
  - **delivered**: Sent to the user via the assigned channel
  - **acted_on**: User took action (feedback detected); `InsightFeedback` written
  - **ignored**: Expiry passed without action; feedback written with `acted_on=false`
  - **superseded**: A newer insight from the same source+type replaced this one (dedup)
  - **expired**: `expires_at` passed while in `queued` state — never delivered

  **Constraint**: Insights in `queued` state MUST be re-scored on each poll cycle in case urgency changes.

- **Priority**: HIGH
- **Testable**: Insight generated but not delivered before `expires_at` transitions to `expired`, never delivered; insight superseded shows `superseded` state.

---

### FR-009: Predictive Intent Tool — `cortex_predict`

- **Requirement**: The system MUST expose a new Cortex tool `cortex_predict` for agent use.

  **Tool Signature**:

  ```typescript
  cortex_predict(params: {
    query?: string;          // Natural language query: "what should I know before starting AUGUR work?"
    sources?: string[];      // Filter to specific sources (e.g., ['augur.signals', 'fleet.health'])
    urgency_min?: UrgencyLevel; // Filter by minimum urgency ('low'|'medium'|'high'|'critical')
    include_queue?: boolean; // Include queued (not-yet-delivered) insights (default: false)
    limit?: number;          // Max insights to return (default: 5)
  }) → {
    insights: Insight[];
    sources_polled: number;
    sources_stale: string[];
    last_poll: string;       // ISO 8601
  }
  ```

  **Use Cases**:
  - Agent calls before starting complex work: "what do I need to know?"
  - Pre-action hook integration: inject relevant insights before infrastructure commands
  - On-demand briefing generation without waiting for scheduled triggers

- **Integration with Pre-Action Hooks**: When the pre-action hook system (v1.5.0) detects a tool call for a known project/host, it MUST query `cortex_predict` for relevant `high`+ urgency insights and inject them into the hook knowledge payload.
- **Priority**: MEDIUM
- **Testable**: `cortex_predict({ query: "augur" })` returns at least one insight from `augur.*` sources if any insights are queued or recently delivered; `sources_stale` correctly lists any sources with stale data.

---

### FR-010: Pattern Learning — Cross-Session Signal Reinforcement

- **Requirement**: The system MUST identify recurring prediction patterns that correlate with Matthew's workflow and store them as atoms in the existing Cortex atoms system.

  **Pattern Examples to Detect**:
  - "When AUGUR regime flips, Matthew checks paper_augur.py status within 10 minutes" → promote this as high-confidence pattern
  - "Morning fleet health checks on Mondays correlate with ansible playbook runs later that day"
  - "Git commits to `lbf-ham-radio` after 9 PM correlate with next-session radio time"

  **Pattern Extraction Rules**:
  - Minimum 3 observations required before creating an atom
  - Atom created via `atom_create` with `subject` = data source, `action` = observed signal, `outcome` = user behavior, `consequences` = prediction trigger
  - Atoms with `confidence < 0.3` are not used for prediction generation
  - Weekly review: atoms with zero confirmed predictions in 30 days are archived

  **Atom Integration**:
  - Prediction engine queries `atom_search` at startup and after each feedback write for patterns relevant to active context
  - Atoms from this system are tagged `source: 'predictive-intent'` for isolation from hand-curated atoms

- **Priority**: MEDIUM
- **Testable**: After 3 sessions where AUGUR regime flip precedes a live signal check, an atom is created linking those events with `confidence ≥ 0.5`; subsequent regime flip triggers prediction citing that atom.

---

### FR-011: Configuration Block

- **Requirement**: All predictive intent parameters MUST be configurable via the Cortex plugin config without code changes.

  **Configuration Schema**:

  ```typescript
  interface PredictiveIntentConfig {
    enabled: boolean; // Master switch
    poll_intervals_ms: {
      // Per-source poll intervals
      [source_id: string]: number;
    };
    staleness_thresholds_ms: {
      // Per-source freshness cutoffs
      [source_id: string]: number;
    };
    urgency_thresholds: {
      // Urgency score → tier boundaries
      high: number; // Default: 0.60
      critical: number; // Default: 0.85
    };
    delivery: {
      signal_channel: string; // Signal target for critical alerts
      focus_detection_window_ms: number; // Default: 90000 (90s)
      focus_detection_min_calls: number; // Default: 3
      batch_window_ms: number; // Batch low/medium insights (default: 300000 = 5min)
      duplicate_window_ms: number; // Default: 3600000 (1h)
    };
    anomaly_thresholds: {
      augur_signal_stale_ms: number; // Default: 300000 (5 min)
      augur_loss_streak: number; // Default: 3
      augur_pnl_loss_pct: number; // Default: 0.02 (2%)
      fleet_ssh_timeout_ms: number; // Default: 5000
      pipeline_stuck_ms: number; // Default: 3600000 (60 min)
    };
    feedback: {
      action_window_ms: number; // Default: 600000 (10 min)
      rate_increase_per_act: number; // Default: 0.1
      rate_decrease_per_ignore: number; // Default: 0.05
      min_observations: number; // Default: 20 (before halving)
      low_value_threshold: number; // Default: 0.10 (halve frequency if below)
    };
    briefings: {
      morning_hour_est: number; // Default: 6 (6 AM EST)
      pre_sleep_idle_ms: number; // Default: 5400000 (90 min)
      suppression_window_ms: number; // Default: 14400000 (4 h)
    };
    debug: boolean;
  }
  ```

- **Priority**: MEDIUM
- **Testable**: Setting `enabled: false` in config stops all polling and prediction; setting `urgency_thresholds.critical: 0.5` causes more insights to route to Signal.

---

### FR-012: Metrics and Observability

- **Requirement**: The system MUST emit structured events through the existing Cortex metrics system (v1.3.0+).

  **Events Logged**:

  | Event Name                     | Fields                                                      |
  | ------------------------------ | ----------------------------------------------------------- |
  | `predict_poll_cycle`           | sources_polled, sources_stale, insights_generated, cycle_ms |
  | `predict_insight_generated`    | insight_id, type, source_id, urgency, confidence            |
  | `predict_insight_delivered`    | insight_id, channel, urgency, latency_from_generation_ms    |
  | `predict_insight_expired`      | insight_id, type, source_id, queued_ms                      |
  | `predict_feedback_recorded`    | insight_id, acted_on, action_type, latency_ms               |
  | `predict_anomaly_detected`     | source_id, anomaly_type, severity                           |
  | `predict_pattern_atom_created` | atom_id, source_id, confidence, observations                |
  | `predict_rate_halved`          | source_id, insight_type, action_rate, observation_count     |

- **Dashboard Exposure**: Metrics must be queryable via `cortex stats` CLI extension and visible in future health dashboards.
- **Priority**: HIGH
- **Testable**: All 8 event types appear in metrics store within 30 minutes of normal operation; `cortex stats` shows predictive intent subsystem status.

---

## Non-Functional Requirements

### NFR-001: Performance

- **Poll Cycle Latency**: Full multi-source poll cycle MUST complete within 10 seconds
- **Insight Generation Latency**: From raw data to scored insight MUST be <500ms per insight
- **Delivery Latency**: `critical` insights MUST reach Signal within 60 seconds of generation
- **Memory Footprint**: Insight queue MUST NOT hold more than 100 pending insights; oldest `low`-urgency insights are evicted first when full
- **brain.db Impact**: All writes batched; no blocking reads beyond 200ms; insight_feedback table does NOT lock stm/memories tables

### NFR-002: Security

- **No Credential Exposure**: Insight bodies MUST NOT include raw file contents, API keys, or passwords — only structured summaries
- **SSH Probing**: Fleet health checks use read-only commands only (`ps aux`, `df`, `systemctl is-active`); no writes to remote hosts
- **Local Only**: All insight state stored locally (brain.db + JSON cache); no external transmission except Signal (existing channel) and Synapse (existing internal)
- **Signal Rate Limiting**: `critical` Signal messages capped at 1 per 5 minutes per source to prevent alert storms

### NFR-003: Compatibility

- **Cortex v2.0.0+**: Uses `SessionState` hot_topics and pending_tasks for context fusion; does NOT modify session capture/restore logic
- **Pre-Action Hooks v1.5.0+**: Reads hook context but does NOT modify hook enforcement logic; insight injection is additive
- **Atoms System**: Creates atoms via `atom_create` tool interface; does NOT write directly to atom tables
- **brain.db Schema**: New tables (`insights`, `insight_feedback`) added via migration; existing tables read-only from this module
- **Backward Compatibility**: Disabling predictive intent (config flag) produces zero behavior change in all other Cortex tools

### NFR-004: Reliability

- **Fail-Open Polling**: If any single source poll fails, that source is skipped for that cycle; polling continues; error logged
- **Crash Safety**: Insight state (including feedback) must survive process restarts; insights in `queued` state recovered on startup
- **No Blocking**: Polling MUST run in background; tool calls and memory operations are NEVER blocked waiting for poll results
- **Data Source Independence**: Sources are polled independently; failure in one does NOT delay others
- **AUGUR Read-Only**: NEVER write to AUGUR databases or modify AUGUR config — read-only access only

### NFR-005: Maintainability

- **Modular Sources**: Each data source is an independent adapter implementing `DataSourceAdapter` interface — adding a new source does NOT require modifying core engine
- **Separation of Concerns**: `PollingEngine`, `InsightGenerator`, `UrgencyScorer`, `DeliveryRouter`, `FeedbackTracker`, `PatternLearner` are separate modules
- **Debug Mode**: `CORTEX_PREDICT_DEBUG=1` logs every poll reading, insight candidate, scoring decision, and delivery action
- **Source Mocking**: All source adapters accept a `mockData` injection point for testing without live systems

---

## Dependencies

### Internal Dependencies

- **Cortex STM / brain.db** (v1.0.0+): New `insights` and `insight_feedback` tables; read access to `stm`, `atoms`, `session_states` tables
- **Session Persistence** (v2.0.0+): Reads `hot_topics`, `active_projects`, `pending_tasks` from restored session context for context fusion
- **Pre-Action Hooks** (v1.5.0+): Insight injection at hook evaluation time; hook system reads from predictive engine's insight queue
- **Confidence Scoring** (v1.2.0+): Memory confidence used to filter which cortex.memories are worth including in context fusion
- **Metrics Writer** (v1.3.0+): All prediction events written through existing tamper-evident metrics pipeline
- **Atoms System** (cortex atoms): Pattern learning writes atoms via `atom_create`; reads via `atom_search`
- **Synapse**: Delivers `high`-urgency insights to active sub-agents; reads Synapse inbox for sub-agent pipeline status
- **Working Memory Tool**: Reads current pin state for context fusion; NEVER writes pins (that's session persistence's role)

### External Dependencies

- **AUGUR data files** (read-only): `live_signal.json`, `regime.json`, `live_trades.db`, `paper_results.db` — accessed via local path on same machine OR SSH if on remote host (blackview)
- **Git** (read-only): `git log --oneline -5 --all` on each repo under `~/Projects/` — lightweight, non-blocking
- **SSH** (read-only): Fleet health checks via `ssh -o ConnectTimeout=5` with status-only commands
- **OctoPrint REST API** (read-only): `GET http://192.168.10.141/api/job` and `/api/printer` — existing `.141` target from working memory
- **Signal CLI** (via message tool): Critical alert delivery; uses existing channel infrastructure
- **OpenClaw Cron**: Background polling registered via `api.registerCron` or equivalent scheduler hook; NOT a separate process

### New Components

- **`predictive/polling-engine.ts`**: Multi-source polling loop, freshness tracking, source registry
- **`predictive/data-sources/`**: One adapter file per source (`augur-adapter.ts`, `git-adapter.ts`, `fleet-adapter.ts`, `octoprint-adapter.ts`, `pipeline-adapter.ts`, `cortex-session-adapter.ts`)
- **`predictive/insight-generator.ts`**: Raw reading → typed Insight conversion logic per source
- **`predictive/urgency-scorer.ts`**: Urgency formula, cross-source confirmation, historical rate lookup
- **`predictive/delivery-router.ts`**: Channel selection, focus mode detection, batching, dedup
- **`predictive/feedback-tracker.ts`**: Feedback detection (explicit/implicit/ignored), rate management, db writes
- **`predictive/pattern-learner.ts`**: Cross-session correlation, atom creation via tool API
- **`predictive/briefing-generator.ts`**: Scheduled briefing templates, suppression logic, trigger detection
- **brain.db schema migration v5**: `insights` and `insight_feedback` tables

### Modified Components

- **`index.ts`**: Register `cortex_predict` tool; initialize polling engine in `registerService.start()`; stop polling in `registerService.stop()`
- **`hooks/enforcement-engine.ts`**: Add insight injection step at pre-action hook evaluation (additive, does not change enforcement logic)
- **`cortex-bridge.ts`**: New `InsightPersistenceManager` with CRUD for `insights` and `insight_feedback` tables
- **Cortex plugin config schema**: New `predictive_intent` configuration block

### Does NOT Modify

- Session capture/restore logic (`session-manager.ts`) — reads output only
- Pre-action hook enforcement behavior — adds insight injection as an additional step, does not change blocking/allow logic
- AUGUR databases — strictly read-only
- Fleet hosts — read-only SSH probes only
- Atom tables — writes only via `atom_create` tool API, not raw SQL

---

## Data Schemas

### Insight Record

```typescript
interface Insight {
  id: string; // UUID
  type: InsightType; // 'anomaly'|'opportunity'|'briefing'|'reminder'|'alert'|'pattern'
  source_id: string; // e.g. 'augur.signals', 'fleet.health'
  title: string; // Short, action-oriented title (≤80 chars)
  body: string; // Structured detail (≤500 chars)
  urgency: UrgencyLevel; // 'low'|'medium'|'high'|'critical'
  urgency_score: number; // 0.0–1.0 computed score
  confidence: number; // 0.0–1.0 how confident this insight is correct
  actionable: boolean; // Does this require a decision/action?
  expires_at: string | null; // ISO 8601; null = no expiry
  generated_at: string; // ISO 8601
  state: InsightState; // 'generated'|'scored'|'queued'|'delivered'|'acted_on'|'ignored'|'superseded'|'expired'
  delivery_channel: DeliveryChannel | null; // Assigned at scoring time
  delivered_at: string | null;
  session_id: string; // Session that generated this
  schema_version: number; // For future migrations
}
```

### Insight Feedback Record

```typescript
interface InsightFeedback {
  id: string; // UUID
  insight_id: string; // FK to insights table
  insight_type: InsightType;
  source_id: string;
  urgency_at_delivery: UrgencyLevel;
  delivered_at: string; // ISO 8601
  channel: DeliveryChannel;
  acted_on: boolean;
  action_type: "explicit" | "implicit" | "ignored";
  latency_ms: number | null;
  session_id: string;
  created_at: string;
}
```

---

## Acceptance Criteria

### AC-001: Multi-Source Polling

- ✅ Polling loop starts within 5 seconds of `registerService.start()`
- ✅ All 10 data sources polled within 2 minutes of startup
- ✅ Stale readings (beyond staleness threshold) excluded from insight generation
- ✅ Single source failure does not stop other sources from polling
- ✅ Poll cycle completes in <10 seconds total

### AC-002: Insight Generation

- ✅ Each of the 6 insight types can be generated from at least one source
- ✅ Duplicate suppression: same insight from same source not re-emitted within 60 minutes without data change
- ✅ Expired insights (past `expires_at`) never delivered
- ✅ Insight body ≤ 500 chars, title ≤ 80 chars

### AC-003: Urgency Scoring

- ✅ Open trade about to hit loss threshold scores `high` or `critical`
- ✅ Git activity pattern with no financial impact scores `low` or `medium`
- ✅ `historical_action_rate = 0.0` source+type reduces urgency contribution to zero
- ✅ Cross-source confirmation (2+ sources agreeing) measurably increases urgency score

### AC-004: Anomaly Detection

- ✅ AUGUR signal file > 5 min old generates `anomaly` insight with urgency ≥ `high`
- ✅ Host SSH unreachable generates `alert` insight with urgency ≥ `high`
- ✅ Pipeline task stuck 60+ minutes generates `anomaly` insight
- ✅ Each anomaly type documented in AC-004 can be simulated and detected within one poll cycle

### AC-005: Briefings

- ✅ Morning brief fires on first session start after 6 AM with data from ≥ 4 sources
- ✅ Pre-work brief fires when new project directory is accessed in exec tool
- ✅ Briefing suppression: same type not re-triggered within 4 hours
- ✅ Pre-sleep brief triggers after 90 minutes idle (when implemented via cron or inactivity hook)

### AC-006: Delivery Routing

- ✅ `critical` insight arrives in Signal within 60 seconds
- ✅ `low` insight batched to session preamble, not mid-session interrupt
- ✅ Focus mode (≥3 tool calls in 90s) suppresses `medium` delivery
- ✅ Signal delivery rate-limited to 1 per 5 min per source (no storms)

### AC-007: Feedback Tracking

- ✅ Tool call matching insight subject within 10 min of delivery → `acted_on=true, action_type='implicit'`
- ✅ Explicit "ok"/"done" reply → `acted_on=true, action_type='explicit'`
- ✅ No action within expiry window → `acted_on=false, action_type='ignored'`
- ✅ After 5 acted-on signals from `augur.signals/opportunity`, `historical_action_rate ≥ 0.4` for that combination
- ✅ Source+type with rate < 0.10 after 20+ observations triggers rate-halving event (metric emitted)

### AC-008: Pattern Learning

- ✅ After 3 cross-session observations of signal→action correlation, atom created with `confidence ≥ 0.5`
- ✅ Atoms tagged `source: 'predictive-intent'` to distinguish from hand-curated atoms
- ✅ Atom with zero confirmed predictions in 30 days flagged for review (metric emitted)
- ✅ Atom confidence drives `historical_action_rate` contribution to urgency scoring

### AC-009: `cortex_predict` Tool

- ✅ Returns insights filtered by query, source, urgency level
- ✅ `sources_stale` correctly lists sources with stale data
- ✅ Pre-action hook integration: infrastructure commands trigger `cortex_predict` call and inject relevant insights into hook payload
- ✅ Returns within 200ms (reads from in-memory queue, not re-polling)

### AC-010: Metrics

- ✅ All 8 metric event types emitted during normal operation
- ✅ `cortex stats` CLI shows predictive intent subsystem: last poll time, insights in queue, feedback count
- ✅ Metrics accessible via existing Python metrics reader
- ✅ Zero metrics emitted when `enabled: false` in config

### AC-011: Reliability and Safety

- ✅ No AUGUR database writes — confirmed via filesystem audit of all opened file handles
- ✅ No fleet host writes — all SSH commands are read-only
- ✅ Disabling predictive intent (`enabled: false`) produces identical behavior to Cortex v2.0.0 for all existing tools
- ✅ Process restart with pending insights in queue: insights recovered correctly from brain.db

---

## Out of Scope

### OS-001: Self-Healing Infrastructure

Detecting anomalies and _automatically fixing them_ is Phase 5.2 (task-006). This task detects and alerts — remediation is always human-triggered.

### OS-002: Calendar Integration

Explicit Google Calendar API integration (meeting detection, schedule-aware delivery) is deferred to a follow-up sprint. This task uses session-start time and idle detection as proxies.

### OS-003: External API Integrations

No new external API integrations (news feeds, weather, market data APIs beyond AUGUR's existing SQLite). All data comes from local files, local databases, or local network (fleet SSH + OctoPrint LAN).

### OS-004: Multi-User Contexts

All predictions are scoped to Matthew's single-user, single-channel context. No multi-user routing logic.

### OS-005: Predictive Trading Signals

This system reads AUGUR output but does NOT generate trading signals. AUGUR owns signal generation. Predictive intent surfaces AUGUR's output with context — it is not a competing signal engine.

### OS-006: Notification History UI

No UI for browsing insight history. Insights are queryable via `cortex_predict` tool and visible in metrics. A dedicated history browser is a future deliverable.

### OS-007: Natural Language Threshold Configuration

Configuring urgency thresholds via plain English ("notify me only for critical things") requires NLP parsing not in scope here. Config changes are structured JSON only.

### OS-008: Email Delivery Channel

Email is available (daily planning email already exists) but is NOT a delivery channel for real-time insights. Real-time channels are session injection, Synapse, and Signal only.

---

## Versioning Target

- **Release**: Cortex v2.1.0
- **Branch**: `feature/predictive-intent-v2.1.0`
- **Tag**: `cortex-v2.1.0`
- **Commit convention**: `feat(predict): <description>` for new capabilities, `fix(predict): <description>` for corrections

---

**Next Steps**: Proceed to design phase. Key design decisions requiring specification:

1. Architecture of the polling engine (async loop vs cron vs event-driven)
2. Exact SQL schema for `insights` and `insight_feedback` tables
3. Focus mode detection implementation (hook into tool call counter vs wall-clock heuristic)
4. Pattern learner atom correlation algorithm (time-window join vs event sequence matching)
5. OctoPrint adapter authentication (API key storage in config vs secrets file)
