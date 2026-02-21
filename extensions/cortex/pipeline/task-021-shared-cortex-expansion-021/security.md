# Security Review — task-021-shared-cortex-expansion-021

## Scope

Security assessment of the **build-stage hardening** introduced in task-021:

- `shared-cortex/model-router.ts` (new; central routing boundary)
- `shared-cortex/telemetry.ts` (schema + aggregation)
- tests in `shared-cortex/__tests__/openai-first-routing.test.ts`

This review focuses on:

- trust boundaries and policy bypass risk (model override + fallback)
- data minimization (telemetry / logs)
- injection/log-forging risks (JSONL)
- denial-of-service / runaway retry behavior

## Threat Model (high-level)

### Assets

- Execution routing policy (OpenAI-first defaults + deterministic fallbacks)
- Telemetry stream (metadata that can be sensitive if it contains identifiers)
- Downstream provider invocation surface (where model strings become network calls)

### Trust boundaries

- **User override model**: must only be accepted from explicit user intent (trusted surface).
- **External/untrusted triggers** (webhooks, inbound messages): must not be able to influence model routing or cause state-changing behavior.
- **Telemetry sink**: may be consumed by automated systems; must be robust against log injection.

### Attacker goals

- Force unexpected/expensive routing (override model IDs)
- Coerce unbounded retries / degrade availability
- Exfiltrate secrets via telemetry/logs
- Forge telemetry/log lines to mislead audits

---

## Findings

### F1 — Model override is still unconstrained (allowlist recommended at invocation boundary)

**Where:** `shared-cortex/model-router.ts` → `resolveModel({ userOverrideModel })`

**Observation:** Any non-empty `userOverrideModel` results in `policy_override` classification and can influence the selected model string.

**Risk:** Low→Medium (depends on integration).

- If model strings can be influenced by untrusted input (webhook payloads or agent contributions), an attacker could induce unexpected provider/model selection or cost spikes.

**Recommendation (required before full runtime wiring):**

- Enforce **source-of-truth** for overrides (explicit user instruction only).
- Add an **allowlist** of provider/model IDs at the _actual provider invocation boundary_ (even if the resolver allows arbitrary strings).
- Persist a structured audit field like `override_source: user|task_policy|system_default` (do not infer from free-form strings).

---

### F2 — Retry/attempt budget is bounded but defaults should be treated as a DoS control

**Where:** `runWithSharedModelRouter()`

**Observation:**

- `attemptLimit = max(1, attemptBudget ?? OPENAI_FALLBACK_CHAIN.length + 1)`.
- This is bounded by default (primary + fallbacks), which is good.

**Risk:** Low.

- A misconfigured caller could pass very large `attemptBudget`, producing excessive retries.

**Recommendation:**

- Clamp `attemptBudget` to a safe maximum (e.g., `<= 3` or `<= OPENAI_FALLBACK_CHAIN.length + 1`) unless an explicit elevated mode is set.
- Emit a policy audit marker if clamping occurs (e.g., `attempt_budget_clamped`).

---

### F3 — Telemetry is content-minimized (good), but identifiers can still be sensitive

**Where:** `shared-cortex/model-router.ts` emits `RunTelemetry`

**Observation:**

- Telemetry fields are metadata-only: model IDs, route type, tokens, duration.
- On failure, only `error_class` is emitted (not `error.message`), which avoids accidental leakage.
- `run_id` embeds `taskId` as `"${taskId}:${attempt}"`.

**Risk:** Low.

- `taskId` values can still be sensitive operational identifiers.

**Recommendation:**

- Ensure telemetry storage ACLs treat this as sensitive metadata.
- Consider hashing or normalizing `task_id`/`run_id` before exporting to external systems.

---

### F4 — JSONL fallback lines are structurally safe, but ensure sinks are newline-safe

**Where:** `buildFallbackJsonlLine()`

**Observation:**

- JSON is produced via `JSON.stringify`, which is safe against classic string injection.

**Risk:** Low.

- If downstream sinks concatenate strings without guarding against embedded newlines in values, logs can be forged.

**Recommendation:**

- Keep `taskId` and model IDs validated to exclude control characters (`\r`, `\n`, `\t`) before writing to line-oriented logs.
- Alternatively, ensure the sink writes exactly one line per JSON object and escapes control chars.

---

### F5 — Fallback reason classification is non-secret, but can misclassify

**Where:** `classifyFallbackReason()`

**Observation:**

- Any `userOverrideModel` causes `policy_override`, even when the underlying failure was timeout/5xx.

**Risk:** Low (integrity/observability issue, not a direct security issue).

**Recommendation:**

- Consider splitting "reason for transition" (timeout/5xx/capacity) from "override present" (a separate boolean/audit marker) so telemetry remains accurate.

---

## Positive Controls Present

- **Bounded default retry chain** (primary + defined fallbacks).
- **No raw provider errors or prompts** recorded in telemetry.
- **Route type is explicit in telemetry**, and defaulting emits a policy marker (`route_type_defaulted`).

## Required Follow-ups (before enabling as the only runtime path)

1. **Allowlist/validate model IDs** at the provider invocation boundary.
2. **Lock override source**: accept `userOverrideModel` only from trusted user intent; never from external/untrusted payloads.
3. **Clamp attempt budgets** to prevent accidental retry storms.
4. **Validate/normalize telemetry identifiers** if exported beyond local trusted storage.

## Stage Result

- Status: **pass** (security review completed; no code changes required to complete this stage)
- Notes: Follow-ups are recommended hardening prior to fully wiring SharedModelRouter into all runtime call sites.
