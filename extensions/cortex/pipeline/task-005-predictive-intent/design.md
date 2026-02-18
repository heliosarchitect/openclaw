# Predictive Intent — Act Before Asked: Technical Design

**Task ID:** task-005-predictive-intent  
**Stage:** design  
**Author:** Software Architect (Pipeline Orchestrator)  
**Date:** 2026-02-18  
**Cortex Target Version:** 2.1.0  
**Requires:** Cortex v2.0.0 (session persistence), v1.5.0 (pre-action hooks), v1.3.0 (metrics), v1.2.0 (confidence scoring)

---

## 1. Approach Summary

### Problem

Helios is reactive. Every session starts cold from the agent's perspective: it answers questions, runs tools, completes tasks — but never anticipates. Matthew must manually check AUGUR status, fleet health, print job progress, pipeline state, and relevant memories before starting any session. That cognitive overhead is entirely eliminable.

### Solution Architecture

The Predictive Intent system is a **new `predictive/` module** within the Cortex extension. It runs a background multi-source polling engine that continuously synthesizes structured `Insight` records. Insights are scored, routed to the appropriate delivery channel, tracked for feedback, and used to train a pattern-learning layer that progressively improves prediction quality.

The architecture has **six coordinated subsystems**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PREDICTIVE INTENT ENGINE                          │
│                                                                      │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐   │
│  │ PollingEngine│───▶│ InsightGenerator │───▶│  UrgencyScorer   │   │
│  │  (per-source │    │  (typed insight  │    │  (4-tier score   │   │
│  │   async loop)│    │   construction)  │    │   + channel)     │   │
│  └──────┬───────┘    └──────────────────┘    └────────┬─────────┘   │
│         │                                             │             │
│         │ raw readings                           scored insights    │
│         ▼                                             ▼             │
│  ┌──────────────┐                          ┌──────────────────┐     │
│  │ DataSource   │                          │  DeliveryRouter  │     │
│  │  Adapters    │                          │  (channel select │     │
│  │  (pluggable) │                          │   batch + dedup) │     │
│  └──────────────┘                          └────────┬─────────┘     │
│                                                     │               │
│                          ┌──────────────────────────┤               │
│                          ▼                          ▼               │
│                ┌──────────────────┐      ┌──────────────────┐       │
│                │ FeedbackTracker  │      │ BriefingGenerator│       │
│                │ (acted_on rates) │      │ (scheduled synth)│       │
│                └────────┬─────────┘      └──────────────────┘       │
│                         │                                           │
│                         ▼                                           │
│                ┌──────────────────┐                                 │
│                │  PatternLearner  │                                 │
│                │  (atom creation) │                                 │
│                └──────────────────┘                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

**Decision 1 — Polling Engine: Staggered Async Timer Loop (not cron, not event-driven)**

Rationale: Each source has its own independent poll interval (60s to 15min). OpenClaw cron is too coarse for sub-minute intervals. Event-driven would require source-specific hooks that don't exist on most sources (AUGUR files have no inotify events we can rely on). The solution is a per-source `setTimeout`-based loop started in `registerService.start()` and stopped in `registerService.stop()`. Each source adapter manages its own timer independently — failure in one never delays others. This matches the existing cron infrastructure already in `index.ts` for heartbeat operations, and `setInterval` is safe within the Node.js runtime that hosts the OpenClaw plugin.

**Decision 2 — Insight State: In-Memory Queue + brain.db Persistence**

Insights in `queued` state are held in a module-level `Map<string, Insight>` (keyed by insight ID) for sub-millisecond reads by `cortex_predict`. On every state transition (generated → scored → queued → delivered/acted_on/ignored/expired), the record is written to `brain.db` `insights` table for crash recovery. On `registerService.start()`, insights in `queued` state from the prior session are loaded back into the in-memory queue and re-scored. This is the same dual-write pattern used by session-manager.ts.

**Decision 3 — Focus Mode Detection: Hook Call Counter in EnforcementEngine**

The pre-action hooks module already intercepts every tool call in `before_tool_call`. We add a `FocusModeTracker` singleton that the enforcement engine ticks on each call. A sliding 90-second window with ≥3 calls = focus mode active. This is additive — no change to enforcement logic. The tracker exposes `isFocusModeActive(): boolean` read by the DeliveryRouter. No wall-clock heuristics needed.

**Decision 4 — Pattern Learner: Time-Window Join (not event sequence matching)**

For each `acted_on=true` feedback record, the PatternLearner queries brain.db for data source readings that occurred within a configurable lookback window (default: 30 minutes before delivery). It groups observations by `(source_id, insight_type)` pair. After ≥3 matching observations where user acted, it creates an atom via `atom_create`. This is simpler than sequence matching, avoids ordering assumptions, and generalizes across arbitrary source combinations. The time window is configurable per source.

**Decision 5 — OctoPrint Authentication: Secrets File (not plugin config)**

OctoPrint requires an API key. Storing credentials in plugin config (openclaw.plugin.json) is wrong — it's committed to Git. The adapter reads from `~/.secrets/octoprint.env` (same pattern as `~/.secrets/stripe.env` established 2026-02-07). If the file is absent, the adapter silently skips (graceful degradation per FR-001).

**Discovery: No Dedicated Plugin Lifecycle for Background Polling**

Confirmed from code review: `registerService.start()` / `registerService.stop()` are the correct anchors. The `index.ts` already uses these for the heartbeat/health-check polling. Predictive intent registers its timer loop the same way.

---

## 2. Files to Create / Modify

### New Files

```
extensions/cortex/predictive/
├── types.ts                          # All TypeScript interfaces (Insight, InsightFeedback, Config)
├── polling-engine.ts                 # PollingEngine — source registry, timer loop orchestration
├── insight-generator.ts              # Raw reading → typed Insight conversion, per-source logic
├── urgency-scorer.ts                 # Urgency formula + tier assignment + channel selection
├── delivery-router.ts                # Channel routing, batching, dedup, focus-mode check
├── feedback-tracker.ts               # Action detection, rate management, brain.db writes
├── briefing-generator.ts             # Scheduled briefing templates + suppression
├── pattern-learner.ts                # Cross-session correlation, atom creation via API
├── focus-mode-tracker.ts             # Singleton: sliding-window focus mode detection
├── data-sources/
│   ├── adapter-interface.ts          # DataSourceAdapter interface
│   ├── augur-signals-adapter.ts      # augur.signals — reads live_signal.json
│   ├── augur-trades-adapter.ts       # augur.trades — reads live_trades.db
│   ├── augur-regime-adapter.ts       # augur.regime — reads regime.json
│   ├── augur-paper-adapter.ts        # augur.paper — reads paper_results.db
│   ├── git-adapter.ts               # git.activity — git log across ~/Projects/
│   ├── fleet-adapter.ts             # fleet.health — SSH reachability checks
│   ├── octoprint-adapter.ts         # octoprint.jobs — REST API + secrets file
│   ├── pipeline-adapter.ts          # pipeline.state — reads state.json
│   ├── cortex-session-adapter.ts    # cortex.session — reads SessionState hot_topics
│   └── cortex-atoms-adapter.ts     # cortex.atoms — atom_search for active context
└── __tests__/
    ├── polling-engine.test.ts
    ├── insight-generator.test.ts
    ├── urgency-scorer.test.ts
    ├── delivery-router.test.ts
    ├── feedback-tracker.test.ts
    ├── briefing-generator.test.ts
    └── data-sources/
        └── *.mock.ts                 # Mock data injection per adapter

extensions/cortex/python/
└── predict_manager.py                # Python DB layer: insights + insight_feedback CRUD
```

### Modified Files

| File                                            | Change                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extensions/cortex/python/brain.py`             | Add `insights` + `insight_feedback` tables + indexes in `_init_schema()` (migration v5)                                                                                                                      |
| `extensions/cortex/cortex-bridge.ts`            | Add `PredictBridgeMethods` — thin wrappers calling `predict_manager.py` via `runPython()`                                                                                                                    |
| `extensions/cortex/index.ts`                    | Register `cortex_predict` tool; init PollingEngine in `registerService.start()`; stop in `registerService.stop()`; add `predictive_intent` to configSchema; wire FocusModeTracker tick in `before_tool_call` |
| `extensions/cortex/hooks/enforcement-engine.ts` | Add insight injection step: call `PollingEngine.getRelevantInsights()` at hook evaluation; inject into knowledge payload (additive, does not change blocking logic)                                          |
| `extensions/cortex/openclaw.plugin.json`        | Add `predictive_intent` config block to plugin schema                                                                                                                                                        |

### Does NOT Modify

- `extensions/cortex/session/` — session capture/restore logic untouched; predictive intent reads `SessionState` output only
- `extensions/cortex/hooks/context-extractor.ts`, `knowledge-discovery.ts`, `sop-enhancer.ts` — hook pipeline unmodified
- AUGUR databases — zero writes; adapters open SQLite in read-only mode (`uri=file:path?mode=ro`)
- Remote fleet hosts — SSH commands are read-only status probes only
- `extensions/cortex/python/stm_manager.py`, `embeddings_manager.py` — no changes
- Existing brain.db tables (`stm`, `messages`, `atoms`, `causal_links`, `embeddings`, `working_memory`, `session_states`) — read-only from predictive module

---

## 3. Data Model Changes

### New Table: `insights` (brain.db migration v5)

```sql
CREATE TABLE IF NOT EXISTS insights (
    id TEXT PRIMARY KEY,                    -- UUID
    type TEXT NOT NULL,                     -- 'anomaly'|'opportunity'|'briefing'|'reminder'|'alert'|'pattern'
    source_id TEXT NOT NULL,                -- e.g. 'augur.signals', 'fleet.health'
    title TEXT NOT NULL,                    -- ≤80 chars, action-oriented
    body TEXT NOT NULL,                     -- ≤500 chars, structured detail
    urgency TEXT NOT NULL,                  -- 'low'|'medium'|'high'|'critical'
    urgency_score REAL NOT NULL,            -- 0.0–1.0 computed score
    confidence REAL NOT NULL DEFAULT 0.8,  -- 0.0–1.0
    actionable INTEGER NOT NULL DEFAULT 1, -- 0|1 boolean
    expires_at TEXT,                        -- ISO 8601; NULL = no expiry
    generated_at TEXT NOT NULL,            -- ISO 8601
    state TEXT NOT NULL DEFAULT 'generated', -- state machine state
    delivery_channel TEXT,                 -- NULL until scored
    delivered_at TEXT,                     -- NULL until delivered
    session_id TEXT NOT NULL,              -- Session that generated this
    schema_version INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_insights_state ON insights(state, urgency_score DESC);
CREATE INDEX IF NOT EXISTS idx_insights_source ON insights(source_id, type, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_insights_expires ON insights(expires_at, state);
CREATE INDEX IF NOT EXISTS idx_insights_session ON insights(session_id, generated_at DESC);
```

### New Table: `insight_feedback` (brain.db migration v5)

```sql
CREATE TABLE IF NOT EXISTS insight_feedback (
    id TEXT PRIMARY KEY,                         -- UUID
    insight_id TEXT NOT NULL,                    -- FK → insights.id
    insight_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    urgency_at_delivery TEXT NOT NULL,
    delivered_at TEXT NOT NULL,                  -- ISO 8601
    channel TEXT NOT NULL,
    acted_on INTEGER NOT NULL DEFAULT 0,         -- 0|1 boolean
    action_type TEXT NOT NULL DEFAULT 'ignored', -- 'explicit'|'implicit'|'ignored'
    latency_ms INTEGER,                          -- NULL if ignored
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_source_type ON insight_feedback(source_id, insight_type, acted_on);
CREATE INDEX IF NOT EXISTS idx_feedback_insight ON insight_feedback(insight_id);
CREATE INDEX IF NOT EXISTS idx_feedback_session ON insight_feedback(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_window ON insight_feedback(created_at DESC);
```

### New Table: `predict_action_rates` (brain.db migration v5)

Precomputed rolling rates per `(source_id, insight_type)` pair. Written after each feedback record; avoids recomputing over 30 days of records on every urgency scoring call.

```sql
CREATE TABLE IF NOT EXISTS predict_action_rates (
    id TEXT PRIMARY KEY,                 -- '{source_id}::{insight_type}'
    source_id TEXT NOT NULL,
    insight_type TEXT NOT NULL,
    action_rate REAL NOT NULL DEFAULT 0.0,   -- Rolling 30-day rate 0.0–1.0
    observation_count INTEGER DEFAULT 0,
    rate_halved INTEGER DEFAULT 0,           -- 1 if auto-halving triggered
    last_updated TEXT NOT NULL,
    UNIQUE(source_id, insight_type)
);
```

### Migration Strategy

New tables added at end of `_init_schema()` using `CREATE TABLE IF NOT EXISTS` — fully idempotent. Existing brain.db databases get new tables on next startup with zero data loss. No data transformation required. Schema version comment bumped from v4 to v5 in the Python file header.

---

## 4. TypeScript Interfaces (`predictive/types.ts`)

```typescript
// ──────────────────────────────────────────────────────
// Insight Record — core data unit of the prediction engine
// ──────────────────────────────────────────────────────

export type InsightType = "anomaly" | "opportunity" | "briefing" | "reminder" | "alert" | "pattern";

export type UrgencyLevel = "low" | "medium" | "high" | "critical";

export type InsightState =
  | "generated"
  | "scored"
  | "queued"
  | "delivered"
  | "acted_on"
  | "ignored"
  | "superseded"
  | "expired";

export type DeliveryChannel = "preamble" | "in_session" | "synapse" | "signal";

export interface Insight {
  id: string;
  type: InsightType;
  source_id: string;
  title: string; // ≤80 chars
  body: string; // ≤500 chars
  urgency: UrgencyLevel;
  urgency_score: number; // 0.0–1.0
  confidence: number; // 0.0–1.0
  actionable: boolean;
  expires_at: string | null; // ISO 8601
  generated_at: string; // ISO 8601
  state: InsightState;
  delivery_channel: DeliveryChannel | null;
  delivered_at: string | null;
  session_id: string;
  schema_version: number;
}

// ──────────────────────────────────────────────────────
// Feedback Record — what Matthew did with the insight
// ──────────────────────────────────────────────────────

export type FeedbackActionType = "explicit" | "implicit" | "ignored";

export interface InsightFeedback {
  id: string;
  insight_id: string;
  insight_type: InsightType;
  source_id: string;
  urgency_at_delivery: UrgencyLevel;
  delivered_at: string;
  channel: DeliveryChannel;
  acted_on: boolean;
  action_type: FeedbackActionType;
  latency_ms: number | null;
  session_id: string;
  created_at: string;
}

// ──────────────────────────────────────────────────────
// Data Source Adapter interface
// ──────────────────────────────────────────────────────

export interface SourceReading {
  source_id: string;
  captured_at: string; // ISO 8601
  freshness_ms: number; // Staleness threshold for this source
  data: Record<string, unknown>;
  available: boolean; // false = source unavailable this cycle
  error?: string;
}

export interface DataSourceAdapter {
  readonly source_id: string;
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  poll(): Promise<SourceReading>;
  // Optional: inject mock data for testing
  setMockData?(data: Record<string, unknown>): void;
}

// ──────────────────────────────────────────────────────
// Urgency scoring inputs
// ──────────────────────────────────────────────────────

export interface UrgencyScoringInputs {
  time_sensitivity: number; // 0.0–1.0 based on expires_at
  financial_impact: number; // 0.0–1.0
  historical_action_rate: number; // 0.0–1.0 from predict_action_rates
  cross_source_confirmation: number; // 0.0–1.0 fraction of confirming sources
}

// ──────────────────────────────────────────────────────
// Predictive Intent Config Block
// ──────────────────────────────────────────────────────

export interface PredictiveIntentConfig {
  enabled: boolean;
  poll_intervals_ms: Record<string, number>;
  staleness_thresholds_ms: Record<string, number>;
  urgency_thresholds: {
    high: number; // Default: 0.60
    critical: number; // Default: 0.85
  };
  delivery: {
    signal_channel: string;
    focus_detection_window_ms: number; // Default: 90000
    focus_detection_min_calls: number; // Default: 3
    batch_window_ms: number; // Default: 300000
    duplicate_window_ms: number; // Default: 3600000
  };
  anomaly_thresholds: {
    augur_signal_stale_ms: number; // Default: 300000
    augur_loss_streak: number; // Default: 3
    augur_pnl_loss_pct: number; // Default: 0.02
    fleet_ssh_timeout_ms: number; // Default: 5000
    pipeline_stuck_ms: number; // Default: 3600000
  };
  feedback: {
    action_window_ms: number; // Default: 600000
    rate_increase_per_act: number; // Default: 0.1
    rate_decrease_per_ignore: number; // Default: 0.05
    min_observations: number; // Default: 20
    low_value_threshold: number; // Default: 0.10
  };
  briefings: {
    morning_hour_est: number; // Default: 6
    pre_sleep_idle_ms: number; // Default: 5400000
    suppression_window_ms: number; // Default: 14400000
  };
  octoprint: {
    host: string; // Default: 'http://192.168.10.141'
    secrets_file: string; // Default: '~/.secrets/octoprint.env'
  };
  debug: boolean;
}
```

---

## 5. Module Designs

### 5.1 PollingEngine (`predictive/polling-engine.ts`)

Owns the per-source timer loops. Maintains a `Map<string, DataSourceAdapter>` source registry. On `start()`, each adapter's timer is initialized with `setTimeout` that re-schedules itself on completion (not `setInterval` — prevents overlapping calls if a source is slow). Maintains the `lastReadings: Map<string, SourceReading>` cache for cross-source confirmation queries.

```typescript
class PollingEngine {
  private adapters: Map<string, DataSourceAdapter>;
  private timers: Map<string, NodeJS.Timeout>;
  private lastReadings: Map<string, SourceReading>;
  private running: boolean = false;

  start(config: PredictiveIntentConfig): void;
  stop(): void;
  getLastReading(source_id: string): SourceReading | null;
  getAllReadings(): SourceReading[]; // For cross-source confirmation
  getRelevantInsights(context: string[]): Insight[]; // For pre-action hook injection
  // Called by each timer on completion:
  private onReadingComplete(reading: SourceReading): Promise<void>;
}
```

**Poll loop per source** (pseudocode):

```
async function schedulePoll(adapter) {
  const reading = await adapter.poll()
  onReadingComplete(reading)
  if (running) setTimeout(() => schedulePoll(adapter), adapter.poll_interval_ms)
}
```

### 5.2 InsightGenerator (`predictive/insight-generator.ts`)

Receives a `SourceReading` and returns zero or more `Insight[]`. Each source has a dedicated handler function registered in a `Map<string, (reading: SourceReading) => Insight[]>`. Handler functions implement anomaly detection thresholds, pattern matching, and insight construction for their source.

Key design rule: **handlers are pure functions** — they receive the reading + config thresholds and return insights. No DB access inside handlers. This makes them trivially testable with mock data injection.

```typescript
class InsightGenerator {
  private handlers: Map<string, InsightHandler>;
  generate(reading: SourceReading, config: PredictiveIntentConfig): Insight[];
}

type InsightHandler = (
  reading: SourceReading,
  config: PredictiveIntentConfig,
  existingInsights: Insight[], // For dedup awareness
) => Insight[];
```

**Dedup check inside handlers**: Before constructing an insight, handlers call `isDuplicate(sourceId, type, existingInsights, duplicateWindowMs)` which checks if a non-expired, non-superseded insight of the same source+type exists within the duplicate window. If yes, returns empty array for that candidate.

### 5.3 UrgencyScorer (`predictive/urgency-scorer.ts`)

Stateless scoring: receives an `Insight` + `UrgencyScoringInputs` and returns `{ score: number, tier: UrgencyLevel, channel: DeliveryChannel }`.

```typescript
function scoreInsight(
  insight: Insight,
  inputs: UrgencyScoringInputs,
  config: PredictiveIntentConfig,
): ScoredInsight;

function computeTimeSensitivity(expiresAt: string | null): number;
function computeCrossSourceConfirmation(sourceId: string, allReadings: SourceReading[]): number;

// Channel assignment:
// critical → signal
// high → in_session (or synapse if sub-agent session active)
// medium → in_session (deferred during focus mode)
// low → preamble
function assignChannel(tier: UrgencyLevel, focusActive: boolean): DeliveryChannel;
```

**Score formula implementation**:

```typescript
const score =
  timeSensitivity * 0.4 +
  financialImpact * 0.3 +
  historicalActionRate * 0.2 +
  crossSourceConfirmation * 0.1;
```

**Decay on re-score**: Insights re-scored each poll cycle. If `expires_at` is approaching, `time_sensitivity` increases, possibly elevating tier. If expired, state transitions to `expired` and insight is removed from queue.

### 5.4 DeliveryRouter (`predictive/delivery-router.ts`)

Manages the delivery queue and dispatches to the correct channel. Maintains a batch buffer for `low`/`medium` insights.

```typescript
class DeliveryRouter {
  private queue: Insight[];
  private batchBuffer: Insight[];
  private lastDelivered: Map<string, string>; // source+type → ISO timestamp

  async route(insight: Insight, config: PredictiveIntentConfig): Promise<void>;
  async flushBatch(): Promise<void>; // Called at session preamble points
  private async sendSignal(insight: Insight): Promise<void>;
  private async sendSynapse(insight: Insight): Promise<void>;
  private injectToSession(insight: Insight): void; // Appends to in-session context
}
```

**Signal rate limiting**: A `Map<string, number>` tracks `lastSignalTime` per source_id. If `Date.now() - lastSignalTime < 5 * 60 * 1000`, suppress and queue as `medium` instead.

**Batch flush trigger points**:

1. `before_agent_start` hook (session preamble)
2. After a focus mode window ends (`isFocusModeActive()` transitions false)
3. Explicit `cortex_predict` call with `include_queue: true`

**In-session format**:

```
[PREDICTIVE ALERT — {urgency.toUpperCase()}]
{title}
{body}
Source: {source_id} | Confidence: {(confidence * 100).toFixed(0)}% | Expires: {expiresAt ?? 'none'}
```

### 5.5 FeedbackTracker (`predictive/feedback-tracker.ts`)

Monitors for implicit and explicit action signals by hooking into `after_tool_call` and message processing. Writes `InsightFeedback` records and updates `predict_action_rates`.

**Implicit detection**: `after_tool_call` hook receives tool name + args. For each `delivered` insight, check if the tool call's subject matter (extracted from args using keyword matching against `source_id` → keyword map) overlaps with the insight. Example: exec/SSH call with host matching a fleet insight's body → `action_type='implicit'`.

**Explicit detection**: `after_agent_turn` receives the assistant's outgoing message text. Check for acknowledgment phrases ("ok", "got it", "done", "noted", "acknowledged") within one turn of a delivery. If found, mark `action_type='explicit'`.

**Rate update algorithm**:

```typescript
async function updateActionRate(
  source_id: string,
  insight_type: InsightType,
  acted_on: boolean,
  config: FeedbackConfig,
): Promise<void> {
  const current = await bridge.getActionRate(source_id, insight_type);
  const delta = acted_on
    ? config.rate_increase_per_act // +0.1
    : -config.rate_decrease_per_ignore; // -0.05
  const newRate = Math.max(0, Math.min(1, current.action_rate + delta));
  const newCount = current.observation_count + 1;

  // Check for auto-halving
  const rateHalved = newCount >= config.min_observations && newRate < config.low_value_threshold;

  await bridge.upsertActionRate(source_id, insight_type, newRate, newCount, rateHalved);
  if (rateHalved) {
    await writeMetric("pipeline", {
      metric: "predict_rate_halved",
      source_id,
      insight_type,
      newRate,
      newCount,
    });
  }
}
```

### 5.6 BriefingGenerator (`predictive/briefing-generator.ts`)

Manages scheduled briefing generation. Checks triggering conditions and suppression windows. Pulls data from `PollingEngine.getAllReadings()` and the `SessionPersistenceManager`'s most recent restored context.

**Briefing suppression**: `Map<string, string>` tracks `lastBriefingTime` per briefing type. If within `suppression_window_ms` (4h), returns null.

**Morning Brief trigger**: `registerService.start()` checks if current hour ≥ config `morning_hour_est` AND `lastBriefingTime['morning']` is from a prior calendar day. If so, generates immediately.

**Pre-Work Brief trigger**: `before_tool_call` for `exec` tool — if the command path matches a known project directory, generate pre-work brief for that project. Project detection via regex on command args.

**Pipeline Stage Completion Brief trigger**: `pipeline-adapter.ts` detects state change in `state.json`. On transition, BriefingGenerator is notified and generates a pipeline status brief.

**Pre-Sleep Brief trigger**: A dedicated low-frequency timer (every 15 min) checks time since last tool call. If ≥90 min idle, generate pre-sleep brief.

### 5.7 PatternLearner (`predictive/pattern-learner.ts`)

After each `acted_on=true` feedback write, PatternLearner performs a time-window join to find correlated source readings:

```typescript
async function analyzeForPattern(
  feedback: InsightFeedback,
  config: PredictiveIntentConfig,
): Promise<void> {
  // Get all feedback records of same source+type
  const history = await bridge.getFeedbackHistory(feedback.source_id, feedback.insight_type, {
    acted_on: true,
    window_days: 30,
  });

  if (history.length < 3) return; // Minimum observations

  // Check if correlation pattern already exists as atom
  const existing = await atomSearch(
    "consequences",
    `${feedback.source_id} ${feedback.insight_type}`,
  );
  if (existing.length > 0) {
    // Atom exists — increase confidence if below 1.0
    // (No direct atom edit API yet — log for manual review)
    return;
  }

  // Calculate confidence from action rate
  const rate = await bridge.getActionRate(feedback.source_id, feedback.insight_type);
  if (rate.action_rate < 0.3) return; // Not confident enough yet

  // Create atom
  await atomCreate({
    subject: feedback.source_id,
    action: `generates ${feedback.insight_type} insight`,
    outcome: `Matthew acts on it ${(rate.action_rate * 100).toFixed(0)}% of the time`,
    consequences: `subsequent ${feedback.source_id} insights should be scored with action_rate=${rate.action_rate.toFixed(2)}`,
    confidence: rate.action_rate,
    source: "predictive-intent",
  });

  await writeMetric("pipeline", {
    metric: "predict_pattern_atom_created",
    source_id: feedback.source_id,
    insight_type: feedback.insight_type,
    confidence: rate.action_rate,
    observations: history.length,
  });
}
```

### 5.8 FocusModeTracker (`predictive/focus-mode-tracker.ts`)

Singleton. Ticked by `before_tool_call` in `index.ts`.

```typescript
class FocusModeTracker {
  private callTimestamps: number[] = []; // Rolling window
  private windowMs: number = 90000;
  private minCalls: number = 3;

  tick(): void {
    const now = Date.now();
    this.callTimestamps.push(now);
    // Prune old entries
    this.callTimestamps = this.callTimestamps.filter((t) => now - t < this.windowMs);
  }

  isFocusModeActive(): boolean {
    return this.callTimestamps.length >= this.minCalls;
  }

  configure(windowMs: number, minCalls: number): void {
    this.windowMs = windowMs;
    this.minCalls = minCalls;
  }
}

export const focusModeTracker = new FocusModeTracker();
```

---

## 6. Data Source Adapter Designs

### Common Interface

All adapters implement:

```typescript
interface DataSourceAdapter {
  readonly source_id: string;
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  poll(): Promise<SourceReading>;
  setMockData?(data: Record<string, unknown>): void;
}
```

### Per-Adapter Implementation Notes

**`augur-signals-adapter.ts`** (`augur.signals`): Reads `~/Projects/augur-trading/live_signal.json` via `fs.readFile`. Checks `updated_at` field against current time — if diff > `anomaly_thresholds.augur_signal_stale_ms`, returns reading with `data.stale = true` to trigger anomaly insight. Never writes. 60s interval.

**`augur-trades-adapter.ts`** (`augur.trades`): Opens `live_trades.db` with `sqlite3` in read-only URI mode (`file:path?mode=ro`). Queries: `SELECT * FROM trades WHERE status='open'` and computes session P&L. Connection opened per poll, closed immediately after query. 5min interval.

**`augur-regime-adapter.ts`** (`augur.regime`): Reads `regime.json`. Compares current `regime` field to last known value (stored in adapter instance). Regime flip = anomaly signal. 5min interval.

**`augur-paper-adapter.ts`** (`augur.paper`): Opens `paper_results.db` read-only. Queries recent N trades (last 10), computes loss streak from consecutive losses. 15min interval.

**`git-adapter.ts`** (`git.activity`): Runs `git log --oneline --all --since='10 minutes ago' --format="%H %an %s"` across each known repo directory (scanned from `~/Projects/` with max depth 1). Uses `execAsync` with 5s timeout per repo. Aggregates results. 10min interval.

**`fleet-adapter.ts`** (`fleet.health`): Reads fleet inventory from `~/.openclaw/workspace/fleet.json` (or hardcoded known hosts if file absent). For each host, runs `ssh -o ConnectTimeout=5 -o BatchMode=yes {host} echo ok` with 5s timeout. Read-only commands only. Parallel probes via `Promise.allSettled`. 5min interval.

**`octoprint-adapter.ts`** (`octoprint.jobs`): Reads API key from `~/.secrets/octoprint.env` (`OCTOPRINT_API_KEY=...`). Makes `GET /api/job` and `GET /api/printer` to `http://192.168.10.141`. Uses `fetch` with 5s abort signal. Gracefully degrades if secrets file absent or host unreachable. 5min interval.

**`pipeline-adapter.ts`** (`pipeline.state`): Reads `~/Projects/helios/extensions/cortex/pipeline/state.json`. Detects: stuck stage (task in same stage > `anomaly_thresholds.pipeline_stuck_ms`), failed stage (`result = 'fail'` in state), sub-agent not posting to Synapse (checks `lastMessageTime` via bridge query). Maintains previous state snapshot in adapter for change detection. 2min interval.

**`cortex-session-adapter.ts`** (`cortex.session`): Reads current `SessionPersistenceManager` state directly (in-process, no I/O). Accesses `hot_topics`, `active_projects`, `pending_tasks` from the most recently captured session snapshot. Real-time — on-demand reads only, no timer.

**`cortex-atoms-adapter.ts`** (`cortex.atoms`): Calls `bridge.searchAtoms(hot_topics.join(' '))` to find causal patterns relevant to active context. Limits to top 5 results by confidence. 10min interval.

---

## 7. `cortex_predict` Tool (`index.ts`)

### Tool Registration

```typescript
api.registerTool({
  name: "cortex_predict",
  description:
    "Query the Predictive Intent system for current insights. Returns scored, queued, or recently delivered insights relevant to the given context.",
  inputSchema: Type.Object({
    query: Type.Optional(Type.String()),
    sources: Type.Optional(Type.Array(Type.String())),
    urgency_min: Type.Optional(
      Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("critical"),
      ]),
    ),
    include_queue: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Number()),
  }),
  handler: async (params) => {
    if (!predictConfig?.enabled) {
      return {
        insights: [],
        sources_polled: 0,
        sources_stale: [],
        last_poll: null,
        disabled: true,
      };
    }
    return pollingEngine.queryInsights(params);
  },
});
```

### `queryInsights` — reads from in-memory queue (no re-poll)

```typescript
queryInsights(params): { insights: Insight[], sources_polled, sources_stale, last_poll } {
  let results = Array.from(this.insightQueue.values());

  if (params.query) {
    results = results.filter(i =>
      i.title.toLowerCase().includes(params.query!.toLowerCase()) ||
      i.body.toLowerCase().includes(params.query!.toLowerCase()) ||
      i.source_id.includes(params.query!)
    );
  }
  if (params.sources?.length) {
    results = results.filter(i => params.sources!.includes(i.source_id));
  }
  const urgencyOrder = { low: 0, medium: 1, high: 2, critical: 3 };
  if (params.urgency_min) {
    const minLevel = urgencyOrder[params.urgency_min];
    results = results.filter(i => urgencyOrder[i.urgency] >= minLevel);
  }
  if (!params.include_queue) {
    results = results.filter(i => i.state === 'delivered');
  }
  results = results
    .sort((a, b) => b.urgency_score - a.urgency_score)
    .slice(0, params.limit ?? 5);

  const stale = Array.from(this.lastReadings.values())
    .filter(r => Date.now() - new Date(r.captured_at).getTime() > r.freshness_ms)
    .map(r => r.source_id);

  return { insights: results, sources_polled: this.adapters.size, sources_stale: stale, last_poll: this.lastPollTime };
}
```

---

## 8. `index.ts` Wiring Changes

### `registerService.start()` additions

```typescript
// Initialize Predictive Intent (after session persistence init)
if (config?.predictive_intent?.enabled !== false) {
  predictConfig = mergeWithDefaults(config?.predictive_intent);
  focusModeTracker.configure(
    predictConfig.delivery.focus_detection_window_ms,
    predictConfig.delivery.focus_detection_min_calls,
  );
  pollingEngine = new PollingEngine(bridge, predictConfig);
  deliveryRouter = new DeliveryRouter(bridge, predictConfig);
  feedbackTracker = new FeedbackTracker(bridge, predictConfig);
  briefingGenerator = new BriefingGenerator(pollingEngine, sessionManager, predictConfig);
  patternLearner = new PatternLearner(bridge, predictConfig);
  await pollingEngine.start();
  await briefingGenerator.checkMorningBrief(); // Trigger if applicable
}
```

### `registerService.stop()` additions

```typescript
if (pollingEngine) await pollingEngine.stop();
```

### `before_tool_call` additions

```typescript
// Tick focus mode tracker (additive — before existing hook logic)
if (pollingEngine) {
  focusModeTracker.tick();
  // Inject relevant insights into hook knowledge payload
  const relevant = pollingEngine.getRelevantInsights(contextExtractor.getKeywords(toolCall));
  if (relevant.length > 0) {
    knowledgePayload.predictive_insights = relevant.map(
      (i) => `[${i.urgency.toUpperCase()}] ${i.title}: ${i.body}`,
    );
  }
}
```

### `before_agent_start` additions

```typescript
// Flush batched low/medium insights into preamble (additive — appended after session preamble)
if (deliveryRouter) {
  const batched = await deliveryRouter.flushBatch();
  if (batched.length > 0) {
    preambleText += "\n\n" + formatBatchedInsights(batched);
  }
}
```

### `agent_end` additions

```typescript
// Check feedback on delivered insights (implicit action detection)
if (feedbackTracker && lastToolCall) {
  await feedbackTracker.checkImplicitAction(lastToolCall, bridge.getRecentDeliveredInsights());
}
```

---

## 9. Pre-Action Hook Integration (`enforcement-engine.ts`)

**Additive change only** — adds one step after existing SOP/knowledge discovery steps:

```typescript
// Step 4 (NEW): Inject predictive insights into knowledge payload
if (pollingEngine) {
  const keywords = contextExtractor.extractKeywords(toolCall);
  const insights = pollingEngine.getRelevantInsights(keywords);
  if (insights.length > 0) {
    knowledgePayload.sections.push({
      title: "Predictive Alerts",
      content: insights
        .map((i) => `⚡ [${i.urgency.toUpperCase()}] ${i.title}\n${i.body}`)
        .join("\n\n"),
    });
  }
}
```

No change to blocking logic, SOP enforcement, or allowed/denied tool decisions.

---

## 10. brain.db Python Layer (`python/predict_manager.py`)

New Python module following the pattern of `session_manager.py`. Exposes:

```python
class PredictManager:
    def save_insight(self, insight: dict) -> None
    def update_insight_state(self, insight_id: str, state: str, extra: dict = None) -> None
    def get_queued_insights(self) -> list[dict]          # For startup recovery
    def save_feedback(self, feedback: dict) -> None
    def get_action_rate(self, source_id: str, insight_type: str) -> dict
    def upsert_action_rate(self, source_id: str, insight_type: str, rate: float, count: int, halved: bool) -> None
    def get_feedback_history(self, source_id: str, insight_type: str, acted_on: bool, window_days: int) -> list[dict]
    def get_recent_delivered(self, limit: int = 10) -> list[dict]  # For feedback detection
    def expire_stale_insights(self) -> int               # Returns count expired
```

Called via `CortexBridge.runPython()` with new `PredictBridgeMethods` wrapper in `cortex-bridge.ts`.

---

## 11. Metrics Events

All 8 required metric events written via `writeMetric('pipeline', {...})` using the existing metrics writer infrastructure:

| Event                          | Trigger                                             |
| ------------------------------ | --------------------------------------------------- |
| `predict_poll_cycle`           | End of each full poll cycle (all adapters run once) |
| `predict_insight_generated`    | Each new insight created                            |
| `predict_insight_delivered`    | Each insight dispatched to channel                  |
| `predict_insight_expired`      | Each insight state → `expired`                      |
| `predict_feedback_recorded`    | Each `InsightFeedback` written                      |
| `predict_anomaly_detected`     | Each `anomaly`-type insight generated               |
| `predict_pattern_atom_created` | Each atom created by PatternLearner                 |
| `predict_rate_halved`          | Each auto-halving trigger                           |

**`cortex stats` extension**: Add `predictive_intent_status` section to brain_api.py that returns:

- `last_poll_time`: ISO timestamp
- `insights_queued`: count of queued insights
- `sources_polled`: count of registered adapters
- `sources_stale`: list of stale source IDs
- `feedback_count`: total feedback records in DB

---

## 12. Default Configuration

```json
{
  "predictive_intent": {
    "enabled": true,
    "poll_intervals_ms": {
      "augur.signals": 60000,
      "augur.trades": 300000,
      "augur.regime": 300000,
      "augur.paper": 900000,
      "git.activity": 600000,
      "fleet.health": 300000,
      "octoprint.jobs": 300000,
      "pipeline.state": 120000,
      "cortex.session": 0,
      "cortex.atoms": 600000
    },
    "staleness_thresholds_ms": {
      "augur.signals": 120000,
      "augur.trades": 600000,
      "augur.regime": 600000,
      "augur.paper": 1800000,
      "git.activity": 1200000,
      "fleet.health": 600000,
      "octoprint.jobs": 600000,
      "pipeline.state": 240000,
      "cortex.session": 30000,
      "cortex.atoms": 1200000
    },
    "urgency_thresholds": {
      "high": 0.6,
      "critical": 0.85
    },
    "delivery": {
      "signal_channel": "signal",
      "focus_detection_window_ms": 90000,
      "focus_detection_min_calls": 3,
      "batch_window_ms": 300000,
      "duplicate_window_ms": 3600000
    },
    "anomaly_thresholds": {
      "augur_signal_stale_ms": 300000,
      "augur_loss_streak": 3,
      "augur_pnl_loss_pct": 0.02,
      "fleet_ssh_timeout_ms": 5000,
      "pipeline_stuck_ms": 3600000
    },
    "feedback": {
      "action_window_ms": 600000,
      "rate_increase_per_act": 0.1,
      "rate_decrease_per_ignore": 0.05,
      "min_observations": 20,
      "low_value_threshold": 0.1
    },
    "briefings": {
      "morning_hour_est": 6,
      "pre_sleep_idle_ms": 5400000,
      "suppression_window_ms": 14400000
    },
    "octoprint": {
      "host": "http://192.168.10.141",
      "secrets_file": "~/.secrets/octoprint.env"
    },
    "debug": false
  }
}
```

---

## 13. Security Design

- **No credential exposure in insights**: Insight bodies are constructed from structured summary data only. Adapter handlers explicitly strip any field matching `key|token|password|secret` patterns before passing to InsightGenerator.
- **AUGUR read-only**: All SQLite opens use `file:path?mode=ro` URI. If write is attempted, sqlite3 will throw `SQLITE_READONLY` — treated as adapter error, logged, cycle skipped.
- **SSH read-only**: Fleet adapter command is hardcoded as `echo ok` — no parameterized host commands. Host list comes from known inventory file (not user-supplied input at runtime).
- **Signal rate limiting**: Hard cap of 1 critical signal per 5 minutes per source_id enforced in DeliveryRouter, not configurable below 30 seconds (minimum guard against config errors).
- **OctoPrint API key**: Stored in `~/.secrets/octoprint.env`, chmod 600 on creation. Never written to brain.db or log files.
- **Pattern atom isolation**: All atoms created by PatternLearner carry `source: 'predictive-intent'` tag. Atom search for prediction scoring filters to this tag to prevent contamination from hand-curated atoms.
- **No external transmission**: All insight data stays local. Signal delivery uses existing OpenClaw `message` plugin infrastructure — predictive module never makes raw HTTP calls to Signal endpoints.

---

## 14. Testing Strategy

### Unit Tests

Each module gets its own test file using mock data injection:

- `polling-engine.test.ts`: Verify source registration, timer scheduling, reading cache, graceful degradation when adapter throws
- `insight-generator.test.ts`: Feed mock readings → assert correct insight types, dedup suppression, expiry logic
- `urgency-scorer.test.ts`: Assert scoring formula produces correct tier for known input combinations (open trade <15min expiry → critical; low-stakes git pattern → low)
- `delivery-router.test.ts`: Verify batching, focus-mode suppression, signal rate limiting, correct channel assignment per tier
- `feedback-tracker.test.ts`: Simulate explicit/implicit/ignored sequences → verify rate update math, auto-halving trigger

### Integration Tests

- Startup recovery: Write mock `insights` rows in `queued` state to brain.db → restart PollingEngine → verify queue populated
- Full cycle: Mock all adapters → run one poll cycle → verify insights generated, scored, routed, metric events emitted
- Pre-action hook injection: Call enforcement-engine with mock pollingEngine returning a `high`-urgency insight → verify injection appears in knowledge payload

### Acceptance Tests

Mapped to AC-001 through AC-011 in requirements. All use adapter mock injection — no live AUGUR, fleet, or OctoPrint connections required for CI.

---

## 15. Open Questions for Build Stage

1. **`cortex.atoms` adapter uses `atom_search` tool — but that's an OpenClaw tool, not a direct bridge call.** Build stage should implement a direct Python call to atom DB instead, consistent with how other bridge methods work.

2. **`cortex.session` adapter reads SessionPersistenceManager in-process** — confirm module is exported from `session/session-manager.ts` and accessible as a singleton (no additional init needed).

3. **Git repo discovery**: Scanning `~/Projects/` with max-depth-1 should cover all known repos. Build stage should hardcode a repo list fallback if directory scan fails.

4. **Briefing-generator pre-sleep timer**: 15-minute idle check timer needs to be careful not to cause runaway wake events when the gateway is idle. Use `Date.now()` comparison against last recorded `agent_end` timestamp — don't send brief if no session has been active at all today.

5. **`cortex stats` Python extension**: Confirm Python brain_api.py extension pattern from v1.3.0 metrics task to add `predictive_intent_status` correctly.

---

## 16. Version and Branch

- **Release**: Cortex v2.1.0
- **Branch**: `feature/predictive-intent-v2.1.0`
- **Tag**: `cortex-v2.1.0`
- **Commit convention**: `feat(predict): <description>` for features, `fix(predict): <description>` for corrections
- **Files changed**: ~25 new files, 5 modified files
- **Estimated LOC**: ~1,800 new TypeScript, ~400 new Python
- **Depends on**: Session persistence types exported from `session/types.ts` (confirmed available)

---

**Next Stage**: document — Write API reference, usage guide, and behavioral signatures for the predictive intent system.
