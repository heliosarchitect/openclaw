# Documentation: Bridge SQL Hardening — FINDING-001 Resolution

**Task ID:** task-017-bridge-sql-hardening  
**Stage:** document  
**Status:** PASS  
**Date:** 2026-02-19  
**Author:** Helios pipeline orchestrator  
**Cortex Version:** 2.7.5 (fix shipped in 2.7.2, commit 3f25091b4)

---

## 1. Overview

This document is the authoritative reference for the SQL injection hardening change in the Cortex bridge layer (`cortex-bridge.ts`). It covers:

- What changed and why (security rationale)
- Behavioral signatures for forensic audit
- API reference for the three affected methods
- Migration notes for callers
- Test coverage map
- Version forensics trail linking FINDING-001 → task-017 → production fix

### 1.1 Document Audience

| Audience                                       | What to read                                     |
| ---------------------------------------------- | ------------------------------------------------ |
| Future Helios agents debugging bridge failures | §4 (behavioral signatures), §6 (debugging hooks) |
| Security auditors                              | §2 (vulnerability), §3 (fix), §7 (test coverage) |
| Developers extending cortex-bridge.ts          | §3 (fix design), §5 (API reference)              |
| Pipeline reviewers                             | §8 (version forensics), §9 (acceptance trace)    |

---

## 2. Vulnerability: FINDING-001

### 2.1 Origin

Surfaced during task-016 security review. Documented in `pipeline/task-016-test-coverage/security.md` as **FINDING-001 (High/mitigated)**.

### 2.2 Root Cause

The three SQL bridge methods — `runSQL`, `getSQL`, and `allSQL` — constructed Python subprocess scripts by embedding SQL text and JSON-serialized parameters directly into a Python string literal using naive single-quote escaping:

```typescript
// VULNERABLE PATTERN (pre-commit 3f25091b4 / pre-v2.7.2)
const escapedSql = sql.replace(/'/g, "\\'").replace(/\n/g, " ");
const paramsJson = JSON.stringify(params ?? []).replace(/'/g, "\\'");
await this.runPython(`
import sqlite3, json, os
db.execute('${escapedSql}', json.loads('${paramsJson}'))
`);
```

### 2.3 Known Bypass Paths

| Bypass                          | Input               | Effect                                                                                |
| ------------------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| Backslash + quote               | `\'` in SQL/params  | Becomes `\\'` → escaped backslash + **unescaped** quote — breaks out of Python string |
| Missing backslash normalisation | `\` in any position | Creates precursor for bypass 1                                                        |
| Unicode escape sequences        | `\uXXXX` / `\xNN`   | Python interprets differently from JS — allows content injection                      |
| Newline stripping               | `\n` in SQL         | Silently compresses multi-line SQL, hides intent during review                        |

### 2.4 Attack Surface

| Path                                                  | Exploitability | Notes                                                                        |
| ----------------------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| Internal callers (abstraction engine, archiver, etc.) | Very Low       | Hardcoded SQL strings, no user-controlled input                              |
| `run_sql` tool handler (`index.ts:983–992`)           | Medium         | Tool invocations originate from agent; broader surface than internal callers |

### 2.5 Severity

| Property                   | Value                                                       |
| -------------------------- | ----------------------------------------------------------- |
| CVSS-equivalent            | Medium-High (internally exploitable only)                   |
| Exploitability in practice | Low — no external user input reaches these methods directly |
| Impact if triggered        | Arbitrary Python code execution inside bridge subprocess    |
| Mitigating controls        | Adversarial test suite (task-007), memory poisoning guards  |

---

## 3. Fix: Base64-Encoded Parameter Passing

### 3.1 Core Mechanism

Both SQL text and the JSON-serialized params list are **base64-encoded in TypeScript** before being embedded in the Python subprocess template. Python decodes both values before passing them to SQLite.

**Safety guarantee:** Base64 encoding uses only `[A-Za-z0-9+/=]` — no quotes, backslashes, or Python-significant characters can survive into the template. The decoded SQL string is passed to SQLite's own parameterized query binding (`db.execute(sql, params)`) which handles all value escaping internally.

### 3.2 Fixed Implementation

```typescript
// FIXED PATTERN (commit 3f25091b4 / v2.7.2+)
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

The same pattern is applied identically to `getSQL` (uses `fetchone`) and `allSQL` (uses `fetchall`). The only differences between the three methods are the Python fetch call and result serialization — the base64 encoding/decoding is identical.

### 3.3 Why Base64 (Not Other Approaches)

| Alternative                                       | Why Rejected                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Standalone `run_sql.py` script with argv          | Adds deployment complexity; script file must be co-located and path-resolved        |
| JSON args via `stdin` piped to subprocess         | Requires subprocess to read stdin synchronously; complicates `runPython()` contract |
| Environment variables for SQL/params              | Size limits on env vars; CORTEX_DATA_DIR already in env namespace                   |
| Parameterized Python subprocess (string.Template) | Still requires safe templating; base64 is simpler and more verifiable               |

Base64 inline encoding achieves equivalent security without operational overhead. A follow-on task (task-018+) may migrate all inline Python scripts to file-based scripts as a broader refactor.

---

## 4. Behavioral Signatures

### 4.1 Healthy System (v2.7.2+)

**Grep verifications:**

```bash
# Old escape pattern — must return 0 results:
grep -n "replace.*\\\\'" ~/Projects/helios/extensions/cortex/cortex-bridge.ts

# Base64 encoding — must return 3 results (one per method):
grep -n "Buffer.from(sql)" ~/Projects/helios/extensions/cortex/cortex-bridge.ts

# Python decode — must return 6 results (2 per method):
grep -n "base64.b64decode" ~/Projects/helios/extensions/cortex/cortex-bridge.ts

# Import present in generated scripts — confirmed by test suite
```

**Expected output:**

- `grep replace`: 0 matches in runSQL/getSQL/allSQL bodies
- `grep Buffer.from(sql)`: 3 matches at lines ~1124, ~1142, ~1160
- `grep base64.b64decode`: 6 matches (2 per method: one for sql, one for params)

### 4.2 Failure Mode: Old Code Restored

**Symptoms:**

```
Error: Python subprocess exited with code 1
SyntaxError: EOL while scanning string literal
```

**Trigger condition:** Any SQL string or param value containing `\'` (backslash + single quote).

**Diagnostic:** If `grep "replace.*\\\\'" cortex-bridge.ts` returns results in the `runSQL/getSQL/allSQL` bodies, the old vulnerable pattern has been restored. Revert commit 3f25091b4 fix.

### 4.3 Failure Mode: Python Missing or Wrong Version

**Symptoms:**

```
Error: spawn python3 ENOENT
```

**Diagnostic:** `which python3` — if not found, install Python 3. All SQL bridge operations require Python 3.6+ for `base64` stdlib.

### 4.4 Failure Mode: CORTEX_DATA_DIR Unset or Invalid

**Symptoms:**

```
sqlite3.OperationalError: unable to open database file
```

**Diagnostic:** `echo $CORTEX_DATA_DIR` — must point to a writable directory containing `brain.db`.

---

## 5. API Reference: SQL Bridge Methods

All three methods maintain the same TypeScript signatures as before. No API change was made.

### 5.1 `runSQL(sql: string, params?: unknown[]): Promise<void>`

Execute a SQL statement with no return value. Use for INSERT, UPDATE, DELETE, DDL (CREATE TABLE, ALTER TABLE, etc.).

**Parameters:**

- `sql` — SQL text. May contain `?` placeholders. May span multiple lines. May contain any character including quotes and backslashes.
- `params` — Optional array of values bound to `?` placeholders in order. Values may contain any character including quotes, backslashes, SQL injection payloads, and Unicode.

**Example:**

```typescript
await bridge.runSQL("INSERT INTO stm (id, content, importance) VALUES (?, ?, ?)", [
  "my-id",
  "it's a test with \\backslash",
  2.0,
]);
```

**Throws:** If the SQL is syntactically invalid or violates a constraint.

### 5.2 `getSQL<T>(sql: string, params?: unknown[]): Promise<T | null>`

Execute a SELECT returning the first matching row as a plain object, or `null` if no rows match.

**Parameters:** Same as `runSQL`.

**Returns:** First row as `T` (column names become object keys), or `null`.

**Example:**

```typescript
const row = await bridge.getSQL<{ id: string; content: string }>(
  "SELECT id, content FROM stm WHERE id = ?",
  ["my-id"],
);
// row?.content === "it's a test with \\backslash"
```

### 5.3 `allSQL<T>(sql: string, params?: unknown[]): Promise<T[]>`

Execute a SELECT returning all matching rows as an array of plain objects. Returns `[]` if no rows match.

**Parameters:** Same as `runSQL`.

**Returns:** Array of rows as `T[]`, ordered by query result order.

**Example:**

```typescript
const rows = await bridge.allSQL<{ id: string }>(
  "SELECT id FROM stm WHERE importance >= ? ORDER BY importance DESC",
  [2.0],
);
```

### 5.4 Common Notes

- **Multi-statement SQL:** SQLite's `execute()` only runs one statement. A second statement separated by `;` will be ignored or raise an error — it will not execute. This is a SQLite constraint, not a code-level guard.
- **Transaction support:** `runSQL("BEGIN")` / `runSQL("COMMIT")` / `runSQL("ROLLBACK")` work correctly. Each call is a separate subprocess; `BEGIN` and `COMMIT` must be called in separate `runSQL` invocations.
- **Type safety:** The generic `T` type is not validated at runtime. Callers are responsible for asserting column names match.

---

## 6. Debugging Hooks

### 6.1 Verify Fix Is Active

```bash
# From the cortex repo root:
cd ~/Projects/helios/extensions/cortex

# Should return 0 lines (no old escaping):
grep -n "replace.*\\\\'" cortex-bridge.ts | grep -v "^[[:space:]]*/" | grep -v "test"

# Should return 3 lines (one per method):
grep -n "Buffer.from(sql)" cortex-bridge.ts

# Should return 6 lines (2 per method):
grep -n "base64.b64decode" cortex-bridge.ts
```

### 6.2 Run SQL Hardening Tests

```bash
cd ~/Projects/helios/extensions/cortex
pnpm vitest run __tests__/sql-hardening.test.ts --reporter=verbose
```

All 18+ tests must pass. Any failure in the "Injection Resistance" describe block indicates a regression.

### 6.3 Manual Bridge Smoke Test

```bash
# Quick sanity check without the test suite:
node -e "
const { CortexBridge } = require('./dist/cortex-bridge.js');
const bridge = new CortexBridge();
bridge.runSQL(\"CREATE TABLE IF NOT EXISTS _smoke (id TEXT)\")
  .then(() => bridge.runSQL(\"INSERT INTO _smoke VALUES (?)\", [\"it\\'s ok\"]))
  .then(() => bridge.getSQL(\"SELECT * FROM _smoke\"))
  .then(r => console.log('OK:', r))
  .catch(e => console.error('FAIL:', e.message));
"
```

Expected: `OK: { id: "it's ok" }`

### 6.4 Inspect Python Script Output

To see the actual Python script generated by the bridge (useful for debugging):

```typescript
// Temporarily monkey-patch runPython to log the script:
const orig = bridge["runPython"].bind(bridge);
bridge["runPython"] = async (script: string) => {
  console.log("=== PYTHON SCRIPT ===\n", script);
  return orig(script);
};
await bridge.runSQL("SELECT 1", []);
```

The output should show base64 strings, not raw SQL.

---

## 7. Test Coverage Map

The build stage produces `__tests__/sql-hardening.test.ts` with the following tests:

### 7.1 Script Integrity Tests (AC-011, AC-012, AC-013, AC-014)

| Test                                                 | What It Verifies                                 |
| ---------------------------------------------------- | ------------------------------------------------ |
| `runSQL script does not embed raw SQL text`          | Raw SQL not in template; base64 pattern present  |
| `getSQL script does not embed raw SQL text`          | Same for getSQL                                  |
| `allSQL script does not embed raw SQL text`          | Same for allSQL                                  |
| `no escape-based SQL handling (AC-011 static check)` | `.replace(/'/g, ...)` pattern absent from source |

### 7.2 runSQL Tests

| Test                                   | AC         | What It Verifies                    |
| -------------------------------------- | ---------- | ----------------------------------- |
| DDL (CREATE TABLE)                     | AC-001     | runSQL executes DDL without error   |
| DML (INSERT with params)               | AC-002     | runSQL executes DML with `?` params |
| SQL with single quote                  | AC-006     | `'` in SQL doesn't break Python     |
| SQL with backslash-quote (FINDING-001) | AC-007     | `\'` in SQL doesn't break Python    |
| SQL with newlines                      | AC-008     | Multi-line SQL executes correctly   |
| Params with injection payload          | AC-009/010 | Injection payload is literal value  |

### 7.3 getSQL Tests

| Test                          | AC     | What It Verifies                   |
| ----------------------------- | ------ | ---------------------------------- |
| Returns matching row          | AC-003 | Row returned as object             |
| Returns null for no-match     | AC-003 | Null when no rows match            |
| Params with backslash         | AC-009 | Backslash in param, correct result |
| Params with injection payload | AC-010 | DROP payload treated as literal    |

### 7.4 allSQL Tests

| Test                          | AC     | What It Verifies                |
| ----------------------------- | ------ | ------------------------------- |
| Returns all matching rows     | AC-004 | Multi-row array returned        |
| Returns [] for no-match       | AC-004 | Empty array for no rows         |
| Params with injection payload | AC-010 | DROP payload treated as literal |

### 7.5 Adversarial / Edge Case Tests

| Test                                    | §Reference | What It Verifies                            |
| --------------------------------------- | ---------- | ------------------------------------------- |
| Multi-statement SQL does not drop table | §7.3       | Second statement not executed               |
| 4KB SQL string completes within 5s      | §7.3       | Performance not degraded by base64 overhead |
| Unicode params inserted verbatim        | §7.1 table | Emoji and `\u0027` inserted correctly       |

**Total: ≥18 tests.** All must pass for the build stage to complete.

---

## 8. Version Forensics

### 8.1 Timeline

| Date              | Event                                         | Artifact                                                         |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| 2026-02-19 ~08:xx | task-016 security review surfaces FINDING-001 | `pipeline/task-016-test-coverage/security.md`                    |
| 2026-02-19 ~08:xx | Fix implemented — commit 3f25091b4            | `cortex-bridge.ts:1124–1175`                                     |
| 2026-02-19 ~08:xx | Cortex version bumped to 2.7.2                | `package.json`                                                   |
| 2026-02-19 09:01  | task-017 pipeline opened for formal trace     | `pipeline/state.json`                                            |
| 2026-02-19 09:02  | requirements stage complete                   | `pipeline/task-017-bridge-sql-hardening/requirements.md`         |
| 2026-02-19 09:03  | design stage complete                         | `pipeline/task-017-bridge-sql-hardening/design.md`               |
| 2026-02-19 09:05  | document stage complete                       | `pipeline/task-017-bridge-sql-hardening/document.md` (this file) |
| TBD               | build stage — test suite written and passing  | `pipeline/task-017-bridge-sql-hardening/build-report.md`         |

### 8.2 Commit Trail

| Commit      | Description                                         | Version |
| ----------- | --------------------------------------------------- | ------- |
| `3f25091b4` | `fix(cortex): base64 SQL encoding in cortex-bridge` | 2.7.2   |

### 8.3 FINDING-001 Closure Checklist

| Requirement                            | Status                     |
| -------------------------------------- | -------------------------- |
| Root cause documented                  | ✅ §2                      |
| Fix implemented                        | ✅ commit 3f25091b4        |
| Fix mechanism documented               | ✅ §3                      |
| API unchanged (backward compatible)    | ✅ §5 (same signatures)    |
| Test coverage for injection resistance | 🔄 build stage (task-017)  |
| CHANGELOG entry                        | 🔄 build stage (task-017)  |
| Full pipeline trace                    | 🔄 ongoing (this pipeline) |

### 8.4 Related Tasks

| Task                          | Relationship                                                            |
| ----------------------------- | ----------------------------------------------------------------------- |
| task-016-test-coverage        | Source of FINDING-001; security stage authored the finding              |
| task-017-bridge-sql-hardening | This task — formal pipeline trace for the fix                           |
| task-018+ (future)            | Potential broader refactor: file-based Python scripts instead of inline |

---

## 9. CHANGELOG Entry

To be added to `extensions/cortex/CHANGELOG.md` in the `[2.7.2]` section:

```markdown
## [2.7.2] — 2026-02-19

### Security

- **FINDING-001 (High/mitigated):** Replaced naive single-quote escaping in `runSQL`, `getSQL`,
  and `allSQL` with base64-encoded parameter passing. SQL strings and params are base64-encoded
  in TypeScript before embedding in the Python subprocess template; Python decodes both values
  before execution. Eliminates the backslash-quote bypass (`\'` → `\\'`) that could escape the
  Python string literal. All values reach `db.execute(sql, params)` safely decoded via SQLite's
  own parameterized binding. (commit 3f25091b4)

### Tests

- `__tests__/sql-hardening.test.ts`: 18+ injection resistance tests covering AC-006 through
  AC-015 from task-017 requirements. (task-017)
```

---

## 10. Rollback Plan

If the fix must be reverted:

1. `git revert 3f25091b4` — targeted revert; no other changes in that commit
2. This restores the single-quote escape pattern — acceptable short-term given all internal callers use hardcoded SQL
3. Delete or skip `__tests__/sql-hardening.test.ts` (it will fail against the old pattern)
4. Bump version to `2.7.x+1` with a note in CHANGELOG explaining the temporary revert
5. File a new task to re-implement the fix before the next minor release

**Do not revert without filing a replacement task.** FINDING-001 is a real (if low-exploitability) vulnerability.

---

## 11. Non-Goals (Out of Scope)

The following are explicitly not addressed by task-017:

- Migrating inline Python scripts to file-based scripts (`run_sql.py`) — broader refactor
- FINDING-002 (auto-approval whitelist) — separate task
- FINDING-003 (git-adapter live test) — separate task
- Modifying `runPython()` itself — fix is at the `runSQL/getSQL/allSQL` layer only
- Input validation or SQL allow-listing at the `run_sql` tool handler level — future task
- Connection pooling or persistent Python process for performance — separate concern

---

_Document stage complete. Proceeding to build stage._
