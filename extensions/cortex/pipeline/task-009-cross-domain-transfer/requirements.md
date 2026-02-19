# Task-009: Cross-Domain Pattern Transfer — Requirements

**Stage:** requirements | **Status:** pass
**Phase:** 5.5 of IMPROVEMENT_PLAN
**Date:** 2026-02-18

---

## Problem Statement

Helios operates across several structurally distinct domains: **trading** (AUGUR signals, price action, portfolio risk), **ham radio** (propagation, band conditions, QSO tracking), **fleet/infrastructure** (service health, resource contention, ITSM SLAs), and **meta/AI** (memory hygiene, pipeline orchestration, agent coordination). These domains accumulate knowledge independently — AUGUR learns that VWAP divergence predicts reversals, ft991a-control learns that solar flux predicts 10m propagation windows, fleet learns that disk I/O spikes precede OOM kills.

The problem: **these insights never talk to each other.** A structural pattern that Helios has validated in one domain is never applied to an analogous structure in another. Human experts cross-pollinate across domains constantly — a trading quant's intuition about mean-reversion applies directly to RF propagation "reversion to baseline" or to fleet load-balancing. Helios lacks this capability entirely.

Concrete missed opportunities:

- AUGUR's divergence detection (price vs. indicator diverges from mean, reversal imminent) is structurally identical to RF fade detection (signal strength diverges from expected, skip probable) — same math, different units
- Trading drawdown management (cut exposure when drawdown > threshold) maps directly to fleet circuit-breaking (drop traffic when error rate > threshold) — same risk logic
- Memory compression ratio patterns (how quickly knowledge clusters decay in importance over time) structurally mirror AUGUR's signal decay (how quickly a trade signal loses predictive power over time) — same temporal decay model

Without cross-domain transfer, every domain re-invents the same underlying patterns from scratch, in isolation.

---

## Goals

1. **Pattern extraction**: Extract normalized, domain-agnostic "structural fingerprints" from atoms, memories, and domain-specific artifacts (AUGUR signals, radio logs, fleet metrics)
2. **Cross-domain similarity search**: Given a pattern in Domain A, find structurally similar patterns in Domains B, C, D — even when the underlying data types are completely different
3. **Metaphor engine**: Produce human-readable "cross-domain metaphors" (e.g., "VWAP divergence in trading ≈ signal fade in ham radio ≈ resource contention in fleet") for Helios to use in reasoning and for Matthew to inspect
4. **Cross-pollination alerts**: When a high-confidence pattern from one domain appears nascent in another domain, generate a proactive alert: "Pattern X validated in trading — here's how it might apply to fleet"
5. **Novel hypothesis generation**: Combine patterns from 2+ domains to generate testable hypotheses that couldn't emerge from either domain alone
6. **Fully automated**: Background analysis, Synapse alerts on matches found, no human intervention required for routine operation

---

## Non-Goals

- Replacing domain-specific logic (AUGUR keeps its own signal models; the cross-domain engine reads outputs, doesn't rewrite internals)
- Real-time per-transaction analysis (batch + event-triggered, not streaming)
- Automated application of cross-domain patterns to production systems without Matthew's confirmation (generate hypotheses + alerts, not auto-apply)

---

## Success Criteria

- [ ] Pattern extractor produces normalized structural fingerprints from atoms, memories, AUGUR signals, radio log entries, and fleet health events
- [ ] Cross-domain similarity search identifies structurally similar patterns across ≥2 domains with cosine similarity ≥0.75 on the fingerprint vectors
- [ ] Metaphor engine generates human-readable analogies for top-10 cross-domain matches per run
- [ ] Cross-pollination alert fires when a validated pattern (confidence ≥0.8 in source domain) finds a structural match (similarity ≥0.75) in a target domain where it hasn't been tested
- [ ] Novel hypothesis generation produces ≥1 testable hypothesis per cross-domain match pair
- [ ] All findings posted to Synapse as structured alerts; high-value matches surfaced via cortex_predict
- [ ] TypeScript implementation compiles cleanly (`pnpm tsc --noEmit`)
- [ ] System is additive — existing domain logic (AUGUR, ft991a-control, fleet) unchanged

---

## Inputs / Outputs

**Inputs:**

- `brain.db` atoms — causal structures already in the graph
- `brain.db` memories — categorized knowledge across all domains
- AUGUR signal artifacts (`~/Projects/augur-trading/signals/`, SQLite trade DB)
- Radio log entries (ft991a-control logbook, propagation events)
- Fleet health data (ITSM events, OctoPrint status, service metrics)

**Outputs:**

- `brain.db` cross-domain similarity index (new table: `cross_domain_patterns`)
- `brain.db` metaphor registry (new table: `domain_metaphors`)
- Cross-pollination alert atoms (new `atom_create` records with `source: 'cross-domain'`)
- Novel hypothesis records (stored as cortex memories with category `hypothesis`)
- Nightly Synapse report with top matches, new metaphors, active hypotheses
- `~/Projects/helios/extensions/cortex/reports/cross-domain-{run_id}.json`

---

## Domain Taxonomy

| Domain ID | Label         | Primary Data Sources                                 | Key Pattern Types                                               |
| --------- | ------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `trading` | Trading/AUGUR | AUGUR SQLite, signal miner output, atom graph        | Divergence, momentum, mean-reversion, decay, drawdown           |
| `radio`   | Ham Radio     | ft991a-control logs, propagation data, QSO records   | Propagation windows, fade, skip, signal decay, band cycles      |
| `fleet`   | Fleet/Infra   | ITSM events, OctoPrint, service health metrics       | Resource contention, circuit-break, SLA drift, cascade failure  |
| `meta`    | AI/Cortex     | Atom graph, memory hygiene reports, pipeline history | Pattern confidence decay, compression ratios, error propagation |

---

## Constraints

- Must not degrade Cortex or AUGUR performance — cross-domain engine runs in isolated process
- Hypotheses generated are clearly labeled as synthetic/unvalidated to avoid false confidence
- Domain-specific credentials (AUGUR DB path, radio log paths) resolved via env/config, not hardcoded
- Pattern fingerprints must be serializable and storable in SQLite (no in-memory-only state)
