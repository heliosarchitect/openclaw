export interface ContextItem {
  memory_id: string;
  source: string;
  confidence: number;
  timestamp: string;
  text: string;
  relevance?: number;
  estimated_tokens?: number;
}

export interface ContextPacket {
  task_id: string;
  budget_tokens: number;
  items: ContextItem[];
  trace: {
    generated_at: string;
    policy_version: string;
  };
}

export interface BuildContextPacketInput {
  taskId: string;
  budgetTokens: number;
  candidates: ContextItem[];
  minConfidence?: number;
  policyVersion?: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildContextPacket(input: BuildContextPacketInput): ContextPacket {
  const minConfidence = input.minConfidence ?? 0.75;
  const policyVersion = input.policyVersion ?? "context_packet_v1";

  const ranked = [...input.candidates]
    .filter((item) => item.confidence >= minConfidence)
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

  const items: ContextItem[] = [];
  let tokenCount = 0;

  for (const item of ranked) {
    const itemTokens = item.estimated_tokens ?? estimateTokens(item.text);
    if (tokenCount + itemTokens > input.budgetTokens) continue;
    items.push({ ...item, estimated_tokens: itemTokens });
    tokenCount += itemTokens;
  }

  return {
    task_id: input.taskId,
    budget_tokens: input.budgetTokens,
    items,
    trace: {
      generated_at: new Date().toISOString(),
      policy_version: policyVersion,
    },
  };
}
