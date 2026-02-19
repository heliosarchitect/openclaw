/**
 * Unit tests for Atom Enricher
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { enrichAtoms } from "../atom-enricher.js";

describe("enrichAtoms", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a new atom from a causal abstraction", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: '{"subject": "whale wallet", "action": "accumulates BNKR", "outcome": "price spike follows", "consequences": "retail FOMO within 4h"}',
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const created: any[] = [];
    const result = await enrichAtoms("Whale wallets accumulate BNKR before price spikes", {
      apiKey: "test-key",
      atomSearch: vi.fn().mockResolvedValue([]),
      atomCreate: vi.fn().mockImplementation(async (atom) => {
        created.push(atom);
        return { id: "atom-1" };
      }),
    });

    expect(result.created).toBe(true);
    expect(result.atom_id).toBe("atom-1");
    expect(created[0].subject).toBe("whale wallet");
  });

  it("skips when LLM returns skip:true", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: '{"skip": true}' }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await enrichAtoms("No causal pattern here", {
      apiKey: "test-key",
      atomSearch: vi.fn().mockResolvedValue([]),
      atomCreate: vi.fn(),
    });

    expect(result.created).toBe(false);
  });

  it("deduplicates against existing similar atoms", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: '{"subject": "whale wallet", "action": "accumulates", "outcome": "price rises", "consequences": "FOMO"}',
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const atomCreate = vi.fn();
    const result = await enrichAtoms("Whale accumulation causes price increase", {
      apiKey: "test-key",
      atomSearch: vi.fn().mockResolvedValue([{ id: "existing-atom", similarity: 0.9 }]),
      atomCreate,
    });

    expect(result.created).toBe(false);
    expect(result.enriched_existing).toBe(true);
    expect(atomCreate).not.toHaveBeenCalled();
  });

  it("returns created:false on API failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", mockFetch);

    const result = await enrichAtoms("test", {
      apiKey: "test-key",
      atomSearch: vi.fn(),
      atomCreate: vi.fn(),
    });

    expect(result.created).toBe(false);
  });
});
