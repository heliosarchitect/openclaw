/**
 * Importance Archiver — downgrades source memories after successful compression.
 *
 * Sets importance to 0.5 and marks archived_by with cluster ID.
 * On any failure, attempts rollback by deleting the compressed memory.
 */
import type { CortexBridge } from "../cortex-bridge.js";

export async function archiveSourceMemories(
  bridge: CortexBridge,
  memberIds: string[],
  clusterId: string,
  compressedMemoryId: string,
): Promise<void> {
  const archived: string[] = [];

  try {
    for (const mid of memberIds) {
      await bridge.runSQL(`UPDATE stm SET importance = 0.5, archived_by = ? WHERE id = ?`, [
        clusterId,
        mid,
      ]);
      archived.push(mid);
    }
  } catch (err) {
    // Rollback: restore archived memories to their previous state
    for (const mid of archived) {
      try {
        await bridge.runSQL(`UPDATE stm SET importance = 1.0, archived_by = NULL WHERE id = ?`, [
          mid,
        ]);
      } catch {
        // Best effort rollback
      }
    }
    // Delete the compressed memory
    try {
      await bridge.runSQL(`DELETE FROM stm WHERE id = ?`, [compressedMemoryId]);
    } catch {
      // Best effort
    }
    throw err;
  }
}
