/**
 * Self-Reflection Coach - Periodic review and pattern analysis
 *
 * Analyzes Cortex memories to identify:
 * - Patterns in decisions (what worked, what didn't)
 * - Recurring mistakes or issues
 * - Growth areas and improvements
 * - Lessons that should be reinforced
 *
 * Can run on-demand via tool or scheduled via cron.
 */
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface STMItem {
  content: string;
  timestamp: string;
  category: string;
  importance: number;
  access_count: number;
}

interface ReflectionAnalysis {
  period: string;
  memoriesAnalyzed: number;
  patterns: {
    decisions: string[];
    mistakes: string[];
    successes: string[];
    recurring: string[];
  };
  insights: string[];
  recommendations: string[];
  growthAreas: string[];
  timestamp: string;
}

// Patterns to identify different types of memories
const ANALYSIS_PATTERNS = {
  decisions: [
    /decided|chose|picked|went with|selected|opted/i,
    /the (decision|choice|plan) (was|is)/i,
  ],
  mistakes: [
    /mistake|error|wrong|failed|broken|bug|issue|problem/i,
    /should(n't| not) have|regret|oops|unfortunately/i,
  ],
  successes: [
    /worked|success|fixed|solved|completed|achieved|done/i,
    /great|excellent|perfect|nailed|crushed/i,
  ],
  learning: [
    /learned|realized|discovered|understood|insight/i,
    /now I know|turns out|key (takeaway|lesson)/i,
  ],
};

/**
 * Load STM items from brain.db via REST API
 */
async function loadSTM(): Promise<STMItem[]> {
  try {
    const response = await fetch("http://localhost:8031/stm?limit=100");
    if (response.ok) {
      const data = await response.json() as { entries: STMItem[] };
      return data.entries || [];
    }
    return [];
  } catch {
    // brain_api not running — try stm.json as fallback
    const stmPath = join(homedir(), ".openclaw", "workspace", "memory", "stm.json");
    try {
      const data = await readFile(stmPath, "utf-8");
      const stm = JSON.parse(data) as { short_term_memory: STMItem[] };
      return stm.short_term_memory || [];
    } catch {
      return [];
    }
  }
}

/**
 * Load memories from collections
 */
async function loadCollections(): Promise<Map<string, string[]>> {
  const collectionsDir = join(homedir(), ".openclaw", "workspace", "memory", "collections");
  const collections = new Map<string, string[]>();

  try {
    const fs = await import("node:fs/promises");
    const files = await fs.readdir(collectionsDir);

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const data = await fs.readFile(join(collectionsDir, file), "utf-8");
        const collection = JSON.parse(data) as { entries?: Array<{ content: string }> };
        const category = file.replace(".json", "");
        collections.set(
          category,
          (collection.entries || []).map((e) => e.content)
        );
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Collections dir doesn't exist
  }

  return collections;
}

/**
 * Check if text matches patterns
 */
function matchesPatterns(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Extract items matching a pattern category
 */
function extractByPattern(items: string[], patterns: RegExp[]): string[] {
  return items.filter((item) => matchesPatterns(item, patterns));
}

/**
 * Find recurring themes (words/phrases that appear multiple times)
 */
function findRecurringThemes(items: string[]): string[] {
  const allText = items.join(" ").toLowerCase();
  const words = allText.split(/\s+/).filter((w) => w.length > 5);

  const wordCounts = new Map<string, number>();
  for (const word of words) {
    const clean = word.replace(/[^a-z]/g, "");
    if (clean.length > 5) {
      wordCounts.set(clean, (wordCounts.get(clean) || 0) + 1);
    }
  }

  // Find words that appear 3+ times
  return Array.from(wordCounts.entries())
    .filter(([_word, count]) => count >= 3)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => `"${word}" (${count}x)`);
}

/**
 * Generate insights from patterns
 */
function generateInsights(analysis: Omit<ReflectionAnalysis, "insights" | "recommendations" | "growthAreas">): {
  insights: string[];
  recommendations: string[];
  growthAreas: string[];
} {
  const insights: string[] = [];
  const recommendations: string[] = [];
  const growthAreas: string[] = [];

  const { patterns } = analysis;

  // Analyze decision patterns
  if (patterns.decisions.length > 3) {
    insights.push(`Made ${patterns.decisions.length} notable decisions in this period`);
  }

  // Analyze mistakes
  if (patterns.mistakes.length > 0) {
    insights.push(`Encountered ${patterns.mistakes.length} mistakes or issues`);
    if (patterns.mistakes.length > 2) {
      recommendations.push("Consider reviewing error-prone areas more carefully before acting");
      growthAreas.push("Error prevention and validation");
    }
  }

  // Analyze successes
  if (patterns.successes.length > 0) {
    insights.push(`Achieved ${patterns.successes.length} successes`);
    if (patterns.successes.length > patterns.mistakes.length) {
      insights.push("Success rate is positive - current approaches are working");
    }
  }

  // Analyze recurring themes
  if (patterns.recurring.length > 0) {
    insights.push(`Recurring themes: ${patterns.recurring.slice(0, 5).join(", ")}`);
    recommendations.push("Consider creating dedicated documentation for frequently-discussed topics");
  }

  // Balance analysis
  const successRate = patterns.successes.length / Math.max(1, patterns.successes.length + patterns.mistakes.length);
  if (successRate < 0.5) {
    recommendations.push("Success rate is below 50% - consider slowing down and being more methodical");
    growthAreas.push("Careful planning before execution");
  } else if (successRate > 0.8) {
    insights.push("High success rate indicates good judgment and execution");
  }

  // Default recommendations if none generated
  if (recommendations.length === 0) {
    recommendations.push("Continue current approaches - patterns look healthy");
  }

  if (growthAreas.length === 0) {
    growthAreas.push("Maintain current performance levels");
  }

  return { insights, recommendations, growthAreas };
}

/**
 * Perform reflection analysis
 */
async function performReflection(period: "day" | "week" | "month" = "week"): Promise<ReflectionAnalysis> {
  // Load all memories
  const stmItems = await loadSTM();
  const collections = await loadCollections();

  // Filter by time period
  const now = Date.now();
  const periodMs = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  }[period];

  const recentSTM = stmItems.filter((item) => {
    const itemTime = new Date(item.timestamp).getTime();
    return now - itemTime <= periodMs;
  });

  // Gather all content
  const allContent: string[] = [
    ...recentSTM.map((item) => item.content),
    ...Array.from(collections.values()).flat(),
  ];

  // Analyze patterns
  const patterns = {
    decisions: extractByPattern(allContent, ANALYSIS_PATTERNS.decisions).slice(0, 10),
    mistakes: extractByPattern(allContent, ANALYSIS_PATTERNS.mistakes).slice(0, 10),
    successes: extractByPattern(allContent, ANALYSIS_PATTERNS.successes).slice(0, 10),
    recurring: findRecurringThemes(allContent),
  };

  // Generate insights
  const baseAnalysis = {
    period,
    memoriesAnalyzed: allContent.length,
    patterns,
    timestamp: new Date().toISOString(),
  };

  const { insights, recommendations, growthAreas } = generateInsights(baseAnalysis);

  return {
    ...baseAnalysis,
    insights,
    recommendations,
    growthAreas,
  };
}

/**
 * Format reflection for display
 */
function formatReflection(analysis: ReflectionAnalysis): string {
  const lines: string[] = [];

  lines.push(`=== Self-Reflection Report (${analysis.period}) ===`);
  lines.push(`Generated: ${analysis.timestamp}`);
  lines.push(`Memories analyzed: ${analysis.memoriesAnalyzed}`);
  lines.push("");

  if (analysis.insights.length > 0) {
    lines.push("## Insights");
    analysis.insights.forEach((i) => lines.push(`- ${i}`));
    lines.push("");
  }

  if (analysis.patterns.decisions.length > 0) {
    lines.push("## Recent Decisions");
    analysis.patterns.decisions.slice(0, 5).forEach((d) => lines.push(`- ${d.slice(0, 100)}`));
    lines.push("");
  }

  if (analysis.patterns.successes.length > 0) {
    lines.push("## Successes");
    analysis.patterns.successes.slice(0, 5).forEach((s) => lines.push(`- ${s.slice(0, 100)}`));
    lines.push("");
  }

  if (analysis.patterns.mistakes.length > 0) {
    lines.push("## Areas for Improvement");
    analysis.patterns.mistakes.slice(0, 5).forEach((m) => lines.push(`- ${m.slice(0, 100)}`));
    lines.push("");
  }

  if (analysis.recommendations.length > 0) {
    lines.push("## Recommendations");
    analysis.recommendations.forEach((r) => lines.push(`- ${r}`));
    lines.push("");
  }

  if (analysis.growthAreas.length > 0) {
    lines.push("## Growth Areas");
    analysis.growthAreas.forEach((g) => lines.push(`- ${g}`));
  }

  return lines.join("\n");
}

/**
 * Store reflection in Cortex
 */
async function storeReflection(analysis: ReflectionAnalysis): Promise<void> {
  // Create summary content
  const content = [
    `[Self-Reflection ${analysis.period}] ${analysis.timestamp}`,
    `Insights: ${analysis.insights.join("; ")}`,
    `Recommendations: ${analysis.recommendations.join("; ")}`,
  ].join(" | ").slice(0, 500);

  try {
    // Store via brain.db REST API
    await fetch("http://localhost:8031/remember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        categories: ["reflection", "meta"],
        importance: 2.5,
        source: "self-reflection",
      }),
    });
  } catch {
    // brain_api not running, that's OK
  }
}

const selfReflectionPlugin = {
  id: "self-reflection",
  name: "Self-Reflection Coach",
  description: "Periodic self-analysis to identify patterns, learn from mistakes, and track growth",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as {
      enabled?: boolean;
      autoReflect?: boolean;
      reflectionPeriod?: "day" | "week" | "month";
    };

    const enabled = config?.enabled !== false;

    if (!enabled) {
      api.logger.info("Self-reflection coach disabled");
      return;
    }

    // Register the reflect tool
    api.registerTool(
      {
        name: "reflect",
        description:
          "Perform self-reflection analysis on recent memories. Identifies patterns in decisions, mistakes, successes, and generates insights and recommendations for improvement.",
        parameters: Type.Object({
          period: Type.Optional(
            Type.String({
              description: "Time period to analyze: 'day', 'week', or 'month' (default: week)",
            })
          ),
          store: Type.Optional(
            Type.Boolean({
              description: "Store the reflection summary in Cortex (default: true)",
            })
          ),
        }),
        async execute(_toolCallId, params) {
          const p = params as { period?: string; store?: boolean };
          const period: "day" | "week" | "month" = p.period === "day" || p.period === "month" ? p.period : "week";
          const shouldStore = p.store !== false;

          try {
            const analysis = await performReflection(period);
            const formatted = formatReflection(analysis);

            if (shouldStore) {
              await storeReflection(analysis);
            }

            return {
              content: [
                {
                  type: "text",
                  text: formatted + (shouldStore ? "\n\n(Reflection stored in Cortex)" : ""),
                },
              ],
              details: {
                period,
                memoriesAnalyzed: analysis.memoriesAnalyzed,
                insights: analysis.insights.length,
                stored: shouldStore,
              },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Reflection failed: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["reflect", "self_reflect"] },
    );

    // Register CLI command
    api.registerCli(
      ({ program }) => {
        const reflectCmd = program
          .command("reflect")
          .description("Run self-reflection analysis");

        reflectCmd
          .command("run [period]")
          .description("Perform reflection (day/week/month)")
          .action(async (period: string = "week") => {
            const validPeriod: "day" | "week" | "month" = period === "day" || period === "month" ? period : "week";
            console.log(`Running ${validPeriod} reflection...`);

            const analysis = await performReflection(validPeriod);
            console.log(formatReflection(analysis));

            await storeReflection(analysis);
            console.log("\n(Stored in Cortex)");
          });

        reflectCmd
          .command("schedule")
          .description("Show how to schedule automatic reflections")
          .action(() => {
            console.log("To schedule automatic reflections, add a cron job:");
            console.log("");
            console.log("  # Daily reflection at 11pm");
            console.log("  openclaw cron add --schedule '0 23 * * *' --command 'openclaw reflect run day'");
            console.log("");
            console.log("  # Weekly reflection on Sundays");
            console.log("  openclaw cron add --schedule '0 20 * * 0' --command 'openclaw reflect run week'");
          });
      },
      { commands: ["reflect"] },
    );

    api.logger.info("Self-reflection coach initialized");
  },
};

export default selfReflectionPlugin;
