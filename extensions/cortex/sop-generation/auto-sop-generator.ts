import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export type EvidenceSourceKind = "pipeline_artifact" | "pipeline_state" | "stage_log";

export interface EvidenceRecord {
  source_kind: EvidenceSourceKind;
  task_id?: string;
  stage?: string;
  artifact_path?: string;
  excerpt_hash?: string;
  commands?: string[];
  env?: {
    cwd?: string;
    node?: string | null;
    pnpm?: string | null;
  };
}

export interface SignaturePayload {
  scope: "cortex-pipeline";
  stage: string;
  procedure_commands: string[];
  invariants: string[];
}

export interface ProposalConfidence {
  evidence_count: number;
  threshold: number;
  notes: string;
}

export interface ProposalJson {
  schema_version: "1.0";
  signature: string;
  signature_payload: SignaturePayload;
  title: string;
  mode: "recommendation_only";
  requires_human_validation: true;
  created_at: string;
  updated_at: string;
  confidence: ProposalConfidence;
  preconditions: {
    repo: string;
    tools: string[];
    permissions: string[];
  };
  procedure: {
    steps: Array<{ kind: "command" | "note"; text: string; expect?: string }>;
  };
  verification: {
    checks: Array<{ kind: "command" | "note"; text: string; expect: string }>;
  };
  failure_modes: Array<{
    symptom: string;
    diagnosis: string;
    remediation: string;
    rollback: string;
  }>;
  evidence: EvidenceRecord[];
}

export function extractCommands(markdown: string): string[] {
  const commands: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let inShellFence = false;

  for (const line of lines) {
    const fenceMatch = line.match(/^```\s*(\w+)?\s*$/);
    if (fenceMatch) {
      const lang = (fenceMatch[1] ?? "").toLowerCase();
      if (!inShellFence) {
        inShellFence = ["bash", "sh", "shell", "zsh"].includes(lang);
      } else {
        inShellFence = false;
      }
      continue;
    }

    if (!inShellFence) {
      const trimmed = line.trim();
      if (!isLikelyCommand(trimmed)) continue;
      commands.push(normalizeCommand(trimmed));
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    commands.push(normalizeCommand(trimmed));
  }

  return dedupe(commands);
}

function isLikelyCommand(line: string): boolean {
  return /^(\$\s*)?(cd\s+|pnpm\s+|npm\s+|node\s+|tsc\s+|pytest\s+|\.\/)/i.test(line);
}

export function normalizeCommand(line: string): string {
  let out = line.trim().replace(/^\$\s*/, "");
  out = out.replace(/\s+/g, " ");
  out = out.replace(/\b[0-9a-f]{7,40}\b/gi, "<sha>");
  out = out.replace(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g,
    "<time>",
  );
  out = out.replace(/\/home\/[^/]+\//g, "~/");
  return out;
}

export function computeSignature(payload: SignaturePayload): string {
  const stable = stableJson(payload);
  return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function escapeInlineCode(text: string): string {
  // We render many fields inside single-backtick spans.
  // Escape backticks so untrusted content cannot break formatting.
  return text.replace(/`/g, "\\`");
}

function safeOneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

export function buildSignaturePayload(params: {
  stage: string;
  commands: string[];
  invariantPaths: string[];
}): SignaturePayload {
  return {
    scope: "cortex-pipeline",
    stage: params.stage,
    procedure_commands: params.commands,
    invariants: [...params.invariantPaths].sort(),
  };
}

export function buildProposal(params: {
  signaturePayload: SignaturePayload;
  title: string;
  evidence: EvidenceRecord[];
  threshold?: number;
}): ProposalJson {
  const now = new Date().toISOString();
  const signature = computeSignature(params.signaturePayload);
  const threshold = params.threshold ?? 3;

  return {
    schema_version: "1.0",
    signature,
    signature_payload: params.signaturePayload,
    title: params.title,
    mode: "recommendation_only",
    requires_human_validation: true,
    created_at: now,
    updated_at: now,
    confidence: {
      evidence_count: params.evidence.length,
      threshold,
      notes: "Evidence-weighted; deterministic given same inputs",
    },
    preconditions: {
      repo: "~/Projects/helios/extensions/cortex",
      tools: ["node", "pnpm"],
      permissions: [],
    },
    procedure: {
      steps: params.signaturePayload.procedure_commands.map((text) => ({
        kind: "command" as const,
        text,
      })),
    },
    verification: {
      checks: [
        {
          kind: "command",
          text: "pnpm tsc --noEmit",
          expect: "exit 0",
        },
      ],
    },
    failure_modes: [
      {
        symptom: "TypeScript compile fails",
        diagnosis: "API mismatch or incomplete implementation",
        remediation: "Fix reported compiler errors and rerun checks",
        rollback: "Revert to previous passing commit",
      },
    ],
    evidence: params.evidence,
  };
}

export function renderProposalMarkdown(proposal: ProposalJson): string {
  const lines: string[] = [];
  lines.push(`# ${proposal.title}`);
  lines.push("");
  lines.push("> ⚠️ recommendation_only=true");
  lines.push("> requires_human_validation=true");
  lines.push("");
  lines.push("## Preconditions");
  lines.push(`- Repo: ${proposal.preconditions.repo}`);
  lines.push(`- Tools: ${proposal.preconditions.tools.join(", ")}`);
  lines.push("");
  lines.push("## Procedure");
  for (const [idx, step] of proposal.procedure.steps.entries()) {
    lines.push(`${idx + 1}. \`${escapeInlineCode(safeOneLine(step.text))}\``);
  }
  lines.push("");
  lines.push("## Verification");
  for (const check of proposal.verification.checks) {
    lines.push(
      `- \`${escapeInlineCode(safeOneLine(check.text))}\` → ${escapeInlineCode(safeOneLine(check.expect))}`,
    );
  }
  lines.push("");
  lines.push("## Evidence");
  for (const evidence of proposal.evidence) {
    lines.push(
      `- ${escapeInlineCode(safeOneLine(evidence.task_id ?? "unknown task"))} / ${escapeInlineCode(safeOneLine(evidence.stage ?? "unknown stage"))} / ${escapeInlineCode(safeOneLine(evidence.artifact_path ?? "n/a"))}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeProposalArtifacts(params: {
  repoRoot: string;
  proposal: ProposalJson;
}): Promise<{ jsonPath: string; markdownPath: string }> {
  const dir = resolve(params.repoRoot, "sop-proposals", params.proposal.signature);
  await mkdir(dir, { recursive: true });

  const jsonPath = resolve(dir, "proposal.json");
  const markdownPath = resolve(dir, "proposal.md");

  await writeFile(jsonPath, `${JSON.stringify(params.proposal, null, 2)}\n`, "utf-8");
  await writeFile(markdownPath, `${renderProposalMarkdown(params.proposal)}\n`, "utf-8");

  return {
    jsonPath: relative(params.repoRoot, jsonPath),
    markdownPath: relative(params.repoRoot, markdownPath),
  };
}

export async function loadAndHashEvidenceArtifact(params: {
  repoRoot: string;
  artifactPath: string;
}): Promise<string> {
  const absRoot = resolve(params.repoRoot);
  const absPath = resolve(params.artifactPath);

  // Defensive: prevent accidental reads outside the repoRoot.
  const rel = relative(absRoot, absPath);
  if (!rel || rel.startsWith("..") || rel.includes(".." + "/") || rel.includes(".." + "\\")) {
    throw new Error(`Refusing to read evidence artifact outside repoRoot: ${params.artifactPath}`);
  }

  const content = await readFile(absPath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function taskIdFromArtifactPath(pathValue: string): string | undefined {
  const abs = resolve(pathValue);
  const parent = dirname(abs);
  const match = parent.match(/task-[^/]+$/);
  return match?.[0];
}
