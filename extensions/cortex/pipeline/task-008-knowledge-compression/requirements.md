# Task-008: Knowledge Compression — Abstraction Engine — Requirements

**Stage:** requirements | **Status:** pass (reconstructed at design stage)
**Phase:** 5.4 of IMPROVEMENT_PLAN
**Date:** 2026-02-18

---

## Problem Statement

Helios accumulates raw memories continuously — every session adds dozens of STM entries, embeddings, and atoms. Over time this creates:

1. **Memory bloat**: Hundreds of specific instances of the same underlying pattern, each stored verbatim
2. **Retrieval dilution**: Semantically similar memories compete for the same retrieval slots, drowning out truly novel entries
3. **Missed abstractions**: No mechanism extracts _generalizable principles_ from clusters of related observations — the insight "whale accumulation precedes price moves" is buried inside 200 individual trade records
4. **Context window waste**: Hot-memory and semantic-memory injections carry redundant, verbose content that could be compressed to 10% of its tokens without semantic loss

Humans solve this via sleep-based memory consolidation. Helios needs an engineered equivalent: an **Abstraction Engine** that continuously compresses episodic memories into semantic knowledge, and semantic clusters into atomic principles.

---

## Goals

1. **Compression pipeline**: Identify clusters of related memories → distill into a single high-value abstraction → archive or downgrade source memories
2. **Meta-knowledge production**: Surface generalizable patterns that weren't explicitly stored (e.g., "Matthew corrects me when I assert without verifying" from 15 instances)
3. **Token efficiency**: Reduce average context injection size by ≥40% without semantic loss (measured by retrieval quality)
4. **Atom enrichment**: Feed distilled patterns into the atom graph as first-class causal units
5. **Fully automated**: Runs on cron, no human intervention required; exceptions posted to Synapse

---

## Non-Goals

- Lossy deletion of high-importance (≥2.5) memories — compression only, never destruction of critical knowledge
- Replacing the existing cortex_dedupe workflow (deduplication is exact-match; compression is semantic-cluster)
- Real-time compression on every memory write (batch process only, run during low-activity windows)

---

## Success Criteria

- [ ] Compression identifies clusters of ≥3 semantically similar memories with cosine similarity ≥0.82
- [ ] Each cluster produces one distilled abstraction stored as a cortex memory with `compressed_from` metadata
- [ ] Source memories downgraded to importance 0.5 (archived but not deleted) after successful compression
- [ ] Distilled patterns that are causal in nature auto-generate atom records via `atom_create`
- [ ] Cron job runs nightly at 3:30 AM; results posted to Synapse
- [ ] Context injection token count measurably reduced (baseline captured pre-run, delta measured post-run)
- [ ] TypeScript implementation compiles cleanly (`pnpm tsc --noEmit`)
- [ ] Compression is idempotent — re-running on already-compressed memory cluster produces no changes

---

## Inputs / Outputs

**Inputs:**

- `brain.db` — STM entries (all categories)
- `brain.db` — embeddings (vector + content)
- Atom graph (existing atoms, for enrichment)

**Outputs:**

- New compressed memories in `brain.db` with metadata `{ compressed_from: [id,...], compression_ratio: float }`
- New or enriched atoms in atom graph
- Compression report (JSON artifact + Synapse summary)
- Updated importance scores on source memories (downgraded to 0.5)
