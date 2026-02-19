# Task-009: Cross-Domain Pattern Transfer — Technical Documentation

**Stage:** document | **Status:** complete
**Phase:** 5.5 | **Date:** 2026-02-18
**Author:** Pipeline Documentation Specialist

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture Summary](#2-architecture-summary)
3. [Data Model Reference](#3-data-model-reference)
4. [Module Reference](#4-module-reference)
5. [Configuration Reference](#5-configuration-reference)
6. [Database Schema](#6-database-schema)
7. [Operational Runbook](#7-operational-runbook)
8. [Integration Guide](#8-integration-guide)
9. [Extractor Plugin Guide](#9-extractor-plugin-guide)
10. [Hypothesis Lifecycle](#10-hypothesis-lifecycle)
11. [Troubleshooting](#11-troubleshooting)
12. [Glossary](#12-glossary)

---

## 1. Overview

The **Cross-Domain Pattern Transfer (CDPT) Engine** is Phase 5.5 of the Cortex improvement plan. It gives Helios the ability to recognize when a validated pattern in one operational domain is **structurally identical** to a nascent or untested pattern in another domain — and to surface that recognition as cross-pollination alerts and testable hypotheses.

### 1.1 The Core Problem It Solves

Helios operates across four structurally distinct domains — **trading**, **ham radio**, **fleet/infra**, and **meta/AI** — accumulating knowledge in each independently. Without CDPT, a pattern validated in trading (e.g., VWAP divergence predicts reversal) is never compared to a structurally analogous pattern in radio (solar flux divergence predicts propagation fade). Human experts make these cross-domain leaps instinctively; CDPT makes Helios do it systematically.

### 1.2 What It Produces

| Output                    | Where Stored                                                             | Audience                    |
| ------------------------- | ------------------------------------------------------------------------ | --------------------------- |
| Cross-domain fingerprints | `brain.db:cross_domain_patterns`                                         | Engine (matching input)     |
| Similarity matches        | `brain.db:cross_domain_matches`                                          | Engine + reports            |
| Domain metaphors          | `brain.db:domain_metaphors` + cortex memory                              | Helios in-context reasoning |
| Cross-pollination alerts  | Synapse + `cortex_predict` + atoms                                       | Matthew (action items)      |
| Testable hypotheses       | Cortex memories (`hypothesis` category)                                  | Matthew + Helios            |
| Nightly run report        | `~/Projects/helios/extensions/cortex/reports/cross-domain-{run_id}.json` | Archive                     |

### 1.3 What It Doesn't Do

- Does **not** modify any domain-specific system (AUGUR, ft991a-control, fleet scripts)
- Does **not** auto-apply cross-domain patterns to production — generates hypotheses only
- Does **not** perform real-time per-transaction analysis (nightly batch + event-triggered)
- Does **not** replace domain-specific models; reads their outputs

---

## 2. Architecture Summary

The engine operates as a three-stage pipeline:

```
EXTRACT → MATCH → SYNTHESIZE
```

### Stage 1: Extract

Five domain extractors convert raw data into normalized **PatternFingerprints** — 12-dimensional domain-agnostic structural vectors. Each extractor is a plugin registered at startup; new domains are added by dropping a new `*.extractor.ts` file with zero core changes.

**Extractors (initial set):**

| Extractor          | Source                        | Key Pattern Types                              |
| ------------------ | ----------------------------- | ---------------------------------------------- |
| `AtomExtractor`    | `brain.db` atoms              | Causal structures (divergence, cascade, decay) |
| `MemoryExtractor`  | `brain.db` memories           | Compressed abstractions, domain knowledge      |
| `TradingExtractor` | AUGUR SQLite                  | Signal WR, divergence type, decay curves       |
| `RadioExtractor`   | ft991a-control logs + WEMS    | Propagation windows, fade events, band cycles  |
| `FleetExtractor`   | ITSM events, self-healing log | SLA drift, cascade failure, recovery time      |

All fingerprints are normalized via `PatternNormalizer` before storage. Under-specified fingerprints (>6 zero dimensions) and low-confidence fingerprints (<0.2) are rejected.

### Stage 2: Match

The **Similarity Index** computes pairwise cosine similarity across all cross-domain fingerprint pairs (same-domain pairs are excluded). Pairs scoring ≥ 0.75 become `CrossDomainMatch` records. Each match is classified as:

- **`structural`**: geometric similarity only — generates metaphor
- **`causal`**: both patterns have confirmed causal outcomes (atom records) — generates metaphor + alert
- **`temporal`**: high similarity specifically in decay/lead-time dimensions — generates temporal hypothesis

### Stage 3: Synthesize

Three synthesizers operate on match records:

- **MetaphorEngine**: generates human-readable cross-domain analogies
- **AlertGenerator**: fires cross-pollination alerts when a validated pattern (≥0.8 confidence) matches an untested analog (≤0.6 confidence) in another domain
- **HypothesisGenerator**: produces explicit testable hypotheses with observation protocols

All outputs are stored in `brain.db`, cortex memory, atoms, and Synapse.

---

## 3. Data Model Reference

### 3.1 PatternFingerprint

The irreducible unit of CDPT. Every observation from every domain is converted to this normalized structure before any cross-domain comparison.

```typescript
interface PatternFingerprint {
  fingerprint_id: string; // uuid v4
  source_domain: DomainID; // 'trading' | 'radio' | 'fleet' | 'meta'
  source_id: string; // original record ID in source system
  source_type: SourceType; // 'atom' | 'memory' | 'signal' | 'event'
  label: string; // human-readable: "BNKR-USD VWAP SHORT divergence"
  confidence: number; // 0–1; bootstrap fingerprints capped at 0.3
  schema_version: number; // bumped on dimension schema changes (current: 1)

  structure: {
    // Temporal shape (4 dims)
    trend_direction: number; // [-1,1]: -1=falling, +1=rising
    trend_strength: number; // [0,1]: 0=flat, 1=strong trend
    oscillation_frequency: number; // [0,1]: 0=monotonic, 1=high-freq
    reversion_force: number; // [0,1]: 0=trending, 1=strong mean-reversion

    // Divergence dynamics (2 dims)
    divergence_magnitude: number; // [0,1]: 0=none, 1=maximum separation
    divergence_polarity: number; // [-1,1]: -1=converging, +1=diverging

    // Risk/threshold dynamics (2 dims)
    threshold_proximity: number; // [0,1]: 0=far, 1=at threshold
    cascade_potential: number; // [0,1]: 0=isolated, 1=high cascade risk

    // Temporal decay (2 dims)
    signal_decay_rate: number; // [0,1]: 0=persistent, 1=fast-decaying
    lead_time_normalized: number; // [0,1]: 0=coincident, 1=long lead time

    // Magnitude (2 dims)
    effect_size: number; // [0,1]: 0=weak, 1=large effect
    frequency_of_occurrence: number; // [0,1]: 0=rare, 1=very frequent
  };

  run_id: string; // CDPT run that created this fingerprint
  created_at: string; // ISO 8601
}
```

**Dimension rationale:** The 12 dimensions capture the complete structural vocabulary shared across all four domains. Any time-series observation — a price pattern, an RF propagation window, a service SLA drift, or a memory importance decay curve — can be meaningfully expressed in these 12 dimensions. Normalization is z-score within domain then clipped to [-1,1], ensuring cross-domain comparisons are fair (a "strong" signal in radio equals a "strong" signal in trading relative to its own domain's scale).

---

### 3.2 CrossDomainMatch

```typescript
interface CrossDomainMatch {
  match_id: string; // uuid v4
  fingerprint_a_id: string;
  fingerprint_b_id: string;
  domain_a: DomainID;
  domain_b: DomainID;
  similarity_score: number; // cosine similarity [0,1]
  match_type: MatchType; // 'structural' | 'causal' | 'temporal'
  transfer_opportunity: boolean; // a_confidence ≥0.8 && b_confidence <0.6
  a_confidence: number;
  b_confidence: number;
  metaphor_id?: string;
  hypothesis_id?: string;
  alert_sent: boolean;
  created_at: string;
}
```

**Idempotency:** A `(fingerprint_a_id, fingerprint_b_id)` pair is not re-matched within 30 days unless confidence delta > 0.15. Prevents alert spam on slow-moving patterns.

---

### 3.3 DomainMetaphor

```typescript
interface DomainMetaphor {
  metaphor_id: string;
  match_id: string | null; // null for multi-domain clique metaphors
  domains_involved: DomainID[];
  pattern_label: string; // universal name: "Divergence-Reversion"
  text: string; // 1-2 sentences, no domain-specific jargon
  shared_mechanism: string; // underlying mechanism both domains share
  confidence: number; // avg confidence across participating domains
  created_at: string;
}
```

**Multi-domain grouping:** When ≥3 patterns from different domains form a similarity clique, a single unified metaphor is generated instead of N² pairwise metaphors.

---

### 3.4 CrossPollinationAlert

```typescript
interface CrossPollinationAlert {
  alert_id: string;
  match_id: string;
  source_domain: DomainID;
  source_pattern: string;
  source_confidence: number; // e.g., 0.85
  source_win_rate?: number; // if trading signal
  target_domain: DomainID;
  target_pattern: string;
  target_confidence: number; // e.g., 0.35 — low = transfer opportunity
  transfer_recommendation: string; // LLM-generated 1-sentence recommendation
  urgency: "info" | "action"; // 'action' if source WR ≥85% or cascade ≥0.8
  created_at: string;
}
```

---

### 3.5 Hypothesis

Not a standalone record type — stored as a cortex memory with category `['hypothesis', <target_domain_category>]`.

**Required prefix:** All hypotheses begin with `HYPOTHESIS [UNVALIDATED]:` to prevent false confidence.

**Template:**

```
HYPOTHESIS [UNVALIDATED]:
IF [mechanism from Domain A] operates similarly in [Domain B],
THEN [predicted observable outcome in Domain B] within [lead_time from Domain A] —
testable by [specific observation method in Domain B].
Derived from: [source_pattern] (confidence {a_confidence}) ↔ [target_pattern] (confidence {b_confidence}).
Match score: {similarity_score}. Created: {date}.
```

---

## 4. Module Reference

### 4.1 `cdpt-engine.ts` — Main Orchestrator

Entry point. Orchestrates the full pipeline for a single run.

```typescript
// Public API
async function runCDPT(options?: CDPTOptions): Promise<CDPTRunResult>;

interface CDPTOptions {
  runId?: string; // auto-generated uuid if omitted
  domainFilter?: DomainID[]; // run only specified domains; default: all
  dryRun?: boolean; // extract + match but don't write synthesis outputs
  matchThreshold?: number; // override CDPT_MATCH_THRESHOLD for this run
}

interface CDPTRunResult {
  run_id: string;
  fingerprints_extracted: number;
  fingerprints_rejected: number;
  matches_found: number;
  new_matches: number; // excluding 30-day idempotency cache hits
  metaphors_generated: number;
  alerts_fired: number;
  hypotheses_generated: number;
  report_path: string;
  duration_ms: number;
}
```

**Lifecycle per run:**

1. Initialize DB (run migration if needed)
2. Load registered extractors
3. Run all extractors → collect raw fingerprints
4. Normalize all fingerprints → store in `cross_domain_patterns`
5. Run matcher → store new matches in `cross_domain_matches`
6. Run synthesizers (metaphor, alert, hypothesis) for new matches
7. Publish Synapse report
8. Write JSON run report to `~/Projects/helios/extensions/cortex/reports/`

---

### 4.2 `normalizer.ts` — Pattern Normalizer

```typescript
// Normalizes a batch of raw fingerprints from a single domain
async function normalizeDomainBatch(
  raw: RawFingerprint[],
  domain: DomainID,
): Promise<{ accepted: PatternFingerprint[]; rejected: RejectionRecord[] }>;

// Rejection reasons
type RejectionReason =
  | "under_specified" // >6 zero dimensions
  | "low_confidence" // confidence < 0.2
  | "invalid_range" // dimension outside [-1,1]
  | "missing_label";
```

Normalization is z-score within domain then clip to [-1,1]. Domain statistics are computed from the batch itself on first run, then updated incrementally via exponential moving average (α=0.1) — this prevents new domains from being dominated by outlier fingerprints.

---

### 4.3 `matcher.ts` — Similarity Index

```typescript
async function runMatchingPass(runId: string, options?: MatchOptions): Promise<MatchResult>;

interface MatchOptions {
  threshold?: number; // default: CDPT_MATCH_THRESHOLD (0.75)
  idempotencyDays?: number; // default: 30
  batchSize?: number; // fingerprint batch size for N² pre-filter; default: 500
}
```

**Algorithm detail:**

1. Load all accepted fingerprints from `cross_domain_patterns`
2. Pre-filter pairs by sign-bucket on `divergence_polarity` and `trend_direction` — eliminates ~60% of candidate pairs before cosine computation
3. Batch cosine similarity in chunks of `batchSize × batchSize`
4. For each pair where `domain_a ≠ domain_b` and `score ≥ threshold`:
   - Check idempotency cache (30-day window)
   - Insert into `cross_domain_matches` if new or confidence-changed
5. Return match count, new matches, cache hits

**Performance target:** < 30s for 1,000 fingerprints across all domains. Scales to ~2,000 fingerprints before requiring approximate nearest neighbor (ANN) index upgrade.

---

### 4.4 `classifier.ts` — Match Type Classifier

```typescript
function classifyMatch(
  a: PatternFingerprint,
  b: PatternFingerprint,
  score: number,
  atomIndex: Map<string, Atom>,
): MatchType;

// Rule-based, no LLM call:
// 1. Compute cosine similarity on temporal sub-dimensions only
//    [signal_decay_rate, lead_time_normalized, oscillation_frequency]
// 2. If temporal sub-score > 0.88 → 'temporal'
// 3. If both source_ids have atom records → 'causal'
// 4. Otherwise → 'structural'
```

Classification is deterministic and cheap — no LLM call, runs in O(1) per pair.

---

### 4.5 `extractors/atom-extractor.ts`

```typescript
class AtomExtractor implements DomainExtractor {
  readonly domain = "meta";
  readonly version = "1.0.0";

  async extract(options?: ExtractOptions): Promise<PatternFingerprint[]>;
}
```

**Mapping strategy (in priority order):**

1. **Keyword heuristics** (fast, free): regex patterns on atom `action`, `outcome`, `consequences` fields map to structural dimensions directly. Covers ~70% of atoms with confidence ≥ 0.7.
2. **LLM-assisted fallback** (slow, costs $): for atoms where heuristics produce > 4 near-zero dimensions or confidence < 0.5, calls Claude Haiku with a structured extraction prompt. Batched in groups of 20 per API call to minimize latency.

**Keyword → dimension mapping (selected examples):**

| Keyword pattern | Dimension      | Value logic            |
| --------------- | -------------- | ---------------------- | --------------------- | ---- |
| `diverge        | separate       | widen`                 | `divergence_polarity` | +0.7 |
| `converge       | narrow         | revert`                | `divergence_polarity` | -0.7 |
| `cascade        | propagat       | spread`                | `cascade_potential`   | +0.8 |
| `decay          | diminish       | fade`                  | `signal_decay_rate`   | +0.7 |
| `SHORT          | bearish        | sell`                  | `trend_direction`     | -0.8 |
| `LONG           | bullish        | buy`                   | `trend_direction`     | +0.8 |
| `82% WR         | high win rate` | `effect_size`          | +0.8                  |
| `within 4h      | 4h lead`       | `lead_time_normalized` | calculated            |

---

### 4.6 `extractors/trading-extractor.ts`

```typescript
class TradingExtractor implements DomainExtractor {
  readonly domain = "trading";
  readonly version = "1.0.0";

  async extract(options?: ExtractOptions): Promise<PatternFingerprint[]>;
}
```

**Data sources (in resolution order):**

1. `AUGUR_DB_PATH` env var → SQLite signals database
2. Signal miner JSON artifacts at `~/Projects/augur-trading/signals/` (fallback if DB unavailable)

**Extraction logic:**

- Only signals with ≥10 occurrences are extracted (below this: insufficient evidence for fingerprinting)
- Signal WR → `effect_size` (WR=0.5 → 0.0, WR=1.0 → 1.0, linear)
- Signal direction (LONG/SHORT) → `trend_direction`
- Lead time relative to 10h max → `lead_time_normalized`
- VWAP divergence type → `divergence_magnitude = 0.8`, `reversion_force = 0.7`
- Signal count per product → `frequency_of_occurrence`
- **Confidence mapping:** WR ≥ 0.80 → confidence = WR; WR < 0.80 → confidence = WR × 0.8 (penalty for below-threshold)

---

### 4.7 `extractors/radio-extractor.ts`

```typescript
class RadioExtractor implements DomainExtractor {
  readonly domain = "radio";
  readonly version = "1.0.0";

  async extract(options?: ExtractOptions): Promise<PatternFingerprint[]>;
  private isBootstrapMode(): boolean; // true if < 20 observations
}
```

**Bootstrap mode:** When < 20 radio observations are available, all extracted fingerprints are capped at `confidence = 0.3` and tagged `bootstrap: true`. Bootstrap fingerprints:

- Included in matching (so patterns can be found early)
- **Excluded** from cross-pollination alerts (`transfer_opportunity` check requires source confidence ≥ 0.8)
- Included in structural metaphors (labeled "nascent" in the metaphor text)

**Data sources:**

- `RADIO_LOG_PATH` env var → ft991a-control log directory
- WEMS API for solar flux, K-index, A-index time series

**Extracted patterns:**

- Propagation window open/close events → divergence cycle fingerprints
- Solar flux vs. baseline divergence → `divergence_magnitude`, `lead_time_normalized`
- Band cycle periodicity (daily ionospheric) → `oscillation_frequency`
- Signal fade events → `signal_decay_rate`, `divergence_polarity`

---

### 4.8 `extractors/fleet-extractor.ts`

```typescript
class FleetExtractor implements DomainExtractor {
  readonly domain = "fleet";
  readonly version = "1.0.0";

  async extract(options?: ExtractOptions): Promise<PatternFingerprint[]>;
}
```

**Data sources:**

- Cortex ITSM tool output (fleet status API)
- Cortex memories in `infrastructure` and `system` categories
- Self-healing event log from task-006 artifacts
- OctoPrint progress events

**Extracted patterns:**

- Service degradation: metric drift → threshold breach → `threshold_proximity` curve, `cascade_potential`
- Recovery time after incident → `signal_decay_rate` analog
- SLA drift patterns → `trend_direction` + `trend_strength` + `threshold_proximity`
- Multi-service cascade failures → `cascade_potential = 0.9+`

---

### 4.9 `extractors/memory-extractor.ts`

```typescript
class MemoryExtractor implements DomainExtractor {
  readonly domain = "meta"; // shares domain tag with AtomExtractor
  readonly version = "1.0.0";

  async extract(options?: ExtractOptions): Promise<PatternFingerprint[]>;
}
```

**Priority targeting:**

1. Memories with `importance ≥ 2.0` AND causal keywords in content
2. Memories tagged `compressed` from task-008 (already distilled patterns)
3. Memories in `trading`, `radio`, `infrastructure` categories with `importance ≥ 1.5`

**Extraction:** Uses same keyword heuristic + LLM fallback as AtomExtractor, applied to memory content. Compressed memories tend to produce cleaner fingerprints (already abstracted) with fewer LLM fallback calls.

---

### 4.10 `synthesizers/metaphor-engine.ts`

```typescript
async function generateMetaphor(
  match: CrossDomainMatch,
  fingerprintA: PatternFingerprint,
  fingerprintB: PatternFingerprint,
): Promise<DomainMetaphor>;

async function generateCliqueMetaphor(
  clique: CrossDomainMatch[],
  fingerprints: Map<string, PatternFingerprint>,
): Promise<DomainMetaphor>;
```

**LLM prompt (Claude Haiku):**

```
Given two observed patterns in different domains with structural similarity:

Pattern A (domain: {domain_a}): {label_a}
Key dimensions: {top_similar_dimensions}
Pattern B (domain: {domain_b}): {label_b}
Key dimensions: {top_similar_dimensions}
Similarity score: {score:.2f}

Produce JSON:
{
  "metaphor_text": "...",       // 1-2 sentences; understandable by non-expert in either domain
  "pattern_label": "...",       // universal name for the shared structure (e.g., "Divergence-Reversion")
  "shared_mechanism": "..."     // 1 sentence: the common underlying mechanism
}
```

**Storage:** Stored in `domain_metaphors` table + cortex memory (category: `['cross_domain', 'meta']`, importance: 1.5). Top-3 metaphors by similarity score are injected into semantic memory for Helios's in-context reasoning.

---

### 4.11 `synthesizers/alert-generator.ts`

```typescript
async function generateAlert(
  match: CrossDomainMatch,
  fingerprintA: PatternFingerprint,
  fingerprintB: PatternFingerprint,
): Promise<CrossPollinationAlert | null>;
// Returns null if transfer_opportunity = false or match_type = 'structural'
```

**Fires when:**

- `transfer_opportunity = true` (source confidence ≥ 0.8, target confidence < 0.6)
- `match_type` is `causal` or `temporal` (not `structural` alone)
- Not already alerted on this match

**Urgency rules:**

- `action`: source `win_rate ≥ 0.85` OR `cascade_potential ≥ 0.8` in source fingerprint
- `info`: all other cases

**Output pipeline per alert:**

1. `atom_create` — stores alert as causal atom with `source: 'cross-domain'`
2. `cortex_add` — stores as memory (category: `['cross_domain', <target_category>]`, importance: 2.0 for action, 1.5 for info)
3. `cortex_predict` — feeds into predictive intent pipeline as high-urgency insight
4. Synapse message — posted to thread `task-009-cross-domain-transfer` (info priority for info, action priority for action)

---

### 4.12 `synthesizers/hypothesis-generator.ts`

```typescript
async function generateHypothesis(
  match: CrossDomainMatch,
  fingerprintA: PatternFingerprint,
  fingerprintB: PatternFingerprint,
): Promise<string>; // Returns cortex memory ID of stored hypothesis
```

**Called for:** `causal` and `temporal` match types only. Capped at 10 hypotheses per run (quality over quantity).

**LLM model:** Claude Sonnet (higher quality required for a useful testable hypothesis).

**Required prefix enforcement:** All generated text is validated to start with `HYPOTHESIS [UNVALIDATED]:` before storage; if LLM omits it, it is prepended programmatically.

**Confidence assignment:** New cross-domain hypothesis atoms start at `confidence = 0.6` — lower than agent-confirmed observations (1.0) or compressed abstractions (0.7), higher than pure speculation. This reflects the transfer hypothesis nature.

---

### 4.13 `reporter.ts` — Run Reporter

```typescript
async function publishRunReport(result: CDPTRunResult, matches: CrossDomainMatch[]): Promise<void>;
```

Publishes:

1. JSON run report to `~/Projects/helios/extensions/cortex/reports/cross-domain-{run_id}.json`
2. Synapse summary to thread `task-009-cross-domain-transfer` with:
   - Run statistics (fingerprints, matches, alerts, hypotheses)
   - Top-5 matches by similarity score with metaphor text
   - Any `action`-urgency alerts from this run

---

## 5. Configuration Reference

### 5.1 Environment Variables

| Variable                   | Default                                    | Description                                          |
| -------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `AUGUR_DB_PATH`            | `~/Projects/augur-trading/data/signals.db` | AUGUR signals SQLite path                            |
| `RADIO_LOG_PATH`           | `~/Projects/lbf-ham-radio/logs/`           | ft991a-control log directory                         |
| `CDPT_MATCH_THRESHOLD`     | `0.75`                                     | Minimum cosine similarity for a match                |
| `CDPT_ALERT_SOURCE_MIN`    | `0.80`                                     | Min source confidence to trigger cross-poll alert    |
| `CDPT_ALERT_TARGET_MAX`    | `0.60`                                     | Max target confidence (below = transfer opportunity) |
| `CDPT_IDEMPOTENCY_DAYS`    | `30`                                       | Days before re-matching same fingerprint pair        |
| `CDPT_MAX_HYPOTHESES`      | `10`                                       | Max new hypotheses per run                           |
| `CDPT_BOOTSTRAP_THRESHOLD` | `20`                                       | Min observations for a domain to exit bootstrap mode |
| `CDPT_DRY_RUN`             | `false`                                    | Extract + match but skip synthesis outputs           |

### 5.2 `cdpt-config.json`

Optional config file in repo root. Overrides env vars and controls extractor registration:

```json
{
  "extractors": {
    "atom": { "enabled": true },
    "memory": { "enabled": true },
    "trading": { "enabled": true },
    "radio": { "enabled": true, "bootstrapMode": true },
    "fleet": { "enabled": true }
  },
  "matching": {
    "threshold": 0.75,
    "idempotencyDays": 30,
    "batchSize": 500
  },
  "synthesis": {
    "metaphors": true,
    "alerts": true,
    "hypotheses": true,
    "maxHypothesesPerRun": 10
  },
  "llm": {
    "extractionModel": "claude-haiku-20240307",
    "metaphorModel": "claude-haiku-20240307",
    "hypothesisModel": "claude-sonnet-4-5"
  }
}
```

---

## 6. Database Schema

### 6.1 `cross_domain_patterns`

```sql
CREATE TABLE IF NOT EXISTS cross_domain_patterns (
  fingerprint_id    TEXT PRIMARY KEY,
  source_domain     TEXT NOT NULL CHECK (source_domain IN ('trading','radio','fleet','meta')),
  source_id         TEXT NOT NULL,
  source_type       TEXT NOT NULL CHECK (source_type IN ('atom','memory','signal','event')),
  label             TEXT NOT NULL,
  confidence        REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  bootstrap         INTEGER NOT NULL DEFAULT 0,  -- 1 = low-observation bootstrap fingerprint
  schema_version    INTEGER NOT NULL DEFAULT 1,
  structure         JSON NOT NULL,               -- 12-dim object
  run_id            TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(source_id, source_type, run_id)          -- idempotent per run per source
);

CREATE INDEX idx_cdp_domain      ON cross_domain_patterns(source_domain);
CREATE INDEX idx_cdp_confidence  ON cross_domain_patterns(confidence);
CREATE INDEX idx_cdp_run         ON cross_domain_patterns(run_id);
CREATE INDEX idx_cdp_bootstrap   ON cross_domain_patterns(bootstrap);
```

### 6.2 `cross_domain_matches`

```sql
CREATE TABLE IF NOT EXISTS cross_domain_matches (
  match_id            TEXT PRIMARY KEY,
  fingerprint_a_id    TEXT NOT NULL REFERENCES cross_domain_patterns(fingerprint_id),
  fingerprint_b_id    TEXT NOT NULL REFERENCES cross_domain_patterns(fingerprint_id),
  domain_a            TEXT NOT NULL,
  domain_b            TEXT NOT NULL,
  similarity_score    REAL NOT NULL,
  match_type          TEXT NOT NULL CHECK (match_type IN ('structural','causal','temporal')),
  transfer_opportunity INTEGER NOT NULL DEFAULT 0,
  a_confidence        REAL NOT NULL,
  b_confidence        REAL NOT NULL,
  metaphor_id         TEXT,
  hypothesis_id       TEXT,
  alert_sent          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(fingerprint_a_id, fingerprint_b_id)       -- prevent A-B and B-A duplication
);

CREATE INDEX idx_cdm_domains   ON cross_domain_matches(domain_a, domain_b);
CREATE INDEX idx_cdm_score     ON cross_domain_matches(similarity_score DESC);
CREATE INDEX idx_cdm_transfer  ON cross_domain_matches(transfer_opportunity)
  WHERE transfer_opportunity = 1;
CREATE INDEX idx_cdm_alert     ON cross_domain_matches(alert_sent)
  WHERE alert_sent = 0;
```

### 6.3 `domain_metaphors`

```sql
CREATE TABLE IF NOT EXISTS domain_metaphors (
  metaphor_id       TEXT PRIMARY KEY,
  match_id          TEXT,                          -- NULL for multi-domain clique
  domains_involved  JSON NOT NULL,                 -- ["trading","radio"]
  pattern_label     TEXT NOT NULL,
  text              TEXT NOT NULL,
  shared_mechanism  TEXT NOT NULL,
  confidence        REAL NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_dm_pattern ON domain_metaphors(pattern_label);
CREATE INDEX idx_dm_created ON domain_metaphors(created_at DESC);
```

### 6.4 Migration

File: `src/migrations/009-cross-domain.ts`

Migration is idempotent — uses `CREATE TABLE IF NOT EXISTS` and index creation with `IF NOT EXISTS`. Safe to run multiple times.

---

## 7. Operational Runbook

### 7.1 Manual Run

```bash
~/bin/run-cross-domain
# Or directly:
cd ~/Projects/helios && npx tsx src/cross-domain/cdpt-engine.ts
```

**With options:**

```bash
# Dry run (no writes to synthesis outputs):
CDPT_DRY_RUN=true ~/bin/run-cross-domain

# Single domain extraction only:
cd ~/Projects/helios && npx tsx src/cross-domain/cdpt-engine.ts --domain trading

# Custom threshold:
CDPT_MATCH_THRESHOLD=0.80 ~/bin/run-cross-domain
```

### 7.2 Scheduled Operation

Runs nightly via cron at 04:00 America/New_York, after knowledge compression (03:30).

To check scheduled run history:

```bash
openclaw cron list | grep cross-domain
```

### 7.3 Inspecting Run Output

**Latest run report:**

```bash
ls -lt ~/Projects/helios/extensions/cortex/reports/cross-domain-*.json | head -1
cat $(ls -lt ~/Projects/helios/extensions/cortex/reports/cross-domain-*.json | head -1 | awk '{print $NF}')
```

**Active matches in DB:**

```bash
cd ~/Projects/helios && npx tsx -e "
const db = require('./src/db').getDb();
const matches = db.prepare('SELECT * FROM cross_domain_matches ORDER BY similarity_score DESC LIMIT 20').all();
console.table(matches.map(m => ({ domain_a: m.domain_a, domain_b: m.domain_b, score: m.similarity_score, type: m.match_type, alert: !!m.alert_sent })));
"
```

**Active metaphors:**

```bash
cd ~/Projects/helios && npx tsx -e "
const db = require('./src/db').getDb();
const rows = db.prepare('SELECT pattern_label, text FROM domain_metaphors ORDER BY created_at DESC LIMIT 10').all();
rows.forEach(r => console.log(r.pattern_label + ':\\n' + r.text + '\\n'));
"
```

### 7.4 Hypothesis Lifecycle Management

**List all unvalidated hypotheses:**

```bash
openclaw cortex stm --category hypothesis
```

**Validate a hypothesis (evidence collected):**
When evidence confirms a hypothesis, update the cortex memory and create an atom:

1. `cortex_edit` → replace `[UNVALIDATED]` with `[VALIDATED — N confirmations]`
2. `atom_create` with the confirmed causal structure
3. New atom confidence = 0.85+ depending on evidence quality

**Falsify a hypothesis:**

1. `cortex_edit` → replace `[UNVALIDATED]` with `[FALSIFIED — reason]`
2. The falsified record is preserved as valuable negative knowledge

---

## 8. Integration Guide

### 8.1 Task-008 (Knowledge Compression) → CDPT

Compressed memories emerge from task-008 nightly at 03:30. CDPT at 04:00 runs after compression, ensuring all compressed abstractions are available as high-quality MemoryExtractor inputs. No explicit handshake needed — MemoryExtractor queries `brain.db` at runtime and picks up any records tagged `compressed`.

### 8.2 CDPT → Task-005 (Predictive Intent)

Cross-pollination alerts are fed into `cortex_predict` automatically (alert generator calls `cortex_add` which triggers the predictive intent pipeline's scoring system). High-urgency cross-domain alerts surface to Matthew during relevant conversations without any additional plumbing.

**How surface topics are matched:** The predictive intent system matches alert category tags to conversation context. If Matthew discusses AUGUR signals, alerts with category `['cross_domain', 'trading']` become eligible for surfacing.

### 8.3 CDPT → Task-006 (Self-Healing)

CDPT engine exits non-zero on failure. The self-healing cron monitor (task-006) detects non-zero exit codes from monitored scripts and fires a self-healing alert. Add `run-cross-domain` to the self-healing monitor's watched script list in the self-healing config.

### 8.4 CDPT → AUGUR

The TradingExtractor reads AUGUR's SQLite signal DB **read-only**. No AUGUR changes required. If the AUGUR DB path changes, update `AUGUR_DB_PATH` environment variable.

**AUGUR signals that become fingerprints:**

| AUGUR Signal Attribute        | CDPT Fingerprint Dimension                    |
| ----------------------------- | --------------------------------------------- |
| Win rate                      | `effect_size`                                 |
| Direction (LONG/SHORT)        | `trend_direction`                             |
| Signal type (VWAP divergence) | `divergence_magnitude`, `divergence_polarity` |
| Avg lead time                 | `lead_time_normalized`                        |
| Total count                   | `frequency_of_occurrence`                     |
| WR decay over time            | `signal_decay_rate`                           |

### 8.5 CDPT → ft991a-control

RadioExtractor reads ft991a-control log files read-only via `RADIO_LOG_PATH`. No ft991a-control changes required. As ham radio operational data grows (especially with digital modes from task-013 and logbook from task-012), RadioExtractor fingerprint quality and confidence automatically improve — bootstrap mode disengages when ≥20 observations are logged.

---

## 9. Extractor Plugin Guide

### 9.1 Implementing a New Extractor

To add a new domain (e.g., `weather` from WEMS, `drone` from telemetry):

**Step 1:** Create `src/cross-domain/extractors/{domain}-extractor.ts`:

```typescript
import type { DomainExtractor, ExtractOptions, PatternFingerprint } from "../../types/cross-domain";
import { randomUUID } from "crypto";

export class WeatherExtractor implements DomainExtractor {
  readonly domain = "weather"; // new DomainID — must be added to types too
  readonly version = "1.0.0";

  async extract(options?: ExtractOptions): Promise<PatternFingerprint[]> {
    // 1. Read data from source
    const observations = await this.readWeatherData();

    // 2. Convert to raw fingerprints (unnormalized, domain-relative values)
    const raw = observations.map((obs) => this.observationToFingerprint(obs, options?.runId));

    // 3. Return raw; normalizer handles z-score normalization
    return raw;
  }

  private async readWeatherData(): Promise<WeatherObservation[]> {
    // ... read from WEMS API or local cache
  }

  private observationToFingerprint(obs: WeatherObservation, runId?: string): PatternFingerprint {
    return {
      fingerprint_id: randomUUID(),
      source_domain: "weather",
      source_id: obs.id,
      source_type: "event",
      label: `${obs.phenomenon} (${obs.location})`,
      confidence: obs.confidence,
      schema_version: 1,
      structure: {
        trend_direction: obs.pressureTrend, // -1 to +1
        trend_strength: obs.trendStrength,
        oscillation_frequency: obs.diurnalCycle,
        reversion_force: obs.meanReversionStrength,
        divergence_magnitude: obs.anomalyMagnitude,
        divergence_polarity: obs.anomalyDirection,
        threshold_proximity: obs.extremeProximity,
        cascade_potential: obs.cascadePotential,
        signal_decay_rate: obs.phenomenonDecayRate,
        lead_time_normalized: obs.leadTimeNorm,
        effect_size: obs.impactMagnitude,
        frequency_of_occurrence: obs.historicalFrequency,
      },
      run_id: runId ?? randomUUID(),
      created_at: new Date().toISOString(),
    };
  }
}
```

**Step 2:** The engine auto-discovers extractors by scanning `src/cross-domain/extractors/*.extractor.ts` at startup. No registration code required.

**Step 3:** Add `'weather'` to the `DomainID` union in `src/types/cross-domain.ts`.

**Step 4:** Optionally add to `cdpt-config.json` with `enabled: false` for initial testing:

```json
{ "extractors": { "weather": { "enabled": false } } }
```

### 9.2 Extractor Contract Requirements

Every extractor must:

- Return `PatternFingerprint[]` with **domain-relative raw values** (not pre-normalized) — normalizer handles scaling
- Set `confidence` based on evidence quality in the source domain (not cross-domain quality)
- Set `label` to a human-readable string that a non-expert could understand
- Not throw exceptions for missing data sources — return empty array with a logged warning
- Not modify any data source — read-only access only

### 9.3 Schema Versioning

When the 12-dim `structure` schema changes (e.g., adding a 13th dimension):

1. Bump `schema_version` constant in `src/types/cross-domain.ts`
2. Add migration in `src/migrations/` that adds a new column to `cross_domain_patterns`
3. Fingerprints with older `schema_version` are re-extracted on next run (engine detects version mismatch per-run)

---

## 10. Hypothesis Lifecycle

```
CREATED (UNVALIDATED)
      │
      ├─── Evidence collected → update memory, increment confirmation count
      │         │
      │         ├─── ≥3 confirmations → promote to VALIDATED atom
      │         │    (atom_create, confidence = 0.85+)
      │         │
      │         └─── Contradicting evidence → mark FALSIFIED
      │              (preserve memory as negative knowledge)
      │
      └─── No evidence after 90 days → mark STALE
           (cortex_edit, importance downgrade to 1.0)
```

**Confidence mapping:**

| State           | Memory prefix                 | Atom confidence | Importance |
| --------------- | ----------------------------- | --------------- | ---------- |
| Unvalidated     | `HYPOTHESIS [UNVALIDATED]:`   | 0.60            | 2.0        |
| 1 confirmation  | `HYPOTHESIS [1/3 confirmed]:` | 0.70            | 2.0        |
| 2 confirmations | `HYPOTHESIS [2/3 confirmed]:` | 0.75            | 2.0        |
| Validated       | `HYPOTHESIS [VALIDATED]:`     | 0.85+           | 2.5        |
| Falsified       | `HYPOTHESIS [FALSIFIED]:`     | N/A             | 1.5        |
| Stale           | `HYPOTHESIS [STALE]:`         | N/A             | 1.0        |

---

## 11. Troubleshooting

### 11.1 Zero Fingerprints Extracted

**Symptoms:** Run report shows `fingerprints_extracted: 0`

**Diagnosis:**

```bash
CDPT_DRY_RUN=true ~/bin/run-cross-domain 2>&1 | grep -E "extractor|error|warn"
```

**Common causes:**

- `AUGUR_DB_PATH` env var incorrect or DB doesn't exist → TradingExtractor returns empty
- `RADIO_LOG_PATH` directory doesn't exist → RadioExtractor returns empty (non-fatal, continues)
- `brain.db` has no atoms or memories yet → AtomExtractor and MemoryExtractor return empty
- All extractors disabled in `cdpt-config.json`

---

### 11.2 Zero Matches Found

**Symptoms:** Fingerprints extracted but `matches_found: 0`

**Diagnosis:**

```bash
cd ~/Projects/helios && npx tsx -e "
const db = require('./src/db').getDb();
const fps = db.prepare('SELECT source_domain, count(*) as n FROM cross_domain_patterns GROUP BY source_domain').all();
console.table(fps);
"
```

**Common causes:**

- All fingerprints from same domain (cross-domain matching requires ≥2 domains with fingerprints)
- All fingerprints are bootstrap-flagged AND threshold is 0.75 (bootstrap fingerprints still participate in matching, but verify they aren't all being rejected by normalizer)
- `CDPT_MATCH_THRESHOLD` set too high — try `CDPT_MATCH_THRESHOLD=0.60` to debug
- Idempotency cache blocking re-match — check `cross_domain_matches` for recent entries with same fingerprint pairs

---

### 11.3 LLM Calls Failing

**Symptoms:** Metaphors or hypotheses not generated; LLM errors in log

**Cause:** API key not set or rate-limited.

**Mitigation:**

- Fingerprint extraction without LLM still works (keyword heuristics produce ~70% of fingerprints)
- Matching still works (cosine similarity is local computation)
- Metaphors and hypotheses are skipped if LLM call fails — alerts still fire for `causal`/`temporal` matches
- Re-run will retry synthesis for any matches with `metaphor_id = NULL`

---

### 11.4 High Memory Usage During Matching

**Symptoms:** Process OOM on large fingerprint sets

**Mitigation:** Reduce `CDPT_BATCH_SIZE` (default: 500):

```bash
CDPT_BATCH_SIZE=200 ~/bin/run-cross-domain
```

This trades runtime for memory. At batch size 200, memory peak is approximately 60% of batch size 500.

---

### 11.5 Duplicate Alerts

**Symptoms:** Same cross-pollination alert sent multiple times to Synapse

**Cause:** `alert_sent` flag not being set before Synapse publish.

**Fix:** Check `cross_domain_matches` table — `alert_sent` should be `1` after first alert. If `0` despite prior Synapse message, run:

```sql
UPDATE cross_domain_matches SET alert_sent = 1 WHERE match_id = '<id>';
```

---

## 12. Glossary

| Term                        | Definition                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bootstrap mode**          | Extractor state when < 20 domain observations available. Fingerprints are generated at capped confidence (0.3). Used for radio domain initially.                                                                                         |
| **Causal match**            | A cross-domain match where both participating patterns have confirmed causal atom records. Triggers metaphor + cross-pollination alert.                                                                                                  |
| **Cross-domain clique**     | ≥3 patterns from ≥3 different domains that all match each other. Generates a single unified multi-domain metaphor.                                                                                                                       |
| **Cross-pollination alert** | A Synapse message + cortex memory triggered when a high-confidence pattern from one domain matches an untested analog in another domain.                                                                                                 |
| **CDPT**                    | Cross-Domain Pattern Transfer. The engine described in this document.                                                                                                                                                                    |
| **Divergence-Reversion**    | The most common cross-domain pattern label: a leading indicator separates from baseline, then reverts. Appears in AUGUR (VWAP), radio (solar flux vs. propagation), and fleet (metric vs. SLA baseline).                                 |
| **Domain ID**               | One of: `trading`, `radio`, `fleet`, `meta`. The operational context of a fingerprint.                                                                                                                                                   |
| **Fingerprint**             | A normalized 12-dimensional vector representation of a domain observation, stripped of domain-specific units and semantics.                                                                                                              |
| **Hypothesis**              | A testable prediction generated by combining mechanisms from two matched domains. Stored with `HYPOTHESIS [UNVALIDATED]:` prefix until confirmed or falsified.                                                                           |
| **Idempotency window**      | 30-day period during which a `(fingerprint_a, fingerprint_b)` pair is not re-matched unless confidence changes by > 0.15.                                                                                                                |
| **Match type**              | Classification of a cross-domain match: `structural` (geometry only), `causal` (both have confirmed outcomes), or `temporal` (primarily decay/lead-time similarity).                                                                     |
| **Metaphor**                | A human-readable cross-domain analogy expressing the shared structural mechanism between two (or more) matched patterns.                                                                                                                 |
| **PatternFingerprint**      | See _Fingerprint_.                                                                                                                                                                                                                       |
| **Schema version**          | Integer version of the fingerprint structure schema. Bumped when dimensions are added or renamed. Enables re-extraction when schema evolves.                                                                                             |
| **Structural match**        | A cross-domain match based on geometric similarity alone (no confirmed causal outcomes required). Generates metaphor but no cross-pollination alert.                                                                                     |
| **Temporal match**          | A cross-domain match with high similarity specifically in decay-rate and lead-time dimensions. Generates temporal hypothesis.                                                                                                            |
| **Transfer opportunity**    | Flag set when source confidence ≥ 0.8 and target confidence < 0.6. Indicates that validated knowledge from the source domain has not yet been tested in the target domain. Triggers cross-pollination alert for causal/temporal matches. |

---

_Stage: document → next stage: build (TypeScript implementation)_
_Artifact: pipeline/task-009-cross-domain-transfer/document.md_
