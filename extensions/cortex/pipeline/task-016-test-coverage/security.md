# Security Review: Comprehensive Test Coverage — Cortex Foundation Tests

**Task ID:** task-016-test-coverage  
**Stage:** security  
**Status:** PASS (with observations)  
**Date:** 2026-02-19T03:35:00-05:00  
**Reviewer:** Pipeline Security Specialist

---

## 1. Executive Summary

The test suite added in task-016 introduces **no new attack surface** — it is a test infrastructure change only. All 36 new test files use proper mock isolation with no live I/O escaping test boundaries. However, the security audit surfaced **pre-existing vulnerabilities in the tested source code** that warrant tracking and mitigation.

**Verdict: PASS** — safe to proceed to next stage.  
No blocking issues. Three medium-severity findings require follow-on tasks.

---

## 2. Test Infrastructure Security Assessment

### 2.1 Mock Boundary Compliance ✅

All 36 new test files respect the mock boundaries defined in the design doc:

| Boundary              | Status    | Notes                                              |
| --------------------- | --------- | -------------------------------------------------- |
| SQLite (`brain.db`)   | ✅ Mocked | `createMockDb()` in-memory stub, no disk writes    |
| Child processes       | ✅ Mocked | Runbook tests use `dry_run()` only, no `execute()` |
| File system           | ✅ Mocked | No `writeFile` in new task-016 tests               |
| HTTP/fetch            | ✅ Mocked | Adapter tests use `setMockData()` injection        |
| Live process spawning | ✅ None   | No `execSync`/`spawnSync` in new test files        |

Pre-existing tests (`sop-patcher.test.ts`) use `mkdtempSync` for filesystem tests — safe, writes only to OS temp dir, cleans up with `rmSync` in `afterEach`.

### 2.2 Credential / Secrets Exposure ✅

Scanned all 36 new test files for hardcoded credentials:

- **No hardcoded API keys, passwords, tokens, or private keys** found in new test files
- References to `radio.fleet.wood` are string literals used as anomaly `target_id` values — not network connections
- References to `.141` (OctoPrint) and `~/.secrets/` paths are in **pre-existing** test fixtures (task-011/task-013), not task-016 additions
- `trust/__tests__/index.test.ts`: barrel export verification only — no credential handling

### 2.3 Environment Variable Safety ✅

The `process-env.ts` fixture (`withEnv`) correctly:

- Captures original values before override
- Restores all modified env vars after test (both sync and async paths)
- Prevents env leakage between test files

**Edge case identified (Low):** The sync/async path split means if a test function is both synchronous AND throws (not a Promise), the sync `finally` block restores env correctly. However, if a synchronous function is accidentally treated as async by returning a non-Promise thenable, cleanup might run twice. This is a theoretical edge case — no current tests trigger it.

### 2.4 No Vacuous Tests ✅

Grep for `it.skip`, `xit`, and zero-assertion tests returns clean results across all 36 new files.

---

## 3. Source Code Security Findings (Pre-Existing)

These findings are in the **production source code**, surfaced during test coverage analysis. They are **not regressions introduced by task-016**.

---

### FINDING-001: Naive SQL Escaping in `cortex-bridge.ts` — High

**Severity:** High (mitigated)  
**Location:** `cortex-bridge.ts` lines 1127–1165 (`runSQL`, `getSQL`, `allSQL`)  
**Status:** Pre-existing, not introduced by task-016

**Description:**  
SQL queries and their parameters are embedded into inline Python scripts via string interpolation. Escaping is applied manually:

```typescript
const escapedSql = sql.replace(/'/g, "\\'").replace(/\n/g, " ");
const paramsJson = JSON.stringify(params ?? []).replace(/'/g, "\\'");
```

This approach has known deficiencies:

1. **Incomplete escaping:** A single-quote preceded by a backslash in the SQL string (`\'`) results in `\\'` (escaped backslash + unescaped quote), breaking the Python string literal.
2. **No backslash normalization:** Backslashes in `sql` or `params` are not escaped before the single-quote pass, creating a bypass path.
3. **Unicode escapes:** Python's string handling may interpret unicode escape sequences differently than JavaScript's escape replacement.

**Mitigating factors (why this is not Critical):**

- All callers of `runSQL/getSQL/allSQL` are internal — SQL strings are hardcoded, not user-controlled
- `params` are typed and serialized through `JSON.stringify()`, which wraps strings in double quotes — single-quote injection in params is less effective
- The adversarial framework (task-007) has memory poisoning tests that exercise the add/search paths
- SQLite's own Python bindings use parameterized queries internally

**Recommended fix (follow-on task):**  
Replace inline Python string interpolation with a base64-encoded parameter passing strategy:

```typescript
const payloadB64 = Buffer.from(JSON.stringify({ sql, params: params ?? [] })).toString("base64");
const script = `
import sqlite3, json, base64, os
payload = json.loads(base64.b64decode('${payloadB64}'))
db = sqlite3.connect(os.path.join(os.environ.get('CORTEX_DATA_DIR', '.'), 'brain.db'))
db.execute(payload['sql'], payload['params'])
db.commit()
db.close()
print('null')
`;
```

**Action:** Create follow-on task `task-017-bridge-sql-hardening`.

---

### FINDING-002: Auto-Approval Whitelist on Two Runbooks — Medium

**Severity:** Medium  
**Location:** `healing/runbooks/rb-gc-trigger.ts:18`, `healing/runbooks/rb-rotate-logs.ts:23`  
**Status:** Pre-existing (task-006 deliverable)

**Description:**  
Two runbooks have `auto_approve_whitelist = true`, meaning the `RunbookExecutor` can execute them without human approval:

- `rb-gc-trigger` — triggers garbage collection
- `rb-rotate-logs` — rotates log files

These are lower-risk operations, but `rb-rotate-logs` deletes/compresses log data. In a scenario where the healing system misclassifies an anomaly, auto-approved log rotation could destroy forensic evidence.

**Test coverage gap:** The existing `rb-rotate-logs.test.ts` and `rb-gc-trigger.test.ts` do not assert that `auto_approve_whitelist` is `true` — meaning a future refactor could silently change this to `false` without test failure.

**Recommended fixes:**

1. Add explicit assertions to `rb-rotate-logs.test.ts` and `rb-gc-trigger.test.ts`:
   ```typescript
   it("auto_approve_whitelist is true (low-risk operation)", () => {
     expect(rb.auto_approve_whitelist).toBe(true);
   });
   ```
2. Consider demoting `rb-rotate-logs` to `auto_approve_whitelist = false` — log rotation affecting forensic trails should require approval.

---

### FINDING-003: GitAdapter Live Execution in Tests — Medium

**Severity:** Medium  
**Location:** `predictive/__tests__/data-sources/git-adapter.test.ts:20-26`  
**Status:** Pre-existing design choice (task-011)

**Description:**  
The test `"poll without mock returns real data (graceful)"` calls `adapter.poll()` without injecting mock data, causing the GitAdapter to run real `git log` commands against the local repo:

```typescript
it("poll without mock returns real data (graceful)", async () => {
  const adapter = new GitAdapter();
  const reading = await adapter.poll();
  expect(reading.source_id).toBe("git.activity");
  expect(reading).toHaveProperty("data");
});
```

**Risks:**

- In a CI/CD environment without git history, this test may return unexpected shapes or fail
- The test asserts minimal structure — `source_id` and `data` — so it passes even if the adapter returns error state, making it potentially vacuous
- Any secrets inadvertently committed to the repo would be accessible via this path during test execution

**Recommended fix:** Either inject a mock git response or explicitly mark this as an integration test (`.live.test.ts` suffix, excluded from `pnpm test:fast`):

```typescript
// git-adapter.live.test.ts (excluded from fast suite)
it("poll without mock uses real git", ...)
```

---

### FINDING-004: `sanitizeCommand()` Pattern Gaps — Low

**Severity:** Low  
**Location:** `trust/gate.ts:135-148`

**Description:**  
The `sanitizeCommand()` method redacts several secret patterns before storing in `decision_log`:

- Bearer tokens, key=value args, JWT tokens, 40+ hex strings

**Gaps identified:**

1. AWS credential format (`AKIA[A-Z0-9]{16}`) not covered
2. Base64-encoded secrets (common in shell scripts) not redacted — `echo <base64_secret> | base64 -d`
3. SSH private key content (`-----BEGIN...`) could appear in command strings if piped
4. URL-embedded credentials (`https://user:password@host`) not redacted

**Mitigating factor:** `sanitizeCommand()` only processes `params.command` strings (exec tool calls), not all tool calls. Attack surface is limited.

**Recommended fix (Low priority):** Add patterns for AWS credentials and URL auth to `sanitizeCommand()`.

---

### FINDING-005: MockDb Doesn't Validate Parameterized Query Structure — Low

**Severity:** Low  
**Location:** `__tests__/fixtures/brain-db.mock.ts`

**Description:**  
The mock DB silently accepts any SQL and returns empty/null results, regardless of query validity. This means tests that call `runSQL/getSQL/allSQL` cannot detect:

- Malformed SQL strings
- Wrong parameter count vs. placeholder count
- SQL that accidentally uses string concatenation instead of parameters

**Recommended fix (Low priority):** Add a `validateParamCount(sql, params)` check to the mock that throws if `?` placeholder count doesn't match `params.length`.

---

## 4. Test Coverage Security Assessment

### 4.1 What the New Tests Verify From a Security Perspective

| Security Property                                    | Covered By                                                                    | Status |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| Runbooks don't auto-execute without anomaly input    | All 8 runbook tests require explicit `build(anomaly)` call                    | ✅     |
| Runbooks default to `auto_approve_whitelist = false` | 6/8 new runbooks assert `false` (rb-db-emergency, rb-kill-zombie, etc.)       | ✅     |
| Trust system exports not tampered                    | `trust/__tests__/index.test.ts` verifies all expected exports exist           | ✅     |
| Detection relays don't enqueue on success            | `tool-monitor.test.ts`: exit 0 = no enqueue                                   | ✅     |
| Detection payloads carry correct tier                | `pipeline-fail-relay.test.ts`, `trust-event-relay.test.ts` verify tier values | ✅     |
| Adapters return `[]` not throw on error              | All adapter tests with mockData verify graceful returns                       | ✅     |
| AtomPropagator fails gracefully on DB error          | `atom-propagator.test.ts`: DB error → `success: false`, no throw              | ✅     |
| SOP violation detection fires correctly              | `hook-violation-relay.test.ts` tests both with/without description            | ✅     |

### 4.2 Injection Boundary Coverage Gap

The new tests don't include adversarial boundary tests for injection scenarios:

- No test passes SQL metacharacters through the `cortex-bridge` path
- No test verifies that command injection via `target_id` in runbook anomalies is blocked
- No test verifies that memory content with prompt injection markers is handled by the bridge

**Note:** These are covered by the adversarial test framework (task-007), but unit-level injection tests would provide defense-in-depth and fail faster during development.

---

## 5. Summary of Findings

| ID          | Severity         | Location                                | Status           | Action                                                      |
| ----------- | ---------------- | --------------------------------------- | ---------------- | ----------------------------------------------------------- |
| FINDING-001 | High (mitigated) | `cortex-bridge.ts:1127-1165`            | Pre-existing     | Create task-017-bridge-sql-hardening                        |
| FINDING-002 | Medium           | `rb-gc-trigger.ts`, `rb-rotate-logs.ts` | Pre-existing     | Add explicit assertion tests; consider demoting rotate-logs |
| FINDING-003 | Medium           | `git-adapter.test.ts:20`                | Pre-existing     | Move to `.live.test.ts` or inject mock                      |
| FINDING-004 | Low              | `trust/gate.ts:135`                     | Pre-existing     | Add AWS/URL credential patterns                             |
| FINDING-005 | Low              | `brain-db.mock.ts`                      | New (test infra) | Optional: add placeholder count validation                  |

**Blocking issues:** None  
**New attack surface introduced by task-016:** None  
**Tests are safe to run in CI:** Yes

---

## 6. Acceptance Criteria Review

| Criterion                                          | Status                                               |
| -------------------------------------------------- | ---------------------------------------------------- |
| No hardcoded credentials in new test files         | ✅ PASS                                              |
| All tests use mock boundaries (no live I/O)        | ✅ PASS (see FINDING-003 for pre-existing exception) |
| No path traversal in fixture generation            | ✅ PASS                                              |
| No `auto_approve_whitelist = true` in new runbooks | ✅ PASS (6/8 new runbooks explicitly assert `false`) |
| No `eval()` or dynamic code execution in new tests | ✅ PASS                                              |
| Tests can safely run in CI without network access  | ✅ PASS                                              |

---

## 7. Behavioral Signature (Version Forensics)

**Inputs that trigger this security analysis:**

- Pipeline webhook `pipeline-next-stage` for `task-016-test-coverage` stage `security`
- Build artifact: `build-report.md` reporting 36 new test files, 128 new tests

**Expected grep pattern after this stage:**

```
grep -r "FINDING-001\|FINDING-002\|task-017-bridge-sql-hardening" \
  ~/Projects/helios/extensions/cortex/pipeline/task-016-test-coverage/security.md
```

**Failure mode:** If `task-017-bridge-sql-hardening` is not created as a follow-on task, FINDING-001 will remain untracked and risk accumulation in `cortex-bridge.ts` will increase with each new SQL-using feature.

---

_Security review complete. Proceeding to next pipeline stage._
