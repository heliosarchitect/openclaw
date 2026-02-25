# Cortex Memory Extension Changelog

## ⛔ CONSTRAINTS — What NOT To Do

_Every constraint has a scar behind it. Remove only when the underlying system changes make them obsolete._

### Memory Management Constraints

- **NO direct database writes** — All memory operations must go through brain.py UnifiedBrain class to maintain consistency and prevent corruption.
- **NO confidence scores outside 0.1-1.0 range** — Values outside this range break filtering logic and cause tool failures.
- **NO synchronous confidence recalculation** — Confidence updates must be async/batched to prevent blocking memory operations.

---

## Version 2.8.0 - "Auto-SOP Generation (Recommendation-Only)" (February 25, 2026)

### New Features

- **NEW (task-041):** Auto-SOP Generation Engine (MVP)
  - Deterministic command extraction from pipeline artifacts (shell fences + inline commands)
  - Command normalization to reduce volatile tokens (SHA/time/home-path)
  - Deterministic signature payload + stable JSON hashing → 12-hex signature
  - Proposal JSON schema with enforced governance invariants:
    - `mode: recommendation_only`
    - `requires_human_validation: true`
  - Proposal artifact writer: `extensions/cortex/sop-proposals/<signature>/(proposal.json|proposal.md)`

### Security

- **Hardened markdown rendering**: escape backticks + force one-line inline-code rendering to reduce formatting injection risk
- **Bounded evidence artifact reads**: refuse to hash evidence outside repoRoot (defensive anti-path-traversal)

---

## Version 2.7.5 - "SQL Hardening Validated" (February 19, 2026)

### Security

- **task-017 complete:** Full validation pipeline for FINDING-001 SQL injection fix. All 20 hardening tests pass. CHANGELOG backfilled for v2.7.1–v2.7.4.

### Fixes (v2.7.1–v2.7.5 cumulative — backfilled from git log)

- **v2.7.5:** `fix(cortex)` — Demote `rb-rotate-logs` auto-approval + isolate git-adapter live test (commit `7472d1693`)
- **v2.7.4:** `fix(cortex)` — Expand `sanitizeCommand` with GitHub/GitLab/Slack/PEM/env-export patterns + 16 tests (commit `818dd1cfa`)
- **v2.7.3:** `fix(cortex)` — Add AWS/URL/1Password credential patterns to `sanitizeCommand` (commit `1d78021f0`)
- **v2.7.2:** `fix(cortex)` — **FINDING-001 (High) mitigated:** Replaced naive single-quote escaping in `runSQL`, `getSQL`, and `allSQL` with base64-encoded parameter passing. SQL strings and params are now base64-encoded in TypeScript before embedding in the Python subprocess template. Python decodes both values before execution via `base64.b64decode`. Eliminates backslash-quote bypass (`\'` → `\\'`) that could break out of the Python string literal. All values reach `db.execute(sql, params)` safely decoded. (commit `3f25091b4`)
- **v2.7.1:** `fix(cortex)` — Correct `memories→stm` table name in abstraction engine (6 files + test) (commit `3ba083c90`)

### Test Coverage Added (task-017)

- **NEW:** `extensions/cortex/__tests__/sql-hardening.test.ts` — 20 injection resistance tests covering AC-001 through AC-015
  - Real Python subprocess execution against hermetic temp SQLite database
  - Script integrity tests validate base64 encoding present in generated Python scripts
  - Static source analysis guards against reintroduction of `.replace(/'/)` escape patterns
  - Adversarial: multi-statement DROP TABLE, 4KB SQL stress, Unicode params

### Security Findings Logged

| ID          | Severity | Status                | Description                                                         |
| ----------- | -------- | --------------------- | ------------------------------------------------------------------- |
| FINDING-001 | High     | ✅ Mitigated (v2.7.2) | SQL injection via backslash-quote bypass — base64 encoding fix      |
| FINDING-002 | Medium   | 🔵 Track (task-018)   | Non-SQL `runPython` callers use `JSON.stringify` interpolation      |
| OBS-001     | Low      | 🔵 Track (task-018)   | `memoryId` interpolated without encoding in `editSTM`/`updateSTM`   |
| OBS-002     | Low      | 🔵 Track              | Concurrent SQLite access may cause transient lock errors under load |

### Behavioral Signature

```
✓ extensions/cortex/__tests__/sql-hardening.test.ts (20 tests) — all pass
# grep "\.replace.*'" cortex-bridge.ts → 0 results in SQL methods
# TypeScript: exit 0, no errors
```

**Regression indicator:**

```
✗ backslash-quote bypass does not break Python execution (FINDING-001)
Error: Python subprocess exited with code 1
SyntaxError: EOL while scanning string literal
```

---

## Version 2.0.0 - "Session Persistence" (February 18, 2026)

### ⛔ New Constraints

- **NO direct writes to working_memory.json** — Pin inheritance must use `saveWorkingMemory()` — never direct DB writes to the `working_memory` table.
- **NO blocking session restoration** — If `onSessionStart()` exceeds 1500ms, fall back to cold start immediately.
- **NO credential storage in session_states** — All working memory pins must be redacted through `redactCredentials()` before DB write.
- **NO confidence score modifications from decay engine** — Decay is applied only at restore-time for filtering decisions; it never writes to the `stm` table.

### Breaking Changes

None — All changes are additive and backward compatible. The `session_states` table is created with `CREATE TABLE IF NOT EXISTS` (idempotent migration).

### New Features

- **NEW**: Cross-Session State Preservation — Maintain context across session boundaries with confidence-decayed inheritance
  - Session state captured at `registerService.stop()` (final) and `agent_end` (incremental, crash-safe)
  - Prior session context restored at `registerService.start()` via relevance scoring
  - Confidence decay formula: `max(0.3, 1.0 - (h/168) × 0.4)` — 30% floor after 7 days
  - Relevance scoring: recency (40%) + topic overlap (35%) + pending tasks (25%)
  - Sessions with score < 0.25 are silently dropped; top-3 qualifying sessions contribute

- **NEW**: Working Memory Pin Inheritance — Pins from prior sessions survive session boundaries
  - Up to 5 pins inherited from highest-scoring prior session
  - Hard cap: 10 total pins enforced (inherited + existing)
  - Label deduplication prevents duplicate pins on repeated inheritance
  - CRITICAL-priority pins from prior sessions preserved

- **NEW**: Session Continuity Preamble — Structured context injection on first agent turn
  - Format: pending tasks, active projects, hot topics, inherited pin count
  - Injected as L0 context tier (before working memory) — not counted against token budget
  - Fired once per session (module-level flag prevents repetition)
  - Cold starts are silent — no preamble if no qualifying prior sessions

- **NEW**: Hot Topic Extraction — Stateful keyword accumulator tracks session focus
  - Signal sources: tool calls, memory accesses, exec workdirs, Synapse subjects, pin labels
  - Top-20 keywords stored per session; used for relevance scoring at next session start
  - Stop word filtering: 30 common stop words excluded

- **NEW**: Crash Recovery — Detect and recover sessions with NULL end_time
  - `detectAndRecoverCrashed()` fires at every `registerService.start()`
  - Incremental `agent_end` capture ensures most state survives SIGKILL

- **NEW**: JSON Mirror — Session snapshots mirrored to `~/.openclaw/sessions/{session_id}.json`
  - Backup outside brain.db for forensic analysis
  - Written asynchronously (best-effort; DB record is authoritative)

- **NEW**: `cortex_session_continue` tool — Manual session inheritance override
  - Force-inherit from a specific prior session ID
  - Useful for multi-channel session continuity

- **NEW**: `session_persistence` config block — 9 configurable parameters
  - `enabled`, `lookback_days`, `relevance_threshold`, `max_sessions_scored`
  - `max_inherited_pins`, `decay_min_floor`, `critical_inheritance_days`
  - `sessions_dir`, `debug`

### Database Changes

- **NEW TABLE**: `session_states` in brain.db (migration v4)
  - Indexed on `end_time`, `previous_session_id`, `channel`
  - JSON fields: `working_memory`, `hot_topics`, `active_projects`, `pending_tasks`, `recent_learnings`
  - Session chain via `previous_session_id` FK links

### New Files

| File                             | Purpose                                                                   |
| -------------------------------- | ------------------------------------------------------------------------- |
| `session/types.ts`               | TypeScript interfaces (SessionState, PendingTask, WorkingMemoryPin, etc.) |
| `session/decay-engine.ts`        | Confidence decay formula                                                  |
| `session/context-scorer.ts`      | Relevance scoring: recency + topic overlap + pending tasks                |
| `session/hot-topic-extractor.ts` | Stateful keyword accumulator                                              |
| `session/preamble-injector.ts`   | Session continuity preamble formatter                                     |
| `session/session-manager.ts`     | SessionPersistenceManager orchestrator                                    |
| `python/session_manager.py`      | SQLite DB layer for session_states CRUD                                   |

### Tests Added

- 137 TypeScript tests across 5 new test files (100% requirement coverage)
- 17 Python integration tests (SQLite CRUD, chain traversal, crash recovery)
- 0 regressions against existing cortex test suite

---

## Version 1.2.0 - "Confidence Foundation" (February 17, 2026)

### ⛔ New Constraints

- **NO manual confidence score assignment** — Confidence must be calculated via ConfidenceEngine to ensure consistency.

### Breaking Changes

None — All changes are additive and backward compatible.

### New Features

- **NEW**: Memory Confidence Scoring System — Automatic reliability scoring for all memories
  - Algorithm: Age decay, access frequency boost, validation bonus, contradiction penalty
  - Range: 0.1 (minimum) to 1.0 (maximum confidence)
  - Coverage: STM entries, embeddings, atoms
  - Retroactive: Scores all existing memories based on historical data

- **NEW**: Confidence-Based Memory Filtering — Filter memories by reliability threshold
  - Critical operations: 0.8 minimum confidence required
  - Routine operations: 0.5 minimum confidence required
  - Experimental: 0.2 minimum confidence required
  - Search integration: Confidence scores included in all results

- **NEW**: Confidence Audit Trail — Track confidence changes over time
  - Reasons: Access boost, validation success/failure, contradiction detection
  - Full history: When confidence changed, why, and by how much
  - Debugging: Identify why memories have specific confidence levels

### Bug Fixes

- **FIX**: TypeScript compilation errors in cortex extension — Missing tool labels and undefined ctx references → Added required label properties and fixed parameter names
- **FIX**: Import statement cleanup — Removed unused imports causing ESLint errors → Cleaner codebase

### Database Schema Changes

- **SCHEMA**: Added confidence tracking columns to all memory tables

  ```sql
  -- STM entries
  ALTER TABLE stm_entries ADD COLUMN confidence REAL DEFAULT 0.5;
  ALTER TABLE stm_entries ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'));
  ALTER TABLE stm_entries ADD COLUMN access_count INTEGER DEFAULT 1;

  -- Embeddings
  ALTER TABLE embeddings ADD COLUMN confidence REAL DEFAULT 0.5;
  ALTER TABLE embeddings ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'));

  -- Atoms
  ALTER TABLE atoms ADD COLUMN confidence REAL DEFAULT 0.6;
  ALTER TABLE atoms ADD COLUMN validation_count INTEGER DEFAULT 0;
  ```

- **SCHEMA**: New confidence audit table for change tracking
  ```sql
  CREATE TABLE confidence_audit (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    old_confidence REAL,
    new_confidence REAL,
    reason TEXT,
    timestamp INTEGER DEFAULT (strftime('%s', 'now'))
  );
  ```

### Configuration Changes

- **CONFIG**: Default STM capacity reduced from 50,000 to 2,000 — Prevents memory bombs during initialization

### Performance Impact

| Metric              | Before | After  | Delta                         |
| ------------------- | ------ | ------ | ----------------------------- |
| Memory Search       | ~200ms | ~250ms | +25% (confidence calculation) |
| Memory Creation     | ~50ms  | ~55ms  | +10% (initial confidence)     |
| Database Size       | 13MB   | 13.5MB | +4% (confidence metadata)     |
| Retroactive Scoring | N/A    | <5min  | New operation                 |

### Tool Enhancements

- **cortex_add**: Now sets initial confidence of 1.0 for all new memories
- **cortex_stm**: Displays confidence percentages alongside memory content
- **cortex_stats**: Reports confidence distribution (high/medium/low breakdown)
- **memory_search**: Can filter by minimum confidence threshold

### Key Files Changed

- `extensions/cortex/python/confidence_engine.py` — New confidence calculation engine
- `extensions/cortex/python/migrate_confidence.py` — Retroactive scoring migration
- `extensions/cortex/python/brain.py` — Confidence integration in UnifiedBrain
- `extensions/cortex/cortex-bridge.ts` — TypeScript confidence support
- `extensions/cortex/index.ts` — Tool enhancements with confidence

### Key Commits

- `2bffc4109` — fix: TypeScript errors in cortex extension - add missing labels and fix ctx references
- `eed6c8018` — fix: remaining TypeScript issues - remove OpenClawPlugin type, fix implicit any

### Migration Required

Run confidence migration after deployment:

```bash
cd ~/Projects/helios/extensions/cortex/python
python3 migrate_confidence.py --batch-size 1000 --progress
```

### Lessons Learned

- TypeScript tooling definitions require `label` property in newer OpenClaw versions
- Large STM capacity defaults (50K) cause gateway hangs during initialization
- Confidence scoring must be designed as additive feature to avoid breaking existing functionality
- Database migrations need comprehensive rollback plans for production safety

---

## Version 1.1.0 - "Pre-Action SOP Enforcement" (2026-02-17)

### New Features

- **NEW**: Pre-action SOP enforcement hook — Intercepts tool calls to inject relevant SOPs and procedures
- **NEW**: Mandatory knowledge consultation — Tool execution blocked until knowledge acknowledgment

### Bug Fixes

- **FIX**: Hot memory feedback loop — Reduced decay rate to prevent infinite growth

---

## Version 1.0.0 - "Foundation Release" (2026-02-17)

### New Features

- **NEW**: Short-term memory (STM) with 50K+ capacity
- **NEW**: Atomic knowledge units with causal linking
- **NEW**: Temporal search and pattern analysis
- **NEW**: Cross-agent messaging via SYNAPSE protocol
- **NEW**: GPU-accelerated embeddings with semantic search
- **NEW**: Deep causal abstraction ("keep going until no")
- **NEW**: Working memory management for persistent context

### Database Schema

- Initial brain.db schema with unified storage
- STM, atoms, embeddings, messages, threads tables
- FTS5 full-text search integration

---

_Template: lbf-templates/project/CHANGELOG.md_
