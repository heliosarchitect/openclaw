# Release Notes: Bridge SQL Hardening — task-017

**Task ID:** task-017-bridge-sql-hardening  
**Stage:** done  
**Cortex Version Released:** v2.7.5 (patch series v2.7.1–v2.7.5)  
**Completed:** 2026-02-19T15:10:00-05:00  
**Commit:** bf1be6602

---

## Summary

Task-017 completes the validation pipeline for FINDING-001 (High) — the SQL injection vulnerability via backslash-quote bypass in `cortex-bridge.ts`. The fix itself was shipped in v2.7.2 (commit `3f25091b4`); this task adds the full 7-stage validation audit trail: requirements → design → document → build → security → test → deploy.

No new production code is released. All deliverables are test infrastructure and documentation.

---

## What Changed

### New: SQL Hardening Test Suite (20 tests)

**File:** `extensions/cortex/__tests__/sql-hardening.test.ts`

- Real Python subprocess execution against hermetic temp SQLite database
- Script integrity tests (spy on `runPython` to validate base64 encoding in generated scripts)
- Injection resistance: single-quote, backslash-quote bypass (FINDING-001), newline, DROP TABLE payload
- Adversarial: multi-statement SQL, 4KB stress test, Unicode params
- Static source analysis: guards against reintroduction of `.replace(/'/)` escape patterns

### Updated: CHANGELOG.md

- v2.7.5 section added with full security findings log
- v2.7.1–v2.7.4 backfilled from git log

---

## Security Status

| Finding                                                   | Severity | Status                                               |
| --------------------------------------------------------- | -------- | ---------------------------------------------------- |
| FINDING-001: Backslash-quote SQL injection bypass         | High     | ✅ Mitigated (v2.7.2) + validated (v2.7.5, task-017) |
| FINDING-002: Non-SQL runPython callers use JSON.stringify | Medium   | 🔵 Track → task-018                                  |
| OBS-001: memoryId interpolated without encoding           | Low      | 🔵 Track → task-018                                  |
| OBS-002: Concurrent SQLite access lock reliability        | Low      | 🔵 Track                                             |

---

## Test Metrics

| Metric                          | Value          |
| ------------------------------- | -------------- |
| SQL hardening tests             | 20/20 PASS     |
| Acceptance criteria satisfied   | 15/15          |
| TypeScript compilation          | ✅ Exit 0      |
| Regressions introduced          | 0              |
| Pre-existing unrelated failures | 10 (unchanged) |

---

## Pipeline Stages

| Stage        | Status          | Date                 |
| ------------ | --------------- | -------------------- |
| requirements | ✅ PASS         | 2026-02-19           |
| design       | ✅ PASS         | 2026-02-19           |
| document     | ✅ PASS         | 2026-02-19           |
| build        | ✅ PASS         | 2026-02-19T09:10     |
| security     | ✅ PASS         | 2026-02-19T09:15     |
| test         | ✅ PASS         | 2026-02-19T15:01     |
| deploy       | ✅ PASS         | 2026-02-19T15:04     |
| **done**     | **✅ COMPLETE** | **2026-02-19T15:10** |

---

## Follow-On

- **task-018:** Systematic base64 migration for non-SQL `runPython()` callers (FINDING-002 + OBS-001)

---

_task-017-bridge-sql-hardening complete._
