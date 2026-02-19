# Task-008: Knowledge Compression — Abstraction Engine — Documentation

**Stage:** document | **Status:** complete
**Phase:** 5.4 | **Date:** 2026-02-18
**Author:** Pipeline Documentation Specialist

---

## Table of Contents

1. [Overview](#1-overview)
2. [Motivation & Problem Context](#2-motivation--problem-context)
3. [Architecture Reference](#3-architecture-reference)
4. [Component API Reference](#4-component-api-reference)
   - 4.1 [ClusterFinder](#41-clusterfinder)
   - 4.2 [Distiller](#42-distiller)
   - 4.3 [MemoryWriter](#43-memorywriter)
   - 4.4 [Archiver](#44-archiver)
   - 4.5 [AtomEnricher](#45-atomenricher)
   - 4.6 [Reporter](#46-reporter)
   - 4.7 [AbstractionEngine (Orchestrator)](#47-abstractionengine-orchestrator)
5. [Database Schema](#5-database-schema)
6. [Type Reference](#6-type-reference)
7. [Configuration](#7-configuration)
8. [Operational Guide](#8-operational-guide)
   - 8.1 [Cron Setup](#81-cron-setup)
   - 8.2 [Manual Execution](#82-manual-execution)
   - 8.3 [Monitoring & Alerting](#83-monitoring--alerting)
   - 8.4 [Interpreting Compression Reports](#84-interpreting-compression-reports)
9. [Integration Guide](#9-integration-guide)
10. [Behavioral Signatures & Failure Modes](#10-behavioral-signatures--failure-modes)
11. [Rollback & Recovery](#11-rollback--recovery)
12. [Cost & Performance Characteristics](#12-cost--performance-characteristics)
13. [Decision Log](#13-decision-log)
14. [Glossary](#14-glossary)

---

## 1. Overview

The **Abstraction Engine** is Helios's memory consolidation system — the engineered equivalent of sleep-based hippocampal replay in biological cognition. It runs nightly as a background cron job to:

1. **Cluster** semantically similar memories (cosine similarity ≥ 0.82) into compression candidates
2. **Distill** each cluster into a single high-value abstraction via LLM synthesis
3. **Enrich** the atom graph with newly discovered causal patterns
4. **Archive** source memories (importance → 0.5) to reduce context injection noise
5. **Report** compression metrics to Synapse

**Key invariant:** The engine is _additive and safe_. It never deletes memories. Critical memories (importance ≥ 2.5) are permanently immune from compression. All operations inside a cluster run are wrapped in SQLite transactions — partial failures roll back cleanly.

**Primary output:** A leaner knowledge base where every active memory earns its context window slot.

---

## 2. Motivation & Problem Context

### The Accumulation Problem

Helios writes dozens of STM entries per session. Over weeks, this creates:

| Problem             | Symptom                                                             | Impact                  |
| ------------------- | ------------------------------------------------------------------- | ----------------------- |
| Memory bloat        | 200+ entries for the same underlying pattern                        | Context windows flooded |
| Retrieval dilution  | Semantically similar memories compete for retrieval slots           | Novel entries buried    |
| Missed abstractions | "Whale accumulation precedes price moves" is implicit in 200 trades | Pattern never surfaced  |
| Token waste         | Hot/semantic injections carry redundant verbose content             | Wasted model capacity   |

### The Biological Analogy

Human brains solve this via **sleep-based memory consolidation**: the hippocampus replays episodic memories during sleep, gradually transferring stable patterns to cortical long-term storage while discarding redundant episodes.

The Abstraction Engine is the engineered equivalent:

- **Episodic → Semantic**: Individual observations → generalizable principles
- **Semantic → Atomic**: Generalizable principles → causal atoms
- **Redundancy elimination**: Source memories archived, not deleted

### Why Nightly?

Compression is CPU/API-intensive and non-urgent. Running at 3:30 AM:

- Avoids contention with active sessions
- Aligns with the biological metaphor (sleep = consolidation time)
- `cortex_dedupe` runs just before at 3:00 AM (exact-match dedup first, then semantic compression)

---

## 3. Architecture Reference

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     AbstractionEngine (orchestrator)                     │
│                      src/abstraction/abstraction-engine.ts               │
│                                                                           │
│  Step 1         Step 2          Step 3            Step 4                 │
│  ┌───────────┐  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Cluster  │  │ Distiller  │  │MemoryWriter  │  │   Archiver       │  │
│  │  Finder   │─▶│            │─▶│              │─▶│                  │  │
│  │ (cosine   │  │(LLM: Haiku)│  │(brain.db     │  │(importance→0.5,  │  │
│  │  ≥0.82)   │  │            │  │ compressed   │  │ SQLite txn)      │  │
│  └───────────┘  └────────────┘  │ memories)    │  └──────────────────┘  │
│       │               │         └──────────────┘          │             │
│       │               ▼                                    │             │
│       │    ┌──────────────────┐                            │             │
│       │    │  Atom Enricher   │                            │             │
│       │    │  (is_causal →    │◀───────────────────────────┘             │
│       │    │  atom_create)    │                                           │
│       │    └──────────────────┘                                           │
│       │               │                                                   │
│       ▼               ▼                                                   │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │                        Reporter                                   │    │
│  │  compression-{run_id}.json  +  Synapse summary                   │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘

Data flow:
  brain.db ──────────────▶ ClusterFinder ──▶ clusters[]
  clusters[] ────────────▶ Distiller ──▶ DistilledResult[]
  DistilledResult[] ─────▶ MemoryWriter ──▶ compressed_memory_id
  compressed_memory_id ──▶ Archiver ──▶ source importances → 0.5
  DistilledResult[] ─────▶ AtomEnricher ──▶ atom graph (if is_causal)
  all above ─────────────▶ Reporter ──▶ report JSON + Synapse post
```

### Data Flow Summary

1. **ClusterFinder** scans `brain.db` for non-critical memories older than 24h with embeddings, computes pairwise cosine similarity, returns clusters of ≥3 members above threshold 0.82.
2. **Distiller** sends each cluster's content to Claude Haiku for synthesis into a single compressed abstraction. Returns `{ abstraction, compression_ratio, is_causal }`.
3. **MemoryWriter** persists the abstraction as a new cortex memory with `compressed_from` metadata.
4. **Archiver** sets source memory `importance = 0.5` within a SQLite transaction. Rolls back on any failure.
5. **AtomEnricher** (parallel to steps 3–4) extracts `{subject, action, outcome, consequences}` from causal distillations and calls `atom_create` or strengthens an existing atom.
6. **Reporter** aggregates metrics, writes JSON report, posts Synapse summary.

---

## 4. Component API Reference

### 4.1 ClusterFinder

**File:** `src/abstraction/cluster-finder.ts`

**Purpose:** Identifies groups of semantically related memories eligible for compression.

#### `findClusters(db: Database): Promise<MemoryCluster[]>`

**Algorithm:**

1. Query memories where `importance < 2.5 AND compressed_from IS NULL AND created_at < datetime('now', '-1 day')`
2. Join with embeddings table to get vectors
3. Batch cosine similarity computation (batch size: 200)
4. Single-linkage clustering at threshold 0.82
5. Discard clusters with `member_count < 3`
6. Compute cluster fingerprint (SHA-256 of sorted member IDs)
7. Check `compression_log` — skip if fingerprint processed in last 7 days
8. Sort by `member_count DESC`

**Returns:** `MemoryCluster[]` sorted largest-first

**Memory safety:** All embedding vectors are loaded batch-by-batch; no full O(n²) matrix is held in memory simultaneously.

**Idempotency guarantee:** Identical cluster → same fingerprint → `skipped` in log on second run.

#### Configuration constants

```typescript
const SIMILARITY_THRESHOLD = 0.82;
const MIN_CLUSTER_SIZE = 3;
const MAX_MEMORY_AGE_HOURS = 24; // freshness filter
const CRITICAL_IMPORTANCE_FLOOR = 2.5; // immune from compression
const FINGERPRINT_TTL_DAYS = 7; // idempotency window
const COSINE_BATCH_SIZE = 200;
```

---

### 4.2 Distiller

**File:** `src/abstraction/distiller.ts`

**Purpose:** Converts a cluster of related memories into a single compressed abstraction via LLM synthesis.

#### `distill(cluster: MemoryCluster, memories: Memory[]): Promise<DistilledResult | null>`

**LLM model:** Claude Haiku (direct Anthropic SDK, not OpenClaw routing)

**System prompt:**

```
You are a knowledge distillation engine for an AI agent's memory system.
Given N related memories, produce a single compressed abstraction that:
1. Preserves ALL actionable insights and causal relationships
2. Is ≤30% the combined token length of the inputs
3. Is written as a declarative fact or principle, not a narrative or story
4. Captures the most generalizable form of the pattern
5. Determines whether the pattern is causal (action → outcome) or merely descriptive

Output ONLY valid JSON: { "abstraction": "...", "compression_ratio": 3.4, "is_causal": true }
```

**User message format:**

```
MEMORIES TO COMPRESS (cluster of {N} related entries, category: {category}):

[1] importance={importance} | {content}
[2] importance={importance} | {content}
...

Produce a single compressed abstraction.
```

**Validation rules (distillation is rejected if any fail):**
| Rule | Value |
|------|-------|
| `abstraction` non-empty | Required |
| `compression_ratio` ≥ 1.5 | Minimum compression worth keeping |
| `abstraction` ≤ 2000 tokens | Length cap |
| `abstraction` contains no memory IDs | No internal reference leakage |
| JSON parses cleanly | Required |

**Failure handling:** Returns `null` on any validation failure or LLM error. Cluster logged as `skipped` with reason. Source memories untouched.

**Rate limiting:** Max 10 distillations per minute (100ms minimum between calls, burst capacity 10).

---

### 4.3 MemoryWriter

**File:** `src/abstraction/memory-writer.ts`

**Purpose:** Persists the distilled abstraction as a new cortex memory.

#### `writeCompressedMemory(result: DistilledResult, cluster: MemoryCluster, db: Database): Promise<string>`

Returns the new `memory_id`.

**Category assignment:**

- Always includes `'compressed'` tag
- Inherits top-2 most frequent categories from source memories
- Example: sources are [trading, trading, meta, trading, meta] → categories = ['trading', 'meta', 'compressed']

**Importance assignment:**

- `max(member importances)` — preserves peak signal strength
- If max < 1.0, sets to 1.0 (floor for any new memory)

**Metadata stored in `compressed_from` column (JSON):**

```json
{
  "source_ids": ["abc123", "def456", ...],
  "compression_ratio": 3.4,
  "cluster_size": 7,
  "distilled_at": "2026-02-18T03:30:00-05:00",
  "source_date_range": ["2026-02-10T10:00:00Z", "2026-02-18T02:00:00Z"]
}
```

**Embedding generation:** The new memory is embedded immediately using the same embedding model as other memories. It becomes a first-class retrievable memory.

---

### 4.4 Archiver

**File:** `src/abstraction/archiver.ts`

**Purpose:** Downgrades source memories to archived state after successful compression.

#### `archiveMemories(memberIds: string[], clusterId: string, compressedMemoryId: string, db: Database): Promise<void>`

**Operations (all within a single SQLite transaction):**

1. `UPDATE memories SET importance = 0.5, archived_by = '{clusterId}', archived_at = '{ISO}' WHERE id IN ({memberIds})`
2. `INSERT INTO compression_log (cluster_fingerprint, compressed_memory_id, status, member_count, compression_ratio) VALUES (...)`

**Rollback behavior:** If any step inside the transaction fails:

- SQLite automatically rolls back both the importance update and the log insert
- The `MemoryWriter`-created compressed memory is deleted via a compensating action
- Cluster is logged as `failed` in a separate non-transactional write
- Source memories remain at their original importance — no corruption possible

**Critical safety:** `importance ≥ 2.5` memories are **never** candidates (filtered at ClusterFinder). The Archiver does not re-check; it trusts ClusterFinder's filter. This is documented here so the invariant is clear.

---

### 4.5 AtomEnricher

**File:** `src/abstraction/atom-enricher.ts`

**Purpose:** Extracts causal patterns from distillations and populates the atom graph.

#### `enrich(result: DistilledResult, cluster: MemoryCluster): Promise<AtomEnrichmentResult>`

Only called when `result.is_causal === true`.

**Extraction LLM call (Claude Haiku):**

System prompt:

```
You extract causal knowledge atoms from text. A causal atom has four fields:
- subject: WHO or WHAT acts (e.g., "Helios", "whale wallet", "Matthew")
- action: WHAT they do (e.g., "asserts without verifying", "accumulates BTC")
- outcome: WHAT results (e.g., "assertion is wrong", "price rises")
- consequences: WHAT follows downstream (e.g., "Matthew corrects; trust eroded")

Output ONLY valid JSON: { "subject": "...", "action": "...", "outcome": "...", "consequences": "..." }
If the text is not genuinely causal, output: { "not_causal": true }
```

**Deduplication before creating:**

1. `atom_search({ field: 'subject', query: extracted.subject })` — threshold 0.85
2. If a matching atom exists AND its action is semantically similar: strengthen confidence by +0.1 (not exceed 1.0)
3. If no match: `atom_create` with `confidence = 0.7` (synthetic origin, slightly lower than agent-sourced 1.0)

**Returns:**

```typescript
interface AtomEnrichmentResult {
  action: "created" | "strengthened" | "skipped" | "not_causal";
  atom_id?: string;
  confidence_delta?: number;
}
```

---

### 4.6 Reporter

**File:** `src/abstraction/reporter.ts`

**Purpose:** Aggregates run metrics into a structured report and posts Synapse summary.

#### `generateReport(runContext: RunContext): Promise<CompressionRunReport>`

**Report file location:** `~/Projects/helios/extensions/cortex/reports/compression-{run_id}.json`

**Synapse post:**

- `to: 'all'`
- `priority: 'info'` (default) or `'action'` if `errors.length > 0` or `verdict === 'FAIL'`
- Subject: `COMPRESSION RUN {verdict}: {abstractions_created} abstractions, {token_reduction_pct}% token reduction`

**Verdict logic:**

```
PASS    → clusters_compressed > 0 AND errors.length === 0
PARTIAL → clusters_compressed > 0 AND errors.length > 0
FAIL    → clusters_compressed === 0 (no useful work done) OR fatal error
```

---

### 4.7 AbstractionEngine (Orchestrator)

**File:** `src/abstraction/abstraction-engine.ts`

**Entry point:** `main()` — called by `~/bin/run-compression`

**Full execution sequence:**

```
1. Open brain.db connection
2. Run DB migration 008 if not yet applied
3. Capture pre-run token baseline (cortex_stats)
4. findClusters() → clusters[]
5. For each cluster (rate-limited at 10/min):
   a. distill(cluster) → result | null
   b. if null: log skipped, continue
   c. writeCompressedMemory(result) → compressed_id
   d. archiveMemories(cluster.memberIds, cluster_id, compressed_id) [with rollback on failure]
   e. enrich(result) [parallel, non-blocking]
6. Capture post-run token baseline
7. generateReport() → write JSON + post Synapse
8. Exit 0 (success) or 1 (FAIL verdict)
```

**Concurrency guard:** Creates a lock file at `/tmp/helios-compression.lock` on start. If lock exists, logs warning to Synapse and exits 0 (not 1 — lock is not an error, just a skip).

**Env requirements:**

- `ANTHROPIC_API_KEY` — for Haiku LLM calls
- `HELIOS_DB_PATH` — path to `brain.db` (defaults to `~/.openclaw/workspace/brain.db`)

---

## 5. Database Schema

### 5.1 New Table: `compression_log`

```sql
CREATE TABLE IF NOT EXISTS compression_log (
  id                  TEXT PRIMARY KEY,
  cluster_fingerprint TEXT NOT NULL,      -- SHA-256 of sorted member IDs
  compressed_memory_id TEXT,              -- memory.id of resulting abstraction
  status              TEXT NOT NULL,      -- 'compressed' | 'skipped' | 'failed'
  reason              TEXT,               -- populated for skipped/failed
  member_count        INTEGER NOT NULL,
  compression_ratio   REAL,
  run_id              TEXT NOT NULL,      -- links to report file
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_compression_log_fingerprint ON compression_log(cluster_fingerprint);
CREATE INDEX idx_compression_log_created     ON compression_log(created_at);
CREATE INDEX idx_compression_log_run         ON compression_log(run_id);
```

### 5.2 Extensions to `memories` Table

```sql
-- Added by migration 008
ALTER TABLE memories ADD COLUMN compressed_from TEXT;  -- JSON: { source_ids, compression_ratio, cluster_size, distilled_at, source_date_range }
ALTER TABLE memories ADD COLUMN archived_by     TEXT;  -- cluster_id if this memory was archived
ALTER TABLE memories ADD COLUMN archived_at     TEXT;  -- ISO timestamp
```

**Querying compressed memories:**

```sql
-- All compressed abstractions
SELECT * FROM memories WHERE compressed_from IS NOT NULL;

-- All archived source memories
SELECT * FROM memories WHERE archived_by IS NOT NULL;

-- Memories eligible for compression (not critical, not fresh, not already compressed/archived)
SELECT m.*, e.vector FROM memories m
JOIN embeddings e ON e.memory_id = m.id
WHERE m.importance < 2.5
  AND m.compressed_from IS NULL
  AND m.archived_by IS NULL
  AND m.created_at < datetime('now', '-1 day');
```

### 5.3 Migration File

**Path:** `src/migrations/008-compression.ts`

```typescript
export async function migrate008(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS compression_log ( ... );
    CREATE INDEX IF NOT EXISTS idx_compression_log_fingerprint ON compression_log(cluster_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_compression_log_created ON compression_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_compression_log_run ON compression_log(run_id);
  `);

  // Safe idempotent column additions
  for (const col of ["compressed_from TEXT", "archived_by TEXT", "archived_at TEXT"]) {
    try {
      await db.exec(`ALTER TABLE memories ADD COLUMN ${col}`);
    } catch {}
  }
}
```

---

## 6. Type Reference

```typescript
// src/types/compression.ts

export interface MemoryCluster {
  cluster_id: string; // uuid v4
  fingerprint: string; // SHA-256 of sorted member IDs
  member_ids: string[]; // memory IDs in cluster
  member_count: number;
  avg_similarity: number; // mean cosine similarity within cluster
  dominant_category: string; // most frequent category
  top_categories: string[]; // top-2 by frequency
  total_tokens: number; // estimated combined token count
  max_importance: number; // peak importance (used for compressed memory)
  oldest_member_at: string; // ISO timestamp
  newest_member_at: string; // ISO timestamp
}

export interface DistilledResult {
  abstraction: string; // compressed text
  compression_ratio: number; // original_tokens / compressed_tokens
  is_causal: boolean; // whether the pattern is causal
  input_tokens: number; // tokens fed to LLM
  output_tokens: number; // tokens returned by LLM
  llm_latency_ms: number;
}

export interface CompressedMemory {
  id: string;
  content: string;
  categories: string[];
  importance: number;
  compressed_from: {
    source_ids: string[];
    compression_ratio: number;
    cluster_size: number;
    distilled_at: string;
    source_date_range: [string, string];
  };
}

export interface AtomEnrichmentResult {
  action: "created" | "strengthened" | "skipped" | "not_causal";
  atom_id?: string;
  confidence_delta?: number;
  extracted?: {
    subject: string;
    action: string;
    outcome: string;
    consequences: string;
  };
}

export interface CompressionError {
  cluster_id: string;
  stage: "distill" | "write" | "archive" | "enrich";
  error: string;
  timestamp: string;
}

export interface CompressionRunReport {
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;

  // Scope
  memories_scanned: number;
  clusters_found: number;
  clusters_skipped: number;
  clusters_compressed: number;

  // Impact
  memories_archived: number;
  abstractions_created: number;
  atoms_created: number;
  atoms_enriched: number;

  // Token efficiency
  tokens_before: number;
  tokens_after: number;
  token_reduction_pct: number;

  // Quality
  avg_compression_ratio: number;
  max_compression_ratio: number;
  min_compression_ratio: number;

  // LLM usage
  total_llm_calls: number;
  total_llm_input_tokens: number;
  total_llm_output_tokens: number;
  estimated_cost_usd: number;

  // Errors
  errors: CompressionError[];

  verdict: "PASS" | "PARTIAL" | "FAIL";
  verdict_reason?: string; // populated on FAIL
}
```

---

## 7. Configuration

### 7.1 Engine Constants

All configurable via environment variables (with defaults):

| Variable                             | Default                          | Description                                      |
| ------------------------------------ | -------------------------------- | ------------------------------------------------ |
| `COMPRESSION_SIMILARITY_THRESHOLD`   | `0.82`                           | Cosine similarity floor for cluster membership   |
| `COMPRESSION_MIN_CLUSTER_SIZE`       | `3`                              | Minimum members to form a compressible cluster   |
| `COMPRESSION_FRESHNESS_HOURS`        | `24`                             | Memories younger than this are excluded          |
| `COMPRESSION_CRITICAL_FLOOR`         | `2.5`                            | Importance threshold for immunity                |
| `COMPRESSION_RATE_LIMIT_PER_MIN`     | `10`                             | Max LLM distillation calls per minute            |
| `COMPRESSION_MAX_RATIO`              | `1.5`                            | Minimum compression ratio to accept distillation |
| `COMPRESSION_FINGERPRINT_TTL_DAYS`   | `7`                              | Idempotency window for cluster fingerprints      |
| `COMPRESSION_MAX_ABSTRACTION_TOKENS` | `2000`                           | Max tokens in a single distillation              |
| `ANTHROPIC_API_KEY`                  | (required)                       | Anthropic API key for Haiku calls                |
| `HELIOS_DB_PATH`                     | `~/.openclaw/workspace/brain.db` | Path to brain.db                                 |

### 7.2 Cron Job

Registered via OpenClaw `cron` tool:

```json
{
  "name": "nightly-knowledge-compression",
  "schedule": { "kind": "cron", "expr": "30 3 * * *", "tz": "America/New_York" },
  "payload": {
    "kind": "systemEvent",
    "text": "Run nightly knowledge compression: cd ~/Projects/helios && ~/bin/run-compression"
  },
  "sessionTarget": "main",
  "enabled": true
}
```

**Ordering with dedup:** `cortex_dedupe` (exact-match) runs at 3:00 AM, compression at 3:30 AM. This ensures exact duplicates are cleaned before semantic clustering — avoids wasting LLM calls on near-identical memories that dedup would have removed.

---

## 8. Operational Guide

### 8.1 Cron Setup

Register the cron job once:

```bash
# Via Helios (preferred)
# Tell Helios: "Register the nightly knowledge compression cron at 3:30 AM"

# Or via CLI (direct OpenClaw cron)
openclaw cron add '{"name":"nightly-knowledge-compression","schedule":{"kind":"cron","expr":"30 3 * * *","tz":"America/New_York"},...}'
```

### 8.2 Manual Execution

```bash
# Full run
~/bin/run-compression

# Dry-run (scan clusters, no writes)
~/bin/run-compression --dry-run

# Single cluster by ID (for debugging)
~/bin/run-compression --cluster-id {uuid}

# Verbose output
~/bin/run-compression --verbose
```

The shell wrapper sets necessary environment variables and ensures the lock file is cleaned up on exit (even on SIGINT/SIGTERM).

### 8.3 Monitoring & Alerting

**Normal operation:** Synapse message posted after every run with verdict PASS/PARTIAL/FAIL.

**Alert conditions → `priority: 'action'` Synapse post:**

- `verdict === 'FAIL'`
- Any `CompressionError` in the errors array
- `token_reduction_pct < 0` (compression made things worse — should not happen)
- Run duration > 30 minutes (possible runaway)

**Self-healing integration:** If `~/bin/run-compression` exits with code 1, the task-006 self-healing cron detects the failure and posts a Synapse alert. No additional wiring needed.

**Checking last run:**

```bash
ls -t ~/Projects/helios/extensions/cortex/reports/compression-*.json | head -1 | xargs cat | jq '{verdict, abstractions_created, token_reduction_pct, errors}'
```

### 8.4 Interpreting Compression Reports

| Field                               | Good    | Warning     | Bad              |
| ----------------------------------- | ------- | ----------- | ---------------- |
| `token_reduction_pct`               | > 15%   | 5–15%       | < 5% or negative |
| `avg_compression_ratio`             | > 2.5   | 1.5–2.5     | < 1.5 (at floor) |
| `clusters_skipped / clusters_found` | < 20%   | 20–50%      | > 50%            |
| `errors.length`                     | 0       | 1–2         | > 2              |
| `estimated_cost_usd`                | < $0.10 | $0.10–$0.25 | > $0.25          |
| `verdict`                           | PASS    | PARTIAL     | FAIL             |

**High skip rate causes:**

- Many clusters already processed within last 7 days (idempotency guard working correctly)
- Many clusters with compression_ratio < 1.5 (memories too diverse within cluster — threshold may need tuning)
- LLM validation failures (distillation quality issues)

---

## 9. Integration Guide

### 9.1 Relationship to Existing Cortex Tools

| Tool             | Relationship to Abstraction Engine                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `cortex_dedupe`  | Runs before compression (3:00 AM). Exact-match dedup; Abstraction Engine handles semantic-cluster compression. They do not overlap. |
| `cortex_stm`     | Used to check memory freshness and identify recently written memories to exclude                                                    |
| `cortex_stats`   | Called before and after run to measure token delta                                                                                  |
| `atom_create`    | Called by AtomEnricher for new causal patterns                                                                                      |
| `atom_search`    | Called by AtomEnricher for deduplication before atom_create                                                                         |
| `cortex_predict` | Benefits from Abstraction Engine — compressed abstractions are higher-quality Insight sources                                       |
| `working_memory` | Pinned items are NOT candidates — they are outside brain.db (excluded at query level)                                               |

### 9.2 Impact on Context Injections

After a successful compression run, the next session will see:

- Fewer but denser entries in `hot-memory` and `semantic-memory` context blocks
- Source memories remain retrievable but score lower in retrieval (importance 0.5)
- Compressed abstractions surface first due to higher importance and `compressed` category tag

### 9.3 Adding New Distillation Strategies

The `Distiller` is designed for extension. To add a specialized distillation strategy for a specific category:

```typescript
// Implement DistillationStrategy interface
interface DistillationStrategy {
  name: string;
  matches(cluster: MemoryCluster): boolean;
  buildPrompt(cluster: MemoryCluster, memories: Memory[]): string;
  validate(result: DistilledResult): boolean;
}

// Register in distiller.ts
const strategies: DistillationStrategy[] = [
  new DefaultStrategy(),
  new TradingSignalStrategy(), // example: specialized for trading memories
  new CausalPatternStrategy(), // aggressive causal extraction
];
```

---

## 10. Behavioral Signatures & Failure Modes

### Normal Behavior

```
[03:30:01] AbstractionEngine: starting run {run_id}
[03:30:01] ClusterFinder: scanning 847 eligible memories
[03:30:03] ClusterFinder: found 12 clusters (3-18 members each)
[03:30:03] Distiller: processing cluster 1/12 (18 members, category=trading)
[03:30:04] Distiller: cluster 1 → ratio=4.2, is_causal=false
[03:30:04] MemoryWriter: wrote compressed memory {id}
[03:30:04] Archiver: archived 18 source memories
...
[03:35:22] Reporter: PASS — 9 abstractions, 3 atoms created, 23% token reduction
```

### Failure Modes

| Mode                   | Symptom                                                     | Cause                                                     | Recovery                                                                                       |
| ---------------------- | ----------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Lock contention        | `[WARN] compression already running, skipping`              | Previous run still in progress or crashed without cleanup | `rm /tmp/helios-compression.lock` then re-run                                                  |
| LLM API error          | Cluster logged as `skipped`, reason=`LLM error: 429`        | Rate limit or outage                                      | Auto-retry at next nightly run; manual `~/bin/run-compression` if urgent                       |
| Validation failure     | Cluster skipped, reason=`compression_ratio=1.2 below floor` | LLM produced insufficiently compressed output             | Normal — means that cluster wasn't compressible. No action needed.                             |
| DB transaction failure | Cluster logged as `failed`; source memories untouched       | SQLite lock, disk full, corruption                        | Check disk space; inspect SQLite integrity. Source memories are safe — no corruption possible. |
| No eligible memories   | `clusters_found: 0`, verdict=FAIL                           | Brain is fresh (<24h old), or already well-compressed     | Normal on freshly initialized system. Will improve after a week of operation.                  |
| Atom enricher error    | Logged in errors[]; compression still completes             | LLM extraction failure                                    | Non-fatal — compression proceeds without atom creation for that cluster                        |

### Anti-Patterns to Avoid

- **Do not delete compressed_log entries** to "reset" the engine — this breaks idempotency and may cause duplicate compression
- **Do not manually set `archived_by`** on memories — use only via Archiver (SQLite transaction guarantees consistency)
- **Do not change `COMPRESSION_CRITICAL_FLOOR`** below 2.0 — this risks compressing memories that are actually critical

---

## 11. Rollback & Recovery

### Scenario 1: Compressed memory is wrong/low-quality

```bash
# Find the compressed memory
sqlite3 ~/.openclaw/workspace/brain.db "SELECT id, content, compressed_from FROM memories WHERE compressed_from IS NOT NULL ORDER BY created_at DESC LIMIT 5;"

# Extract source IDs from compressed_from JSON
# Restore source importance (use the source_ids from the JSON)
sqlite3 ~/.openclaw/workspace/brain.db "UPDATE memories SET importance = 1.5, archived_by = NULL, archived_at = NULL WHERE id IN ('id1', 'id2', ...);"

# Delete the bad compressed memory
sqlite3 ~/.openclaw/workspace/brain.db "DELETE FROM memories WHERE id = '{compressed_id}';"

# Remove the compression_log entry so it can re-run
sqlite3 ~/.openclaw/workspace/brain.db "DELETE FROM compression_log WHERE compressed_memory_id = '{compressed_id}';"
```

### Scenario 2: Entire run was bad

```bash
# Find all compressions from a specific run
sqlite3 ~/.openclaw/workspace/brain.db "SELECT * FROM compression_log WHERE run_id = '{run_id}';"

# Restore all sources and delete all compressions from that run
# (use the rollback script in ~/bin/compression-rollback)
~/bin/compression-rollback --run-id {run_id}
```

The `compression-rollback` script is shipped with the engine and accepts `--run-id` or `--since {ISO-timestamp}`.

### Scenario 3: DB corruption

- The Abstraction Engine never modifies the `embeddings` table structure
- All writes use SQLite WAL mode — no partial writes
- Backup is created by the pre-compression snapshot in `~/bin/run-compression` before any writes

---

## 12. Cost & Performance Characteristics

### LLM Cost (Claude Haiku, Feb 2026 pricing)

| Scenario                   | Clusters | Avg Cluster Size | Estimated Cost                   |
| -------------------------- | -------- | ---------------- | -------------------------------- |
| Lean night (new system)    | 5        | 4                | ~$0.01                           |
| Typical night (active use) | 30       | 8                | ~$0.06                           |
| Heavy night (post-sprint)  | 80       | 12               | ~$0.16                           |
| Capped maximum             | 100+     | any              | ~$0.25 (hard cap via rate limit) |

Cost formula: `clusters × 2 LLM calls × avg_input_tokens × $0.00025/1K_tokens`

### Runtime Performance

| Phase                          | Typical Duration | Bottleneck                   |
| ------------------------------ | ---------------- | ---------------------------- |
| Cluster finding (800 memories) | 2–5 seconds      | Cosine similarity batches    |
| Distillation (30 clusters)     | 60–90 seconds    | LLM API latency + rate limit |
| Memory writes                  | < 1 second       | SQLite                       |
| Total nightly run              | 2–3 minutes      | LLM calls                    |

### Token Reduction Projections

Based on design targets:

- Week 1 post-deploy: ~10–15% reduction (less accumulated history)
- Month 1: ~30–40% reduction (approaching design target)
- Steady-state: ~40% reduction sustained (ongoing consolidation keeps up with accumulation)

---

## 13. Decision Log

| Decision                                          | Rationale                                                                    | Alternatives Considered                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Claude Haiku for LLM calls (not OpenClaw routing) | Direct SDK = lower latency, predictable cost, no OpenClaw tool overhead      | OpenClaw tool routing (rejected: adds latency, complicates rate control)                              |
| Single-linkage clustering (not k-means)           | No hyperparameter tuning needed; handles non-spherical clusters              | k-means (rejected: requires choosing k), DBSCAN (rejected: more complex, similar result)              |
| Threshold 0.82                                    | Conservative — reduces false positives (unrelated memories grouped together) | 0.75 (too aggressive, groups loose concepts), 0.90 (too strict, misses obvious clusters)              |
| Never delete source memories                      | Preserves auditability; importance=0.5 effectively hides them from context   | Hard delete (rejected: irreversible, breaks audit trail)                                              |
| No compression of compressed memories             | Avoids semantic drift through multiple distillation passes                   | Allow 2nd-order compression (rejected: risk of lossy abstraction of abstractions)                     |
| Atom confidence=0.7 for distilled origins         | Synthetic atoms are less reliable than directly observed patterns            | 0.5 (too low — dismisses valid patterns), 1.0 (too high — equals direct observation)                  |
| Top-2 category inheritance                        | Captures multi-domain memories without over-tagging                          | All categories (rejected: too many tags dilutes search), 1 category only (rejects valid cross-domain) |

---

## 14. Glossary

| Term                          | Definition                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Abstraction**               | A compressed memory produced by distilling a cluster of related memories. Stored with `compressed_from` metadata. |
| **Archival**                  | Setting a source memory's importance to 0.5 after successful compression. Does not delete.                        |
| **Atom**                      | An atomic causal unit: `{subject, action, outcome, consequences}`. Stored in the atom graph.                      |
| **Atom Enrichment**           | Creating or strengthening an atom from a causal distillation result.                                              |
| **Cluster**                   | A group of ≥3 semantically related memories with cosine similarity ≥0.82 between all member pairs.                |
| **Cluster Fingerprint**       | SHA-256 of sorted member IDs — uniquely identifies a cluster for idempotency checking.                            |
| **Compression Ratio**         | `original_tokens / compressed_tokens`. A ratio of 3.4 means the abstraction is 3.4x shorter.                      |
| **Critical Memory**           | A memory with importance ≥ 2.5. Permanently immune from compression.                                              |
| **Distillation**              | The LLM-synthesis process that converts a cluster into a single abstraction.                                      |
| **Idempotency**               | Running compression on an already-compressed cluster produces no changes (fingerprint check).                     |
| **Single-Linkage Clustering** | Merges the two closest members (by cosine similarity) iteratively until no pair exceeds the threshold.            |
| **Verdict**                   | PASS / PARTIAL / FAIL — overall assessment of a compression run.                                                  |

---

_Stage document complete. Next stage: build (TypeScript implementation)_
_Pipeline: requirements → design → **document** → build → security → test → deploy → done_
