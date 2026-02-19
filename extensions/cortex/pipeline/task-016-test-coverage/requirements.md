# Requirements: Comprehensive Test Coverage — Cortex Foundation Tests

**Task ID:** task-016-test-coverage  
**Phase:** 5.4  
**Stage:** requirements  
**Status:** COMPLETE  
**Date:** 2026-02-19

---

## 1. Problem Statement

Cortex has grown through 16 pipeline tasks to v2.4.0. While individual feature tasks included test suites for new functionality, the foundational infrastructure was never systematically tested:

- `cortex-bridge.ts` (core memory bridge, 0 tests)
- Pipeline orchestrator state machine (0 tests)
- SOP parsing/enforcement engine (partial)
- `~/bin/` scripts (0 tests)
- 55 source files currently lack any corresponding test file
- No vitest config in cortex's own `package.json` — tests run through parent vitest root but cortex has no test scripts

**Current state:** 59 test files across the extensions tree, but ~55 source modules remain untested.

**Risk:** Any refactor, migration, or new pipeline task risks silent breakage in untested foundational layers with no immediate signal.

---

## 2. Goals

| #   | Requirement                                                                     | Priority |
| --- | ------------------------------------------------------------------------------- | -------- |
| R1  | 90%+ test coverage on all Cortex TypeScript modules (by line count)             | Critical |
| R2  | Test coverage for `cortex-bridge.ts` — the core memory interface                | Critical |
| R3  | Test coverage for pipeline orchestrator (state.json management, stage chaining) | Critical |
| R4  | Test coverage for SOP parsing: `*.ai.sop` format loading and enforcement        | High     |
| R5  | Test coverage for all `~/bin/` Cortex-adjacent scripts                          | High     |
| R6  | Test coverage for healing runbooks (all 12 variants)                            | High     |
| R7  | Test coverage for predictive data-source adapters (all 9)                       | High     |
| R8  | Test coverage for realtime-learning detection relays (4 relay modules)          | High     |
| R9  | Add `test` and `test:coverage` scripts to cortex `package.json`                 | Medium   |
| R10 | All tests must pass `pnpm tsc --noEmit` type check                              | Critical |

---

## 3. Scope

### In Scope

- All `.ts` files under `extensions/cortex/` with no corresponding `__tests__/*.test.ts`
- `~/bin/` scripts: `pipeline-stage-done`, `brain`, `brain-api`, `brain-test-all`, `brain-qa-cron`, `brain-embed-cron`
- SOP parser/loader for `*.ai.sop` format
- Coverage configuration for cortex-specific threshold reporting

### Out of Scope

- Python modules under `extensions/cortex/python/`
- `.ai.sop` files themselves (content, not code)
- Adversarial runner tests (already covered by adversarial framework itself)
- E2E tests (live OpenClaw gateway, live brain.db)

---

## 4. Constraints

- **No live I/O:** All tests must mock filesystem, child_process, SQLite, and HTTP calls
- **Vitest only:** Must use vitest (already in devDependencies). No Jest.
- **TypeScript strict:** `pnpm tsc --noEmit` must pass on all new test files
- **Isolation:** Each test file must be independently runnable (`vitest run path/to/file`)
- **Speed:** Unit tests must complete in < 30s total (no timeouts)
- **No side effects:** No writes to real `brain.db`, no real process spawning

---

## 5. Acceptance Criteria

1. `pnpm test:fast` includes all new test files and passes 100%
2. Running `vitest run --coverage extensions/cortex/` reports ≥ 90% lines covered
3. TypeScript compilation clean (`pnpm tsc --noEmit`)
4. cortex `package.json` has `"test"` and `"test:coverage"` scripts
5. Pipeline directory artifact present at `pipeline/task-016-test-coverage/`
