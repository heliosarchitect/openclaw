# Security Review: Bridge SQL Hardening — Eliminate FINDING-001 Injection Vector

**Task ID:** task-017-bridge-sql-hardening  
**Stage:** security  
**Status:** PASS  
**Date:** 2026-02-19T09:15:00-05:00  
**Reviewer:** Claude Code (pipeline security specialist)  
**Cortex Version:** 2.7.5 (fix shipped in 2.7.2, commit 3f25091b4)

---

## 1. Executive Summary

FINDING-001 (High) is **fully mitigated**. The base64-encoding fix in `runSQL`, `getSQL`, and `allSQL` is architecturally sound: no raw SQL or parameter data reaches the Python script as an interpolated string literal. The fix was shipped in v2.7.2 (commit `3f25091b4`) and validated by 20 new tests covering all 15 acceptance criteria. No regressions.

Two low-severity observations are noted for adjacent code patterns. One medium-severity finding is flagged for a follow-on task. Neither blocks this task.

**Verdict: PASS** — safe to proceed to next stage (test).

---

## 2. Scope

This review covers:

1. Correctness of the FINDING-001 fix in `cortex-bridge.ts` (`runSQL`, `getSQL`, `allSQL`, lines 1126–1176)
2. Adequacy of the test suite added in the build stage (`__tests__/sql-hardening.test.ts`)
3. Adjacent Python script interpolation patterns in `cortex-bridge.ts` — potential follow-on risk
4. Trust boundary and subprocess execution model

Out of scope:

- FINDING-002 (auto-approval whitelist) — tracked separately
- FINDING-003 (git-adapter live test) — tracked separately
- Python scripts in `python/` directory (reviewed in task-016)

---

## 3. FINDING-001 Fix Verification ✅

### 3.1 Pre-Fix Pattern (Removed)

Task-016 documented the vulnerable pattern at lines 1127–1130 (pre-v2.7.2):

```typescript
// VULNERABLE (removed in v2.7.2)
const escapedSql = sql.replace(/'/g, "\\'").replace(/\n/g, " ");
const paramsJson = JSON.stringify(params ?? []).replace(/'/g, "\\'");
```

**Bypass:** Input `\'` → escaped to `\\'` → Python interprets as `\` + end of string → `SyntaxError`. The backslash-quote sequence broke out of the Python single-quoted string literal, satisfying FINDING-001.

### 3.2 Post-Fix Pattern (Current Implementation)

```typescript
// SECURE (v2.7.2+)
const sqlB64 = Buffer.from(sql).toString("base64");
const paramsB64 = Buffer.from(JSON.stringify(params ?? [])).toString("base64");
```

Embedded in Python script as:

```python
sql = base64.b64decode('${sqlB64}').decode()
params = json.loads(base64.b64decode('${paramsB64}').decode())
db.execute(sql, params)
```

### 3.3 Correctness Analysis

| Property                            | Assessment                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Base64 alphabet is `[A-Za-z0-9+/=]` | ✅ No `'`, `\`, `"`, or control chars — safe in Python single-quoted string      |
| SQL decoded by Python before use    | ✅ Python receives raw SQL string; no second escaping layer                      |
| Params JSON-decoded by Python       | ✅ `json.loads()` correctly handles all JSON types                               |
| SQLite parameterised queries        | ✅ `db.execute(sql, params)` — SQLite handles binding, no injection surface      |
| Null params default                 | ✅ `params ?? []` — no crash on undefined params                                 |
| UTF-8 encoding                      | ✅ `Buffer.from(sql)` uses UTF-8 by default; `.decode()` in Python is also UTF-8 |

**Old escape-based patterns:** `grep -n ".replace.*'" cortex-bridge.ts` returns **zero results** in the SQL methods. Confirmed clean.

### 3.4 Static Verification

AC-011 test (`sql-hardening.test.ts`) greps the source file for old escape patterns:

```typescript
expect(src).not.toMatch(/\.replace\(\/'\//);
```

This is a **regression guard** — any reintroduction of the old pattern breaks the test suite automatically. No behavioral changes required; the static check runs in CI on every commit.

---

## 4. Test Suite Adequacy ✅

### 4.1 Coverage Assessment

| Acceptance Criteria                     | Test Approach                            | Status |
| --------------------------------------- | ---------------------------------------- | ------ |
| AC-001: DDL execution                   | Real subprocess, CREATE TABLE            | ✅     |
| AC-002: DML with params                 | Real subprocess, INSERT ? params         | ✅     |
| AC-003: getSQL row/null                 | Real subprocess, SELECT + no-match       | ✅     |
| AC-004: allSQL array/[]                 | Real subprocess, multi-row + empty       | ✅     |
| AC-005: params not interpolated         | Script integrity spy (no subprocess)     | ✅     |
| AC-006: single-quote in SQL             | Real subprocess                          | ✅     |
| AC-007: backslash-quote bypass          | Real subprocess (FINDING-001 regression) | ✅     |
| AC-008: newline in SQL                  | Real subprocess                          | ✅     |
| AC-009: backslash in params             | Real subprocess                          | ✅     |
| AC-010: DROP TABLE injection payload    | Real subprocess, table survives          | ✅     |
| AC-011: no .replace escaping            | Static grep of source file               | ✅     |
| AC-012: Buffer.from base64 present      | Script integrity spy                     | ✅     |
| AC-013: params JSON+base64 encoded      | Script integrity spy                     | ✅     |
| AC-014: Python base64.b64decode present | Script integrity spy                     | ✅     |
| AC-015: parameterised queries work      | Implicit: correct result from ? params   | ✅     |

All 15 ACs covered. 20 tests, all passing. Existing suite (722 tests) unaffected.

### 4.2 Test Quality Assessment

**Strengths:**

- Real Python subprocess execution (no mocking of the injection surface itself)
- Per-run hermetic temp database in `/tmp/` — no production DB contamination
- Adversarial multi-statement test verifies SQLite's single-statement enforcement
- 4KB stress test validates no subprocess memory cliff
- Script integrity spy catches source-level regressions without subprocess overhead

**Gap (Low):** Test suite does not test concurrent calls to `runSQL`/`getSQL`/`allSQL` from multiple async callsites (race condition on SQLite file lock). Not an injection vector, but a reliability concern. Noted as OBSERVATION-002 below.

---

## 5. Adjacent Risk Assessment

### 5.1 OBSERVATION-001: `memoryId` Interpolated Without Encoding (Low)

**Location:** `editSTM()` (~line 1555) and `updateSTM()` (~line 1573)

```typescript
result = b.edit_stm('${memoryId}', ${contentJson})
result = b.update_stm('${memoryId}', importance=${impArg}, categories=${catArg})
```

`memoryId` is interpolated directly into a Python single-quoted string without base64 encoding.

**Risk assessment:** Low. Memory IDs are generated internally with a controlled format:

```typescript
const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
// Example: mem-1708350000000-k3f2x9
```

The format is `[a-z0-9-]+` — no single quotes, backslashes, or whitespace possible. No external user input flows to `memoryId` in the current call graph. The injection risk is theoretical only.

**Recommendation:** Apply base64 encoding to `memoryId` in `editSTM()` and `updateSTM()` as defence-in-depth, especially if the ID format ever changes. Low-priority hardening in task-018 scope.

**Blocking:** ❌ No

---

### 5.2 OBSERVATION-002: JSON.stringify Interpolation in Non-SQL Scripts (Low)

**Location:** Multiple methods (`addToSTM`, `getRecentSTM`, `searchSTM`, `addToAtoms`, etc.) at lines 1213, 1247, 1287–1291, 1395–1399, 1673–1675.

Example:

```typescript
result = add_to_stm(${JSON.stringify(content)}, categories=${categoriesJson}, importance=${importance})
```

`JSON.stringify()` produces double-quoted, properly-escaped JSON strings embedded directly in Python script strings.

**Risk assessment:** Low. JSON.stringify handles primary escape cases (`"`, `\`, `\n`, `\r`, `\t`). The resulting Python expression is syntactically valid for the vast majority of inputs. Notable edge case: `\uXXXX` sequences in JSON output are valid JSON but may generate Python 3.12+ DeprecationWarning for unrecognized escape sequences in Python string literals. Not exploitable, but a latent compatibility concern.

**Recommendation:** Phase-2 hardening — migrate non-SQL Python scripts to base64 pattern to achieve uniform and provably-safe encoding across all `runPython()` callers. Track as task-018 scope.

**Blocking:** ❌ No

---

### FINDING-002 (Medium): Systematic Base64 Migration for Non-SQL Python Scripts

**Severity:** Medium  
**Status:** New finding — follow-on task required  
**Scope:** ~15 `runPython()` call sites in `cortex-bridge.ts` that interpolate user-provided string data via `JSON.stringify()`

**Description:** The base64 fix applied to the three SQL methods creates a partial inconsistency: SQL operations use provably-safe base64 encoding, while STM/atom/synapse operations use `JSON.stringify()` interpolation which is safer-but-not-provably-safe. Comprehensive hardening would apply base64 encoding to all data values passed into inline Python scripts.

**Recommendation:** Create task-018 to migrate all `runPython()` data-bearing call sites to base64 encoding. This eliminates the entire class of Python template injection vulnerabilities rather than addressing individual instances.

**Blocking:** ❌ No (not a regression; risk is low for current usage patterns)

---

## 6. Trust Boundary Review

### 6.1 Subprocess Invocation Model

```typescript
spawn(this.pythonPath, ["-c", code], {
  env: { ...process.env, PYTHONPATH: this.pythonScriptsDir, CORTEX_DATA_DIR: this.memoryDir },
});
```

| Property                                | Assessment                                              |
| --------------------------------------- | ------------------------------------------------------- |
| `spawn` not `exec`                      | ✅ No shell metacharacter expansion (no `sh -c`)        |
| `pythonPath` from constructor options   | ✅ Not user-controllable in live deployment             |
| `pythonScriptsDir` from filesystem path | ✅ Hardcoded to extension install directory             |
| `CORTEX_DATA_DIR` via env, not CLI arg  | ✅ No path injection via command line                   |
| Base64 values in Python string literals | ✅ Base64 alphabet safe in single-quoted Python strings |
| No `shell: true` in spawn options       | ✅ Confirmed — spawn options do not set `shell: true`   |

### 6.2 SQLite Connection Management

Each `runSQL`/`getSQL`/`allSQL` call opens a new SQLite connection and closes it after use. No connection pool.

**Assessment:** Safe from connection-leak vulnerabilities. The `db.close()` call is unconditional (not in a try/finally), meaning an exception before `db.close()` could leave the connection open until Python GC. SQLite handles this gracefully, but transient "database is locked" errors are possible under high concurrency. Not a security issue — reliability concern only.

### 6.3 CORTEX_DATA_DIR Trust

`memoryDir` defaults to `~/.openclaw/workspace/memory`. If a hostile value were injected via compromised config, it could redirect brain.db reads/writes to an attacker-controlled path. Current threat model: fully internal system with no external control over `memoryDir`. No change needed.

---

## 7. Changelog Verification

**Status:** Entry absent from CHANGELOG.md — must be added before deploy stage.

Required entry (for `[2.7.2]` or `[Unreleased]` section):

```markdown
### Security

- **FINDING-001 (High/mitigated):** Replaced naive single-quote escaping in `runSQL`, `getSQL`,
  and `allSQL` with base64-encoded parameter passing. SQL strings and params are now base64-encoded
  in TypeScript before embedding in the Python subprocess template. Python decodes both values
  before execution. Eliminates the backslash-quote bypass (`\'` → `\\'`) that could break out of
  the Python string literal. All values reach `db.execute(sql, params)` safely decoded.
  (commit 3f25091b4)
- **Test coverage added:** 20 injection resistance tests in `__tests__/sql-hardening.test.ts`
  covering AC-006 through AC-015. (task-017)
```

This entry will be added now as part of the security stage deliverable.

---

## 8. Regression Analysis

| Test category                             | Before (v2.7.1)                 | After (v2.7.5) |
| ----------------------------------------- | ------------------------------- | -------------- |
| Existing cortex-bridge tests              | 722 passing                     | 722 passing ✅ |
| New SQL hardening tests                   | N/A                             | 20 passing ✅  |
| FINDING-001 regression case (`\'` bypass) | Would fail (Python SyntaxError) | Passes ✅      |
| Script integrity (no .replace escaping)   | N/A                             | Passes ✅      |

---

## 9. Findings Summary

| ID          | Severity | Status         | Description                                                                      |
| ----------- | -------- | -------------- | -------------------------------------------------------------------------------- |
| FINDING-001 | High     | ✅ Mitigated   | SQL injection via backslash-quote bypass — fixed in v2.7.2 via base64 encoding   |
| FINDING-002 | Medium   | 🔵 New / Track | Non-SQL runPython callers use JSON.stringify interpolation — migrate in task-018 |
| OBS-001     | Low      | 🔵 Track       | `memoryId` interpolated without encoding in editSTM/updateSTM                    |
| OBS-002     | Low      | 🔵 Track       | Concurrent SQLite access may cause transient lock errors under high load         |

---

## 10. Behavioral Signature (Version Forensics)

**Healthy state log patterns:**

```
✓ SQL Hardening — Bridge Base64 Encoding (20 tests) — all pass
# No "SyntaxError" in test output
# No "Python subprocess error" in test output
# grep "\.replace.*'" cortex-bridge.ts → 0 results
```

**Failure mode if FINDING-001 regressed:**

```
✗ backslash-quote bypass does not break Python execution (FINDING-001)
Error: Python subprocess exited with code 1
SyntaxError: EOL while scanning string literal
```

**Rollback plan:**

- This stage adds only documentation (CHANGELOG entry + this report)
- No code changes to roll back
- Fix commit 3f25091b4 is the relevant rollback target if ever needed

---

_Security review complete. Verdict: PASS. Proceeding to test stage._
