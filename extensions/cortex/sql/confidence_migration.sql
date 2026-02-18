-- Confidence Scoring System Migration
-- Adds confidence-related columns and tables to existing brain.db

-- STM Entries Table Enhancements
ALTER TABLE stm_entries ADD COLUMN confidence REAL DEFAULT 0.5;
ALTER TABLE stm_entries ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'));
ALTER TABLE stm_entries ADD COLUMN access_count INTEGER DEFAULT 1;
ALTER TABLE stm_entries ADD COLUMN validation_count INTEGER DEFAULT 0;
ALTER TABLE stm_entries ADD COLUMN contradiction_count INTEGER DEFAULT 0;

-- STM Legacy Table Support (if using old stm table name)
ALTER TABLE stm ADD COLUMN confidence REAL DEFAULT 0.5;
ALTER TABLE stm ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'));
ALTER TABLE stm ADD COLUMN access_count INTEGER DEFAULT 1;
ALTER TABLE stm ADD COLUMN validation_count INTEGER DEFAULT 0;
ALTER TABLE stm ADD COLUMN contradiction_count INTEGER DEFAULT 0;

-- Embeddings Table Enhancements
ALTER TABLE embeddings ADD COLUMN confidence REAL DEFAULT 0.5;
ALTER TABLE embeddings ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'));
ALTER TABLE embeddings ADD COLUMN access_count INTEGER DEFAULT 1;
ALTER TABLE embeddings ADD COLUMN validation_count INTEGER DEFAULT 0;

-- Atoms Table Enhancements
ALTER TABLE atoms ADD COLUMN confidence REAL DEFAULT 0.6;
ALTER TABLE atoms ADD COLUMN validation_count INTEGER DEFAULT 0;
ALTER TABLE atoms ADD COLUMN contradiction_flags TEXT DEFAULT '[]';

-- Confidence Audit Table
CREATE TABLE IF NOT EXISTS confidence_audit (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    memory_type TEXT NOT NULL, -- 'stm', 'embedding', 'atom'
    old_confidence REAL,
    new_confidence REAL,
    reason TEXT, -- 'access', 'validation', 'contradiction', 'decay', 'retroactive_scoring'
    timestamp INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_stm_confidence ON stm_entries(confidence);
CREATE INDEX IF NOT EXISTS idx_stm_legacy_confidence ON stm(confidence);
CREATE INDEX IF NOT EXISTS idx_embeddings_confidence ON embeddings(confidence);
CREATE INDEX IF NOT EXISTS idx_atoms_confidence ON atoms(confidence);
CREATE INDEX IF NOT EXISTS idx_confidence_audit_memory ON confidence_audit(memory_id);
CREATE INDEX IF NOT EXISTS idx_confidence_audit_timestamp ON confidence_audit(timestamp);

-- Views for Easy Querying

-- High Confidence Memories View
CREATE VIEW IF NOT EXISTS high_confidence_memories AS
SELECT 'stm' as memory_type, id, content, confidence, created_at, categories
FROM stm_entries 
WHERE confidence >= 0.8
UNION ALL
SELECT 'embedding' as memory_type, id, content, confidence, created_at, categories
FROM embeddings 
WHERE confidence >= 0.8
UNION ALL  
SELECT 'atom' as memory_type, id, content, confidence, created_at, '{}'
FROM atoms
WHERE confidence >= 0.8;

-- Confidence Statistics View
CREATE VIEW IF NOT EXISTS confidence_summary AS
SELECT 
    'stm' as table_name,
    COUNT(*) as total,
    AVG(confidence) as avg_confidence,
    COUNT(CASE WHEN confidence >= 0.8 THEN 1 END) as high_confidence,
    COUNT(CASE WHEN confidence >= 0.5 AND confidence < 0.8 THEN 1 END) as medium_confidence,
    COUNT(CASE WHEN confidence < 0.5 THEN 1 END) as low_confidence
FROM stm_entries
UNION ALL
SELECT 
    'embeddings' as table_name,
    COUNT(*) as total,
    AVG(confidence) as avg_confidence,
    COUNT(CASE WHEN confidence >= 0.8 THEN 1 END) as high_confidence,
    COUNT(CASE WHEN confidence >= 0.5 AND confidence < 0.8 THEN 1 END) as medium_confidence,
    COUNT(CASE WHEN confidence < 0.5 THEN 1 END) as low_confidence
FROM embeddings
UNION ALL
SELECT 
    'atoms' as table_name,
    COUNT(*) as total,
    AVG(confidence) as avg_confidence,
    COUNT(CASE WHEN confidence >= 0.8 THEN 1 END) as high_confidence,
    COUNT(CASE WHEN confidence >= 0.5 AND confidence < 0.8 THEN 1 END) as medium_confidence,
    COUNT(CASE WHEN confidence < 0.5 THEN 1 END) as low_confidence
FROM atoms;

-- Triggers for Automatic Confidence Updates

-- Update access timestamp when STM entry is read
CREATE TRIGGER IF NOT EXISTS update_stm_access
    AFTER UPDATE OF access_count ON stm_entries
    FOR EACH ROW
BEGIN
    UPDATE stm_entries 
    SET last_accessed = strftime('%s', 'now')
    WHERE id = NEW.id;
END;

-- Update access timestamp when embeddings are accessed  
CREATE TRIGGER IF NOT EXISTS update_embedding_access
    AFTER UPDATE OF access_count ON embeddings
    FOR EACH ROW
BEGIN
    UPDATE embeddings
    SET last_accessed = strftime('%s', 'now') 
    WHERE id = NEW.id;
END;

-- Log confidence changes automatically
CREATE TRIGGER IF NOT EXISTS log_stm_confidence_changes
    AFTER UPDATE OF confidence ON stm_entries
    FOR EACH ROW
    WHEN OLD.confidence != NEW.confidence
BEGIN
    INSERT INTO confidence_audit (
        id, memory_id, memory_type, old_confidence, new_confidence, 
        reason, timestamp
    ) VALUES (
        'audit_' || datetime('now') || '_' || NEW.id,
        NEW.id, 'stm', OLD.confidence, NEW.confidence,
        'auto_update', strftime('%s', 'now')
    );
END;

CREATE TRIGGER IF NOT EXISTS log_embedding_confidence_changes
    AFTER UPDATE OF confidence ON embeddings
    FOR EACH ROW
    WHEN OLD.confidence != NEW.confidence
BEGIN
    INSERT INTO confidence_audit (
        id, memory_id, memory_type, old_confidence, new_confidence,
        reason, timestamp
    ) VALUES (
        'audit_' || datetime('now') || '_' || NEW.id,
        NEW.id, 'embedding', OLD.confidence, NEW.confidence,
        'auto_update', strftime('%s', 'now')
    );
END;

CREATE TRIGGER IF NOT EXISTS log_atom_confidence_changes
    AFTER UPDATE OF confidence ON atoms
    FOR EACH ROW
    WHEN OLD.confidence != NEW.confidence
BEGIN
    INSERT INTO confidence_audit (
        id, memory_id, memory_type, old_confidence, new_confidence,
        reason, timestamp
    ) VALUES (
        'audit_' || datetime('now') || '_' || NEW.id,
        NEW.id, 'atom', OLD.confidence, NEW.confidence,
        'auto_update', strftime('%s', 'now')
    );
END;