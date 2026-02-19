# Design: Bridge SQL Hardening Test Suite

**Task ID:** task-017-bridge-sql-hardening  
**Stage:** design  
**Status:** PASS  
**Date:** 2026-02-19  
**Author:** Helios pipeline orchestrator  
**Cortex Version:** 2.7.5 (fix shipped in 2.7.2, commit 3f25091b4)

---

## 1. Design Scope

The fix (base64 SQL encoding) is already live. This design stage covers **what to build** in the `build` stage — specifically, the test suite that validates the fix satisfies all acceptance criteria from requirements (§5, §6.3, §7).

The design does **not** re-architect the fix itself. The implementation in `cortex-bridge.ts:1124–1175` is frozen.

---

## 2. Test File Architecture

### 2.1 New File: `__tests__/sql-hardening.test.ts`

A dedicated test file, separate from `cortex-bridge.test.ts`. The existing test file covers pure-TS utility functions (no subprocess I/O). SQL hardening tests require real subprocess execution against a live SQLite database, making them a different test category:

| Test file               | Tests                              | DB dependency    | Subprocess        |
| ----------------------- | ---------------------------------- | ---------------- | ----------------- |
| `cortex-bridge.test.ts` | Pure TS utilities, in-memory mocks | None             | None              |
| `sql-hardening.test.ts` | SQL bridge injection resistance    | Temp SQLite file | Python subprocess |

### 2.2 File Location

```
extensions/cortex/__tests__/sql-hardening.test.ts
```

This keeps all cortex tests under the existing `__tests__/` directory, consistent with the vitest config (`"test": "vitest run extensions/cortex/"`).

---

## 3. Test Infrastructure Design

### 3.1 Real Subprocess Requirement

`runSQL`, `getSQL`, and `allSQL` spawn a Python child process. The `brain-db.mock.ts` fixture (which provides a JS-in-memory stub) cannot validate the Python-layer execution. All SQL hardening tests must exercise the **actual subprocess path**.

This means:

1. Tests require Python 3 installed (system dependency, already satisfied on giggletits)
2. Tests are slower than unit tests (~50–200ms per call due to spawn overhead)
3. Tests require a real file-backed SQLite database (`:memory:` requires `CORTEX_DATA_DIR` to point to a writeable path)

### 3.2 Temp Database Setup

Each test suite (describe block) uses a **per-run temp database** in `/tmp/`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// In beforeAll:
const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
process.env.CORTEX_DATA_DIR = tmpDir;

// In afterAll:
rmSync(tmpDir, { recursive: true, force: true });
```

This avoids test pollution across runs and keeps tests hermetic.

### 3.3 CortexBridge Instantiation

```typescript
import { CortexBridge } from "../cortex-bridge.js";

const bridge = new CortexBridge();
// bridge.memoryDir → reads CORTEX_DATA_DIR from env (set in beforeAll)
```

The bridge must be instantiated **after** `CORTEX_DATA_DIR` is set. A single bridge instance is reused across tests in the same describe block.

### 3.4 Test Table Schema

A lightweight scratch table (`test_harness`) is created once per test run in `beforeAll`:

```sql
CREATE TABLE IF NOT EXISTS test_harness (
  id   TEXT PRIMARY KEY,
  val  TEXT
)
```

This table is used for all INSERT/SELECT/UPDATE/DELETE tests. It is distinct from production tables (`stm`, `atoms`, etc.) so tests cannot corrupt real data.

---

## 4. Test Suite Layout

### 4.1 Suite Structure

```
describe('SQL Hardening — Bridge Base64 Encoding')
  ├── describe('Script Integrity')
  │     ├── runSQL script does not embed raw SQL text
  │     ├── getSQL script does not embed raw SQL text
  │     └── allSQL script does not embed raw SQL text
  ├── describe('runSQL — Happy Path')
  │     ├── DDL (CREATE TABLE)
  │     └── DML (INSERT with params)
  ├── describe('runSQL — Injection Resistance')
  │     ├── SQL with single quote
  │     ├── SQL with backslash-quote (FINDING-001 bypass)
  │     ├── SQL with newline (multi-line SQL)
  │     └── params containing SQL injection payload
  ├── describe('getSQL — Happy Path + Injection Resistance')
  │     ├── Returns matching row
  │     ├── Returns null for no-match
  │     ├── Params with backslash return correct result
  │     └── Params with injection payload treated as literal
  ├── describe('allSQL — Happy Path + Injection Resistance')
  │     ├── Returns all matching rows
  │     ├── Returns [] for no-match
  │     └── Params with injection payload treated as literal
  └── describe('Adversarial / Edge Cases')
        ├── Multi-statement SQL does not execute second statement
        ├── 4KB SQL string completes within 5s
        └── Unicode params inserted verbatim
```

Total: **≥18 test cases** (requirement NFR-010: minimum 6, 2 per method)

### 4.2 Script Integrity Tests (AC-011, AC-012, AC-013)

These tests inspect the **generated Python script string** without executing it. They spy on `CortexBridge.prototype.runPython` to capture the script text:

```typescript
import { vi } from "vitest";

it("runSQL script does not embed raw SQL text", async () => {
  const spy = vi.spyOn(bridge as any, "runPython").mockResolvedValue(null);
  const sql = "SELECT id FROM stm WHERE id = 'test'";
  await bridge.runSQL(sql);

  const script = spy.mock.calls[0][0] as string;
  // The raw SQL must NOT appear in the script
  expect(script).not.toContain(sql);
  // Base64 import must be present
  expect(script).toContain("import base64") || expect(script).toContain("base64");
  // Decode pattern must be present
  expect(script).toContain("base64.b64decode");

  spy.mockRestore();
});
```

This validates AC-011 (no raw escaping logic) and AC-012/AC-013/AC-014 (base64 pattern present).

### 4.3 Injection Resistance Tests (AC-006 through AC-010)

These tests execute the **real subprocess** and verify:

1. No Python `SyntaxError` or subprocess failure
2. The SQL result is semantically correct (not corrupted by injection)

Key patterns:

```typescript
it("backslash-quote bypass does not break Python execution (FINDING-001)", async () => {
  // This is the specific bypass documented in requirements §2.2
  // Pre-fix: "SELECT * FROM test_harness WHERE id = '\'" would break the Python template
  const sql = "SELECT * FROM test_harness WHERE id = ?";
  const params = ["path\\to\\something\\'with quotes"];

  // Must complete without throwing (no Python SyntaxError)
  await expect(bridge.getSQL(sql, params)).resolves.toBeNull();
});

it("SQL injection in params treated as literal value (AC-010)", async () => {
  const sql = "SELECT * FROM test_harness WHERE id = ?";
  const injectionPayload = "'; DROP TABLE test_harness;--";

  // Must return null (no match), not throw, and not drop the table
  await expect(bridge.getSQL(sql, [injectionPayload])).resolves.toBeNull();

  // Verify table still exists
  const rows = await bridge.allSQL("SELECT * FROM test_harness");
  expect(Array.isArray(rows)).toBe(true); // Would throw if table was dropped
});
```

### 4.4 Multi-Statement Adversarial Test (§7.3)

```typescript
it("multi-statement SQL does not execute second statement", async () => {
  // SQLite's execute() only runs one statement; the DROP should not execute
  await bridge.runSQL("INSERT INTO test_harness VALUES ('keep-me', 'val')");

  // This may throw a SQLite error (multi-statement rejected), or silently ignore DROP
  // Either outcome is acceptable — the table must survive
  try {
    await bridge.runSQL("SELECT 1; DROP TABLE test_harness", []);
  } catch (_e) {
    // Expected: SQLite rejects multi-statement
  }

  // Table must still exist and contain our row
  const row = await bridge.getSQL("SELECT * FROM test_harness WHERE id = 'keep-me'");
  expect(row).not.toBeNull();
});
```

### 4.5 4KB Stress Test (§7.3)

```typescript
it("4KB SQL string completes within 5 seconds", async () => {
  const longComment = "-- " + "x".repeat(4000);
  const sql = `${longComment}\nSELECT 1 FROM test_harness LIMIT 1`;

  const start = Date.now();
  await bridge.allSQL(sql, []);
  const elapsed = Date.now() - start;

  expect(elapsed).toBeLessThan(5000);
}, 10_000); // Vitest timeout: 10s
```

---

## 5. CHANGELOG Entry Design

A CHANGELOG entry must be added to `extensions/cortex/CHANGELOG.md` in the `[2.7.2]` or `[Unreleased]` section:

```markdown
### Security

- **FINDING-001 (High/mitigated):** Replaced naive single-quote escaping in `runSQL`, `getSQL`, and `allSQL`
  with base64-encoded parameter passing. SQL strings and params are now base64-encoded in TypeScript
  before embedding in the Python subprocess template. Python decodes both values before execution.
  This eliminates the backslash-quote bypass (`\'` → `\\'`) that could break out of the Python
  string literal. All values reach `db.execute(sql, params)` safely decoded. (commit 3f25091b4)
- **Test coverage added:** 18+ injection resistance tests in `__tests__/sql-hardening.test.ts`
  covering AC-006 through AC-015. (task-017)
```

---

## 6. Acceptance Criteria Traceability

| AC     | Requirement                                                  | Test Design                          |
| ------ | ------------------------------------------------------------ | ------------------------------------ |
| AC-001 | runSQL executes DDL                                          | Happy path: CREATE TABLE test        |
| AC-002 | runSQL executes DML with params                              | Happy path: INSERT with ? params     |
| AC-003 | getSQL returns single row or null                            | Happy path: SELECT + null case       |
| AC-004 | allSQL returns array or []                                   | Happy path: multi-row SELECT + empty |
| AC-005 | All methods pass params via args, not interpolation          | Script integrity spy test            |
| AC-006 | SQL with `'` doesn't break Python                            | Injection resistance test            |
| AC-007 | SQL with `\'` doesn't break Python                           | FINDING-001 regression test          |
| AC-008 | SQL with `\n` executes correctly                             | Multi-line SQL test                  |
| AC-009 | Params with `'` or `\` don't alter SQL                       | Param injection resistance           |
| AC-010 | Injection payload in params treated as literal               | DROP TABLE payload test              |
| AC-011 | No `.replace(/'/g, ...)` in the three methods                | Grep assertion (can be static)       |
| AC-012 | SQL base64-encoded via `Buffer.from(sql).toString("base64")` | Script integrity spy                 |
| AC-013 | Params JSON+base64 encoded                                   | Script integrity spy                 |
| AC-014 | Python decodes via `base64.b64decode`                        | Script integrity spy                 |
| AC-015 | SQLite uses `db.execute(sql, params)` parameterised form     | Implicit: correct results            |

---

## 7. Static Verification (No Runtime)

AC-011 can be verified statically — a grep check in CI or as a test:

```typescript
it("no escape-based SQL handling (AC-011 static check)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../cortex-bridge.ts", import.meta.url), "utf8");

  // Extract only the runSQL/getSQL/allSQL method bodies (lines 1124–1175)
  // Check they contain no replace-based escaping
  expect(src).not.toMatch(/\.replace\(\/'\//); // No /.replace(/'/g, ...)/ in source
});
```

This is a strong negative assertion. Any regression restoring the old pattern will break this test even without a running DB.

---

## 8. Build Stage Deliverables

The build stage must produce:

| Deliverable     | Path                                                     | Notes                     |
| --------------- | -------------------------------------------------------- | ------------------------- |
| Test file       | `__tests__/sql-hardening.test.ts`                        | ≥18 tests, all passing    |
| CHANGELOG entry | `CHANGELOG.md`                                           | In `[2.7.2]` section      |
| Test run output | `pipeline/task-017-bridge-sql-hardening/build-report.md` | Pass/fail counts, timings |

---

## 9. Build Stage Constraints

1. **No new TypeScript types or interfaces** — fix is implementation-only (NFR-011)
2. **Python 3 must be available** — subprocess tests skip gracefully if `python3` not found (with `it.skipIf`)
3. **Tests must not mutate production DB** — `CORTEX_DATA_DIR` must point to temp dir for all subprocess tests
4. **All 703 existing tests must continue to pass** — no regressions
5. **Vitest timeout override required** — subprocess tests need `{ timeout: 10_000 }` on slow adversarial tests

---

## 10. Behavioral Signature (Version Forensics)

**Log patterns if test suite is healthy:**

```
✓ SQL Hardening — Bridge Base64 Encoding (18 tests) — all pass
# No "SyntaxError" in test output
# No "Python subprocess error" in test output
```

**Failure mode if fix were reverted:**

- `backslash-quote bypass` test fails with: `Error: Python subprocess exited with code 1` + `SyntaxError: EOL while scanning string literal`
- Script integrity test fails: `AssertionError: expected script to not contain raw SQL`

**Rollback plan:**

- Delete `__tests__/sql-hardening.test.ts` (revert build stage only)
- The fix itself (commit 3f25091b4) is separate and should remain unless explicitly reverted

---

_Design complete. Proceeding to build stage._
