# Technical Design Document - Confidence Scoring System

**Agent Role:** Software Architect  
**Date:** 2026-02-17  
**Task:** Phase 1.2 - Confidence scoring for all memories

## 1. Approach Summary

Implement confidence scoring through a multi-layer approach: database schema extensions, confidence engine class, integration hooks, and retroactive migration script. The design uses SQLite triggers for automatic updates, cached confidence calculation to maintain performance, and a structured rollout to minimize risk to existing functionality.

## 2. Files to Create/Modify

### Core Implementation Files

**NEW: `extensions/cortex/python/confidence_engine.py`**

- ConfidenceEngine class with calculation algorithms
- Retroactive scoring methods for existing memories
- Validation and contradiction detection logic
- ~300 lines

**NEW: `extensions/cortex/python/migrate_confidence.py`**

- One-time migration script for retroactive scoring
- Batch processing for large datasets
- Progress reporting and error handling
- ~150 lines

**NEW: `extensions/cortex/sql/confidence_migration.sql`**

- Database schema updates (ALTER TABLE statements)
- Confidence-related triggers and indexes
- ~50 lines

### Modified Files

**MODIFY: `extensions/cortex/python/brain.py`**

- Add confidence parameter to memory creation methods
- Integrate confidence filtering in search operations
- Add confidence update methods
- ~50 lines of changes

**MODIFY: `extensions/cortex/cortex-bridge.ts`**

- Add confidence field to CortexMemory interface
- Expose confidence calculation methods to TypeScript
- Update memory retrieval to include confidence
- ~30 lines of changes

**MODIFY: `extensions/cortex/index.ts`**

- Update cortex_add to set initial confidence
- Update cortex_stm to display confidence scores
- Update cortex_stats to report confidence distribution
- ~40 lines of changes

**MODIFY: `extensions/cortex/python/stm_manager.py`**

- Add confidence field to STM entry structure
- Update STM access tracking for confidence boost
- ~20 lines of changes

## 3. Database Schema Changes

### STM Table Modifications

```sql
ALTER TABLE stm_entries ADD COLUMN confidence REAL DEFAULT 0.5;
ALTER TABLE stm_entries ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'));
ALTER TABLE stm_entries ADD COLUMN access_count INTEGER DEFAULT 1;
ALTER TABLE stm_entries ADD COLUMN validation_count INTEGER DEFAULT 0;
ALTER TABLE stm_entries ADD COLUMN contradiction_count INTEGER DEFAULT 0;

CREATE INDEX idx_stm_confidence ON stm_entries(confidence);
```

### Embeddings Table Modifications

```sql
ALTER TABLE embeddings ADD COLUMN confidence REAL DEFAULT 0.5;
ALTER TABLE embeddings ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'));
ALTER TABLE embeddings ADD COLUMN access_count INTEGER DEFAULT 1;
ALTER TABLE embeddings ADD COLUMN validation_count INTEGER DEFAULT 0;

CREATE INDEX idx_embeddings_confidence ON embeddings(confidence);
```

### Atoms Table Modifications

```sql
ALTER TABLE atoms ADD COLUMN confidence REAL DEFAULT 0.6;
ALTER TABLE atoms ADD COLUMN validation_count INTEGER DEFAULT 0;
ALTER TABLE atoms ADD COLUMN contradiction_flags TEXT DEFAULT '[]';

CREATE INDEX idx_atoms_confidence ON atoms(confidence);
```

### Confidence Audit Table (New)

```sql
CREATE TABLE confidence_audit (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  memory_type TEXT NOT NULL, -- 'stm', 'embedding', 'atom'
  old_confidence REAL,
  new_confidence REAL,
  reason TEXT, -- 'access', 'validation', 'contradiction', 'decay'
  timestamp INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY(memory_id) REFERENCES stm_entries(id) -- polymorphic
);
```

## 4. Confidence Calculation Algorithm

### ConfidenceEngine Class Structure

```python
class ConfidenceEngine:
    BASE_SCORE = 1.0
    AGE_DECAY_PER_DAY = 0.01
    ACCESS_BOOST = 0.05
    CONTRADICTION_PENALTY = 0.3
    VALIDATION_BONUS = 0.2
    MIN_CONFIDENCE = 0.1
    MAX_CONFIDENCE = 1.0

    def calculate_confidence(self, memory: MemoryRecord) -> float:
        """Calculate current confidence based on all factors"""

    def apply_retroactive_scoring(self, batch_size: int = 1000) -> dict:
        """Score all existing memories in batches"""

    def update_on_access(self, memory_id: str) -> float:
        """Boost confidence on memory access"""

    def detect_contradictions(self, new_memory: str, existing_memories: list) -> list:
        """Find potentially contradictory memories"""

    def apply_validation_bonus(self, memory_id: str, success: bool) -> float:
        """Apply bonus/penalty based on execution success"""
```

### Calculation Formula

```python
def calculate_confidence(self, creation_date, access_count, validation_count, contradiction_count):
    # Age decay
    days_old = (datetime.now() - creation_date).days
    age_factor = max(0.1, 1.0 - (days_old * self.AGE_DECAY_PER_DAY))

    # Access boost (capped at 30 days)
    access_factor = min(0.5, access_count * self.ACCESS_BOOST)

    # Validation bonus
    validation_factor = validation_count * self.VALIDATION_BONUS

    # Contradiction penalty
    contradiction_factor = contradiction_count * self.CONTRADICTION_PENALTY

    # Final confidence
    confidence = self.BASE_SCORE + access_factor + validation_factor - contradiction_factor
    confidence *= age_factor  # Apply age decay as multiplier

    return max(self.MIN_CONFIDENCE, min(self.MAX_CONFIDENCE, confidence))
```

## 5. API Integration Points

### cortex_add Tool Integration

```typescript
// In cortex_add execute method
const initialConfidence = 1.0; // All new memories start with perfect confidence
const memory = await bridge.createMemory({
  content,
  categories,
  importance,
  confidence: initialConfidence,
  validation_count: 0,
  contradiction_count: 0,
});
```

### cortex_stm Tool Integration

```typescript
// In cortex_stm results formatting
results.forEach((item) => {
  item.display_confidence = `${(item.confidence * 100).toFixed(0)}%`;
  item.confidence_category =
    item.confidence >= 0.8 ? "high" : item.confidence >= 0.5 ? "medium" : "low";
});
```

### cortex_stats Enhancement

```typescript
// Add to cortex_stats output
const confidenceStats = await bridge.getConfidenceDistribution();
stats.confidence = {
  average: confidenceStats.average,
  distribution: {
    high_confidence: confidenceStats.high_count, // >= 0.8
    medium_confidence: confidenceStats.medium_count, // 0.5-0.8
    low_confidence: confidenceStats.low_count, // < 0.5
  },
  total_with_confidence: confidenceStats.total,
};
```

## 6. Migration Strategy

### Phase 1: Schema Migration (5 minutes)

1. Backup brain.db before changes
2. Run confidence_migration.sql to add columns
3. Verify schema changes with test queries

### Phase 2: Retroactive Scoring (30 minutes)

1. Run migrate_confidence.py with batch processing
2. Process STM entries first (fastest)
3. Process embeddings second (medium)
4. Process atoms last (complex validation logic)
5. Generate migration report with statistics

### Phase 3: Integration Activation (2 minutes)

1. Deploy updated cortex-bridge.ts with confidence support
2. Deploy updated index.ts with tool enhancements
3. Restart cortex extension to activate new code
4. Validate sample queries return confidence scores

## 7. Performance Considerations

### Confidence Calculation Optimization

- Cache confidence scores for 1 hour after calculation
- Use SQLite triggers to auto-update access counts
- Batch confidence recalculation daily during off-hours
- Index confidence columns for fast filtering

### Memory Usage Impact

- Each confidence score: 8 bytes (REAL)
- Total overhead for 50K memories: ~400KB additional storage
- Confidence metadata per memory: ~40 bytes additional
- Total memory increase: <2MB for large installations

### Query Performance

- Confidence filtering adds ~10ms to search queries
- Confidence-based sorting comparable to existing relevance sort
- Confidence statistics calculation: <50ms for 50K memories
- Overall tool response time increase: <100ms target met

## 8. Risk Assessment

### High Risk Items

**Database Migration Failure**

- Mitigation: Full backup before migration, rollback script prepared
- Test on copy of production database first

**Performance Degradation**

- Mitigation: Performance benchmarks before/after, optimization ready
- Confidence calculation can be disabled via config if needed

### Medium Risk Items

**Confidence Accuracy Issues**

- Mitigation: Manual validation of sample memories, algorithm tuning
- Conservative initial thresholds, can be adjusted based on usage

**Integration Breaking Changes**

- Mitigation: All changes are additive, fallback values provided
- Existing tools continue working without confidence data

### Low Risk Items

**Storage Space Concerns** - Confidence data adds <1% storage overhead
**Complexity Addition** - Well-contained in ConfidenceEngine class

## 9. Testing Strategy

### Unit Tests (confidence_engine_test.py)

- Test confidence calculation with various scenarios
- Test retroactive scoring logic
- Test contradiction detection algorithms
- Test boundary conditions (min/max confidence)

### Integration Tests (cortex_confidence_integration_test.py)

- Test cortex_add with confidence scoring
- Test cortex_stm confidence display
- Test cortex_stats confidence reporting
- Test confidence-based search filtering

### Migration Tests (migrate_confidence_test.py)

- Test migration script with sample data
- Test rollback scenario
- Test performance with large datasets
- Test migration resume after interruption

## 10. Rollback Plan

### Emergency Rollback Steps

1. Restore brain.db from pre-migration backup
2. Revert cortex-bridge.ts to previous version
3. Revert index.ts to previous version
4. Restart gateway to load previous code
5. Verify all cortex tools working normally

### Gradual Rollback Option

1. Set confidence calculation to always return 0.5 (disable)
2. Remove confidence from tool outputs via config flag
3. Keep database schema changes for future retry
4. Monitor for 24 hours before full rollback decision

## Estimated Complexity: MEDIUM (M)

- Database changes: Low complexity
- Algorithm implementation: Medium complexity
- Integration points: Medium complexity
- Migration script: Medium complexity
- Testing requirements: Medium complexity

Total development time estimate: 8-12 hours across all pipeline stages.
