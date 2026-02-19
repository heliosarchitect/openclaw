# Cortex v2.3.0 — Adversarial Self-Testing Framework

**Released:** 2026-02-18
**Tag:** `cortex-v2.3.0`
**Phase:** 5.3 — Adversarial Self-Testing

---

## Overview

Cortex v2.3.0 ships the **Adversarial Self-Testing (AST) Framework** — a chaos engineering
harness that deliberately attacks Helios to verify its defenses hold. 25 purposeful test cases
across 5 attack categories. All passing.

This is not fuzzing. Each test models a real, named threat vector, applies a targeted stimulus,
and asserts a specific expected defense. A passing test = the attack was correctly detected,
rejected, or recovered from. A failing test = vulnerability report.

---

## What's New

### Adversarial Self-Testing Framework (`adversarial/`)

**5 Attack Categories, 25 Test Cases:**

| Category                  | Tests | What It Validates                                                                                                      |
| ------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| Prompt Injection (PI)     | 5     | EXTERNAL_UNTRUSTED_CONTENT guards, jailbreak resistance, nested tag escape, exfil prevention                           |
| Memory Poisoning (MP)     | 5     | False directive detection, importance manipulation, STM flood prevention, XSS sanitization, DB tampering detection     |
| Tool Fault Injection (TF) | 5     | SQLITE_BUSY retry, exec timeout/cleanup, synapse retry queue, HTTP 500 recovery, partial artifact detection            |
| Pipeline Corruption (PC)  | 5     | Truncated JSON rejection, invalid stage detection, impossible ordering, missing artifact gating, idempotent stage-done |
| Synapse Adversarial (SA)  | 5     | Agent spoofing, OOM payload rejection, SQL injection prevention, rate limiting, webhook source verification            |

**Test Infrastructure:**

- In-memory mocks — production `brain.db` never touched
- Per-test sandboxing — fresh context per test, `/tmp/ast-{runId}-*` cleaned on completion
- Behavioral assertions — silent bypass = test failure (not just detection signals)
- CLI flags: `--critical-only`, `--no-cortex`, `--json-only` for CI integration

**pnpm Scripts:**

```bash
pnpm test:adversarial           # Full suite (with Cortex reporting)
pnpm test:adversarial:ci        # Full suite (JSON-only, no Cortex)
pnpm test:adversarial:critical  # Critical-only subset (fast)
```

### Automated Schedules

| Schedule             | What Runs            | Alert Routing                                            |
| -------------------- | -------------------- | -------------------------------------------------------- |
| Weekly (Sun 3:00 AM) | Full 25-test suite   | CRITICAL → Synapse urgent + Matthew; HIGH → Synapse only |
| Daily (4:05 AM)      | Critical-only subset | Any failure → Synapse urgent + Matthew                   |

### Security Hardening

- Added `.gitignore`: `adversarial/reports/`, `adversarial/adversarial-results.json`
  — raw adversarial payloads (SQL injections, XSS, prompt injections) stay off version control
- `adversarial/reports/` directory created for output artifacts

---

## Known Limitations (Post-Deploy Backlog)

| ID    | Description                                                                                     | Priority |
| ----- | ----------------------------------------------------------------------------------------------- | -------- |
| F-001 | Cortex reporter stores raw payloads if tests fail — must sanitize before first failure          | P1       |
| F-002 | PI-004 assertion incomplete — doesn't call processExternalContent on post-fake-close content    | P2       |
| F-003 | Mock deduplication (substring) diverges from production (embeddings) — semantic floods untested | P2       |
| F-005 | `corrupt_json` in FaultInjector missing try-catch                                               | P3       |
| F-006 | SA-004 rate limiter uses real clock — could be flaky under GC pressure                          | P4       |

F-001 must be addressed before any adversarial test failure is expected in production.

---

## Test Results at Release

```
Run ID: 0b3db673
Verdict: PASS  |  ✅ 25  ❌ 0  💥 0  ⏭️ 0
Duration: 5,575ms
TypeScript: 0 errors (pnpm tsc --noEmit)
Sandbox: clean (no production state contact)
```

---

## Upgrade Notes

No breaking changes. The `adversarial/` module is purely additive — no existing functionality
is modified. Existing tests and cron jobs are unaffected.

To manually run the adversarial suite:

```bash
cd ~/Projects/helios/extensions/cortex
pnpm test:adversarial:ci
```

---

## What's Next

**Cortex Phase 5.4 — Knowledge Compression & Abstraction Engine** (task-008):

- Long-term memory compression via semantic abstraction
- Pattern extraction from STM clusters
- Episodic → semantic memory promotion pipeline

---

_Released by the LBF Development Pipeline_
_Commit: 25a1341ef | All stages: requirements → design → document → build → security → test → deploy → done_
