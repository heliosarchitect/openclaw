/**
 * Confidence Decay Engine — Cross-Session State Preservation
 * Cortex v2.0.0
 *
 * Pure function: computes decayed confidence based on elapsed time.
 * Used only for filtering during session restoration — never persisted.
 */

/**
 * Apply time-based decay to a confidence score.
 *
 * @param originalConfidence - Original confidence (0-3 scale)
 * @param hoursElapsed - Hours since the memory was created/updated
 * @param minFloor - Minimum decay factor (default 0.3)
 * @returns Decayed confidence value
 *
 * Formula: confidence * max(minFloor, 1.0 - (hours / 168) * 0.4)
 * At 168h (7 days): decay factor = 0.6 → effective = original * 0.6
 * Floor prevents complete decay of important memories.
 */
export function applyDecay(
  originalConfidence: number,
  hoursElapsed: number,
  minFloor: number = 0.3,
): number {
  const decayFactor = Math.max(minFloor, 1.0 - (hoursElapsed / 168) * 0.4);
  return originalConfidence * decayFactor;
}
