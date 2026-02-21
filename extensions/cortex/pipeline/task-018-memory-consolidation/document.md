# Documentation — task-018-memory-consolidation (Memory Consolidation System)

## Purpose

This stage documents the **planned Memory Consolidation System** for Cortex Phase 2.2: a deterministic, auditable pipeline that reduces redundant memories, promotes validated high-value knowledge, archives low-utility noise, and flags contradictions for review.

This document is written as **version-forensics style operational docs**: what the subsystem does, how to recognize it in logs, how to run it safely, and how to debug/rollback.

---

## Status / Scope (this task)

- **Default mode:** dry-run (no writes)
- **Action classes:** merge, promote, archive, flag_contradiction
- **Execution safety:** plan-first, transactional execution, idempotence keys
- **Contradiction handling:** flag-only (no auto-delete)

> Implementation details and architecture are defined in `design.md`; this document focuses on operational usage, signatures, and debugging hooks.

---

## Operator Model

### Modes

- **Dry-run** (default):
  - Detect + plan + report.
  - Produces machine-readable report; makes no database changes.
- **Execute** (explicit):
  - Applies a reviewed plan using transaction boundaries.
  - Prefer “archive duplicates” over deletion by default.

### Typical cadence

- Nightly: dry-run report (trend monitoring, safety).
- Weekly (optional, earned): execute with conservative thresholds.

---

## Artifacts

### Report artifact (append-only)

A consolidation run emits a JSON report with:

- `run_id`, `mode`, `config_hash`, `scope`
- detection summary (`clusters`, `contradiction_pairs`)
- planned action counts (`merge`, `promote`, `archive`, `flag_contradiction`, `noop`)
- action list with per-action rationale and evidence

Example schema (abridged):

```json
{
  "run_id": "2026-02-21T11:12:03-05:00",
  "mode": "dry_run",
  "config_hash": "sha256:...",
  "planned": { "merge": 4, "archive": 8, "flag_contradiction": 3 },
  "actions": [
    {
      "type": "merge",
      "targetIds": ["stm_...", "stm_..."],
      "canonicalId": "stm_...",
      "rationale": {
        "ruleId": "R2-near-duplicate-merge",
        "reasons": ["similarity >= 0.95", "cluster_size >= 2"],
        "evidence": { "similarity": 0.972, "clusterId": "cluster_0007" }
      }
    }
  ]
}
```

### Flag records for contradictions

Contradictions are stored in a minimally invasive way:

- Preferred (if supported later): a `flags` table.
- Initial safe approach: a new STM memory in category `contradictions` referencing both IDs, including similarity + heuristic signals.

This is **deliberately non-destructive**.

---

## Behavioral Signatures (how to grep)

All logs should be structured enough to grep quickly.

### Consolidation run lifecycle

- `CONSOLIDATE/START run_id=<...> mode=<dry_run|execute> config_hash=<...>`
- `CONSOLIDATE/DETECT clusters=<n> contradiction_pairs=<n>`
- `CONSOLIDATE/PLAN merge=<n> promote=<n> archive=<n> flag_contradiction=<n> noop=<n>`
- `CONSOLIDATE/REPORT path=<...>`
- `CONSOLIDATE/EXECUTE begin` (execute only)
- `CONSOLIDATE/DONE ok` or `CONSOLIDATE/ERROR <...>`

Suggested debugging hooks:

- `grep "CONSOLIDATE/" <logfile>`
- `grep "CONSOLIDATE/ERROR" <logfile>`

### Action-level signatures

- `CONSOLIDATE/MERGE canonical=<id> merged_from=<ids...> rule=<ruleId>`
- `CONSOLIDATE/ARCHIVE id=<id> reason=<...> rule=<ruleId>`
- `CONSOLIDATE/PROMOTE id=<id> from=<x> to=<y> rule=<ruleId>`
- `CONSOLIDATE/CONTRADICTION a=<id> b=<id> signals=<...>`

---

## Failure Modes (what broken looks like)

### 1) Over-merging near-duplicates

**Signature:** unexpected merges across distinct topics; many merges at similarity barely above threshold.

- Grep: `grep "CONSOLIDATE/MERGE" <logfile>`
- Mitigation:
  - raise `similarity_threshold` (e.g. 0.95 → 0.98)
  - scope by category
  - increase `min_cluster_size`

### 2) Contradiction false positives

**Signature:** many `CONSOLIDATE/CONTRADICTION` flags with weak evidence.

- Mitigation:
  - increase contradiction score threshold
  - tighten negation/numeric mismatch heuristics
  - continue flag-only policy (no destructive actions)

### 3) Transaction failures during execute

**Signature:** `CONSOLIDATE/ERROR` and partial cluster/application.

- Required behavior: rollback the current cluster/action batch.
- Mitigation:
  - reduce batch size to “per cluster”
  - verify DB lock contention, long-running transactions

### 4) Idempotence drift (duplicate flags)

**Signature:** repeated runs create multiple identical contradiction flags.

- Mitigation:
  - include deterministic idempotence key in flag content/source
  - on create: check for existing key

---

## Rollback / Safety Controls

### Rollback philosophy

Prefer **reversible transforms**:

- archive rather than delete
- preserve provenance (`merged_from`) and before/after references

### Recommended rollback actions

- If over-merging occurs:
  - stop execute runs; run dry-run only
  - restore archived duplicates (if archive used)
  - adjust thresholds and rescan

### “Kill switch”

- Keep a global config flag (or CLI flag) to force `--dry-run` regardless of cron schedule.

---

## Integration Notes

### Cron / maintenance

Consolidation should integrate with existing maintenance workflows:

- nightly `dry-run` report generation
- optional weekly `execute` after review

### Observability

- Ensure per-run summary counters are included (planned vs executed vs skipped)
- Include `config_hash` and `run_id` everywhere for correlation

---

## References

- Requirements: `requirements.md`
- Design: `design.md`
- Pipeline task: `task.json`
