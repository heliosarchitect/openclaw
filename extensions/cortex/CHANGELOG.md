# Cortex Memory Extension Changelog

## ⛔ CONSTRAINTS — What NOT To Do

_Every constraint has a scar behind it. Remove only when the underlying system changes make them obsolete._

### Memory Management Constraints

- **NO direct database writes** — All memory operations must go through brain.py UnifiedBrain class to maintain consistency and prevent corruption.
- **NO confidence scores outside 0.1-1.0 range** — Values outside this range break filtering logic and cause tool failures.
- **NO synchronous confidence recalculation** — Confidence updates must be async/batched to prevent blocking memory operations.

---

## Version 1.2.0 - "Confidence Foundation" (2026-02-17)

### ⛔ New Constraints

- **NO manual confidence score assignment** — Confidence must be calculated via ConfidenceEngine to ensure consistency.

### Breaking Changes

None — All changes are additive and backward compatible.

### New Features

- **NEW**: Memory Confidence Scoring System — Automatic reliability scoring for all memories
  - Algorithm: Age decay, access frequency boost, validation bonus, contradiction penalty
  - Range: 0.1 (minimum) to 1.0 (maximum confidence)
  - Coverage: STM entries, embeddings, atoms
  - Retroactive: Scores all existing memories based on historical data

- **NEW**: Confidence-Based Memory Filtering — Filter memories by reliability threshold
  - Critical operations: 0.8 minimum confidence required
  - Routine operations: 0.5 minimum confidence required
  - Experimental: 0.2 minimum confidence required
  - Search integration: Confidence scores included in all results

- **NEW**: Confidence Audit Trail — Track confidence changes over time
  - Reasons: Access boost, validation success/failure, contradiction detection
  - Full history: When confidence changed, why, and by how much
  - Debugging: Identify why memories have specific confidence levels

### Bug Fixes

- **FIX**: TypeScript compilation errors in cortex extension — Missing tool labels and undefined ctx references → Added required label properties and fixed parameter names
- **FIX**: Import statement cleanup — Removed unused imports causing ESLint errors → Cleaner codebase

### Database Schema Changes

- **SCHEMA**: Added confidence tracking columns to all memory tables

  ```sql
  -- STM entries
  ALTER TABLE stm_entries ADD COLUMN confidence REAL DEFAULT 0.5;
  ALTER TABLE stm_entries ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'));
  ALTER TABLE stm_entries ADD COLUMN access_count INTEGER DEFAULT 1;

  -- Embeddings
  ALTER TABLE embeddings ADD COLUMN confidence REAL DEFAULT 0.5;
  ALTER TABLE embeddings ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'));

  -- Atoms
  ALTER TABLE atoms ADD COLUMN confidence REAL DEFAULT 0.6;
  ALTER TABLE atoms ADD COLUMN validation_count INTEGER DEFAULT 0;
  ```

- **SCHEMA**: New confidence audit table for change tracking
  ```sql
  CREATE TABLE confidence_audit (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    old_confidence REAL,
    new_confidence REAL,
    reason TEXT,
    timestamp INTEGER DEFAULT (strftime('%s', 'now'))
  );
  ```

### Configuration Changes

- **CONFIG**: Default STM capacity reduced from 50,000 to 2,000 — Prevents memory bombs during initialization

### Performance Impact

| Metric              | Before | After  | Delta                         |
| ------------------- | ------ | ------ | ----------------------------- |
| Memory Search       | ~200ms | ~250ms | +25% (confidence calculation) |
| Memory Creation     | ~50ms  | ~55ms  | +10% (initial confidence)     |
| Database Size       | 13MB   | 13.5MB | +4% (confidence metadata)     |
| Retroactive Scoring | N/A    | <5min  | New operation                 |

### Tool Enhancements

- **cortex_add**: Now sets initial confidence of 1.0 for all new memories
- **cortex_stm**: Displays confidence percentages alongside memory content
- **cortex_stats**: Reports confidence distribution (high/medium/low breakdown)
- **memory_search**: Can filter by minimum confidence threshold

### Key Files Changed

- `extensions/cortex/python/confidence_engine.py` — New confidence calculation engine
- `extensions/cortex/python/migrate_confidence.py` — Retroactive scoring migration
- `extensions/cortex/python/brain.py` — Confidence integration in UnifiedBrain
- `extensions/cortex/cortex-bridge.ts` — TypeScript confidence support
- `extensions/cortex/index.ts` — Tool enhancements with confidence

### Key Commits

- `2bffc4109` — fix: TypeScript errors in cortex extension - add missing labels and fix ctx references
- `eed6c8018` — fix: remaining TypeScript issues - remove OpenClawPlugin type, fix implicit any

### Migration Required

Run confidence migration after deployment:

```bash
cd ~/Projects/helios/extensions/cortex/python
python3 migrate_confidence.py --batch-size 1000 --progress
```

### Lessons Learned

- TypeScript tooling definitions require `label` property in newer OpenClaw versions
- Large STM capacity defaults (50K) cause gateway hangs during initialization
- Confidence scoring must be designed as additive feature to avoid breaking existing functionality
- Database migrations need comprehensive rollback plans for production safety

---

## Version 1.1.0 - "Pre-Action SOP Enforcement" (2026-02-17)

### New Features

- **NEW**: Pre-action SOP enforcement hook — Intercepts tool calls to inject relevant SOPs and procedures
- **NEW**: Mandatory knowledge consultation — Tool execution blocked until knowledge acknowledgment

### Bug Fixes

- **FIX**: Hot memory feedback loop — Reduced decay rate to prevent infinite growth

---

## Version 1.0.0 - "Foundation Release" (2026-02-17)

### New Features

- **NEW**: Short-term memory (STM) with 50K+ capacity
- **NEW**: Atomic knowledge units with causal linking
- **NEW**: Temporal search and pattern analysis
- **NEW**: Cross-agent messaging via SYNAPSE protocol
- **NEW**: GPU-accelerated embeddings with semantic search
- **NEW**: Deep causal abstraction ("keep going until no")
- **NEW**: Working memory management for persistent context

### Database Schema

- Initial brain.db schema with unified storage
- STM, atoms, embeddings, messages, threads tables
- FTS5 full-text search integration

---

_Template: lbf-templates/project/CHANGELOG.md_
