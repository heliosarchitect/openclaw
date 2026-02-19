# Task-009: Cross-Domain Pattern Transfer — Design

**Stage:** design | **Status:** complete
**Phase:** 5.5 | **Date:** 2026-02-18
**Author:** Pipeline Design Specialist

---

## 1. Overview

The **Cross-Domain Pattern Transfer (CDPT) Engine** gives Helios the ability to recognize when a pattern validated in one operational domain is structurally identical to a nascent or untested pattern in another domain — and to act on that recognition by generating cross-pollination alerts and testable hypotheses.

The core insight: **mathematical structure is domain-agnostic.** A divergence, a decay, a reversion, a cascade — these shapes appear in price data, RF propagation, fleet resource graphs, and memory confidence curves. A human expert recognizes them intuitively across domains. CDPT makes Helios do it systematically.

### Design Philosophy

Three capabilities working in sequence:

1. **Extract** — normalize domain-specific observations into universal structural fingerprints
2. **Match** — find structurally similar fingerprints across domains via vector similarity
3. **Synthesize** — generate metaphors, alerts, and testable hypotheses from matches

Each step is independently testable and independently replaceable. The engine is purely additive — it reads from existing data sources and writes only to new tables and new memory/atom records; it never modifies domain-specific systems.

### AMENDMENT (Matthew, 2026-02-18 22:50): Plugin Extractor Architecture

**DO NOT hardcode domain extractors.** The extraction layer MUST use a plugin/registry pattern:

```typescript
// Core interface — all extractors implement this
interface DomainExtractor {
  readonly domain: string; // e.g. "trading", "radio", "fleet"
  readonly version: string;
  extract(options?: ExtractOptions): Promise<PatternFingerprint[]>;
}

// Registry — engine discovers extractors at runtime
class ExtractorRegistry {
  register(extractor: DomainExtractor): void;
  getAll(): DomainExtractor[];
  getByDomain(domain: string): DomainExtractor | undefined;
}
```

- Extractors live in `src/cross-domain/extractors/` — one file per domain
- Engine loads all `*.extractor.ts` files from that directory at startup
- Adding a new domain (e.g. weather, drone telemetry) = drop a new file, zero core changes
- The TradingExtractor, RadioExtractor, FleetExtractor, AtomExtractor, MemoryExtractor are the INITIAL plugins, not hardcoded dependencies
- Config file (`cdpt-config.json` or similar) can enable/disable extractors without code changes

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                Cross-Domain Pattern Transfer Engine                  │
│                     (cdpt-engine.ts)                                │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  EXTRACTION LAYER                                            │  │
│  │                                                              │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐   │  │
│  │  │ TradingExtract│ │ RadioExtract │ │  FleetExtract      │   │  │
│  │  │ (AUGUR SQLite)│ │ (ft991a logs)│ │  (ITSM/metrics)   │   │  │
│  │  └──────┬───────┘ └──────┬───────┘ └────────┬───────────┘   │  │
│  │         │                │                   │               │  │
│  │         ▼                ▼                   ▼               │  │
│  │  ┌──────────────────────────────────────────────────────┐   │  │
│  │  │            AtomExtractor + MemoryExtractor            │   │  │
│  │  │         (reads brain.db atoms + memories)             │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  │                          │                                   │  │
│  │                          ▼                                   │  │
│  │  ┌──────────────────────────────────────────────────────┐   │  │
│  │  │              Pattern Normalizer                       │   │  │
│  │  │   → PatternFingerprint (12-dim domain-agnostic vec)   │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│                             │                                       │
│  ┌──────────────────────────▼───────────────────────────────────┐  │
│  │  MATCHING LAYER                                              │  │
│  │                                                              │  │
│  │  ┌──────────────────────────────────────────────────────┐   │  │
│  │  │         Cross-Domain Similarity Index                 │   │  │
│  │  │   (cosine similarity on PatternFingerprint vectors)   │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  │                          │                                   │  │
│  │                          ▼                                   │  │
│  │  ┌──────────────────────────────────────────────────────┐   │  │
│  │  │         Match Classifier                              │   │  │
│  │  │  (score + classify: structural, causal, temporal)     │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│                             │                                       │
│  ┌──────────────────────────▼───────────────────────────────────┐  │
│  │  SYNTHESIS LAYER                                             │  │
│  │                                                              │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │  │
│  │  │   Metaphor   │ │  Cross-Poll  │ │  Hypothesis          │ │  │
│  │  │   Engine     │ │  Alert Gen   │ │  Generator           │ │  │
│  │  └──────┬───────┘ └──────┬───────┘ └──────────┬───────────┘ │  │
│  │         │                │                     │             │  │
│  │         ▼                ▼                     ▼             │  │
│  │  ┌──────────────────────────────────────────────────────┐   │  │
│  │  │       Reporter + Synapse Publisher                    │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Data Model

### 3.1 Pattern Fingerprint

The fundamental unit: a normalized 12-dimensional vector that captures the **structural shape** of any observation, independent of domain.

```typescript
interface PatternFingerprint {
  // Identity
  fingerprint_id: string; // uuid
  source_domain: "trading" | "radio" | "fleet" | "meta";
  source_id: string; // ID of the source record (atom_id, signal_id, etc.)
  source_type: "atom" | "memory" | "signal" | "event";
  label: string; // Human-readable: "VWAP divergence SHORT"
  confidence: number; // 0–1, inherited from source record

  // Structural dimensions (all normalized to [-1, 1])
  structure: {
    // Temporal shape
    trend_direction: number; // -1 (falling) → +1 (rising)
    trend_strength: number; // 0 (flat) → 1 (strong)
    oscillation_frequency: number; // 0 (monotonic) → 1 (high-freq oscillation)
    reversion_force: number; // 0 (trending) → 1 (strong mean-reversion)

    // Divergence / convergence
    divergence_magnitude: number; // 0 (no divergence) → 1 (maximum separation)
    divergence_polarity: number; // -1 (converging) → +1 (diverging)

    // Risk / threshold dynamics
    threshold_proximity: number; // 0 (far from threshold) → 1 (at threshold)
    cascade_potential: number; // 0 (isolated) → 1 (high cascade risk)

    // Temporal decay
    signal_decay_rate: number; // 0 (persistent) → 1 (fast-decaying)
    lead_time_normalized: number; // 0 (coincident) → 1 (long lead time)

    // Magnitude
    effect_size: number; // 0 (weak) → 1 (large effect)
    frequency_of_occurrence: number; // 0 (rare) → 1 (frequent)
  };

  created_at: string; // ISO timestamp
  run_id: string; // which CDPT run created this
}
```

**Why 12 dimensions?** These capture the complete structural vocabulary shared across all four domains:

- Temporal shape (trend, oscillation, reversion) — universal across all time-series data
- Divergence dynamics — the fundamental pattern behind AUGUR signals, RF fading, and resource contention
- Risk/threshold dynamics — common to trading drawdown, circuit-breaking, and memory confidence floors
- Decay rates — AUGUR signal decay, radio propagation windows, and cortex memory importance decay all follow the same functional forms

---

### 3.2 Cross-Domain Pattern Match

```typescript
interface CrossDomainMatch {
  match_id: string; // uuid
  fingerprint_a_id: string; // source domain
  fingerprint_b_id: string; // target domain
  domain_a: string;
  domain_b: string;
  similarity_score: number; // cosine similarity on structure vectors
  match_type: "structural" | "causal" | "temporal"; // classifier output

  // For alert generation
  a_confidence: number; // confidence in domain A pattern
  b_confidence: number; // confidence in domain B pattern
  transfer_opportunity: boolean; // a_confidence ≥0.8 && b_confidence <0.6

  // Status
  metaphor_id?: string; // FK to domain_metaphors if generated
  hypothesis_id?: string; // FK to hypothesis memory if generated
  alert_sent: boolean;
  created_at: string;
}
```

---

### 3.3 Domain Metaphor

```typescript
interface DomainMetaphor {
  metaphor_id: string;
  match_id: string;

  // Human-readable expression
  text: string;
  // e.g.: "VWAP divergence in trading (AUGUR SHORT signal) ≈ signal fade in ham radio
  //        (propagation skip window ending) ≈ resource contention in fleet (disk I/O spike
  //        preceding OOM) — all three are divergence-convergence patterns where a leading
  //        indicator separates from a baseline then reverts with high predictive accuracy."

  domains_involved: string[]; // ['trading', 'radio', 'fleet']
  pattern_label: string; // "Divergence-Reversion"
  shared_mechanism: string; // "leading indicator separates from baseline → reversion event"
  confidence: number; // avg confidence across participating domains
  created_at: string;
}
```

---

## 4. Extraction Layer

### 4.1 AtomExtractor (`src/cross-domain/extractors/atom-extractor.ts`)

Converts existing atoms into PatternFingerprints by mapping causal structure to the 12-dim space.

**Mapping logic:**

```typescript
function atomToFingerprint(atom: Atom): PatternFingerprint {
  // Heuristic mapping from causal text to structural dimensions
  // Uses keyword matching + LLM-assisted extraction for ambiguous atoms
  // Example: atom { subject: "BNKR-USD", action: "accumulates short divergence vs VWAP",
  //                 outcome: "reversal signal", consequences: "82% WR on SHORT within 4h" }
  // → structure.divergence_magnitude ≈ 0.8
  // → structure.divergence_polarity → -1 (converging toward reversal)
  // → structure.trend_direction → -1 (SHORT)
  // → structure.lead_time_normalized ≈ 0.4 (4h lead / 10h max)
  // → structure.effect_size ≈ 0.8 (82% WR)
}
```

**LLM-assisted fallback:** For atoms where keyword heuristics produce low-confidence mappings, a structured LLM prompt extracts the 12 dimensions directly from the atom's causal text. Returns confidence estimate alongside dimensions.

---

### 4.2 TradingExtractor (`src/cross-domain/extractors/trading-extractor.ts`)

Reads AUGUR SQLite signal database directly.

**Reads from:**

- `~/Projects/augur-trading/data/signals.db` (env: `AUGUR_DB_PATH`)
- Signal miner daily report (JSON artifacts in `~/Projects/augur-trading/signals/`)

**Extracts:**

- Validated signals (WR ≥ 60%, ≥ 10 occurrences) as high-confidence fingerprints
- Invalidated signals as low-confidence fingerprints (useful as "negative examples")
- Decay curves (how quickly signal WR drops as lead time increases) → `signal_decay_rate`
- Short vs. long bias per product → `trend_direction`
- Divergence type (VWAP, SMA, RSI) → `divergence_magnitude` + `divergence_polarity`

---

### 4.3 RadioExtractor (`src/cross-domain/extractors/radio-extractor.ts`)

Reads ft991a-control log data and propagation events.

**Reads from:**

- ft991a-control log files on `radio.fleet.wood` (SSH or local mount; configurable via `RADIO_LOG_PATH`)
- WEMS space weather data (solar flux, K-index) from WEMS API

**Extracts:**

- Propagation window patterns: when does 10m open? → temporal shape fingerprints
- Signal fade events: leading indicator → fade → recovery → `divergence_polarity` cycle
- Band-condition cycles (daily/seasonal) → `oscillation_frequency`
- Solar flux correlation with propagation quality → `lead_time_normalized`, `effect_size`

**Note:** Radio data is currently sparse. Extractor runs in "bootstrap" mode if < 20 observations available — stores fingerprints at `confidence = 0.3` to avoid polluting high-confidence match pool.

---

### 4.4 FleetExtractor (`src/cross-domain/extractors/fleet-extractor.ts`)

Reads fleet/infrastructure health events from ITSM and service metrics.

**Reads from:**

- Cortex ITSM tool output (fleet status API)
- Cortex memories in `infrastructure` and `system` categories
- Self-healing event log (`task-006` artifacts)
- OctoPrint progress events (for temporal pattern extraction on long-running jobs)

**Extracts:**

- Service degradation patterns: metric drift → threshold breach → recovery → divergence fingerprint
- Cascade failure events: one service fails → N others → `cascade_potential`
- SLA drift patterns: gradual degradation before threshold breach → `threshold_proximity` curve
- Recovery time distributions → `signal_decay_rate` analog

---

### 4.5 MemoryExtractor (`src/cross-domain/extractors/memory-extractor.ts`)

Converts cortex memories with known patterns into fingerprints.

**Priority targets:**

- Memories in `trading`, `radio`, `infrastructure` categories with `importance ≥ 2.0`
- Memories tagged `compressed` (abstractions from task-008) — these are already distilled patterns
- Memories with explicit causal language (detected via keyword filter before LLM call)

---

### 4.6 Pattern Normalizer (`src/cross-domain/normalizer.ts`)

Receives raw extractor output → normalizes all 12 dimensions to [-1, 1] → validates → stores in `cross_domain_patterns` table.

**Normalization rules:**

- Each dimension is normalized relative to the domain's own distribution (z-score within domain, then clipped to [-1, 1])
- This makes cross-domain comparison fair — a "strong" signal in radio means the same as "strong" in trading relative to the domain's own scale

**Validation:**

- Reject fingerprints where > 6 of 12 dimensions are 0 (under-specified pattern)
- Reject fingerprints with `confidence < 0.2` (too uncertain to pollinate)
- Flag fingerprints with `confidence < 0.5` as "bootstrap" — included in matching but labeled

---

## 5. Matching Layer

### 5.1 Cross-Domain Similarity Index (`src/cross-domain/matcher.ts`)

**Algorithm:**

1. Load all fingerprints from `cross_domain_patterns` where `domain_a ≠ domain_b` (cross-domain only, never same-domain)
2. Compute pairwise cosine similarity on the 12-dim `structure` vector
3. Filter: similarity ≥ 0.75 (configurable threshold `CDPT_MATCH_THRESHOLD`)
4. For each match pair, check idempotency: has this `(fingerprint_a_id, fingerprint_b_id)` pair been matched in the last 30 days? If so, skip unless confidence changed significantly (Δ > 0.15)
5. Store new matches in `cross_domain_matches` table

**Efficiency:**

- N² comparison is batched in chunks of 500 fingerprints
- Pre-filter by dominant structural type before full cosine (coarse bucketing on `divergence_polarity` sign and `trend_direction` sign — eliminates ~60% of pairs before full comparison)
- Target runtime: < 30s for 1000 fingerprints (acceptable for nightly batch)

---

### 5.2 Match Classifier (`src/cross-domain/classifier.ts`)

Each match is classified by type to inform synthesis:

| Type         | Condition                                                                     | Synthesis Path                     |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------- |
| `structural` | High geometric similarity (structure vectors close), low causal overlap       | Metaphor only                      |
| `causal`     | High similarity + both patterns have confirmed causal outcomes (atom records) | Metaphor + cross-pollination alert |
| `temporal`   | High similarity in decay/lead-time dimensions specifically                    | Temporal hypothesis                |

Classification is rule-based (no LLM call) for speed:

```typescript
function classifyMatch(a: PatternFingerprint, b: PatternFingerprint, sim: number): MatchType {
  const temporalDimensions = ["signal_decay_rate", "lead_time_normalized", "oscillation_frequency"];
  const temporalSim = cosineSimilarity(
    temporalDimensions.map((d) => a.structure[d]),
    temporalDimensions.map((d) => b.structure[d]),
  );

  const hasAtomA = !!atomIndex.get(a.source_id);
  const hasAtomB = !!atomIndex.get(b.source_id);

  if (temporalSim > 0.88) return "temporal";
  if (hasAtomA && hasAtomB) return "causal";
  return "structural";
}
```

---

## 6. Synthesis Layer

### 6.1 Metaphor Engine (`src/cross-domain/synthesizers/metaphor-engine.ts`)

Generates human-readable cross-domain analogies for every `structural` or `causal` match.

**LLM prompt strategy:**

```
Given two observed patterns in different domains that share structural similarities,
produce a clear, concise cross-domain metaphor.

Pattern A (domain: {domain_a}): {label_a}
Pattern B (domain: {domain_b}): {label_b}
Shared structural features: {most_similar_dimensions}
Similarity score: {score}

Produce:
{
  "metaphor_text": "...",       // 1-2 sentences max; no jargon specific to one domain
  "pattern_label": "...",       // short universal name: "Divergence-Reversion", "Cascade Failure", etc.
  "shared_mechanism": "..."     // the underlying mechanism both domains share
}
```

**Multi-domain grouping:** If 3+ patterns from different domains all match each other (clique), produce a single unified metaphor covering all domains rather than N² pairwise metaphors.

Stored in `domain_metaphors` table + as a cortex memory with category `['cross_domain', 'meta']`.

---

### 6.2 Cross-Pollination Alert Generator (`src/cross-domain/synthesizers/alert-generator.ts`)

Fires when `transfer_opportunity = true` (high-confidence in source domain, low-confidence in target domain) AND match type is `causal` or `temporal`.

**Alert structure:**

```typescript
interface CrossPollinationAlert {
  alert_id: string;
  match_id: string;

  source_domain: string;
  source_pattern: string; // human label
  source_confidence: number; // e.g., 0.85
  source_win_rate?: number; // if trading signal

  target_domain: string;
  target_pattern: string;
  target_confidence: number; // e.g., 0.35 — this is why we're alerting

  transfer_recommendation: string; // LLM-generated 1-sentence recommendation
  // e.g.: "VWAP-divergence SHORT logic (82% WR in trading) structurally matches
  //        solar flux divergence from baseline in ham radio — consider tracking
  //        solar flux vs. 30-day moving average as a 10m propagation predictor."

  urgency: "info" | "action"; // 'action' if source WR ≥85% or cascade_potential ≥0.8
  created_at: string;
}
```

Alert is:

1. Stored as atom: `atom_create({ subject: "Cross-domain transfer opportunity", action: "identified structural match", outcome: "{pattern_label} found in {target_domain}", consequences: "{transfer_recommendation}" })`
2. Stored as cortex memory (category: `['cross_domain', target_domain_category]`, importance: 2.0 for `action`, 1.5 for `info`)
3. Posted to Synapse (`priority: 'action'` for action urgency, `'info'` otherwise)
4. Fed into `cortex_predict` as a scored insight for surfacing to Matthew

---

### 6.3 Hypothesis Generator (`src/cross-domain/synthesizers/hypothesis-generator.ts`)

For `causal` and `temporal` matches where both sides have confirmed causal patterns, generates a testable hypothesis by combining the mechanisms.

**Template:**

```
IF [mechanism from Domain A] operates similarly in [Domain B],
THEN [predicted observable outcome in Domain B] within [lead_time from Domain A] —
testable by [specific observation method in Domain B].
```

**Example output:**

> "IF solar flux divergence from 30-day mean operates similarly to VWAP divergence in trading, THEN 10m band should show propagation recovery within 45 minutes of solar flux reversion — testable by logging signal strength reports on 28.074 MHz during the reversion window."

**Stored as:** Cortex memory with category `['hypothesis', target_domain_category]`, importance 2.0, prefixed with `HYPOTHESIS [UNVALIDATED]:` to prevent false confidence.

**Hypothesis lifecycle:**

- Created as `unvalidated`
- When Matthew or Helios collects evidence, updates confidence score
- When evidence ≥ 3 confirmations: promoted to `validated` atom via `atom_create`
- When evidence shows falsification: stored as `falsified` memory (valuable negative knowledge)

---

## 7. Database Schema

### 7.1 New Table: `cross_domain_patterns`

```sql
CREATE TABLE IF NOT EXISTS cross_domain_patterns (
  fingerprint_id TEXT PRIMARY KEY,
  source_domain TEXT NOT NULL,     -- trading | radio | fleet | meta
  source_id TEXT NOT NULL,         -- FK to original record
  source_type TEXT NOT NULL,       -- atom | memory | signal | event
  label TEXT NOT NULL,
  confidence REAL NOT NULL,

  -- 12 structural dimensions (stored as JSON for flexibility)
  structure JSON NOT NULL,

  -- Run metadata
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(source_id, source_type, run_id)  -- idempotent per run
);

CREATE INDEX idx_cdp_domain ON cross_domain_patterns(source_domain);
CREATE INDEX idx_cdp_confidence ON cross_domain_patterns(confidence);
CREATE INDEX idx_cdp_run ON cross_domain_patterns(run_id);
```

### 7.2 New Table: `cross_domain_matches`

```sql
CREATE TABLE IF NOT EXISTS cross_domain_matches (
  match_id TEXT PRIMARY KEY,
  fingerprint_a_id TEXT NOT NULL REFERENCES cross_domain_patterns(fingerprint_id),
  fingerprint_b_id TEXT NOT NULL REFERENCES cross_domain_patterns(fingerprint_id),
  domain_a TEXT NOT NULL,
  domain_b TEXT NOT NULL,
  similarity_score REAL NOT NULL,
  match_type TEXT NOT NULL,        -- structural | causal | temporal
  transfer_opportunity INTEGER NOT NULL DEFAULT 0,  -- boolean
  metaphor_id TEXT,
  hypothesis_id TEXT,
  alert_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Prevent A-B and B-A from both being stored
  UNIQUE(fingerprint_a_id, fingerprint_b_id)
);

CREATE INDEX idx_cdm_domains ON cross_domain_matches(domain_a, domain_b);
CREATE INDEX idx_cdm_score ON cross_domain_matches(similarity_score DESC);
CREATE INDEX idx_cdm_transfer ON cross_domain_matches(transfer_opportunity) WHERE transfer_opportunity = 1;
```

### 7.3 New Table: `domain_metaphors`

```sql
CREATE TABLE IF NOT EXISTS domain_metaphors (
  metaphor_id TEXT PRIMARY KEY,
  match_id TEXT,                   -- NULL if multi-domain clique
  domains_involved JSON NOT NULL,  -- ["trading","radio"]
  pattern_label TEXT NOT NULL,
  text TEXT NOT NULL,
  shared_mechanism TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 7.4 Migration

`src/migrations/009-cross-domain.ts`

---

## 8. File Structure

```
src/
├── cross-domain/
│   ├── cdpt-engine.ts                         # Main orchestrator
│   ├── normalizer.ts                          # Pattern Normalizer
│   ├── matcher.ts                             # Similarity Index + matching
│   ├── classifier.ts                          # Match type classifier
│   ├── extractors/
│   │   ├── atom-extractor.ts                  # Atoms → fingerprints
│   │   ├── memory-extractor.ts                # Memories → fingerprints
│   │   ├── trading-extractor.ts               # AUGUR signals → fingerprints
│   │   ├── radio-extractor.ts                 # ft991a logs → fingerprints
│   │   └── fleet-extractor.ts                 # ITSM/metrics → fingerprints
│   ├── synthesizers/
│   │   ├── metaphor-engine.ts                 # Generate domain metaphors
│   │   ├── alert-generator.ts                 # Cross-pollination alerts
│   │   └── hypothesis-generator.ts            # Testable hypothesis production
│   └── reporter.ts                            # Run report + Synapse publish
├── migrations/
│   └── 009-cross-domain.ts
└── types/
    └── cross-domain.ts                        # All interfaces

~/bin/
└── run-cross-domain                           # Shell wrapper for cron
```

---

## 9. Cron Configuration

Runs nightly after knowledge compression (task-008), at 4:00 AM:

```json
{
  "name": "nightly-cross-domain-transfer",
  "schedule": { "kind": "cron", "expr": "0 4 * * *", "tz": "America/New_York" },
  "payload": {
    "kind": "systemEvent",
    "text": "Run cross-domain pattern transfer: cd ~/Projects/helios && npx tsx src/cross-domain/cdpt-engine.ts"
  },
  "sessionTarget": "main",
  "enabled": true
}
```

**Sequencing:** Compression (task-008) runs at 3:30 AM. CDPT at 4:00 AM. This ensures compressed abstractions are available as high-quality fingerprint sources.

Also triggerable manually: `~/bin/run-cross-domain`

---

## 10. LLM Call Strategy

| Call                                   | Model         | Purpose                                             | Per-run frequency                  |
| -------------------------------------- | ------------- | --------------------------------------------------- | ---------------------------------- |
| Atom fingerprint extraction (fallback) | Claude Haiku  | Map ambiguous atoms to 12 dimensions                | ≤50 atoms/run                      |
| Metaphor generation                    | Claude Haiku  | Produce human-readable analogies                    | 1 call per new match pair          |
| Alert transfer recommendation          | Claude Haiku  | 1-sentence transfer recommendation                  | 1 call per cross-pollination alert |
| Hypothesis generation                  | Claude Sonnet | Produce testable hypothesis (higher quality needed) | ≤10/run                            |

**Cost estimate:** ~$0.005/run for typical 30-match batch. Hypothesis generation (Sonnet) ≤10 calls at ~$0.002/call = ~$0.02 cap.

---

## 11. Integration Points

### 11.1 Task-008 (Knowledge Compression)

Compressed memories (importance-downgraded abstractions) are **priority inputs** to the MemoryExtractor. They are already distilled patterns and produce cleaner fingerprints than raw episodic memories.

### 11.2 Task-005 (Predictive Intent)

Cross-pollination alerts are fed into the `cortex_predict` pipeline as high-urgency insights. The predictive intent system surfaces them to Matthew during relevant conversations (e.g., if Matthew is discussing trading, surface a trading-radio metaphor found overnight).

### 11.3 Task-006 (Self-Healing)

CDPT failure (non-zero exit) triggers self-healing alert via the existing self-healing cron monitor.

### 11.4 AUGUR

The TradingExtractor reads AUGUR's SQLite signal DB read-only. No AUGUR changes required. If AUGUR DB path changes, update env var `AUGUR_DB_PATH`.

### 11.5 ft991a-control

The RadioExtractor reads log files read-only. Minimal data available now; bootstrap mode applies. As ham radio activity increases (digital modes, logbook in task-012/013/014), fingerprint quality improves automatically.

---

## 12. Testing Plan (for Build Stage)

| Test                                                                     | Type        | Assertion                                                                 |
| ------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------- |
| Atom → fingerprint: divergence atom maps to `divergence_magnitude ≥ 0.7` | Unit        | Mock atom with "divergence" in action                                     |
| Atom → fingerprint: cascade atom maps to `cascade_potential ≥ 0.7`       | Unit        | Mock atom with cascade language                                           |
| Normalizer rejects under-specified fingerprints (> 6 zeros)              | Unit        | Fingerprint with 7 zero dims → rejected                                   |
| Matcher produces no same-domain matches                                  | Unit        | All match pairs have `domain_a ≠ domain_b`                                |
| Matcher idempotency: re-run doesn't duplicate matches                    | Integration | Run twice → same match count                                              |
| Classifier correctly assigns `temporal` for high decay-dim similarity    | Unit        | Mock two decay-heavy fingerprints                                         |
| Metaphor engine produces non-empty text                                  | Unit        | Mock LLM returns; text validates as non-empty                             |
| Alert generator fires only when `transfer_opportunity = true`            | Unit        | a_confidence=0.85, b_confidence=0.4 → alert; b_confidence=0.75 → no alert |
| Hypothesis prefixed with `HYPOTHESIS [UNVALIDATED]:`                     | Unit        | All generated hypotheses start with prefix                                |
| E2E synthetic run: 4-domain fingerprints produce ≥1 cross-domain match   | E2E         | Inject 10 fingerprints per domain with known overlaps                     |
| AUGUR extractor reads signals.db without modifying it                    | Integration | MD5 of signals.db unchanged post-run                                      |

---

## 13. Implementation Plan (Build Stage)

| Step | Work                                            | Files                                                            |
| ---- | ----------------------------------------------- | ---------------------------------------------------------------- |
| 1    | Types + interfaces                              | `types/cross-domain.ts`                                          |
| 2    | DB migration                                    | `migrations/009-cross-domain.ts`                                 |
| 3    | Pattern Normalizer                              | `cross-domain/normalizer.ts`                                     |
| 4    | AtomExtractor + MemoryExtractor                 | `extractors/atom-extractor.ts`, `extractors/memory-extractor.ts` |
| 5    | TradingExtractor (mock if AUGUR DB unavailable) | `extractors/trading-extractor.ts`                                |
| 6    | RadioExtractor (bootstrap mode)                 | `extractors/radio-extractor.ts`                                  |
| 7    | FleetExtractor                                  | `extractors/fleet-extractor.ts`                                  |
| 8    | Matcher + Classifier                            | `cross-domain/matcher.ts`, `cross-domain/classifier.ts`          |
| 9    | Metaphor Engine                                 | `synthesizers/metaphor-engine.ts`                                |
| 10   | Alert Generator                                 | `synthesizers/alert-generator.ts`                                |
| 11   | Hypothesis Generator                            | `synthesizers/hypothesis-generator.ts`                           |
| 12   | Reporter                                        | `cross-domain/reporter.ts`                                       |
| 13   | Main orchestrator                               | `cross-domain/cdpt-engine.ts`                                    |
| 14   | Shell wrapper + cron                            | `~/bin/run-cross-domain`                                         |
| 15   | Unit + integration tests                        | `src/cross-domain/__tests__/`                                    |

---

## 14. Risks

| Risk                                                                  | Likelihood       | Mitigation                                                                                                               |
| --------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Fingerprint dimensions are too abstract to produce meaningful matches | Medium           | Start with known ground-truth pair (AUGUR VWAP divergence ≈ any oscillation pattern) as calibration test; tune threshold |
| Radio domain bootstrap mode produces noisy fingerprints               | High (near-term) | Bootstrap mode caps confidence at 0.3; excluded from cross-pollination alerts until ≥ 20 observations                    |
| LLM-generated metaphors are too generic to be useful                  | Low              | Prompt enforces domain-specific labeling in the analogy; human review via Synapse                                        |
| Hypothesis proliferation (too many hypotheses clutter memory)         | Medium           | Cap: max 10 new hypotheses per run; favor quality (causal + temporal matches) over quantity                              |
| N² matching blows up with large fingerprint sets                      | Low              | Pre-filtering by sign-buckets; only run cross-domain pairs; practical limit ~2000 fingerprints before needing ANN index  |

---

## 15. Open Questions

1. **Fingerprint versioning**: When the 12-dim schema evolves (e.g., adding a 13th dimension), how do we migrate existing fingerprints? Proposal: version the schema in `cross_domain_patterns.schema_version`; re-extract on schema bump.
2. **Hypothesis falsification flow**: Who/what observes that a hypothesis has been falsified? Proposal: Helios observes contradicting evidence in the relevant domain during heartbeat and updates hypothesis status.
3. **User-facing metaphor surface**: Should top cross-domain metaphors be injected into Helios's context (like hot-memory)? Proposal: yes — top-3 metaphors by match score per week injected as semantic memory; gives Helios spontaneous cross-domain intuition in conversation.
4. **Atom confidence for cross-domain atoms**: New atoms from cross-pollination alerts start at `confidence=0.6` (lower than agent-sourced 1.0, higher than compression-derived 0.7) — reflects that it's a transfer hypothesis, not a confirmed observation.

---

_Next stage: document → build (TypeScript implementation)_
