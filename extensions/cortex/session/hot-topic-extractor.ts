/**
 * Hot Topic Extractor — Cross-Session State Preservation
 * Cortex v2.0.0
 *
 * Stateful accumulator that tracks topics, projects, and learnings
 * across the lifetime of a session.
 */

/** Known project path patterns for extraction */
const PROJECT_PATH_PATTERNS = [/\/Projects\/([^/]+)/, /\/home\/[^/]+\/([^/]+)/];

/** Stop words to filter from topic extraction */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "are",
  "was",
  "will",
  "have",
  "has",
  "had",
  "been",
  "being",
  "would",
  "could",
  "should",
  "into",
  "not",
  "but",
  "its",
  "all",
  "can",
  "did",
  "get",
  "got",
  "just",
  "more",
  "some",
  "than",
  "them",
  "then",
  "they",
  "what",
  "when",
  "which",
  "who",
  "how",
  "now",
  "out",
  "use",
  "also",
  "each",
  "make",
  "like",
  "over",
]);

export class HotTopicExtractor {
  private topicCounts = new Map<string, number>();
  private projects = new Set<string>();
  private learningIds: string[] = [];
  private sopInteractions: Array<{
    sop_path: string;
    injected_at: string;
    acknowledged: boolean;
    tool_call: string;
  }> = [];

  /**
   * Record a tool call — extract topic signals from tool name and params.
   */
  recordToolCall(toolName: string, params: Record<string, unknown>): void {
    this.incrementTopic(toolName);

    // Extract keywords from string params
    for (const val of Object.values(params)) {
      if (typeof val === "string" && val.length > 2 && val.length < 200) {
        this.extractAndCount(val);
      }
    }
  }

  /**
   * Record memory access categories.
   */
  recordMemoryAccess(categories: string[]): void {
    for (const cat of categories) {
      this.incrementTopic(cat, 2); // Categories are higher signal
    }
  }

  /**
   * Record a working memory pin label.
   */
  recordWorkingMemoryLabel(label: string): void {
    if (label) {
      this.extractAndCount(label, 3); // Pin labels are highest signal
    }
  }

  /**
   * Record an exec workdir to detect active projects.
   */
  recordExecWorkdir(workdir: string): void {
    for (const pattern of PROJECT_PATH_PATTERNS) {
      const match = workdir.match(pattern);
      if (match?.[1]) {
        this.projects.add(match[1]);
        this.incrementTopic(match[1], 2);
      }
    }
  }

  /**
   * Record a Synapse message subject.
   */
  recordSynapseSubject(subject: string): void {
    this.extractAndCount(subject, 2);
  }

  /**
   * Record a cortex_add memory ID (for recent_learnings tracking).
   */
  recordLearningId(memoryId: string): void {
    this.learningIds.push(memoryId);
  }

  /**
   * Record an SOP interaction.
   */
  recordSOPInteraction(sopPath: string, toolCall: string, acknowledged: boolean = false): void {
    this.sopInteractions.push({
      sop_path: sopPath,
      injected_at: new Date().toISOString(),
      acknowledged,
      tool_call: toolCall,
    });
  }

  /**
   * Get current topics, frequency-ranked, top N.
   */
  getCurrentTopics(): string[] {
    return this.getTopN(20);
  }

  /**
   * Get top N topics by frequency.
   */
  getTopN(n: number): string[] {
    return [...this.topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([topic]) => topic);
  }

  /**
   * Get detected active projects.
   */
  getActiveProjects(): string[] {
    return [...this.projects];
  }

  /**
   * Get all learning IDs recorded this session.
   */
  getRecentLearningIds(): string[] {
    return [...this.learningIds];
  }

  /**
   * Alias for getRecentLearningIds.
   */
  getAllLearningIds(): string[] {
    return this.getRecentLearningIds();
  }

  /**
   * Get all SOP interactions.
   */
  getSOPInteractions(): Array<{
    sop_path: string;
    injected_at: string;
    acknowledged: boolean;
    tool_call: string;
  }> {
    return [...this.sopInteractions];
  }

  private incrementTopic(topic: string, weight: number = 1): void {
    const normalized = topic.toLowerCase().trim();
    if (normalized.length < 2 || STOP_WORDS.has(normalized)) return;
    this.topicCounts.set(normalized, (this.topicCounts.get(normalized) ?? 0) + weight);
  }

  private extractAndCount(text: string, weight: number = 1): void {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s-_]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

    for (const word of words) {
      this.incrementTopic(word, weight);
    }
  }
}
