# Design — task-018-memory-consolidation (Memory Consolidation System)

## 0) TL;DR

Implement a **deterministic**, **auditable**, **default-dry-run** consolidation pass that:

- detects duplicates/near-duplicates (embedding + text heuristics)
- plans actions (merge / promote / archive / flag_contradiction)
- emits a machine-readable report
- optionally executes actions using **transactional writes** against `brain.db`

This task formalizes and extends the existing prototype (`python/memory_consolidator.py`) into a rule-driven engine with safety rails and integration hooks.

---

## 1) Goals & Non-goals

### Goals

- Provide a **rule engine** to decide _what to do_ with candidate memory groups.
- Separate the pipeline into **Detect → Plan → Report → Execute**.
- Preserve audit metadata: provenance, timestamps, access counters, and “why this happened”.
- Add **contradiction flagging** (do not auto-delete contradictory items).
- Ensure idempotence where feasible (re-running yields same plan unless underlying data changed).

### Non-goals

- UI/triage dashboard.
- Full long-term tiering / cold-storage mechanics (Phase 2.3+).
- Non-deterministic “freeform” LLM rewriting by default.

---

## 2) Current Baseline (Existing Code)

There is an existing prototype consolidator:

- `python/memory_consolidator.py`
  - clusters STM entries via embeddings + cosine similarity
  - optionally synthesizes a consolidated entry via Ollama (`phi3:mini`)
  - writes a new consolidated STM entry and tags provenance in `source`

Limitations relative to this task:

- no configurable rule system
- no contradiction detection
- no archive/promote actions (beyond “create new memory”)
- no structured report suitable for review/approval
- no explicit transactional executor boundary

---

## 3) High-Level Architecture

### Pipeline stages (runtime)

1. **Load**: fetch candidate STM rows (optionally scoped by category/time window).
2. **Detect**:
   - duplicates/near-duplicates (similarity clustering)
   - contradiction candidates (high similarity but negation/conflict signals)
3. **Plan**: produce an ordered list of proposed actions (no writes).
4. **Report**: emit a JSON report + human summary.
5. **Execute (optional)**: apply planned actions inside safe transaction boundaries.

### Components (implementation-level)

- `ConsolidationConfig`: thresholds, scopes, and rule definitions.
- `Detector`:
  - `DuplicateDetector` (embedding similarity + text hash)
  - `ContradictionDetector` (pairwise within cluster + heuristics)
- `Planner`:
  - decides merge/promotion/archive/flagging
  - produces `PlannedAction[]`
- `Executor`:
  - applies actions via Cortex’s DB bridge APIs
  - ensures transactional safety and logs outcomes
- `Reporter`:
  - writes `reports/consolidation/<timestamp>.json`
  - summarizes counts and samples

---

## 4) Data Model

### Inputs

- STM memory records from `brain.db`:
  - `id`, `content`, `categories`, `importance`, `created_at`, `access_count`, `source`
- embeddings table join for `source_type='stm'`.

### Planned Actions

All changes are represented as a plan first.

```ts
type ConsolidationActionType = "merge" | "promote" | "archive" | "flag_contradiction" | "noop";

interface PlannedAction {
  type: ConsolidationActionType;
  targetIds: string[]; // ids affected
  canonicalId?: string; // for merge decisions
  newContent?: string; // for merge synthesis (optional)
  newCategories?: string[];
  newImportance?: number;
  rationale: {
    ruleId: string;
    score?: number;
    reasons: string[];
    evidence: {
      similarity?: number;
      clusterId?: string;
      contradictionSignals?: string[];
    };
  };
}
```

### Reports

Report is append-only and reviewable.

```json
{
  "run_id": "2026-02-21T11:12:03-05:00",
  "mode": "dry_run",
  "config_hash": "sha256:...",
  "scope": { "categories": ["..."], "limit": null },
  "detected": { "clusters": 12, "contradiction_pairs": 3 },
  "planned": { "merge": 4, "promote": 2, "archive": 8, "flag_contradiction": 3, "noop": 10 },
  "actions": [
    /* PlannedAction[] */
  ],
  "samples": {
    "clusters": [
      /* small redacted excerpts */
    ]
  }
}
```

---

## 5) Detection Design

### 5.1 Duplicate / near-duplicate detection

Use a two-tier detector:

1. **Fast pre-filter** (deterministic):

- normalized text hash (lowercase, collapse whitespace, strip punctuation) for exact-ish dupes
- optionally: n-gram / shingle signature for near dupes

2. **Embedding similarity** (existing approach):

- join STM ↔ embeddings
- compute cosine similarity
- cluster using deterministic linkage (current python uses complete-linkage greedy)

Key parameters:

- `similarity_threshold` (default 0.95 for dupes; lower like 0.85 for “topic clusters”)
- `min_cluster_size` (default 2 for duplicate detection; 3+ for “consolidate into new memory”)

Design choice: keep clustering deterministic (stable ordering by `created_at`, then `id`).

### 5.2 Contradiction detection

Contradiction detection is **flag-only** (no automatic deletions).

Heuristic signals (deterministic):

- negation markers: `not`, `never`, `do not`, `avoid`, `cannot`, `won't`
- polarity flips around modal verbs: `must` vs `must not`, `always` vs `never`
- numerical mismatch when the rest of sentence is highly similar (e.g., “threshold 0.85” vs “threshold 0.95”)

Algorithm:

- For each high-similarity pair inside a cluster:
  - compute a simple contradiction score based on:
    - negation marker presence asymmetry
    - numeric token mismatch count
    - antonym marker list (configurable)
- If score ≥ threshold, generate `flag_contradiction` action linking the two IDs.

Storage of flags:

- minimally invasive: add a new STM entry in category `contradictions` referencing both IDs, or
- preferred (if schema supports): store a row in a `flags` table (`type='contradiction'`).

(Implementation can start with the “new STM entry” approach to avoid migrations.)

---

## 6) Rule Engine (Configurable Consolidation Rules)

### Rule definition

Rules are evaluated against detected clusters / pairs.

```ts
interface ConsolidationRule {
  id: string;
  trigger: "daily" | "weekly" | "on_similarity" | "on_contradiction";
  when: {
    minSimilarity?: number;
    minClusterSize?: number;
    maxAgeDays?: number;
    minAccessCount?: number;
    minImportance?: number;
    categoriesAny?: string[];
  };
  then: {
    action: "merge" | "promote" | "archive" | "flag_contradiction" | "noop";
    params?: Record<string, unknown>;
  };
}
```

### Default rules (proposed)

- `R1-exact-duplicate-merge`:
  - trigger `on_similarity`
  - when similarity ≥ 0.98 and cluster size ≥ 2
  - action `merge` (canonical = newest)
- `R2-near-duplicate-merge`:
  - similarity ≥ 0.95 and cluster size ≥ 2
  - action `merge` (canonical = newest; aggregate metadata)
- `R3-promote-high-value-procedural`:
  - access_count ≥ N and importance ≥ 2.0 and categories contain `sop|procedure|coding|trading`
  - action `promote` (+0.5 importance cap 3.0)
- `R4-archive-low-utility`:
  - age ≥ 30 days AND access_count == 0 AND importance ≤ 1.5
  - action `archive` (move to `archive/*` category or set `source='archived:...'`)
- `R5-flag-contradiction`:
  - trigger `on_contradiction`
  - action `flag_contradiction`

---

## 7) Merge / Promote / Archive Semantics

### 7.1 Merge

**Canonical selection**: newest (`created_at`) wins content by default.

Metadata merge:

- `importance`: max(importance) (or max + small bump capped at 3.0 if rule says so)
- `access_count`: sum
- `categories`: union
- provenance: store `merged_from: [ids...]` on canonical

Write strategy:

- executor updates canonical row + deletes/archives older duplicates (configurable).
- default safe mode: **archive older** rather than delete.

### 7.2 Promote

- increase importance in-place (cap at 3.0)
- optionally pin to a “validated/\*” category

### 7.3 Archive

- move categories to `archive/<original>` OR add `archived` category
- preserve original content (no loss)
- optionally set `source='archived:{json meta}'`

### 7.4 Flag contradiction

- create a “flag record” (either flags table or a new STM entry) with:
  - the pair ids
  - excerpt and rationale
  - similarity score

---

## 8) Safety / Idempotence / Transactions

### Safety defaults

- **dry-run default**
- execution requires explicit `--execute`

### Transaction boundaries

- plan is computed first with no writes
- execution applies actions in a single transaction per cluster (or per action batch)
  - if any write fails, rollback that cluster batch

### Idempotence

- attach a `run_id` and `config_hash` to any generated artifacts
- for generated “flag” STM entries, include a deterministic key so duplicates are not re-created

---

## 9) Integration Points

### CLI

Add a dedicated command entry point:

- `node scripts/consolidate.ts --dry-run --report <path>` (or equivalent)

### Cron

Integrate with existing maintenance cron as:

- nightly dry-run report
- weekly execute (optional, only after trust is established)

### Observability

- log per action: `CONSOLIDATE/MERGE`, `CONSOLIDATE/ARCHIVE`, `CONSOLIDATE/CONTRADICTION`
- expose summary counters compatible with existing healthcheck patterns

---

## 10) Testing Strategy

Unit tests:

- cluster determinism
- merge semantics (canonical selection, category union, access sum)
- contradiction heuristics
- rule evaluation (given cluster metadata → expected action)

Integration tests:

- run consolidation against a temporary sqlite `brain.db` fixture
- verify dry-run report schema
- verify executor transactions (rollback on induced failure)

TypeScript compile gate:

- `pnpm tsc --noEmit` must pass after build stage.

---

## 11) Risks / Mitigations

- **False positives** in contradiction detection → mitigate by flag-only + high thresholds.
- **Over-merging** near-duplicates that should remain separate → mitigate by conservative defaults and category scoping.
- **Schema coupling** to `brain.db` → mitigate by using existing Cortex bridge APIs where possible.
- **LLM synthesis nondeterminism** → mitigate by defaulting to canonical-content merge; optional synthesis behind flag.
