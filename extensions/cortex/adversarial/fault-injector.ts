/**
 * Fault Injector — Controlled chaos for adversarial testing
 *
 * Intercepts tool calls and file operations to inject:
 * - Network timeouts
 * - Tool errors
 * - File corruption
 * - Message interception
 */

import { readFile, writeFile, truncate, unlink } from "node:fs/promises";
import type { FaultInjector, FileMutation, MessageHandler, SynapseMessage } from "./types.js";

interface ToolFault {
  error?: Error;
  delayMs?: number;
}

export function createFaultInjector(): FaultInjector {
  const toolFaults = new Map<string, ToolFault>();
  const messageInterceptors: Array<{ pattern: RegExp; handler: MessageHandler }> = [];

  return {
    injectNetworkTimeout(toolName: string, delayMs: number) {
      const existing = toolFaults.get(toolName) ?? {};
      existing.delayMs = delayMs;
      toolFaults.set(toolName, existing);
    },

    injectToolError(toolName: string, error: Error) {
      const existing = toolFaults.get(toolName) ?? {};
      existing.error = error;
      toolFaults.set(toolName, existing);
    },

    async corruptFile(path: string, mutation: FileMutation) {
      switch (mutation.kind) {
        case "truncate":
          await truncate(path, mutation.at);
          break;

        case "corrupt_json": {
          const raw = await readFile(path, "utf-8");
          const obj = JSON.parse(raw);
          obj[mutation.field] = mutation.value;
          await writeFile(path, JSON.stringify(obj));
          break;
        }

        case "inject_bytes": {
          const buf = await readFile(path);
          const result = Buffer.concat([
            buf.subarray(0, mutation.offset),
            mutation.bytes,
            buf.subarray(mutation.offset),
          ]);
          await writeFile(path, result);
          break;
        }

        case "delete":
          await unlink(path);
          break;
      }
    },

    interceptMessage(pattern: RegExp, handler: MessageHandler) {
      messageInterceptors.push({ pattern, handler });
    },

    isToolFaulted(toolName: string) {
      const fault = toolFaults.get(toolName);
      if (!fault) return { faulted: false };
      return { faulted: true, error: fault.error, delayMs: fault.delayMs };
    },

    reset() {
      toolFaults.clear();
      messageInterceptors.length = 0;
    },
  };
}

/**
 * Apply message interceptors to a synapse message.
 * Returns null if message should be dropped.
 */
export function applyMessageInterceptors(
  msg: SynapseMessage,
  interceptors: Array<{ pattern: RegExp; handler: MessageHandler }>,
): SynapseMessage | null {
  let current: SynapseMessage | null = msg;
  for (const { pattern, handler } of interceptors) {
    if (!current) break;
    if (pattern.test(current.body)) {
      current = handler(current);
    }
  }
  return current;
}
