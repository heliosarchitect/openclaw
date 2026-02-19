/**
 * Adversarial Context Factory
 * Creates sandboxed test environments for adversarial testing.
 *
 * Each test gets an isolated context with:
 * - In-memory cortex mock (no real brain.db access)
 * - In-memory synapse mock
 * - Temp directory for file operations
 * - Tool call recording
 * - Fault injection capabilities
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdversarialContext,
  CortexMock,
  SandboxEnv,
  STMEntry,
  SynapseMock,
  SynapseMessage,
  ToolCallRecord,
} from "./types.js";
import { createFaultInjector } from "./fault-injector.js";

/**
 * Create an in-memory Cortex mock with basic operations.
 * Memories are stored in a Map — no disk access.
 */
function createCortexMock(): CortexMock {
  const memories = new Map<string, STMEntry>();

  return {
    async add(content, opts) {
      const id = randomUUID();
      const entry: STMEntry = {
        id,
        content,
        importance: opts?.importance ?? 1.0,
        categories: opts?.categories ?? ["general"],
        timestamp: new Date().toISOString(),
        confidence: 1.0,
      };
      memories.set(id, entry);
      return id;
    },

    async stm(opts) {
      let entries = Array.from(memories.values());
      if (opts?.category) {
        entries = entries.filter((e) => e.categories.includes(opts.category!));
      }
      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return entries.slice(0, opts?.limit ?? 10);
    },

    async stats() {
      const cats: Record<string, number> = {};
      for (const entry of memories.values()) {
        for (const cat of entry.categories) {
          cats[cat] = (cats[cat] ?? 0) + 1;
        }
      }
      return { total: memories.size, stm_count: memories.size, categories: cats };
    },

    async search(query, opts) {
      // Simple substring match for testing
      const matches = Array.from(memories.values()).filter((e) =>
        e.content.toLowerCase().includes(query.toLowerCase()),
      );
      return matches.slice(0, opts?.limit ?? 10);
    },

    async dedupe(action) {
      if (action !== "report") return { duplicates: 0, groups: [] };
      const seen = new Map<string, STMEntry[]>();
      for (const entry of memories.values()) {
        const key = entry.content.substring(0, 50);
        const group = seen.get(key) ?? [];
        group.push(entry);
        seen.set(key, group);
      }
      const dupes = Array.from(seen.values()).filter((g) => g.length > 1);
      return { duplicates: dupes.length, groups: dupes };
    },
  };
}

/**
 * Create an in-memory Synapse mock.
 */
function createSynapseMock(): SynapseMock {
  const messages: SynapseMessage[] = [];

  return {
    async send(to, body, opts) {
      const id = randomUUID();
      messages.push({
        id,
        from: "ast-runner",
        to,
        body,
        priority: opts?.priority ?? "info",
        timestamp: new Date().toISOString(),
      });
      return id;
    },

    async inbox(opts) {
      return opts?.include_read ? [...messages] : messages.slice(-10);
    },

    async history(opts) {
      return messages.slice(-(opts?.limit ?? 20));
    },
  };
}

/**
 * Create a sandboxed environment with temp directories.
 */
async function createSandbox(runId: string): Promise<SandboxEnv> {
  const tmpDir = await mkdtemp(join(tmpdir(), `ast-${runId}-`));
  const dbPath = join(tmpDir, "brain.db");
  const stateJsonPath = join(tmpDir, "state.json");

  // Create initial empty state.json
  await writeFile(
    stateJsonPath,
    JSON.stringify({ active_tasks: [], completed_tasks: [], status: "test" }),
  );

  return {
    tmpDir,
    dbPath,
    stateJsonPath,
    async cleanup() {
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a fresh AdversarialContext for a test run.
 */
export async function createAdversarialContext(runId?: string): Promise<AdversarialContext> {
  const id = runId ?? randomUUID().slice(0, 8);
  const sandbox = await createSandbox(id);
  const toolCalls: ToolCallRecord[] = [];
  const logs: string[] = [];

  return {
    cortex: createCortexMock(),
    synapse: createSynapseMock(),
    faultInjector: createFaultInjector(),
    sandbox,
    toolCalls,
    logs,
    log(msg: string) {
      logs.push(`[${new Date().toISOString()}] ${msg}`);
    },
    recordToolCall(record: ToolCallRecord) {
      toolCalls.push(record);
    },
  };
}
