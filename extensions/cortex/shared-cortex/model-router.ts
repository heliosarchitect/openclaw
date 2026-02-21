import type { RouteType, RunTelemetry } from "./telemetry.js";
import {
  OPENAI_FALLBACK_CHAIN,
  OPENAI_PRIMARY_MODEL,
  type FallbackReason,
  resolveModel,
  type TaskType,
} from "./model-policy-resolver.js";

export interface SharedModelRouterInput {
  taskId: string;
  taskType: TaskType;
  userOverrideModel?: string;
  taskPolicyModel?: string;
  routeType?: RouteType;
  attemptBudget?: number;
}

export interface SharedModelRouterDeps {
  runWithModel: (model: string) => Promise<{ tokensIn: number; tokensOut: number }>;
  nowIso?: () => string;
  emitTelemetry: (event: RunTelemetry) => void;
}

function classifyFallbackReason(
  error: unknown,
  userOverrideModel?: string,
): Exclude<FallbackReason, "none"> {
  if (userOverrideModel?.trim()) return "policy_override";

  const text = String(
    (error as { message?: string } | undefined)?.message ?? error ?? "",
  ).toLowerCase();
  const code = String((error as { code?: string | number } | undefined)?.code ?? "").toLowerCase();
  const status = Number((error as { status?: number } | undefined)?.status ?? 0);

  if (
    text.includes("timeout") ||
    text.includes("timed out") ||
    code === "etimedout" ||
    code === "aborterror"
  ) {
    return "timeout";
  }

  if ((status >= 500 && status <= 599) || text.includes("5xx") || text.includes("gateway")) {
    return "provider_5xx";
  }

  return "capacity";
}

export function buildFallbackJsonlLine(params: {
  taskId: string;
  from: string;
  to: string;
  reason: Exclude<FallbackReason, "none">;
  routeType: RouteType;
}): string {
  return JSON.stringify({
    event: "model_fallback",
    task_id: params.taskId,
    from: params.from,
    to: params.to,
    reason: params.reason,
    route_type: params.routeType,
  });
}

export async function runWithSharedModelRouter(
  input: SharedModelRouterInput,
  deps: SharedModelRouterDeps,
): Promise<{
  selectedModel: string;
  attempts: number;
  routeType: RouteType;
  policyAudit: string[];
}> {
  const attemptedModels: string[] = [];
  const attemptLimit = Math.max(1, input.attemptBudget ?? OPENAI_FALLBACK_CHAIN.length + 1);
  const routeType: RouteType = input.routeType ?? "api_key";
  const routeTypeDefaulted = input.routeType == null;

  let lastError: unknown;
  let lastReason: Exclude<FallbackReason, "none"> = "capacity";
  let policyAudit: string[] = routeTypeDefaulted ? ["route_type_defaulted"] : [];

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    const resolved = resolveModel({
      taskType: input.taskType,
      userOverrideModel: input.userOverrideModel,
      taskPolicyModel: input.taskPolicyModel,
      attemptedModels,
      failureReason: attemptedModels.length ? lastReason : undefined,
    });

    policyAudit = [...policyAudit, ...resolved.policyAudit];

    const selectedModel = resolved.selectedModel;
    attemptedModels.push(selectedModel);
    const startedAt = Date.now();

    try {
      const usage = await deps.runWithModel(selectedModel);
      deps.emitTelemetry({
        run_id: `${input.taskId}:${attempt}`,
        task_id: input.taskId,
        task_type: input.taskType,
        selected_model: selectedModel,
        fallback_from: resolved.fallbackFrom,
        fallback_to: resolved.fallbackTo,
        fallback_reason: resolved.fallbackReason,
        route_type: routeType,
        tokens_in: usage.tokensIn,
        tokens_out: usage.tokensOut,
        duration_ms: Date.now() - startedAt,
        success: true,
        created_at: deps.nowIso?.(),
        attempt_count: attempt,
      });

      return { selectedModel, attempts: attempt, routeType, policyAudit };
    } catch (error) {
      lastError = error;
      lastReason = classifyFallbackReason(error, input.userOverrideModel);

      deps.emitTelemetry({
        run_id: `${input.taskId}:${attempt}`,
        task_id: input.taskId,
        task_type: input.taskType,
        selected_model: selectedModel,
        fallback_from: resolved.fallbackFrom,
        fallback_to: resolved.fallbackTo,
        fallback_reason: resolved.fallbackReason,
        route_type: routeType,
        tokens_in: 0,
        tokens_out: 0,
        duration_ms: Date.now() - startedAt,
        success: false,
        created_at: deps.nowIso?.(),
        error_class: (error as { name?: string } | undefined)?.name ?? "Unknown",
        attempt_count: attempt,
      });

      if (attempt >= attemptLimit) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`model_router_failed:${lastReason}`);
}

export const __testables = {
  classifyFallbackReason,
};
