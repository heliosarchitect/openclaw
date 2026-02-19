# Documentation: Comprehensive Test Coverage — Cortex Foundation Tests

**Task ID:** task-016-test-coverage  
**Phase:** 5.4  
**Stage:** document  
**Status:** COMPLETE  
**Date:** 2026-02-19  
**Author:** Helios Pipeline Orchestrator

---

## 1. Purpose

This document serves as the canonical technical reference for the Cortex test coverage backfill initiative (task-016). It defines:

- The complete inventory of source modules vs. test coverage (before and after)
- Test infrastructure architecture and shared fixture design
- Per-module behavioral signatures (grep-able after the fact)
- Failure mode catalog with debugging hooks
- Developer guide for adding future tests
- Versioned coverage baseline for regression detection

This document is the `document` stage artifact and gates the `build` stage.

---

## 2. Context: Why Now

Cortex has evolved through 16 pipeline tasks (v1.0.0 → v2.4.0) and accumulated 55 TypeScript source files with no corresponding test coverage. Each new pipeline task added tests for its own feature slice but left foundational infrastructure untested. The risk surface includes:

| Risk                               | Impact                                              |
| ---------------------------------- | --------------------------------------------------- |
| `cortex-bridge.ts` silently broken | All memory operations fail; no signal until runtime |
| Pipeline state.json write bug      | Stage never advances; pipeline halts                |
| SOP parser regression              | Knowledge discovery disabled; agent ignores SOPs    |
| Healing runbook crash              | Self-healing fails; incidents go unresolved         |
| Predictive adapter fails           | Insights stop generating; briefings empty           |

A single bad refactor touching `cortex-bridge.ts` or `pipeline/state.json` would cascade silently through the entire stack.

---

## 3. Test Infrastructure

### 3.1 Framework

| Component            | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| Runner               | vitest 2.x (already in root `devDependencies`)                                  |
| Root config          | `~/Projects/helios/vitest.config.ts` — auto-discovers `extensions/**/*.test.ts` |
| TypeScript execution | `tsx` (via vitest's default)                                                    |
| Pool                 | `forks` (isolates each test file in a subprocess)                               |
| Per-file timeout     | 30 seconds                                                                      |
| Coverage provider    | `@vitest/coverage-v8`                                                           |

### 3.2 Cortex-Local Package Scripts

The cortex `package.json` receives these additions during the build stage:

```json
{
  "scripts": {
    "test": "vitest run --project=cortex",
    "test:coverage": "vitest run --coverage --reporter=text extensions/cortex/",
    "test:fast": "vitest run extensions/cortex/"
  }
}
```

These enable targeted cortex-only runs without running the entire Helios test suite.

### 3.3 Shared Test Fixtures

Location: `extensions/cortex/__tests__/fixtures/`

| Fixture File         | Exports                            | Purpose                                                                                                                                        |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `brain-db.mock.ts`   | `createMockDb()`                   | Returns a vitest-compatible SQLite stub using `vi.mock('better-sqlite3')`. Exposes `prepare()`, `exec()`, `transaction()` as jest-style mocks. |
| `cortex-memory.ts`   | `createMemory(overrides?)`         | Factory for `CortexMemory` objects with sensible defaults; accepts partial override.                                                           |
| `pipeline-state.ts`  | `createPipelineState(overrides?)`  | Factory for `PipelineState` with at least one active task. Writes to a temp dir for isolation.                                                 |
| `synapse-message.ts` | `createSynapseMessage(overrides?)` | Factory for `SynapseMessage` records used by Synapse tests.                                                                                    |
| `sop-document.ts`    | `createSopDocument(overrides?)`    | Factory for parsed `.ai.sop` documents with sensible default trigger categories.                                                               |
| `process-env.ts`     | `withEnv(overrides, fn)`           | Sets env vars for the duration of `fn`, restores originals on cleanup. Prevents env pollution between tests.                                   |

### 3.4 Mock Boundaries

Every test in this suite must mock at these exact boundaries — no exceptions:

| Boundary                          | Mock Strategy                                                | Why                                         |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `brain.db` (SQLite)               | `vi.mock('better-sqlite3')` with `createMockDb()`            | Prevents writes to real database            |
| `node:child_process` (spawn/exec) | `vi.mock('node:child_process')` per test                     | Runbooks/bridge spawn real processes        |
| Filesystem reads/writes           | `vi.mock('node:fs/promises')` or `tmp` dir via `os.tmpdir()` | State.json tests need isolated files        |
| HTTP/fetch                        | `vi.fn()` passed as `fetchFn` constructor arg                | All adapters accept injected fetch          |
| OpenClaw plugin API               | `vi.mock('openclaw/plugin-sdk')`                             | Prevents gateway calls                      |
| Python cortex-bridge spawn        | `vi.spyOn(child_process, 'spawn')` with EventEmitter         | Simulates `cortex-bridge.py` stdout/stderr  |
| `~/bin/` scripts                  | Subprocess spawn with `BRAIN_DB` env override                | Bash scripts need real subprocess isolation |

---

## 4. Module Coverage Inventory

### 4.1 Before task-016

| Module Group                     | Source Files | Existing Tests | Gap               |
| -------------------------------- | ------------ | -------------- | ----------------- |
| `abstraction/`                   | 8            | 7              | ✅ Well covered   |
| `adversarial/`                   | 6            | 5 (suites)     | ✅ Well covered   |
| `cortex-bridge.ts`               | 1            | 0              | ❌ Zero coverage  |
| `cross-domain/`                  | 13           | 1              | ⚠️ Partial        |
| `healing/runbooks/`              | 12           | 4              | ⚠️ 8 missing      |
| `healing/probes/`                | 6            | 3              | ⚠️ 3 missing      |
| `healing/` (core)                | 6            | 5              | ✅ Mostly covered |
| `hooks/`                         | 4            | 3              | ⚠️ 1 missing      |
| `index.ts`                       | 1            | 0              | ❌ Zero coverage  |
| `predictive/data-sources/`       | 10           | 0              | ❌ Zero coverage  |
| `predictive/` (core)             | 8            | 8              | ✅ Well covered   |
| `realtime-learning/detection/`   | 5            | 0              | ❌ Zero coverage  |
| `realtime-learning/propagation/` | 4            | 2              | ⚠️ 2 missing      |
| `realtime-learning/` (other)     | 8            | 8              | ✅ Well covered   |
| `session/`                       | 6            | 5              | ✅ Mostly covered |
| `trust/`                         | 10           | 9              | ✅ Well covered   |
| `~/bin/` scripts                 | 6            | 0              | ❌ Zero coverage  |
| **Total**                        | **~118**     | **59**         | **55 gaps**       |

### 4.2 After task-016 (Target)

**36 new test files** added across 10 priority tiers:

| Priority                            | Files Added | Coverage Target  |
| ----------------------------------- | ----------- | ---------------- |
| P1 — cortex-bridge                  | 1           | 85%              |
| P2 — Pipeline orchestrator          | 2           | 80%              |
| P3 — SOP / knowledge-discovery      | 1           | 80%              |
| P4 — Healing runbooks (8 missing)   | 8           | 90%+             |
| P4 — Healing index + probe-registry | 2           | 85%              |
| P5 — Predictive data-sources (10)   | 10          | 80%              |
| P6 — RT-learning detection relays   | 4           | 80%              |
| P7 — Healing probes (3 missing)     | 3           | 85%              |
| P8 — RT-learning propagation (2)    | 2           | 80%              |
| P9 — Trust index                    | 1           | 75%              |
| P10 — `~/bin/` scripts              | 2           | 70%              |
| **Total**                           | **36**      | **90%+ overall** |

---

## 5. Per-Module Behavioral Signatures

These signatures enable forensic debugging 6 months from now. Grep these patterns in test output or source logs to identify which module is exercised.

### 5.1 `cortex-bridge.ts`

```
# Behavioral signature (passing):
✓ cortex-bridge: normalizeCategories returns ['general'] for null input
✓ cortex-bridge: CortexBridge.add() spawns Python with correct args

# Failure signature:
FAIL extensions/cortex/__tests__/cortex-bridge.test.ts
  ● cortex-bridge › add() › spawn error

# Debug hooks:
grep "cortex-bridge" extensions/cortex/__tests__/cortex-bridge.test.ts
grep "spawn" extensions/cortex/cortex-bridge.ts | head -20
```

### 5.2 Pipeline Orchestrator (`state.json`)

```
# Behavioral signature (passing):
✓ state-manager: reads valid state.json correctly
✓ stage-chain: 'pass' result triggers next stage hook

# Failure signature:
FAIL extensions/cortex/pipeline/__tests__/state-manager.test.ts
  ● state-manager › concurrent write protection

# Debug hooks:
grep "stages_completed" ~/Projects/helios/extensions/cortex/pipeline/state.json
cat ~/bin/pipeline-stage-done | head -40
```

### 5.3 SOP / Knowledge Discovery

```
# Behavioral signature (passing):
✓ knowledge-discovery: discovers SOPs from sop/ directory
✓ knowledge-discovery: matches tool call by category keyword

# Failure signature:
FAIL extensions/cortex/hooks/__tests__/knowledge-discovery.test.ts
  ● knowledge-discovery › caches SOP index between calls

# Debug hooks:
ls ~/Projects/helios/extensions/cortex/sop/
grep "mtime" extensions/cortex/hooks/knowledge-discovery.ts
```

### 5.4 Healing Runbooks

```
# Behavioral signature (passing):
✓ rb-db-emergency: execute() returns status='success' on happy path
✓ rb-kill-zombie: execute() does not throw — errors captured in result

# Failure signature:
FAIL extensions/cortex/healing/__tests__/runbooks/rb-gateway-restart.test.ts
  ● rb-gateway-restart › dry-run mode — no side effects

# Debug hooks:
grep "RunbookResult" extensions/cortex/healing/types.ts
grep "execute" extensions/cortex/healing/runbooks/rb-*.ts | grep "async"
```

### 5.5 Predictive Data-Source Adapters

```
# Behavioral signature (passing):
✓ pipeline-adapter: collect() returns InsightRecord[] on success
✓ augur-trades-adapter: collect() returns [] on SQLite error

# Failure signature:
FAIL extensions/cortex/predictive/__tests__/data-sources/fleet-adapter.test.ts
  ● fleet-adapter › collect() handles malformed response gracefully

# Debug hooks:
grep "DataSourceAdapter" extensions/cortex/predictive/data-sources/adapter-interface.ts
grep "fetchFn" extensions/cortex/predictive/data-sources/fleet-adapter.ts
```

### 5.6 RT-Learning Detection Relays

```
# Behavioral signature (passing):
✓ tool-monitor: onEvent() calls downstream handler with transformed payload
✓ pipeline-fail-relay: malformed event → logs error, does not throw

# Failure signature:
FAIL extensions/cortex/realtime-learning/__tests__/detection/trust-event-relay.test.ts
  ● trust-event-relay › disabled flag → events silently dropped

# Debug hooks:
grep "onEvent\|relay" extensions/cortex/realtime-learning/detection/*.ts | head -20
```

---

## 6. Test File Map (Complete)

```
extensions/cortex/
├── __tests__/
│   ├── fixtures/
│   │   ├── brain-db.mock.ts              [NEW - shared SQLite mock factory]
│   │   ├── cortex-memory.ts              [NEW - CortexMemory factory]
│   │   ├── pipeline-state.ts             [NEW - PipelineState factory]
│   │   ├── synapse-message.ts            [NEW - SynapseMessage factory]
│   │   ├── sop-document.ts               [NEW - SOP document factory]
│   │   └── process-env.ts                [NEW - env isolation utility]
│   ├── cortex-bridge.test.ts             [NEW - P1]
│   └── bin/
│       ├── pipeline-stage-done.test.ts   [NEW - P10]
│       └── brain-cli.test.ts             [NEW - P10]
├── pipeline/
│   └── __tests__/
│       ├── state-manager.test.ts         [NEW - P2]
│       └── stage-chain.test.ts           [NEW - P2]
├── hooks/
│   └── __tests__/
│       └── knowledge-discovery.test.ts   [NEW - P3]
├── healing/
│   └── __tests__/
│       ├── probe-registry.test.ts        [NEW - P4]
│       ├── index.test.ts                 [NEW - P4]
│       ├── probes/
│       │   ├── gateway-probe.test.ts     [NEW - P7]
│       │   ├── log-bloat-probe.test.ts   [NEW - P7]
│       │   └── augur-process-probe.test.ts [NEW - P7]
│       └── runbooks/
│           ├── rb-db-emergency.test.ts   [NEW - P4]
│           ├── rb-probe-then-alert.test.ts [NEW - P4]
│           ├── rb-clear-phantom.test.ts  [NEW - P4]
│           ├── rb-kill-zombie.test.ts    [NEW - P4]
│           ├── rb-restart-service.test.ts [NEW - P4]
│           ├── rb-restart-augur.test.ts  [NEW - P4]
│           ├── rb-gateway-restart.test.ts [NEW - P4]
│           └── rb-emergency-cleanup.test.ts [NEW - P4]
├── predictive/
│   └── __tests__/
│       └── data-sources/
│           ├── pipeline-adapter.test.ts       [NEW - P5]
│           ├── git-adapter.test.ts            [NEW - P5]
│           ├── augur-trades-adapter.test.ts   [NEW - P5]
│           ├── augur-regime-adapter.test.ts   [NEW - P5]
│           ├── augur-paper-adapter.test.ts    [NEW - P5]
│           ├── augur-signals-adapter.test.ts  [NEW - P5]
│           ├── fleet-adapter.test.ts          [NEW - P5]
│           ├── octoprint-adapter.test.ts      [NEW - P5]
│           ├── cortex-session-adapter.test.ts [NEW - P5]
│           └── cortex-atoms-adapter.test.ts   [NEW - P5]
├── realtime-learning/
│   └── __tests__/
│       ├── detection/
│       │   ├── tool-monitor.test.ts           [NEW - P6]
│       │   ├── pipeline-fail-relay.test.ts    [NEW - P6]
│       │   ├── hook-violation-relay.test.ts   [NEW - P6]
│       │   └── trust-event-relay.test.ts      [NEW - P6]
│       └── propagation/
│           ├── atom-propagator.test.ts        [NEW - P8]
│           └── cross-system-relay.test.ts     [NEW - P8]
└── trust/
    └── __tests__/
        └── index.test.ts                      [NEW - P9]
```

**36 new test files. 6 new fixture files. Total post-task: ~95 test files.**

---

## 7. Failure Mode Catalog

| Failure Mode                                  | Symptom                                                | Root Cause                                                             | Fix                                                                          |
| --------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Mock not reset between tests                  | Test A passes, Test B fails with wrong data            | Missing `vi.resetAllMocks()` in `afterEach`                            | Add `afterEach(() => vi.resetAllMocks())` to test file                       |
| SQLite mock not injected                      | `ENOENT: brain.db not found`                           | Test calling real `createMockDb` but not injecting                     | Pass `createMockDb()` result into constructor or module under test           |
| child_process mock scope leak                 | Unexpected real process spawn                          | `vi.mock` hoisted but not scoped to test file                          | Move `vi.mock('node:child_process')` to top of test file, outside `describe` |
| Pipeline state race                           | `current_stage` not updated                            | `state.json` written but task lookup used wrong field                  | Check `active_tasks[].task_id` filter in `state-manager.test.ts`             |
| Bash script test flake                        | `pipeline-stage-done` exits 0 but doesn't update state | Temp dir not correctly pointed to by `HELIOS_PIPELINE_DIR` env         | Verify `withEnv({ HELIOS_PIPELINE_DIR: tmpdir })` wraps spawn                |
| TypeScript type errors on new test files      | `pnpm tsc --noEmit` fails                              | Fixture returns `any`; vitest types not imported                       | Import `{ describe, it, expect, vi }` from `'vitest'`; type fixture returns  |
| Vitest picks up adversarial tests as coverage | Coverage inflated                                      | Adversarial `.test.ts` files in `adversarial/suites/` are non-standard | Exclude `adversarial/suites/**` from coverage reporter                       |

---

## 8. Coverage Configuration

Add to `vitest.config.ts` (or cortex local config) to enforce thresholds:

```typescript
coverage: {
  provider: 'v8',
  include: ['extensions/cortex/**/*.ts'],
  exclude: [
    'extensions/cortex/**/*.test.ts',
    'extensions/cortex/**/__tests__/**',
    'extensions/cortex/**/types.ts',      // type-only files
    'extensions/cortex/**/schema.ts',     // zod schema files
    'extensions/cortex/adversarial/**',   // chaos harness, not prod code
    'extensions/cortex/**/migration-*.ts' // migration scripts
  ],
  thresholds: {
    lines: 90,
    functions: 85,
    branches: 80,
    statements: 90
  },
  reporter: ['text', 'html', 'json']
}
```

Coverage HTML report location: `~/Projects/helios/coverage/cortex/index.html`

---

## 9. Developer Guide — Adding Tests for Future Modules

When a new Cortex module is added, follow this checklist:

### 9.1 Standard Test File Template

```typescript
// extensions/cortex/<module>/__tests__/<filename>.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockDb } from "../../__tests__/fixtures/brain-db.mock";
import { withEnv } from "../../__tests__/fixtures/process-env";

// Mock boundaries — always at top level, outside describe()
vi.mock("better-sqlite3");
vi.mock("node:child_process");

describe("<ModuleName>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("<methodName>()", () => {
    it("returns expected output on happy path", () => {
      // Arrange
      const db = createMockDb();
      // ... setup

      // Act
      const result = someFunction(db);

      // Assert
      expect(result).toBeDefined();
      expect(result.status).toBe("success");
    });

    it("handles error gracefully — does not throw", async () => {
      // Arrange
      vi.mocked(someAsyncThing).mockRejectedValue(new Error("test error"));

      // Act & Assert
      await expect(async () => someFunction()).not.toThrow();
    });
  });
});
```

### 9.2 Rules

1. **No `it.skip` or `xit`** — skipped tests are tech debt; fix or delete
2. **Every `it()` must have at least one `expect()`** — no vacuous tests
3. **Mock at module level, reset in `beforeEach`** — prevents cross-test pollution
4. **Use `withEnv()` for env var dependencies** — never mutate `process.env` directly
5. **Use `os.tmpdir()` for file system tests** — never write to real workspace dirs
6. **Adapter tests inject `fetchFn` parameter** — never stub `globalThis.fetch` globally
7. **TypeScript must compile** — run `pnpm tsc --noEmit` before marking build complete

### 9.3 Runbook Test Template

Each runbook follows this standard pattern (reduces boilerplate for 12 files):

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RbXxx } from "../../runbooks/rb-xxx";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

describe("RbXxx", () => {
  let runbook: RbXxx;

  beforeEach(() => {
    vi.clearAllMocks();
    runbook = new RbXxx();
  });

  it("execute() returns status=success on happy path", async () => {
    vi.mocked(execFile).mockImplementation((cmd, args, cb) => {
      cb(null, "ok", "");
    });
    const result = await runbook.execute({});
    expect(result.status).toBe("success");
    expect(result.logs.length).toBeGreaterThan(0);
  });

  it("execute() returns status=failed when command fails", async () => {
    vi.mocked(execFile).mockImplementation((cmd, args, cb) => {
      cb(new Error("fail"), "", "error");
    });
    const result = await runbook.execute({});
    expect(result.status).toBe("failed");
  });

  it("execute() does not throw — errors are captured in result", async () => {
    vi.mocked(execFile).mockRejectedValue(new Error("unexpected"));
    await expect(runbook.execute({})).resolves.toBeDefined();
  });
});
```

### 9.4 Adapter Test Template

```typescript
import { describe, it, expect, vi } from "vitest";
import { XxxAdapter } from "../../data-sources/xxx-adapter";

const mockFetch = vi.fn();

describe("XxxAdapter", () => {
  const adapter = new XxxAdapter({ fetchFn: mockFetch });

  beforeEach(() => mockFetch.mockReset());

  it("implements DataSourceAdapter interface", () => {
    expect(typeof adapter.collect).toBe("function");
    expect(typeof adapter.name).toBe("string");
  });

  it("collect() returns InsightRecord[] on success", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    const results = await adapter.collect();
    expect(Array.isArray(results)).toBe(true);
  });

  it("collect() returns [] on HTTP error — does not throw", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const results = await adapter.collect();
    expect(results).toEqual([]);
  });
});
```

---

## 10. Rollback Plan

If the build stage introduces test files that break the existing 59-test suite:

1. `git diff --name-only HEAD` — identify new test files
2. `pnpm vitest run extensions/cortex/` — run only cortex tests to isolate failures
3. `git stash extensions/cortex/__tests__/` — stash new files, verify existing suite still passes
4. Fix root cause (usually: a new test that imports a module with side effects at import time)
5. Re-apply stash and fix with `vi.mock()` at top level

If TypeScript compilation breaks:

```bash
cd ~/Projects/helios
pnpm tsc --noEmit 2>&1 | grep "extensions/cortex" | head -20
```

Common causes: fixture exports typed as `any`, missing `vitest` import for `vi` type, incorrect mock factory return type.

---

## 11. Definition of Done

Build stage completes when ALL of the following are true:

- [ ] 36 new test files created (see §6 for complete list)
- [ ] 6 shared fixture files created at `extensions/cortex/__tests__/fixtures/`
- [ ] `pnpm test:fast` passes: zero failures, zero skipped tests
- [ ] `pnpm tsc --noEmit` clean: zero TypeScript errors
- [ ] Coverage report shows ≥ 90% lines on cortex source modules
- [ ] cortex `package.json` has `test`, `test:coverage`, `test:fast` scripts
- [ ] No vacuous tests (every `it()` has ≥ 1 `expect()`)
- [ ] No tests that depend on live I/O (real DB, real HTTP, real process spawn)

---

## 12. Version Forensics

| Version                | What Changed                                                | Behavioral Signature                  |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------- |
| Pre-task-016           | 59 test files, ~55 untested source modules                  | Vitest: 59 files collected            |
| Post-task-016 (build)  | +36 test files, +6 fixtures                                 | Vitest: 95 files collected            |
| Post-task-016 (deploy) | cortex `package.json` updated, coverage thresholds enforced | `pnpm test:coverage` exits 0 at ≥ 90% |

**Regression detection:** If a future pipeline task breaks coverage below 90%, `pnpm test:coverage` will exit non-zero and block the build stage for that task. This is the intended behavior.

---

_Document generated by Helios pipeline orchestrator at 2026-02-19T03:24 America/New_York_
