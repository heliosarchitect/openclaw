/**
 * CortexMemory factory for tests
 */
import type { CortexMemory, STMItem } from "../../cortex-bridge.js";

let counter = 0;

export function createMemory(overrides?: Partial<CortexMemory>): CortexMemory {
  counter++;
  return {
    id: `test-mem-${counter}`,
    content: `Test memory content ${counter}`,
    source: "test",
    categories: ["general"],
    category: "general",
    timestamp: new Date().toISOString(),
    importance: 1.0,
    access_count: 0,
    ...overrides,
  };
}

export function createSTMItem(overrides?: Partial<STMItem>): STMItem {
  counter++;
  return {
    content: `STM item ${counter}`,
    timestamp: new Date().toISOString(),
    categories: ["general"],
    category: "general",
    importance: 1.0,
    access_count: 0,
    ...overrides,
  };
}
