# Cross-Session State Preservation — API Documentation & Developer Guide

**Task ID:** task-004-session-persistence  
**Stage:** document  
**Author:** Documentation Specialist (Pipeline)  
**Date:** 2026-02-18  
**Cortex Target Version:** 2.0.0  
**Requires:** Cortex v1.5.0+, brain.db schema v4+

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [TypeScript API Reference](#3-typescript-api-reference)
   - [Types & Interfaces](#31-types--interfaces)
   - [SessionPersistenceManager](#32-sessionpersistencemanager)
   - [DecayEngine](#33-decayengine)
   - [ContextScorer](#34-contextscorer)
   - [HotTopicExtractor](#35-hottopicextractor)
   - [PreambleInjector](#36-preambleinjector)
4. [Python API Reference](#4-python-api-reference)
   - [SessionManager](#41-sessionmanager)
5. [CortexBridge Session Methods](#5-cortexbridge-session-methods)
6. [Plugin Configuration](#6-plugin-configuration)
7. [Tool Registration](#7-tool-registration)
8. [Database Schema](#8-database-schema)
9. [Integration Guide](#9-integration-guide)
   - [Lifecycle Hook Wiring](#91-lifecycle-hook-wiring)
   - [Preamble Injection in before_agent_start](#92-preamble-injection-in-before_agent_start)
   - [Hot Topic Accumulation Hooks](#93-hot-topic-accumulation-hooks)
10. [Configuration Reference](#10-configuration-reference)
11. [Metrics Events](#11-metrics-events)
12. [Migration Guide](#12-migration-guide)
    - [brain.db Schema v4](#121-braindb-schema-v4)
    - [Applying the Migration](#122-applying-the-migration)
13. [Developer Guide](#13-developer-guide)
    - [Adding a New Signal Source](#131-adding-a-new-signal-source)
    - [Tuning Relevance Thresholds](#132-tuning-relevance-thresholds)
    - [Credential Redaction Patterns](#133-credential-redaction-patterns)
    - [Debug Mode](#134-debug-mode)
14. [Testing Guide](#14-testing-guide)
    - [Unit Tests](#141-unit-tests)
    - [Integration Tests](#142-integration-tests)
    - [Performance Benchmarks](#143-performance-benchmarks)
15. [Troubleshooting](#15-troubleshooting)
16. [Changelog / Version History](#16-changelog--version-history)

---

## 1. Overview

The **Cross-Session State Preservation** system ensures Helios maintains meaningful context across session boundaries — restarts, crashes, and multi-day gaps. Before v2.0.0, every process restart was a cold start: working memory was lost, pending tasks were forgotten, and active project context evaporated.

**What it does:**

- Captures a structured `SessionState` snapshot at every session boundary (graceful or crash)
- Scores prior sessions for relevance using recency, topic overlap, and pending task weight
- Restores working memory pins, pending task alerts, and hot topics into new sessions within 2 seconds of startup
- Applies time-based confidence decay to inherited memories — context gets softer as it ages, never abruptly vanishes
- Provides crash recovery: abrupt kills are detected and their state partially recovered

**What it does NOT do:**

- Consolidate or merge memories (Phase 2.2)
- Sync sessions across machines (local-only)
- Extend to sub-agents (Phase 3.1)
- Replay or replay-debug session history

**Resulting user experience:** The answer to _"Will you remember in 2 days?"_ changes from **NO** to **YES, with graceful decay**.

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                       SESSION LIFECYCLE                             │
│                                                                     │
│  registerService.start()                registerService.stop()      │
│         │                                       │                   │
│         ▼                                       ▼                   │
│  ┌─────────────────┐                  ┌──────────────────┐          │
│  │ SessionManager  │                  │  SessionManager  │          │
│  │  .onSessionStart│                  │  .onSessionEnd   │          │
│  └────────┬────────┘                  └────────┬─────────┘          │
│           │                                    │                    │
│           │ fetchRecentSessions()              │ captureState()     │
│           │ score() + filter()                 │ redactCredentials()│
│           │ inheritPins()                      │ detectPending()    │
│           │ buildPreamble()                    │ writeDB()          │
│           │                                    │ writeJSONMirror()  │
│           ▼                                    │ emitMetrics()      │
│  ┌─────────────────┐         agent_end()       │                    │
│  │ RestoredContext  │  ◄──── updatePartial() ──┘                    │
│  │ (module-level)  │         (crash-safe)                           │
│  └────────┬────────┘                                                │
│           │                                                         │
│           ▼  before_agent_start (first turn only)                   │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │               CONTEXT INJECTION ORDER                      │    │
│  │  1. [session-continuity] preamble  (L0 — always first)     │    │
│  │  2. [working-memory]     pins      (L1 — structural)       │    │
│  │  3. [hot-memory]         STM       (L2 — frequent)         │    │
│  │  4. [episodic-memory]    recent    (L3 — event)            │    │
│  │  5. [semantic-memory]    search    (L4 — semantic)         │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────┐    ┌──────────────────────┐
│   HotTopicExtractor  │    │    ContextScorer      │
│ (stateful accumulator│    │ relevanceScore =      │
│  across all turns)   │    │  recency×0.4          │
│                      │    │  + topicOverlap×0.35  │
│ Signals:             │    │  + pendingTasks×0.25  │
│ - exec workdirs      │    └──────────────────────┘
│ - cortex_add cats    │    ┌──────────────────────┐
│ - working_memory pin │    │    DecayEngine        │
│ - synapse subjects   │    │ factor = max(0.3,     │
│ - before_agent prompt│    │  1-(h/168)×0.4)       │
└──────────────────────┘    └──────────────────────┘
```

**Data Flow:**

```
brain.db (session_states table)
  ↑ write                    ↓ read
SessionPersistenceManager  ←→  CortexBridge  ←→  session_manager.py
  ↑ read
~/.openclaw/sessions/{session_id}.json  (JSON mirror — read by external tools)
```

---

## 3. TypeScript API Reference

### 3.1 Types & Interfaces

**File:** `extensions/cortex/session/types.ts`

---

#### `SessionState`

The canonical record for a single session's captured context.

```typescript
export interface SessionState {
  /** UUID generated at session start — primary key in session_states table */
  session_id: string;

  /** ISO 8601 — set in registerService.start() */
  start_time: string;

  /** ISO 8601 — set in registerService.stop(); NULL if session is active or crashed */
  end_time: string;

  /** Channel name: "signal", "cli", "discord", etc. */
  channel: string;

  /** Full working memory pin list at session end (CRITICAL pins always included) */
  working_memory: WorkingMemoryPin[];

  /** Top-N session keywords ranked by frequency (TF-IDF-style). Max 20. */
  hot_topics: string[];

  /** Project names detected from exec workdirs, file paths, synapse messages */
  active_projects: string[];

  /** LBF tasks flagged incomplete at session end */
  pending_tasks: PendingTask[];

  /** cortex memory IDs created via cortex_add during this session */
  recent_learnings: string[];

  /** All confidence score changes made during this session */
  confidence_updates: ConfidenceUpdate[];

  /** Which SOPs fired and whether they were acknowledged */
  sop_interactions: SOPInteraction[];

  /** Link to the prior session ID — forms the session chain */
  previous_session_id: string | null;

  /** Set when a subsequent session loads this one for restoration */
  continued_by: string | null;

  /** True if this record was written by crash recovery (not a clean shutdown) */
  crash_recovered?: boolean;

  /** Schema version for future migrations. Currently: 1 */
  schema_version: number;

  // ── Computed at restore time — NOT stored in brain.db ──────────────────
  /** 0–1 score: how relevant this prior session is to the current session */
  relevance_score?: number;

  /** ISO 8601 — when this session state was loaded into the current session */
  inherited_at?: string;
}
```

---

#### `WorkingMemoryPin`

Mirrors the pin format used by `working_memory.json`.

```typescript
export interface WorkingMemoryPin {
  /** Pin content (may include inline provenance label when inherited) */
  content: string;

  /** ISO 8601 — when the pin was created */
  pinnedAt: string;

  /**
   * Short display label for the pin.
   * Inherited pins append: " [inherited from {session_id} @ {date}]"
   */
  label?: string;
}
```

---

#### `PendingTask`

An LBF task flagged as incomplete at session end.

```typescript
export interface PendingTask {
  /** LBF task ID (e.g., "task-004-session-persistence") */
  task_id: string;

  /** Task title from pipeline/state.json or working memory scan */
  title: string;

  /** Last known pipeline stage (e.g., "build", "verify", "validate") */
  stage: string;

  /**
   * true = detected from a working memory pin pattern ("TODO", "incomplete", etc.)
   * false = detected from pipeline/state.json active_tasks scan
   */
  flagged_incomplete: boolean;
}
```

---

#### `ConfidenceUpdate`

Records a confidence score change made during the session.

```typescript
export interface ConfidenceUpdate {
  /** brain.db memory ID */
  memory_id: string;

  /** Confidence score before the update */
  old_score: number;

  /** Confidence score after the update */
  new_score: number;

  /**
   * Reason for the change:
   * - "sop_boost" — SOP consultation triggered a boost
   * - "repeated_access" — memory accessed 3+ times in session
   * - "hook_penalty" — pre-action hook penalized (tool called without SOP)
   * - "manual" — agent called cortex_update directly
   */
  reason: string;

  /** ISO 8601 */
  timestamp: string;
}
```

---

#### `SOPInteraction`

Records a single SOP injection event during the session.

```typescript
export interface SOPInteraction {
  /** Absolute path to the SOP file */
  sop_path: string;

  /** ISO 8601 — when the SOP was injected */
  injected_at: string;

  /**
   * Whether the agent acknowledged the SOP.
   * Tracked by looking for the SOP's acknowledgment keyword in the agent's reply.
   */
  acknowledged: boolean;

  /** The tool call that triggered the SOP lookup */
  tool_call: string;
}
```

---

#### `RestoredSessionContext`

Return value from `SessionPersistenceManager.onSessionStart()`. Cached module-level until the first agent turn.

```typescript
export interface RestoredSessionContext {
  /**
   * Formatted preamble string to inject into before_agent_start context.
   * null if no qualifying prior sessions found (cold start — silent).
   */
  preamble: string | null;

  /** Pins to write into working_memory.json — max 5, provenance-labeled */
  inheritedPins: WorkingMemoryPin[];

  /** Session IDs that contributed to restoration */
  sessionIds: string[];

  /** Relevance scores (parallel array with sessionIds) */
  relevanceScores: number[];

  /** Total pending task count surfaced (across all contributing sessions) */
  pendingTaskCount: number;
}
```

---

### 3.2 SessionPersistenceManager

**File:** `extensions/cortex/session/session-manager.ts`

The central orchestrator. Registered as a singleton in `index.ts` and wired into all three lifecycle surfaces.

---

#### Constructor

```typescript
constructor(
  bridge: CortexBridge,
  logger: Logger,
  config: SessionPersistenceConfig
)
```

| Parameter | Type                       | Description                     |
| --------- | -------------------------- | ------------------------------- |
| `bridge`  | `CortexBridge`             | Cortex bridge for DB operations |
| `logger`  | `Logger`                   | OpenClaw logger instance        |
| `config`  | `SessionPersistenceConfig` | Plugin config block (see §6)    |

---

#### `onSessionStart(sessionId, channel)`

Called from `registerService.start()`. Performs crash recovery, then restores qualifying prior sessions.

```typescript
async onSessionStart(
  sessionId: string,
  channel: string
): Promise<RestoredSessionContext>
```

**Behavior:**

1. Calls `detectAndRecoverCrashed(sessionId)` — writes recovery records for crashed sessions
2. Writes an initial `session_states` record with `start_time` and NULL `end_time` (active marker)
3. Fetches last `config.lookback_days` (default: 7) of completed sessions via bridge
4. Scores each session via `ContextScorer.score()`
5. Drops sessions with `relevance_score < config.relevance_threshold` (default: 0.25)
6. Sorts descending by score, takes top `config.max_sessions_scored` (default: 3)
7. For the highest-scoring session, inherits working memory pins (up to `config.max_inherited_pins`)
8. Builds preamble via `PreambleInjector.format()`
9. Emits `session_restored` metric
10. Calls `markSessionContinued()` on all restored sessions
11. Returns `RestoredSessionContext`

**Performance guarantee:** If the entire restoration phase exceeds 1500ms, it is aborted and a cold-start `RestoredSessionContext` with `preamble: null` is returned. The error is logged but does not block startup.

---

#### `updateSessionState(partial)`

Called from the `agent_end` hook after every turn. Provides crash-safe incremental capture.

```typescript
async updateSessionState(
  partial: Partial<SessionState>
): Promise<void>
```

Performs an UPSERT on the `session_states` record for the current session. Only the fields present in `partial` are updated; all others are preserved.

**Typical fields updated per turn:**

- `hot_topics` — from `HotTopicExtractor.getCurrentTopics()`
- `active_projects` — from `HotTopicExtractor.getActiveProjects()`
- `recent_learnings` — from `HotTopicExtractor.getRecentLearningIds()`
- `updated_at` — ISO 8601 current time

---

#### `onSessionEnd(sessionId)`

Called from `registerService.stop()`. Writes the final complete SessionState record.

```typescript
async onSessionEnd(sessionId: string): Promise<void>
```

**Behavior:**

1. Loads current `working_memory.json`
2. Redacts credential patterns from pin content (see §13.3)
3. Builds final `SessionState` with all fields populated
4. UPSERTs to `brain.db session_states`
5. Writes JSON mirror to `~/.openclaw/sessions/{session_id}.json` (best-effort, failure is non-fatal)
6. Emits `session_captured` metric

---

#### `detectAndRecoverCrashed(currentSessionId)`

Detects sessions with NULL `end_time` that are not the current active session and writes crash recovery records.

```typescript
async detectAndRecoverCrashed(
  currentSessionId: string
): Promise<void>
```

**Recovery record fields:**

- `end_time`: estimated from `updated_at` (last incremental write) or `start_time + 1h` as fallback
- `crash_recovered: true`
- All other fields: preserved from last incremental `updateSessionState` call

---

#### `forceInheritSession(targetSessionId)`

FR-011: Manual override — forces full inheritance from a specific prior session regardless of age or relevance score.

```typescript
async forceInheritSession(
  targetSessionId: string
): Promise<RestoredSessionContext>
```

Invoked by the `cortex_session_continue` tool. No age cutoff, no relevance threshold — all pins and context from the target session are inherited (subject to pin cap). Logs the override with invoking agent and timestamp for audit.

---

#### `getSessionChain(sessionId, depth)`

Traverses the session chain backward via `previous_session_id` links.

```typescript
async getSessionChain(
  sessionId: string,
  depth: number
): Promise<SessionState[]>
```

Returns sessions in **chronological order** (oldest first). The chain is terminated when `previous_session_id` is NULL or `depth` is reached.

**Example:**

```typescript
const chain = await manager.getSessionChain(currentSessionId, 5);
// Returns: [session_5_days_ago, session_4_days_ago, ..., yesterday_session]
```

---

### 3.3 DecayEngine

**File:** `extensions/cortex/session/decay-engine.ts`

Pure functions — no state, no dependencies. Safe to call from anywhere.

---

#### `applyDecay(originalConfidence, hoursElapsed)`

Computes the decayed confidence for a memory inherited from a prior session.

```typescript
export function applyDecay(originalConfidence: number, hoursElapsed: number): number;
```

**Formula:**

```
decayFactor = max(0.3, 1.0 - (hoursElapsed / 168) × 0.4)
inheritedConfidence = originalConfidence × decayFactor
```

**Examples:**

| Hours Elapsed | Decay Factor | Original 1.0 → | Original 0.8 → |
| ------------- | ------------ | -------------- | -------------- |
| 0h            | 1.000        | 1.000          | 0.800          |
| 24h           | 0.943        | 0.943          | 0.754          |
| 48h           | 0.886        | 0.886          | 0.709          |
| 72h           | 0.829        | 0.829          | 0.663          |
| 120h          | 0.714        | 0.714          | 0.571          |
| 168h (7d)     | 0.600        | 0.600          | 0.480          |
| 200h          | 0.300        | 0.300          | 0.240          |

> **Note:** The `originalConfidence × decayFactor` product can go below 0.3, at which point the memory is excluded from inheritance entirely. The `max(0.3, ...)` floor applies to the _factor_, not the final product — memories with low original confidence may still be excluded.

**Usage:** Called by `ContextScorer` during session restoration. **Never** persisted — the `confidence` field in `brain.db stm` is untouched.

---

#### `shouldInherit(originalConfidence, hoursElapsed, floor?)`

Convenience predicate: returns true if the decayed confidence is above the inheritance floor.

```typescript
export function shouldInherit(
  originalConfidence: number,
  hoursElapsed: number,
  floor: number = 0.3,
): boolean;
```

---

### 3.4 ContextScorer

**File:** `extensions/cortex/session/context-scorer.ts`

Scores prior sessions for relevance to the current session context.

---

#### `score(session, currentContext, hoursElapsed)`

Computes the composite relevance score for a prior session.

```typescript
export function score(
  session: SessionState,
  currentContext: { keywords: string[] },
  hoursElapsed: number,
): number;
```

**Scoring formula:**

```
relevance_score = (recency_weight × 0.4)
                + (topic_overlap_weight × 0.35)
                + (pending_tasks_weight × 0.25)

recency_weight      = max(0, 1 - hoursElapsed / 168)
topic_overlap_weight = |currentKeywords ∩ session.hot_topics| / |currentKeywords ∪ session.hot_topics|
pending_tasks_weight = min(1.0, session.pending_tasks.length × 0.25)
```

**Component ranges:**
| Component | Weight | Min | Max | Notes |
|---|---|---|---|---|
| Recency | 0.40 | 0.0 | 0.40 | Zero at 7+ days |
| Topic overlap | 0.35 | 0.0 | 0.35 | Jaccard similarity |
| Pending tasks | 0.25 | 0.0 | 0.25 | Maxes out at 4+ tasks |

**Threshold:** Sessions with `score < 0.25` are excluded from restoration.

---

#### `scoreAll(sessions, currentContext)`

Batch-scores an array of sessions, sorting descending and filtering below threshold.

```typescript
export function scoreAll(
  sessions: SessionState[],
  currentContext: { keywords: string[] },
  threshold?: number,
): Array<{ session: SessionState; score: number; hoursElapsed: number }>;
```

Returns only sessions above the threshold, sorted by score descending.

---

### 3.5 HotTopicExtractor

**File:** `extensions/cortex/session/hot-topic-extractor.ts`

A stateful accumulator that runs throughout the entire session lifetime. A single instance is created in `registerService.start()` and stored as a module-level variable.

---

#### Constructor

```typescript
constructor(config?: { stopwords?: string[] })
```

Optionally accepts a custom stopword list. Defaults include common English stopwords plus tool names that aren't project-specific (`exec`, `read`, `write`, `edit`, `tool`, `file`, `path`).

---

#### Signal Recording Methods

These are called from existing hooks as signals are detected:

```typescript
/** Record a cortex category accessed (e.g., ["coding", "meta"]) */
recordMemoryAccess(categories: string[]): void

/** Record the label of a working memory pin */
recordWorkingMemoryLabel(label: string): void

/** Record an exec workdir (e.g., "/home/user/Projects/lbf-ham-radio") */
recordExecWorkdir(workdir: string): void

/** Record a Synapse message subject or recipient */
recordSynapseSignal(subject: string, recipient: string): void

/** Record a cortex_add memory ID (for recent_learnings tracking) */
recordLearningId(memoryId: string): void

/** Record raw text for keyword extraction (e.g., from agent prompts) */
recordText(text: string, weight?: number): void
```

---

#### Output Methods

```typescript
/** Top N keywords by frequency, deduplicated. Default N=20. */
getCurrentTopics(n?: number): string[]

/** Project names extracted from exec workdirs and synapse signals */
getActiveProjects(): string[]

/** All cortex memory IDs recorded via recordLearningId() this session */
getRecentLearningIds(): string[]

/** Raw frequency map (keyword → count) for debugging */
getFrequencyMap(): Map<string, number>
```

---

### 3.6 PreambleInjector

**File:** `extensions/cortex/session/preamble-injector.ts`

Formats the session continuity preamble from restored session context.

---

#### `format(context, options?)`

```typescript
export function format(
  context: {
    sessions: SessionState[];
    inheritedPins: WorkingMemoryPin[];
    pendingTasks: PendingTask[];
    hotTopics: string[];
    activeProjects: string[];
  },
  options?: {
    maxTopics?: number; // default: 10
    maxProjects?: number; // default: 5
    dateFormat?: "relative" | "absolute"; // default: 'relative'
  },
): string | null;
```

Returns `null` (no preamble) when:

- `context.sessions.length === 0`
- `context.inheritedPins.length === 0` AND `context.pendingTasks.length === 0` AND `context.hotTopics.length === 0`

**Output format:**

```
[SESSION CONTINUITY — inherited from {N} prior session(s)]

PENDING TASKS:
- [task-004-session-persistence] Cross-Session State Preservation (last stage: design, 2h ago)
- [task-003-pre-action-hooks] Pre-Action Hook System (last stage: done, 1d ago)

ACTIVE PROJECTS: helios/extensions/cortex, lbf-ham-radio

HOT TOPICS: cortex, session, persistence, brain.db, pipeline, hooks

WORKING MEMORY RESTORED: 3 pins inherited (use working_memory view to see all)
```

---

## 4. Python API Reference

### 4.1 SessionManager

**File:** `extensions/cortex/python/session_manager.py`

All database operations for `session_states` table. Called via `bridge.runPython()` — never imported directly from TypeScript.

---

#### `save_session(session_dict)`

UPSERT a session record. Accepts a dict matching `SessionState` interface (JSON-serialized arrays for list fields).

```python
def save_session(self, session_dict: dict) -> None
```

**SQL operation:** `INSERT OR REPLACE INTO session_states ...`

---

#### `get_recent_sessions(days, limit)`

Fetch completed sessions (sessions with a non-NULL `end_time`) within the last `days` days.

```python
def get_recent_sessions(self, days: int = 7, limit: int = 20) -> list[dict]
```

**SQL:** Uses `idx_session_endtime` index on `(end_time, start_time)` for performance.

**Returns:** List of session dicts, sorted by `end_time` descending (most recent first).

---

#### `get_crashed_sessions(active_session_id)`

Find sessions that appear crashed (NULL `end_time`, not the current active session).

```python
def get_crashed_sessions(self, active_session_id: str) -> list[dict]
```

**SQL:** `SELECT * FROM session_states WHERE end_time IS NULL AND id != ?`

---

#### `mark_continued(session_id, next_id)`

Set `continued_by` on a prior session when it has been loaded for restoration.

```python
def mark_continued(self, session_id: str, next_id: str) -> None
```

---

#### `recover_crashed(session_id, estimated_end_time)`

Write a crash recovery record: set `end_time`, `crash_recovered=1`, `updated_at`.

```python
def recover_crashed(self, session_id: str, estimated_end_time: str) -> None
```

---

#### `get_session_chain(session_id, depth)`

Traverses the chain backward via `previous_session_id`, up to `depth` hops.

```python
def get_session_chain(self, session_id: str, depth: int = 5) -> list[dict]
```

**Returns:** List of session dicts in **chronological order** (oldest first). Stops early if `previous_session_id` is NULL or the chain terminates.

---

## 5. CortexBridge Session Methods

**File:** `extensions/cortex/cortex-bridge.ts` (additions)

These are thin TypeScript wrappers that call `session_manager.py` via `bridge.runPython()`. They follow the same pattern as all existing bridge methods.

```typescript
interface CortexBridge {
  // ── Session Persistence Methods (new in v2.0.0) ─────────────────────────

  /** UPSERT a session record */
  saveSessionState(state: SessionState): Promise<void>;

  /** Fetch sessions completed within the last N days */
  getRecentSessions(days: number, limit?: number): Promise<SessionState[]>;

  /** Set continued_by on prior sessions */
  markSessionContinued(sessionId: string, nextSessionId: string): Promise<void>;

  /** Find sessions with NULL end_time (crashed) */
  detectCrashedSessions(activeSessionId: string): Promise<SessionState[]>;

  /** Write crash recovery record */
  recoverCrashedSession(sessionId: string): Promise<void>;

  /** Traverse session chain backward */
  getSessionChain(sessionId: string, depth: number): Promise<SessionState[]>;
}
```

---

## 6. Plugin Configuration

**Location:** OpenClaw plugin config → `cortex.session_persistence`

**TypeBox schema** (in `index.ts`):

```typescript
session_persistence: Type.Object({
  /** Master switch. Set false to disable session persistence entirely. */
  enabled: Type.Boolean({ default: true }),

  /**
   * How many days back to look for prior sessions.
   * Sessions older than this are never scored or restored.
   * Range: 1–30
   */
  lookback_days: Type.Number({ default: 7, minimum: 1, maximum: 30 }),

  /**
   * Minimum relevance_score for a session to be included in restoration.
   * Sessions scoring below this are silently skipped.
   * Range: 0.1–1.0
   */
  relevance_threshold: Type.Number({ default: 0.25, minimum: 0.1, maximum: 1.0 }),

  /**
   * Maximum number of prior sessions that may contribute to restoration simultaneously.
   * Only the highest-scoring sessions (up to this count) contribute.
   * Range: 1–10
   */
  max_sessions_scored: Type.Number({ default: 3, minimum: 1, maximum: 10 }),

  /**
   * Maximum working memory pins inherited from prior sessions.
   * Hard cap — working memory max is 10; 5 inherited leaves 5 for current session.
   * Range: 1–8
   */
  max_inherited_pins: Type.Number({ default: 5, minimum: 1, maximum: 8 }),

  /**
   * Minimum confidence floor for the decay factor.
   * A memory is excluded from inheritance if its decayed confidence falls below this.
   * Range: 0.1–0.9
   */
  decay_min_floor: Type.Number({ default: 0.3, minimum: 0.1, maximum: 0.9 }),

  /**
   * How many days back CRITICAL-tagged pins are inherited, regardless of relevance score.
   * CRITICAL pins bypass the relevance threshold up to this age.
   * Range: 1–30
   */
  critical_inheritance_days: Type.Number({ default: 7, minimum: 1, maximum: 30 }),

  /**
   * Directory for JSON mirror files of completed sessions.
   * Created automatically on first session capture.
   */
  sessions_dir: Type.String({ default: "~/.openclaw/sessions" }),

  /**
   * Verbose debug logging for all scoring decisions and inheritance choices.
   * Also enabled by CORTEX_SESSION_DEBUG=1 environment variable.
   */
  debug: Type.Boolean({ default: false }),
});
```

**Example openclaw.json config block:**

```json
{
  "plugins": {
    "cortex": {
      "session_persistence": {
        "enabled": true,
        "lookback_days": 7,
        "relevance_threshold": 0.25,
        "max_sessions_scored": 3,
        "max_inherited_pins": 5,
        "decay_min_floor": 0.3,
        "critical_inheritance_days": 7,
        "sessions_dir": "~/.openclaw/sessions",
        "debug": false
      }
    }
  }
}
```

---

## 7. Tool Registration

### `cortex_session_continue`

FR-011: Manual session continuity override. Forces full inheritance from a specific prior session regardless of age or relevance score.

**Registration:** `index.ts` (alongside existing cortex tools)

**Parameters:**

```typescript
{
  session_id: string; // Required. The prior session ID to force-inherit from.
}
```

**Behavior:**

1. Calls `SessionPersistenceManager.forceInheritSession(session_id)`
2. Inherits all working memory pins from target session (up to `max_inherited_pins`, with provenance labels)
3. Injects inherited context into current working memory via `saveWorkingMemory()`
4. Returns a summary of what was inherited
5. Logs the override to audit trail: `{invoking_agent, session_id, timestamp}`

**Example usage:**

```
cortex_session_continue({ session_id: "a1b2c3d4-..." })
```

**Output:**

```
Inherited from session a1b2c3d4 (2026-02-14 09:23 EST):
- 4 working memory pins restored
- 2 pending tasks surfaced
- 15 hot topics loaded
Pins written to working memory.
```

---

## 8. Database Schema

### `session_states` table (brain.db, migration v4)

Added to `brain.py → _init_schema()`.

```sql
CREATE TABLE IF NOT EXISTS session_states (
    -- Primary identity
    id TEXT PRIMARY KEY,                     -- UUID (session_id)
    start_time TEXT NOT NULL,                -- ISO 8601
    end_time TEXT,                           -- NULL = active or crashed
    channel TEXT DEFAULT 'unknown',          -- "signal", "cli", etc.

    -- Active context snapshots (JSON-encoded arrays)
    working_memory TEXT NOT NULL DEFAULT '[]',    -- WorkingMemoryPin[]
    hot_topics TEXT NOT NULL DEFAULT '[]',        -- string[]
    active_projects TEXT NOT NULL DEFAULT '[]',   -- string[]
    pending_tasks TEXT NOT NULL DEFAULT '[]',     -- PendingTask[]

    -- Knowledge state
    recent_learnings TEXT NOT NULL DEFAULT '[]',       -- string[] (memory IDs)
    confidence_updates TEXT NOT NULL DEFAULT '[]',     -- ConfidenceUpdate[]
    sop_interactions TEXT NOT NULL DEFAULT '[]',       -- SOPInteraction[]

    -- Session chain (bidirectional links)
    previous_session_id TEXT,               -- FK → prior session ID (nullable)
    continued_by TEXT,                      -- Set by next session on load

    -- Recovery metadata
    crash_recovered INTEGER DEFAULT 0,      -- 1 if recovered from unclean shutdown

    -- Schema versioning
    schema_version INTEGER DEFAULT 1,

    -- Timestamps
    created_at TEXT NOT NULL,
    updated_at TEXT
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_session_endtime
    ON session_states(end_time, start_time);

CREATE INDEX IF NOT EXISTS idx_session_prev
    ON session_states(previous_session_id);

CREATE INDEX IF NOT EXISTS idx_session_channel
    ON session_states(channel, start_time);
```

**Notes:**

- All list/object fields are stored as JSON strings; `session_manager.py` serializes/deserializes transparently
- `id` = `session_id` (using `id` as column name for ORM compatibility)
- `previous_session_id` is not a strict FK (no FOREIGN KEY constraint) to allow out-of-order recovery writes
- `schema_version = 1` for all records created in v2.0.0

### Data Retention

Sessions older than 30 days are archived nightly by the existing `runMaintenance()` task (extended in v2.0.0):

- **Archive**: Copy record to `~/.openclaw/sessions/archive/{YYYY-MM}/{session_id}.json`
- **Delete**: Remove from `session_states` table
- This keeps the hot `session_states` table small (typically < 200 rows for a 30-day window)

---

## 9. Integration Guide

### 9.1 Lifecycle Hook Wiring

**File:** `extensions/cortex/index.ts`

Three integration points must be added to the existing lifecycle hooks:

#### `registerService.start()` — Session Initialization

```typescript
// After existing initialization (brain.db open, loadSTMDirect, etc.)
// Create the session ID and SessionPersistenceManager singleton
const sessionId = crypto.randomUUID();
let restoredSessionContext: RestoredSessionContext | null = null;
let preambleInjected = false;

const sessionManager = new SessionPersistenceManager(bridge, logger, config.session_persistence);

if (config.session_persistence?.enabled !== false) {
  try {
    restoredSessionContext = await sessionManager.onSessionStart(sessionId, channelName);
  } catch (err) {
    logger.warn("[session] Restoration failed, cold start:", err);
    restoredSessionContext = null;
  }
}
```

#### `agent_end` Hook — Incremental Capture

```typescript
// Append to existing agent_end hook, AFTER the current auto-capture block:
if (config.session_persistence?.enabled !== false && sessionId) {
  await sessionManager
    .updateSessionState({
      session_id: sessionId,
      hot_topics: hotTopicExtractor.getCurrentTopics(),
      active_projects: hotTopicExtractor.getActiveProjects(),
      recent_learnings: hotTopicExtractor.getRecentLearningIds(),
      updated_at: new Date().toISOString(),
    })
    .catch((err) => logger.warn("[session] Incremental update failed:", err));
}
```

#### `registerService.stop()` — Final Capture

```typescript
// Prepend to existing cleanup in registerService.stop():
if (config.session_persistence?.enabled !== false && sessionId) {
  try {
    await sessionManager.onSessionEnd(sessionId);
  } catch (err) {
    logger.warn("[session] Final capture failed:", err);
    // Non-fatal: best-effort capture
  }
}
```

---

### 9.2 Preamble Injection in `before_agent_start`

The session continuity preamble is injected as the **first context part**, before L1 Working Memory, using the module-level `preambleInjected` flag to ensure it appears only once per session.

```typescript
// In the existing before_agent_start hook, BEFORE the L1 working memory block:

// L0: Session Continuity Preamble (injected once, first turn only)
if (!preambleInjected && restoredSessionContext?.preamble) {
  contextParts.push(
    `<session-continuity hint="inherited from prior sessions">\n` +
      restoredSessionContext.preamble +
      `\n</session-continuity>`,
  );
  preambleInjected = true;

  // Write inherited pins to working_memory.json (also first-turn only)
  if (restoredSessionContext.inheritedPins.length > 0) {
    await inheritPins(restoredSessionContext.inheritedPins, logger);
  }
}

// L1: Working Memory (existing block — unchanged)
// ...
```

**`inheritPins()` implementation:**

```typescript
async function inheritPins(inheritedPins: WorkingMemoryPin[], logger: Logger): Promise<void> {
  const current = await loadWorkingMemory(); // Existing function
  const currentLabels = new Set(current.items.map((p: WorkingMemoryPin) => p.label));

  let added = 0;
  for (const pin of inheritedPins) {
    if (current.items.length >= 10) break; // Hard cap: 10 pins total
    if (added >= 5) break; // Inherited cap: 5 pins max
    if (currentLabels.has(pin.label)) continue; // Collision: current session wins

    current.items.push(pin);
    currentLabels.add(pin.label);
    added++;
  }

  if (added > 0) {
    await saveWorkingMemory(current); // Existing function
    logger.debug(`[session] Inherited ${added} working memory pins`);
  }
}
```

---

### 9.3 Hot Topic Accumulation Hooks

`HotTopicExtractor` signals must be wired into existing hooks at the points where each signal type naturally appears:

| Hook                      | Signal                          | Call                                               |
| ------------------------- | ------------------------------- | -------------------------------------------------- |
| `before_agent_start`      | Prompt keywords                 | `extractor.recordText(prompt, 0.5)`                |
| `agent_end`               | Auto-captured memory categories | `extractor.recordMemoryAccess(categories)`         |
| `cortex_add` execute      | Categories used                 | `extractor.recordMemoryAccess(params.categories)`  |
| `cortex_add` execute      | New memory ID                   | `extractor.recordLearningId(result.id)`            |
| `before_tool_call` (exec) | workdir param                   | `extractor.recordExecWorkdir(params.workdir)`      |
| Pre-action hook           | Synapse targets                 | `extractor.recordSynapseSignal(subject, to)`       |
| `working_memory` (pin)    | Pin label                       | `extractor.recordWorkingMemoryLabel(params.label)` |

**Project name extraction** from exec workdirs:

```typescript
function extractProjectName(workdir: string): string | null {
  // e.g., "/home/user/Projects/lbf-ham-radio" → "lbf-ham-radio"
  const match = workdir.match(/\/Projects\/([^/]+)/);
  return match ? match[1] : null;
}
```

---

## 10. Configuration Reference

All parameters are in `plugin.config.session_persistence`. Quick reference:

| Parameter                   | Default                | Range   | Effect                                         |
| --------------------------- | ---------------------- | ------- | ---------------------------------------------- |
| `enabled`                   | `true`                 | bool    | Master kill switch                             |
| `lookback_days`             | `7`                    | 1–30    | How far back to search for prior sessions      |
| `relevance_threshold`       | `0.25`                 | 0.1–1.0 | Minimum score to restore a session             |
| `max_sessions_scored`       | `3`                    | 1–10    | Max prior sessions contributing simultaneously |
| `max_inherited_pins`        | `5`                    | 1–8     | Max working memory pins inherited              |
| `decay_min_floor`           | `0.3`                  | 0.1–0.9 | Decay factor floor (minimum multiplier)        |
| `critical_inheritance_days` | `7`                    | 1–30    | Age cutoff for CRITICAL pin forced inheritance |
| `sessions_dir`              | `~/.openclaw/sessions` | path    | JSON mirror directory                          |
| `debug`                     | `false`                | bool    | Verbose logging of all scoring decisions       |

**Environment variable override:** `CORTEX_SESSION_DEBUG=1` enables debug mode regardless of config.

---

## 11. Metrics Events

All events emitted through the existing Cortex metrics writer (v1.3.0+). Events are tamper-evident via the existing metrics pipeline.

### `session_captured`

Emitted at `registerService.stop()` after successful final capture.

```typescript
{
  event: "session_captured",
  session_id: string,
  channel: string,
  duration_minutes: number,       // Session duration (end_time - start_time)
  pin_count: number,              // Working memory pins captured
  learning_count: number,         // cortex_add calls this session
  task_count: number,             // Pending tasks detected
  hot_topic_count: number,        // Keywords in hot_topics
  crash_recovered: false          // Always false for clean shutdowns
}
```

---

### `session_restored`

Emitted at `onSessionStart()` when at least one prior session was restored.

```typescript
{
  event: "session_restored",
  new_session_id: string,
  from_session_ids: string[],         // Which prior sessions contributed
  pins_inherited: number,             // How many pins were written to working memory
  relevance_scores: number[],         // Scores for each contributing session
  pending_task_count: number,         // How many pending tasks were surfaced
  cold_start: false                   // Always false when restoration occurred
}
```

For cold starts (no restoration): this event is NOT emitted. Nothing is logged for cold starts.

---

### `confidence_decay_applied`

Emitted once per memory evaluated during session restoration (including ones excluded).

```typescript
{
  event: "confidence_decay_applied",
  memory_id: string,
  original_confidence: number,
  decayed_confidence: number,
  hours_elapsed: number,
  excluded: boolean               // true if decayed_confidence < decay_min_floor
}
```

---

### `pending_task_surfaced`

Emitted once per pending task included in the preamble.

```typescript
{
  event: "pending_task_surfaced",
  task_id: string,
  title: string,
  stage: string,
  days_pending: number,
  source: "pipeline_state" | "working_memory_scan"
}
```

---

### `session_chain_traversal`

Emitted when `getSessionChain()` is called (by manual override or debug tooling).

```typescript
{
  event: "session_chain_traversal",
  start_session_id: string,
  requested_depth: number,
  sessions_found: number,
  oldest_session_age_hours: number
}
```

---

## 12. Migration Guide

### 12.1 brain.db Schema v4

The `session_states` table is a **new addition** — no existing tables are modified. Migration is **zero-risk** for all existing brain.db databases.

The `CREATE TABLE IF NOT EXISTS` statement in `_init_schema()` is idempotent: it runs on every startup and is safely ignored if the table already exists.

**No data transformation required.** Existing `stm`, `memories`, `atoms`, `metrics`, `categories`, `todos`, `embeddings` tables are unchanged.

### 12.2 Applying the Migration

Migration happens automatically on the first startup after the v2.0.0 code is deployed. No manual intervention required.

To verify the migration succeeded:

```bash
sqlite3 ~/.openclaw/brain.db ".schema session_states"
# Should output the CREATE TABLE statement
```

To verify indexes:

```bash
sqlite3 ~/.openclaw/brain.db ".indexes session_states"
# Should output: idx_session_channel  idx_session_endtime  idx_session_prev
```

---

## 13. Developer Guide

### 13.1 Adding a New Signal Source

To add a new hot topic extraction signal (e.g., recording Synapse recipients as project signals):

1. Add a recording method to `HotTopicExtractor` if the signal type is new:

   ```typescript
   recordSynapseRecipient(recipient: string): void {
     if (recipient !== 'all') {
       this.recordText(recipient, 1.5);  // Weight 1.5x for explicit recipients
     }
   }
   ```

2. Wire it into the relevant hook:

   ```typescript
   // In the synapse tool execute handler:
   hotTopicExtractor.recordSynapseRecipient(params.to);
   ```

3. No schema changes required — signals feed into the in-memory frequency map.

---

### 13.2 Tuning Relevance Thresholds

**Scenario:** Users find that sessions from 3+ days ago are being restored unnecessarily.

**Approach 1:** Increase `relevance_threshold` from 0.25 → 0.35

- Effect: Sessions need stronger topic overlap or more pending tasks to qualify

**Approach 2:** Reduce `lookback_days` from 7 → 3

- Effect: Sessions older than 3 days are never even scored

**Scenario:** Critical work is being lost because sessions aren't qualifying.

**Approach:** Check what topics the current session has (`extractor.getCurrentTopics()` in debug mode). If the topic extraction is producing generic terms, the topic overlap component will be weak. Use `CORTEX_SESSION_DEBUG=1` to see all scoring decisions in the log.

---

### 13.3 Credential Redaction Patterns

Credential redaction runs before writing working memory pins to `session_states`. The pattern list is shared with the pre-action hook system (task-003).

**Current patterns:**

```typescript
const CREDENTIAL_PATTERNS = [
  // Key=value patterns
  /\b(password|passwd|secret|api[_-]?key|token|auth|bearer|private[_-]?key)\s*[:=]\s*\S+/gi,

  // Long base64 strings (potential encoded secrets)
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,

  // OpenAI-style API keys
  /sk-[a-zA-Z0-9]{32,}/g,

  // GitHub personal access tokens
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{59}/g,

  // Anthropic keys
  /sk-ant-[a-zA-Z0-9-]{90,}/g,
];
```

**To add a new pattern** (e.g., for AWS keys):

1. Add the pattern to `CREDENTIAL_PATTERNS` in `session/session-manager.ts`
2. Also add it to `hooks/pre-action-hook.ts` (shared list — keep them in sync)
3. No database migration needed; redaction is applied at capture time only

---

### 13.4 Debug Mode

Enable with `CORTEX_SESSION_DEBUG=1` or `config.session_persistence.debug: true`.

**Debug output includes:**

- All sessions fetched from DB for scoring
- Per-session score breakdown (recency, topic_overlap, pending_tasks components)
- Which sessions were above/below threshold
- Pin inheritance decisions (which pins were skipped due to collision or cap)
- Decay calculations for each memory evaluated
- Preamble format before injection
- Total restoration time

**Example debug output:**

```
[session:debug] Fetched 12 sessions from last 7 days
[session:debug] Scoring session a1b2c3d4 (48h elapsed):
  recency: 0.886 × 0.4 = 0.354
  topic_overlap: 3/20 = 0.150 × 0.35 = 0.053
  pending_tasks: 2 tasks × 0.25 = 0.50 × 0.25 = 0.125
  TOTAL: 0.532 ✅ (threshold: 0.25)
[session:debug] Pin inheritance: 3 current pins, 5 candidate pins, cap=5
  - "ft991a control" → ADDED (no collision)
  - "pipeline state" → ADDED (no collision)
  - "AUGUR weekly" → SKIPPED (label collision with current pin)
[session:debug] Restoration complete in 312ms
```

---

## 14. Testing Guide

### 14.1 Unit Tests

**File:** `tests/session/` (new directory)

| Test File                     | Coverage                                                               |
| ----------------------------- | ---------------------------------------------------------------------- |
| `decay-engine.test.ts`        | Formula correctness, floor enforcement, `shouldInherit` predicate      |
| `context-scorer.test.ts`      | Score composition, Jaccard overlap, threshold filtering, batch scoring |
| `hot-topic-extractor.test.ts` | Signal accumulation, stopword filtering, project extraction, ranking   |
| `preamble-injector.test.ts`   | Format output, null on cold start, task formatting, topic truncation   |
| `session-manager.test.ts`     | Round-trip capture/restore, crash recovery, chain traversal, pin cap   |

**Key unit test cases:**

```typescript
// decay-engine.test.ts
describe('applyDecay', () => {
  it('no decay at 0h', () => expect(applyDecay(1.0, 0)).toBe(1.0));
  it('≈0.886 decay at 48h', () => expect(applyDecay(1.0, 48)).toBeCloseTo(0.886));
  it('min factor 0.3 at 200h', () => expect(applyDecay(1.0, 200)).toBe(0.3));
  it('0.3×0.3=0.09 below floor', () => expect(shouldInherit(0.3, 200)).toBe(false));
  it('does not mutate DB confidence', () => { ... });
});

// context-scorer.test.ts
describe('score', () => {
  it('score < 0.25 with no overlap, no tasks, 168h elapsed', () => { ... });
  it('score ≥ 0.25 with 4 pending tasks', () => {
    const session = makeSession({ pending_tasks: makeTasks(4) });
    expect(score(session, {keywords: []}, 160)).toBeGreaterThanOrEqual(0.25);
  });
  it('max 3 sessions from scoreAll', () => { ... });
});
```

---

### 14.2 Integration Tests

**File:** `tests/session/integration.test.ts`

| Test                            | Description                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Round-trip capture/restore      | Session A sets 3 pins → stop() → Session B onSessionStart() → pins present with provenance labels |
| Decay correctness (mocked time) | Memory with confidence=1.0 set 48h ago → inherited_confidence ≈ 0.89 in restored context          |
| Pin cap enforcement             | 7 existing pins + 5 eligible inherited → exactly 5 inherited, total 10                            |
| CRITICAL pin forced inheritance | CRITICAL-labeled pin from 6-day-old session → always inherited                                    |
| Cold start silence              | No prior sessions in DB → preamble is null → nothing injected                                     |
| Credential redaction            | Pin containing `api_key=sk-abc...` → stored as `api_key=[REDACTED]`                               |
| Crash recovery                  | onSessionStart with NULL end_time session → crash_recovered=true written                          |
| Idempotent restoration          | Calling inheritPins twice with same pins → no duplicates                                          |
| Pending task detection          | pipeline/state.json has active task in "build" → appears in preamble                              |
| Task drop on completion         | Task completed between sessions → silently dropped from preamble                                  |
| Session chain integrity         | Chain traversal returns sessions in chronological order                                           |
| Performance: restoration < 2s   | 50 sessions in DB → onSessionStart completes in < 2000ms                                          |
| Migration safety                | Existing brain.db without session_states → migration succeeds, no data loss                       |

---

### 14.3 Performance Benchmarks

Run with `CORTEX_BENCH=1 pnpm test tests/session/bench.test.ts`:

| Benchmark                              | Target   | Measured     |
| -------------------------------------- | -------- | ------------ |
| `onSessionStart` (50 sessions, 7 days) | < 2000ms | TBD at build |
| `onSessionEnd` (full capture)          | < 500ms  | TBD at build |
| `getRecentSessions(7, 50)` SQL query   | < 500ms  | TBD at build |
| `scoreAll(50 sessions)`                | < 100ms  | TBD at build |
| `applyDecay(1000 calls)`               | < 1ms    | TBD at build |

---

## 15. Troubleshooting

### Sessions not being restored on startup

**Symptoms:** No session continuity preamble, working memory always empty after restart.

**Check 1:** Is session persistence enabled?

```bash
openclaw config get | jq '.plugins.cortex.session_persistence.enabled'
# Should be: true
```

**Check 2:** Are there completed sessions in brain.db?

```bash
sqlite3 ~/.openclaw/brain.db \
  "SELECT id, start_time, end_time FROM session_states WHERE end_time IS NOT NULL ORDER BY end_time DESC LIMIT 5;"
```

**Check 3:** Enable debug mode and check logs:

```bash
CORTEX_SESSION_DEBUG=1 openclaw start
# Look for [session:debug] scoring output
```

---

### Working memory pins from prior session missing provenance labels

**Cause:** Pins were inherited from a session before v2.0.0, which didn't include provenance labeling.

**Resolution:** Expected behavior for pre-v2.0.0 sessions. Future sessions will include provenance labels.

---

### Session capture taking > 500ms

**Symptoms:** Slow shutdown, [session] warning in logs.

**Check:** Size of working memory and hot topics:

```bash
sqlite3 ~/.openclaw/brain.db \
  "SELECT id, length(working_memory), length(hot_topics) FROM session_states ORDER BY created_at DESC LIMIT 3;"
```

If `length(hot_topics)` > 10KB, the `HotTopicExtractor` may be accumulating too many signals. Tune by reducing `recordText` call sites or adding more stopwords.

---

### Crash recovery not detecting crashed session

**Symptoms:** After a SIGKILL, the next session doesn't surface pending tasks from the killed session.

**Root cause:** If `updateSessionState()` (agent_end) never fired (crash before first turn completed), the session record may be empty (just start_time, NULL end_time).

**Resolution:** `detectAndRecoverCrashed()` still detects it and writes a partial recovery record. However, if `hot_topics` and `pending_tasks` are empty arrays, it may not score above the relevance threshold. In this case, use `cortex_session_continue({session_id: "..."})` for manual recovery.

---

### `getSessionChain` returning fewer sessions than expected

**Cause:** Session chain is broken at a point where `previous_session_id` was not set (e.g., first session, crash before initial record write, or pre-v2.0.0 session).

**Resolution:** The chain is best-effort for historical sessions; new sessions (v2.0.0+) will always have proper links.

---

## 16. Changelog / Version History

### Cortex v2.0.0 — Cross-Session State Preservation

**Released:** 2026-02-18 (estimated — build stage pending)  
**Task:** task-004-session-persistence  
**Phase:** 2.1 of IMPROVEMENT_PLAN

**New features:**

- `session_states` table in brain.db (migration v4, zero-risk)
- `SessionPersistenceManager` class with full lifecycle hook integration
- `DecayEngine` — confidence decay for inherited memories
- `ContextScorer` — weighted relevance scoring for prior sessions
- `HotTopicExtractor` — TF-IDF-style keyword accumulation across session lifetime
- `PreambleInjector` — structured session continuity preamble
- `session_manager.py` — Python DB layer for session CRUD
- `cortex_session_continue` tool — manual session inheritance override
- Crash recovery: abrupt kills detected and partially recovered
- JSON mirror files at `~/.openclaw/sessions/{session_id}.json`
- 5 new metrics events for full session lifecycle observability
- `session_persistence` plugin config block with 9 tunable parameters

**Requires:** Cortex v1.5.0 (pre-action hooks), Cortex v1.3.0 (metrics), Cortex v1.2.0 (confidence scoring)

---

_Next stage: build — implement all TypeScript and Python modules described in this document._
