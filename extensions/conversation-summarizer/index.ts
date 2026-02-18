/**
 * Conversation Summarizer - Auto-summarize conversations for Cortex
 *
 * Hooks into agent_end to extract and store:
 * - Key decisions made
 * - Insights and learnings
 * - Action items / todos
 * - Problems solved
 * - Questions that remain open
 *
 * Summaries are stored in Cortex with high importance for long-term recall.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Patterns to identify different types of content
const CONTENT_PATTERNS = {
  decisions: [
    /decided to|decision:|chose to|going with|we('ll| will) use|let's go with/i,
    /the plan is|approach will be|strategy is/i,
  ],
  insights: [
    /realized|learned|discovered|found out|turns out|interesting(ly)?/i,
    /key (insight|takeaway|point)|important to note/i,
  ],
  actions: [
    /todo:|action:|need to|should|must|will do|next step/i,
    /remember to|don't forget|make sure to/i,
  ],
  problems: [
    /fixed|solved|resolved|the (issue|problem|bug) was/i,
    /root cause|solution was|worked around/i,
  ],
  questions: [
    /\?$|still (need to|unclear|don't know)|open question/i,
    /wondering|not sure (about|if|whether)/i,
  ],
};

interface ConversationSummary {
  decisions: string[];
  insights: string[];
  actions: string[];
  problems: string[];
  questions: string[];
  topicSummary: string;
  messageCount: number;
  timestamp: string;
}

/**
 * Extract text content from a message
 */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          block &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Check if text matches any pattern in a category
 */
function matchesCategory(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Extract sentences that match a category
 */
function extractMatches(text: string, patterns: RegExp[]): string[] {
  const sentences = text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  return sentences.filter((sentence) => matchesCategory(sentence, patterns));
}

/**
 * Generate a brief topic summary from messages
 */
function generateTopicSummary(messages: Array<{ role?: string; content?: unknown }>): string {
  // Get first user message as topic indicator
  const firstUser = messages.find((m) => m.role === "user");
  const firstUserText = firstUser ? extractText(firstUser.content).slice(0, 200) : "";

  // Get keywords from all messages
  const allText = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => extractText(m.content))
    .join(" ")
    .toLowerCase();

  // Simple keyword extraction (words that appear multiple times)
  const words = allText.split(/\s+/).filter((w) => w.length > 4);
  const wordCounts = new Map<string, number>();
  for (const word of words) {
    const clean = word.replace(/[^a-z]/g, "");
    if (clean.length > 4) {
      wordCounts.set(clean, (wordCounts.get(clean) || 0) + 1);
    }
  }

  const topWords = Array.from(wordCounts.entries())
    .filter(([_word, count]) => count >= 2)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  if (firstUserText) {
    return `Topic: ${firstUserText.slice(0, 100)}${firstUserText.length > 100 ? "..." : ""} | Keywords: ${topWords.join(", ") || "general"}`;
  }
  return `Keywords: ${topWords.join(", ") || "general conversation"}`;
}

/**
 * Analyze a conversation and extract structured summary
 */
function analyzeConversation(
  messages: Array<{ role?: string; content?: unknown }>,
): ConversationSummary {
  const decisions: string[] = [];
  const insights: string[] = [];
  const actions: string[] = [];
  const problems: string[] = [];
  const questions: string[] = [];

  // Process assistant messages (where decisions/insights typically appear)
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }

    const text = extractText(msg.content);
    if (!text || text.length < 20) {
      continue;
    }

    // Extract matches for each category
    decisions.push(...extractMatches(text, CONTENT_PATTERNS.decisions));
    insights.push(...extractMatches(text, CONTENT_PATTERNS.insights));
    actions.push(...extractMatches(text, CONTENT_PATTERNS.actions));
    problems.push(...extractMatches(text, CONTENT_PATTERNS.problems));
    questions.push(...extractMatches(text, CONTENT_PATTERNS.questions));
  }

  // Deduplicate and limit
  const dedupe = (arr: string[]) => [...new Set(arr)].slice(0, 5);

  return {
    decisions: dedupe(decisions),
    insights: dedupe(insights),
    actions: dedupe(actions),
    problems: dedupe(problems),
    questions: dedupe(questions),
    topicSummary: generateTopicSummary(messages),
    messageCount: messages.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format summary for Cortex storage
 */
function formatSummaryForStorage(summary: ConversationSummary): string {
  const parts: string[] = [];

  parts.push(`[Conversation Summary - ${summary.timestamp}]`);
  parts.push(summary.topicSummary);
  parts.push(`Messages: ${summary.messageCount}`);

  if (summary.decisions.length > 0) {
    parts.push(`\nDecisions:\n- ${summary.decisions.join("\n- ")}`);
  }
  if (summary.insights.length > 0) {
    parts.push(`\nInsights:\n- ${summary.insights.join("\n- ")}`);
  }
  if (summary.actions.length > 0) {
    parts.push(`\nAction Items:\n- ${summary.actions.join("\n- ")}`);
  }
  if (summary.problems.length > 0) {
    parts.push(`\nProblems Solved:\n- ${summary.problems.join("\n- ")}`);
  }
  if (summary.questions.length > 0) {
    parts.push(`\nOpen Questions:\n- ${summary.questions.join("\n- ")}`);
  }

  return parts.join("\n");
}

/**
 * Calculate importance based on content richness
 */
function calculateImportance(summary: ConversationSummary): number {
  let importance = 1.0;

  // Decisions are high value
  if (summary.decisions.length > 0) {
    importance += 0.5;
  }

  // Insights are valuable
  if (summary.insights.length > 0) {
    importance += 0.3;
  }

  // Actions indicate work to be done
  if (summary.actions.length > 0) {
    importance += 0.2;
  }

  // Problems solved are worth remembering
  if (summary.problems.length > 0) {
    importance += 0.3;
  }

  // Longer conversations tend to be more substantial
  if (summary.messageCount > 10) {
    importance += 0.2;
  }

  return Math.min(3.0, importance);
}

const conversationSummarizerPlugin = {
  id: "conversation-summarizer",
  name: "Conversation Summarizer",
  description: "Auto-summarize conversations and store insights in Cortex",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as {
      enabled?: boolean;
      minMessages?: number;
      minImportance?: number;
    };

    const enabled = config?.enabled !== false;
    const minMessages = config?.minMessages ?? 4;
    const minImportance = config?.minImportance ?? 1.3;

    if (!enabled) {
      api.logger.info("Conversation summarizer disabled");
      return;
    }

    // Hook into agent_end to summarize conversations
    api.on("agent_end", async (event, _ctx) => {
      if (!event.success || !event.messages) {
        return;
      }

      const messages = event.messages as Array<{ role?: string; content?: unknown }>;

      // Skip short conversations
      if (messages.length < minMessages) {
        api.logger.debug?.(
          `Skipping summary: only ${messages.length} messages (min: ${minMessages})`,
        );
        return;
      }

      try {
        // Analyze the conversation
        const summary = analyzeConversation(messages);

        // Check if there's anything worth storing
        const hasContent =
          summary.decisions.length > 0 ||
          summary.insights.length > 0 ||
          summary.actions.length > 0 ||
          summary.problems.length > 0;

        if (!hasContent) {
          api.logger.debug?.("Skipping summary: no significant content extracted");
          return;
        }

        const importance = calculateImportance(summary);

        // Skip low-importance summaries
        if (importance < minImportance) {
          api.logger.debug?.(
            `Skipping summary: importance ${importance.toFixed(1)} below threshold ${minImportance}`,
          );
          return;
        }

        // Format for storage
        const content = formatSummaryForStorage(summary);

        // Store via brain.db REST API (port 8031)
        try {
          const response = await fetch("http://localhost:8031/remember", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: content.slice(0, 500),
              categories: ["meta"],
              importance,
              source: "conversation-summarizer",
            }),
          });

          if (response.ok) {
            api.logger.info(
              `Conversation summarized: ${summary.decisions.length} decisions, ` +
                `${summary.insights.length} insights, ${summary.actions.length} actions ` +
                `(importance: ${importance.toFixed(1)})`,
            );
          } else {
            api.logger.debug?.(`brain_api returned ${response.status}`);
          }
        } catch (err) {
          // brain_api not running, that's OK
          api.logger.debug?.(`Could not store summary via brain_api: ${err}`);
        }
      } catch (err) {
        api.logger.debug?.(`Conversation summary failed: ${err}`);
      }
    });

    // Register a manual summarize tool
    api.registerTool(
      {
        name: "summarize_conversation",
        description:
          "Manually trigger conversation summarization. Extracts decisions, insights, action items, and problems from the current conversation.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_toolCallId, _params, _ctx) {
          // This would need access to current conversation context
          // For now, return instructions
          return {
            content: [
              {
                type: "text",
                text:
                  "Conversation summarization runs automatically at the end of each conversation. " +
                  "Summaries are stored in Cortex STM with category 'meta'. " +
                  "Use cortex_stm with category='meta' to view recent summaries.",
              },
            ],
            details: { success: true },
          };
        },
      },
      { names: ["summarize_conversation"] },
    );

    api.logger.info("Conversation summarizer initialized");
  },
};

export default conversationSummarizerPlugin;
