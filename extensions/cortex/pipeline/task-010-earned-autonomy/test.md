# Task-010: Earned Autonomy — Test Report

**Stage:** test | **Status:** pass
**Phase:** 5.6 | **Date:** 2026-02-19
**Author:** Pipeline Test Specialist

---

## Test Summary

**85 tests across 9 test files — all passing** (282ms total)

| Test Suite                  | Tests  | Status          | Type             |
| --------------------------- | ------ | --------------- | ---------------- |
| classifier.test.ts          | 20     | ✅ pass         | Unit             |
| gate.test.ts                | 9      | ✅ pass         | Unit/Integration |
| score-updater.test.ts       | 9      | ✅ pass         | Unit             |
| outcome-collector.test.ts   | 7      | ✅ pass         | Unit/Integration |
| migration.test.ts           | 8      | ✅ pass         | Integration      |
| milestone-detector.test.ts  | 9      | ✅ pass         | Unit/Integration |
| override-manager.test.ts    | 10     | ✅ pass         | Integration      |
| reporter.test.ts            | 7      | ✅ pass         | Integration      |
| e2e-trust-lifecycle.test.ts | 8      | ✅ pass         | E2E              |
| **Total**                   | **85** | **✅ all pass** |                  |

## New Test Coverage (40 tests added)

### Migration Tests (8 tests)

- Creates all 6 required tables
- Bootstraps trust_scores for all 18 known categories
- Sets correct initial scores per tier (0.75/0.65/0.55/0.0)
- Idempotent — running twice doesn't duplicate rows
- Creates all expected indexes (5 indexes verified)
- Enforces risk_tier CHECK constraint (rejects tier 5)
- Enforces gate_decision CHECK constraint (rejects 'invalid')
- Enforces trust_scores range constraint [0.0, 1.0]

### MilestoneDetector Tests (9 tests)

- Detects first_auto_approve on initial threshold crossing
- Detects tier_promotion on subsequent threshold crossings
- Detects tier_demotion on downward threshold crossing
- Detects blocked on downward floor crossing
- Emits both demotion + blocked when score drops through both boundaries
- Emits nothing when score changes within same zone
- Persists milestones to database
- recordOverrideMilestone stores override grant milestones
- (Milestone records verified in SQLite)

### OverrideManager Tests (10 tests)

- Grants an override (type, category, active, granted_by verified)
- Revokes an override
- Deactivates previous override when setting new one for same category
- revokeAll deactivates all active overrides (returns count)
- listActive returns only active non-expired overrides
- Supports expiry duration parsing ("4h" → ~4h from now)
- Rejects invalid duration format ("4x" → error)
- Creates milestone on grant
- Creates milestone on revoke

### Reporter Tests (7 tests)

- generateReport contains all 18 known categories
- generateReport contains all 4 tier headers
- generateReport shows correct status for default scores (auto-approve/pause/blocked/hardcap)
- generateReport shows active overrides with reason
- generateReport shows [none] when no overrides
- generateWeeklySummary returns valid structure
- generateWeeklySummary includes recent milestones

### E2E Trust Lifecycle Tests (8 tests)

- Pass decisions accumulate and raise trust score via EWMA
- Corrections (corrected_significant) lower trust score
- Enough pass outcomes promote write_file past threshold (0.65 → ≥0.70, gate transitions pause→pass)
- Override grant + revoke lifecycle (pause → pass via grant → pause after revokeAll)
- Decision count increments correctly in decision_log
- Reporter works after real gate activity (decision count reflected)
- tool_error_external has negligible score impact (< 0.03 delta)
- Tier 4 financial never auto-approves even after 50 pass outcomes (alpha=0, score stays 0.0)

## Key Findings

1. **Tier 3 initial scores (0.55) are below floor (0.60)**: All Tier 3 categories start in "blocked" state, not "pause". This is by design (conservative) but means Tier 3 actions will be blocked until Matthew explicitly grants overrides or the bootstrap scores are adjusted. Documented in reporter test.

2. **EWMA convergence verified**: 20 consecutive pass outcomes for write_file (alpha=0.10) are sufficient to cross the 0.70 threshold from initial 0.65.

3. **Tier 4 hardcap verified**: 50 consecutive pass resolutions with alpha=0.00 correctly leaves score at 0.0 — financial actions can never be auto-approved.

4. **Schema constraints working**: All CHECK constraints (risk_tier range, gate_decision enum, score bounds) correctly reject invalid data.

## Security Test Alignment

Tests validate all security-critical behaviors identified in the security review:

- ✅ Tier 4 hardcap cannot be bypassed via score accumulation
- ✅ Override grant/revoke lifecycle is consistent
- ✅ Decision logging captures every gate check
- ✅ Score bounds enforced at DB level [0.0, 1.0]
- ✅ Migration is idempotent (safe to re-run)

## Run Command

```bash
cd ~/Projects/helios && npx vitest run extensions/cortex/trust/__tests__/
```
