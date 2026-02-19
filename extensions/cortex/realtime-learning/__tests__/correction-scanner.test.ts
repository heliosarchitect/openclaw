/**
 * Real-Time Learning — Correction Scanner Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { DetectionPayload, RealtimeLearningConfig } from "../types.js";
import { AsyncQueue } from "../async-queue.js";
import { CorrectionScanner } from "../detection/correction-scanner.js";
import { DEFAULT_REALTIME_LEARNING_CONFIG } from "../types.js";

describe("CorrectionScanner", () => {
  let queue: AsyncQueue<DetectionPayload>;
  let scanner: CorrectionScanner;
  let captured: DetectionPayload[];

  beforeEach(() => {
    captured = [];
    queue = new AsyncQueue<DetectionPayload>();
    queue.onDrain(async (item) => {
      captured.push(item);
    });
    scanner = new CorrectionScanner(queue, DEFAULT_REALTIME_LEARNING_CONFIG);
  });

  it("detects correction keyword after a tool call", async () => {
    scanner.recordToolCall({ toolName: "exec", toolCallId: "tc1" });
    scanner.onUserMessage("that's wrong, the path should be /opt/bin");

    // Let the async queue drain
    await new Promise((r) => setTimeout(r, 50));

    expect(captured.length).toBe(1);
    expect(captured[0].type).toBe("CORRECT");
    expect(captured[0].tier).toBe(2);
  });

  it("does not fire without a recent tool call", async () => {
    scanner.onUserMessage("that's wrong, the path should be /opt/bin");

    await new Promise((r) => setTimeout(r, 50));
    expect(captured.length).toBe(0);
  });

  it("does not fire for correction keywords inside code blocks", async () => {
    scanner.recordToolCall({ toolName: "exec", toolCallId: "tc2" });
    scanner.onUserMessage("```\nthat's wrong\n```");

    await new Promise((r) => setTimeout(r, 50));
    expect(captured.length).toBe(0);
  });

  it("does not fire for correction keywords in quotes", async () => {
    scanner.recordToolCall({ toolName: "exec", toolCallId: "tc3" });
    scanner.onUserMessage("> that's wrong\nOK looks good");

    await new Promise((r) => setTimeout(r, 50));
    expect(captured.length).toBe(0);
  });

  it("fires for multiple keywords", async () => {
    scanner.recordToolCall({ toolName: "write", toolCallId: "tc4" });
    scanner.onUserMessage("that's the wrong path");

    await new Promise((r) => setTimeout(r, 50));
    expect(captured.length).toBe(1);
    expect(captured[0].failure_desc).toContain("wrong path");
  });
});
