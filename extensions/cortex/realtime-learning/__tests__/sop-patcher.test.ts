/**
 * Real-Time Learning — SOP Patcher Tests
 * Task-011: test stage
 */

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FailureEvent, RealtimeLearningConfig, RealtimeLearningDeps } from "../types.js";
import { SOPPatcher } from "../propagation/sop-patcher.js";
import { DEFAULT_REALTIME_LEARNING_CONFIG } from "../types.js";

function makeFailure(overrides: Partial<FailureEvent> = {}): FailureEvent {
  return {
    id: "fail-test-001",
    detected_at: new Date().toISOString(),
    type: "TOOL_ERR",
    tier: 1,
    source: "exec",
    context: {},
    failure_desc: "ENOENT: /usr/local/bin/missing-tool",
    root_cause: "wrong_path",
    propagation_status: "pending",
    recurrence_count: 0,
    ...overrides,
  };
}

describe("SOPPatcher", () => {
  let tmpDir: string;
  let sopDir: string;
  let patcher: SOPPatcher;
  let deps: RealtimeLearningDeps;
  let config: RealtimeLearningConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sop-patcher-test-"));
    sopDir = join(tmpDir, "sop");
    mkdirSync(sopDir, { recursive: true });

    deps = {
      db: {
        run: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue([]),
      },
      sendSynapse: vi.fn().mockResolvedValue("msg-456"),
      writeMetric: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      repoRoot: tmpDir,
    };

    config = { ...DEFAULT_REALTIME_LEARNING_CONFIG, sop_directory: sopDir };
    patcher = new SOPPatcher(config, deps);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns no_sop_found when SOP directory does not exist", async () => {
    config.sop_directory = "/nonexistent/path";
    patcher = new SOPPatcher(config, deps);
    const result = await patcher.patch(makeFailure());
    expect(result.type).toBe("no_sop_found");
    expect(result.status).toBe("skipped");
  });

  it("creates corrections.md fallback and patches it for wrong_path", async () => {
    const result = await patcher.patch(makeFailure());
    // Should have created corrections.md and patched it
    expect(result.status).not.toBe("skipped");
    const correctionsPath = join(sopDir, "corrections.md");
    expect(existsSync(correctionsPath)).toBe(true);
    const content = readFileSync(correctionsPath, "utf8");
    expect(content).toContain("Path Correction");
    expect(content).toContain("ENOENT");
  });

  it("patches existing SOP file when root cause maps to known file", async () => {
    const filePaths = join(sopDir, "file-paths.md");
    writeFileSync(filePaths, "# File Paths SOP\n\nExisting content.\n", "utf8");

    const result = await patcher.patch(makeFailure());
    expect(result.target_file).toBe(filePaths);
    const content = readFileSync(filePaths, "utf8");
    expect(content).toContain("Path Correction");
    expect(content).toContain("Existing content");
  });

  it("uses context sop_file when provided", async () => {
    const customSop = join(sopDir, "custom.md");
    writeFileSync(customSop, "# Custom SOP\n", "utf8");

    const failure = makeFailure({ context: { sop_file: customSop } });
    const result = await patcher.patch(failure);
    expect(result.target_file).toBe(customSop);
  });

  it("generates trust boundary entry for trust_boundary_crossed", async () => {
    const trustSop = join(sopDir, "trust-boundaries.md");
    writeFileSync(trustSop, "# Trust Boundaries\n", "utf8");

    const failure = makeFailure({
      root_cause: "trust_boundary_crossed",
      tier: 3,
      type: "TRUST_DEM",
      failure_desc: "Overwrote config without approval",
    });

    const result = await patcher.patch(failure);
    expect(result.status).toBe("previewed");
    expect(deps.sendSynapse).toHaveBeenCalled();
    const content = readFileSync(trustSop, "utf8");
    expect(content).toContain("Trust Boundary");
    expect(content).toContain("Overwrote config");
  });

  it("sends Synapse preview for Tier 3 failures", async () => {
    const failure = makeFailure({
      tier: 3,
      root_cause: "trust_boundary_crossed",
      type: "TRUST_DEM",
    });
    const trustSop = join(sopDir, "trust-boundaries.md");
    writeFileSync(trustSop, "# Trust\n", "utf8");

    const result = await patcher.patch(failure);
    expect(result.status).toBe("previewed");
    expect(result.synapse_msg_id).toBe("msg-456");
    expect(deps.sendSynapse).toHaveBeenCalledWith(
      expect.stringContaining("SOP Patch Preview"),
      expect.any(String),
      "action",
      expect.any(String),
    );
  });

  it("generates missing_binary patch entry", async () => {
    const toolSop = join(sopDir, "tool-binaries.md");
    writeFileSync(toolSop, "# Tool Binaries\n", "utf8");

    const failure = makeFailure({
      root_cause: "missing_binary",
      failure_desc: "command not found: rg",
    });
    await patcher.patch(failure);
    const content = readFileSync(toolSop, "utf8");
    expect(content).toContain("Missing Binary");
    expect(content).toContain("rg");
  });

  it("generates stale_sop patch entry", async () => {
    const maintSop = join(sopDir, "sop-maintenance.md");
    writeFileSync(maintSop, "# SOP Maintenance\n", "utf8");

    const failure = makeFailure({
      type: "SOP_VIOL",
      tier: 2,
      root_cause: "stale_sop",
      context: { rule_id: "rule-42" },
      failure_desc: "SOP rule is outdated",
    });
    await patcher.patch(failure);
    const content = readFileSync(maintSop, "utf8");
    expect(content).toContain("SOP Updated");
    expect(content).toContain("rule-42");
  });
});
