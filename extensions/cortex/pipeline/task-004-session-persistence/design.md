# Cross-Session State Preservation — Technical Design

**Task ID:** task-004-session-persistence  
**Stage:** design  
**Author:** Software Architect (Sub-Agent)  
**Date:** 2026-02-18  
**Cortex Target Version:** 2.0.0  
**Requires:** Cortex v1.5.0 (pre-action hooks), Cortex v1.2.0 (confidence scoring), Cortex v1.3.0 (metrics)

---

## 1. Approach Summary

### Problem

The current Cortex architecture has no cross-session memory: every process restart is a cold start. Working memory pins survive only within a running process. `before_agent_start` reconstructs context from brain.db on each turn, but the _session boundary itself_ — which pins were active, what was being worked on, what tasks were pending — is never captured and never restored.

### Solution Architecture

The Cross-Session State Preservation system is a **new `session` module** within the Cortex extension that hooks into the three available session lifecycle surfaces:

| Hook Surface     | OpenClaw API                      | Phase                               |
| ---------------- | --------------------------------- | ----------------------------------- |
| Session start    | `registerService.start()`         | Restore prior state                 |
| First agent turn | `before_agent_start` (flag-gated) | Inject continuity preamble          |
| Each turn end    | `agent_end`                       | Incremental crash-safe capture      |
| Session end      | `registerService.stop()`          | Final session capture + JSON mirror |

**Critical discovery from code review**: OpenClaw does NOT have dedicated `on_session_start`/`on_session_end` hooks. The `registerService.start/stop` callbacks are the correct lifecycle anchors. Working memory is stored in a **JSON file** at `~/.openclaw/workspace/memory/working_memory.json` (not the `working_memory` brain.db table, which is unused). All pin inheritance must read/write through the existing `loadWorkingMemory()` / `saveWorkingMemory()` functions — never direct DB writes.

### Key Architectural Decisions

1. **Session UUID**: Generated once in `registerService.start()`, stored as module-level variable in `index.ts`. Survives all turns of that process lifetime.
2. **Incremental + Final capture dual pattern**: `agent_end` hook writes partial state after every turn (crash-safe). `registerService.stop()` writes the final complete snapshot with `end_time`.
3. **Preamble injection flag**: A module-level `preambleInjected` boolean prevents the session continuity preamble from repeating beyond the first `before_agent_start` turn.
4. **Read-through working memory**: Pin inheritance reads current `working_memory.json`, appends up to 5 inherited pins (with provenance), writes back through `saveWorkingMemory()` — respects the 10-pin hard cap.
5. **Python-side DB operations**: Session state read/write uses a new `session_manager.py` Python module, consistent with the existing pattern of calling Python via `bridge.runPython()`.
6. **No LBF API direct calls**: Pending task detection reads `pipeline/state.json` (in-process tasks) and scans working memory pins for task mentions. LBF API polling at session boundaries is out of scope.

---

## 2. Files to Create / Modify

### New Files

```
extensions/cortex/session/
├── types.ts                      # TypeScript interfaces (SessionState, PendingTask, etc.)
├── session-manager.ts            # SessionPersistenceManager class (orchestrator)
├── decay-engine.ts               # DecayEngine — confidence decay formula
├── context-scorer.ts             # ContextScorer — relevance_score computation
├── preamble-injector.ts          # PreambleInjector — formats session continuity preamble
└── hot-topic-extractor.ts        # HotTopicExtractor — extracts keywords from session activity

extensions/cortex/python/
└── session_manager.py            # Python DB layer (session_states table CRUD)

~/.openclaw/sessions/             # Runtime JSON mirror directory (created at first capture)
└── {session_id}.json             # One file per completed session
```

### Modified Files

| File                                 | Change                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extensions/cortex/python/brain.py`  | Add `session_states` table to `_init_schema()` (migration v4)                                                                                                      |
| `extensions/cortex/cortex-bridge.ts` | Add `SessionBridgeMethods` — thin wrappers that call `session_manager.py` via `runPython()`                                                                        |
| `extensions/cortex/index.ts`         | Wire session hooks into `registerService`, `before_agent_start`, `agent_end`; register `cortex_session_continue` tool; add `session_persistence` to `configSchema` |

### Does NOT Modify

- `extensions/cortex/hooks/` — pre-action hook system untouched
- `extensions/cortex/python/stm_manager.py` — no STM schema changes
- `extensions/cortex/python/embeddings_manager.py` — no embeddings changes
- Existing `memories`, `stm`, `atoms`, `messages`, `working_memory` (DB table) — read-only

---

## 3. Data Model Changes

### New Table: `session_states` (brain.db migration v4)

Added in `brain.py → _init_schema()` using the existing `CREATE TABLE IF NOT EXISTS` pattern:

```sql
CREATE TABLE IF NOT EXISTS session_states (
    id TEXT PRIMARY KEY,                     -- UUID (session_id)
    start_time TEXT NOT NULL,                -- ISO 8601
    end_time TEXT,                           -- NULL = active or crashed
    channel TEXT DEFAULT 'unknown',          -- "signal", "cli", "discord", etc.

    -- Active context snapshots (JSON arrays)
    working_memory TEXT NOT NULL DEFAULT '[]',   -- WorkingMemoryPin[]
    hot_topics TEXT NOT NULL DEFAULT '[]',       -- string[] (top-20 keywords)
    active_projects TEXT NOT NULL DEFAULT '[]',  -- string[] (project names)
    pending_tasks TEXT NOT NULL DEFAULT '[]',    -- PendingTask[]

    -- Knowledge state
    recent_learnings TEXT NOT NULL DEFAULT '[]', -- string[] (cortex memory IDs)
    confidence_updates TEXT NOT NULL DEFAULT '[]', -- ConfidenceUpdate[]
    sop_interactions TEXT NOT NULL DEFAULT '[]',   -- SOPInteraction[]

    -- Session chain
    previous_session_id TEXT,               -- FK → prior session id
    continued_by TEXT,                      -- Set when next session loads this one

    -- Recovery metadata
    crash_recovered INTEGER DEFAULT 0,      -- 1 if recovered from unclean shutdown

    -- Schema versioning for future migrations
    schema_version INTEGER DEFAULT 1,

    created_at TEXT NOT NULL,
    updated_at TEXT
);

-- Indexes for lookback queries and chain traversal
CREATE INDEX IF NOT EXISTS idx_session_endtime
    ON session_states(end_time, start_time);

CREATE INDEX IF NOT EXISTS idx_session_prev
    ON session_states(previous_session_id);

CREATE INDEX IF NOT EXISTS idx_session_channel
    ON session_states(channel, start_time);
```

### Migration Strategy

Migration is added as a new block in `_init_schema()` after existing tables. Since all `CREATE TABLE IF NOT EXISTS` calls are idempotent, existing brain.db databases are automatically migrated on next startup with no data loss. The new `session_states` table simply does not exist yet and gets created. No data transformation required.

### No Other Schema Changes

All existing tables (`stm`, `messages`, `atoms`, `causal_links`, `embeddings`, `working_memory`, `categories`, `todos`) are unchanged.

---

## 4. API / Interface Changes

### 4.1 New TypeScript Interfaces (`session/types.ts`)

```typescript
export interface SessionState {
  session_id: string;
  start_time: string;
  end_time: string;
  channel: string;
  working_memory: WorkingMemoryPin[];
  hot_topics: string[];
  active_projects: string[];
  pending_tasks: PendingTask[];
  recent_learnings: string[];
  confidence_updates: ConfidenceUpdate[];
  sop_interactions: SOPInteraction[];
  previous_session_id: string | null;
  continued_by: string | null;
  crash_recovered?: boolean;
  schema_version: number;
  // Computed at restore time — NOT stored in DB
  relevance_score?: number;
  inherited_at?: string;
}

export interface WorkingMemoryPin {
  content: string;
  pinnedAt: string;
  label?: string;
}

export interface PendingTask {
  task_id: string;
  title: string;
  stage: string;
  flagged_incomplete: boolean;
}

export interface ConfidenceUpdate {
  memory_id: string;
  old_score: number;
  new_score: number;
  reason: string;
  timestamp: string;
}

export interface SOPInteraction {
  sop_path: string;
  injected_at: string;
  acknowledged: boolean;
  tool_call: string;
}

export interface RestoredSessionContext {
  preamble: string | null; // Formatted preamble to inject
  inheritedPins: WorkingMemoryPin[]; // Pins to write into working memory
  sessionIds: string[]; // Which prior sessions contributed
  relevanceScores: number[]; // Their scores
  pendingTaskCount: number;
}
```

### 4.2 New `SessionPersistenceManager` Class (`session/session-manager.ts`)

```typescript
export class SessionPersistenceManager {
  constructor(bridge: CortexBridge, logger: Logger, config: SessionPersistenceConfig) {}

  // Called from registerService.start()
  async onSessionStart(sessionId: string, channel: string): Promise<RestoredSessionContext> {}

  // Called from agent_end hook (incremental, crash-safe)
  async updateSessionState(partial: Partial<SessionState>): Promise<void> {}

  // Called from registerService.stop()
  async onSessionEnd(sessionId: string): Promise<void> {}

  // Detect crashed sessions (sessions with no end_time that aren't current)
  async detectAndRecoverCrashed(currentSessionId: string): Promise<void> {}

  // Manual override tool
  async forceInheritSession(targetSessionId: string): Promise<RestoredSessionContext> {}

  // Chain traversal
  async getSessionChain(sessionId: string, depth: number): Promise<SessionState[]> {}
}
```

### 4.3 New Methods on `CortexBridge` (`cortex-bridge.ts` additions)

```typescript
// Session DB operations via Python
async saveSessionState(state: SessionState): Promise<void>
async getRecentSessions(days: number, limit: number): Promise<SessionState[]>
async markSessionContinued(sessionId: string, nextSessionId: string): Promise<void>
async detectCrashedSessions(activeSessionId: string): Promise<SessionState[]>
async recoverCrashedSession(sessionId: string): Promise<void>
async getSessionChain(sessionId: string, depth: number): Promise<SessionState[]>
```

### 4.4 New Python Module (`python/session_manager.py`)

```python
class SessionManager:
    def __init__(self, db_path=None): ...

    def save_session(self, session_dict: dict) -> None:
        """UPSERT session record (INSERT OR REPLACE)"""

    def get_recent_sessions(self, days: int = 7, limit: int = 20) -> list[dict]:
        """SELECT sessions from last N days with end_time set (completed sessions)"""

    def get_crashed_sessions(self, active_session_id: str) -> list[dict]:
        """SELECT sessions with NULL end_time, excluding active_session_id"""

    def mark_continued(self, session_id: str, next_id: str) -> None:
        """UPDATE continued_by field"""

    def recover_crashed(self, session_id: str, estimated_end_time: str) -> None:
        """UPDATE with estimated end_time, set crash_recovered=1"""

    def get_session_chain(self, session_id: str, depth: int = 5) -> list[dict]:
        """Recursive traversal via previous_session_id links"""
```

### 4.5 New Plugin Config Block (`index.ts configSchema`)

```typescript
session_persistence: Type.Object({
  enabled: Type.Boolean({ default: true }),
  lookback_days: Type.Number({ default: 7, minimum: 1, maximum: 30 }),
  relevance_threshold: Type.Number({ default: 0.25, minimum: 0.1, maximum: 1.0 }),
  max_sessions_scored: Type.Number({ default: 3, minimum: 1, maximum: 10 }),
  max_inherited_pins: Type.Number({ default: 5, minimum: 1, maximum: 8 }),
  decay_min_floor: Type.Number({ default: 0.3, minimum: 0.1, maximum: 0.9 }),
  critical_inheritance_days: Type.Number({ default: 7, minimum: 1, maximum: 30 }),
  sessions_dir: Type.String({ default: "~/.openclaw/sessions" }),
  debug: Type.Boolean({ default: false }), // CORTEX_SESSION_DEBUG env var override
});
```

### 4.6 New Tool: `cortex_session_continue` (`index.ts` registration)

```typescript
// FR-011: Manual session continuity override
api.registerTool({
  name: "cortex_session_continue",
  parameters: Type.Object({
    session_id: Type.String({ description: "Prior session ID to force-inherit from" }),
  }),
  async execute(_toolCallId, params) { ... }
}, { names: ["cortex_session_continue"] });
```

---

## 5. Integration Points

### 5.1 `registerService.start()` → Session Initialization

```
registerService.start() {
  1. Generate sessionId = crypto.randomUUID()  // module-level var
  2. SessionPersistenceManager.detectAndRecoverCrashed(sessionId)
     → find sessions with NULL end_time → write recovery records
  3. Get channel from api.pluginConfig.channel or env
  4. Write initial session record to brain.db (start_time, no end_time)
  5. RestoredContext = SessionPersistenceManager.onSessionStart(sessionId, channel)
     a. Fetch last 7 days of completed sessions
     b. Score each via ContextScorer.score() → relevance_score
     c. Drop sessions with score < 0.25
     d. Sort descending, take top 3
     e. For highest-scoring session:
        → Inherit working memory pins (up to 5, with CRITICAL priority override)
        → Write to working_memory.json via saveWorkingMemory() pattern
     f. Collect hot_topics, active_projects, pending_tasks from top sessions
     g. Build preamble via PreambleInjector.format()
     h. Emit session_restored metric
     i. Return RestoredSessionContext
  6. Store RestoredContext in module-level var for first before_agent_start turn
  7. markSessionContinued() on all restored sessions
}
```

**Critical**: This runs before any agent turn. The restored context is cached in a module-level variable and consumed by `before_agent_start` on the first turn.

### 5.2 `before_agent_start` → Preamble Injection (First Turn Only)

The existing `before_agent_start` hook in `index.ts` (priority 50) builds context tiers. Session continuity preamble is injected as the **first context part** (highest priority), ahead of working memory:

```typescript
// In existing before_agent_start hook, before L1 Working Memory:
if (!preambleInjected && restoredSessionContext?.preamble) {
  contextParts.push(
    `<session-continuity hint="inherited from prior sessions">\n` +
      `${restoredSessionContext.preamble}\n</session-continuity>`,
  );
  preambleInjected = true; // Module-level flag — never repeats
}
```

**Session continuity preamble does NOT count against token budget** (same policy as working memory L1 — it's structural context, not optional).

### 5.3 `agent_end` → Incremental Crash-Safe Capture

After the existing auto-capture logic in the `agent_end` hook:

```typescript
// Append to existing agent_end hook, after auto-capture block:
if (config.session_persistence?.enabled && sessionId) {
  await sessionManager.updateSessionState({
    session_id: sessionId,
    hot_topics: hotTopicExtractor.getCurrentTopics(),
    active_projects: hotTopicExtractor.getActiveProjects(),
    recent_learnings: hotTopicExtractor.getRecentLearningIds(),
    updated_at: new Date().toISOString(),
  });
}
```

This provides crash-safe state: even if `registerService.stop()` never fires, the session state has been periodically written.

### 5.4 `registerService.stop()` → Final Session Capture

```
registerService.stop() {
  1. Load current working_memory.json
  2. Redact credential patterns from pin content (reuse task-003 pattern list)
  3. Build final SessionState:
     - end_time: now
     - working_memory: current pins (redacted)
     - hot_topics: hotTopicExtractor.getTopN(20)
     - active_projects: hotTopicExtractor.getActiveProjects()
     - pending_tasks: detectPendingTasks()
     - recent_learnings: hotTopicExtractor.getAllLearningIds()
     - sop_interactions: sopTracker.getAll()
  4. Upsert to brain.db session_states
  5. Write JSON mirror to ~/.openclaw/sessions/{session_id}.json
  6. Emit session_captured metric (pin_count, learning_count, task_count)
}
```

### 5.5 Confidence Decay Integration (Cortex v1.2.0)

`DecayEngine.applyDecay()` is called during session restoration (step 5a in `onSessionStart`), NOT during storage. The decayed confidence is used only for **filtering** memories during inheritance — it determines whether a memory is included in the restored context. The `confidence` field in brain.db `stm` table is **never modified** by the decay engine.

```typescript
// decay-engine.ts
export function applyDecay(originalConfidence: number, hoursElapsed: number): number {
  const decayFactor = Math.max(0.3, 1.0 - (hoursElapsed / 168) * 0.4);
  return originalConfidence * decayFactor;
}

// Used only in ContextScorer — never persisted
const inheritedConf = applyDecay(memory.confidence, hoursElapsed);
if (inheritedConf < 0.3) continue; // Drop from inheritance
```

### 5.6 Pre-Action Hook Compatibility (Cortex v1.5.0)

Session capture fires in `registerService.stop()` — after the plugin lifecycle has already cleaned up hook state. The hook cooldown timer is **not** persisted across sessions (ephemeral by design). The session system tracks SOP interactions (which SOPs fired, whether acknowledged) for analytics purposes only — SOPs themselves are not replayed or blocked based on session history.

### 5.7 Hot Topic Extraction (`hot-topic-extractor.ts`)

The `HotTopicExtractor` runs as a stateful accumulator across the session lifetime:

```typescript
export class HotTopicExtractor {
  // Called by various hooks to accumulate signals
  recordToolCall(toolName: string, params: Record<string, unknown>): void;
  recordMemoryAccess(categories: string[]): void;
  recordWorkingMemoryLabel(label: string): void;
  recordExecWorkdir(workdir: string): void;
  recordSynapseSubject(subject: string): void;
  recordLearningId(memoryId: string): void;

  // Output
  getCurrentTopics(): string[]; // Frequency-ranked, top 20
  getActiveProjects(): string[]; // Detected project names
  getRecentLearningIds(): string[]; // cortex_add memory IDs this session
  getTopN(n: number): string[];
}
```

**Signal sources** (accumulation happens in existing hooks, calls added to each):

- `before_agent_start`: prompt keywords → `recordToolCall` equivalent
- `agent_end`: auto-captured memory categories → `recordMemoryAccess`
- `cortex_add` execute: `recordMemoryAccess(categories)` + `recordLearningId(memId)`
- `before_tool_call` (exec): extract workdir → `recordExecWorkdir`
- Pre-action hook: `recordSynapseSubject` from Synapse messages
- Working memory `pin` action: `recordWorkingMemoryLabel(label)`

### 5.8 Pending Task Detection

At session end, `detectPendingTasks()` does two things:

1. **Read `pipeline/state.json`**: Scan `active_tasks` for tasks with `current_stage` in `["build", "verify", "validate"]` → flag as `PendingTask` with `flagged_incomplete: false`
2. **Scan working memory pins**: Look for patterns like `task-NNN`, `[TASK]`, `incomplete`, `TODO`, `in-progress` → flag as `flagged_incomplete: true`
3. **Filter on restore**: At session start, check each `PendingTask.task_id` against current `pipeline/state.json` — if task is now `done` or absent, silently drop it from preamble

---

## 6. Algorithms

### 6.1 Relevance Scoring (FR-006)

```typescript
// context-scorer.ts
export function calculateRelevanceScore(
  session: SessionState,
  currentContext: { keywords: string[] },
  hoursElapsed: number,
): number {
  // Recency weight (0 at 7+ days)
  const recency = Math.max(0, 1 - hoursElapsed / 168);

  // Topic overlap (Jaccard-like)
  const sessionTopics = new Set(session.hot_topics.map((t) => t.toLowerCase()));
  const currentKeywords = new Set(currentContext.keywords.map((k) => k.toLowerCase()));
  const intersection = [...currentKeywords].filter((k) => sessionTopics.has(k)).length;
  const union = new Set([...currentKeywords, ...sessionTopics]).size;
  const topicOverlap = union > 0 ? intersection / union : 0;

  // Pending tasks weight
  const pendingWeight = Math.min(1.0, session.pending_tasks.length * 0.25);

  return recency * 0.4 + topicOverlap * 0.35 + pendingWeight * 0.25;
}
```

### 6.2 Credential Redaction

Reuse the same credential pattern list defined in task-003's pre-action hooks (`security` category patterns). Before writing working memory pins to `session_states`:

```typescript
const CREDENTIAL_PATTERNS = [
  /\b(password|passwd|secret|api[_-]?key|token|auth|bearer|private[_-]?key)\s*[:=]\s*\S+/gi,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g, // Base64-encoded secrets
  /sk-[a-zA-Z0-9]{32,}/g, // OpenAI-style keys
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub tokens
];

function redactCredentials(content: string): string {
  let redacted = content;
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}
```

---

## 7. Preamble Format

When qualifying prior sessions exist, inject:

```
[SESSION CONTINUITY — inherited from {N} prior session(s)]

PENDING TASKS:
- [{task_id}] {title} (last stage: {stage}, {days}d ago)

ACTIVE PROJECTS: {project1}, {project2}

HOT TOPICS: {keyword1}, {keyword2}, {keyword3}, ...

WORKING MEMORY RESTORED: {N} pins inherited (see working_memory view)
```

When no qualifying sessions exist → inject nothing (cold start is silent).

---

## 8. Risk Assessment

### HIGH Risks

| #    | Risk                                                    | Impact                              | Mitigation                                                                                                                    |
| ---- | ------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| R-01 | `registerService.stop()` does not fire on SIGKILL/crash | Session state lost for abrupt kills | Incremental capture in `agent_end` every turn ensures most state survives; crash recovery detects sessions with NULL end_time |
| R-02 | Working memory 10-pin cap conflict                      | Inherited pins rejected silently    | Check `items.length` before inheritance; enforce hard limit of 5 inherited pins; count current pins first                     |
| R-03 | Module-level session ID lost across hot reloads         | Session chain broken                | `registerService.start()` regenerates; hot reload is treated as new session                                                   |

### MEDIUM Risks

| #    | Risk                                                     | Impact                                        | Mitigation                                                                                                                                                 |
| ---- | -------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-04 | LBF `pipeline/state.json` path dependency                | Pending task detection breaks if path changes | Use configurable path; graceful fallback to working memory scan only                                                                                       |
| R-05 | Hot topic extraction signal quality                      | Poor topic detection → low relevance scores   | Use working memory labels and STM categories as primary signals (these are already structured); raw keyword frequency is supplementary                     |
| R-06 | First `before_agent_start` timing vs. preamble readiness | Preamble not ready when first turn fires      | `registerService.start()` runs synchronously before any turns; preamble is cached in module-level var by the time first turn arrives                       |
| R-07 | Python `session_manager.py` blocking startup             | Session restoration exceeds 2s budget         | Async Python call via `runPython()`; 7-day lookback with index on `end_time` is fast; add 1500ms timeout on the restoration phase, fall back to cold start |

### LOW Risks

| #    | Risk                                               | Impact             | Mitigation                                                                                                                          |
| ---- | -------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| R-08 | `session_states` table migration on existing DB    | Schema collision   | `CREATE TABLE IF NOT EXISTS` is idempotent; new table, no existing tables modified                                                  |
| R-09 | JSON mirror directory doesn't exist                | File write failure | `mkdir -p ~/.openclaw/sessions` before first write; failure is non-fatal (DB record already written)                                |
| R-10 | Idempotent restoration (same session loaded twice) | Duplicate pins     | Check label collision before inserting inherited pins; de-duplicate by label                                                        |
| R-11 | 30-day session record retention policy             | DB growth          | Nightly maintenance cron (existing `runMaintenance()`) extended to archive `session_states` older than 30 days to JSON cold storage |

---

## 9. Estimated Complexity

**Overall: L (Large)**

| Component                                | Complexity | LOC Est.  |
| ---------------------------------------- | ---------- | --------- |
| `session/types.ts`                       | S          | ~80       |
| `session/decay-engine.ts`                | S          | ~50       |
| `session/context-scorer.ts`              | S          | ~80       |
| `session/hot-topic-extractor.ts`         | M          | ~150      |
| `session/preamble-injector.ts`           | S          | ~80       |
| `session/session-manager.ts`             | L          | ~300      |
| `python/session_manager.py`              | M          | ~200      |
| `python/brain.py` (schema migration)     | S          | ~40       |
| `cortex-bridge.ts` (new session methods) | M          | ~150      |
| `index.ts` (hook wiring + tool + config) | M          | ~200      |
| **Total**                                | **L**      | **~1330** |

**Why L and not M**: Five new modules required; three distinct integration points in the existing hook system; two-phase capture pattern (incremental + final); crash recovery logic; relevance scoring with multiple weighted factors; working memory cap enforcement with CRITICAL-tag override; pending task detection across two data sources. The complexity is structural (many moving parts that must coordinate) rather than algorithmic.

---

## 10. Performance Budget

| Operation                             | Target   | Approach                                                                                               |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| Session capture (stop hook)           | < 500ms  | `session_states` UPSERT is a single SQL write; JSON mirror is async best-effort                        |
| Session restoration (start hook)      | < 2000ms | Indexed 7-day SELECT; Python scores sessions in-memory; timeout after 1500ms → fall back to cold start |
| Lookback query (7 days, all sessions) | < 500ms  | `idx_session_endtime` index; typically < 50 sessions in 7 days                                         |
| brain.db block per operation          | < 100ms  | WAL mode already configured; session writes are IMMEDIATE transactions                                 |
| First turn preamble overhead          | ~0ms     | Preamble pre-computed in `registerService.start()`; `before_agent_start` just reads module-level var   |

---

## 11. Testing Approach (for Build Phase)

The test plan (detailed in test stage) should cover:

1. **Round-trip test**: Session A pins 3 items → stop → Session B → verify pins inherited with provenance labels
2. **Decay correctness**: Memory with confidence=1.0 at 48h elapsed → inherited_confidence ≈ 0.89
3. **Relevance filtering**: Session with score < 0.25 → not restored; session with 3 pending tasks → score ≥ 0.25
4. **Pin cap enforcement**: 7 existing pins + 5 inherited = max 10 total; verify 5 inherited, not 6
5. **Crash recovery**: Kill process mid-session → next session detects NULL end_time → recovery record written
6. **Idempotency**: Same session restored twice → no duplicate pins
7. **Cold start silence**: No prior sessions → no preamble injected
8. **Credential redaction**: Pin with API key pattern → stored as [REDACTED]
9. **Performance**: Restoration completes in < 2000ms with 50 sessions in DB
10. **Migration safety**: Existing brain.db (no session_states) → migration succeeds, existing data intact

---

## 12. Build Phase Execution Order

1. Create `session/types.ts` (interfaces — no dependencies)
2. Create `python/session_manager.py` (DB layer — depends on brain.py schema)
3. Add `session_states` table to `python/brain.py` `_init_schema()`
4. Add session methods to `cortex-bridge.ts` (wraps Python)
5. Create `session/decay-engine.ts` (pure function, no deps)
6. Create `session/context-scorer.ts` (uses decay-engine)
7. Create `session/hot-topic-extractor.ts` (stateful accumulator)
8. Create `session/preamble-injector.ts` (formats output)
9. Create `session/session-manager.ts` (orchestrates all above)
10. Modify `index.ts` (wires everything together — final step, highest coupling)

---

_Design complete. Proceed to document stage for API documentation and developer guide._
