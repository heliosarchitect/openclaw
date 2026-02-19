# Requirements: Bridge SQL Hardening

**Task ID:** task-017-bridge-sql-hardening  
**Stage:** requirements  
**Status:** PASS  
**Date:** 2026-02-19  
**Source:** FINDING-001 from task-016-test-coverage/security.md  
**Cortex Version at time of writing:** 2.7.5 (fix already shipped as 2.7.2 in commit 3f25091b4)

---

## 1. Background

Task-016's security review surfaced FINDING-001 (High/mitigated): the three SQL bridge methods in `cortex-bridge.ts` — `runSQL`, `getSQL`, and `allSQL` — constructed inline Python scripts by string-interpolating SQL text and JSON-serialised parameters using a naive single-quote-escape strategy. This created an exploitable code path if a SQL string or parameter value contained backslash-quote sequences (`\'`), resulting in broken Python string literals and a bypass to SQLite's own parameterised query machinery.

A fix was shipped in **commit 3f25091b4** (`fix(cortex): base64 SQL encoding in cortex-bridge`, cortex v2.7.2). This document formalises the requirements so the build, verify, validate, and deploy stages have explicit acceptance criteria to test against — and so the fix is traceable through the full pipeline.

---

## 2. Current Vulnerability Description (Pre-Fix)

### 2.1 Affected Code (pre-commit 3f25091b4)

All three SQL bridge methods used an identical vulnerable pattern:

```typescript
// VULNERABLE — naive single-quote escaping (pre-2.7.2)
const escapedSql = sql.replace(/'/g, "\\'").replace(/\n/g, " ");
const paramsJson = JSON.stringify(params ?? []).replace(/'/g, "\\'");
await this.runPython(`
import sqlite3, json, os
db = sqlite3.connect(...)
db.execute('${escapedSql}', json.loads('${paramsJson}'))
...
`);
```

### 2.2 Known Bypass Paths

1. **Backslash + quote combination:** A SQL string containing `\'` becomes `\\'` after the escape — an escaped backslash followed by an **unescaped** quote, breaking out of the Python string literal.
2. **Missing backslash normalisation:** Backslashes in SQL or params are not escaped before the single-quote pass. Any `\` in values creates a precursor for path 1.
3. **Unicode escape sequences:** Python interprets `\uXXXX` and `\xNN` differently from JavaScript, allowing crafted values to produce unintended Python string content.
4. **Newline stripping:** `.replace(/\n/g, " ")` destroys SQL formatting and makes multi-line SQL injection non-obvious during review.

### 2.3 Severity Assessment

| Property            | Assessment                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| CVSS-equivalent     | Medium-High (internally exploitable only)                                                                              |
| Exploitability      | Low in practice — all callers use hardcoded SQL strings                                                                |
| Impact if triggered | Arbitrary Python code execution inside the bridge subprocess                                                           |
| Mitigating factors  | No external user input reaches these methods directly; adversarial test suite (task-007) covers memory poisoning paths |

---

## 3. All Affected Code Paths

### 3.1 Bridge Methods (primary targets)

| Method                    | Location                | Purpose                                             |
| ------------------------- | ----------------------- | --------------------------------------------------- |
| `runSQL(sql, params?)`    | `cortex-bridge.ts:1124` | INSERT / UPDATE / DELETE / DDL with no return value |
| `getSQL<T>(sql, params?)` | `cortex-bridge.ts:1142` | SELECT returning single row or null                 |
| `allSQL<T>(sql, params?)` | `cortex-bridge.ts:1160` | SELECT returning all matching rows                  |

All three delegate to `runPython()` by constructing a complete Python script string via template literal.

### 3.2 Internal Callers (TypeScript layer)

These call `runSQL/getSQL/allSQL` and are all considered internal (hardcoded SQL, no user-controlled query strings):

| File                                | Methods Used                           | Notes                                             |
| ----------------------------------- | -------------------------------------- | ------------------------------------------------- |
| `abstraction/migration-008.ts`      | `runSQL` (×5)                          | Schema DDL: CREATE TABLE, ALTER TABLE             |
| `abstraction/archiver.ts`           | `runSQL` (×3)                          | UPDATE/DELETE on `stm` rows                       |
| `abstraction/abstraction-engine.ts` | `runSQL` (×6), `allSQL` (×2)           | Cluster writes, BEGIN/COMMIT/ROLLBACK             |
| `abstraction/cluster-finder.ts`     | `allSQL` (×2)                          | SELECT on abstraction clusters                    |
| `abstraction/distiller.ts`          | `allSQL` (×1)                          | SELECT members for distillation                   |
| `abstraction/memory-writer.ts`      | `getSQL` (×2), `allSQL` (×1)           | Importance/range/category reads                   |
| `index.ts`                          | `runSQL`, `getSQL`, `allSQL` (×1 each) | Tool handler dispatch for external SQL tool calls |

### 3.3 External Entry Point

`index.ts:983–992` exposes `runSQL/getSQL/allSQL` as tool handlers for the `run_sql` OpenClaw tool. This is the **only path where a non-hardcoded SQL string or params value could arrive**. Tool handler code:

```typescript
await bridge.runSQL(sql, params); // line 983
return bridge.getSQL<T>(sql, params); // line 989
return bridge.allSQL<T>(sql, params); // line 992
```

The `sql` and `params` values at this call site originate from the agent's own tool invocations — not raw user input — but the attack surface is wider than the internal abstraction callers.

---

## 4. Proposed Solution

### 4.1 Core Mechanism

Replace string interpolation for both SQL and parameters with **base64-encoded channels**. Each value is independently base64-encoded in TypeScript before being embedded in the Python script template. Python decodes the base64 literals before using them.

This is safe because:

- Base64 encoding uses only `[A-Za-z0-9+/=]` — no quotes, backslashes, or Python-significant characters
- The decoded SQL is passed to `db.execute(sql, params)` — SQLite's own parameterised query binding handles value escaping
- The decoded `params` list is deserialized from JSON (never interpolated into SQL text)

### 4.2 Fix Applied (commit 3f25091b4)

```typescript
// FIXED — base64 parameter passing (cortex v2.7.2+)
async runSQL(sql: string, params?: unknown[]): Promise<void> {
    const sqlB64 = Buffer.from(sql).toString("base64");
    const paramsB64 = Buffer.from(JSON.stringify(params ?? [])).toString("base64");
    await this.runPython(`
import sqlite3, json, os, base64
sql = base64.b64decode('${sqlB64}').decode()
params = json.loads(base64.b64decode('${paramsB64}').decode())
db = sqlite3.connect(os.path.join(os.environ.get('CORTEX_DATA_DIR', '.'), 'brain.db'))
db.execute(sql, params)
db.commit()
db.close()
print('null')
`);
}
```

Identical pattern applied to `getSQL` and `allSQL` — the only differences are the Python fetch call (`fetchone` / `fetchall`) and the JSON serialisation of the result.

### 4.3 Why Not a Separate Python Script File

An alternative would be a standalone `run_sql.py` script accepting base64 arguments via `argv`. This is **not required** for correctness and adds deployment complexity (script file must be present, path must be resolved). The inline script approach with base64 encoding achieves equivalent security without the operational overhead. A follow-on task (task-018+) may migrate all inline Python scripts to file-based scripts as a broader refactor if warranted.

---

## 5. Acceptance Criteria

The following must all be true for the build stage to pass:

### 5.1 Functional Correctness

- [ ] **AC-001:** `runSQL` executes DDL (CREATE TABLE, ALTER TABLE) without error
- [ ] **AC-002:** `runSQL` executes DML (INSERT, UPDATE, DELETE) with parameterised values
- [ ] **AC-003:** `getSQL` returns a single row object matching the query, or `null` for no-match
- [ ] **AC-004:** `allSQL` returns an array of all matching rows; returns `[]` for no-match
- [ ] **AC-005:** All three methods pass `?` placeholder values via the `params` argument, never interpolated into the SQL string

### 5.2 Injection Resistance

- [ ] **AC-006:** A SQL string containing `'` (single quote) does not break Python script execution
- [ ] **AC-007:** A SQL string containing `\'` (backslash + quote) does not break Python script execution
- [ ] **AC-008:** A SQL string containing `\n` (newline) executes correctly (multi-line SQL supported)
- [ ] **AC-009:** A `params` value containing `'` or `\` does not alter the SQL statement executed
- [ ] **AC-010:** A `params` value containing `"; DROP TABLE stm;--` is treated as a literal value, not SQL
- [ ] **AC-011:** No `.replace(/'/g, ...)` or similar escaping logic exists in `runSQL`, `getSQL`, or `allSQL`

### 5.3 Implementation Constraints

- [ ] **AC-012:** SQL text is base64-encoded using `Buffer.from(sql).toString("base64")` before embedding in the Python template string
- [ ] **AC-013:** Params are JSON-serialised then base64-encoded using `Buffer.from(JSON.stringify(params ?? [])).toString("base64")`
- [ ] **AC-014:** Python script decodes both values via `base64.b64decode(...).decode()` before use
- [ ] **AC-015:** SQLite execution uses `db.execute(sql, params)` — parameterised form with decoded values

---

## 6. Non-Functional Requirements

### 6.1 Backward Compatibility

- **NFR-001:** All existing callers listed in §3.2 continue to work without modification. The `runSQL/getSQL/allSQL` API signatures do not change — `(sql: string, params?: unknown[])`.
- **NFR-002:** SQL strings that were previously valid (no injected content) must continue to produce identical results post-fix.
- **NFR-003:** The `run_sql` tool handler in `index.ts` must continue to dispatch correctly. No change to the tool schema or return type.

### 6.2 Performance

- **NFR-004:** Base64 encoding/decoding overhead is negligible for typical SQL query sizes (< 4KB). No caching or optimisation required.
- **NFR-005:** The fix must not increase subprocess spawn count. Each `runSQL/getSQL/allSQL` call still spawns exactly one Python process.
- **NFR-006:** The `CORTEX_DATA_DIR` environment variable path resolution must remain unchanged.

### 6.3 Test Coverage

- **NFR-007:** Unit tests for `runSQL`, `getSQL`, and `allSQL` must cover the injection resistance cases in AC-006 through AC-011 using the mock DB fixture.
- **NFR-008:** Tests must verify the Python script string produced by each method **does not contain** the unencoded SQL text.
- **NFR-009:** Tests must verify that `params` containing special characters are passed through correctly and do not alter query semantics.
- **NFR-010:** Minimum new test count: 6 tests (2 per method covering happy path + injection resistance).

### 6.4 Code Quality

- **NFR-011:** No TypeScript type changes required — the fix is purely implementation, not interface.
- **NFR-012:** Each of the three methods must be consistent — identical base64 encode/decode pattern.
- **NFR-013:** The `base64` Python module must be imported in all three generated scripts (was previously absent).

---

## 7. Security Testing Requirements

### 7.1 Injection Boundary Tests

The following inputs **must be tested** in the verify stage. Each must execute without Python syntax error and produce the expected SQL result:

| Test Case              | SQL Input                                        | Params                         | Expected Behaviour                   |
| ---------------------- | ------------------------------------------------ | ------------------------------ | ------------------------------------ |
| Basic select           | `SELECT * FROM stm WHERE id = ?`                 | `["test-id"]`                  | Returns matching row or null         |
| Single quote in SQL    | `SELECT * FROM stm WHERE content LIKE '%it''s%'` | `[]`                           | Executes correctly                   |
| Backslash-quote bypass | `SELECT * FROM stm WHERE id = '\'`               | `[]`                           | Executes without Python syntax error |
| Newline in SQL         | `SELECT id,\n  content\nFROM stm\nWHERE id = ?`  | `["x"]`                        | Multi-line SQL executes correctly    |
| Injection in param     | `SELECT * FROM stm WHERE id = ?`                 | `["'; DROP TABLE stm;--"]`     | Returns null; `stm` table unaffected |
| Backslash in param     | `SELECT * FROM stm WHERE id = ?`                 | `["path\\to\\file"]`           | Returns null; no syntax error        |
| Unicode in param       | `INSERT INTO stm (content) VALUES (?)`           | `["emoji 🔒 and \u0027quote"]` | Inserted verbatim                    |

### 7.2 Regression Test (Pre-Existing Callers)

- All abstraction engine operations (`migration-008`, `archiver`, `abstraction-engine`, `cluster-finder`, `distiller`, `memory-writer`) must pass their existing tests unmodified.
- The `run_sql` tool handler integration path must be covered by at least one end-to-end test.

### 7.3 Negative / Adversarial Tests

- A test must assert that calling `runSQL("SELECT 1; DROP TABLE stm", [])` either (a) raises a SQLite error (multi-statement not allowed) or (b) executes only the first statement — but does **not** drop the table.
- A test must verify `runSQL` with a 4KB SQL string (stress test for base64 + subprocess buffer) completes within 5 seconds.

---

## 8. Deliverables

| Deliverable                                                | Owner Stage           | Location                                                        |
| ---------------------------------------------------------- | --------------------- | --------------------------------------------------------------- |
| Fix already applied                                        | ✅ (commit 3f25091b4) | `extensions/cortex/cortex-bridge.ts:1124–1175`                  |
| Unit tests for `runSQL/getSQL/allSQL` injection resistance | build                 | `extensions/cortex/__tests__/cortex-bridge.test.ts` or new file |
| Updated CHANGELOG entry                                    | build                 | `extensions/cortex/CHANGELOG.md`                                |
| Version bump to 2.7.x (already 2.7.2→2.7.5)                | ✅ done               | `extensions/cortex/package.json`                                |

---

## 9. Out of Scope

The following are **not** in scope for task-017:

- Migrating inline Python scripts to file-based scripts (`run_sql.py`, etc.) — this is a broader refactor
- Addressing FINDING-002 (auto-approval whitelist) or FINDING-003 (git-adapter live test) — separate tasks
- Modifying the `runPython()` method itself — the fix is at the `runSQL/getSQL/allSQL` layer
- Adding input validation or SQL allow-listing at the `run_sql` tool handler — future task

---

## 10. Verification Notes

The fix (commit 3f25091b4) is already present in the codebase as of cortex v2.7.2. The purpose of running this task through the full pipeline is to:

1. Document the requirement formally for future auditors
2. Ensure test coverage is added in the build stage (currently no tests cover the injection resistance cases)
3. Confirm the fix is stable across the full abstraction caller surface
4. Generate a traceable pipeline record linking FINDING-001 → task-017 → requirements → build → verify → done

---

## 11. Behavioral Signature (Version Forensics)

**Log patterns indicating fix is active (cortex v2.7.2+):**

```
# No occurrences of old escape pattern:
grep -n "replace.*\\\\'" extensions/cortex/cortex-bridge.ts  # → 0 results

# Base64 pattern present in all three methods:
grep -n "Buffer.from(sql)" extensions/cortex/cortex-bridge.ts  # → 3 results
grep -n "base64.b64decode" extensions/cortex/cortex-bridge.ts  # → 6 results (2 per method)
```

**Failure mode signature (if old code were somehow restored):**

- Python subprocess fails with `SyntaxError: EOL while scanning string literal` when SQL contains `\'`
- `runSQL` call with multi-line SQL silently compresses to single line (newlines stripped)

**Rollback plan:**

- Revert commit 3f25091b4 only (targeted revert, no other changes in that commit)
- This restores the old escape-based pattern — acceptable short-term given all callers use hardcoded SQL

---

_Requirements complete. Proceeding to build stage._
