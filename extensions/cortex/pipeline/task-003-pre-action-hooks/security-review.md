# Security Review — Pre-Action Hook System v2.0.0

**Task ID**: task-003-pre-action-hooks  
**Stage**: security  
**Date**: 2026-02-18  
**Reviewer**: Security Specialist  
**Input**: build-report.md + code review of hooks/ and modified index.ts / cortex-bridge.ts  
**Result**: ✅ APPROVED WITH MITIGATIONS

---

## Executive Summary

The Pre-Action Hook System v2.0.0 has been reviewed against the STRIDE threat model and the project's NFR-002 (Security) requirements. **No CRITICAL or HIGH severity findings.** Two MEDIUM findings require follow-up in the next release cycle; both are mitigated by existing controls and do not block deployment.

The system's core security posture is sound: fail-open architecture preserves availability, knowledge injection is length-bounded, tool interception is scoped to a fixed allowlist, and credentials sections are handled at the SOP pattern level rather than surfaced to agents arbitrarily.

---

## Findings Summary

| Severity | Count | Status        |
| -------- | ----- | ------------- |
| CRITICAL | 0     | ✅ None       |
| HIGH     | 0     | ✅ None       |
| MEDIUM   | 2     | ⚠️ Mitigated  |
| LOW      | 4     | ✅ Acceptable |
| INFO     | 5     | ✅ Noted      |

---

## Detailed Findings

### MEDIUM Findings

#### MED-001: Non-Cryptographic Bypass Token Generation

**Component**: `hooks/enforcement-engine.ts:279-286`  
**Code**:

```typescript
generateBypassToken(): string {
  const token = Math.random().toString(36).substring(2, 15);
  this.bypassTokens.add(token);
  ...
}
```

**Issue**: `Math.random()` is seeded by V8's internal PRNG — not suitable for security tokens. An attacker with knowledge of the PRNG state could predict valid bypass tokens.

**Impact**: An agent or injected prompt that learns the approximate token space could brute-force bypass enforcement within a predictable range.  
**Likelihood**: LOW — bypass tokens are consumed server-side and never transmitted. Attack requires process-level access, at which point enforcement is already bypassed.  
**Residual Risk**: MEDIUM (by classification), LOW (in practice).

**Recommendation**: Replace with `crypto.randomBytes(16).toString('hex')` from Node.js built-in `crypto` module. One-line change, no dependency additions.

```typescript
import { randomBytes } from "node:crypto";
// ...
const token = randomBytes(16).toString("hex");
```

**Status**: ⚠️ **MITIGATED by architecture** — tokens are in-process only, never exposed externally. Fix scheduled for next patch.

---

#### MED-002: Unescaped Section Name in `extractSection` RegExp Constructor

**Component**: `hooks/sop-enhancer.ts:36-57`  
**Code**:

```typescript
const headingRe = new RegExp(`^#{1,4}\\s*${sectionName}\\s*$`, "im");
// ...
const yamlRe = new RegExp(`^${sectionName}:\\s*$`, "im");
```

**Issue**: `sectionName` is interpolated directly into `RegExp` without escaping special regex characters. A crafted section name containing regex metacharacters (e.g., `(preflight|.*)`) could cause ReDoS or unexpected pattern matching.

**Impact**: Malformed knowledge injection output; potential ReDoS if section names are ever sourced from user input or external SOP files.  
**Likelihood**: LOW — currently `sections` arrays are fully hardcoded in `SOPEnhancer.patterns` (e.g., `["preflight", "gotchas", "credentials"]`). No external input path today.  
**Residual Risk**: MEDIUM (by classification), LOW (in practice while input is controlled).

**Recommendation**: Escape `sectionName` before interpolation as a defensive measure:

```typescript
const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headingRe = new RegExp(`^#{1,4}\\s*${escaped}\\s*$`, "im");
const yamlRe = new RegExp(`^${escaped}:\\s*$`, "im");
```

**Status**: ⚠️ **MITIGATED by controlled input** — section names are hardcoded constants. Fix scheduled for next patch.

---

### LOW Findings

#### LOW-001: Non-Atomic Cooldown Check/Track Operations

**Component**: `hooks/enforcement-engine.ts` — `checkCooldown()` / `trackInjection()`  
**Issue**: Cooldown checking and recording are two separate async operations. In theory, two concurrent tool calls with the same key could both pass `checkCooldown()` before either executes `trackInjection()`.  
**Impact**: Double-injection of the same knowledge block in a narrow race window. Not a security bypass, merely cosmetic noise.  
**Mitigation**: Node.js single-threaded event loop makes true concurrent races impossible within the same synchronous flow. Risk is negligible.  
**Recommendation**: If multi-process OpenClaw is ever deployed, replace with atomic check-and-set.  
**Status**: ✅ Acceptable for single-process deployment.

---

#### LOW-002: Unbounded `minConfidence` Parameter

**Component**: `cortex-bridge.ts:searchMemoriesWithConfidence()`  
**Issue**: `minConfidence` has no bounds clamping. Values < 0 return all memories; values > 1 return nothing.  
**Impact**: Misconfigured enforcement config could cause unexpected behavior (all memories shown, or none).  
**Mitigation**: `enforcementConfig.confidenceThreshold` is set from plugin config with a numeric default (0.5). No external injection path.  
**Recommendation**: Add `Math.max(0, Math.min(1, minConfidence))` clamping in the function.  
**Status**: ✅ Acceptable.

---

#### LOW-003: `any` Typing in `groupMemoriesByCategory()`

**Component**: `hooks/enforcement-engine.ts:337`  
**Code**: `private groupMemoriesByCategory(memories: any[]): Map<string, any[]>`  
**Issue**: Using `any[]` bypasses TypeScript's type checker for memory objects. A structural change to the `KnowledgeResult.memories` type would silently fail at runtime.  
**Impact**: Type safety gap — not a runtime security risk.  
**Recommendation**: Replace `any` with the proper memory interface type from `knowledge-discovery.ts`.  
**Status**: ✅ Acceptable.

---

#### LOW-004: Bypass Token Lifetime via `setTimeout` Reference Loss

**Component**: `hooks/enforcement-engine.ts:284-286`  
**Issue**: Bypass token expiry uses `setTimeout`. On process restart, the in-memory `bypassTokens` Set is cleared (good), but the timer callbacks reference a stale object. No memory leak — GC handles it — but there's no explicit cleanup on shutdown.  
**Impact**: Negligible. Restart clears all tokens.  
**Status**: ✅ Acceptable.

---

### INFO Findings

#### INFO-001: Fail-Open Design ✅ CORRECT

The hook wraps all logic in `try/catch` and returns `undefined` (allow) on any error. This is the correct security posture for an availability-critical hook. Tool execution is never blocked by hook infrastructure failures.

#### INFO-002: Read-Only Pass-Through ✅ CORRECT

```typescript
const READ_ONLY_PATTERN = /^\s*(ls|cat|head|tail|grep|find|...)\b/i;
```

Read-only commands bypass enforcement unconditionally and are logged with `acknowledged: true`. This correctly prevents enforcement from blocking diagnostic operations.

#### INFO-003: Content Truncation ✅ ADEQUATE

SOP content is truncated to 1000 chars; memory content to 200 chars; total injection message to 4000 chars (`maxKnowledgeLength`). This prevents unbounded prompt injection via oversized knowledge blocks and limits token waste.

#### INFO-004: Tool Interception Scope ✅ APPROPRIATE

`interceptTools` defaults to `["exec", "nodes"]` — a narrowly scoped allowlist. `browser` and `message` require explicit config opt-in. This correctly limits the enforcement surface to high-impact tools.

#### INFO-005: Credential Section Handling ✅ REVIEWED

SOP patterns declare `"credentials"` as an extractable section. This is correct — Helios needs credential lookup hints (e.g., where keys are stored) before tool execution. The content is truncated (INFO-003) and never written to persistent logs in the current implementation. If future logging of injected content is added, credential sections must be redacted explicitly.

---

## Security Properties Assessment

### NFR-002 Compliance Check

| Requirement                       | Status | Notes                                                     |
| --------------------------------- | ------ | --------------------------------------------------------- |
| Input sanitization of tool params | ✅     | `JSON.stringify` + paramStr; no SQL/shell injection paths |
| Access control on bypass          | ⚠️     | `Math.random()` token (MED-001); fix scheduled            |
| Audit trail for all bypasses      | ✅     | `writeMetric()` called on all interception events         |
| Secrets protection in logs        | ✅     | Content truncated; no direct log write of credentials     |

### CIA Triad

| Property            | Assessment                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Confidentiality** | ✅ No new external data exposure. SOP content stays in-process. Memory results scoped to process + session.                  |
| **Integrity**       | ✅ Hook cannot be manipulated by agent (runs pre-call, not in agent reasoning flow). Metrics write is post-decision.         |
| **Availability**    | ✅ Fail-open on all error paths. 150ms timeout prevents blocking on slow knowledge lookup. Read-only pass-through preserved. |

### STRIDE Threat Assessment

| Threat                     | Finding                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spoofing**               | No auth required for hook system (correct — it's internal). Bypass tokens prevent impersonation of authorized callers.                                  |
| **Tampering**              | Agent cannot modify `recentInjections` or `bypassTokens` (in-memory, non-exposed). Hook fires before agent logic acts.                                  |
| **Repudiation**            | All interceptions logged via `writeMetric()` with tamper-evident backend (from v1.3.0).                                                                 |
| **Information Disclosure** | Knowledge injection is bounded (4000 chars max). Credential hints pass through, but only to the calling agent (not logged).                             |
| **Denial of Service**      | 150ms hard timeout + fail-open prevents hook from blocking tool execution. `recentInjections` cleanup at 1000 entries prevents unbounded memory growth. |
| **Elevation of Privilege** | `emergencyBypass: false` by default. No agent-accessible API to enable it.                                                                              |

---

## Attack Surface Summary

```
External (webhook/message) → no hook bypass possible (hooks fire in plugin layer)
Agent (tool call params)   → can influence keyword extraction (INFO only: affects search terms, not execution)
Config (pre-action-hooks)  → controls enforcement level; requires OpenClaw config access (trusted)
SOP files (filesystem)     → can influence injection content; reading is read-only, no write path from hook
```

No externally reachable attack surface was identified.

---

## Security Sign-Off

| Check                     | Result                                           |
| ------------------------- | ------------------------------------------------ |
| CRITICAL findings         | ✅ None                                          |
| HIGH findings             | ✅ None                                          |
| MEDIUM findings mitigated | ✅ Both blocked by architecture; fixes scheduled |
| NFR-002 requirements met  | ✅ Yes                                           |
| Fail-open verified        | ✅ Yes                                           |
| Audit trail coverage      | ✅ Yes                                           |

**Decision**: ✅ **APPROVED FOR TESTING STAGE**

Two MEDIUM findings are mitigated by architectural controls and do not represent active exploitable paths in the current deployment. Both should be resolved in the next patch release (v2.0.1):

- MED-001: `crypto.randomBytes()` for bypass tokens
- MED-002: Regex escaping in `extractSection()`

---

**Reviewer**: Security Specialist (pipeline-stage)  
**Sign-off**: 2026-02-18  
**Next Stage**: test
