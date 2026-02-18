# Requirements Document - Confidence Scoring System

**Agent Role:** Requirements Analyst  
**Date:** 2026-02-17  
**Task:** Phase 1.2 - Confidence scoring for all memories (retroactive scoring of existing)

## 1. Summary

Implement a confidence scoring system that automatically rates the reliability of all memories in Cortex STM and embeddings based on age, usage patterns, validation history, and contradictions. The system will assign confidence scores from 0.0 to 1.0, with automatic decay over time and boosts from successful validations. All existing memories must be retroactively scored using historical data, and new memories will be scored at creation with ongoing updates during usage.

## 2. Functional Requirements

**FR-1** Memory Confidence Calculation

- Calculate confidence scores using base score 1.0 with decay factors:
  - Age decay: -0.01 per day (2% weekly decay)
  - Access frequency boost: +0.05 per access in last 30 days
  - Contradiction penalty: -0.3 per conflicting memory
  - Validation bonus: +0.2 per successful execution
- Score range: 0.1 minimum to 1.0 maximum

**FR-2** Retroactive Scoring

- Score all existing STM entries based on creation date and access history
- Score all existing embeddings based on metadata and usage patterns
- Process existing atoms with confidence based on causal link validation
- Preserve original creation timestamps while adding confidence metadata

**FR-3** Dynamic Confidence Updates

- Update confidence when memories are accessed or validated
- Detect contradictory memories and apply penalties automatically
- Track successful executions and apply validation bonuses
- Recalculate scores on configurable intervals (daily/weekly)

**FR-4** Confidence-Based Memory Filtering

- Filter memories by minimum confidence thresholds:
  - Critical operations: 0.8 minimum
  - Routine operations: 0.5 minimum
  - Experimental: 0.2 minimum
- Include confidence scores in all memory search results
- Sort search results by confidence when relevance is equal

**FR-5** Confidence Tracking and Reporting

- Store confidence scores in memory metadata
- Track confidence change history for audit trail
- Report confidence statistics via cortex_stats tool
- Export confidence data for analysis

## 3. Non-Functional Requirements

**NFR-1** Performance

- Retroactive scoring must complete for 50K+ memories within 5 minutes
- Real-time confidence updates must not add >100ms to memory operations
- Confidence calculation must be cacheable to avoid repeated computation

**NFR-2** Data Integrity

- All confidence updates must be atomic transactions
- Backup existing memory data before applying confidence scores
- Confidence scores must survive database migrations and restarts

**NFR-3** Backward Compatibility

- Existing cortex tools must continue working without modification
- Confidence scores are additive - no breaking changes to memory structure
- Legacy memories without confidence default to 0.5 baseline

**NFR-4** Accuracy

- Confidence scores must accurately reflect memory reliability
- False positives (marking reliable memories as low confidence) <10%
- False negatives (marking unreliable memories as high confidence) <5%

## 4. Dependencies

**Existing Systems:**

- **cortex-bridge.ts**: CortexMemory interface needs confidence field
- **brain.py**: UnifiedBrain class needs confidence calculation methods
- **stm_manager.py**: STM entries need confidence metadata
- **embeddings**: Embedding vectors need confidence scores in metadata
- **atoms**: Atomic knowledge units need confidence tracking

**Database Schema:**

- STM table: Add `confidence` REAL column with default 0.5
- Embeddings table: Add `confidence` REAL column
- Memory consolidation: Consider confidence in merge decisions

**Tool Dependencies:**

- cortex_add: Auto-calculate confidence at creation
- cortex_stm: Display confidence scores in output
- cortex_stats: Report confidence distribution
- memory_search: Filter and rank by confidence

## 5. Acceptance Criteria

**AC-1** Retroactive Scoring Complete

- [ ] All existing STM entries have confidence scores between 0.1-1.0
- [ ] All existing embeddings have confidence scores
- [ ] All existing atoms have confidence scores
- [ ] Confidence calculation audit log shows 0 errors

**AC-2** Dynamic Updates Working

- [ ] New memories get initial confidence of 1.0
- [ ] Memory access increases confidence by 0.05 per access (capped)
- [ ] Age decay reduces confidence by 0.01 per day
- [ ] Contradiction detection applies -0.3 penalty
- [ ] Successful validations apply +0.2 bonus

**AC-3** Integration Complete

- [ ] cortex_add tool creates memories with confidence scores
- [ ] cortex_stm tool displays confidence in memory listing
- [ ] cortex_stats tool reports confidence distribution
- [ ] All existing cortex tools work unchanged

**AC-4** Performance Requirements Met

- [ ] Retroactive scoring completes in <5 minutes on production data
- [ ] Memory operations with confidence add <100ms latency
- [ ] Database queries with confidence filtering perform adequately

**AC-5** Data Quality Validated

- [ ] Manual spot-check of 100 random memories shows accurate confidence
- [ ] No memories with impossible confidence values (<0.1 or >1.0)
- [ ] Confidence audit trail available for debugging

## 6. Out of Scope

**Not Included:**

- Machine learning-based confidence prediction (future phase)
- Cross-agent confidence sharing (future phase)
- Confidence-based memory archival (separate task)
- User-configurable confidence algorithms (hardcoded for Phase 1)
- Real-time confidence visualization dashboard (future feature)
- Confidence-based memory recommendations (future feature)

**Deferred to Later Phases:**

- Advanced contradiction detection beyond exact matches
- Confidence calibration based on prediction accuracy
- Integration with external validation sources
- Confidence transfer during memory migration between agents

## Implementation Priority: HIGH

This is a foundational Phase 1 capability required for the pre-action hook system to function effectively. Memory reliability scoring is critical for the mandatory knowledge injection pipeline.
