/**
 * AST Runner — Adversarial Self-Testing Framework
 * Discovers and executes all adversarial test suites.
 *
 * Usage:
 *   npx tsx extensions/cortex/adversarial/runner.ts [--no-cortex] [--json-only] [--critical-only]
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdversarialTest,
  ASTRunResult,
  AttackCategory,
  CategoryResult,
  TestResult,
} from "./types.js";
import { createAdversarialContext } from "./context.js";
import { storeCortexSummary } from "./reporters/cortex-reporter.js";
import { writeJsonReport, writeLatestReport } from "./reporters/json-reporter.js";
import { memoryPoisoningSuite } from "./suites/memory-poisoning.test.js";
import { pipelineCorruptionSuite } from "./suites/pipeline-corruption.test.js";
// Import suites
import { promptInjectionSuite } from "./suites/prompt-injection.test.js";
import { synapseAdversarialSuite } from "./suites/synapse-adversarial.test.js";
import { toolFaultsSuite } from "./suites/tool-faults.test.js";

const ALL_SUITES: AdversarialTest[] = [
  ...promptInjectionSuite,
  ...memoryPoisoningSuite,
  ...toolFaultsSuite,
  ...pipelineCorruptionSuite,
  ...synapseAdversarialSuite,
];

interface RunOptions {
  criticalOnly?: boolean;
  noCortex?: boolean;
  jsonOnly?: boolean;
  outputDir?: string;
}

async function runTest(test: AdversarialTest): Promise<TestResult> {
  const start = Date.now();
  const ctx = await createAdversarialContext();

  try {
    const attackResult = await test.attack(ctx);
    const outcome = test.assert(attackResult);

    return {
      id: test.id,
      category: test.category,
      severity: test.severity,
      description: test.description,
      outcome,
      duration_ms: Date.now() - start,
      attack_result: attackResult,
    };
  } catch (err) {
    return {
      id: test.id,
      category: test.category,
      severity: test.severity,
      description: test.description,
      outcome: "error",
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await ctx.sandbox.cleanup();
  }
}

export async function runAdversarialTests(opts: RunOptions = {}): Promise<ASTRunResult> {
  const runId = randomUUID().slice(0, 8);
  const start = Date.now();

  let tests = ALL_SUITES;
  if (opts.criticalOnly) {
    tests = tests.filter((t) => t.severity === "critical");
  }

  console.log(`\n🛡️  AST Runner — ${tests.length} tests (run: ${runId})\n`);

  const results: TestResult[] = [];

  for (const test of tests) {
    const result = await runTest(test);
    results.push(result);

    const icon =
      result.outcome === "pass"
        ? "✅"
        : result.outcome === "fail"
          ? "❌"
          : result.outcome === "skip"
            ? "⏭️"
            : "💥";
    console.log(`  ${icon} ${result.id} — ${result.description} (${result.duration_ms}ms)`);
    if (result.error) {
      console.log(`     Error: ${result.error}`);
    }
  }

  // Aggregate by category
  const byCategory: Partial<Record<AttackCategory, CategoryResult>> = {};
  for (const r of results) {
    if (!byCategory[r.category]) {
      byCategory[r.category] = { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, tests: [] };
    }
    const cat = byCategory[r.category]!;
    cat.total++;
    cat.tests.push(r);
    if (r.outcome === "pass") cat.passed++;
    else if (r.outcome === "fail") cat.failed++;
    else if (r.outcome === "skip") cat.skipped++;
    else cat.errors++;
  }

  const passed = results.filter((r) => r.outcome === "pass").length;
  const failed = results.filter((r) => r.outcome === "fail").length;
  const skipped = results.filter((r) => r.outcome === "skip").length;
  const errors = results.filter((r) => r.outcome === "error").length;
  const failedTests = results.filter((r) => r.outcome === "fail" || r.outcome === "error");

  const verdict: ASTRunResult["overall_verdict"] =
    failed === 0 && errors === 0 ? "PASS" : failed + errors === results.length ? "FAIL" : "PARTIAL";

  const runResult: ASTRunResult = {
    run_id: runId,
    timestamp: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    skipped,
    errors,
    by_category: byCategory,
    failed_tests: failedTests,
    overall_verdict: verdict,
    duration_ms: Date.now() - start,
  };

  // Summary
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  Verdict: ${verdict}  |  ✅ ${passed}  ❌ ${failed}  💥 ${errors}  ⏭️ ${skipped}`);
  console.log(`  Duration: ${runResult.duration_ms}ms`);
  console.log(`${"─".repeat(50)}\n`);

  // Write reports
  const outputDir = opts.outputDir ?? dirname(fileURLToPath(import.meta.url));
  await mkdir(outputDir, { recursive: true });

  const jsonPath = await writeLatestReport(runResult, outputDir);
  console.log(`  📄 Report: ${jsonPath}`);

  if (!opts.noCortex) {
    const ctx = await createAdversarialContext();
    const memoryId = await storeCortexSummary(runResult, ctx.cortex);
    runResult.cortex_memory_id = memoryId;
    await ctx.sandbox.cleanup();
    console.log(`  🧠 Cortex: ${memoryId}`);
  }

  return runResult;
}

// CLI entry point
const args = process.argv.slice(2);
const cliOpts: RunOptions = {
  criticalOnly: args.includes("--critical-only"),
  noCortex: args.includes("--no-cortex"),
  jsonOnly: args.includes("--json-only"),
};

runAdversarialTests(cliOpts)
  .then((result) => {
    if (cliOpts.jsonOnly) {
      console.log(JSON.stringify(result));
    }
    process.exit(result.overall_verdict === "PASS" ? 0 : 1);
  })
  .catch((err) => {
    console.error("AST Runner failed:", err);
    process.exit(2);
  });
