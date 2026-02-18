# Test Report — task-005-predictive-intent

**Stage:** test  
**Date:** 2026-02-18  
**Result:** ✅ PASS  
**Branch:** feature/predictive-intent-v2.1.0

## Summary

102/102 tests passed across 8 test files. TypeScript compilation clean (`pnpm tsc --noEmit` exit 0). Security HIGH finding (SEC-HIGH-001: shell injection in fleet-adapter.ts) remediated during test stage.

## Test Files

| File                         | Tests | Status  |
| ---------------------------- | ----- | ------- |
| `focus-mode-tracker.test.ts` | 5     | ✅ PASS |
| `urgency-scorer.test.ts`     | 20    | ✅ PASS |
| `insight-generator.test.ts`  | 30    | ✅ PASS |
| `delivery-router.test.ts`    | 10    | ✅ PASS |
| `feedback-tracker.test.ts`   | 10    | ✅ PASS |
| `briefing-generator.test.ts` | 9     | ✅ PASS |
| `polling-engine.test.ts`     | 11    | ✅ PASS |
| `pattern-learner.test.ts`    | 7     | ✅ PASS |

## Coverage by Module

### FocusModeTracker (5 tests)

- Initial state (inactive, 0 count)
- Activation after minCalls within window
- Deactivation when timestamps expire outside window
- Custom configure(windowMs, minCalls)
- Timestamp pruning on tick

### UrgencyScorer (20 tests)

- `computeTimeSensitivity`: null expiry (0.0), expired (1.0), ≤15min (1.0), ≥24h (0.0), mid-range interpolation
- `computeCrossSourceConfirmation`: empty sources, self-only, all fresh (1.0), unavailable excluded, mixed staleness (fractional)
- `assignChannel`: all 4 tiers × focus/no-focus (critical→signal always, high→in_session/synapse, medium→in_session/preamble, low→preamble always)
- `scoreInsight`: weighted formula (0.4+0.3+0.2+0.1=1.0), all-zero→low, high threshold, score clamping [0,1], state set to 'scored', focus mode routing

### InsightGenerator (30 tests)

- **augur.signals** (5): stale anomaly, new signal opportunity, unchanged signal skip, unavailable source, dedup within window
- **augur.trades** (3): loss streak anomaly, high PnL alert, low streak no-op
- **augur.regime** (2): regime change anomaly, no change no-op
- **augur.paper** (1): paper loss streak anomaly
- **fleet.health** (2): unreachable alert, all reachable no-op
- **git.activity** (2): commit briefing with repo summary, zero commits no-op
- **octoprint.jobs** (3): print complete alert, error anomaly, milestone briefing
- **pipeline.state** (3): stuck anomaly, failed alert, completion briefing
- **cortex.session** (2): pending task reminder, empty tasks no-op
- **cortex.atoms** (2): pattern insight, empty patterns no-op
- **Cross-cutting** (5): unknown source empty, handler error caught, valid UUIDs, title ≤80, body ≤500

### DeliveryRouter (10 tests)

- Signal routing to sendSignalFn
- Synapse routing to sendSynapseFn
- Preamble batching
- Batch flush returns + clears
- Signal rate limiting per source (5min)
- Different sources bypass each other's rate limit
- Focus mode defers to batch
- formatInsight uppercase urgency
- formatBatch empty/multi

### FeedbackTracker (10 tests)

- Implicit action via keyword match in tool args
- No match → no feedback
- Outside action window → ignored
- Already acted_on → no double-act
- Explicit acknowledgment phrase detection
- Non-ack text ignored
- Expire unacted → ignored feedback
- Rate increase on acted_on (+0.1)
- Rate decrease on ignored (-0.05)
- Rate halving trigger (below threshold with ≥20 observations)

### BriefingGenerator (9 tests)

- Morning brief during morning hours
- Returns null outside morning window
- Suppresses duplicate morning brief
- Returns null with no readings
- Pre-sleep: returns null when active
- Pre-sleep: generates after idle threshold
- Pre-sleep: suppresses duplicate
- Pipeline brief: low urgency on pass
- Pipeline brief: high urgency + actionable on fail

### PollingEngine (11 tests)

- Adapter registration + count
- Queued insight recovery on start
- First poll on start + reading stored
- Skips adapters with poll_interval_ms ≤ 0
- On-demand pollSource
- getRelevantInsights keyword filter
- queryInsights structured response
- queryInsights urgency_min filter
- queryInsights source filter
- Stop clears all timers
- Adapter poll error → graceful degradation

### PatternLearner (7 tests)

- Creates atom with ≥3 observations + rate ≥ 0.3
- Skips when existing atom found
- Skips when < 3 observations
- Skips when action rate < 0.3
- Skips non-acted-on feedback
- Skips when no atomCreate function
- Bridge errors → graceful degradation

## Security Fix Applied

**SEC-HIGH-001** (fleet-adapter.ts shell injection): Added hostname regex validation (`/^[a-zA-Z0-9._-]+$/`) and `--` end-of-options separator before host argument in SSH command.

## TypeScript Compilation

```
$ pnpm tsc --noEmit
(exit code 0 — clean)
```

## Existing Test Suite Compatibility

All pre-existing cortex extension tests remain unaffected (session, hooks modules not modified by predictive intent test files).
