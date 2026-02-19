/**
 * Atom Enricher — extracts causal patterns from distillations and feeds them into the atom graph.
 *
 * Uses a second LLM pass (Haiku) to extract {subject, action, outcome, consequences} quadruples.
 * Deduplicates against existing atoms before creating new ones.
 */
import type { CausalAtom } from "./types.js";

const ATOM_EXTRACT_PROMPT = `Extract a causal knowledge atom from this abstraction.
Output ONLY valid JSON with exactly these fields:
{ "subject": "who/what acts", "action": "what they do", "outcome": "what results", "consequences": "what follows" }
If no clear causal pattern exists, respond with: { "skip": true }`;

export interface AtomEnricherDeps {
  atomSearch: (field: string, query: string) => Promise<Array<{ id: string; similarity: number }>>;
  atomCreate: (atom: CausalAtom) => Promise<{ id: string }>;
  apiKey: string;
  model?: string;
}

export async function enrichAtoms(
  abstraction: string,
  deps: AtomEnricherDeps,
): Promise<{ created: boolean; atom_id?: string; enriched_existing?: boolean }> {
  const { apiKey, model = "claude-haiku-4-20250414", atomSearch, atomCreate } = deps;

  // Extract causal quadruple via LLM
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: `${ATOM_EXTRACT_PROMPT}\n\nAbstraction: ${abstraction}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) return { created: false };

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((c) => c.type === "text")?.text;
  if (!text) return { created: false };

  let parsed: CausalAtom & { skip?: boolean };
  try {
    const jsonStr = text
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    return { created: false };
  }

  if (parsed.skip || !parsed.subject || !parsed.action) return { created: false };

  // Dedup check: search for similar atoms by subject
  const similar = await atomSearch("subject", parsed.subject);
  if (similar.some((s) => s.similarity > 0.85)) {
    return { created: false, enriched_existing: true };
  }

  // Create atom
  const result = await atomCreate(parsed);
  return { created: true, atom_id: result.id };
}
