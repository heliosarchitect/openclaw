# Release Notes — Cortex v2.1.0 "Predictive Intent"

**Task ID**: task-005-predictive-intent  
**Phase**: 5.1  
**Stage**: deploy  
**Release Date**: 2026-02-18  
**Released By**: Orchestrator (Pipeline Deploy Stage)  
**Git Tag**: `cortex-v2.1.0`  
**Commit**: `a1e357f90`  
**Remotes Published**: `gitea` (gitea.fleet.wood), `helios` (github.com/heliosarchitect/openclaw)

---

## Summary

Cortex v2.1.0 ships **Predictive Intent — Act Before Asked**. Helios is no longer purely reactive. A continuous background polling engine monitors 10 live data sources (AUGUR signals/trades/regime/paper, fleet health, OctoPrint, git activity, pipeline state, session context, and atoms), generates scored `Insight` records, and delivers them to the right channel at the right time — without interrupting focus.

This is **Phase 5.1** of the Helios IMPROVEMENT_PLAN.

---

## What Ships

### New Capabilities

| Feature                              | Description                                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Predictive Polling Engine**        | Per-source async timer loops (60s–15min intervals) across 10 data adapters; graceful degradation if any source fails                      |
| **InsightGenerator**                 | Pure-function handlers per source: anomaly detection, opportunity spotting, briefing triggers (10 handlers registered)                    |
| **UrgencyScorer**                    | 4-factor weighted formula (time_sensitivity×0.4 + financial_impact×0.3 + historical_rate×0.2 + cross_source×0.1) → 4-tier channel routing |
| **DeliveryRouter**                   | Channel assignment (signal/synapse/in_session/preamble), batch buffering, focus-mode suppression, 5-min signal rate limit per source      |
| **FeedbackTracker**                  | Implicit (tool-call keyword match) + explicit (ack phrase detection) action tracking; rolling action-rate per source×type                 |
| **BriefingGenerator**                | Morning brief (6AM EST), pre-sleep idle (90min), pipeline completion, pre-work project detection                                          |
| **PatternLearner**                   | Time-window join on acted_on feedback → atom creation when rate ≥ 0.3 with ≥ 3 observations                                               |
| **FocusModeTracker**                 | Sliding-window (90s/3-calls) singleton; suppresses non-critical insights during active tool use                                           |
| **`cortex_predict` tool**            | Query queued/delivered insights by source, urgency, or keyword; returns stale-source list                                                 |
| **`predictive_intent` config block** | 35+ configurable parameters with sensible defaults; disabled=no behavior change                                                           |

### Data Sources

| Source ID        | What It Monitors                            | Interval  |
| ---------------- | ------------------------------------------- | --------- |
| `augur.signals`  | live_signal.json staleness + signal changes | 60s       |
| `augur.trades`   | Open positions, session P&L                 | 5min      |
| `augur.regime`   | Regime flips                                | 5min      |
| `augur.paper`    | Paper loss streaks                          | 15min     |
| `fleet.health`   | SSH reachability of all fleet hosts         | 5min      |
| `octoprint.jobs` | Print completion, errors, milestones        | 5min      |
| `git.activity`   | Recent commits across ~/Projects/           | 10min     |
| `pipeline.state` | Stuck stages, failed tasks, completions     | 2min      |
| `cortex.session` | Hot topics, pending tasks from SessionState | On-demand |
| `cortex.atoms`   | Relevant causal patterns for active context | 10min     |

### Database Changes

**brain.db migration v5** — 3 new tables (all idempotent `CREATE TABLE IF NOT EXISTS`):

- `insights` — Insight records with state machine (generated→scored→queued→delivered→acted_on/ignored/expired)
- `insight_feedback` — Per-insight feedback records (explicit/implicit/ignored, latency_ms)
- `predict_action_rates` — Precomputed rolling 30-day action rates per (source_id, insight_type)

### New Files (26 files, ~2,943 LOC TypeScript + 284 LOC Python)

```
predictive/
├── types.ts                     # All TypeScript interfaces
├── polling-engine.ts            # Multi-source timer orchestration
├── insight-generator.ts         # Pure-function per-source handlers
├── urgency-scorer.ts            # 4-factor scoring formula
├── delivery-router.ts           # Channel routing + batching
├── feedback-tracker.ts          # Action detection + rate updates
├── briefing-generator.ts        # Scheduled briefing templates
├── pattern-learner.ts           # Atom creation from feedback
├── focus-mode-tracker.ts        # Sliding-window focus detection
├── data-sources/ (11 adapters)
│   ├── adapter-interface.ts
│   ├── augur-signals-adapter.ts
│   ├── augur-trades-adapter.ts
│   ├── augur-regime-adapter.ts
│   ├── augur-paper-adapter.ts
│   ├── git-adapter.ts
│   ├── fleet-adapter.ts
│   ├── octoprint-adapter.ts
│   ├── pipeline-adapter.ts
│   ├── cortex-session-adapter.ts
│   └── cortex-atoms-adapter.ts
└── __tests__/ (8 test files, 102 tests)
python/
└── predict_manager.py           # PredictManager: brain.db CRUD for all 3 tables
```

### Modified Files (4 files)

| File                   | Change                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `python/brain.py`      | Migration v5: 3 new tables + 8 indexes                                                                            |
| `cortex-bridge.ts`     | 9 new PredictBridgeMethods                                                                                        |
| `index.ts`             | `cortex_predict` tool, PollingEngine lifecycle, FocusModeTracker tick, preamble flush, `predictive_intent` config |
| `openclaw.plugin.json` | `predictive_intent` config block                                                                                  |

---

## Test Results

| Test File                    | Tests   | Result              |
| ---------------------------- | ------- | ------------------- |
| `focus-mode-tracker.test.ts` | 5       | ✅ PASS             |
| `urgency-scorer.test.ts`     | 20      | ✅ PASS             |
| `insight-generator.test.ts`  | 30      | ✅ PASS             |
| `delivery-router.test.ts`    | 10      | ✅ PASS             |
| `feedback-tracker.test.ts`   | 10      | ✅ PASS             |
| `briefing-generator.test.ts` | 9       | ✅ PASS             |
| `polling-engine.test.ts`     | 11      | ✅ PASS             |
| `pattern-learner.test.ts`    | 7       | ✅ PASS             |
| **TOTAL**                    | **102** | **✅ 102/102 PASS** |

TypeScript compilation: `pnpm tsc --noEmit` → exit code 0 (clean)

---

## Security Sign-Off

**Result**: ✅ APPROVED — 0 CRITICAL (after remediation)

| ID           | Severity     | Description                                                           | Status                                                                           |
| ------------ | ------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| SEC-HIGH-001 | HIGH → FIXED | fleet-adapter.ts shell injection: unvalidated hostname in SSH command | Remediated in test stage — hostname regex `/^[a-zA-Z0-9._-]+$/` + `--` separator |
| SEC-MED-002  | MEDIUM       | Signal rate limit configurable below 30s minimum guard                | Mitigated — 30s hard floor in DeliveryRouter regardless of config                |
| SEC-LOW-003  | LOW          | OctoPrint secrets absence logs path to stderr                         | Acceptable — local dev only                                                      |

---

## Breaking Changes

**None.** All changes additive. `predictive_intent.enabled: false` (or absent from config) = zero behavior change. brain.db migration is idempotent.

---

## Behavioral Signatures (for forensics)

**Normal operation log patterns:**

```
[predict] PollingEngine started — 10 adapters registered
[predict] poll cycle: augur.signals → 1 insight generated (anomaly, urgency=high)
[predict] insight delivered: signal=augur.signals:anomaly urgency=high channel=in_session
[predict] feedback recorded: insight_id=<uuid> acted_on=true action_type=implicit latency_ms=8432
[predict] pattern atom created: source=augur.signals type=anomaly rate=0.42 observations=5
```

**Failure signatures:**

```
[predict] adapter error: fleet.health — ETIMEDOUT — skipping cycle    (graceful degradation)
[predict] signal rate limit hit: source=augur.signals — deferred to batch    (rate limiting)
[predict] briefing suppressed: morning — last=2026-02-18T06:12:00Z    (suppression window)
```

---

## Known Issues / Deferred to v2.1.1

- `cortex stats` Python extension (`predictive_intent_status` section) deferred — `cortex_predict` tool provides equivalent query capability
- `cortex.atoms` adapter uses bridge call rather than tool call; direct atom DB access pending refactor
- Pre-sleep brief 15-min idle timer needs runaway protection if gateway stays running overnight with no active sessions

---

## Deployment Notes

No manual steps required. The 3 new brain.db tables are created automatically on next startup. OctoPrint monitoring requires `~/.secrets/octoprint.env` with `OCTOPRINT_API_KEY=<key>` (chmod 600); adapter silently skips if absent.

**Optional config** (all defaults are sensible — see design.md §12 for full schema):

```json
{
  "predictive_intent": {
    "enabled": true,
    "debug": false
  }
}
```

---

## Pipeline Artifacts

| Stage        | Artifact                                                               |
| ------------ | ---------------------------------------------------------------------- |
| Requirements | `pipeline/task-005-predictive-intent/requirements.md`                  |
| Design       | `pipeline/task-005-predictive-intent/design.md`                        |
| Document     | `pipeline/task-005-predictive-intent/document.md`                      |
| Build        | `pipeline/task-005-predictive-intent/build-report.md`                  |
| Security     | `pipeline/task-005-predictive-intent/security-review.md`               |
| Test         | `pipeline/task-005-predictive-intent/test-report.md`                   |
| **Deploy**   | **`pipeline/task-005-predictive-intent/release-notes.md`** ← this file |

---

## What's Next

**Phase 5.2 — Self-Healing Infrastructure** (task-006-self-healing queued)  
Predictive Intent now surfaces fleet + pipeline anomalies proactively. Self-Healing will close the loop: automated recovery actions triggered by Insight records with `type=anomaly` and `urgency=high|critical`. Pattern atoms from PatternLearner become the training signal for which anomalies warrant auto-remediation vs. human escalation.

---

_Released by LBF Automated Development Pipeline — Orchestrator (Deploy Stage)_  
_Cortex v2.1.0 | 2026-02-18 17:14 EST | cortex-v2.1.0 @ a1e357f90_
