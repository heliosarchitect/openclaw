import { describe, expect, it } from "vitest";
import {
  buildProposal,
  buildSignaturePayload,
  computeSignature,
  extractCommands,
  normalizeCommand,
  renderProposalMarkdown,
} from "../auto-sop-generator.js";

describe("auto sop generator", () => {
  it("extracts and normalizes shell commands from markdown", () => {
    const md = [
      "# Build",
      "```bash",
      "$ cd /home/bonsaihorn/Projects/helios/extensions/cortex",
      "pnpm tsc --noEmit",
      "```",
      "npm test",
    ].join("\n");

    const commands = extractCommands(md);
    expect(commands).toEqual([
      "cd ~/Projects/helios/extensions/cortex",
      "pnpm tsc --noEmit",
      "npm test",
    ]);
  });

  it("computes stable signature", () => {
    const payload = buildSignaturePayload({
      stage: "build",
      commands: ["pnpm test", "pnpm tsc --noEmit"],
      invariantPaths: ["pipeline/state.json", "pipeline/task-041/build.md"],
    });

    const a = computeSignature(payload);
    const b = computeSignature(payload);
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it("builds recommendation-only proposal with governance flags", () => {
    const proposal = buildProposal({
      signaturePayload: buildSignaturePayload({
        stage: "build",
        commands: ["pnpm tsc --noEmit"],
        invariantPaths: ["pipeline/state.json"],
      }),
      title: "SOP proposal: Build validation",
      evidence: [
        {
          source_kind: "pipeline_artifact",
          task_id: "task-041-auto-sop-generation-041",
          stage: "build",
          artifact_path: "pipeline/task-041-auto-sop-generation-041/build.md",
        },
      ],
    });

    expect(proposal.mode).toBe("recommendation_only");
    expect(proposal.requires_human_validation).toBe(true);
    expect(proposal.confidence.evidence_count).toBe(1);

    const markdown = renderProposalMarkdown(proposal);
    expect(markdown).toContain("recommendation_only=true");
    expect(markdown).toContain("requires_human_validation=true");
  });

  it("normalizes volatile values in command strings", () => {
    const out = normalizeCommand(
      "$ node script.js --commit abcdef1234 --time 2026-02-24T12:00:00Z --path /home/alice/tmp",
    );
    expect(out).toContain("<sha>");
    expect(out).toContain("<time>");
    expect(out).toContain("~/tmp");
  });
});
