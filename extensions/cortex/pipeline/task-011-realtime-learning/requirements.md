# Task-011: Real-Time Learning — Adapt Without Restart — Requirements

**Stage:** requirements | **Status:** pass (reconstructed from IMPROVEMENT_PLAN §5.7)
**Phase:** 5.7 of IMPROVEMENT_PLAN
**Date:** 2026-02-19

---

## Problem Statement

Every mistake Helios makes today is a dead end. The error happens, Matthew corrects it, Helios apologizes, and the system carries on unchanged. The same mistake will happen again — in a different session, in a different context — because nothing was written down, nothing was updated, and nothing was tested.

The core failure mode: **learning is manual and bounded by the session**. When a session ends, the correction evaporates.

Concrete manifestations today:

- Helios uses the wrong path for a binary → Matthew corrects → next session, same wrong path
- A pre-action hook fires with the wrong SOP → Matthew says "that SOP is outdated" → the SOP is never updated in-session
- AUGUR makes a trading error traceable to a missing infrastructure pattern → the pattern never gets added to the infrastructure SOP
- A pipeline stage fails → the failure is noted in Synapse → nobody adds a regression test → the same failure occurs in task-012
- Corrections from Matthew expire from context after ~20 messages → the correction is "lost" before the end-of-session memory consolidation

The deeper problem: there is no **automated feedback loop**. Mistakes don't trigger improvement; they just generate apologies.

---

## Goals

1. **Failure detection (< 5 seconds)**: Catch mistakes as they happen — tool errors, Matthew's corrections, SOP violations, trust gate demotions — before the session moves on
2. **Root cause tagging (< 30 seconds)**: Classify every failure by type and locate the SOP/pattern/hook rule that should have prevented it
3. **Instant propagation (< 60 seconds end-to-end)**: From detection to fix — rewrite the relevant SOP, patch the pre-action hook pattern, update atom/cortex records, queue a regression test
4. **Cross-system propagation**: A failure in AUGUR that traces to an infrastructure root cause updates infrastructure SOPs, not just AUGUR-domain SOPs
5. **Regression test generation**: Every significant failure generates a regression test entry so it never silently recurs
6. **Recurrence detection**: If the same failure pattern fires twice within 30 days, trigger an escalated Synapse alert — the first propagation didn't work
7. **Propagation metrics**: Track time-to-propagation, propagation completeness, and recurrence rate — these are the primary success indicators

---

## Non-Goals

- Replacing Matthew's judgment — propagation proposals are **logged and previewed**, not silently committed for high-risk changes (config files, critical SOPs)
- Retroactive replay — failures from prior sessions before task-011 is deployed are not backfilled into the learning pipeline (future-forward only)
- Cross-agent propagation to other agents (AUGUR, etc.) via direct file modification — cross-system propagation happens via Synapse message to the relevant agent's owner session
- LLM-generated SOP rewrites in the hot path — root cause classification is rule-based; SOP rewrite suggestions are async (spawned sub-agent), not blocking
- Replacing the task-003 pre-action hook system — this system feeds INTO hooks, it doesn't replace them

---

## Success Criteria

- [ ] Failure detection fires within 5 seconds of a tool error, correction keyword, or SOP violation
- [ ] Root cause is tagged automatically for ≥ 90% of detected failures (remaining 10% = "unknown" requiring Matthew's classification)
- [ ] Time-to-propagation (detection → SOP update committed) ≤ 60 seconds for Tier 1-2 failures
- [ ] Time-to-propagation ≤ 5 minutes for Tier 3 failures (require Synapse preview before commit)
- [ ] Regression test entry created within 60 seconds of every significant failure
- [ ] Recurrence detection fires within 5 seconds if same failure pattern re-occurs within 30 days
- [ ] Cross-system propagation: infrastructure root causes reach the infrastructure SOP within 60 seconds of an AUGUR failure
- [ ] Propagation completeness tracked: % of failures that resulted in at least one committed fix
- [ ] `~/bin/failure-log` CLI produces readable failure history with propagation status
- [ ] TypeScript compiles cleanly (`pnpm tsc --noEmit`)

---

## Inputs / Outputs

**Inputs:**

- Tool errors (from exec, write, gateway — any non-zero exit code or exception)
- Matthew's corrections (session message scanner — keyword detection within 5-minute window after a tool call)
- Trust gate demotions from task-010 (structured event emitted on `corrected_significant`)
- SOP violation flags from task-003 pre-action hooks (hook fires but SOP was stale/wrong)
- Pipeline stage failures (from pipeline orchestrator fail events)

**Outputs:**

- `brain.db` new tables: `failure_events`, `propagation_records`, `regression_tests`
- Updated SOP files (auto-patched for Tier 1-2 failures; Synapse preview for Tier 3)
- Updated pre-action hook patterns (rule additions/removals in `hooks/patterns.ts`)
- Atom/cortex updates (new atoms recording failure → fix causal chain)
- Synapse alerts: immediate on detection, summary on propagation completion
- Regression test entries in `brain.db` + test file additions
- Weekly propagation metrics report via Synapse

---

## Failure Taxonomy

Failures are classified into five types. Classification is rule-based and deterministic:

| Type           | Code        | Detection Source                                  | Propagation Target                            | Tier |
| -------------- | ----------- | ------------------------------------------------- | --------------------------------------------- | ---- |
| Tool Error     | `TOOL_ERR`  | Non-zero exec exit code, write exception          | Pre-action hook patterns (prevent re-trigger) | 1    |
| Correction     | `CORRECT`   | Matthew's message with correction keywords        | SOP rewrite + confidence score update         | 2    |
| SOP Violation  | `SOP_VIOL`  | Hook fired, SOP was flagged stale by hook logic   | SOP refresh + atom update                     | 2    |
| Trust Demotion | `TRUST_DEM` | Task-010 milestone event (corrected_significant)  | SOP update + regression test                  | 3    |
| Pipeline Fail  | `PIPE_FAIL` | Pipeline orchestrator stage result = fail/blocked | Regression test + Synapse escalation          | 3    |

**Tier** here means propagation complexity (1=fast/simple, 3=requires preview). Not the same as trust tier.

---

## Propagation Safety Rules

1. **SOP changes for core infrastructure files require Matthew's preview** before commit — a Synapse message shows the diff and waits for `y/n` (10-minute TTL, default = don't commit)
2. **Additive changes are auto-committed** — adding a new SOP rule or regression test is always safe; removing or modifying existing rules requires preview
3. **Cross-system propagation is Synapse-only** — Helios never directly modifies another agent's files; it posts a structured Synapse message describing the needed change
4. **Propagation log is immutable** — every propagation attempt (success or fail) is recorded; no silent skips
5. **Recurrence escalates** — if a regression test fires twice, propagation failed; escalate to Matthew with full failure chain

---

## Metrics Definitions

| Metric                    | Definition                                                                     | Target |
| ------------------------- | ------------------------------------------------------------------------------ | ------ |
| Time-to-propagation (T2P) | seconds from failure detection to first committed fix                          | ≤ 60s  |
| Propagation completeness  | % of failures that resulted in ≥ 1 committed propagation record                | ≥ 80%  |
| Recurrence rate           | % of failures whose pattern re-fires within 30 days                            | ≤ 5%   |
| Detection latency         | seconds from failure event to failure_event record creation                    | ≤ 5s   |
| False positive rate       | % of failure detections that were not actual failures (per Matthew's feedback) | ≤ 10%  |

---

## Constraints

- Failure detection adds ≤ 2ms to the post-tool-call monitoring path (background, async)
- Propagation runs in a background async queue — it never blocks the main session
- SOP file writes go through git: every auto-committed SOP change is a `git commit` with a structured commit message
- All failure events and propagation records persist in `brain.db` — survive restarts
- The system cannot mark its own propagation attempts as successful — success requires either a test pass or Matthew's confirmation
