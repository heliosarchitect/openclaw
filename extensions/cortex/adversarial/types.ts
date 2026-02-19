/**
 * Adversarial Self-Testing Framework — Type Definitions
 * Task-007 | Cortex v2.3.0
 */

// ──────────────────────────────────────────────────────
// Attack Categories
// ──────────────────────────────────────────────────────

export type AttackCategory =
  | "prompt_injection"
  | "memory_poisoning"
  | "tool_faults"
  | "pipeline_corruption"
  | "synapse_adversarial";

export type Severity = "low" | "medium" | "high" | "critical";

export type TestOutcome = "pass" | "fail" | "skip" | "error";

// ──────────────────────────────────────────────────────
// Core Test Interface
// ──────────────────────────────────────────────────────

export interface AttackResult {
  /** Raw output from the attack execution */
  output: unknown;
  /** Tool calls that were triggered (if any) */
  toolCallsTriggered: string[];
  /** Errors encountered during attack */
  errors: string[];
  /** Whether the system detected the attack */
  attackDetected: boolean;
  /** Whether the attack succeeded in its goal */
  attackSucceeded: boolean;
  /** Additional metadata */
  meta: Record<string, unknown>;
}

export interface AdversarialTest {
  id: string;
  category: AttackCategory;
  severity: Severity;
  description: string;
  payload: unknown;
  attack: (ctx: AdversarialContext) => Promise<AttackResult>;
  assert: (result: AttackResult) => TestOutcome;
}

// ──────────────────────────────────────────────────────
// Adversarial Context
// ──────────────────────────────────────────────────────

export interface CortexMock {
  add(content: string, opts?: { importance?: number; categories?: string[] }): Promise<string>;
  stm(opts?: { limit?: number; category?: string }): Promise<STMEntry[]>;
  stats(): Promise<{ total: number; stm_count: number; categories: Record<string, number> }>;
  search(query: string, opts?: { limit?: number }): Promise<STMEntry[]>;
  dedupe(action: "report"): Promise<{ duplicates: number; groups: unknown[] }>;
}

export interface STMEntry {
  id: string;
  content: string;
  importance: number;
  categories: string[];
  timestamp: string;
  confidence?: number;
}

export interface SynapseMock {
  send(to: string, body: string, opts?: { priority?: string; subject?: string }): Promise<string>;
  inbox(opts?: { include_read?: boolean }): Promise<SynapseMessage[]>;
  history(opts?: { limit?: number }): Promise<SynapseMessage[]>;
}

export interface SynapseMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  priority: string;
  timestamp: string;
}

export interface ToolCallRecord {
  tool: string;
  params: Record<string, unknown>;
  timestamp: string;
  blocked: boolean;
  reason?: string;
}

export interface SandboxEnv {
  tmpDir: string;
  dbPath: string;
  stateJsonPath: string;
  cleanup(): Promise<void>;
}

export interface AdversarialContext {
  cortex: CortexMock;
  synapse: SynapseMock;
  faultInjector: FaultInjector;
  sandbox: SandboxEnv;
  toolCalls: ToolCallRecord[];
  logs: string[];
  log(msg: string): void;
  recordToolCall(record: ToolCallRecord): void;
}

// ──────────────────────────────────────────────────────
// Fault Injector
// ──────────────────────────────────────────────────────

export type FileMutation =
  | { kind: "truncate"; at: number }
  | { kind: "corrupt_json"; field: string; value: unknown }
  | { kind: "inject_bytes"; offset: number; bytes: Buffer }
  | { kind: "delete" };

export type MessageHandler = (msg: SynapseMessage) => SynapseMessage | null;

export interface FaultInjector {
  injectNetworkTimeout(toolName: string, delayMs: number): void;
  injectToolError(toolName: string, error: Error): void;
  corruptFile(path: string, mutation: FileMutation): Promise<void>;
  interceptMessage(pattern: RegExp, handler: MessageHandler): void;
  isToolFaulted(toolName: string): { faulted: boolean; error?: Error; delayMs?: number };
  reset(): void;
}

// ──────────────────────────────────────────────────────
// Results
// ──────────────────────────────────────────────────────

export interface TestResult {
  id: string;
  category: AttackCategory;
  severity: Severity;
  description: string;
  outcome: TestOutcome;
  duration_ms: number;
  error?: string;
  attack_result?: AttackResult;
}

export interface CategoryResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  tests: TestResult[];
}

export interface ASTRunResult {
  run_id: string;
  timestamp: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  by_category: Partial<Record<AttackCategory, CategoryResult>>;
  failed_tests: TestResult[];
  overall_verdict: "PASS" | "FAIL" | "PARTIAL";
  duration_ms: number;
  cortex_memory_id?: string;
}
