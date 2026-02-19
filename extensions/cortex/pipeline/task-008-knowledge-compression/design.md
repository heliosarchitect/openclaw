# Task-008: Knowledge Compression — Abstraction Engine — Design

**Stage:** design | **Status:** complete
**Phase:** 5.4 | **Date:** 2026-02-18
**Author:** Pipeline Design Specialist

---

## 1. Overview

The **Abstraction Engine** is Helios's memory consolidation system — the engineered equivalent of sleep-based hippocampal replay in biological cognition. It runs nightly as a background cron job, clustering semantically similar memories, distilling them into high-value abstractions, feeding causal patterns into the atom graph, and archiving redundant source memories.

The result: a leaner, more powerful knowledge base where every active memory earns its context window slot.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Abstraction Engine (abstraction-engine.ts)      │
│                                                                   │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│  │  Cluster     │   │  Distiller   │   │   Atom Enricher      │ │
│  │  Finder      │──▶│              │──▶│                      │ │
│  │  (cosine)    │   │  (LLM call)  │   │  (pattern→atom_create│ │
│  └──────────────┘   └──────────────┘   └──────────────────────┘ │
│          │                  │                       │            │
│          ▼                  ▼                       ▼            │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│  │  Importance  │   │  Compressed  │   │   Compression        │ │
│  │  Archiver    │   │  Memory      │   │   Report             │ │
│  │  (→0.5)      │   │  Writer      │   │   (JSON + Synapse)   │ │
│  └──────────────┘   └──────────────┘   └──────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Components

### 3.1 Cluster Finder (`src/abstraction/cluster-finder.ts`)

Identifies groups of semantically related memories eligible for compression.

**Algorithm:**

1. Load all memories from `brain.db` with `importance < 2.5` (critical memories are never candidates)
2. Filter out memories already tagged `compressed_from` (already distilled)
3. Filter out memories created within the last 24h (too fresh to compress)
4. Load their embedding vectors from the embeddings table
5. Compute pairwise cosine similarity in batches of 200 to avoid O(n²) blowup
6. Use **single-linkage clustering** with threshold `≥0.82` — simple, fast, no hyperparameters
7. Discard clusters with fewer than 3 members (not enough signal to distill)
8. Sort clusters by size (largest first) — bigger clusters = more compression opportunity

```typescript
interface MemoryCluster {
  cluster_id: string; // uuid
  member_ids: string[]; // memory IDs
  member_count: number;
  avg_similarity: number;
  dominant_category: string; // most common category across members
  total_tokens: number; // estimated token count of all members
  oldest_member_at: string; // ISO timestamp
}
```

**Idempotency guard:** Clusters are fingerprinted as a sorted set of member IDs. If an identical fingerprint was processed in the last 7 days (stored in `brain.db` compression_log table), skip.

---

### 3.2 Distiller (`src/abstraction/distiller.ts`)

Takes a cluster → produces a single compressed memory via LLM synthesis.

**Prompt strategy:**

```
You are a knowledge distillation engine. Given N related memories,
produce a single compressed abstraction that:
1. Preserves all actionable insights
2. Loses no causal relationships
3. Is ≤30% the combined token length of the inputs
4. Is written as a declarative fact, not a narrative
5. Includes a "compression_ratio" float (original_tokens / compressed_tokens)

Output format: { "abstraction": "...", "compression_ratio": 3.4, "is_causal": true/false }
```

**Inputs to the LLM:** All member memory content + their categories + their importance scores (weighted).

**Validation:** The distilled text must:

- Be non-empty
- Have `compression_ratio ≥ 1.5` (otherwise not worth compressing)
- Not contain any memory IDs or internal reference strings
- Be ≤ 2000 tokens

**Failure handling:** If distillation fails (LLM error, validation fails), log the cluster as `skipped` with reason. Never corrupt source memories on distiller failure.

---

### 3.3 Compressed Memory Writer (`src/abstraction/memory-writer.ts`)

Stores the distilled abstraction as a new cortex memory with enriched metadata.

```typescript
interface CompressedMemory {
  content: string; // distilled abstraction
  categories: string[]; // inherited from dominant category + 'compressed'
  importance: number; // max(member importances) — preserve peak signal
  metadata: {
    compressed_from: string[]; // source memory IDs
    compression_ratio: number; // e.g. 3.4 (3.4x token reduction)
    cluster_size: number; // how many memories collapsed into this one
    distilled_at: string; // ISO timestamp
    source_date_range: [string, string]; // oldest → newest source
  };
}
```

The `compressed` category tag allows future queries like "show me all abstractions" without touching raw memories.

---

### 3.4 Importance Archiver (`src/abstraction/archiver.ts`)

After successful compression, downgrades source memories.

**Rules:**

- Set `importance = 0.5` on all member memories (marks as archived-but-retained)
- Do NOT delete source memories — they remain queryable
- Add metadata: `{ archived_by: cluster_id, archived_at: ISO }`
- Critical memories (`importance ≥ 2.5` at time of cluster formation) are **excluded** from candidacy entirely — this is enforced at the Cluster Finder level, not here

**Rollback:** If any archiver write fails, the entire compression run for that cluster is rolled back (source memories restored, compressed memory deleted). Uses SQLite transactions for atomicity.

---

### 3.5 Atom Enricher (`src/abstraction/atom-enricher.ts`)

For distillations flagged `is_causal: true`, creates or enriches atoms.

**Causal pattern detection:** The distiller flags causal patterns explicitly. Examples:

- "Matthew corrects me when I assert without verifying" → causal atom
- "BNKR-USD generates the most signals" → descriptive, not causal

**Atom mapping:**

```typescript
// Input: "Matthew corrects me when I assert without verifying git state"
// Output:
atom_create({
  subject: "Helios",
  action: "asserts git state without verifying",
  outcome: "assertion is wrong",
  consequences: "Matthew corrects immediately; trust eroded temporarily",
});
```

The Atom Enricher uses a second LLM pass to extract the `{subject, action, outcome, consequences}` quadruple from the distilled text.

**Deduplication:** Before creating an atom, search `atom_search` for semantically similar atoms in the `subject` field. If similarity > 0.85, strengthen the existing atom's confidence rather than creating a duplicate.

---

### 3.6 Compression Report (`src/abstraction/reporter.ts`)

Generates a structured report at the end of each run.

```typescript
interface CompressionRunReport {
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;

  // Scope
  memories_scanned: number;
  clusters_found: number;
  clusters_skipped: number; // idempotency / validation failures
  clusters_compressed: number;

  // Impact
  memories_archived: number;
  abstractions_created: number;
  atoms_created: number;
  atoms_enriched: number;

  // Token efficiency
  tokens_before: number; // estimated total active memory tokens pre-run
  tokens_after: number; // estimated total active memory tokens post-run
  token_reduction_pct: number;

  // Quality
  avg_compression_ratio: number;
  max_compression_ratio: number;

  // Errors
  errors: CompressionError[];

  verdict: "PASS" | "PARTIAL" | "FAIL";
}
```

Report written to: `~/Projects/helios/extensions/cortex/reports/compression-{run_id}.json`
Synapse summary posted to `all` at `priority='info'` (or `'action'` if `errors.length > 0`).

---

## 4. Database Schema

### 4.1 New Table: `compression_log`

```sql
CREATE TABLE IF NOT EXISTS compression_log (
  id TEXT PRIMARY KEY,
  cluster_fingerprint TEXT NOT NULL,   -- sorted member IDs hash
  compressed_memory_id TEXT,           -- FK to memories
  status TEXT NOT NULL,                -- 'compressed' | 'skipped' | 'failed'
  reason TEXT,                         -- if skipped/failed
  member_count INTEGER NOT NULL,
  compression_ratio REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_compression_log_fingerprint ON compression_log(cluster_fingerprint);
CREATE INDEX idx_compression_log_created ON compression_log(created_at);
```

### 4.2 Memories Table Extension

Two new columns added to existing `memories` table:

```sql
ALTER TABLE memories ADD COLUMN compressed_from TEXT;  -- JSON array of source IDs
ALTER TABLE memories ADD COLUMN archived_by TEXT;       -- cluster_id if archived
```

Migration: `src/migrations/008-compression.ts`

---

## 5. File Structure

```
src/
├── abstraction/
│   ├── abstraction-engine.ts      # Main orchestrator
│   ├── cluster-finder.ts          # Cosine clustering
│   ├── distiller.ts               # LLM-based compression
│   ├── memory-writer.ts           # Write compressed memories
│   ├── archiver.ts                # Downgrade source memories
│   ├── atom-enricher.ts           # Feed causal patterns to atom graph
│   └── reporter.ts                # Generate run report
├── migrations/
│   └── 008-compression.ts         # DB schema additions
└── types/
    └── compression.ts             # All interfaces

~/bin/
└── run-compression                # Shell wrapper for cron
```

---

## 6. Cron Configuration

```json
{
  "name": "nightly-knowledge-compression",
  "schedule": { "kind": "cron", "expr": "30 3 * * *", "tz": "America/New_York" },
  "payload": {
    "kind": "systemEvent",
    "text": "Run knowledge compression: cd ~/Projects/helios && npx tsx src/abstraction/abstraction-engine.ts"
  },
  "sessionTarget": "main",
  "enabled": true
}
```

Also triggered manually via: `~/bin/run-compression`

---

## 7. LLM Call Strategy

Two LLM calls per cluster:

1. **Distiller call**: Claude Haiku (fast, cheap) — pure text synthesis, no tool use
2. **Atom extractor call**: Claude Haiku — structured JSON extraction of causal quadruple

Both calls use the Anthropic SDK directly (not via OpenClaw tool routing) for latency and cost control. API key from env `ANTHROPIC_API_KEY`.

**Rate limiting:** Max 10 clusters processed per minute to avoid API throttling.

**Cost estimate:** ~$0.002 per cluster (avg 2K tokens input + 500 tokens output × 2 calls × Haiku pricing). A typical nightly run of 50 clusters costs ~$0.10.

---

## 8. Integration Points

### 8.1 Existing Cortex Tools

- `cortex_stm` — used for freshness filtering (skip memories < 24h old)
- `cortex_dedupe` — runs BEFORE compression in the cron sequence (dedup first, then compress remaining)
- `atom_create`, `atom_search` — used by atom enricher
- `cortex_stats` — used for token baseline measurement

### 8.2 Pre-existing Atom Graph

The Abstraction Engine is **additive** to the existing atom graph. It enriches atoms from newly distilled patterns but does not modify existing atoms' subject/action/outcome/consequences fields.

### 8.3 Self-Healing Integration (task-006)

If `abstraction-engine.ts` exits non-zero, the self-healing cron (task-006) detects the failure and posts a Synapse alert. No additional wiring needed.

---

## 9. Testing Plan (for Build Stage)

| Test                                              | Type        | Assertion                                                               |
| ------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| Cluster finder returns ≥3-member clusters         | Unit        | Mock embeddings with known similarity matrix                            |
| Cluster finder skips importance ≥2.5 memories     | Unit        | Critical memory excluded from candidates                                |
| Cluster finder is idempotent                      | Unit        | Same cluster → same fingerprint → skipped on second run                 |
| Distiller produces valid schema output            | Unit        | Mock LLM returns; JSON validates against interface                      |
| Distiller compression_ratio ≥1.5 enforced         | Unit        | ratio=1.2 input → cluster skipped                                       |
| Archiver uses SQLite transactions (rollback)      | Integration | Inject fault mid-archive; assert source memories unchanged              |
| Atom enricher deduplicates against existing atoms | Integration | Pre-seed similar atom; assert no duplicate created                      |
| Full run on synthetic brain.db                    | E2E         | 20 seeded memories → 3 clusters → 3 abstractions → token reduction ≥30% |
| Cron wrapper exits 0 on success, 1 on failure     | Shell       | Both paths exercised                                                    |

---

## 10. Implementation Plan (Build Stage)

| Step | Work                                   | Files                                                   |
| ---- | -------------------------------------- | ------------------------------------------------------- |
| 1    | Types + DB migration                   | `types/compression.ts`, `migrations/008-compression.ts` |
| 2    | Cluster Finder                         | `abstraction/cluster-finder.ts`                         |
| 3    | Distiller (with mock LLM)              | `abstraction/distiller.ts`                              |
| 4    | Memory Writer                          | `abstraction/memory-writer.ts`                          |
| 5    | Importance Archiver (with transaction) | `abstraction/archiver.ts`                               |
| 6    | Atom Enricher                          | `abstraction/atom-enricher.ts`                          |
| 7    | Reporter                               | `abstraction/reporter.ts`                               |
| 8    | Main orchestrator                      | `abstraction/abstraction-engine.ts`                     |
| 9    | Shell wrapper + cron setup             | `~/bin/run-compression`                                 |
| 10   | Unit + integration tests               | `src/abstraction/__tests__/`                            |

---

## 11. Risks

| Risk                                        | Likelihood | Mitigation                                                          |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| LLM distillation loses critical nuance      | Medium     | Compression only for importance < 2.5; critical memories immune     |
| Cosine clustering groups unrelated memories | Low        | Threshold 0.82 is conservative; human review via Synapse report     |
| SQLite transaction deadlock                 | Low        | Single writer at a time; cron ensures no concurrent runs            |
| Atom graph explosion from over-enrichment   | Low        | Dedup check before atom_create; new atoms only if similarity < 0.85 |
| Runaway LLM costs                           | Very Low   | 10 clusters/min rate limit; Haiku model; run cost capped ~$0.25     |

---

## 12. Open Questions

1. **Compression of compressed memories**: Should second-order compression be allowed (distillations of distillations)? Initial answer: no — `compressed_from` metadata makes them ineligible as candidates.
2. **Category inheritance**: Should the compressed memory inherit _all_ categories from its sources, or just the dominant one? Proposal: top-2 categories by frequency, always including `compressed`.
3. **Atom confidence**: New atoms created from distillations start at `confidence=0.7` (slightly lower than agent-sourced atoms at 1.0) to reflect their synthetic origin.

---

_Next stage: document → build (TypeScript implementation)_
