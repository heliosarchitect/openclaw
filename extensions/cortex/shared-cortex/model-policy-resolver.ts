export type TaskType = "coding" | "orchestration" | "analysis" | "general";

export type FallbackReason = "timeout" | "provider_5xx" | "capacity" | "policy_override" | "none";

export interface ResolveModelInput {
  taskType?: TaskType;
  userOverrideModel?: string;
  taskPolicyModel?: string;
  attemptedModels?: string[];
  failureReason?: Exclude<FallbackReason, "none">;
}

export interface ModelResolution {
  selectedModel: string;
  resolutionSource: "user_override" | "task_policy" | "system_default" | "fallback";
  fallbackFrom?: string;
  fallbackTo?: string;
  fallbackReason: FallbackReason;
  policyAudit: string[];
}

export const OPENAI_PRIMARY_MODEL = "openai-codex/gpt-5.3-codex";
export const OPENAI_FALLBACK_CHAIN = ["openai/gpt-5.2", "openai/gpt-5o"] as const;

const TASK_POLICY_DEFAULTS: Record<TaskType, string> = {
  coding: OPENAI_PRIMARY_MODEL,
  orchestration: OPENAI_PRIMARY_MODEL,
  analysis: OPENAI_PRIMARY_MODEL,
  general: OPENAI_PRIMARY_MODEL,
};

export function resolveModel(input: ResolveModelInput = {}): ModelResolution {
  const policyAudit: string[] = [];

  if (input.userOverrideModel?.trim()) {
    policyAudit.push(`selected user override model: ${input.userOverrideModel}`);
    return {
      selectedModel: input.userOverrideModel,
      resolutionSource: "user_override",
      fallbackReason: "none",
      policyAudit,
    };
  }

  const baseModel = input.taskPolicyModel?.trim()
    ? input.taskPolicyModel
    : TASK_POLICY_DEFAULTS[input.taskType ?? "general"];

  policyAudit.push(
    `base model from ${input.taskPolicyModel ? "task_policy" : "system_default"}: ${baseModel}`,
  );

  const attempted = new Set((input.attemptedModels ?? []).filter(Boolean));
  if (!attempted.has(baseModel)) {
    return {
      selectedModel: baseModel,
      resolutionSource: input.taskPolicyModel ? "task_policy" : "system_default",
      fallbackReason: "none",
      policyAudit,
    };
  }

  for (const candidate of OPENAI_FALLBACK_CHAIN) {
    if (!attempted.has(candidate)) {
      policyAudit.push(`fallback selected: ${candidate}`);
      return {
        selectedModel: candidate,
        resolutionSource: "fallback",
        fallbackFrom: baseModel,
        fallbackTo: candidate,
        fallbackReason: input.failureReason ?? "capacity",
        policyAudit,
      };
    }
  }

  policyAudit.push("fallback chain exhausted, reusing final model");
  return {
    selectedModel: OPENAI_FALLBACK_CHAIN[OPENAI_FALLBACK_CHAIN.length - 1],
    resolutionSource: "fallback",
    fallbackFrom: baseModel,
    fallbackTo: OPENAI_FALLBACK_CHAIN[OPENAI_FALLBACK_CHAIN.length - 1],
    fallbackReason: input.failureReason ?? "capacity",
    policyAudit,
  };
}
