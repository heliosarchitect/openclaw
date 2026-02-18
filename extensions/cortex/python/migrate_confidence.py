#!/usr/bin/env python3
"""
Confidence Migration Script
One-time script to add confidence scoring to existing memories.
"""

import sqlite3
import argparse
import json
import sys
import os
from datetime import datetime
from pathlib import Path
from confidence_engine import ConfidenceEngine

def create_confidence_schema(db_path: str) -> bool:
    """Add confidence-related columns and tables to database."""
    try:
        with sqlite3.connect(db_path) as conn:
            # Create backup before schema changes
            backup_path = f"{db_path}.pre_confidence_backup"
            with sqlite3.connect(backup_path) as backup:
                conn.backup(backup)
                print(f"✅ Database backed up to: {backup_path}")
            
            # Add confidence columns to existing tables
            schema_updates = [
                # STM entries
                "ALTER TABLE stm_entries ADD COLUMN confidence REAL DEFAULT 0.5",
                "ALTER TABLE stm_entries ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'))",
                "ALTER TABLE stm_entries ADD COLUMN access_count INTEGER DEFAULT 1",
                "ALTER TABLE stm_entries ADD COLUMN validation_count INTEGER DEFAULT 0", 
                "ALTER TABLE stm_entries ADD COLUMN contradiction_count INTEGER DEFAULT 0",
                "CREATE INDEX IF NOT EXISTS idx_stm_confidence ON stm_entries(confidence)",
                
                # Embeddings
                "ALTER TABLE embeddings ADD COLUMN confidence REAL DEFAULT 0.5",
                "ALTER TABLE embeddings ADD COLUMN last_accessed INTEGER DEFAULT (strftime('%s', 'now'))",
                "ALTER TABLE embeddings ADD COLUMN access_count INTEGER DEFAULT 1",
                "ALTER TABLE embeddings ADD COLUMN validation_count INTEGER DEFAULT 0",
                "CREATE INDEX IF NOT EXISTS idx_embeddings_confidence ON embeddings(confidence)",
                
                # Atoms
                "ALTER TABLE atoms ADD COLUMN confidence REAL DEFAULT 0.6",
                "ALTER TABLE atoms ADD COLUMN validation_count INTEGER DEFAULT 0", 
                "ALTER TABLE atoms ADD COLUMN contradiction_flags TEXT DEFAULT '[]'",
                "CREATE INDEX IF NOT EXISTS idx_atoms_confidence ON atoms(confidence)",
            ]
            
            for sql in schema_updates:
                try:
                    conn.execute(sql)
                    print(f"✅ {sql}")
                except sqlite3.OperationalError as e:
                    if "duplicate column name" in str(e).lower():
                        print(f"⚠️  Column already exists: {sql}")
                    else:
                        print(f"❌ Failed: {sql} - {e}")
                        return False
            
            # Create confidence audit table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS confidence_audit (
                    id TEXT PRIMARY KEY,
                    memory_id TEXT NOT NULL,
                    memory_type TEXT NOT NULL,
                    old_confidence REAL,
                    new_confidence REAL,
                    reason TEXT,
                    timestamp INTEGER DEFAULT (strftime('%s', 'now'))
                )
            """)
            print("✅ Confidence audit table created")
            
            conn.commit()
            return True
            
    except Exception as e:
        print(f"❌ Schema migration failed: {e}")
        return False

def get_database_stats(db_path: str) -> dict:
    """Get current database statistics."""
    stats = {}
    
    try:
        with sqlite3.connect(db_path) as conn:
            tables = ["stm_entries", "embeddings", "atoms"]
            
            for table in tables:
                try:
                    cursor = conn.execute(f"SELECT COUNT(*) FROM {table}")
                    count = cursor.fetchone()[0]
                    stats[table] = count
                    print(f"📊 {table}: {count:,} records")
                except sqlite3.OperationalError:
                    stats[table] = 0
                    print(f"📊 {table}: table not found")
                    
    except Exception as e:
        print(f"❌ Error getting stats: {e}")
        
    return stats

def verify_migration(db_path: str) -> bool:
    """Verify migration completed successfully."""
    try:
        with sqlite3.connect(db_path) as conn:
            # Check if confidence columns exist
            tables_to_check = [
                ("stm_entries", ["confidence", "access_count", "validation_count"]),
                ("embeddings", ["confidence", "access_count", "validation_count"]),
                ("atoms", ["confidence", "validation_count"])
            ]
            
            for table, columns in tables_to_check:
                try:
                    cursor = conn.execute(f"PRAGMA table_info({table})")
                    table_columns = [row[1] for row in cursor.fetchall()]
                    
                    for col in columns:
                        if col in table_columns:
                            print(f"✅ {table}.{col} exists")
                        else:
                            print(f"❌ {table}.{col} missing")
                            return False
                            
                except sqlite3.OperationalError:
                    print(f"⚠️  Table {table} not found (may be normal)")
                    
            # Check audit table
            cursor = conn.execute("SELECT COUNT(*) FROM confidence_audit")
            audit_count = cursor.fetchone()[0]
            print(f"✅ Confidence audit table: {audit_count} entries")
            
            return True
            
    except Exception as e:
        print(f"❌ Verification failed: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="Migrate database to confidence scoring system")
    parser.add_argument("--db-path", 
                       default=os.path.expanduser("~/.openclaw/brain.db"),
                       help="Path to brain.db database")
    parser.add_argument("--batch-size", type=int, default=1000,
                       help="Batch size for processing records")
    parser.add_argument("--dry-run", action="store_true",
                       help="Show what would be done without making changes")
    parser.add_argument("--progress", action="store_true", 
                       help="Show progress during migration")
    parser.add_argument("--stats-only", action="store_true",
                       help="Only show database statistics")
    
    args = parser.parse_args()
    
    # Verify database exists
    if not os.path.exists(args.db_path):
        print(f"❌ Database not found: {args.db_path}")
        sys.exit(1)
        
    print(f"🔍 Processing database: {args.db_path}")
    
    # Show initial statistics
    print("\n📊 Current Database Statistics:")
    initial_stats = get_database_stats(args.db_path)
    
    if args.stats_only:
        # Show confidence stats if already migrated
        try:
            engine = ConfidenceEngine(args.db_path)
            confidence_stats = engine.get_confidence_stats()
            if confidence_stats:
                print("\n🎯 Confidence Statistics:")
                print(json.dumps(confidence_stats, indent=2))
            else:
                print("⚠️  No confidence data found - migration may be needed")
        except Exception as e:
            print(f"⚠️  Could not get confidence stats: {e}")
        return
    
    if args.dry_run:
        print("\n🧪 DRY RUN MODE - No changes will be made")
        print("Schema updates that would be applied:")
        print("- Add confidence columns to stm_entries, embeddings, atoms")
        print("- Create confidence audit table")
        print("- Create confidence indexes")
        print("- Calculate confidence scores for all existing records")
        return
        
    # Perform migration
    print("\n🔧 Starting Migration...")
    
    # Step 1: Schema migration
    print("\n📝 Step 1: Updating database schema...")
    if not create_confidence_schema(args.db_path):
        print("❌ Schema migration failed. Stopping.")
        sys.exit(1)
        
    # Step 2: Retroactive scoring
    print("\n🧮 Step 2: Calculating confidence scores...")
    engine = ConfidenceEngine(args.db_path)
    
    def progress_callback(memory_type: str, processed: int, total: int):
        if args.progress:
            percentage = (processed / total * 100) if total > 0 else 0
            print(f"  {memory_type}: {processed:,}/{total:,} ({percentage:.1f}%)")
    
    start_time = datetime.now()
    results = engine.apply_retroactive_scoring(
        batch_size=args.batch_size,
        progress_callback=progress_callback
    )
    end_time = datetime.now()
    
    duration = end_time - start_time
    print(f"\n✅ Retroactive scoring completed in {duration}")
    print("📊 Results:")
    for key, value in results.items():
        print(f"  {key}: {value:,}")
        
    # Step 3: Verification
    print("\n🔍 Step 3: Verifying migration...")
    if verify_migration(args.db_path):
        print("✅ Migration verification passed")
    else:
        print("❌ Migration verification failed")
        sys.exit(1)
        
    # Step 4: Final statistics
    print("\n📊 Final Database Statistics:")
    final_stats = get_database_stats(args.db_path)
    
    print("\n🎯 Confidence Distribution:")
    confidence_stats = engine.get_confidence_stats()
    if confidence_stats:
        for table, stats in confidence_stats.items():
            if stats['total'] > 0:
                print(f"  {table}:")
                print(f"    Total: {stats['total']:,}")
                print(f"    Average confidence: {stats['average_confidence']:.3f}")
                print(f"    High confidence (≥0.8): {stats['high_confidence']:,}")
                print(f"    Medium confidence (0.5-0.8): {stats['medium_confidence']:,}")
                print(f"    Low confidence (<0.5): {stats['low_confidence']:,}")
                
    print("\n🎉 Migration completed successfully!")
    print(f"💾 Backup available at: {args.db_path}.pre_confidence_backup")
    print("\nNext steps:")
    print("1. Restart the OpenClaw gateway to load new confidence features")
    print("2. Test confidence scoring with: cortex_stats")
    print("3. Monitor confidence changes in the audit table")

if __name__ == "__main__":
    main()