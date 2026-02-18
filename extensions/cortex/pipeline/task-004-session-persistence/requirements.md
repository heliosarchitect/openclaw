# Cross-Session State Preservation - Requirements Document

**Task ID:** task-004-session-persistence  
**Phase:** 2.1 - Cross-Session Persistence Engine  
**Author:** Requirements Analyst (Sub-Agent)  
**Date:** 2026-02-18  
**Cortex Version:** 1.5.0 → 2.0.0  
**OpenClaw Compatibility:** Plugin API v2.x+

## Summary

The Cross-Session State Preservation system closes the most critical gap in the Helios memory architecture: the answer to "Will you remember in 2 days?" is currently NO. This system captures a structured SessionState snapshot at every session boundary — recording working memory pins, hot topics, active projects, pending tasks, and recent learnings — and restores relevant context at session start with time-decayed confidence scores so that continuity is structural, not voluntary. The system integrates with Cortex STM (brain.db), the existing working memory pin system, Cortex v1.2.0 confidence scoring, and the pre-action hook framework, adding a new persistence layer that makes context survival across restarts, crashes, and multi-day gaps a guaranteed property of the architecture rather than a best-effort behavior.

---

## Functional Requirements

### FR-001: Session State Capture at Session End

- **Requirement**: The system MUST capture a complete `SessionState` record when any session terminates (graceful shutdown, timeout, crash recovery)
- **Captured Fields**:
  - `session_id`: UUID for the closing session
  - `start_time` / `end_time`: ISO 8601 timestamps
  - `working_memory`: Full snapshot of all current working memory pins (label + content)
  - `hot_topics`: Top-N keywords extracted from session activity (tool calls, memory accesses, messages)
  - `active_projects`: Projects actively worked on during the session (detected from exec workdirs, file paths, Synapse messages)
  - `pending_tasks`: LBF tasks in-progress or explicitly flagged as incomplete
  - `recent_learnings`: All `cortex_add` calls made during the session with their memory IDs
  - `confidence_updates`: All confidence score changes (boosts and penalties) applied during the session
  - `sop_interactions`: Which SOPs were injected and whether they were acknowledged
  - `previous_session_id`: Link to prior session for chain traversal
- **Storage**: Written to brain.db `session_states` table and mirrored as JSON to `~/.openclaw/sessions/{session_id}.json`
- **Priority**: CRITICAL
- **Testable**: After session shutdown, `session_states` table contains a complete record with all required fields populated

### FR-002: Session State Restoration at Session Start

- **Requirement**: The system MUST restore relevant context when a new session initializes, within 2 seconds of startup
- **Restoration Behavior**:
  - Load the most recent `SessionState` records up to 7 days back
  - Score each state's relevance using `calculateContextRelevance()` (see FR-006)
  - Re-inject working memory pins from the most recent session that score above threshold
  - Surface hot topics and active projects as contextual hints in session preamble
  - Flag pending tasks with their original LBF task IDs for acknowledgment
  - Apply confidence decay to inherited memories before injection (see FR-004)
- **Restore Target**: Inject inherited context into working memory and session preamble automatically — no agent action required
- **Priority**: CRITICAL
- **Testable**: A new session started 48 hours after a prior session contains the prior session's working memory pins and hot topics in its initial context

### FR-003: Session State Schema (SessionState Record)

- **Requirement**: The system MUST implement the following schema for all session state records

```typescript
interface SessionState {
  session_id: string; // UUID
  start_time: string; // ISO 8601
  end_time: string; // ISO 8601 (set on capture)
  channel: string; // e.g. "signal", "cli"

  // Active context
  working_memory: WorkingMemoryPin[]; // Full pin list at session end
  hot_topics: string[]; // Top-20 session keywords
  active_projects: string[]; // Project names detected
  pending_tasks: PendingTask[]; // Unfinished LBF tasks

  // Knowledge state
  recent_learnings: string[]; // cortex memory IDs created this session
  confidence_updates: ConfidenceUpdate[]; // {memory_id, old_score, new_score, reason}
  sop_interactions: SOPInteraction[]; // {sop_path, injected_at, acknowledged: bool}

  // Chain links
  previous_session_id: string | null;
  continued_by: string | null; // Set when next session loads this one

  // Scoring (computed at restore time)
  relevance_score?: number; // 0–1, computed from recency + content match
  inherited_at?: string; // ISO 8601 timestamp of restoration
}

interface PendingTask {
  task_id: string; // LBF task ID
  title: string;
  stage: string; // Last known pipeline stage
  flagged_incomplete: boolean;
}

interface ConfidenceUpdate {
  memory_id: string;
  old_score: number;
  new_score: number;
  reason: string;
  timestamp: string;
}

interface SOPInteraction {
  sop_path: string;
  injected_at: string;
  acknowledged: boolean;
  tool_call: string;
}
```

- **Priority**: HIGH
- **Testable**: Schema validation passes on all stored records; TypeScript interfaces enforce shape at compile time

### FR-004: Confidence Decay on Inherited Memories

- **Requirement**: The system MUST apply time-based confidence decay to all memories restored from prior sessions before injecting them into the new session
- **Decay Algorithm**:
  ```
  inherited_confidence = original_confidence × decay_factor(hours_elapsed)
  decay_factor(h) = max(0.3, 1.0 - (h / 168) × 0.4)
  ```

  - At 0h (immediate): no decay (factor = 1.0)
  - At 24h (1 day): factor ≈ 0.94
  - At 48h (2 days): factor ≈ 0.89
  - At 168h (7 days): factor = 0.60 (minimum cap at 0.3 applied)
- **Application**: Decay is applied to inherited memories in the restored session context ONLY; original brain.db confidence scores are NOT modified by this decay
- **Minimum Floor**: Inherited memories never decay below confidence 0.3 — below this they are dropped from restoration
- **Priority**: HIGH
- **Testable**: A memory with confidence 1.0 restored after 48h appears in context with confidence ≈ 0.89; original brain.db record unchanged

### FR-005: Hot Topic Extraction

- **Requirement**: The system MUST automatically extract hot topics from session activity to populate `hot_topics` in the SessionState
- **Extraction Sources**:
  - Working memory pin labels and content keywords
  - Memory categories accessed via `cortex_stm`, `cortex_add` during the session
  - Project names from exec working directories
  - Synapse message subjects and targets
  - Pre-action hook context keywords
- **Algorithm**: TF-IDF-style frequency ranking over session keywords, deduplicated, top 20 retained
- **Priority**: MEDIUM
- **Testable**: After a session working on `lbf-ham-radio`, "ft991a", "ham radio", "lbf-ham-radio" appear in `hot_topics`

### FR-006: Cross-Session Context Relevance Scoring

- **Requirement**: The system MUST compute a `relevance_score` (0–1) for each prior session when determining what to restore
- **Scoring Factors**:

  ```
  relevance_score = (recency_weight × 0.4)
                  + (topic_overlap_weight × 0.35)
                  + (pending_tasks_weight × 0.25)

  recency_weight = max(0, 1 - (hours_elapsed / 168))    // 0 at 7+ days
  topic_overlap_weight = |current_context ∩ session.hot_topics| / max(|both|, 1)
  pending_tasks_weight = min(1.0, session.pending_tasks.length × 0.25)
  ```

- **Restoration Threshold**: Sessions with `relevance_score < 0.25` are not restored
- **Multi-Session Inheritance**: Up to 3 prior sessions may contribute context simultaneously (highest scorers)
- **Priority**: HIGH
- **Testable**: A session with 3 pending tasks scores ≥ 0.25 in `pending_tasks_weight` and triggers restoration regardless of age (up to 7-day cutoff)

### FR-007: Working Memory Pin Inheritance

- **Requirement**: The system MUST restore working memory pins from the most recent qualifying session, deduplicated against any pins already present in the new session
- **Inheritance Rules**:
  - Pins with `importance` tag "CRITICAL" are always inherited regardless of session age (up to 7 days)
  - Standard pins are inherited from sessions with `relevance_score ≥ 0.4`
  - Inherited pins are labeled with provenance: `[inherited from {session_id} @ {timestamp}]`
  - Max inherited pins: 5 (working memory cap is 10; reserve 5 for current session)
  - If inherited pin conflicts with current pin (same label), current session pin wins
- **Priority**: HIGH
- **Testable**: A working memory pin set in session A is present in session B started 24h later, labeled with provenance

### FR-008: Pending Task Surfacing

- **Requirement**: The system MUST surface unfinished LBF tasks from prior sessions at session start
- **Detection**: Tasks are flagged as pending if:
  - They were in-progress (stage: build/verify/validate) at session end
  - A working memory pin explicitly mentions a task as incomplete
  - A Synapse message from this session referenced a task with no completion ack
- **Surfacing Format**: Injected into session preamble as a structured list with task ID, title, last stage, and days since last activity
- **Priority**: MEDIUM
- **Testable**: An LBF task in "build" stage at session end appears in the next session's preamble with correct metadata

### FR-009: Session Chain Traversal

- **Requirement**: The system MUST maintain bidirectional links between sessions and support traversal of the session chain
- **Implementation**:
  - Each session record stores `previous_session_id`
  - When a session is loaded for restoration, its `continued_by` field is updated with the new session ID
  - A `getSessionChain(session_id, depth)` function must traverse up to N sessions backward
- **Use Case**: Enables "what was I working on last Tuesday?" queries
- **Priority**: MEDIUM
- **Testable**: `getSessionChain(current_id, 5)` returns a linked list of the 5 most recent sessions in chronological order

### FR-010: Session Start Preamble Injection

- **Requirement**: The system MUST inject a structured preamble into the session context on startup when prior sessions are restored
- **Preamble Format**:

  ```
  [SESSION CONTINUITY — inherited from {N} prior session(s)]

  PENDING TASKS:
  - [{task_id}] {title} (last stage: {stage}, {days}d ago)

  ACTIVE PROJECTS: {project list}

  HOT TOPICS: {keyword list}

  WORKING MEMORY RESTORED: {N} pins inherited
  (Use working_memory view to see all pins)
  ```

- **Delivery**: Via OpenClaw session initialization hook, before first user message is processed
- **Silence Mode**: If no prior sessions qualify for restoration, no preamble is injected (no noise)
- **Priority**: HIGH
- **Testable**: Starting a new session after prior qualifying sessions shows the structured preamble; starting cold (no prior sessions) shows nothing

### FR-011: Manual Session Continuity Override

- **Requirement**: The system MUST support explicit continuation of a specific prior session by ID
- **Trigger**: Via Cortex tool call: `cortex_session_continue(session_id: string)`
- **Behavior**: Forces full inheritance from the specified session regardless of age or relevance score
- **Priority**: LOW
- **Testable**: `cortex_session_continue("abc-123")` restores all pins and context from session "abc-123" even if 14 days old

### FR-012: Session Crash Recovery

- **Requirement**: The system MUST detect and handle abrupt session terminations (crash, kill, timeout) and still produce a SessionState record
- **Detection**: A session is considered crashed if no `end_time` is recorded but the session is not in the active sessions list
- **Recovery**: On next startup, detect crashed sessions and write a recovery record with:
  - `end_time`: estimated from last known activity timestamp
  - `pending_tasks`: all tasks active at time of crash
  - A `crash_recovered: true` flag
- **Priority**: MEDIUM
- **Testable**: After killing a session process mid-work, the next session detects the crashed session and restores its working memory

### FR-013: Metrics and Observability

- **Requirement**: The system MUST log all session persistence events through the existing Cortex metrics system (v1.3.0+)
- **Events Logged**:
  - `session_captured` (session_id, pin_count, learning_count, task_count)
  - `session_restored` (from_session_ids[], pins_inherited, relevance_scores[])
  - `confidence_decay_applied` (memory_id, original_score, decayed_score, hours_elapsed)
  - `pending_task_surfaced` (task_id, days_pending)
  - `session_chain_traversal` (start_id, depth, sessions_found)
- **Storage**: Tamper-evident metrics via existing Cortex metrics writer
- **Priority**: HIGH
- **Testable**: All session lifecycle events appear in metrics with correct structured fields

---

## Non-Functional Requirements

### NFR-001: Performance

- **Session Capture Latency**: Full SessionState capture MUST complete within 500ms of session end signal
- **Session Restoration Latency**: Full context restoration MUST complete within 2000ms of session start
- **Storage Overhead**: Each SessionState record MUST NOT exceed 50KB serialized
- **Database Impact**: Session persistence operations MUST NOT block concurrent brain.db reads/writes beyond 100ms
- **Lookback Query Speed**: Fetching and scoring 7 days of prior sessions MUST complete in <500ms

### NFR-002: Security

- **No Secret Persistence**: Working memory pins containing credential patterns (passwords, API keys, tokens) MUST be redacted before storage — redaction uses the same pattern list as the pre-action hook system (NFR-002 of task-003)
- **Local Storage Only**: SessionState records MUST NOT be sent to external services; storage is local brain.db and local JSON only
- **Session ID Isolation**: Session IDs are UUIDs; no personally identifiable information embedded in IDs
- **Audit Trail**: All manual overrides (`cortex_session_continue`) logged with invoking agent and timestamp

### NFR-003: Compatibility

- **Cortex v1.2.0+**: Full integration with existing confidence scoring engine; inherited confidence uses the same score field and decay mechanics as defined in v1.2.0 (not a parallel scoring system)
- **Cortex v1.5.0+**: Session capture hooks fire AFTER pre-action hook cleanup; no interference with hook cooldown state
- **OpenClaw Working Memory**: Pin inheritance writes through the existing `working_memory` tool interface — no direct database writes that bypass the pin cap enforcement
- **brain.db Schema**: New `session_states` table added via migration; existing tables (`memories`, `stm`, `metrics`) unmodified
- **Backward Compatibility**: Systems without session persistence enabled experience no behavior change

### NFR-004: Reliability

- **Crash Safety**: Session capture uses a write-ahead pattern — partial writes do not corrupt existing session records
- **Fail-Open**: If session restoration fails for any reason, the session starts normally with no context; errors are logged but do not block startup
- **Idempotent Restoration**: Restoring the same session twice does not create duplicate working memory pins or duplicate preamble injections
- **Data Retention**: Session records older than 30 days are automatically archived (moved to cold storage JSON, removed from hot brain.db table)

### NFR-005: Maintainability

- **Modular Components**: Clear separation between `SessionCapture`, `SessionRestorer`, `ContextScorer`, `DecayEngine`, and `PreambleInjector` modules
- **Configurable Parameters**: All thresholds (relevance score, decay rate, lookback days, max inherited pins) externally configurable via Cortex plugin config without code changes
- **Diagnostic Mode**: `CORTEX_SESSION_DEBUG=1` env var enables verbose logging of all scoring decisions and inheritance choices
- **Schema Versioning**: `session_states` table includes a `schema_version` field; migrations handle upgrades cleanly

---

## Dependencies

### Internal Dependencies

- **Cortex STM / brain.db** (Cortex v1.0.0+): SQLite backend for persistent session state storage; new `session_states` table added via migration
- **Confidence Scoring Engine** (Cortex v1.2.0+): `calculateCurrentConfidence()` used as baseline for inherited scores; decay applied on top
- **Metrics Writer** (Cortex v1.3.0+): All session events written through tamper-evident metrics pipeline
- **Pre-Action Hook System** (Cortex v1.5.0+): Session capture fires after hook cleanup; hook cooldown state NOT persisted across sessions (ephemeral)
- **Working Memory Tool** (OpenClaw core): Pin inheritance writes through `working_memory(pin)` — respects 10-pin cap
- **OpenClaw Plugin Lifecycle Hooks**: `on_session_start` and `on_session_end` hooks required for automatic capture/restore; if not available, a manual trigger fallback is required

### External Dependencies

- **SQLite** (via existing brain.db connection): No new database engine; same connection pool as Cortex STM
- **Node.js crypto module**: UUID generation for `session_id`
- **File System**: Write access to `~/.openclaw/sessions/` for JSON mirror files

### Modified Components

- **cortex-bridge.ts**: New `SessionPersistenceManager` class; new `session_states` table migration
- **Cortex Extension index.ts**: Register `on_session_start` and `on_session_end` lifecycle hooks
- **brain.db schema**: New `session_states` table (migration v4)
- **Cortex plugin config schema**: New `session_persistence` configuration block

### Does NOT Modify

- Existing `memories`, `stm`, `atoms`, `metrics` tables — read-only access only
- Pre-action hook interception logic — session capture is post-hook, not part of the hook chain
- Working memory pin storage format — inheritance uses the existing tool interface

---

## Acceptance Criteria

### AC-001: End-of-Session Capture

- ✅ SessionState record written to brain.db within 500ms of session end
- ✅ All required fields populated (working_memory, hot_topics, active_projects, pending_tasks, recent_learnings)
- ✅ Credential patterns redacted from stored pin content
- ✅ Crash recovery produces a valid (if partial) SessionState record for abrupt terminations

### AC-002: Session Restoration on Startup

- ✅ New session inherits working memory pins from prior qualifying session within 2000ms
- ✅ Preamble injected with pending tasks, active projects, and hot topics
- ✅ No preamble injected when no qualifying prior sessions exist (cold start is silent)
- ✅ Inherited pins labeled with provenance (session ID + timestamp)

### AC-003: Confidence Decay Correctness

- ✅ Memory restored after 48h has confidence ≈ 0.89 × original in session context
- ✅ Original brain.db confidence score unchanged by restoration
- ✅ Memories decayed below 0.3 are excluded from restoration
- ✅ Decay formula matches spec: `max(0.3, 1.0 - (h/168) × 0.4)`

### AC-004: Relevance Scoring and Filtering

- ✅ Sessions with `relevance_score < 0.25` are not restored
- ✅ Sessions with pending tasks score ≥ 0.25 in `pending_tasks_weight` regardless of topic overlap
- ✅ Up to 3 prior sessions contribute context simultaneously (no more)
- ✅ Topic overlap correctly computed from `hot_topics` intersection

### AC-005: Working Memory Inheritance Limits

- ✅ Maximum 5 inherited pins inserted into working memory (cap enforced)
- ✅ Current session pins take priority over inherited pins on label collision
- ✅ CRITICAL-tagged pins are inherited regardless of relevance score (up to 7-day cutoff)

### AC-006: Pending Task Surfacing

- ✅ LBF tasks in build/verify/validate stage at session end appear in next-session preamble
- ✅ Preamble shows task ID, title, last stage, and days since last activity
- ✅ Tasks absent from LBF (deleted/completed externally) are silently dropped from preamble

### AC-007: Session Chain Integrity

- ✅ `previous_session_id` links form a valid chain across sessions
- ✅ `continued_by` is set on prior session when a new session restores from it
- ✅ `getSessionChain(id, 5)` returns correct ordered history

### AC-008: Performance Targets

- ✅ Session capture: < 500ms in 95th percentile
- ✅ Session restoration: < 2000ms in 95th percentile
- ✅ Lookback query (7 days, scoring all sessions): < 500ms
- ✅ No brain.db read blocking beyond 100ms per operation

### AC-009: Metrics Coverage

- ✅ All 5 event types logged (`session_captured`, `session_restored`, `confidence_decay_applied`, `pending_task_surfaced`, `session_chain_traversal`)
- ✅ Metrics accessible via existing Cortex metrics API
- ✅ No metrics emitted on cold start (nothing to restore)

### AC-010: Integration Testing

- ✅ Full round-trip test: session A sets pins → shutdown → session B restores pins with correct decay
- ✅ Pre-action hook system (v1.5.0) unaffected by session persistence layer
- ✅ brain.db migration runs without data loss on existing databases
- ✅ Existing Cortex tools (cortex_add, cortex_stm, cortex_search) behave identically with or without session persistence enabled

---

## Out of Scope

### OS-001: Memory Consolidation

- This system does NOT merge, promote, or archive memories across sessions
- Memory consolidation pipeline is a separate deliverable (Phase 2.2 of IMPROVEMENT_PLAN)

### OS-002: Hierarchical Memory Tiers

- This system does NOT implement Tier 1/2/3/4 memory architecture
- The tiered memory system is Phase 2.3; this feature provides the session boundary capture that feeds it

### OS-003: Sub-Agent Knowledge Inheritance

- This system does NOT extend session persistence to sub-agents
- Sub-agent shared cortex access is Phase 3.1; sub-agents remain session-isolated for now

### OS-004: Cross-User or Cross-Channel Sessions

- Session state is single-user, single-channel scoped
- No cross-channel or cross-user session linking in this phase

### OS-005: Session Replay or Debugging

- This system does NOT provide a "replay session" capability or interactive session history viewer
- Chain traversal is for context inheritance only, not full session replay

### OS-006: External Persistence or Sync

- SessionState records remain local to the host machine (brain.db + ~/.openclaw/sessions/)
- No cloud sync, remote backup, or cross-host session handoff

### OS-007: Automatic SOP Persistence

- SOP interaction logs are captured in SessionState for analytics only
- This system does NOT create new SOPs or modify existing ones based on session activity
- Auto-SOP generation is Phase 4.2

### OS-008: Real-Time Session Bridging

- This system does NOT support live handoff between concurrent sessions
- Context inheritance is offline (at session start from prior session's captured state)

---

**Next Steps**: Upon approval, proceed to design phase with technical specification of `session_states` migration, `SessionPersistenceManager` class design, OpenClaw lifecycle hook integration points, and the decay engine implementation.
