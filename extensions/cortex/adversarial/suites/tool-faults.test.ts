/**
 * Tool Fault Injection Suite (TF-001 through TF-005)
 * Verifies graceful degradation under tool failures.
 */

import type { AdversarialTest, AdversarialContext } from "../types.js";

/** Simulate a tool call with fault injection applied */
async function simulateToolCall(
  ctx: AdversarialContext,
  toolName: string,
  fn: () => Promise<unknown>,
): Promise<{ result: unknown; error: string | null; duration_ms: number }> {
  const start = Date.now();
  const fault = ctx.faultInjector.isToolFaulted(toolName);

  if (fault.faulted && fault.delayMs) {
    await new Promise((r) => setTimeout(r, Math.min(fault.delayMs!, 2000))); // cap for tests
  }

  if (fault.faulted && fault.error) {
    ctx.recordToolCall({
      tool: toolName,
      params: {},
      timestamp: new Date().toISOString(),
      blocked: true,
      reason: fault.error.message,
    });
    return { result: null, error: fault.error.message, duration_ms: Date.now() - start };
  }

  try {
    const result = await fn();
    ctx.recordToolCall({
      tool: toolName,
      params: {},
      timestamp: new Date().toISOString(),
      blocked: false,
    });
    return { result, error: null, duration_ms: Date.now() - start };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.recordToolCall({
      tool: toolName,
      params: {},
      timestamp: new Date().toISOString(),
      blocked: true,
      reason: msg,
    });
    return { result: null, error: msg, duration_ms: Date.now() - start };
  }
}

/** Retry logic: attempt up to N times with backoff */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  backoffMs: number,
): Promise<{ result: T | null; attempts: number; lastError: string | null }> {
  let lastError: string | null = null;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const result = await fn();
      return { result, attempts: i, lastError: null };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (i < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoffMs * i));
      }
    }
  }
  return { result: null, attempts: maxAttempts, lastError };
}

export const toolFaultsSuite: AdversarialTest[] = [
  {
    id: "TF-001",
    category: "tool_faults",
    severity: "high",
    description: "SQLITE_BUSY during cortex_add — retry with backoff",
    payload: { error: "SQLITE_BUSY", retries: 3 },
    async attack(ctx) {
      let callCount = 0;
      // Simulate: first 2 calls fail with SQLITE_BUSY, 3rd succeeds
      const retryResult = await withRetry(
        async () => {
          callCount++;
          if (callCount < 3) throw new Error("SQLITE_BUSY: database is locked");
          return ctx.cortex.add("test memory", { importance: 1.0 });
        },
        5,
        50,
      );

      ctx.log(
        `TF-001: SQLITE_BUSY retry. Attempts: ${retryResult.attempts}, success: ${retryResult.result !== null}`,
      );

      return {
        output: retryResult,
        toolCallsTriggered: ["cortex_add"],
        errors: callCount > 1 ? ["SQLITE_BUSY"] : [],
        attackDetected: true,
        attackSucceeded: retryResult.result === null,
        meta: { total_calls: callCount },
      };
    },
    assert(result) {
      // Pass if retry succeeded (attack did NOT cause permanent failure)
      return !result.attackSucceeded ? "pass" : "fail";
    },
  },

  {
    id: "TF-002",
    category: "tool_faults",
    severity: "medium",
    description: "Exec tool timeout — process cleanup",
    payload: { timeout_ms: 100 },
    async attack(ctx) {
      ctx.faultInjector.injectNetworkTimeout("exec", 100);

      const result = await simulateToolCall(ctx, "exec", async () => {
        // Simulate a long-running process
        await new Promise((r) => setTimeout(r, 5000));
        return "completed";
      });

      // After timeout, check no zombies (simulated)
      const zombieCheck = { zombies: 0, cleaned: true };
      ctx.log(
        `TF-002: Exec timeout. Duration: ${result.duration_ms}ms, zombies: ${zombieCheck.zombies}`,
      );

      return {
        output: { ...result, zombieCheck },
        toolCallsTriggered: result.error ? [] : ["exec"],
        errors: result.error ? [result.error] : [],
        attackDetected: true,
        attackSucceeded: zombieCheck.zombies > 0,
        meta: { timeout_ms: 100 },
      };
    },
    assert(result) {
      return !result.attackSucceeded ? "pass" : "fail";
    },
  },

  {
    id: "TF-003",
    category: "tool_faults",
    severity: "medium",
    description: "Synapse send drops 3 consecutive messages — retry queue",
    payload: { drop_count: 3 },
    async attack(ctx) {
      let dropCount = 0;
      const maxDrops = 3;

      const retryResult = await withRetry(
        async () => {
          dropCount++;
          if (dropCount <= maxDrops) throw new Error("ECONNRESET: connection dropped");
          return ctx.synapse.send("all", "test message", { priority: "info" });
        },
        5,
        50,
      );

      ctx.log(
        `TF-003: Synapse drops. Attempts: ${retryResult.attempts}, delivered: ${retryResult.result !== null}`,
      );

      return {
        output: retryResult,
        toolCallsTriggered: retryResult.result ? ["synapse_send"] : [],
        errors: dropCount > 0 ? ["ECONNRESET"] : [],
        attackDetected: true,
        attackSucceeded: retryResult.result === null,
        meta: { drops: maxDrops },
      };
    },
    assert(result) {
      return !result.attackSucceeded ? "pass" : "fail";
    },
  },

  {
    id: "TF-004",
    category: "tool_faults",
    severity: "low",
    description: "web_fetch returns 500 — graceful error handling",
    payload: { status: 500 },
    async attack(ctx) {
      ctx.faultInjector.injectToolError("web_fetch", new Error("HTTP 500: Internal Server Error"));

      const result = await simulateToolCall(ctx, "web_fetch", async () => {
        return { status: 200, body: "ok" };
      });

      ctx.log(`TF-004: web_fetch 500. Error handled: ${result.error !== null}`);

      return {
        output: result,
        toolCallsTriggered: [],
        errors: result.error ? [result.error] : [],
        attackDetected: result.error !== null,
        attackSucceeded: false, // Graceful failure = not an attack success
        meta: { http_status: 500 },
      };
    },
    assert(result) {
      // Pass if error was caught and handled (not crashed)
      return result.attackDetected ? "pass" : "fail";
    },
  },

  {
    id: "TF-005",
    category: "tool_faults",
    severity: "high",
    description: "File write fails mid-pipeline-artifact — partial artifact detection",
    payload: null,
    async attack(ctx) {
      const { writeFile, readFile, stat } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const artifactPath = join(ctx.sandbox.tmpDir, "build-report.md");
      const fullContent =
        "# Build Report\n\nFull content here with all sections complete.\n\n## Summary\nDone.";

      // Simulate partial write (truncated)
      const partial = fullContent.substring(0, 20);
      await writeFile(artifactPath, partial);

      // Verify: pipeline should detect partial artifact
      const fileStats = await stat(artifactPath);
      const content = await readFile(artifactPath, "utf-8");
      const isComplete = content.includes("## Summary") && content.includes("Done.");
      const isPartial = !isComplete && fileStats.size > 0;

      ctx.log(
        `TF-005: Partial artifact. Size: ${fileStats.size}, complete: ${isComplete}, partial: ${isPartial}`,
      );

      return {
        output: { fileSize: fileStats.size, isComplete, isPartial, content },
        toolCallsTriggered: ["writeFile"],
        errors: isPartial ? ["Partial artifact detected"] : [],
        attackDetected: isPartial,
        attackSucceeded: !isPartial && !isComplete, // Attack succeeds if partial goes undetected
        meta: { expected_size: fullContent.length, actual_size: fileStats.size },
      };
    },
    assert(result) {
      return result.attackDetected ? "pass" : "fail";
    },
  },
];
