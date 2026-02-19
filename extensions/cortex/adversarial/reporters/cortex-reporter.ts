/**
 * Cortex Reporter — Stores adversarial test summary in Cortex memory.
 */

import type { ASTRunResult, CortexMock } from "../types.js";

export async function storeCortexSummary(
  result: ASTRunResult,
  cortex: CortexMock,
): Promise<string> {
  const failedList = result.failed_tests
    .map((t) => `  - ${t.id}: ${t.description} [${t.severity}]`)
    .join("\n");

  const summary = [
    `AST Run ${result.run_id} — ${result.overall_verdict}`,
    `${result.passed}/${result.total} passed, ${result.failed} failed, ${result.errors} errors`,
    `Duration: ${result.duration_ms}ms`,
    result.failed_tests.length > 0 ? `\nFailed:\n${failedList}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const importance =
    result.overall_verdict === "FAIL" ? 3.0 : result.overall_verdict === "PARTIAL" ? 2.0 : 1.0;

  return cortex.add(summary, {
    importance,
    categories: ["security", "infrastructure"],
  });
}
