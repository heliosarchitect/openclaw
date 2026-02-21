# Design — task-021-shared-cortex-expansion-021

## Summary

This design hardens **OpenAI-first model routing** for the Shared Cortex runtime by making selection + fallback **deterministic, policy-enforced, and observable** under constrained host environments.

Primary goals:

- Enforce OpenAI-first defaults everywhere sub-agent/model routing occurs
- Emit **machine-parseable fallback reason codes** for every transition
- Make hook / SOP execution assumptions portable (`python3`, `grep` fallback when `rg` is missing)
- Record telemetry that explicitly distinguishes **subscription** vs **api_key** routing

## Design Targets

### A) Model Policy Enforcement (Runtime)

**Problem:** `shared-cortex/model-policy-resolver.ts` defines policy, but runtime call sites can still drift (ad-hoc model strings, inconsistent fallbacks, missing reason codes).

**Design:** Introduce a single “routing boundary” wrapper that all model-bearing actions go through.

#### A1. Central entrypoint: `SharedModelRouter`

A small runtime utility that:

1. Resolves model via `resolveModel()`
2. Executes the underlying action (tool call / sub-agent spawn / provider call)
3. Classifies failures → standardized reason codes
4. Retries with deterministic fallback chain
5. Emits structured telemetry

**Pseudo-interface**

```ts
interface SharedModelRouterInput {
  taskId: string;
  taskType: "coding" | "orchestration" | "analysis" | "general";
  userOverrideModel?: string; // only if explicitly set by user
  taskPolicyModel?: string; // optional per-task policy
  routeType: "subscription" | "api_key";
  attemptBudget?: number; // default = 1 + fallbacks
}

interface SharedModelRouterDeps {
  runWithModel: (model: string) => Promise<{ tokensIn: number; tokensOut: number }>;
  nowIso: () => string;
  emitTelemetry: (t: RunTelemetry) => void;
  logger?: { info: Function; warn: Function; error: Function };
}
```

#### A2. Deterministic fallback order

- Primary: `openai-codex/gpt-5.3-codex`
- Fallback 1: `openai/gpt-5.2`
- Fallback 2: `openai/gpt-5o`

**Determinism rules**

- Same `taskType + taskPolicyModel + userOverrideModel + attemptedModels + failureReason` must produce the same result.
- No randomization, no “best available” probing.
- Fallback chain exhaustion returns the final fallback model (consistent with current resolver behavior).

#### A3. Standard failure → reason-code mapping

Reason codes must be **finite**, **stable**, and **parseable**.

**Required reason codes (v1)**

- `timeout`
- `provider_5xx`
- `capacity`
- `policy_override`
- `none`

**Mapping strategy**

- If runtime detects explicit policy override (e.g., user override differs from system default) → `policy_override`
- If error matches timeouts / aborts → `timeout`
- If provider error is HTTP 5xx / transient gateway → `provider_5xx`
- Otherwise for known “model unavailable / overloaded / rate-ish” cases → `capacity`
- Unknown errors should still map to one of the above (default to `capacity`) but must include a non-secret diagnostic `error_class` field in telemetry (see section C)

### B) Portability Hardening for Hooks & SOP Tooling

**Problem:** Some host environments lack `python` alias and/or `rg` (ripgrep). Failures show up as SOP violations or missing-binary failures.

**Design:** Normalize tool assumptions in all SOP-recommended commands + internal scripts.

#### B1. Python

- Standard command: `python3`
- Any sample commands or internal script invocations must prefer `python3`.
- If a script currently documents `python …`, update docs/SOPs to `python3 …`.

#### B2. Search tool fallback

- Preferred: `rg` when present (fast, ergonomic)
- Portable fallback: `grep -RIn` with sensible excludes

**Standard portable snippet**

```bash
if command -v rg >/dev/null 2>&1; then
  rg -n "PATTERN" path/
else
  grep -RIn --exclude-dir=node_modules --exclude='*.lock' -E "PATTERN" path/
fi
```

#### B3. SOP enhancer resilience

`hooks/sop-enhancer.ts` already tolerates missing SOP files (returns null when nonexistent). This task adds a design constraint:

- Missing SOP files must be treated as **non-fatal** (already true)
- Where SOPs are referenced in config (e.g. `python-env.ai.sop`), the system should either:
  - provide a minimal baseline SOP file in-repo, or
  - remove/replace references to non-existent SOPs.

(Implementation choice deferred to build stage; this design mandates **no hard dependency** on missing SOP content.)

### C) Telemetry & Observability

**Problem:** We have a telemetry schema (`shared-cortex/telemetry.ts`), but runtime must ensure every run records:

- selected model
- fallback transitions + reason
- route type separation

#### C1. Telemetry event: `RunTelemetry` (append-only)

Use the existing `RunTelemetry` structure, with additional optional fields for diagnostics (non-secret):

- `error_class?: string` (e.g. `TimeoutError`, `Provider5xx`, `Unknown`)
- `attempt_count?: number`

Rules:

- Never log keys, tokens, or raw provider payloads.
- Ensure `route_type` is always present and correct.

#### C2. Route type derivation

Telemetry must differentiate **subscription** vs **api_key**.

Design contract:

- `route_type` should be passed explicitly into the router from the calling context.
- If not available, default to `api_key` (safer accounting assumption) and add a policyAudit entry like `route_type_defaulted`.

(Implementation details depend on where OpenClaw/Helios stores routing metadata; build stage will wire actual detection.)

#### C3. Machine-parseable logging

In addition to human logs, emit single-line JSONL for fallback transitions.

Example line:

```json
{
  "event": "model_fallback",
  "task_id": "task-021...",
  "from": "openai-codex/gpt-5.3-codex",
  "to": "openai/gpt-5.2",
  "reason": "timeout",
  "route_type": "api_key"
}
```

### D) Rollout Plan

1. **Build stage:** Implement `SharedModelRouter` and replace ad-hoc model selection in shared-cortex call sites.
2. Add reason-code classification helpers + tests for mapping.
3. Add telemetry emission sinks (file/db) and daily aggregation reporting.
4. Update SOP examples/scripts to use `python3` and `grep` fallback.

### E) Risks & Mitigations

- **Risk:** Silent drift if call sites bypass router
  - **Mitigation:** single exported API + lint/test that denies direct provider calls without router wrapper
- **Risk:** Misclassified errors leading to misleading reason codes
  - **Mitigation:** keep small reason-code set; include `error_class` to preserve diagnostics
- **Risk:** Incomplete route_type separation
  - **Mitigation:** require explicit `route_type` parameter at routing boundary; default conservatively to `api_key`

## Definition of Done (Design)

- Design artifact describes runtime enforcement mechanism, reason-code contract, portability rules, and telemetry contract.
- Pipeline state updated to mark `design` complete and advance to `document`.
