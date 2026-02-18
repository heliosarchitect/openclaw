#!/usr/bin/env python3
"""
Confidence Engine for Cortex Memory System
Calculates and manages reliability scores for all memories.
"""

import sqlite3
import json
import math
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)

@dataclass
class MemoryRecord:
    id: str
    content: str
    created_at: datetime
    access_count: int = 1
    validation_count: int = 0
    contradiction_count: int = 0
    last_accessed: Optional[datetime] = None
    memory_type: str = "stm"  # stm, embedding, atom

class ConfidenceEngine:
    """Calculates and manages memory confidence scores."""
    
    # Algorithm constants
    BASE_SCORE = 1.0
    AGE_DECAY_PER_DAY = 0.01
    ACCESS_BOOST = 0.05
    CONTRADICTION_PENALTY = 0.3
    VALIDATION_BONUS = 0.2
    MIN_CONFIDENCE = 0.1
    MAX_CONFIDENCE = 1.0
    
    # Access boost window (days)
    ACCESS_WINDOW_DAYS = 30
    
    def __init__(self, db_path: str):
        """Initialize confidence engine with database path."""
        self.db_path = db_path
        
    def calculate_confidence(self, record: MemoryRecord) -> float:
        """Calculate current confidence based on all factors."""
        try:
            # Age decay factor
            now = datetime.now()
            age_days = (now - record.created_at).days
            age_factor = max(0.1, 1.0 - (age_days * self.AGE_DECAY_PER_DAY))
            
            # Access frequency boost (within window)
            access_factor = 0.0
            if record.last_accessed:
                days_since_access = (now - record.last_accessed).days
                if days_since_access <= self.ACCESS_WINDOW_DAYS:
                    # More recent access = higher boost
                    recency_multiplier = 1.0 - (days_since_access / self.ACCESS_WINDOW_DAYS)
                    access_factor = min(0.5, record.access_count * self.ACCESS_BOOST * recency_multiplier)
            
            # Validation bonus
            validation_factor = record.validation_count * self.VALIDATION_BONUS
            
            # Contradiction penalty
            contradiction_factor = record.contradiction_count * self.CONTRADICTION_PENALTY
            
            # Calculate final confidence
            base_confidence = (self.BASE_SCORE + access_factor + validation_factor - contradiction_factor)
            final_confidence = base_confidence * age_factor
            
            # Clamp to valid range
            return self.clamp_confidence(final_confidence)
            
        except Exception as e:
            logger.error(f"Error calculating confidence for {record.id}: {e}")
            return 0.5  # Fallback to neutral confidence
            
    def clamp_confidence(self, confidence: float) -> float:
        """Ensure confidence is within valid range."""
        return max(self.MIN_CONFIDENCE, min(self.MAX_CONFIDENCE, confidence))
        
    def update_on_access(self, memory_id: str, memory_type: str = "stm") -> float:
        """Update confidence when memory is accessed."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                
                table_map = {
                    "stm": "stm_entries",
                    "embedding": "embeddings", 
                    "atom": "atoms"
                }
                table = table_map.get(memory_type, "stm_entries")
                
                # Get current record
                cursor = conn.execute(f"""
                    SELECT id, content, created_at, access_count, validation_count, 
                           contradiction_count, last_accessed, confidence
                    FROM {table} WHERE id = ?
                """, (memory_id,))
                
                row = cursor.fetchone()
                if not row:
                    logger.warning(f"Memory {memory_id} not found in {table}")
                    return 0.5
                    
                # Create memory record
                record = MemoryRecord(
                    id=row['id'],
                    content=row['content'],
                    created_at=datetime.fromisoformat(row['created_at']),
                    access_count=row.get('access_count', 1) + 1,  # Increment
                    validation_count=row.get('validation_count', 0),
                    contradiction_count=row.get('contradiction_count', 0),
                    last_accessed=datetime.now(),
                    memory_type=memory_type
                )
                
                # Calculate new confidence
                new_confidence = self.calculate_confidence(record)
                old_confidence = row.get('confidence', 0.5)
                
                # Update database
                conn.execute(f"""
                    UPDATE {table} 
                    SET access_count = ?, last_accessed = ?, confidence = ?
                    WHERE id = ?
                """, (record.access_count, record.last_accessed.isoformat(), 
                      new_confidence, memory_id))
                
                # Log confidence change
                self._log_confidence_change(
                    conn, memory_id, memory_type, old_confidence, 
                    new_confidence, "access"
                )
                
                conn.commit()
                return new_confidence
                
        except Exception as e:
            logger.error(f"Error updating confidence on access for {memory_id}: {e}")
            return 0.5
            
    def apply_validation_bonus(self, memory_id: str, success: bool, memory_type: str = "stm") -> float:
        """Apply validation bonus/penalty based on execution success."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                
                table_map = {
                    "stm": "stm_entries",
                    "embedding": "embeddings",
                    "atom": "atoms"
                }
                table = table_map.get(memory_type, "stm_entries")
                
                # Get current record
                cursor = conn.execute(f"""
                    SELECT id, content, created_at, access_count, validation_count,
                           contradiction_count, last_accessed, confidence
                    FROM {table} WHERE id = ?
                """, (memory_id,))
                
                row = cursor.fetchone()
                if not row:
                    return 0.5
                    
                # Update validation count
                new_validation_count = row.get('validation_count', 0)
                if success:
                    new_validation_count += 1
                    reason = "validation_success"
                else:
                    # Treat failure as contradiction
                    new_contradiction_count = row.get('contradiction_count', 0) + 1
                    reason = "validation_failure"
                
                # Create updated record
                record = MemoryRecord(
                    id=row['id'],
                    content=row['content'],
                    created_at=datetime.fromisoformat(row['created_at']),
                    access_count=row.get('access_count', 1),
                    validation_count=new_validation_count,
                    contradiction_count=new_contradiction_count if not success else row.get('contradiction_count', 0),
                    last_accessed=datetime.fromisoformat(row['last_accessed']) if row.get('last_accessed') else None,
                    memory_type=memory_type
                )
                
                # Calculate new confidence
                new_confidence = self.calculate_confidence(record)
                old_confidence = row.get('confidence', 0.5)
                
                # Update database
                if success:
                    conn.execute(f"""
                        UPDATE {table}
                        SET validation_count = ?, confidence = ?
                        WHERE id = ?
                    """, (record.validation_count, new_confidence, memory_id))
                else:
                    conn.execute(f"""
                        UPDATE {table}
                        SET contradiction_count = ?, confidence = ?
                        WHERE id = ?
                    """, (record.contradiction_count, new_confidence, memory_id))
                
                # Log confidence change
                self._log_confidence_change(
                    conn, memory_id, memory_type, old_confidence,
                    new_confidence, reason
                )
                
                conn.commit()
                return new_confidence
                
        except Exception as e:
            logger.error(f"Error applying validation to {memory_id}: {e}")
            return 0.5
            
    def detect_contradictions(self, new_content: str, existing_memories: List[Dict]) -> List[str]:
        """Detect potentially contradictory memories (basic implementation)."""
        contradictions = []
        
        # Basic contradiction detection - look for negating words
        negation_patterns = [
            ("not", ""), ("never", "always"), ("can't", "can"), 
            ("won't", "will"), ("don't", "do"), ("isn't", "is"),
            ("false", "true"), ("incorrect", "correct"), ("wrong", "right")
        ]
        
        new_lower = new_content.lower()
        
        for memory in existing_memories:
            memory_lower = memory.get('content', '').lower()
            
            # Check for direct negations
            for neg_word, pos_word in negation_patterns:
                if neg_word in new_lower and pos_word in memory_lower:
                    # Look for similar context
                    if self._similar_context(new_content, memory['content']):
                        contradictions.append(memory['id'])
                        
        return contradictions
        
    def _similar_context(self, text1: str, text2: str, threshold: float = 0.3) -> bool:
        """Check if two texts have similar context (simple word overlap)."""
        words1 = set(text1.lower().split())
        words2 = set(text2.lower().split())
        
        # Remove common stop words
        stop_words = {"the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by"}
        words1 -= stop_words
        words2 -= stop_words
        
        if not words1 or not words2:
            return False
            
        overlap = len(words1 & words2)
        similarity = overlap / min(len(words1), len(words2))
        
        return similarity >= threshold
        
    def apply_retroactive_scoring(self, batch_size: int = 1000, progress_callback=None) -> Dict[str, Any]:
        """Score all existing memories based on historical data."""
        results = {
            "stm_processed": 0,
            "embeddings_processed": 0, 
            "atoms_processed": 0,
            "errors": 0,
            "total_confidence_changes": 0
        }
        
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                
                # Process STM entries
                results.update(self._process_table_batch(
                    conn, "stm_entries", "stm", batch_size, progress_callback
                ))
                
                # Process embeddings  
                results.update(self._process_table_batch(
                    conn, "embeddings", "embedding", batch_size, progress_callback
                ))
                
                # Process atoms
                results.update(self._process_table_batch(
                    conn, "atoms", "atom", batch_size, progress_callback
                ))
                
                conn.commit()
                
        except Exception as e:
            logger.error(f"Error in retroactive scoring: {e}")
            results["errors"] += 1
            
        return results
        
    def _process_table_batch(self, conn: sqlite3.Connection, table: str, memory_type: str, 
                           batch_size: int, progress_callback) -> Dict[str, int]:
        """Process a single table in batches."""
        processed = 0
        confidence_changes = 0
        
        # Get total count
        total_count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        
        # Process in batches
        offset = 0
        while offset < total_count:
            cursor = conn.execute(f"""
                SELECT id, content, created_at, 
                       COALESCE(access_count, 1) as access_count,
                       COALESCE(validation_count, 0) as validation_count,
                       COALESCE(contradiction_count, 0) as contradiction_count,
                       last_accessed,
                       COALESCE(confidence, 0.5) as current_confidence
                FROM {table}
                LIMIT ? OFFSET ?
            """, (batch_size, offset))
            
            batch = cursor.fetchall()
            if not batch:
                break
                
            for row in batch:
                try:
                    # Create memory record
                    record = MemoryRecord(
                        id=row['id'],
                        content=row['content'], 
                        created_at=datetime.fromisoformat(row['created_at']),
                        access_count=row['access_count'],
                        validation_count=row['validation_count'],
                        contradiction_count=row['contradiction_count'],
                        last_accessed=datetime.fromisoformat(row['last_accessed']) if row['last_accessed'] else None,
                        memory_type=memory_type
                    )
                    
                    # Calculate confidence
                    new_confidence = self.calculate_confidence(record)
                    old_confidence = row['current_confidence']
                    
                    # Only update if confidence changed significantly
                    if abs(new_confidence - old_confidence) > 0.01:
                        conn.execute(f"""
                            UPDATE {table} SET confidence = ? WHERE id = ?
                        """, (new_confidence, row['id']))
                        
                        self._log_confidence_change(
                            conn, row['id'], memory_type, old_confidence,
                            new_confidence, "retroactive_scoring"
                        )
                        confidence_changes += 1
                        
                    processed += 1
                    
                except Exception as e:
                    logger.error(f"Error processing {row['id']}: {e}")
                    continue
                    
            offset += batch_size
            
            # Progress callback
            if progress_callback:
                progress_callback(memory_type, processed, total_count)
                
        return {f"{memory_type}_processed": processed, "confidence_changes": confidence_changes}
        
    def _log_confidence_change(self, conn: sqlite3.Connection, memory_id: str, 
                             memory_type: str, old_confidence: float, 
                             new_confidence: float, reason: str):
        """Log confidence changes to audit table."""
        try:
            conn.execute("""
                INSERT INTO confidence_audit 
                (id, memory_id, memory_type, old_confidence, new_confidence, reason, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                f"audit_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{memory_id}",
                memory_id, memory_type, old_confidence, new_confidence, reason,
                int(datetime.now().timestamp())
            ))
        except Exception as e:
            logger.debug(f"Could not log confidence change: {e}")
            
    def get_confidence_stats(self) -> Dict[str, Any]:
        """Get confidence distribution statistics."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                stats = {}
                
                # STM stats
                cursor = conn.execute("""
                    SELECT 
                        COUNT(*) as total,
                        AVG(confidence) as avg_confidence,
                        COUNT(CASE WHEN confidence >= 0.8 THEN 1 END) as high_confidence,
                        COUNT(CASE WHEN confidence >= 0.5 AND confidence < 0.8 THEN 1 END) as medium_confidence,
                        COUNT(CASE WHEN confidence < 0.5 THEN 1 END) as low_confidence
                    FROM stm_entries
                """)
                row = cursor.fetchone()
                if row:
                    stats['stm'] = {
                        'total': row[0],
                        'average_confidence': round(row[1] or 0.5, 3),
                        'high_confidence': row[2],
                        'medium_confidence': row[3], 
                        'low_confidence': row[4]
                    }
                
                # Similar for embeddings and atoms
                for table, key in [("embeddings", "embeddings"), ("atoms", "atoms")]:
                    try:
                        cursor = conn.execute(f"""
                            SELECT 
                                COUNT(*) as total,
                                AVG(confidence) as avg_confidence,
                                COUNT(CASE WHEN confidence >= 0.8 THEN 1 END) as high_confidence,
                                COUNT(CASE WHEN confidence >= 0.5 AND confidence < 0.8 THEN 1 END) as medium_confidence,
                                COUNT(CASE WHEN confidence < 0.5 THEN 1 END) as low_confidence
                            FROM {table}
                        """)
                        row = cursor.fetchone()
                        if row:
                            stats[key] = {
                                'total': row[0],
                                'average_confidence': round(row[1] or 0.5, 3),
                                'high_confidence': row[2],
                                'medium_confidence': row[3],
                                'low_confidence': row[4]
                            }
                    except sqlite3.OperationalError:
                        # Table might not exist or have confidence column
                        stats[key] = {'total': 0, 'average_confidence': 0.0, 'high_confidence': 0, 'medium_confidence': 0, 'low_confidence': 0}
                
                return stats
                
        except Exception as e:
            logger.error(f"Error getting confidence stats: {e}")
            return {}


if __name__ == "__main__":
    # CLI interface for testing
    import sys
    
    if len(sys.argv) < 3:
        print("Usage: python confidence_engine.py <db_path> <command>")
        print("Commands: stats, retroactive_score")
        sys.exit(1)
        
    db_path = sys.argv[1]
    command = sys.argv[2]
    
    engine = ConfidenceEngine(db_path)
    
    if command == "stats":
        stats = engine.get_confidence_stats()
        print(json.dumps(stats, indent=2))
        
    elif command == "retroactive_score":
        def progress_callback(memory_type: str, processed: int, total: int):
            print(f"{memory_type}: {processed}/{total} ({processed/total*100:.1f}%)")
            
        results = engine.apply_retroactive_scoring(progress_callback=progress_callback)
        print(json.dumps(results, indent=2))
        
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)