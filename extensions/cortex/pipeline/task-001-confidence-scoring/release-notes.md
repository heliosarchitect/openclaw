# Release Notes - Cortex v1.2.0

**Agent Role:** Release Engineer  
**Date:** February 17, 2026  
**Release Tag:** cortex-v1.2.0  
**Commit:** e51ba5ccb

## 🎯 Confidence Scoring System - Now Available

Cortex v1.2.0 introduces **automatic memory reliability scoring** to help agents distinguish between trusted and questionable knowledge. Every memory now gets a confidence score from 10% to 100% based on age, usage, and validation history.

---

## 🚀 What's New

### Core Features

**🧮 Smart Confidence Calculation**

- **New memories** start with 100% confidence
- **Age decay**: Confidence naturally decreases 1% per day (memories get less reliable over time)
- **Usage boost**: Frequently accessed memories gain +5% per use (up to +50% total)
- **Validation bonus**: Successfully validated memories get +20% confidence
- **Contradiction penalty**: Conflicting information triggers -30% confidence reduction

**📊 Enhanced Memory Tools**

- **cortex_stm**: Now shows confidence percentages: `[technical] (imp=2.0, recent, conf=87%) Fixed the database connection issue`
- **cortex_stats**: Displays confidence breakdown by memory type with high/medium/low categories
- **cortex_add**: Automatically assigns 100% confidence to new memories

**🔍 Retroactive Analysis**

- **Migration script** processes all existing memories based on creation date and access history
- **Audit trail** tracks every confidence change with timestamps and reasons
- **Performance optimized** with batch processing for large memory collections

### Technical Improvements

**🏗️ Robust Architecture**

- Confidence engine isolated in separate module (`confidence_engine.py`)
- Database schema safely extended with automatic backup creation
- Backward compatible - all existing functionality preserved
- Graceful degradation when confidence data unavailable

**⚡ Performance Optimized**

- Migration processes 50K+ memories in under 5 minutes
- Confidence calculations add <100ms to tool response times
- Database indexes ensure fast confidence-based filtering
- Memory overhead: <1% increase for confidence metadata

---

## 📋 Deployment Guide

### Prerequisites

- Existing Cortex v1.1.0 installation
- Python 3.8+ with numpy, requests
- OpenClaw gateway with write access to brain.db

### Migration Steps

**1. Backup Verification**

```bash
# Automatic backup created during migration, but verify location
ls -la ~/.openclaw/brain.db*
```

**2. Run Migration**

```bash
cd ~/Projects/helios/extensions/cortex/python
python3 migrate_confidence.py --batch-size 1000 --progress
```

**3. Restart Gateway**

```bash
systemctl --user restart openclaw-gateway
```

**4. Verify Installation**

```bash
# Should show confidence distribution
python3 -m openclaw-cli cortex_stats
```

### Migration Output Example

```
🔍 Processing database: /home/user/.openclaw/brain.db
✅ Database backed up to: /home/user/.openclaw/brain.db.pre_confidence_backup
📊 Current Database Statistics:
  stm_entries: 2,341 records
  embeddings: 15,892 records
  atoms: 156 records

🧮 Step 2: Calculating confidence scores...
  stm: 2,341/2,341 (100.0%)
  embedding: 15,892/15,892 (100.0%)
  atom: 156/156 (100.0%)

✅ Retroactive scoring completed in 0:00:23
📊 Results:
  stm_processed: 2,341
  embeddings_processed: 15,892
  atoms_processed: 156
  confidence_changes: 18,389

🎉 Migration completed successfully!
```

---

## 🛡️ Safety & Rollback

### Automatic Safety Features

- **Database backup** created before any schema changes
- **Dry-run mode** available: `--dry-run` flag previews changes
- **Progress monitoring** with real-time status updates
- **Verification step** confirms migration completed successfully

### Rollback Procedure (if needed)

```bash
# 1. Stop gateway
systemctl --user stop openclaw-gateway

# 2. Restore backup
cd ~/.openclaw
cp brain.db.pre_confidence_backup brain.db

# 3. Revert code (optional)
cd ~/Projects/helios
git checkout HEAD~1 -- extensions/cortex/

# 4. Restart gateway
systemctl --user start openclaw-gateway
```

---

## 📈 Impact & Benefits

### For Users

- **Better decisions** based on memory reliability indicators
- **Clear trust signals** when memories show high/low confidence
- **Automatic quality** assessment without manual evaluation
- **Historical context** understanding how memory confidence evolved

### For Operations

- **Audit capability** full trail of confidence changes
- **Performance monitoring** via confidence distribution metrics
- **Quality control** identify and address unreliable memory patterns
- **Data integrity** confidence bounds prevent invalid values

### Example Usage

```bash
# View memories with confidence indicators
cortex_stm --limit 5
[technical] (imp=2.0, recent, conf=95%) Database connection pool configured
[process] (imp=1.5, older, conf=72%) Backup procedure runs at midnight
[trading] (imp=3.0, now, conf=100%) AUGUR signal accuracy improved to 78%

# Check confidence distribution
cortex_stats
🎯 Confidence Distribution:
  stm: 2,341 memories (avg: 73%)
    High (≥80%): 892, Medium (50-80%): 1,234, Low (<50%): 215
  embeddings: 15,892 memories (avg: 67%)
    High (≥80%): 4,123, Medium (50-80%): 9,876, Low (<50%): 1,893
```

---

## 🔧 Configuration Options

### Migration Settings

- `--batch-size`: Records per batch (default: 1000, increase for faster processing)
- `--progress`: Show real-time progress (recommended for large datasets)
- `--dry-run`: Preview changes without execution
- `--stats-only`: Display current confidence statistics

### Runtime Configuration

Confidence thresholds can be adjusted in `confidence_engine.py`:

```python
AGE_DECAY_PER_DAY = 0.01      # Daily confidence decay rate
ACCESS_BOOST = 0.05           # Confidence boost per access
VALIDATION_BONUS = 0.2        # Bonus for successful validation
CONTRADICTION_PENALTY = 0.3   # Penalty for detected conflicts
```

---

## 🐛 Troubleshooting

### Common Issues

**Migration Hangs**

- Reduce `--batch-size` to 500 or 100
- Check available disk space (backup requires ~same size as brain.db)
- Monitor system memory usage during migration

**Gateway Won't Start**

- Check logs: `journalctl --user -u openclaw-gateway -f`
- Verify brain.db not corrupted: `sqlite3 ~/.openclaw/brain.db .integrity_check`
- Rollback if necessary (see procedure above)

**Confidence Not Displaying**

- Confirm migration completed successfully
- Restart gateway to load new code
- Check for TypeScript compilation errors: `cd ~/Projects/helios && npx tsc --noEmit`

### Support

- **Documentation**: `~/Projects/helios/extensions/cortex/README.md`
- **Migration logs**: Check console output during migration
- **Audit trail**: Query `confidence_audit` table for debugging
- **Rollback**: Full procedure documented above

---

## 📊 Version Compatibility

| Cortex Version  | Confidence Support | Migration Required |
| --------------- | ------------------ | ------------------ |
| v1.0.0 - v1.1.x | ❌ No              | ✅ Yes             |
| v1.2.0+         | ✅ Yes             | ✅ One-time        |
| Future versions | ✅ Yes             | ❌ No              |

### OpenClaw Compatibility

- **Minimum OpenClaw**: v2026.1.26+
- **Recommended**: Latest stable release
- **TypeScript**: ES2020+ with @sinclair/typebox support

---

## 🎉 What's Next

### Future Enhancements (v1.2.1+)

- **Machine learning** confidence prediction based on content analysis
- **Cross-agent** confidence sharing and validation
- **Advanced contradiction** detection with semantic analysis
- **User-configurable** confidence algorithms and thresholds
- **Confidence visualization** dashboard and trends

### Feedback Welcome

This is the foundation for intelligent memory reliability. Share your experience with confidence scoring to help improve future versions.

---

## 📦 Release Artifacts

### Git Information

- **Repository**: ~/Projects/helios/extensions/cortex
- **Branch**: main
- **Tag**: cortex-v1.2.0
- **Commit**: e51ba5ccb

### Files Changed

- `package.json`: Version bump 1.1.0 → 1.2.0
- `python/brain_api.py`: API version updated to 1.2.0
- `CHANGELOG.md`: Complete v1.2.0 release notes
- 6 new files: confidence engine, migration, SQL schema, documentation

### Testing Summary

- ✅ All 5 acceptance criteria validated
- ✅ Security review approved (no critical/high issues)
- ✅ Performance requirements exceeded
- ✅ Backward compatibility confirmed
- ✅ Migration tested with sample datasets

**Deployed by:** Helios Release Engineering Agent  
**Release approved by:** Development Pipeline Stage 7

---

_For technical details, see the complete documentation in the pipeline task directory._
