# Design: Comprehensive Test Coverage — Cortex Foundation Tests

**Task ID:** task-016-test-coverage  
**Phase:** 5.4  
**Stage:** design  
**Status:** COMPLETE  
**Date:** 2026-02-19

---

## 1. Overview

This design defines the architecture, test strategies, mock patterns, and file layout for achieving 90%+ test coverage across all Cortex TypeScript modules. 55 source files currently have no unit tests. This task backfills them systematically using vitest with vi.mock isolation.

---

## 2. Test Infrastructure

### 2.1 Runner

| Setting    | Value                                                                |
| ---------- | -------------------------------------------------------------------- |
| Framework  | vitest (already in root devDependencies)                             |
| Config     | Parent `vitest.config.ts` already includes `extensions/**/*.test.ts` |
| TypeScript | `tsx` for imports; `pnpm tsc --noEmit` for type validation           |
| Pool       | `forks` (inherited from root config)                                 |
| Timeout    | 30s per test file                                                    |

### 2.2 Package.json Scripts (cortex)

Add to `extensions/cortex/package.json`:

```json
{
  "scripts": {
    "test": "vitest run --project=cortex",
    "test:coverage": "vitest run --coverage --reporter=text extensions/cortex/",
    "test:fast": "vitest run extensions/cortex/"
  }
}
```

> **Note:** The parent vitest config already picks up `extensions/**/*.test.ts`, so tests are runnable via root `pnpm test:fast` without a separate cortex config. The cortex-local scripts provide targeted running.

### 2.3 Mock Boundaries

All unit tests must mock at these boundaries:

| Boundary                          | Mock Method                                       |
| --------------------------------- | ------------------------------------------------- |
| `brain.db` (SQLite)               | `vi.mock('better-sqlite3')` with in-memory stub   |
| Child processes (`spawn`, `exec`) | `vi.mock('node:child_process')`                   |
| File system reads/writes          | `vi.mock('node:fs/promises')` or temp dir         |
| HTTP/fetch (adapters)             | `vi.mock('node:http')` or `globalThis.fetch` stub |
| OpenClaw plugin API               | `vi.mock('openclaw/plugin-sdk')`                  |
| `~/bin/` scripts                  | Bash script unit tests via `exec` with temp env   |
| `cortex-bridge.ts` Python spawn   | `vi.spyOn(child_process, 'spawn')`                |

### 2.4 Shared Test Fixtures

Create `extensions/cortex/__tests__/fixtures/`:

```
fixtures/
  brain-db.mock.ts      — SQLite mock factory (createMockDb())
  cortex-memory.ts      — CortexMemory factory (createMemory(overrides?))
  pipeline-state.ts     — PipelineState factory
  synapse-message.ts    — SynapseMessage factory
  sop-document.ts       — Parsed SOP document factory
  process-env.ts        — Safe env variable reset utility
```

---

## 3. Module Coverage Plan

### Priority 1 — Critical Foundation (cortex-bridge.ts)

**File:** `cortex-bridge.ts`  
**Test:** `__tests__/cortex-bridge.test.ts`

Test cases:

```
normalizeCategories()
  ✓ null/undefined → ['general']
  ✓ string → [string]
  ✓ [] → ['general']
  ✓ ['a', 'b'] → ['a', 'b']

categoriesMatch()
  ✓ no filter → always true
  ✓ single category match
  ✓ multi-category OR match
  ✓ no match → false

CortexBridge class
  ✓ constructor reads brain.db path from env/default
  ✓ add() calls Python bridge with correct args
  ✓ search() parses JSON output correctly
  ✓ search() handles malformed JSON gracefully
  ✓ stm() returns array of CortexMemory objects
  ✓ spawn error → throws with descriptive message
  ✓ empty result → returns []
```

**Strategy:** Mock `node:child_process` spawn to return controlled stdout. Use `EventEmitter` to simulate process lifecycle.

---

### Priority 2 — Pipeline Orchestrator

**Files:** `pipeline/state.json` management + `~/bin/pipeline-stage-done`  
**Tests:**

- `pipeline/__tests__/state-manager.test.ts` — state.json read/write/update
- `pipeline/__tests__/stage-chain.test.ts` — stage chaining logic

The orchestrator is shell-based (`~/bin/pipeline-stage-done`). Tests target the state management logic baked into pipeline stages.

Test cases:

```
State management
  ✓ reads valid state.json correctly
  ✓ adds stage to stages_completed
  ✓ updates current_stage
  ✓ adds artifact path to artifacts map
  ✓ handles missing task in active_tasks gracefully
  ✓ concurrent write protection (file lock)
  ✓ invalid JSON → throws with context

Stage chaining
  ✓ 'pass' result → triggers next stage hook
  ✓ 'fail' result → stops chain, posts alert
  ✓ 'blocked' result → stops chain, posts alert
  ✓ 'done' stage → bumps semver, posts release
  ✓ unknown stage → does nothing
```

**Strategy:** Use temp directory with a mock `state.json`. Test state mutations by reading the file after each operation.

---

### Priority 3 — SOP Parser/Enforcement

**Files:** `sop/` (parsing logic), `hooks/knowledge-discovery.ts`  
**Tests:**

- `hooks/__tests__/knowledge-discovery.test.ts`

The `.ai.sop` format is parsed via the enforcement engine. Tests target the SOP loading and matching:

```
knowledge-discovery.ts
  ✓ discovers SOPs from sop/ directory
  ✓ matches tool call by category keyword
  ✓ returns empty array when no SOP matches
  ✓ caches SOP index between calls
  ✓ re-reads on file change (mtime check)
  ✓ malformed SOP file → logs warning, continues
```

**Strategy:** Create synthetic `.ai.sop` files in a temp dir. Mock `fs.readdir` to point to temp dir.

---

### Priority 4 — Healing Runbooks (12 variants)

**Files:** `healing/runbooks/*.ts` (12 files currently untested)  
**Test:** `healing/__tests__/runbooks/` (add missing ones)

Currently tested: `rb-force-gc`, `rb-gc-trigger`, `rb-rotate-logs`, `rb-kick-pipeline`  
Missing: `rb-db-emergency`, `rb-probe-then-alert`, `rb-clear-phantom`, `rb-kill-zombie`, `rb-restart-service`, `rb-restart-augur`, `rb-gateway-restart`, `rb-emergency-cleanup`

Standard runbook test pattern (per file):

```
rb-<name>.test.ts
  ✓ execute() returns RunbookResult with status='success' on happy path
  ✓ execute() returns status='failed' when underlying command fails
  ✓ execute() does not throw — errors are captured in result
  ✓ dry-run mode (if applicable) — no side effects
  ✓ result includes log lines for audit trail
```

**Strategy:** Mock `exec`/`spawn` to return success/failure. Each runbook test is <30 lines.

Also add missing healing module tests:

**`probe-registry.ts`** → `healing/__tests__/probe-registry.test.ts`

```
  ✓ registers probe by name
  ✓ run() calls probe.check() and returns ProbeResult
  ✓ runAll() collects results for all registered probes
  ✓ unknown probe name → throws ProbeNotFoundError
```

**`healing/index.ts`** → `healing/__tests__/index.test.ts`

```
  ✓ exports all expected symbols
  ✓ IncidentManager, RunbookExecutor, EscalationRouter are exported
```

---

### Priority 5 — Predictive Data-Source Adapters (9 files)

**Files:** `predictive/data-sources/*.ts` (9 adapters)  
**Tests:** `predictive/__tests__/data-sources/` (new directory)

Standard adapter test pattern:

```
<adapter-name>.test.ts
  ✓ implements DataSourceAdapter interface (has collect() method)
  ✓ collect() returns InsightRecord[] on success
  ✓ collect() returns [] on HTTP error (not throw)
  ✓ collect() returns [] when source file missing
  ✓ collect() handles malformed response gracefully
  ✓ adapter name matches expected string constant
```

Individual adapter specifics:

- `pipeline-adapter` → mocks `state.json` read
- `git-adapter` → mocks `exec('git log ...')`
- `augur-*` adapters → mock SQLite query results
- `fleet-adapter` → mocks `fetch()` to fleet API
- `octoprint-adapter` → mocks `fetch()` to OctoPrint API
- `cortex-session-adapter` → mocks session history file
- `cortex-atoms-adapter` → mocks atom DB query

---

### Priority 6 — Realtime-Learning Detection Relays (4 files)

**Files:**

- `realtime-learning/detection/tool-monitor.ts`
- `realtime-learning/detection/pipeline-fail-relay.ts`
- `realtime-learning/detection/hook-violation-relay.ts`
- `realtime-learning/detection/trust-event-relay.ts`

**Tests:** `realtime-learning/__tests__/detection/` (new directory)

Test pattern (relay modules are thin event forwarders):

```
<relay>.test.ts
  ✓ onEvent() calls downstream handler with transformed payload
  ✓ malformed event → logs error, does not throw
  ✓ disabled flag → events silently dropped
  ✓ relay preserves timestamp and source fields
```

---

### Priority 7 — Healing Probes (missing ones)

**Files:** `healing/probes/gateway-probe.ts`, `log-bloat-probe.ts`, `augur-process-probe.ts`  
**Tests:** `healing/__tests__/probes/`

Currently missing probes (3 of 6):

```
gateway-probe.test.ts
  ✓ check() pings gateway and returns UP on 200
  ✓ check() returns DOWN on connection refused
  ✓ check() returns DEGRADED on timeout

log-bloat-probe.test.ts
  ✓ check() returns UP when log files < threshold
  ✓ check() returns DEGRADED when any log > 100MB
  ✓ check() returns DOWN when disk near capacity

augur-process-probe.test.ts
  ✓ check() finds augur process via ps
  ✓ check() returns DOWN when process not found
  ✓ check() returns DEGRADED on zombie state
```

---

### Priority 8 — Realtime-Learning Propagation Modules

**Files:**

- `realtime-learning/propagation/atom-propagator.ts`
- `realtime-learning/propagation/cross-system-relay.ts`

**Tests:** New entries in `realtime-learning/__tests__/`

```
atom-propagator.test.ts
  ✓ propagate() creates atom from correction event
  ✓ propagate() skips if atom already exists (dedup)
  ✓ propagate() links new atom to causal chain

cross-system-relay.test.ts
  ✓ relay() forwards event to configured downstream
  ✓ relay() handles offline downstream gracefully
  ✓ relay() respects system-specific payload transforms
```

---

### Priority 9 — Trust Module Index + Types

**Files:** `trust/index.ts`, `trust/types.ts`  
**Tests:** `trust/__tests__/index.test.ts`

```
  ✓ exports TrustScore, TrustGate, TrustMilestone types
  ✓ exports createTrustScore() factory
  ✓ TrustScore default values are correct
  ✓ enum values match expected constants
```

---

### Priority 10 — ~/bin/ Script Tests

**Strategy:** Bash scripts tested via `exec` with mocked environment variables pointing to temp dirs. Shell-native unit tests using `bash -c 'source script; function-name args'` pattern.

**Scripts to cover:**

- `~/bin/pipeline-stage-done` — state update + chain trigger
- `~/bin/brain` — cortex bridge CLI dispatcher
- `~/bin/brain-api` — REST API wrapper
- `~/bin/brain-test-all` — test runner aggregator
- `~/bin/brain-qa-cron` — QA scheduling logic
- `~/bin/brain-embed-cron` — embedding generation scheduling

**Test file:** `extensions/cortex/__tests__/bin/` (TypeScript tests that spawn scripts with mocked env)

```
pipeline-stage-done.test.ts
  ✓ 'pass' result → updates state.json current_stage
  ✓ 'fail' result → does not advance stage
  ✓ missing task_id → exits with error code 1
  ✓ invalid stage name → exits with error code 1
  ✓ state.json not found → exits with helpful error message
  ✓ concurrent runs: second invocation detects lock and waits

brain-cli.test.ts
  ✓ 'add' subcommand → calls cortex-bridge add()
  ✓ 'search' subcommand → prints results as JSON
  ✓ 'stm' subcommand → prints recent memories
  ✓ missing subcommand → prints usage and exits 1
  ✓ BRAIN_DB env override → uses custom path
```

---

## 4. Test File Map

```
extensions/cortex/
├── __tests__/
│   ├── fixtures/
│   │   ├── brain-db.mock.ts
│   │   ├── cortex-memory.ts
│   │   ├── pipeline-state.ts
│   │   └── sop-document.ts
│   ├── cortex-bridge.test.ts          [NEW - Priority 1]
│   └── bin/
│       ├── pipeline-stage-done.test.ts [NEW - Priority 10]
│       └── brain-cli.test.ts           [NEW - Priority 10]
├── pipeline/
│   └── __tests__/
│       ├── state-manager.test.ts       [NEW - Priority 2]
│       └── stage-chain.test.ts         [NEW - Priority 2]
├── hooks/
│   └── __tests__/
│       └── knowledge-discovery.test.ts [NEW - Priority 3]
├── healing/
│   └── __tests__/
│       ├── probe-registry.test.ts      [NEW - Priority 4]
│       ├── index.test.ts              [NEW - Priority 4]
│       ├── probes/
│       │   ├── gateway-probe.test.ts  [NEW - Priority 7]
│       │   ├── log-bloat-probe.test.ts [NEW - Priority 7]
│       │   └── augur-process-probe.test.ts [NEW - Priority 7]
│       └── runbooks/
│           ├── rb-db-emergency.test.ts     [NEW - Priority 4]
│           ├── rb-probe-then-alert.test.ts [NEW - Priority 4]
│           ├── rb-clear-phantom.test.ts    [NEW - Priority 4]
│           ├── rb-kill-zombie.test.ts      [NEW - Priority 4]
│           ├── rb-restart-service.test.ts  [NEW - Priority 4]
│           ├── rb-restart-augur.test.ts    [NEW - Priority 4]
│           ├── rb-gateway-restart.test.ts  [NEW - Priority 4]
│           └── rb-emergency-cleanup.test.ts [NEW - Priority 4]
├── predictive/
│   └── __tests__/
│       └── data-sources/
│           ├── pipeline-adapter.test.ts    [NEW - Priority 5]
│           ├── git-adapter.test.ts         [NEW - Priority 5]
│           ├── augur-trades-adapter.test.ts [NEW - Priority 5]
│           ├── augur-regime-adapter.test.ts [NEW - Priority 5]
│           ├── augur-paper-adapter.test.ts  [NEW - Priority 5]
│           ├── augur-signals-adapter.test.ts [NEW - Priority 5]
│           ├── fleet-adapter.test.ts        [NEW - Priority 5]
│           ├── octoprint-adapter.test.ts    [NEW - Priority 5]
│           ├── cortex-session-adapter.test.ts [NEW - Priority 5]
│           └── cortex-atoms-adapter.test.ts [NEW - Priority 5]
├── realtime-learning/
│   └── __tests__/
│       ├── detection/
│       │   ├── tool-monitor.test.ts         [NEW - Priority 6]
│       │   ├── pipeline-fail-relay.test.ts  [NEW - Priority 6]
│       │   ├── hook-violation-relay.test.ts [NEW - Priority 6]
│       │   └── trust-event-relay.test.ts    [NEW - Priority 6]
│       └── propagation/
│           ├── atom-propagator.test.ts      [NEW - Priority 8]
│           └── cross-system-relay.test.ts   [NEW - Priority 8]
└── trust/
    └── __tests__/
        └── index.test.ts                    [NEW - Priority 9]
```

**Total new test files: 36**  
**Existing test files: 59**  
**Post-task total: ~95 test files**

---

## 5. Coverage Estimation

| Module Group                     | Source Files | Current Tests | New Tests | Estimated Coverage |
| -------------------------------- | ------------ | ------------- | --------- | ------------------ |
| cortex-bridge                    | 1            | 0             | 1         | 85%                |
| Pipeline orchestrator            | 1 (shell)    | 0             | 2         | 80%                |
| SOP parser / knowledge-discovery | 1            | 0             | 1         | 80%                |
| Healing runbooks (all 12)        | 12           | 4             | 8         | 90%+               |
| Probe registry + index           | 2            | 0             | 2         | 85%                |
| Healing probes (missing 3)       | 3            | 3             | 3         | 85%                |
| Predictive data-sources (all 9)  | 9            | 0             | 9         | 80%                |
| RT-learning detection relays     | 4            | 0             | 4         | 80%                |
| RT-learning propagation          | 2            | 0             | 2         | 80%                |
| Trust index/types                | 2            | 0             | 1         | 75%                |
| ~/bin/ scripts                   | 6            | 0             | 2         | 70%                |

**Overall target: 90%+ lines covered** across all cortex `.ts` files (excluding type-only files).

---

## 6. Implementation Order

The build stage will implement in this order (matches priority):

1. Fixtures + test infrastructure (`__tests__/fixtures/`)
2. `cortex-bridge.test.ts` (most critical, highest value)
3. Pipeline state manager tests
4. Missing runbook tests (8 files, quick to write)
5. Probe tests (3 files)
6. Predictive adapter tests (10 files, template-driven)
7. Realtime-learning detection tests (4 files)
8. Realtime-learning propagation tests (2 files)
9. Trust index test
10. `~/bin/` script tests
11. `package.json` script additions

---

## 7. Risk & Mitigations

| Risk                                                           | Mitigation                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `cortex-bridge.ts` spawns Python — hard to mock                | Use `vi.mock('node:child_process')` + EventEmitter simulation                   |
| `~/bin/` scripts are bash — TypeScript tests can't import them | Spawn scripts in subprocess, mock env vars, check exit codes + stdout           |
| Healing runbooks call `exec` with real commands                | Mock `execAsync` at module level with `vi.mock`                                 |
| Predictive adapters hit live APIs                              | All adapters accept injected `fetchFn`, mock via `vi.fn()`                      |
| Pipeline state.json concurrent writes                          | Tests run sequentially via isolated temp dirs                                   |
| TypeScript strict mode on types-only files                     | Add `@ts-expect-error` where intentional, or export a no-op to satisfy coverage |

---

## 8. Definition of Done

- [ ] 36 new test files created
- [ ] All tests pass: `pnpm test:fast` (zero failures)
- [ ] TypeScript clean: `pnpm tsc --noEmit`
- [ ] Coverage report shows ≥ 90% lines on cortex modules
- [ ] cortex `package.json` has `test` + `test:coverage` scripts
- [ ] No skipped tests (no `it.skip` or `xit`)
- [ ] No tests that pass vacuously (zero assertions) — all use `expect()`
