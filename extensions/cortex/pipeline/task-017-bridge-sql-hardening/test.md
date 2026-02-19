# Test Report: Bridge SQL Hardening — Base64 Parameter Passing

**Task ID:** task-017-bridge-sql-hardening  
**Stage:** test  
**Status:** PASS  
**Date:** 2026-02-19T15:01:00-05:00  
**Tester:** Claude Code (pipeline test specialist)  
**Cortex Version:** v2.7.5 (fix shipped in v2.7.2, commit 3f25091b4)

---

## 1. Executive Summary

All 20 SQL hardening tests pass. TypeScript compiles clean. Security review confirmed PASS with no blockers. The 10 failures in the full suite are pre-existing and unrelated to this change (3 files in `src/pairing/`, `src/cli/`, `src/agents/`, `src/browser/`, plus 5 adversarial suite infrastructure failures). **Verdict: PASS.**

---

## 2. SQL Hardening Test Results

**Command:** `npx vitest run extensions/cortex/__tests__/sql-hardening.test.ts` (from repo root)

```
✓ extensions/cortex/__tests__/sql-hardening.test.ts (20 tests) 452ms

 Test Files  1 passed (1)
      Tests  20 passed (20)
   Start at  15:01:32
   Duration  692ms (transform 156ms, setup 127ms, import 34ms, tests 452ms, environment 0ms)
```

**Result:** ✅ 20/20 PASS

### Note on test invocation

The test file lives at `extensions/cortex/__tests__/sql-hardening.test.ts`. The vitest config includes `extensions/**/*.test.ts` which matches this path. The test must be run from the **repo root** (`~/Projects/helios`), not from `extensions/cortex/` directly, as the vitest config is at the repo root.

---

## 3. Full Test Suite Results

**Command:** `npx vitest run` (from repo root)

```
 Test Files  10 failed | 850 passed (860)
      Tests  10 failed | 7286 passed | 1 skipped (7297)
   Duration  38.69s
```

### Failing files (all pre-existing, unrelated to task-017):

| File                                                                    | Tests | Failures | Root cause                                      |
| ----------------------------------------------------------------------- | ----- | -------- | ----------------------------------------------- |
| `extensions/cortex/adversarial/suites/memory-poisoning.test.ts`         | 0     | infra    | Adversarial runner infrastructure failure       |
| `extensions/cortex/adversarial/suites/pipeline-corruption.test.ts`      | 0     | infra    | Adversarial runner infrastructure failure       |
| `extensions/cortex/adversarial/suites/tool-faults.test.ts`              | 0     | infra    | Adversarial runner infrastructure failure       |
| `extensions/cortex/adversarial/suites/synapse-adversarial.test.ts`      | 0     | infra    | Adversarial runner infrastructure failure       |
| `extensions/cortex/adversarial/suites/prompt-injection.test.ts`         | 0     | infra    | Adversarial runner infrastructure failure       |
| `src/pairing/setup-code.test.ts`                                        | 6     | 2        | Token hashing change (commit `03a18f65a`)       |
| `src/cli/qr-cli.test.ts`                                                | 7     | 3        | QR/remote URL flow change (commit `03a18f65a`)  |
| `src/gateway/server-runtime-config.test.ts`                             | 5     | 1        | Related to same CLI/Gateway refactor            |
| `src/agents/model-catalog.test.ts`                                      | 3     | 3        | codex-spark model handling (commit `33ebffb2b`) |
| `src/browser/server.post-tabs-open-profile-unknown-returns-404.test.ts` | 2     | 1        | Browser server test (pre-existing)              |

**Assessment:** None of these failures touch `extensions/cortex/__tests__/`, `extensions/cortex/src/cortex-bridge.ts`, or any SQL-related code paths. They are pre-existing failures from unrelated changes to CLI/Gateway/Agents code introduced after the SQL hardening fix was shipped. **Not regressions from task-017.**

---

## 4. TypeScript Compilation

**Command:** `npx tsc --noEmit` (from repo root)

```
EXIT: 0
(no errors)
```

**Result:** ✅ Clean compilation — no type errors.

---

## 5. Security Review Verification

**File:** `pipeline/task-017-bridge-sql-hardening/security.md`  
**Status:** PASS  
**Date:** 2026-02-19T09:15:00-05:00

Key findings:

- **FINDING-001 (High):** ✅ Fully mitigated — base64 encoding fix confirmed in `runSQL`, `getSQL`, `allSQL`
- **FINDING-002 (Medium):** 🔵 New/tracked — non-SQL runPython callers, task-018 scope. Non-blocking.
- **OBS-001 (Low):** 🔵 `memoryId` interpolation in `editSTM`/`updateSTM` — low risk, task-018 scope
- **OBS-002 (Low):** 🔵 Concurrent SQLite lock reliability concern — reliability only, not security

**No blockers. Security verdict: PASS.**

---

## 6. Acceptance Criteria Verification

| AC     | Description                          | Test                                    | Result |
| ------ | ------------------------------------ | --------------------------------------- | ------ |
| AC-001 | DDL execution via base64             | Real subprocess, CREATE TABLE           | ✅     |
| AC-002 | DML with params via base64           | Real subprocess, INSERT ? params        | ✅     |
| AC-003 | getSQL row/null                      | Real subprocess, SELECT + no-match      | ✅     |
| AC-004 | allSQL array/empty                   | Real subprocess, multi-row + empty      | ✅     |
| AC-005 | Params not interpolated directly     | Script integrity spy                    | ✅     |
| AC-006 | Single-quote in SQL                  | Real subprocess                         | ✅     |
| AC-007 | Backslash-quote bypass (FINDING-001) | Real subprocess                         | ✅     |
| AC-008 | Newline in SQL                       | Real subprocess                         | ✅     |
| AC-009 | Backslash in params                  | Real subprocess                         | ✅     |
| AC-010 | DROP TABLE injection payload         | Real subprocess, table survives         | ✅     |
| AC-011 | No .replace escaping in source       | Static grep of source file              | ✅     |
| AC-012 | Buffer.from base64 present           | Script integrity spy                    | ✅     |
| AC-013 | Params JSON+base64 encoded           | Script integrity spy                    | ✅     |
| AC-014 | Python base64.b64decode present      | Script integrity spy                    | ✅     |
| AC-015 | Parameterised queries work           | Implicit: correct results from ? params | ✅     |

**15/15 acceptance criteria satisfied.**

---

## 7. Behavioral Signature (Version Forensics)

**Healthy state patterns:**

```
✓ extensions/cortex/__tests__/sql-hardening.test.ts (20 tests) — all pass
# TypeScript: exit 0, no errors
# grep "\.replace.*'" cortex-bridge.ts → 0 results in SQL methods
```

**Regression indicator:**

```
✗ backslash-quote bypass does not break Python execution (FINDING-001)
Error: Python subprocess exited with code 1
SyntaxError: EOL while scanning string literal
```

---

## 8. Verdict

| Check                                | Result                |
| ------------------------------------ | --------------------- |
| SQL hardening tests (20)             | ✅ PASS               |
| TypeScript compilation               | ✅ PASS               |
| Security review                      | ✅ PASS (no blockers) |
| All 15 ACs satisfied                 | ✅ PASS               |
| Full suite regressions from task-017 | ✅ None               |

**STAGE: test → PASS**  
Safe to proceed to validate stage.

---

_Test report complete._
