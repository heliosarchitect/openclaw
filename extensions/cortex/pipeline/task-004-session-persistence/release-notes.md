# Release Notes — Cortex v2.0.0 "Session Persistence"

**Task ID**: task-004-session-persistence  
**Stage**: deploy  
**Release Date**: 2026-02-18  
**Released By**: Release Engineer (Pipeline Sub-Agent)  
**Git Tag**: `cortex-v2.0.0`  
**Commit**: `086253577`  
**Remotes Published**: `gitea` (gitea.fleet.wood), `helios` (github.com/heliosarchitect/openclaw)

---

## Summary

Cortex v2.0.0 ships **Cross-Session State Preservation** — the answer to "Will you remember in 2 days?" is now **YES**.

Every session boundary is captured as a structured `SessionState` record containing working memory pins, hot topics, active projects, pending LBF tasks, and recent learnings. On next session start, prior context is restored via relevance scoring with time-decayed confidence so that continuity is a guaranteed architectural property, not a best-effort behavior.

This is Phase 2.1 of the Helios IMPROVEMENT_PLAN. It is a MAJOR version bump (v1.5.0 → v2.0.0) because it adds a new `session_states` database table and new lifecycle hooks at `registerService.start/stop` — a structural architectural addition, though all changes are additive and backward-compatible.

---

## What Ships

### New Capabilities

| Feature                                | Description                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Session State Capture**              | Full `SessionState` record written at `registerService.stop()` + incremental crash-safe writes at `agent_end`     |
| **Session State Restoration**          | Prior context restored at `registerService.start()` within 2 seconds; relevance-scored, confidence-decayed        |
| **Working Memory Pin Inheritance**     | Up to 5 pins from highest-scoring prior session; labeled with provenance; respects 10-pin hard cap                |
| **Session Continuity Preamble**        | Structured context injected as L0 tier on first agent turn — pending tasks, active projects, hot topics           |
| **Confidence Decay Engine**            | `max(0.3, 1.0 - (h/168) × 0.4)` — 30% floor after 7 days; applied at restore-time only, never written to brain.db |
| **Relevance Scoring**                  | Recency (40%) + topic overlap (35%) + pending tasks (25%); threshold 0.25; top-3 sessions contribute              |
| **Hot Topic Extraction**               | Stateful keyword accumulator from tool calls, exec workdirs, memory accesses, Synapse subjects; top-20 retained   |
| **Crash Recovery**                     | Detects `NULL end_time` sessions on startup; writes recovery record with `crash_recovered: true` flag             |
| **JSON Mirror**                        | Session snapshots mirrored to `~/.openclaw/sessions/{session_id}.json` for forensic analysis                      |
| **`cortex_session_continue` tool**     | Manual force-inheritance from any prior session by ID                                                             |
| **`session_persistence` config block** | 9 configurable parameters (enabled, lookback_days, thresholds, paths, debug)                                      |

### New Files

| File                             | LOC | Purpose                                                                   |
| -------------------------------- | --- | ------------------------------------------------------------------------- |
| `session/types.ts`               | 95  | TypeScript interfaces (SessionState, PendingTask, ConfidenceUpdate, etc.) |
| `session/decay-engine.ts`        | 40  | Confidence decay formula                                                  |
| `session/context-scorer.ts`      | 40  | Relevance scoring engine                                                  |
| `session/hot-topic-extractor.ts` | 177 | Stateful keyword accumulator                                              |
| `session/preamble-injector.ts`   | 82  | Session continuity preamble formatter                                     |
| `session/session-manager.ts`     | 373 | `SessionPersistenceManager` orchestrator                                  |
| `python/session_manager.py`      | 195 | SQLite DB layer for `session_states` CRUD                                 |

**Total new code**: ~1,014 LOC across 7 files

### Database Changes

- **New table**: `session_states` in brain.db (migration v4, idempotent `CREATE TABLE IF NOT EXISTS`)
- Indexes on `end_time`, `previous_session_id`, `channel`
- Session chain via `previous_session_id` FK links for "what was I working on last Tuesday?" queries

---

## Test Results

| Category               | Result                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| TypeScript compilation | ✅ PASS — zero errors                                                                          |
| Session unit tests     | ✅ **137 tests PASS**, 0 failures                                                              |
| Pre-existing failures  | ⚠️ 8 in unrelated modules (pairing, browser, model-catalog, CLI) — not introduced by this task |
| Integration wiring     | ✅ All lifecycle hooks verified                                                                |

**Test files**: `decay-engine.test.ts` (17), `context-scorer.test.ts` (19), `preamble-injector.test.ts` (19), `hot-topic-extractor.test.ts` (63), `session-manager.test.ts` (19)

---

## Security Sign-Off

**Result**: ✅ APPROVED — 0 CRITICAL, 0 HIGH findings

| Severity | Count | Disposition                                           |
| -------- | ----- | ----------------------------------------------------- |
| CRITICAL | 0     | —                                                     |
| HIGH     | 0     | —                                                     |
| MEDIUM   | 2     | Mitigated by architecture; fixes scheduled for v2.0.1 |
| LOW      | 4     | Acceptable                                            |

**MED-001** (incomplete base64/AWS credential redaction patterns) — mitigated by local-only storage; fix in v2.0.1  
**MED-002** (missing audit metric on `cortex_session_continue`) — mitigated by trusted agent context; fix in v2.0.1

---

## Breaking Changes

**None.** All changes are additive and backward-compatible. The `session_states` table migration is idempotent. Systems without `session_persistence` enabled in config experience no behavior change.

---

## Known Issues / Deferred to v2.0.1

- MED-001: Add base64 + AWS key patterns to `CREDENTIAL_PATTERNS`
- MED-002: Add `writeMetric("session", { event: "session_override" })` to `cortex_session_continue`
- LOW-001: `archive_old_sessions()` should verify JSON mirror exists before DELETE
- LOW-002: Add `MAX_TOPIC_ENTRIES` cap with LRU eviction to `HotTopicExtractor`

---

## Deployment Notes

No manual deployment steps required. The `session_states` table is created automatically on first startup. The `~/.openclaw/sessions/` directory is created on demand.

**Optional configuration** (all defaults are sensible):

```json
{
  "session_persistence": {
    "enabled": true,
    "lookback_days": 7,
    "relevance_threshold": 0.25,
    "max_sessions_scored": 20,
    "max_inherited_pins": 5,
    "decay_min_floor": 0.3,
    "critical_inheritance_days": 7,
    "sessions_dir": "~/.openclaw/sessions",
    "debug": false
  }
}
```

---

## Pipeline Artifacts

| Stage        | Artifact                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| Requirements | `pipeline/task-004-session-persistence/requirements.md`                  |
| Design       | `pipeline/task-004-session-persistence/design.md`                        |
| Document     | `pipeline/task-004-session-persistence/document.md`                      |
| Build        | `pipeline/task-004-session-persistence/build-report.md`                  |
| Security     | `pipeline/task-004-session-persistence/security-review.md`               |
| Test         | `pipeline/task-004-session-persistence/test-report.md`                   |
| **Deploy**   | **`pipeline/task-004-session-persistence/release-notes.md`** ← this file |

---

## What's Next

**Phase 2.2 — Memory Consolidation Pipeline** (task-005-predictive-intent queued)  
Session state capture now provides the raw material for cross-session memory consolidation: promoting frequently-recurring learnings from STM to long-term embeddings, pruning stale context, and abstracting session patterns into atoms. Phase 2.2 consumes `session_states` as its primary input.

---

_Released by LBF Automated Development Pipeline — Release Engineer stage_  
_Cortex v2.0.0 | 2026-02-18 | cortex-v2.0.0 @ 086253577_
