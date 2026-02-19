/**
 * Real-Time Learning — Correction Scanner
 * Cortex v2.6.0 (task-011)
 *
 * Scans session messages for correction signals within a configurable window
 * after tool calls. Filters out false positives from code blocks and quotes.
 */

import type { AsyncQueue } from "../async-queue.js";
import type { DetectionPayload, RealtimeLearningConfig } from "../types.js";

interface ToolCallRecord {
  toolName: string;
  toolCallId?: string;
  sessionId?: string;
  input?: string;
  output?: string;
  timestamp: number;
}

export class CorrectionScanner {
  private queue: AsyncQueue<DetectionPayload>;
  private config: RealtimeLearningConfig;
  private recentToolCalls: ToolCallRecord[] = [];
  private logger?: { debug?: (msg: string) => void };

  constructor(
    queue: AsyncQueue<DetectionPayload>,
    config: RealtimeLearningConfig,
    logger?: { debug?: (msg: string) => void },
  ) {
    this.queue = queue;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Record a tool call for the sliding window.
   */
  recordToolCall(record: Omit<ToolCallRecord, "timestamp">): void {
    this.recentToolCalls.push({ ...record, timestamp: Date.now() });
    // Prune expired entries
    const cutoff = Date.now() - this.config.correction_scan_window_ms;
    this.recentToolCalls = this.recentToolCalls.filter((r) => r.timestamp > cutoff);
  }

  /**
   * Scan a user message for correction signals. Call this on every user message.
   */
  onUserMessage(message: string, sessionId?: string): void {
    if (this.recentToolCalls.length === 0) return;

    const cleanedMessage = this.stripCodeBlocksAndQuotes(message);
    const lowerMessage = cleanedMessage.toLowerCase();

    const matchedKeyword = this.config.correction_keywords.find((kw) =>
      lowerMessage.includes(kw.toLowerCase()),
    );

    if (!matchedKeyword) return;

    // Find the most recent tool call within the window
    const cutoff = Date.now() - this.config.correction_scan_window_ms;
    const recentCall = this.recentToolCalls
      .filter((r) => r.timestamp > cutoff)
      .sort((a, b) => b.timestamp - a.timestamp)[0];

    if (!recentCall) return;

    this.logger?.debug?.(
      `[CorrectionScanner] Correction detected: "${matchedKeyword}" → tool ${recentCall.toolName}`,
    );

    this.queue.enqueue({
      type: "CORRECT",
      tier: 2,
      source: `user_correction:${matchedKeyword}`,
      context: {
        session_id: sessionId ?? recentCall.sessionId,
        tool_call_id: recentCall.toolCallId,
        tool_name: recentCall.toolName,
        matched_keyword: matchedKeyword,
        time_since_tool_ms: Date.now() - recentCall.timestamp,
      },
      raw_input: recentCall.input,
      failure_desc: `User correction after ${recentCall.toolName}: "${cleanedMessage.substring(0, 200)}"`,
    });
  }

  /**
   * Strip code blocks (``` ... ```) and quoted lines (> ...) to reduce false positives.
   */
  private stripCodeBlocksAndQuotes(text: string): string {
    // Remove fenced code blocks
    let cleaned = text.replace(/```[\s\S]*?```/g, "");
    // Remove inline code
    cleaned = cleaned.replace(/`[^`]+`/g, "");
    // Remove quoted lines
    cleaned = cleaned
      .split("\n")
      .filter((line) => !line.trimStart().startsWith(">"))
      .join("\n");
    return cleaned;
  }
}
